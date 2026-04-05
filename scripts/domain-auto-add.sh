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
MODE="${1:-run}"

SKIP_PATTERNS="msftconnecttest\.com|windowsupdate\.com|update\.microsoft\.com|login\.microsoftonline\.com|apple-dns\.net|akadns\.net|connectivitycheck|captive\.apple\.com|cloudfront\.net|akamaized\.net|akamaiedge\.net"

# Russian TLDs — accessible without VPN, never auto-route.
RU_TLDS="\.ru$|\.su$|\.xn--p1ai$|\.xn--80adxhks$|\.xn--d1acj3b$|\.xn--p1acf$|\.tatar$|\.moscow$"

get_parent_domain() {
  printf '%s\n' "$1" | sed 's/^[^.]*\.//'
}

get_reg_domain() {
  printf '%s\n' "$1" | awk -F. '{print $(NF-1)"."$NF}'
}

is_ipv4_dash_label() {
  label="$1"
  printf '%s\n' "$label" | awk -F- '
    NF != 4 { exit 1 }
    {
      for (i = 1; i <= 4; i++) {
        if ($i !~ /^[0-9]+$/ || $i > 255) exit 1
      }
      exit 0
    }'
}

get_ip_family_label() {
  domain="$1"
  reg_domain=$(get_reg_domain "$domain")
  prefix="${domain%.$reg_domain}"
  [ "$prefix" = "$domain" ] && return 1

  last_label=${prefix##*.}
  if is_ipv4_dash_label "$last_label"; then
    printf '%s\n' "$last_label"
    return 0
  fi

  printf '%s\n' "$prefix" | awk -F. '
    NF < 4 { exit 1 }
    {
      a=$(NF-3); b=$(NF-2); c=$(NF-1); d=$NF
      if (a ~ /^[0-9]+$/ && b ~ /^[0-9]+$/ && c ~ /^[0-9]+$/ && d ~ /^[0-9]+$/ &&
          a <= 255 && b <= 255 && c <= 255 && d <= 255) {
        printf "%s.%s.%s.%s\n", a, b, c, d
        exit 0
      }
      exit 1
    }'
}

get_family_domain() {
  domain="$1"
  reg_domain=$(get_reg_domain "$domain")
  ip_family_label=$(get_ip_family_label "$domain" 2>/dev/null || true)
  if [ -n "$ip_family_label" ]; then
    printf '%s.%s\n' "$ip_family_label" "$reg_domain"
    return 0
  fi

  dot_count=$(printf '%s\n' "$domain" | tr -cd '.' | wc -c)
  if [ "$dot_count" -ge 2 ]; then
    printf '%s\n' "$reg_domain"
  else
    printf '%s\n' "$domain"
  fi
}

extract_ipset_domains() {
  file="$1"
  [ -f "$file" ] || return 0
  grep '^ipset=/' "$file" 2>/dev/null \
    | sed 's|^ipset=/||;s|/.*$||' \
    | sed '/^[[:space:]]*$/d' \
    | sort -u
}

extract_literal_domains() {
  file="$1"
  [ -f "$file" ] || return 0
  grep -vE '^[[:space:]]*#|^[[:space:]]*$' "$file" 2>/dev/null | sort -u
}

domain_in_list_exact() {
  domain="$1"
  list_file="$2"
  [ -f "$list_file" ] || return 1
  grep -qxF "$domain" "$list_file" 2>/dev/null
}

find_covering_domain_in_lists() {
  domain="$1"
  shift
  current="$domain"
  while [ -n "$current" ]; do
    for list_file in "$@"; do
      if domain_in_list_exact "$current" "$list_file"; then
        printf '%s\n' "$current"
        return 0
      fi
    done
    case "$current" in
      *.*) current=${current#*.} ;;
      *) break ;;
    esac
  done
  return 1
}

is_domain_covered_by_lists() {
  domain="$1"
  shift
  find_covering_domain_in_lists "$domain" "$@" >/dev/null 2>&1
}

sort_domains_by_breadth() {
  list_file="$1"
  [ -f "$list_file" ] || return 0
  awk -F. '{print NF, length($0), $0}' "$list_file" \
    | sort -k1,1n -k2,2n -k3,3 \
    | awk '{print $3}'
}

rewrite_auto_file_from_list() {
  keep_list="$1"
  tmp_auto="/tmp/daa-auto-rewrite.$$"
  {
    printf '# normalized by domain-auto-add.sh at %s\n' "$NOW"
    while IFS= read -r kept_domain; do
      [ -n "$kept_domain" ] || continue
      printf 'ipset=/%s/%s\n'          "$kept_domain" "$VPN_IPSET"
      printf 'server=/%s/1.1.1.1@%s\n' "$kept_domain" "$VPN_IFACE"
      printf 'server=/%s/9.9.9.9@%s\n' "$kept_domain" "$VPN_IFACE"
    done < "$keep_list"
  } > "$tmp_auto"
  mv "$tmp_auto" "$AUTO"
}

cleanup_auto_config() {
  cleanup_before=$(wc -l < "$AUTO_DOMAINS" 2>/dev/null | tr -d ' ')
  cleanup_before=${cleanup_before:-0}
  cleanup_after=$cleanup_before
  cleanup_removed=0
  [ "$cleanup_before" -gt 0 ] || return 0

  AUTO_ORDERED=/tmp/daa-auto-ordered.$$
  AUTO_KEEP=/tmp/daa-auto-keep.$$
  AUTO_DROP=/tmp/daa-auto-drop.$$
  : > "$AUTO_ORDERED"; : > "$AUTO_KEEP"; : > "$AUTO_DROP"

  sort_domains_by_breadth "$AUTO_DOMAINS" > "$AUTO_ORDERED"

  while IFS= read -r auto_domain; do
    [ -n "$auto_domain" ] || continue

    covered_by=$(find_covering_domain_in_lists "$auto_domain" "$MANAGED_DOMAINS" 2>/dev/null || true)
    if [ -n "$covered_by" ]; then
      printf '%s\tmanual\t%s\n' "$auto_domain" "$covered_by" >> "$AUTO_DROP"
      continue
    fi

    covered_by=$(find_covering_domain_in_lists "$auto_domain" "$AUTO_KEEP" 2>/dev/null || true)
    if [ -n "$covered_by" ]; then
      printf '%s\tauto\t%s\n' "$auto_domain" "$covered_by" >> "$AUTO_DROP"
      continue
    fi

    printf '%s\n' "$auto_domain" >> "$AUTO_KEEP"
  done < "$AUTO_ORDERED"

  cleanup_after=$(wc -l < "$AUTO_KEEP" 2>/dev/null | tr -d ' ')
  cleanup_after=${cleanup_after:-0}
  cleanup_removed=$((cleanup_before - cleanup_after))

  if [ "$cleanup_removed" -gt 0 ]; then
    rewrite_auto_file_from_list "$AUTO_KEEP"
    cp "$AUTO_KEEP" "$AUTO_DOMAINS"

    while IFS="$(printf '\t')" read -r dropped_domain dropped_source covered_by; do
      [ -n "$dropped_domain" ] || continue
      printf '  - %-48s covered by %s %s\n' \
        "$dropped_domain" "$dropped_source" "$covered_by" >> "$CLEANUP_LIST"
      echo 1 >> "$CNT_CLN"
    done < "$AUTO_DROP"

    touch "$CHANGED"
    logger -t domain-auto-add \
      "Cleanup removed $cleanup_removed redundant auto-domains (kept: $cleanup_after)"
  fi

  rm -f "$AUTO_ORDERED" "$AUTO_KEEP" "$AUTO_DROP"
}

NOW=$(date '+%Y-%m-%d %H:%M')

if [ "$MODE" != "--cleanup-only" ] && [ "$MODE" != "run" ] && [ -n "$MODE" ]; then
  echo "Usage: $0 [--cleanup-only]" >&2
  exit 1
fi

if [ -f "$LOG" ]; then
  TOTAL_Q=$(grep -c "query\[A" "$LOG" 2>/dev/null || echo 0)
  LOG_FROM=$(head -1 "$LOG" 2>/dev/null | awk '{print $3}')
  LOG_TO=$(tail  -1 "$LOG" 2>/dev/null | awk '{print $3}')
  DATE_HDR=$(head -1 "$LOG" 2>/dev/null | awk '{print $1, $2}')
else
  TOTAL_Q=0
  LOG_FROM="-"
  LOG_TO="-"
  DATE_HDR=""
fi

if [ "$MODE" = "run" ] && [ ! -f "$LOG" ]; then
  logger -t domain-auto-add "No log at $LOG — is dnsmasq logging enabled?"
  exit 0
fi

# Temp files — pre-created so subshell (pipe) can append to them
CHANGED=/tmp/daa-changed.$$
CNT_ADD=/tmp/daa-add.$$
CNT_KNW=/tmp/daa-knw.$$
CNT_SKP=/tmp/daa-skp.$$
CNT_CND=/tmp/daa-cnd.$$
CNT_GEO=/tmp/daa-geo.$$
CNT_CLN=/tmp/daa-cln.$$
ADDED_LIST=/tmp/daa-list.$$
CANDIDATES=/tmp/daa-candidates.$$
CANDIDATES_PROBE=/tmp/daa-probe.$$
GEO_LIST=/tmp/daa-geolist.$$
CLEANUP_LIST=/tmp/daa-cleanup.$$
MANAGED_DOMAINS=/tmp/daa-managed.$$
AUTO_DOMAINS=/tmp/daa-auto.$$
NO_VPN_DOMAINS=/tmp/daa-no-vpn.$$
: > "$CNT_ADD"; : > "$CNT_KNW"; : > "$CNT_SKP"; : > "$CNT_CND"; : > "$CNT_GEO"; : > "$CNT_CLN"
: > "$ADDED_LIST"; : > "$CANDIDATES"; : > "$CANDIDATES_PROBE"; : > "$GEO_LIST"; : > "$CLEANUP_LIST"
: > "$MANAGED_DOMAINS"; : > "$AUTO_DOMAINS"; : > "$NO_VPN_DOMAINS"
trap 'rm -f "$CHANGED" "$CNT_ADD" "$CNT_KNW" "$CNT_SKP" "$CNT_CND" "$CNT_GEO" "$CNT_CLN" "$ADDED_LIST" "$CANDIDATES" "$CANDIDATES_PROBE" "$GEO_LIST" "$CLEANUP_LIST" "$MANAGED_DOMAINS" "$AUTO_DOMAINS" "$NO_VPN_DOMAINS"' 0

extract_ipset_domains "$MANAGED" > "$MANAGED_DOMAINS"
extract_ipset_domains "$AUTO" > "$AUTO_DOMAINS"
extract_literal_domains "$NO_VPN" > "$NO_VPN_DOMAINS"

cleanup_before=0
cleanup_after=0
cleanup_removed=0
cleanup_auto_config

if [ "$MODE" = "--cleanup-only" ]; then
  if [ -f "$CHANGED" ]; then
    service restart_dnsmasq
  fi
  printf 'Auto cleanup: %d -> %d (removed %d redundant entries)\n' \
    "$cleanup_before" "$cleanup_after" "$cleanup_removed"
  if [ "$cleanup_removed" -gt 0 ] && [ -s "$CLEANUP_LIST" ]; then
    head -20 "$CLEANUP_LIST"
    [ "$cleanup_removed" -gt 20 ] && printf '  ...trimmed output, total removed: %d\n' "$cleanup_removed"
  fi
  exit 0
fi

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

      parent=$(get_parent_domain "$domain")
      reg_domain=$(get_reg_domain "$domain")
      family_domain=$(get_family_domain "$domain")

      # Check user exclusion list (domains-no-vpn.txt) — exact or parent match
      if is_domain_covered_by_lists "$domain" "$NO_VPN_DOMAINS"; then
        echo 1 >> "$CNT_SKP"
        continue
      fi

      if is_domain_covered_by_lists "$domain" "$MANAGED_DOMAINS" "$AUTO_DOMAINS"; then
        echo 1 >> "$CNT_KNW"
        continue
      fi

      # Source devices (computed early for both candidates and additions)
      srcs=$(grep "query\[A\] ${domain} from" "$LOG" \
             | awk '{print $8}' | sort -u | tr '\n' ',' | sed 's/,$//')

      # Check against blocked domains list — only add known-blocked domains.
      # If the list doesn't exist (not yet downloaded), fall back to old behavior (add all).
      if [ -f "$BLOCKED_LIST" ]; then
        if ! grep -qFx "$domain" "$BLOCKED_LIST" \
           && ! grep -qFx "$parent" "$BLOCKED_LIST" \
           && ! grep -qFx "$reg_domain" "$BLOCKED_LIST" \
           && ! grep -qFx "$family_domain" "$BLOCKED_LIST"; then
          printf '  ? %-48s %3d запр  [%s]\n' "$domain" "$count" "$srcs" >> "$CANDIDATES"
          # Save raw data for ISP probe.
          # Short "entry" domains (for example www.ig.com) get a higher score so
          # they can be probed even after a single observed query. Dynamic DNS
          # names with IP-encoded family labels get the same treatment.
          num_devs=$(echo "$srcs" | tr ',' '\n' | grep -c '.')
          reg_label=${reg_domain%%.*}
          reg_len=${#reg_label}
          dot_count=$(echo "$domain" | tr -cd '.' | wc -c)
          probe_score=$count
          case "$domain" in
            www.*) probe_score=$((probe_score + 500)) ;;
          esac
          if [ "$reg_len" -le 3 ]; then
            probe_score=$((probe_score + 300))
          elif [ "$reg_len" -le 4 ]; then
            probe_score=$((probe_score + 200))
          fi
          if [ "$dot_count" -le 1 ]; then
            probe_score=$((probe_score + 100))
          fi
          if [ "$family_domain" != "$reg_domain" ]; then
            probe_score=$((probe_score + 700))
          fi
          printf '%d %d %d %s\n' "$probe_score" "$count" "$num_devs" "$domain" >> "$CANDIDATES_PROBE"
          echo 1 >> "$CNT_CND"
          continue
        fi
      fi

      # Prefer a service-family domain for subdomains, but keep IP-encoded
      # dynamic DNS families narrower than the public suffix.
      write_domain="$family_domain"

      # If reg_domain differs from domain, do an exact check for the write target
      if [ "$write_domain" != "$domain" ] && \
         is_domain_covered_by_lists "$write_domain" "$MANAGED_DOMAINS" "$AUTO_DOMAINS"; then
        echo 1 >> "$CNT_KNW"
        continue
      fi

      # Add to dnsmasq autodiscovered config
      {
        printf '\n# auto-added %s (queries: %d, from: %s)\n' "$NOW" "$count" "$srcs"
        printf 'ipset=/%s/%s\n'          "$write_domain" "$VPN_IPSET"
        printf 'server=/%s/1.1.1.1@%s\n' "$write_domain" "$VPN_IFACE"
        printf 'server=/%s/9.9.9.9@%s\n' "$write_domain" "$VPN_IFACE"
      } >> "$AUTO"

      # One line per added domain for the activity log
      printf '  + %-48s %3d запр  [%s]\n' "$write_domain" "$count" "$srcs" >> "$ADDED_LIST"

      echo 1 >> "$CNT_ADD"
      printf '%s\n' "$write_domain" >> "$AUTO_DOMAINS"
      sort -u "$AUTO_DOMAINS" -o "$AUTO_DOMAINS"
      touch "$CHANGED"
      logger -t domain-auto-add "Added: $domain (queries: $count)"
    done

# ── ISP probe for high-priority candidates (geo-blocked sites) ───────────────
# Tests candidates via ISP.
# Ordinary candidates need repeated hits, but short/entry domains such as
# www.ig.com and dynamic DNS names with IP-encoded family labels are probed
# earlier even after a single observed query.
# HTTP 000 (timeout/refused) = ISP blocks it → add to VPN even without antifilter entry.
PROBE_MIN_COUNT=3
PROBE_MIN_COUNT_PRIORITY=1
PROBE_PRIORITY_MIN_SCORE=700
PROBE_MIN_DEVICES=1
PROBE_MAX_PER_RUN=16
PROBE_TIMEOUT=4
WAN_IFACE=wan0
probe_count=0

sort -rn "$CANDIDATES_PROBE" | while IFS=' ' read -r cand_score cand_count cand_devs cand_domain; do
  [ "$probe_count" -ge "$PROBE_MAX_PER_RUN" ] && break
  min_count="$PROBE_MIN_COUNT"
  [ "$cand_score" -ge "$PROBE_PRIORITY_MIN_SCORE" ] && min_count="$PROBE_MIN_COUNT_PRIORITY"
  [ "$cand_count" -lt "$min_count" ]          && continue
  [ "$cand_devs"  -lt "$PROBE_MIN_DEVICES" ]  && continue

  # Determine write target (same family-domain logic as main loop)
  cand_write=$(get_family_domain "$cand_domain")

  # Skip if already covered in any config
  if is_domain_covered_by_lists "$cand_write" "$MANAGED_DOMAINS" "$AUTO_DOMAINS"; then
    continue
  fi

  http_code=$(curl -s --max-time "$PROBE_TIMEOUT" --interface "$WAN_IFACE" \
                   -o /dev/null -w '%{http_code}' "https://$cand_domain/" 2>/dev/null)
  probe_count=$((probe_count + 1))

  if [ "$http_code" = "000" ]; then
    cand_srcs=$(grep "query\[A\] ${cand_domain} from" "$LOG" \
                | awk '{print $8}' | sort -u | tr '\n' ',' | sed 's/,$//')
    {
      printf '\n# geo-blocked (ISP:000) %s (queries: %d, from: %s)\n' \
             "$NOW" "$cand_count" "$cand_srcs"
      printf 'ipset=/%s/%s\n'          "$cand_write" "$VPN_IPSET"
      printf 'server=/%s/1.1.1.1@%s\n' "$cand_write" "$VPN_IFACE"
      printf 'server=/%s/9.9.9.9@%s\n' "$cand_write" "$VPN_IFACE"
    } >> "$AUTO"
    printf '  + %-48s %3d запр  ISP:000\n' "$cand_write" "$cand_count" >> "$GEO_LIST"
    echo 1 >> "$CNT_GEO"
    printf '%s\n' "$cand_write" >> "$AUTO_DOMAINS"
    sort -u "$AUTO_DOMAINS" -o "$AUTO_DOMAINS"
    touch "$CHANGED"
    logger -t domain-auto-add "Geo-blocked: $cand_domain → $cand_write (ISP:000, queries: $cand_count)"
  fi
done

# ── Compute counts ───────────────────────────────────────────────────────────
n_add=$(wc -l < "$CNT_ADD"  2>/dev/null | tr -d ' '); n_add=${n_add:-0}
n_knw=$(wc -l < "$CNT_KNW"  2>/dev/null | tr -d ' '); n_knw=${n_knw:-0}
n_skp=$(wc -l < "$CNT_SKP"  2>/dev/null | tr -d ' '); n_skp=${n_skp:-0}
n_cnd=$(wc -l < "$CNT_CND"  2>/dev/null | tr -d ' '); n_cnd=${n_cnd:-0}
n_geo=$(wc -l < "$CNT_GEO"  2>/dev/null | tr -d ' '); n_geo=${n_geo:-0}
n_cln=$(wc -l < "$CNT_CLN"  2>/dev/null | tr -d ' '); n_cln=${n_cln:-0}

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

  if [ "$n_geo" -gt 0 ] && [ -s "$GEO_LIST" ]; then
    printf '│\n'
    printf '│ GEO-BLOCKED (ISP-проба, %d):\n' "$n_geo"
    while IFS= read -r line; do
      printf '│%s\n' "$line"
    done < "$GEO_LIST"
  fi

  if [ "$n_cln" -gt 0 ] && [ -s "$CLEANUP_LIST" ]; then
    printf '│\n'
    printf '│ CLEANUP AUTO-ФАЙЛА (%d):\n' "$n_cln"
    head -10 "$CLEANUP_LIST" | while IFS= read -r line; do
      printf '│%s\n' "$line"
    done
    [ "$n_cln" -gt 10 ] && printf '│  ...показаны первые 10 из %d\n' "$n_cln"
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
  printf '│ Итог: +%d добавлено  |  +%d geo  |  -%d cleanup  |  %d уже в VPN  |  %d пропущено  |  %d кандидатов%s\n' \
    "$n_add" "$n_geo" "$n_cln" "$n_knw" "$n_skp" "$n_cnd" "$BL_STATUS"
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

logger -t domain-auto-add "Done. Added=$n_add, Geo=$n_geo, Cleanup=$n_cln, Known=$n_knw, Skipped=$n_skp, Candidates=$n_cnd"
