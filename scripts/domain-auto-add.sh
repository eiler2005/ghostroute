#!/bin/sh
# Automatic domain routing — runs every hour via cron.
#
# For each domain queried >= MIN_COUNT times in the dnsmasq log:
#   - Adds ipset + server entries to dnsmasq-autodiscovered.conf.add
#   - Writes a compact activity log to /opt/var/log/domain-activity.log:
#       • Заголовок запуска с временем и статистикой периода
#       • Только добавленные домены (по одной строке каждый)
#       • Итоговая строка: добавлено / уже было / пропущено
#
# View log on Mac:  ./scripts/domain-report --log
# Reset auto-adds:  ./scripts/domain-report --reset

LOG=/opt/var/log/dnsmasq.log
ACTIVITY=/opt/var/log/domain-activity.log
MANAGED=/jffs/configs/dnsmasq.conf.add
AUTO=/jffs/configs/dnsmasq-autodiscovered.conf.add
NO_VPN=/jffs/configs/domains-no-vpn.txt
BLOCKED_LIST=/opt/tmp/blocked-domains.lst
VPN_IPSET=VPN_DOMAINS
VPN_IFACE=wgc1
MIN_COUNT=1

SKIP_PATTERNS="msftconnecttest\.com|windowsupdate\.com|update\.microsoft\.com|login\.microsoftonline\.com|apple-dns\.net|akadns\.net|connectivitycheck|captive\.apple\.com|cloudfront\.net|akamaized\.net|akamaiedge\.net"

# Russian TLDs — accessible without VPN, never auto-route.
RU_TLDS="\.ru$|\.su$|\.xn--p1ai$|\.xn--80adxhks$|\.xn--d1acj3b$|\.xn--p1acf$|\.tatar$|\.moscow$"

if [ ! -f "$LOG" ]; then
  logger -t domain-auto-add "No log at $LOG — is dnsmasq logging enabled?"
  exit 0
fi

NOW=$(date '+%Y-%m-%d %H:%M')
TOTAL_Q=$(grep -c "query\[A" "$LOG" 2>/dev/null || echo 0)
LOG_FROM=$(head -1 "$LOG" 2>/dev/null | awk '{print $3}')
LOG_TO=$(tail  -1 "$LOG" 2>/dev/null | awk '{print $3}')
DATE_HDR=$(head -1 "$LOG" 2>/dev/null | awk '{print $1, $2}')

# Temp files — pre-created so subshell (pipe) can append to them
CHANGED=/tmp/daa-changed.$$
CNT_ADD=/tmp/daa-add.$$
CNT_KNW=/tmp/daa-knw.$$
CNT_SKP=/tmp/daa-skp.$$
CNT_CND=/tmp/daa-cnd.$$
ADDED_LIST=/tmp/daa-list.$$
CANDIDATES=/tmp/daa-candidates.$$
: > "$CNT_ADD"; : > "$CNT_KNW"; : > "$CNT_SKP"; : > "$CNT_CND"
: > "$ADDED_LIST"; : > "$CANDIDATES"
trap 'rm -f "$CHANGED" "$CNT_ADD" "$CNT_KNW" "$CNT_SKP" "$CNT_CND" "$ADDED_LIST" "$CANDIDATES"' 0

# ── Process each unique domain ──────────────────────────────────────────────
grep "query\[A" "$LOG" \
  | awk '{print $6}' \
  | sort | uniq -c | sort -rn \
  | while read count domain; do

      echo "$domain" | grep -q '\.' || continue
      case "$domain" in *.local|*.lan|*.arpa|*.home|*.internal) continue ;; esac

      if echo "$domain" | grep -qE "$SKIP_PATTERNS"; then
        echo 1 >> "$CNT_SKP"
        continue
      fi

      # Skip Russian TLDs — they work without VPN
      if echo "$domain" | grep -qE "$RU_TLDS"; then
        echo 1 >> "$CNT_SKP"
        continue
      fi

      parent=$(echo "$domain" | sed 's/^[^.]*\.//')

      # Check user exclusion list (domains-no-vpn.txt) — exact or parent match
      if [ -f "$NO_VPN" ]; then
        if grep -vE '^\s*#|^\s*$' "$NO_VPN" | grep -qE "^(${domain}|${parent})$"; then
          echo 1 >> "$CNT_SKP"
          continue
        fi
      fi

      if grep -qE "ipset=.*/(${domain}|${parent})/" "$MANAGED" "$AUTO" 2>/dev/null; then
        echo 1 >> "$CNT_KNW"
        continue
      fi

      # Source devices (computed early for both candidates and additions)
      srcs=$(grep "query\[A\] ${domain} from" "$LOG" \
             | awk '{print $8}' | sort -u | tr '\n' ',' | sed 's/,$//')

      # Check against blocked domains list — only add known-blocked domains.
      # If the list doesn't exist (not yet downloaded), fall back to old behavior (add all).
      if [ -f "$BLOCKED_LIST" ]; then
        reg_domain=$(echo "$domain" | awk -F. '{print $(NF-1)"."$NF}')
        if ! grep -qFx "$domain" "$BLOCKED_LIST" \
           && ! grep -qFx "$parent" "$BLOCKED_LIST" \
           && ! grep -qFx "$reg_domain" "$BLOCKED_LIST"; then
          printf '  ? %-48s %3d запр  [%s]\n' "$domain" "$count" "$srcs" >> "$CANDIDATES"
          echo 1 >> "$CNT_CND"
          continue
        fi
      fi

      # Add to dnsmasq autodiscovered config
      {
        printf '\n# auto-added %s (queries: %d, from: %s)\n' "$NOW" "$count" "$srcs"
        printf 'ipset=/%s/%s\n'          "$domain" "$VPN_IPSET"
        printf 'server=/%s/1.1.1.1@%s\n' "$domain" "$VPN_IFACE"
        printf 'server=/%s/9.9.9.9@%s\n' "$domain" "$VPN_IFACE"
      } >> "$AUTO"

      # One line per added domain for the activity log
      printf '  + %-48s %3d запр  [%s]\n' "$domain" "$count" "$srcs" >> "$ADDED_LIST"

      echo 1 >> "$CNT_ADD"
      touch "$CHANGED"
      logger -t domain-auto-add "Added: $domain (queries: $count)"
    done

# ── Compute counts ───────────────────────────────────────────────────────────
n_add=$(wc -l < "$CNT_ADD"  2>/dev/null | tr -d ' '); n_add=${n_add:-0}
n_knw=$(wc -l < "$CNT_KNW"  2>/dev/null | tr -d ' '); n_knw=${n_knw:-0}
n_skp=$(wc -l < "$CNT_SKP"  2>/dev/null | tr -d ' '); n_skp=${n_skp:-0}
n_cnd=$(wc -l < "$CNT_CND"  2>/dev/null | tr -d ' '); n_cnd=${n_cnd:-0}

# ── Write compact entry to activity log ─────────────────────────────────────
{
  printf '┌─────────────────────────────────────────────────────────────\n'
  printf '│ %s   период %s–%s   DNS-запросов: %d\n' \
    "$NOW" "$LOG_FROM" "$LOG_TO" "$TOTAL_Q"
  printf '├─────────────────────────────────────────────────────────────\n'

  if [ "$n_add" -gt 0 ] && [ -s "$ADDED_LIST" ]; then
    printf '│ ДОБАВЛЕНО В VPN (%d):\n' "$n_add"
    while IFS= read -r line; do
      printf '│%s\n' "$line"
    done < "$ADDED_LIST"
  else
    printf '│ Новых доменов для VPN: нет\n'
  fi

  if [ "$n_cnd" -gt 0 ] && [ -s "$CANDIDATES" ]; then
    printf '│\n'
    printf '│ КАНДИДАТЫ (не в списке блокировок, %d):\n' "$n_cnd"
    head -10 "$CANDIDATES" | while IFS= read -r line; do
      printf '│%s\n' "$line"
    done
    [ "$n_cnd" -gt 10 ] && printf '│  ...показаны первые 10 из %d\n' "$n_cnd"
  fi

  printf '│\n'
  BL_STATUS=""
  [ -f "$BLOCKED_LIST" ] && BL_STATUS="  |  список блокировок: $(wc -l < "$BLOCKED_LIST" | tr -d ' ')"
  [ ! -f "$BLOCKED_LIST" ] && BL_STATUS="  |  список блокировок: нет (fallback)"
  printf '│ Итог: +%d добавлено  |  %d уже в VPN  |  %d пропущено  |  %d кандидатов%s\n' \
    "$n_add" "$n_knw" "$n_skp" "$n_cnd" "$BL_STATUS"
  printf '└─────────────────────────────────────────────────────────────\n'
} >> "$ACTIVITY"

# ── Reload dnsmasq if needed ─────────────────────────────────────────────────
if [ -f "$CHANGED" ]; then
  service restart_dnsmasq
  logger -t domain-auto-add "dnsmasq reloaded, $n_add domains added"
fi

# ── Rotate dnsmasq log ───────────────────────────────────────────────────────
if [ -f "$LOG" ]; then
  mv "$LOG" "${LOG}.prev"
  service restart_dnsmasq
fi

# ── Rotate activity log if > 5 MB ────────────────────────────────────────────
if [ -f "$ACTIVITY" ]; then
  SIZE=$(wc -c < "$ACTIVITY" 2>/dev/null || echo 0)
  if [ "$SIZE" -gt 5242880 ]; then
    CREATED=$(head -2 "$ACTIVITY" 2>/dev/null | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' | head -1)
    UNTIL=$(date '+%Y-%m-%d')
    ARCHIVE="$(dirname "$ACTIVITY")/domain-activity_${CREATED}_${UNTIL}.log"
    mv "$ACTIVITY" "$ARCHIVE"
    logger -t domain-auto-add "Activity log rotated to $ARCHIVE"
  fi
fi

logger -t domain-auto-add "Done. Added=$n_add, Known=$n_knw, Skipped=$n_skp, Candidates=$n_cnd"
