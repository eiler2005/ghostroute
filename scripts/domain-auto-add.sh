#!/bin/sh
# Automatic domain routing — runs every hour via cron.
#
# For each domain queried >= MIN_COUNT times in the dnsmasq log:
#   - Adds VPN_DOMAINS + STEALTH_DOMAINS ipset entries to dnsmasq-autodiscovered.conf.add
#   - Writes a compact activity log to /opt/var/log/domain-activity.log:
#       • Заголовок запуска с временем и статистикой периода
#       • Только добавленные домены (по одной строке каждый)
#       • Итоговая строка: добавлено / уже было / пропущено
#   - Saves an hourly DNS forensics snapshot keyed by client IP
#
# View log on Mac:  ./scripts/domain-report --log
# Reset auto-adds:  ./scripts/domain-report --reset

STATE_DIR_DEFAULT=/jffs/addons/router_configuration/dns-forensics
[ -x /opt/bin/opkg ] && STATE_DIR_DEFAULT=/opt/var/log/router_configuration/dns-forensics
LOG="${DOMAIN_AUTO_ADD_LOG_FILE:-/opt/var/log/dnsmasq.log}"
ACTIVITY="${DOMAIN_AUTO_ADD_ACTIVITY_LOG_FILE:-/opt/var/log/domain-activity.log}"
MANAGED="${DOMAIN_AUTO_ADD_MANAGED_FILE:-/jffs/configs/dnsmasq.conf.add}"
AUTO="${DOMAIN_AUTO_ADD_AUTO_FILE:-/jffs/configs/dnsmasq-autodiscovered.conf.add}"
NO_VPN="${DOMAIN_AUTO_ADD_NO_VPN_FILE:-/jffs/configs/domains-no-vpn.txt}"
BLOCKED_LIST="${DOMAIN_AUTO_ADD_BLOCKED_LIST_FILE:-/opt/tmp/blocked-domains.lst}"
LEASES_FILE="${DOMAIN_AUTO_ADD_LEASES_FILE:-/var/lib/misc/dnsmasq.leases}"
FORENSICS_DIR="${DOMAIN_AUTO_ADD_FORENSICS_DIR:-$STATE_DIR_DEFAULT}"
VPN_IPSET=VPN_DOMAINS
STEALTH_IPSET=STEALTH_DOMAINS
MIN_COUNT=1
MODE="${1:-run}"
CANDIDATE_EVENTS_STATE=/opt/tmp/domain-auto-add-candidate-events.tsv
PROBE_HISTORY_STATE=/opt/tmp/domain-auto-add-probe-history.tsv
CANDIDATE_WINDOW_24H_SEC=86400
CANDIDATE_WINDOW_7D_SEC=604800
CANDIDATE_RETENTION_SEC=$CANDIDATE_WINDOW_7D_SEC
FORENSICS_RETENTION_DAYS=30
FORENSICS_TOP_CLIENTS=8
FORENSICS_TOP_DOMAINS=8
FORENSICS_TOP_FAMILIES=6

# "User interest" signal: domain is repeatedly requested by user devices
# across multiple days, even if current 24h volume is low.
USER_INTEREST_MIN_COUNT_7D=10
USER_INTEREST_MIN_DAYS_7D=2
PROBE_INTEREST_SCORE_BOOST=450

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

month_to_number() {
  case "$1" in
    Jan) printf '01\n' ;;
    Feb) printf '02\n' ;;
    Mar) printf '03\n' ;;
    Apr) printf '04\n' ;;
    May) printf '05\n' ;;
    Jun) printf '06\n' ;;
    Jul) printf '07\n' ;;
    Aug) printf '08\n' ;;
    Sep) printf '09\n' ;;
    Oct) printf '10\n' ;;
    Nov) printf '11\n' ;;
    Dec) printf '12\n' ;;
    *) printf '00\n' ;;
  esac
}

write_dns_forensics_snapshot() {
  [ -f "$LOG" ] || return 0

  FORENSICS_LEASES_INPUT="$LEASES_FILE"
  [ -f "$FORENSICS_LEASES_INPUT" ] || FORENSICS_LEASES_INPUT=/dev/null

  FORENSICS_RAW=/tmp/daa-forensics-raw.$$
  FORENSICS_CLIENTS=/tmp/daa-forensics-clients.$$
  FORENSICS_CLIENTS_TOP=/tmp/daa-forensics-clients-top.$$
  FORENSICS_DOMAINS=/tmp/daa-forensics-domains.$$
  FORENSICS_FAMILIES=/tmp/daa-forensics-families.$$
  FORENSICS_SNAPSHOT=/tmp/daa-forensics-snapshot.$$
  : > "$FORENSICS_RAW"; : > "$FORENSICS_CLIENTS"; : > "$FORENSICS_CLIENTS_TOP"; : > "$FORENSICS_DOMAINS"; : > "$FORENSICS_FAMILIES"; : > "$FORENSICS_SNAPSHOT"

  awk '
    function family_domain(domain, n, parts) {
      n = split(domain, parts, ".")
      if (n >= 2) return parts[n - 1] "." parts[n]
      return domain
    }
    NR == FNR {
      if (NF >= 4) {
        host = $4
        if (host == "" || host == "*") host = "?"
        hosts[$3] = host
      }
      next
    }
    / query\[/ && / from / && NF >= 8 {
      domain = $6
      client = $8
      if (domain == "" || client == "") next
      total[client]++
      domain_key = client SUBSEP domain
      if (!(domain_key in seen_domain)) {
        seen_domain[domain_key] = 1
        unique_domains[client]++
      }
      domain_count[domain_key]++
      family = family_domain(domain)
      family_count[client SUBSEP family]++
      if (!(client in hosts)) hosts[client] = "?"
    }
    END {
      for (client in total) {
        printf "CLIENT_RAW|%s|%s|%d|%d\n", client, hosts[client], total[client], unique_domains[client] + 0
      }
      for (domain_key in domain_count) {
        split(domain_key, parts, SUBSEP)
        printf "DOMAIN_RAW|%s|%d|%s\n", parts[1], domain_count[domain_key], parts[2]
      }
      for (family_key in family_count) {
        split(family_key, parts, SUBSEP)
        printf "FAMILY_RAW|%s|%d|%s\n", parts[1], family_count[family_key], parts[2]
      }
    }
  ' "$FORENSICS_LEASES_INPUT" "$LOG" > "$FORENSICS_RAW"

  grep '^CLIENT_RAW|' "$FORENSICS_RAW" | sort -t'|' -k4,4nr -k5,5nr -k2,2 > "$FORENSICS_CLIENTS"
  grep '^DOMAIN_RAW|' "$FORENSICS_RAW" | sort -t'|' -k2,2 -k3,3nr -k4,4 > "$FORENSICS_DOMAINS"
  grep '^FAMILY_RAW|' "$FORENSICS_RAW" | sort -t'|' -k2,2 -k3,3nr -k4,4 > "$FORENSICS_FAMILIES"

  if [ ! -s "$FORENSICS_CLIENTS" ]; then
    rm -f "$FORENSICS_RAW" "$FORENSICS_CLIENTS" "$FORENSICS_CLIENTS_TOP" "$FORENSICS_DOMAINS" "$FORENSICS_FAMILIES" "$FORENSICS_SNAPSHOT"
    return 0
  fi

  mkdir -p "$FORENSICS_DIR"

  total_queries=$(awk -F'|' '{ sum += $4 + 0 } END { print sum + 0 }' "$FORENSICS_CLIENTS")
  client_count=$(wc -l < "$FORENSICS_CLIENTS" 2>/dev/null | tr -d ' ')
  client_count=${client_count:-0}

  month_name=$(printf '%s\n' "$DATE_HDR" | awk '{ print $1 }')
  day_number=$(printf '%s\n' "$DATE_HDR" | awk '{ if ($2 ~ /^[0-9]+$/) printf "%02d\n", $2; else print "00" }')
  month_number=$(month_to_number "$month_name")
  window_hour=${LOG_FROM%%:*}
  [ "$window_hour" = "$LOG_FROM" ] && window_hour=00
  window_key="$(date '+%Y')-${month_number}-${day_number}T${window_hour}"
  snapshot_ts=$(date '+%Y-%m-%dT%H:%M:%S%z')
  snapshot_file="${FORENSICS_DIR}/${window_key}-${snapshot_ts}.tsv"

  head -n "$FORENSICS_TOP_CLIENTS" "$FORENSICS_CLIENTS" > "$FORENSICS_CLIENTS_TOP"

  {
    printf 'SNAPSHOT|%s\n' "$snapshot_ts"
    printf 'WINDOW|%s|%s|%s|%s|%s|%s\n' \
      "$window_key" "$DATE_HDR" "$LOG_FROM" "$LOG_TO" "$total_queries" "$client_count"
    rank=0
    while IFS='|' read -r _ client_ip host query_count unique_domains; do
      [ -n "$client_ip" ] || continue
      rank=$((rank + 1))
      top_family_info=$(awk -F'|' -v client_ip="$client_ip" '$2 == client_ip { print $4 "|" $3; exit }' "$FORENSICS_FAMILIES")
      top_family=-
      top_family_count=0
      if [ -n "$top_family_info" ]; then
        top_family=${top_family_info%%|*}
        top_family_count=${top_family_info##*|}
      fi
      printf 'CLIENT|%d|%s|%s|%s|%s|%s|%s\n' \
        "$rank" "$client_ip" "$host" "$query_count" "$unique_domains" "$top_family" "$top_family_count"
      awk -F'|' -v client_ip="$client_ip" -v max_rows="$FORENSICS_TOP_DOMAINS" '
        BEGIN { rank = 0 }
        $2 == client_ip && rank < max_rows {
          rank++
          printf "TOPDOMAIN|%s|%d|%s|%s\n", client_ip, rank, $3, $4
        }
      ' "$FORENSICS_DOMAINS"
      awk -F'|' -v client_ip="$client_ip" -v max_rows="$FORENSICS_TOP_FAMILIES" '
        BEGIN { rank = 0 }
        $2 == client_ip && rank < max_rows {
          rank++
          printf "TOPFAMILY|%s|%d|%s|%s\n", client_ip, rank, $3, $4
        }
      ' "$FORENSICS_FAMILIES"
    done < "$FORENSICS_CLIENTS_TOP"
  } > "$FORENSICS_SNAPSHOT"

  mv "$FORENSICS_SNAPSHOT" "$snapshot_file"

  find "$FORENSICS_DIR" -name '*.tsv' -mtime +"$FORENSICS_RETENTION_DAYS" -print 2>/dev/null | while IFS= read -r old_file; do
    [ -n "$old_file" ] && rm -f "$old_file"
  done

  rm -f "$FORENSICS_RAW" "$FORENSICS_CLIENTS" "$FORENSICS_CLIENTS_TOP" "$FORENSICS_DOMAINS" "$FORENSICS_FAMILIES" "$FORENSICS_SNAPSHOT"
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
      printf 'ipset=/%s/%s\n' "$kept_domain" "$VPN_IPSET"
      printf 'ipset=/%s/%s\n' "$kept_domain" "$STEALTH_IPSET"
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

refresh_candidate_events_state() {
  tmp_state="/tmp/daa-candidate-events-state.$$"
  [ -f "$CANDIDATE_EVENTS_STATE" ] || : > "$CANDIDATE_EVENTS_STATE"
  {
    cat "$CANDIDATE_EVENTS_STATE" 2>/dev/null
    cat "$CANDIDATE_EVENTS_NEW" 2>/dev/null
  } | awk -F '\t' -v cutoff="$CANDIDATE_RETENTION_CUTOFF_EPOCH" '
        NF >= 3 && $1 ~ /^[0-9]+$/ && $1 >= cutoff { print $1 "\t" $2 "\t" $3 }
      ' > "$tmp_state"
  mv "$tmp_state" "$CANDIDATE_EVENTS_STATE"
}

build_candidate_indexes() {
  : > "$CANDIDATE_COUNT24"
  : > "$CANDIDATE_COUNT7"
  : > "$CANDIDATE_DAYS7"
  [ -s "$CANDIDATE_EVENTS_STATE" ] || return 0
  awk -F '\t' -v cutoff24="$CANDIDATE_CUTOFF_24H_EPOCH" -v cutoff7="$CANDIDATE_CUTOFF_7D_EPOCH" '
    NF >= 3 && $1 ~ /^[0-9]+$/ {
      epoch = $1 + 0
      domain = $2
      cnt = $3 + 0
      if (epoch >= cutoff24) {
        sum24[domain] += cnt
      }
      if (epoch >= cutoff7) {
        sum7[domain] += cnt
        day_key = int(epoch / 86400)
        seen_day[domain "|" day_key] = 1
      }
    }
    END {
      for (d in sum24) {
        printf "24\t%s\t%d\n", d, sum24[d]
      }
      for (d in sum7) {
        printf "7\t%s\t%d\n", d, sum7[d]
      }
      for (k in seen_day) {
        split(k, parts, "|")
        domain = parts[1]
        days[domain] += 1
      }
      for (d in days) {
        printf "d\t%s\t%d\n", d, days[d]
      }
    }
  ' "$CANDIDATE_EVENTS_STATE" | while IFS='	' read -r marker domain value; do
    case "$marker" in
      24) printf '%s\t%s\n' "$domain" "$value" >> "$CANDIDATE_COUNT24" ;;
      7)  printf '%s\t%s\n' "$domain" "$value" >> "$CANDIDATE_COUNT7" ;;
      d)  printf '%s\t%s\n' "$domain" "$value" >> "$CANDIDATE_DAYS7" ;;
    esac
  done
}

get_candidate_count24() {
  domain="$1"
  [ -f "$CANDIDATE_COUNT24" ] || { printf '0\n'; return 0; }
  awk -F '\t' -v d="$domain" '
    $1 == d { print $2; found = 1; exit }
    END { if (!found) print 0 }
  ' "$CANDIDATE_COUNT24"
}

get_candidate_count7() {
  domain="$1"
  [ -f "$CANDIDATE_COUNT7" ] || { printf '0\n'; return 0; }
  awk -F '\t' -v d="$domain" '
    $1 == d { print $2; found = 1; exit }
    END { if (!found) print 0 }
  ' "$CANDIDATE_COUNT7"
}

get_candidate_days7() {
  domain="$1"
  [ -f "$CANDIDATE_DAYS7" ] || { printf '0\n'; return 0; }
  awk -F '\t' -v d="$domain" '
    $1 == d { print $2; found = 1; exit }
    END { if (!found) print 0 }
  ' "$CANDIDATE_DAYS7"
}

get_probe_last_epoch() {
  domain="$1"
  [ -f "$PROBE_HISTORY_STATE" ] || { printf '0\n'; return 0; }
  awk -F '\t' -v d="$domain" '
    $1 == d { print $2; found = 1; exit }
    END { if (!found) print 0 }
  ' "$PROBE_HISTORY_STATE"
}

update_probe_last_epoch() {
  domain="$1"
  ts="$2"
  tmp_history="/tmp/daa-probe-history.$$"

  if [ -f "$PROBE_HISTORY_STATE" ]; then
    awk -F '\t' -v d="$domain" -v ts="$ts" '
      BEGIN { updated = 0 }
      $1 == d { if (!updated) { print d "\t" ts; updated = 1 }; next }
      { print }
      END { if (!updated) print d "\t" ts }
    ' "$PROBE_HISTORY_STATE" > "$tmp_history"
  else
    printf '%s\t%s\n' "$domain" "$ts" > "$tmp_history"
  fi

  mv "$tmp_history" "$PROBE_HISTORY_STATE"
}

NOW=$(date '+%Y-%m-%d %H:%M')
CURRENT_EPOCH=$(date '+%s' 2>/dev/null || echo 0)
[ "$CURRENT_EPOCH" -gt 0 ] 2>/dev/null || CURRENT_EPOCH=0
CANDIDATE_CUTOFF_24H_EPOCH=$((CURRENT_EPOCH - CANDIDATE_WINDOW_24H_SEC))
[ "$CANDIDATE_CUTOFF_24H_EPOCH" -ge 0 ] 2>/dev/null || CANDIDATE_CUTOFF_24H_EPOCH=0
CANDIDATE_CUTOFF_7D_EPOCH=$((CURRENT_EPOCH - CANDIDATE_WINDOW_7D_SEC))
[ "$CANDIDATE_CUTOFF_7D_EPOCH" -ge 0 ] 2>/dev/null || CANDIDATE_CUTOFF_7D_EPOCH=0
CANDIDATE_RETENTION_CUTOFF_EPOCH=$((CURRENT_EPOCH - CANDIDATE_RETENTION_SEC))
[ "$CANDIDATE_RETENTION_CUTOFF_EPOCH" -ge 0 ] 2>/dev/null || CANDIDATE_RETENTION_CUTOFF_EPOCH=0

if [ "$MODE" != "--cleanup-only" ] && [ "$MODE" != "--forensics-only" ] && [ "$MODE" != "run" ] && [ -n "$MODE" ]; then
  echo "Usage: $0 [--cleanup-only] [--forensics-only]" >&2
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

write_dns_forensics_snapshot

if [ "$MODE" = "--forensics-only" ]; then
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
CANDIDATE_EVENTS_NEW=/tmp/daa-candidate-events-new.$$
CANDIDATE_COUNT24=/tmp/daa-candidate-count24.$$
CANDIDATE_COUNT7=/tmp/daa-candidate-count7.$$
CANDIDATE_DAYS7=/tmp/daa-candidate-days7.$$
PROBE_ELIGIBLE=/tmp/daa-probe-eligible.$$
PROBE_SELECTED_INTEREST=/tmp/daa-probe-interest.$$
PROBE_SELECTED_TOP=/tmp/daa-probe-top.$$
PROBE_SELECTED_FAIR=/tmp/daa-probe-fair.$$
PROBE_SELECTED_ALL=/tmp/daa-probe-all.$$
PROBE_SELECTED_DOMAINS=/tmp/daa-probe-selected-domains.$$
PROBE_REMAINING=/tmp/daa-probe-remaining.$$
GEO_LIST=/tmp/daa-geolist.$$
CLEANUP_LIST=/tmp/daa-cleanup.$$
MANAGED_DOMAINS=/tmp/daa-managed.$$
AUTO_DOMAINS=/tmp/daa-auto.$$
NO_VPN_DOMAINS=/tmp/daa-no-vpn.$$
: > "$CNT_ADD"; : > "$CNT_KNW"; : > "$CNT_SKP"; : > "$CNT_CND"; : > "$CNT_GEO"; : > "$CNT_CLN"
: > "$ADDED_LIST"; : > "$CANDIDATES"; : > "$CANDIDATES_PROBE"; : > "$CANDIDATE_EVENTS_NEW"; : > "$CANDIDATE_COUNT24"; : > "$CANDIDATE_COUNT7"; : > "$CANDIDATE_DAYS7"
: > "$PROBE_ELIGIBLE"; : > "$PROBE_SELECTED_INTEREST"; : > "$PROBE_SELECTED_TOP"; : > "$PROBE_SELECTED_FAIR"; : > "$PROBE_SELECTED_ALL"; : > "$PROBE_SELECTED_DOMAINS"; : > "$PROBE_REMAINING"
: > "$GEO_LIST"; : > "$CLEANUP_LIST"
: > "$MANAGED_DOMAINS"; : > "$AUTO_DOMAINS"; : > "$NO_VPN_DOMAINS"
trap 'rm -f "$CHANGED" "$CNT_ADD" "$CNT_KNW" "$CNT_SKP" "$CNT_CND" "$CNT_GEO" "$CNT_CLN" "$ADDED_LIST" "$CANDIDATES" "$CANDIDATES_PROBE" "$CANDIDATE_EVENTS_NEW" "$CANDIDATE_COUNT24" "$CANDIDATE_COUNT7" "$CANDIDATE_DAYS7" "$PROBE_ELIGIBLE" "$PROBE_SELECTED_INTEREST" "$PROBE_SELECTED_TOP" "$PROBE_SELECTED_FAIR" "$PROBE_SELECTED_ALL" "$PROBE_SELECTED_DOMAINS" "$PROBE_REMAINING" "$GEO_LIST" "$CLEANUP_LIST" "$MANAGED_DOMAINS" "$AUTO_DOMAINS" "$NO_VPN_DOMAINS"' 0

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
          printf '%s\t%s\t%s\n' "$CURRENT_EPOCH" "$domain" "$count" >> "$CANDIDATE_EVENTS_NEW"
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
        printf 'ipset=/%s/%s\n' "$write_domain" "$VPN_IPSET"
        printf 'ipset=/%s/%s\n' "$write_domain" "$STEALTH_IPSET"
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
PROBE_MIN_COUNT_24H=3
PROBE_MIN_COUNT_PRIORITY=1
PROBE_PRIORITY_MIN_SCORE=700
PROBE_MIN_DEVICES=1
PROBE_TOP_N=10
PROBE_FAIR_N=4
PROBE_INTEREST_N=2
PROBE_MAX_PER_RUN=16
PROBE_TIMEOUT=4
WAN_IFACE=wan0
probe_count=0

refresh_candidate_events_state
build_candidate_indexes

sort -rn "$CANDIDATES_PROBE" | while IFS=' ' read -r cand_score cand_count cand_devs cand_domain; do
  [ -n "$cand_domain" ] || continue
  [ "$cand_devs" -lt "$PROBE_MIN_DEVICES" ] && continue

  cand_count24=$(get_candidate_count24 "$cand_domain")
  cand_count7=$(get_candidate_count7 "$cand_domain")
  cand_days7=$(get_candidate_days7 "$cand_domain")
  cand_interest=0
  if [ "$cand_count7" -ge "$USER_INTEREST_MIN_COUNT_7D" ] && \
     [ "$cand_days7" -ge "$USER_INTEREST_MIN_DAYS_7D" ]; then
    cand_interest=1
  fi

  min_count="$PROBE_MIN_COUNT_24H"
  [ "$cand_score" -ge "$PROBE_PRIORITY_MIN_SCORE" ] && min_count="$PROBE_MIN_COUNT_PRIORITY"
  if [ "$cand_count24" -lt "$min_count" ] && [ "$cand_interest" -ne 1 ]; then
    continue
  fi

  cand_last_probe=$(get_probe_last_epoch "$cand_domain")
  cand_effective_score=$cand_score
  [ "$cand_interest" -eq 1 ] && cand_effective_score=$((cand_effective_score + PROBE_INTEREST_SCORE_BOOST))
  printf '%d\t%d\t%d\t%d\t%d\t%d\t%d\t%s\n' \
    "$cand_effective_score" "$cand_count24" "$cand_count7" "$cand_days7" "$cand_count" "$cand_last_probe" "$cand_interest" "$cand_domain" >> "$PROBE_ELIGIBLE"
done

# Reserve a small probe budget for "user interest" domains.
awk -F '	' '$7 == 1 { print }' "$PROBE_ELIGIBLE" \
  | sort -t '	' -k6,6n -k3,3nr -k1,1nr -k8,8 \
  | head -n "$PROBE_INTEREST_N" > "$PROBE_SELECTED_INTEREST"
awk -F '	' '{print $8}' "$PROBE_SELECTED_INTEREST" > "$PROBE_SELECTED_DOMAINS"
awk -F '	' 'NR==FNR { picked[$1]=1; next } !picked[$8] { print }' \
  "$PROBE_SELECTED_DOMAINS" "$PROBE_ELIGIBLE" > "$PROBE_REMAINING"

# Top priority by effective score.
sort -t '	' -k1,1nr -k2,2nr -k5,5nr -k8,8 "$PROBE_REMAINING" | head -n "$PROBE_TOP_N" > "$PROBE_SELECTED_TOP"
awk -F '	' '{print $8}' "$PROBE_SELECTED_TOP" >> "$PROBE_SELECTED_DOMAINS"
awk -F '	' 'NR==FNR { picked[$1]=1; next } !picked[$8] { print }' \
  "$PROBE_SELECTED_DOMAINS" "$PROBE_ELIGIBLE" > "$PROBE_REMAINING"

# Fair queue by "longest since last probe" (or never probed = 0).
sort -t '	' -k6,6n -k1,1nr -k2,2nr -k8,8 "$PROBE_REMAINING" | head -n "$PROBE_FAIR_N" > "$PROBE_SELECTED_FAIR"

cat "$PROBE_SELECTED_INTEREST" "$PROBE_SELECTED_TOP" "$PROBE_SELECTED_FAIR" \
  | awk -F '	' '!seen[$8]++ { print }' > "$PROBE_SELECTED_ALL"

while IFS='	' read -r cand_effective_score cand_count24 cand_count7 cand_days7 cand_count cand_last_probe cand_interest cand_domain; do
  [ -n "$cand_domain" ] || continue
  [ "$probe_count" -ge "$PROBE_MAX_PER_RUN" ] && break

  # Determine write target (same family-domain logic as main loop)
  cand_write=$(get_family_domain "$cand_domain")

  # Skip if already covered in any config
  if is_domain_covered_by_lists "$cand_write" "$MANAGED_DOMAINS" "$AUTO_DOMAINS"; then
    continue
  fi

  http_code=$(curl -s --max-time "$PROBE_TIMEOUT" --interface "$WAN_IFACE" \
                   -o /dev/null -w '%{http_code}' "https://$cand_domain/" 2>/dev/null)
  probe_count=$((probe_count + 1))
  update_probe_last_epoch "$cand_domain" "$CURRENT_EPOCH"

  if [ "$http_code" = "000" ]; then
    interest_tag=""
    [ "$cand_interest" -eq 1 ] && interest_tag=" interest"
    cand_srcs=$(grep "query\[A\] ${cand_domain} from" "$LOG" \
                | awk '{print $8}' | sort -u | tr '\n' ',' | sed 's/,$//')
    {
      printf '\n# geo-blocked (ISP:000%s) %s (queries24h: %d, queries7d: %d, from: %s)\n' \
             "$interest_tag" "$NOW" "$cand_count24" "$cand_count7" "$cand_srcs"
      printf 'ipset=/%s/%s\n'          "$cand_write" "$VPN_IPSET"
      printf 'server=/%s/1.1.1.1@%s\n' "$cand_write" "$VPN_IFACE"
      printf 'server=/%s/9.9.9.9@%s\n' "$cand_write" "$VPN_IFACE"
    } >> "$AUTO"
    if [ "$cand_interest" -eq 1 ]; then
      printf '  + %-48s %3d запр24 %3d запр7д  ISP:000 interest\n' "$cand_write" "$cand_count24" "$cand_count7" >> "$GEO_LIST"
    else
      printf '  + %-48s %3d запр24            ISP:000\n' "$cand_write" "$cand_count24" >> "$GEO_LIST"
    fi
    echo 1 >> "$CNT_GEO"
    printf '%s\n' "$cand_write" >> "$AUTO_DOMAINS"
    sort -u "$AUTO_DOMAINS" -o "$AUTO_DOMAINS"
    touch "$CHANGED"
    logger -t domain-auto-add "Geo-blocked: $cand_domain → $cand_write (ISP:000, queries24h: $cand_count24, queries7d: $cand_count7, interest: $cand_interest)"
  fi
done < "$PROBE_SELECTED_ALL"

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
