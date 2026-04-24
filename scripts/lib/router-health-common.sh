#!/bin/bash

router_health_project_root() {
  local source_dir
  source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  printf '%s\n' "$source_dir"
}

router_health_load_env() {
  if [ -n "${ROUTER_HEALTH_INIT_DONE:-}" ]; then
    return 0
  fi

  PROJECT_ROOT="$(router_health_project_root)"
  [ -f "${PROJECT_ROOT}/secrets/router.env" ] && set -a && . "${PROJECT_ROOT}/secrets/router.env" && set +a
  [ -f "${PROJECT_ROOT}/.env" ] && set -a && . "${PROJECT_ROOT}/.env" && set +a

  ROUTER_USER="${ROUTER_USER:-admin}"
  ROUTER_PORT="${ROUTER_PORT:-22}"
  CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-5}"
  ROUTER="${ROUTER:-}"
  SSH_IDENTITY_FILE="${SSH_IDENTITY_FILE:-${HOME}/.ssh/id_rsa}"

  if [ -z "$ROUTER" ]; then
    ROUTER="$(router_detect_ip)"
  fi
  [ -n "$ROUTER" ] || { echo "Cannot detect router IP. Set ROUTER=<ip> in secrets/router.env (or .env)" >&2; return 1; }

  SSH_OPTS=(
    -i "$SSH_IDENTITY_FILE"
    -p "$ROUTER_PORT"
    -o ConnectTimeout="$CONNECT_TIMEOUT"
    -o IdentitiesOnly=yes
    -o PubkeyAcceptedAlgorithms=+ssh-rsa
    -o StrictHostKeyChecking=accept-new
  )

  ROUTER_HEALTH_INIT_DONE=1
}

router_detect_ip() {
  local candidate

  if command -v route >/dev/null 2>&1; then
    candidate="$(route -n get default 2>/dev/null | awk '/gateway:/ { print $2; exit }')"
    if [ -n "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi

  if command -v ip >/dev/null 2>&1; then
    candidate="$(ip route show default 2>/dev/null | awk '/default/ { print $3; exit }')"
    if [ -n "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi

  if command -v ifconfig >/dev/null 2>&1; then
    while IFS='|' read -r iface ip; do
      [ -n "$ip" ] || continue
      candidate="$(printf '%s\n' "$ip" | awk -F. 'NF == 4 { printf "%s.%s.%s.1\n", $1, $2, $3 }')"
      [ -n "$candidate" ] || continue
      if command -v nc >/dev/null 2>&1; then
        nc -G 1 -z "$candidate" 22 >/dev/null 2>&1 && { printf '%s\n' "$candidate"; return 0; }
      else
        printf '%s\n' "$candidate"
        return 0
      fi
    done < <(
      ifconfig 2>/dev/null | awk '
        /^[[:alnum:]][^:]*:/ {
          iface = $1
          sub(/:$/, "", iface)
          next
        }
        $1 == "inet" {
          ip = $2
          if (iface ~ /^(lo|utun|tun|tap|wg|tailscale)/) next
          if (ip ~ /^127\./ || ip ~ /^169\.254\./) next
          if (ip ~ /^10\./ || ip ~ /^192\.168\./ || ip ~ /^172\.(1[6-9]|2[0-9]|3[0-1])\./) {
            printf "%s|%s\n", iface, ip
          }
        }'
    )
  fi

  for candidate in 192.168.50.1 192.168.1.1 192.168.0.1 10.0.0.1; do
    if command -v nc >/dev/null 2>&1; then
      nc -G 1 -z "$candidate" 22 >/dev/null 2>&1 && { printf '%s\n' "$candidate"; return 0; }
    fi
  done

  return 1
}

router_ssh() {
  router_health_load_env || return 1
  ssh "${SSH_OPTS[@]}" "${ROUTER_USER}@${ROUTER}" "$@"
}

router_kv_get() {
  local file="$1"
  local key="$2"
  awk -F= -v key="$key" '
    $1 == key {
      print substr($0, index($0, "=") + 1)
      exit
    }' "$file"
}

router_capacity_level() {
  awk -v usage="${1:-}" '
    BEGIN {
      if (usage == "" || usage == "n/a") print "Unknown";
      else if (usage + 0 < 20) print "OK";
      else if (usage + 0 < 30) print "Watch";
      else if (usage + 0 < 50) print "Warning";
      else print "Critical";
    }'
}

router_extract_int() {
  local value="${1:-}"

  awk -v value="$value" '
    BEGIN {
      if (match(value, /-?[0-9]+/)) print substr(value, RSTART, RLENGTH);
      else print "";
    }'
}

router_growth_level() {
  local delta="${1:-}"
  local usage="${2:-}"
  local maxelem="${3:-65536}"

  awk -v delta="$delta" -v usage="$usage" -v maxelem="$maxelem" '
    BEGIN {
      if (delta == "" || delta == "n/a") {
        print "Unknown"
      } else if (usage != "" && usage != "n/a" && usage + 0 >= 50) {
        print "Critical"
      } else if ((delta + 0) >= (maxelem + 0) * 0.10) {
        print "Critical"
      } else if (usage != "" && usage != "n/a" && usage + 0 >= 30) {
        print "Warning"
      } else if ((delta + 0) >= (maxelem + 0) * 0.05) {
        print "Warning"
      } else if (usage != "" && usage != "n/a" && usage + 0 >= 20) {
        print "Informational"
      } else if ((delta + 0) >= (maxelem + 0) * 0.01) {
        print "Informational"
      } else if ((delta + 0) > 0) {
        print "Stable growth"
      } else if ((delta + 0) == 0) {
        print "Stable"
      } else {
        print "Contracted"
      }
    }'
}

router_auto_growth_note() {
  local total_delta="${1:-}"
  local auto_delta="${2:-}"

  awk -v total_delta="$total_delta" -v auto_delta="$auto_delta" '
    BEGIN {
      if (total_delta == "" || auto_delta == "" || total_delta == "n/a" || auto_delta == "n/a") {
        print "n/a"
      } else if (auto_delta + 0 <= 0) {
        print "auto-catalog growth is not the current driver"
      } else if (total_delta + 0 <= 0) {
        print "auto-catalog grew while total catalog stayed flat/contracted"
      } else if ((auto_delta + 0) >= (total_delta + 0) * 0.75) {
        print "auto-catalog explains most recent rule growth"
      } else if ((auto_delta + 0) >= (total_delta + 0) * 0.50) {
        print "auto-catalog explains a large share of recent rule growth"
      } else {
        print "manual/static changes explain most recent rule growth"
      }
    }'
}

router_freshness_level() {
  local epoch="${1:-0}"
  local warn_after="${2:-0}"
  local critical_after="${3:-0}"

  awk -v epoch="$epoch" -v warn_after="$warn_after" -v critical_after="$critical_after" '
    BEGIN {
      if (epoch == "" || epoch + 0 <= 0) print "Missing";
      else if (critical_after > 0 && epoch + 0 >= critical_after + 0) print "Critical";
      else if (warn_after > 0 && epoch + 0 >= warn_after + 0) print "Warning";
      else print "OK";
    }'
}

router_age_seconds() {
  local now_epoch="${1:-0}"
  local then_epoch="${2:-0}"

  awk -v now_epoch="$now_epoch" -v then_epoch="$then_epoch" '
    BEGIN {
      if (now_epoch + 0 <= 0 || then_epoch + 0 <= 0) print "-1";
      else print now_epoch - then_epoch;
    }'
}

router_human_age() {
  local age="${1:-0}"

  awk -v age="$age" '
    BEGIN {
      if (age == "" || age + 0 < 0) {
        print "n/a"
      } else if (age < 60) {
        printf "%ds", age
      } else if (age < 3600) {
        printf "%dm", int(age / 60)
      } else if (age < 86400) {
        printf "%dh %dm", int(age / 3600), int((age % 3600) / 60)
      } else {
        printf "%dd %dh", int(age / 86400), int((age % 86400) / 3600)
      }
    }'
}

router_is_one() {
  [ "${1:-0}" = "1" ]
}

router_ipv6_runtime_present() {
  local state_file="$1"

  if router_is_one "$(router_kv_get "$state_file" IPV6_ADDR_BR0)" ||
    router_is_one "$(router_kv_get "$state_file" IPV6_ADDR_WAN0)" ||
    router_is_one "$(router_kv_get "$state_file" IPV6_ADDR_WGC1)" ||
    router_is_one "$(router_kv_get "$state_file" IPV6_ADDR_WGS1)" ||
    router_is_one "$(router_kv_get "$state_file" IPV6_ROUTE_MAIN)" ||
    router_is_one "$(router_kv_get "$state_file" IPV6_ROUTE_WGC1)"; then
    printf '1\n'
  else
    printf '0\n'
  fi
}

router_ipv6_lan_wan_present() {
  local state_file="$1"

  if router_is_one "$(router_kv_get "$state_file" IPV6_ADDR_BR0)" ||
    router_is_one "$(router_kv_get "$state_file" IPV6_ADDR_WAN0)" ||
    router_is_one "$(router_kv_get "$state_file" IPV6_ROUTE_MAIN)"; then
    printf '1\n'
  else
    printf '0\n'
  fi
}

router_ipv6_wgc1_path_present() {
  local state_file="$1"

  if router_is_one "$(router_kv_get "$state_file" IPV6_ADDR_WGC1)" ||
    router_is_one "$(router_kv_get "$state_file" IPV6_ROUTE_WGC1)"; then
    printf '1\n'
  else
    printf '0\n'
  fi
}

router_ipv6_all_disable_flags_set() {
  local state_file="$1"

  if [ "$(router_kv_get "$state_file" IPV6_DISABLE_ALL)" = "1" ] &&
    [ "$(router_kv_get "$state_file" IPV6_DISABLE_DEFAULT)" = "1" ] &&
    [ "$(router_kv_get "$state_file" IPV6_DISABLE_BR0)" = "1" ] &&
    [ "$(router_kv_get "$state_file" IPV6_DISABLE_WAN0)" = "1" ] &&
    [ "$(router_kv_get "$state_file" IPV6_DISABLE_WGC1)" = "1" ] &&
    [ "$(router_kv_get "$state_file" IPV6_DISABLE_WGS1)" = "1" ]; then
    printf '1\n'
  else
    printf '0\n'
  fi
}

router_ipv6_policy_mode() {
  local state_file="$1"
  local service
  local runtime_present
  local lan_wan_present
  local wgc1_path_present

  service="$(router_kv_get "$state_file" IPV6_SERVICE)"
  runtime_present="$(router_ipv6_runtime_present "$state_file")"
  lan_wan_present="$(router_ipv6_lan_wan_present "$state_file")"
  wgc1_path_present="$(router_ipv6_wgc1_path_present "$state_file")"

  if [ "${service:-disabled}" = "disabled" ]; then
    printf 'Disabled\n'
  elif [ "$runtime_present" != "1" ]; then
    printf 'Enabled in UI only\n'
  elif [ "$lan_wan_present" = "1" ] && [ "$wgc1_path_present" != "1" ]; then
    printf 'Partial enable\n'
  else
    printf 'Runtime drift\n'
  fi
}

router_ipv6_policy_level() {
  local state_file="$1"
  local service
  local runtime_present
  local lan_wan_present
  local wgc1_path_present
  local all_disable_flags

  service="$(router_kv_get "$state_file" IPV6_SERVICE)"
  runtime_present="$(router_ipv6_runtime_present "$state_file")"
  lan_wan_present="$(router_ipv6_lan_wan_present "$state_file")"
  wgc1_path_present="$(router_ipv6_wgc1_path_present "$state_file")"
  all_disable_flags="$(router_ipv6_all_disable_flags_set "$state_file")"

  if [ "${service:-disabled}" = "disabled" ] && [ "$runtime_present" != "1" ] && [ "$all_disable_flags" = "1" ]; then
    printf 'OK\n'
  elif [ "${service:-disabled}" = "disabled" ] && [ "$runtime_present" != "1" ]; then
    printf 'Warning\n'
  elif [ "$lan_wan_present" = "1" ] && [ "$wgc1_path_present" != "1" ]; then
    printf 'Critical\n'
  else
    printf 'Warning\n'
  fi
}

router_ipv6_policy_note() {
  local state_file="$1"
  local service
  local runtime_present
  local lan_wan_present
  local wgc1_path_present
  local all_disable_flags

  service="$(router_kv_get "$state_file" IPV6_SERVICE)"
  runtime_present="$(router_ipv6_runtime_present "$state_file")"
  lan_wan_present="$(router_ipv6_lan_wan_present "$state_file")"
  wgc1_path_present="$(router_ipv6_wgc1_path_present "$state_file")"
  all_disable_flags="$(router_ipv6_all_disable_flags_set "$state_file")"

  if [ "${service:-disabled}" = "disabled" ] && [ "$runtime_present" != "1" ] && [ "$all_disable_flags" = "1" ]; then
    printf 'IPv6 is disabled in Merlin and no live IPv6 runtime was detected. Safe UI setting remains: IPv6 -> Отключить.\n'
  elif [ "${service:-disabled}" = "disabled" ] && [ "$runtime_present" != "1" ]; then
    printf 'Merlin reports IPv6 disabled, but one or more kernel disable flags drifted away from the expected all-1 state. Keep IPv6 -> Отключить and treat this as policy drift.\n'
  elif [ "${service:-disabled}" != "disabled" ] && [ "$runtime_present" != "1" ]; then
    printf 'IPv6 is enabled in Merlin UI, but no live IPv6 runtime was detected yet. Keep IPv6 -> Отключить until a separate dual-stack project exists.\n'
  elif [ "$lan_wan_present" = "1" ] && [ "$wgc1_path_present" != "1" ]; then
    printf 'LAN/WAN IPv6 is active, but wgc1 has no live IPv6 address/route. This can bypass repo-managed VPN routing.\n'
  else
    printf 'IPv6 runtime exists, but the repo still has no active dual-stack routing layer. Treat this as drift until a separate dual-stack project exists.\n'
  fi
}

router_wgs1_collection_problem() {
  local state_file="$1"

  if [ "$(router_kv_get "$state_file" WG_BIN_FOUND)" != "1" ] ||
    [ "$(router_kv_get "$state_file" WGS1_IFACE_EXISTS)" != "1" ] ||
    [ "$(router_kv_get "$state_file" WGS1_CURRENT_DUMP_OK)" != "1" ]; then
    printf '1\n'
  else
    printf '0\n'
  fi
}

router_wgs1_snapshot_state() {
  local state_file="$1"
  local freshness_level="${2:-OK}"

  if [ "$(router_wgs1_collection_problem "$state_file")" = "1" ]; then
    printf 'Capability problem\n'
  elif [ "$(router_kv_get "$state_file" LATEST_WGS1_EXISTS)" != "1" ] ||
    [ "$(router_kv_get "$state_file" LATEST_WGS1_HAS_DATA)" != "1" ]; then
    printf 'Missing\n'
  elif [ "$freshness_level" != "OK" ]; then
    printf 'Stale\n'
  else
    printf 'Fresh and usable\n'
  fi
}

router_wgs1_snapshot_note() {
  local state_file="$1"
  local freshness_level="${2:-OK}"
  local state

  state="$(router_wgs1_snapshot_state "$state_file" "$freshness_level")"

  case "$state" in
    "Capability problem")
      printf 'wgs1 snapshot collection cannot run cleanly. Check wg binary lookup, wgs1 interface/runtime, and cron execution path.\n'
      ;;
    "Missing")
      printf 'No saved wgs1 dump artifact has accumulated yet. Router-wide wgs1 totals can still exist before the first usable per-peer baseline appears.\n'
      ;;
    "Stale")
      printf 'A saved wgs1 dump exists, but its freshness is outside the expected snapshot window.\n'
      ;;
    *)
      printf 'Fresh raw wgs1 dump snapshots are available for peer breakdowns.\n'
      ;;
  esac
}

router_wgs1_window_state() {
  local traffic_file="$1"
  local warning_text

  warning_text="$(router_kv_get "$traffic_file" TRAFFIC_WGS1_PEER_BREAKDOWN_WARNING)"
  if [ -n "$warning_text" ]; then
    printf 'No usable peer baseline in current traffic window\n'
  else
    printf 'Usable\n'
  fi
}

router_wgs1_window_note() {
  local traffic_file="$1"
  local warning_text

  warning_text="$(router_kv_get "$traffic_file" TRAFFIC_WGS1_PEER_BREAKDOWN_WARNING)"
  if [ -n "$warning_text" ]; then
    printf '%s\n' "$warning_text"
  else
    printf 'Per-peer WireGuard deltas are available for the current traffic window.\n'
  fi
}

router_collect_health_state() {
  local outfile="$1"
  router_health_load_env || return 1

  router_ssh 'sh -s' <<'REMOTE' > "$outfile"
set -eu

latest_file() {
  local pattern="$1"
  local latest
  latest=$(ls $pattern 2>/dev/null | sort | tail -1 || true)
  printf '%s\n' "$latest"
}

file_epoch() {
  local file="$1"
  if [ -n "$file" ] && [ -e "$file" ]; then
    date -r "$file" +%s 2>/dev/null || printf '0\n'
  else
    printf '0\n'
  fi
}

bool_grep() {
  local haystack="$1"
  local needle="$2"
  printf '%s\n' "$haystack" | grep -F -- "$needle" >/dev/null 2>&1 && printf '1\n' || printf '0\n'
}

bool_nonempty() {
  local value="$1"
  [ -n "$value" ] && printf '1\n' || printf '0\n'
}

sysctl_value() {
  local path="$1"
  if [ -f "$path" ]; then
    cat "$path" 2>/dev/null || printf 'missing\n'
  else
    printf 'missing\n'
  fi
}

now_epoch=$(date +%s)
state_dir="/jffs/addons/router_configuration/traffic"
[ -x /opt/bin/opkg ] && state_dir="/opt/var/log/router_configuration"

vpn_current=$(ipset list VPN_DOMAINS 2>/dev/null | awk '/^Number of entries:/ {print $4; exit}')
vpn_header=$(ipset list VPN_DOMAINS 2>/dev/null | awk -F'Header: ' '/^Header:/ {print $2; exit}')
vpn_max=$(printf '%s\n' "$vpn_header" | awk '{for (i = 1; i <= NF; i++) if ($i == "maxelem") {print $(i+1); exit}}')
vpn_mem=$(ipset list VPN_DOMAINS 2>/dev/null | awk '/^Size in memory:/ {print $4; exit}')
vpn_exists=0
[ -n "${vpn_current:-}" ] && vpn_exists=1

vpn_static_current=$(ipset list VPN_STATIC_NETS 2>/dev/null | awk '/^Number of entries:/ {print $4; exit}')
vpn_static_exists=0
[ -n "${vpn_static_current:-}" ] && vpn_static_exists=1

stealth_current=$(ipset list STEALTH_DOMAINS 2>/dev/null | awk '/^Number of entries:/ {print $4; exit}')
stealth_exists=0
[ -n "${stealth_current:-}" ] && stealth_exists=1

manual_count=$(grep -c '^ipset=' /jffs/configs/dnsmasq.conf.add 2>/dev/null || printf '0\n')
auto_count=$(grep -c '^ipset=' /jffs/configs/dnsmasq-autodiscovered.conf.add 2>/dev/null || printf '0\n')

cron_list=$(cru l 2>/dev/null || true)
dnscrypt_config=$(cat /opt/etc/dnscrypt-proxy.toml 2>/dev/null || true)
singbox_config=$(cat /opt/etc/sing-box/config.json 2>/dev/null || true)
prerouting_mangle=$(iptables -t mangle -S PREROUTING 2>/dev/null || true)
output_mangle=$(iptables -t mangle -S OUTPUT 2>/dev/null || true)
nat_prerouting=$(iptables -t nat -S PREROUTING 2>/dev/null || true)
filter_forward=$(iptables -S FORWARD 2>/dev/null || true)
listen_sockets=$(netstat -nlp 2>/dev/null || true)
ip_rules=$(ip rule show 2>/dev/null || true)
route_table_200=$(ip route show table 200 2>/dev/null || true)
chain_rules=$(iptables -t mangle -S RC_VPN_ROUTE 2>/dev/null || true)
ipv6_service=$(nvram get ipv6_service 2>/dev/null || true)
ipv6_addr_br0=$(ip -6 -o addr show dev br0 2>/dev/null || true)
ipv6_addr_wan0=$(ip -6 -o addr show dev wan0 2>/dev/null || true)
ipv6_addr_wgc1=$(ip -6 -o addr show dev wgc1 2>/dev/null || true)
ipv6_addr_wgs1=$(ip -6 -o addr show dev wgs1 2>/dev/null || true)
ipv6_route_main=$(ip -6 route show 2>/dev/null || true)
ipv6_route_wgc1=$(ip -6 route show table wgc1 2>/dev/null || true)
wg_bin=""
for candidate in /usr/sbin/wg /opt/bin/wg /usr/bin/wg /bin/wg; do
  if [ -x "$candidate" ]; then
    wg_bin="$candidate"
    break
  fi
done
wgs1_iface_exists=0
[ -d /sys/class/net/wgs1 ] && wgs1_iface_exists=1
wgs1_current_dump_ok=0
if [ -n "$wg_bin" ] && [ "$wgs1_iface_exists" = "1" ]; then
  if "$wg_bin" show wgs1 dump >/dev/null 2>&1; then
    wgs1_current_dump_ok=1
  fi
fi

blocked_file="/opt/tmp/blocked-domains.lst"
persist_file=""
if [ -f /opt/tmp/VPN_DOMAINS.ipset ]; then
  persist_file="/opt/tmp/VPN_DOMAINS.ipset"
elif [ -f /jffs/addons/router_configuration/VPN_DOMAINS.ipset ]; then
  persist_file="/jffs/addons/router_configuration/VPN_DOMAINS.ipset"
else
  persist_file="/opt/tmp/VPN_DOMAINS.ipset"
fi

latest_tailscale=$(latest_file "$state_dir/tailscale/*.json")
latest_wgs1=$(latest_file "$state_dir/wgs1/*.dump")
latest_daily=$(latest_file "$state_dir/daily/*-lan-conntrack.txt")
interface_counters="$state_dir/interface-counters.tsv"
latest_wgs1_exists=0
latest_wgs1_has_data=0
if [ -n "$latest_wgs1" ] && [ -f "$latest_wgs1" ]; then
  latest_wgs1_exists=1
  [ -s "$latest_wgs1" ] && latest_wgs1_has_data=1
fi

printf 'NOW_EPOCH=%s\n' "$now_epoch"
printf 'ROUTER_PRODUCT=%s\n' "$(nvram get productid 2>/dev/null || true)"
printf 'ROUTER_BUILDNO=%s\n' "$(nvram get buildno 2>/dev/null || true)"
printf 'ROUTER_EXTENDNO=%s\n' "$(nvram get extendno 2>/dev/null || true)"
printf 'ROUTER_UPTIME=%s\n' "$(uptime 2>/dev/null || true)"
printf 'STATE_DIR=%s\n' "$state_dir"

printf 'VPN_DOMAINS_EXISTS=%s\n' "$vpn_exists"
printf 'VPN_DOMAINS_CURRENT=%s\n' "${vpn_current:-0}"
printf 'VPN_DOMAINS_MAX=%s\n' "${vpn_max:-65536}"
printf 'VPN_DOMAINS_MEM=%s\n' "${vpn_mem:-0}"
printf 'VPN_STATIC_NETS_EXISTS=%s\n' "$vpn_static_exists"
printf 'VPN_STATIC_NETS_CURRENT=%s\n' "${vpn_static_current:-0}"
printf 'STEALTH_DOMAINS_EXISTS=%s\n' "$stealth_exists"
printf 'STEALTH_DOMAINS_CURRENT=%s\n' "${stealth_current:-0}"
printf 'MANUAL_RULE_COUNT=%s\n' "${manual_count:-0}"
printf 'AUTO_RULE_COUNT=%s\n' "${auto_count:-0}"
printf 'IPV6_SERVICE=%s\n' "${ipv6_service:-disabled}"
printf 'IPV6_DISABLE_ALL=%s\n' "$(sysctl_value /proc/sys/net/ipv6/conf/all/disable_ipv6)"
printf 'IPV6_DISABLE_DEFAULT=%s\n' "$(sysctl_value /proc/sys/net/ipv6/conf/default/disable_ipv6)"
printf 'IPV6_DISABLE_BR0=%s\n' "$(sysctl_value /proc/sys/net/ipv6/conf/br0/disable_ipv6)"
printf 'IPV6_DISABLE_WAN0=%s\n' "$(sysctl_value /proc/sys/net/ipv6/conf/wan0/disable_ipv6)"
printf 'IPV6_DISABLE_WGC1=%s\n' "$(sysctl_value /proc/sys/net/ipv6/conf/wgc1/disable_ipv6)"
printf 'IPV6_DISABLE_WGS1=%s\n' "$(sysctl_value /proc/sys/net/ipv6/conf/wgs1/disable_ipv6)"
printf 'IPV6_ADDR_BR0=%s\n' "$(bool_nonempty "$ipv6_addr_br0")"
printf 'IPV6_ADDR_WAN0=%s\n' "$(bool_nonempty "$ipv6_addr_wan0")"
printf 'IPV6_ADDR_WGC1=%s\n' "$(bool_nonempty "$ipv6_addr_wgc1")"
printf 'IPV6_ADDR_WGS1=%s\n' "$(bool_nonempty "$ipv6_addr_wgs1")"
printf 'IPV6_ROUTE_MAIN=%s\n' "$(bool_nonempty "$ipv6_route_main")"
printf 'IPV6_ROUTE_WGC1=%s\n' "$(bool_nonempty "$ipv6_route_wgc1")"
printf 'WG_BIN_FOUND=%s\n' "$( [ -n "$wg_bin" ] && printf '1\n' || printf '0\n' )"
printf 'WGS1_IFACE_EXISTS=%s\n' "$wgs1_iface_exists"
printf 'WGS1_CURRENT_DUMP_OK=%s\n' "$wgs1_current_dump_ok"

printf 'RULE_DNS_1111=%s\n' "$(bool_grep "$ip_rules" 'to 1.1.1.1 lookup wgc1')"
printf 'RULE_DNS_9999=%s\n' "$(bool_grep "$ip_rules" 'to 9.9.9.9 lookup wgc1')"
printf 'RULE_MARK_0X1000=%s\n' "$(bool_grep "$ip_rules" 'fwmark 0x1000/0x1000 lookup wgc1')"
printf 'RULE_MARK_0X2000=%s\n' "$(bool_grep "$ip_rules" 'fwmark 0x2000')"
printf 'ROUTE_TABLE_200_SINGBOX=%s\n' "$(bool_grep "$route_table_200" 'default dev singbox0')"
printf 'CHAIN_RC_VPN_ROUTE=%s\n' "$( [ -n "$chain_rules" ] && printf '1\n' || printf '0\n' )"
printf 'HOOK_PREROUTING_BR0=%s\n' "$(bool_grep "$prerouting_mangle" '-A PREROUTING -i br0 -j RC_VPN_ROUTE')"
printf 'HOOK_PREROUTING_WGS1=%s\n' "$(bool_grep "$prerouting_mangle" '-A PREROUTING -i wgs1 -j RC_VPN_ROUTE')"
printf 'HOOK_OUTPUT=%s\n' "$(bool_grep "$output_mangle" '-A OUTPUT -j RC_VPN_ROUTE')"
printf 'HOOK_STEALTH_PREROUTING_BR0=%s\n' "$(bool_grep "$prerouting_mangle" '-A PREROUTING -i br0 -m set --match-set STEALTH_DOMAINS dst')"
printf 'HOOK_STEALTH_PREROUTING_WGS1=%s\n' "$(bool_grep "$prerouting_mangle" '-A PREROUTING -i wgs1 -m set --match-set STEALTH_DOMAINS dst')"
printf 'HOOK_STEALTH_OUTPUT=%s\n' "$(bool_grep "$output_mangle" '-A OUTPUT -m set --match-set STEALTH_DOMAINS dst')"
printf 'CHANNEL_B_REDIRECT_LISTENER=%s\n' "$(bool_grep "$listen_sockets" '0.0.0.0:<lan-redirect-port>')"
printf 'CHANNEL_B_DNSCRYPT_SOCKS_LISTENER=%s\n' "$(bool_grep "$listen_sockets" '127.0.0.1:1080')"
printf 'CHANNEL_B_DNSCRYPT_PROXY=%s\n' "$(bool_grep "$dnscrypt_config" 'socks5://127.0.0.1:1080')"
printf 'CHANNEL_B_SINGBOX_KEEPALIVE=%s\n' "$(bool_grep "$singbox_config" 'tcp_keep_alive_interval')"
printf 'CHANNEL_B_REDIRECT_STEALTH=%s\n' "$(bool_grep "$nat_prerouting" '-A PREROUTING -i br0 -p tcp -m set --match-set STEALTH_DOMAINS dst -j REDIRECT --to-ports <lan-redirect-port>')"
printf 'CHANNEL_B_REDIRECT_STATIC=%s\n' "$(bool_grep "$nat_prerouting" '-A PREROUTING -i br0 -p tcp -m set --match-set VPN_STATIC_NETS dst -j REDIRECT --to-ports <lan-redirect-port>')"
printf 'CHANNEL_B_DROP_QUIC_STEALTH=%s\n' "$(bool_grep "$filter_forward" '-A FORWARD -i br0 -p udp -m udp --dport 443 -m set --match-set STEALTH_DOMAINS dst -j DROP')"
printf 'CHANNEL_B_DROP_QUIC_STATIC=%s\n' "$(bool_grep "$filter_forward" '-A FORWARD -i br0 -p udp -m udp --dport 443 -m set --match-set VPN_STATIC_NETS dst -j DROP')"
printf 'CHANNEL_B_REJECT_QUIC_STEALTH=%s\n' "$(bool_grep "$filter_forward" '-A FORWARD -i br0 -p udp -m udp --dport 443 -m set --match-set STEALTH_DOMAINS dst -j REJECT')"
printf 'CHANNEL_B_REJECT_QUIC_STATIC=%s\n' "$(bool_grep "$filter_forward" '-A FORWARD -i br0 -p udp -m udp --dport 443 -m set --match-set VPN_STATIC_NETS dst -j REJECT')"
printf 'DNS_REDIRECT_UDP=%s\n' "$(bool_grep "$nat_prerouting" '-A PREROUTING -i wgs1 -p udp -m udp --dport 53 -j REDIRECT --to-ports 53')"
printf 'DNS_REDIRECT_TCP=%s\n' "$(bool_grep "$nat_prerouting" '-A PREROUTING -i wgs1 -p tcp -m tcp --dport 53 -j REDIRECT --to-ports 53')"

printf 'CRON_SAVE_IPSET=%s\n' "$(bool_grep "$cron_list" '/jffs/scripts/cron-save-ipset')"
printf 'CRON_TRAFFIC_SNAPSHOT=%s\n' "$(bool_grep "$cron_list" '/jffs/scripts/cron-traffic-snapshot')"
printf 'CRON_TRAFFIC_DAILY_CLOSE=%s\n' "$(bool_grep "$cron_list" '/jffs/scripts/cron-traffic-daily-close')"
printf 'CRON_DOMAIN_AUTO_ADD=%s\n' "$(bool_grep "$cron_list" '/jffs/addons/x3mRouting/domain-auto-add.sh')"
printf 'CRON_SINGBOX_WATCHDOG=%s\n' "$(bool_grep "$cron_list" '/jffs/scripts/singbox-watchdog.sh')"
printf 'CRON_UPDATE_BLOCKED=%s\n' "$(bool_grep "$cron_list" '/jffs/addons/x3mRouting/update-blocked-list.sh')"

printf 'BLOCKED_FILE=%s\n' "$blocked_file"
printf 'BLOCKED_FILE_EPOCH=%s\n' "$(file_epoch "$blocked_file")"
printf 'PERSIST_FILE=%s\n' "$persist_file"
printf 'PERSIST_FILE_EPOCH=%s\n' "$(file_epoch "$persist_file")"
printf 'INTERFACE_COUNTERS_FILE=%s\n' "$interface_counters"
printf 'INTERFACE_COUNTERS_EPOCH=%s\n' "$(file_epoch "$interface_counters")"
printf 'LATEST_TAILSCALE_FILE=%s\n' "$latest_tailscale"
printf 'LATEST_TAILSCALE_EPOCH=%s\n' "$(file_epoch "$latest_tailscale")"
printf 'LATEST_WGS1_FILE=%s\n' "$latest_wgs1"
printf 'LATEST_WGS1_EXISTS=%s\n' "$latest_wgs1_exists"
printf 'LATEST_WGS1_HAS_DATA=%s\n' "$latest_wgs1_has_data"
printf 'LATEST_WGS1_EPOCH=%s\n' "$(file_epoch "$latest_wgs1")"
printf 'LATEST_DAILY_FILE=%s\n' "$latest_daily"
printf 'LATEST_DAILY_EPOCH=%s\n' "$(file_epoch "$latest_daily")"
REMOTE
}

router_extract_traffic_summary() {
  local report_file="$1"
  local outfile="$2"

  awk '
    /^Router-wide window:/   { key = "TRAFFIC_ROUTER_WINDOW"; value = substr($0, index($0, ":") + 1) }
    /^Per-device byte window:/ { key = "TRAFFIC_DEVICE_WINDOW"; value = substr($0, index($0, ":") + 1) }
    /^WAN total:/            { key = "TRAFFIC_WAN_TOTAL"; value = substr($0, index($0, ":") + 1) }
    /^VPN total:/            { key = "TRAFFIC_VPN_TOTAL"; value = substr($0, index($0, ":") + 1) }
    /^WG server total:/      { key = "TRAFFIC_WGS1_TOTAL"; value = substr($0, index($0, ":") + 1) }
    /^Tailscale total:/      { key = "TRAFFIC_TS_TOTAL"; value = substr($0, index($0, ":") + 1) }
    /^VPN share\/WAN:/       { key = "TRAFFIC_VPN_SHARE"; value = substr($0, index($0, ":") + 1) }
    /^Device byte total:/    { key = "TRAFFIC_DEVICE_TOTAL"; value = substr($0, index($0, ":") + 1) }
    /^Via VPN:/              { key = "TRAFFIC_DEVICE_VIA_VPN"; value = substr($0, index($0, ":") + 1) }
    /^Direct WAN:/           { key = "TRAFFIC_DEVICE_DIRECT_WAN"; value = substr($0, index($0, ":") + 1) }
    /^Other:/                { key = "TRAFFIC_DEVICE_OTHER"; value = substr($0, index($0, ":") + 1) }
    /^Warning:[[:space:]]+WG server total is non-zero,/ {
      key = "TRAFFIC_WGS1_PEER_BREAKDOWN_WARNING"
      value = substr($0, index($0, ":") + 1)
    }
    /^- WG server total is non-zero,/ {
      key = "TRAFFIC_WGS1_PEER_BREAKDOWN_WARNING"
      value = substr($0, 3)
    }
    key != "" {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      print key "=" value
      key = ""
      value = ""
    }
  ' "$report_file" > "$outfile"
}

router_collect_capacity_history() {
  local journal_file="$1"
  local outfile="$2"
  local current_date="${3:-}"

  ruby -e '
    require "date"

    path = ARGV[0]
    current_date = ARGV[1].to_s.empty? ? Date.today : Date.iso8601(ARGV[1])
    snapshots = []
    current = nil

    if File.exist?(path)
      File.foreach(path) do |line|
        if (match = line.match(/^## (\d{4}-\d{2}-\d{2}) — Catalog capacity snapshot$/))
          snapshots << current if current
          current = { "date" => match[1] }
          next
        end

        next unless current

        if line =~ /^\| (.+?) \| (.+?) \|$/
          key = Regexp.last_match(1).strip
          value = Regexp.last_match(2).strip
          current[key] = value
        elsif line.start_with?("## ")
          snapshots << current
          current = nil
        end
      end
      snapshots << current if current
    end

    latest = snapshots.last
    week_cutoff = current_date - 6
    week = snapshots.reverse.find do |snapshot|
      Date.iso8601(snapshot["date"]) <= week_cutoff
    end

    if latest
      puts "HISTORY_LATEST_DATE=#{latest["date"]}"
      puts "HISTORY_LATEST_VPN_DOMAINS=#{latest["`VPN_DOMAINS` — IP в ipset"] || latest["VPN_DOMAINS — IP в ipset"]}"
      puts "HISTORY_LATEST_VPN_STATIC=#{latest["`VPN_STATIC_NETS`"] || latest["VPN_STATIC_NETS"]}"
      puts "HISTORY_LATEST_MANUAL=#{latest["Ручные доменные правила"]}"
      puts "HISTORY_LATEST_AUTO=#{latest["Auto-discovered доменные правила"]}"
    end

    if week
      puts "HISTORY_WEEK_DATE=#{week["date"]}"
      puts "HISTORY_WEEK_VPN_DOMAINS=#{week["`VPN_DOMAINS` — IP в ipset"] || week["VPN_DOMAINS — IP в ipset"]}"
      puts "HISTORY_WEEK_VPN_STATIC=#{week["`VPN_STATIC_NETS`"] || week["VPN_STATIC_NETS"]}"
      puts "HISTORY_WEEK_MANUAL=#{week["Ручные доменные правила"]}"
      puts "HISTORY_WEEK_AUTO=#{week["Auto-discovered доменные правила"]}"
    end
  ' "$journal_file" "$current_date" > "$outfile"
}

router_render_health_markdown() {
  local state_file="$1"
  local history_file="$2"
  local traffic_file="$3"

  local now_epoch router_product router_build router_extend router_uptime
  local vpn_current vpn_max vpn_mem vpn_static_current manual_count auto_count
  local usage_pct headroom capacity_level
  local blocked_epoch persist_epoch iface_epoch tailscale_epoch wgs1_epoch daily_epoch
  local blocked_age persist_age iface_age tailscale_age wgs1_age daily_age
  local blocked_level persist_level iface_level tailscale_level wgs1_level daily_level
  local ipv6_policy_mode ipv6_policy_level ipv6_policy_note ipv6_runtime_present ipv6_lan_wan_present ipv6_wgc1_path_present
  local wgs1_snapshot_state wgs1_snapshot_note wgs1_window_state wgs1_window_note
  local latest_date latest_vpn latest_static latest_manual latest_auto
  local week_date week_vpn week_static week_manual week_auto
  local latest_vpn_num latest_static_num latest_manual_num latest_auto_num
  local week_vpn_num week_static_num week_manual_num week_auto_num
  local latest_vpn_delta latest_static_delta latest_manual_delta latest_auto_delta
  local week_vpn_delta week_static_delta week_manual_delta week_auto_delta
  local latest_rule_total_delta week_rule_total_delta
  local latest_growth_level week_growth_level latest_auto_note week_auto_note
  local traffic_router_window traffic_device_window traffic_wan traffic_vpn traffic_wgs1 traffic_ts traffic_share traffic_device_total traffic_device_vpn traffic_device_wan traffic_device_other
  local result_level
  local -a drift_lines

  now_epoch="$(router_kv_get "$state_file" NOW_EPOCH)"
  router_product="$(router_kv_get "$state_file" ROUTER_PRODUCT)"
  router_build="$(router_kv_get "$state_file" ROUTER_BUILDNO)"
  router_extend="$(router_kv_get "$state_file" ROUTER_EXTENDNO)"
  router_uptime="$(router_kv_get "$state_file" ROUTER_UPTIME)"

  vpn_current="$(router_kv_get "$state_file" VPN_DOMAINS_CURRENT)"
  vpn_max="$(router_kv_get "$state_file" VPN_DOMAINS_MAX)"
  vpn_mem="$(router_kv_get "$state_file" VPN_DOMAINS_MEM)"
  vpn_static_current="$(router_kv_get "$state_file" VPN_STATIC_NETS_CURRENT)"
  manual_count="$(router_kv_get "$state_file" MANUAL_RULE_COUNT)"
  auto_count="$(router_kv_get "$state_file" AUTO_RULE_COUNT)"

  usage_pct="$(awk -v current="${vpn_current:-0}" -v max="${vpn_max:-0}" 'BEGIN { if (max <= 0) print "n/a"; else printf "%.1f", (current / max) * 100 }')"
  headroom="$(awk -v current="${vpn_current:-0}" -v max="${vpn_max:-0}" 'BEGIN { if (max <= 0) print "n/a"; else print max - current }')"
  capacity_level="$(router_capacity_level "$usage_pct")"

  blocked_epoch="$(router_kv_get "$state_file" BLOCKED_FILE_EPOCH)"
  persist_epoch="$(router_kv_get "$state_file" PERSIST_FILE_EPOCH)"
  iface_epoch="$(router_kv_get "$state_file" INTERFACE_COUNTERS_EPOCH)"
  tailscale_epoch="$(router_kv_get "$state_file" LATEST_TAILSCALE_EPOCH)"
  wgs1_epoch="$(router_kv_get "$state_file" LATEST_WGS1_EPOCH)"
  daily_epoch="$(router_kv_get "$state_file" LATEST_DAILY_EPOCH)"

  blocked_age="$(router_age_seconds "$now_epoch" "$blocked_epoch")"
  persist_age="$(router_age_seconds "$now_epoch" "$persist_epoch")"
  iface_age="$(router_age_seconds "$now_epoch" "$iface_epoch")"
  tailscale_age="$(router_age_seconds "$now_epoch" "$tailscale_epoch")"
  wgs1_age="$(router_age_seconds "$now_epoch" "$wgs1_epoch")"
  daily_age="$(router_age_seconds "$now_epoch" "$daily_epoch")"

  blocked_level="$(router_freshness_level "$blocked_age" 172800 345600)"
  persist_level="$(router_freshness_level "$persist_age" 28800 86400)"
  iface_level="$(router_freshness_level "$iface_age" 28800 86400)"
  tailscale_level="$(router_freshness_level "$tailscale_age" 28800 86400)"
  wgs1_level="$(router_freshness_level "$wgs1_age" 28800 86400)"
  daily_level="$(router_freshness_level "$daily_age" 129600 259200)"
  ipv6_policy_mode="$(router_ipv6_policy_mode "$state_file")"
  ipv6_policy_level="$(router_ipv6_policy_level "$state_file")"
  ipv6_policy_note="$(router_ipv6_policy_note "$state_file")"
  ipv6_runtime_present="$(router_ipv6_runtime_present "$state_file")"
  ipv6_lan_wan_present="$(router_ipv6_lan_wan_present "$state_file")"
  ipv6_wgc1_path_present="$(router_ipv6_wgc1_path_present "$state_file")"
  wgs1_snapshot_state="$(router_wgs1_snapshot_state "$state_file" "$wgs1_level")"
  wgs1_snapshot_note="$(router_wgs1_snapshot_note "$state_file" "$wgs1_level")"

  latest_date="$(router_kv_get "$history_file" HISTORY_LATEST_DATE)"
  latest_vpn="$(router_kv_get "$history_file" HISTORY_LATEST_VPN_DOMAINS)"
  latest_static="$(router_kv_get "$history_file" HISTORY_LATEST_VPN_STATIC)"
  latest_manual="$(router_kv_get "$history_file" HISTORY_LATEST_MANUAL)"
  latest_auto="$(router_kv_get "$history_file" HISTORY_LATEST_AUTO)"
  week_date="$(router_kv_get "$history_file" HISTORY_WEEK_DATE)"
  week_vpn="$(router_kv_get "$history_file" HISTORY_WEEK_VPN_DOMAINS)"
  week_static="$(router_kv_get "$history_file" HISTORY_WEEK_VPN_STATIC)"
  week_manual="$(router_kv_get "$history_file" HISTORY_WEEK_MANUAL)"
  week_auto="$(router_kv_get "$history_file" HISTORY_WEEK_AUTO)"

  latest_vpn_num="$(router_extract_int "$latest_vpn")"
  latest_static_num="$(router_extract_int "$latest_static")"
  latest_manual_num="$(router_extract_int "$latest_manual")"
  latest_auto_num="$(router_extract_int "$latest_auto")"
  week_vpn_num="$(router_extract_int "$week_vpn")"
  week_static_num="$(router_extract_int "$week_static")"
  week_manual_num="$(router_extract_int "$week_manual")"
  week_auto_num="$(router_extract_int "$week_auto")"

  latest_vpn_delta="n/a"
  latest_static_delta="n/a"
  latest_manual_delta="n/a"
  latest_auto_delta="n/a"
  latest_rule_total_delta="n/a"
  week_vpn_delta="n/a"
  week_static_delta="n/a"
  week_manual_delta="n/a"
  week_auto_delta="n/a"
  week_rule_total_delta="n/a"

  if [ -n "$latest_vpn_num" ]; then
    latest_vpn_delta="$(awk -v cur="${vpn_current:-0}" -v prev="${latest_vpn_num:-0}" 'BEGIN { printf "%+d", cur - prev }')"
  fi
  if [ -n "$latest_static_num" ]; then
    latest_static_delta="$(awk -v cur="${vpn_static_current:-0}" -v prev="${latest_static_num:-0}" 'BEGIN { printf "%+d", cur - prev }')"
  fi
  if [ -n "$latest_manual_num" ]; then
    latest_manual_delta="$(awk -v cur="${manual_count:-0}" -v prev="${latest_manual_num:-0}" 'BEGIN { printf "%+d", cur - prev }')"
  fi
  if [ -n "$latest_auto_num" ]; then
    latest_auto_delta="$(awk -v cur="${auto_count:-0}" -v prev="${latest_auto_num:-0}" 'BEGIN { printf "%+d", cur - prev }')"
  fi
  if [ -n "$latest_manual_num" ] && [ -n "$latest_auto_num" ]; then
    latest_rule_total_delta="$(awk -v cur_m="${manual_count:-0}" -v prev_m="${latest_manual_num:-0}" -v cur_a="${auto_count:-0}" -v prev_a="${latest_auto_num:-0}" 'BEGIN { printf "%+d", (cur_m + cur_a) - (prev_m + prev_a) }')"
  fi

  if [ -n "$week_vpn_num" ]; then
    week_vpn_delta="$(awk -v cur="${vpn_current:-0}" -v prev="${week_vpn_num:-0}" 'BEGIN { printf "%+d", cur - prev }')"
  fi
  if [ -n "$week_static_num" ]; then
    week_static_delta="$(awk -v cur="${vpn_static_current:-0}" -v prev="${week_static_num:-0}" 'BEGIN { printf "%+d", cur - prev }')"
  fi
  if [ -n "$week_manual_num" ]; then
    week_manual_delta="$(awk -v cur="${manual_count:-0}" -v prev="${week_manual_num:-0}" 'BEGIN { printf "%+d", cur - prev }')"
  fi
  if [ -n "$week_auto_num" ]; then
    week_auto_delta="$(awk -v cur="${auto_count:-0}" -v prev="${week_auto_num:-0}" 'BEGIN { printf "%+d", cur - prev }')"
  fi
  if [ -n "$week_manual_num" ] && [ -n "$week_auto_num" ]; then
    week_rule_total_delta="$(awk -v cur_m="${manual_count:-0}" -v prev_m="${week_manual_num:-0}" -v cur_a="${auto_count:-0}" -v prev_a="${week_auto_num:-0}" 'BEGIN { printf "%+d", (cur_m + cur_a) - (prev_m + prev_a) }')"
  fi

  latest_growth_level="$(router_growth_level "$(router_extract_int "$latest_vpn_delta")" "$usage_pct" "$vpn_max")"
  week_growth_level="$(router_growth_level "$(router_extract_int "$week_vpn_delta")" "$usage_pct" "$vpn_max")"
  latest_auto_note="$(router_auto_growth_note "$(router_extract_int "$latest_rule_total_delta")" "$(router_extract_int "$latest_auto_delta")")"
  week_auto_note="$(router_auto_growth_note "$(router_extract_int "$week_rule_total_delta")" "$(router_extract_int "$week_auto_delta")")"

  traffic_router_window="$(router_kv_get "$traffic_file" TRAFFIC_ROUTER_WINDOW)"
  traffic_device_window="$(router_kv_get "$traffic_file" TRAFFIC_DEVICE_WINDOW)"
  traffic_wan="$(router_kv_get "$traffic_file" TRAFFIC_WAN_TOTAL)"
  traffic_vpn="$(router_kv_get "$traffic_file" TRAFFIC_VPN_TOTAL)"
  traffic_wgs1="$(router_kv_get "$traffic_file" TRAFFIC_WGS1_TOTAL)"
  traffic_ts="$(router_kv_get "$traffic_file" TRAFFIC_TS_TOTAL)"
  traffic_share="$(router_kv_get "$traffic_file" TRAFFIC_VPN_SHARE)"
  traffic_device_total="$(router_kv_get "$traffic_file" TRAFFIC_DEVICE_TOTAL)"
  traffic_device_vpn="$(router_kv_get "$traffic_file" TRAFFIC_DEVICE_VIA_VPN)"
  traffic_device_wan="$(router_kv_get "$traffic_file" TRAFFIC_DEVICE_DIRECT_WAN)"
  traffic_device_other="$(router_kv_get "$traffic_file" TRAFFIC_DEVICE_OTHER)"
  wgs1_window_state="$(router_wgs1_window_state "$traffic_file")"
  wgs1_window_note="$(router_wgs1_window_note "$traffic_file")"

  drift_lines=()
  [ "$(router_kv_get "$state_file" VPN_DOMAINS_EXISTS)" = "1" ] || drift_lines+=("VPN_DOMAINS ipset missing")
  [ "$(router_kv_get "$state_file" VPN_STATIC_NETS_EXISTS)" = "1" ] || drift_lines+=("VPN_STATIC_NETS ipset missing")
  [ "$(router_kv_get "$state_file" STEALTH_DOMAINS_EXISTS)" = "1" ] || drift_lines+=("STEALTH_DOMAINS ipset missing")
  [ "$(router_kv_get "$state_file" CHAIN_RC_VPN_ROUTE)" = "1" ] || drift_lines+=("mangle chain RC_VPN_ROUTE missing")
  [ "$(router_kv_get "$state_file" RULE_MARK_0X1000)" = "1" ] || drift_lines+=("missing ip rule for fwmark 0x1000 -> wgc1")
  [ "$(router_kv_get "$state_file" CHANNEL_B_REDIRECT_LISTENER)" = "1" ] || drift_lines+=("missing sing-box REDIRECT listener on :<lan-redirect-port>")
  [ "$(router_kv_get "$state_file" CHANNEL_B_DNSCRYPT_SOCKS_LISTENER)" = "1" ] || drift_lines+=("missing sing-box SOCKS listener on 127.0.0.1:1080")
  [ "$(router_kv_get "$state_file" CHANNEL_B_DNSCRYPT_PROXY)" = "1" ] || drift_lines+=("dnscrypt-proxy is not routed through sing-box SOCKS")
  [ "$(router_kv_get "$state_file" CHANNEL_B_SINGBOX_KEEPALIVE)" = "1" ] || drift_lines+=("sing-box keepalive tuning missing")
  [ "$(router_kv_get "$state_file" CHANNEL_B_REDIRECT_STEALTH)" = "1" ] || drift_lines+=("missing LAN TCP REDIRECT for STEALTH_DOMAINS")
  [ "$(router_kv_get "$state_file" CHANNEL_B_REDIRECT_STATIC)" = "1" ] || drift_lines+=("missing LAN TCP REDIRECT for VPN_STATIC_NETS")
  [ "$(router_kv_get "$state_file" CHANNEL_B_DROP_QUIC_STEALTH)" = "1" ] || drift_lines+=("missing UDP/443 DROP for STEALTH_DOMAINS")
  [ "$(router_kv_get "$state_file" CHANNEL_B_DROP_QUIC_STATIC)" = "1" ] || drift_lines+=("missing UDP/443 DROP for VPN_STATIC_NETS")
  [ "$(router_kv_get "$state_file" CHANNEL_B_REJECT_QUIC_STEALTH)" = "0" ] || drift_lines+=("UDP/443 REJECT for STEALTH_DOMAINS should be absent")
  [ "$(router_kv_get "$state_file" CHANNEL_B_REJECT_QUIC_STATIC)" = "0" ] || drift_lines+=("UDP/443 REJECT for VPN_STATIC_NETS should be absent")
  [ "$(router_kv_get "$state_file" RULE_MARK_0X2000)" = "0" ] || drift_lines+=("legacy fwmark 0x2000 -> table 200 rule should be absent")
  [ "$(router_kv_get "$state_file" ROUTE_TABLE_200_SINGBOX)" = "0" ] || drift_lines+=("legacy table 200 -> singbox0 route should be absent")
  [ "$(router_kv_get "$state_file" HOOK_STEALTH_PREROUTING_BR0)" = "0" ] || drift_lines+=("legacy mangle br0 -> STEALTH_DOMAINS hook should be absent")
  [ "$(router_kv_get "$state_file" HOOK_STEALTH_OUTPUT)" = "0" ] || drift_lines+=("legacy mangle OUTPUT -> STEALTH_DOMAINS hook should be absent")
  [ "$(router_kv_get "$state_file" HOOK_PREROUTING_BR0)" = "0" ] || drift_lines+=("legacy br0 -> RC_VPN_ROUTE hook should be disabled")
  [ "$(router_kv_get "$state_file" HOOK_PREROUTING_WGS1)" = "1" ] || drift_lines+=("missing PREROUTING wgs1 -> RC_VPN_ROUTE hook")
  [ "$(router_kv_get "$state_file" HOOK_OUTPUT)" = "0" ] || drift_lines+=("legacy OUTPUT -> RC_VPN_ROUTE hook should be disabled")
  [ "$(router_kv_get "$state_file" HOOK_STEALTH_PREROUTING_WGS1)" = "0" ] || drift_lines+=("wgs1 should not be hooked into STEALTH_DOMAINS")
  [ "$(router_kv_get "$state_file" DNS_REDIRECT_UDP)" = "1" ] || drift_lines+=("missing wgs1 udp/53 -> dnsmasq redirect")
  [ "$(router_kv_get "$state_file" DNS_REDIRECT_TCP)" = "1" ] || drift_lines+=("missing wgs1 tcp/53 -> dnsmasq redirect")
  [ "$(router_kv_get "$state_file" CRON_SINGBOX_WATCHDOG)" = "1" ] || drift_lines+=("missing sing-box watchdog cron")
  if [ "$ipv6_policy_level" = "Critical" ]; then
    drift_lines+=("IPv6 policy drift: ${ipv6_policy_note}")
  elif [ "$ipv6_policy_level" = "Warning" ]; then
    drift_lines+=("IPv6 policy warning: ${ipv6_policy_note}")
  fi

  result_level="OK"
  if [ "${#drift_lines[@]}" -gt 0 ] || [ "$capacity_level" = "Critical" ] || [ "$blocked_level" = "Critical" ] || [ "$persist_level" = "Critical" ] || [ "$iface_level" = "Critical" ] || [ "$tailscale_level" = "Critical" ] || [ "$wgs1_level" = "Critical" ] || [ "$daily_level" = "Critical" ] || [ "$ipv6_policy_level" = "Critical" ]; then
    result_level="Critical"
  elif [ "$capacity_level" = "Warning" ] || [ "$blocked_level" = "Warning" ] || [ "$persist_level" = "Warning" ] || [ "$iface_level" = "Warning" ] || [ "$tailscale_level" = "Warning" ] || [ "$wgs1_level" = "Warning" ] || [ "$daily_level" = "Warning" ] || [ "$blocked_level" = "Missing" ] || [ "$persist_level" = "Missing" ] || [ "$iface_level" = "Missing" ] || [ "$tailscale_level" = "Missing" ] || [ "$wgs1_level" = "Missing" ] || [ "$daily_level" = "Missing" ] || [ "$ipv6_policy_level" = "Warning" ]; then
    result_level="Warning"
  elif [ "$capacity_level" = "Watch" ]; then
    result_level="Watch"
  fi

  cat <<EOF
# Router Health Latest

Sanitised health snapshot for humans and LLMs. Generated locally; no private IPs, MACs, raw endpoints, or unredacted aliases.

## Summary

- Result: **${result_level}**
- Router: **${router_product}** build **${router_build}${router_extend:+_${router_extend}}**
- Uptime: **${router_uptime}**
- Catalog usage: **${vpn_current}/${vpn_max}** (**${usage_pct}%**, level **${capacity_level}**)
- Headroom: **${headroom}**
- Drift items: **${#drift_lines[@]}**

## Router

- Model: **${router_product}**
- Build: **${router_build}**
- Extend: **${router_extend:-n/a}**
- Uptime: **${router_uptime}**

## Routing Health

| Check | Status |
|---|---|
| VPN_DOMAINS ipset | $( [ "$(router_kv_get "$state_file" VPN_DOMAINS_EXISTS)" = "1" ] && printf 'OK' || printf 'Missing' ) |
| VPN_STATIC_NETS ipset | $( [ "$(router_kv_get "$state_file" VPN_STATIC_NETS_EXISTS)" = "1" ] && printf 'OK' || printf 'Missing' ) |
| STEALTH_DOMAINS ipset | $( [ "$(router_kv_get "$state_file" STEALTH_DOMAINS_EXISTS)" = "1" ] && printf 'OK' || printf 'Missing' ) |
| RC_VPN_ROUTE chain | $( [ "$(router_kv_get "$state_file" CHAIN_RC_VPN_ROUTE)" = "1" ] && printf 'OK' || printf 'Missing' ) |
| ip rule fwmark 0x1000 -> wgc1 | $( [ "$(router_kv_get "$state_file" RULE_MARK_0X1000)" = "1" ] && printf 'OK' || printf 'Missing' ) |
| Channel B REDIRECT listener :<lan-redirect-port> | $( [ "$(router_kv_get "$state_file" CHANNEL_B_REDIRECT_LISTENER)" = "1" ] && printf 'OK' || printf 'Missing' ) |
| Channel B dnscrypt SOCKS listener :1080 | $( [ "$(router_kv_get "$state_file" CHANNEL_B_DNSCRYPT_SOCKS_LISTENER)" = "1" ] && printf 'OK' || printf 'Missing' ) |
| dnscrypt-proxy uses sing-box SOCKS | $( [ "$(router_kv_get "$state_file" CHANNEL_B_DNSCRYPT_PROXY)" = "1" ] && printf 'OK' || printf 'Missing' ) |
| sing-box keepalive tuning | $( [ "$(router_kv_get "$state_file" CHANNEL_B_SINGBOX_KEEPALIVE)" = "1" ] && printf 'OK' || printf 'Missing' ) |
| LAN TCP REDIRECT -> STEALTH_DOMAINS | $( [ "$(router_kv_get "$state_file" CHANNEL_B_REDIRECT_STEALTH)" = "1" ] && printf 'OK' || printf 'Missing' ) |
| LAN TCP REDIRECT -> VPN_STATIC_NETS | $( [ "$(router_kv_get "$state_file" CHANNEL_B_REDIRECT_STATIC)" = "1" ] && printf 'OK' || printf 'Missing' ) |
| UDP/443 DROP -> STEALTH_DOMAINS | $( [ "$(router_kv_get "$state_file" CHANNEL_B_DROP_QUIC_STEALTH)" = "1" ] && printf 'OK' || printf 'Missing' ) |
| UDP/443 DROP -> VPN_STATIC_NETS | $( [ "$(router_kv_get "$state_file" CHANNEL_B_DROP_QUIC_STATIC)" = "1" ] && printf 'OK' || printf 'Missing' ) |
| UDP/443 REJECT absent -> STEALTH_DOMAINS | $( [ "$(router_kv_get "$state_file" CHANNEL_B_REJECT_QUIC_STEALTH)" = "0" ] && printf 'OK' || printf 'Still enabled' ) |
| UDP/443 REJECT absent -> VPN_STATIC_NETS | $( [ "$(router_kv_get "$state_file" CHANNEL_B_REJECT_QUIC_STATIC)" = "0" ] && printf 'OK' || printf 'Still enabled' ) |
| legacy ip rule fwmark 0x2000 absent | $( [ "$(router_kv_get "$state_file" RULE_MARK_0X2000)" = "0" ] && printf 'OK' || printf 'Still enabled' ) |
| legacy table 200 -> singbox0 absent | $( [ "$(router_kv_get "$state_file" ROUTE_TABLE_200_SINGBOX)" = "0" ] && printf 'OK' || printf 'Still enabled' ) |
| legacy mangle br0 -> STEALTH_DOMAINS absent | $( [ "$(router_kv_get "$state_file" HOOK_STEALTH_PREROUTING_BR0)" = "0" ] && printf 'OK' || printf 'Still enabled' ) |
| legacy mangle OUTPUT -> STEALTH_DOMAINS absent | $( [ "$(router_kv_get "$state_file" HOOK_STEALTH_OUTPUT)" = "0" ] && printf 'OK' || printf 'Still enabled' ) |
| PREROUTING br0 -> RC_VPN_ROUTE disabled | $( [ "$(router_kv_get "$state_file" HOOK_PREROUTING_BR0)" = "0" ] && printf 'OK' || printf 'Still enabled' ) |
| PREROUTING wgs1 -> RC_VPN_ROUTE | $( [ "$(router_kv_get "$state_file" HOOK_PREROUTING_WGS1)" = "1" ] && printf 'OK' || printf 'Missing' ) |
| OUTPUT -> RC_VPN_ROUTE disabled | $( [ "$(router_kv_get "$state_file" HOOK_OUTPUT)" = "0" ] && printf 'OK' || printf 'Still enabled' ) |
| PREROUTING wgs1 -> STEALTH_DOMAINS disabled | $( [ "$(router_kv_get "$state_file" HOOK_STEALTH_PREROUTING_WGS1)" = "0" ] && printf 'OK' || printf 'Still enabled' ) |
| wgs1 udp/53 -> dnsmasq | $( [ "$(router_kv_get "$state_file" DNS_REDIRECT_UDP)" = "1" ] && printf 'OK' || printf 'Missing' ) |
| wgs1 tcp/53 -> dnsmasq | $( [ "$(router_kv_get "$state_file" DNS_REDIRECT_TCP)" = "1" ] && printf 'OK' || printf 'Missing' ) |
| sing-box watchdog cron | $( [ "$(router_kv_get "$state_file" CRON_SINGBOX_WATCHDOG)" = "1" ] && printf 'OK' || printf 'Missing' ) |

## IPv6 Policy

- Policy mode: **${ipv6_policy_mode}**
- Status: **${ipv6_policy_level}**
- Merlin UI setting: **$(router_kv_get "$state_file" IPV6_SERVICE)**
- Live IPv6 on LAN/WAN: **$( [ "$ipv6_lan_wan_present" = "1" ] && printf 'Detected' || printf 'Not detected' )**
- Live IPv6 path on wgc1: **$( [ "$ipv6_wgc1_path_present" = "1" ] && printf 'Detected' || printf 'Not detected' )**
- Live IPv6 runtime anywhere: **$( [ "$ipv6_runtime_present" = "1" ] && printf 'Detected' || printf 'Not detected' )**
- Recommendation: **Keep Merlin UI at IPv6 -> Отключить until a separate dual-stack project exists.**
- Note: **${ipv6_policy_note}**

## Catalog Capacity

| Metric | Value |
|---|---|
| VPN_DOMAINS current | ${vpn_current} |
| VPN_DOMAINS maxelem | ${vpn_max} |
| Usage | ${usage_pct}% |
| Level | ${capacity_level} |
| Headroom | ${headroom} |
| Memory | ${vpn_mem} B |
| VPN_STATIC_NETS current | ${vpn_static_current} |
| Manual rule count | ${manual_count} |
| Auto-discovered rule count | ${auto_count} |
EOF

  if [ -n "$latest_date" ]; then
    cat <<EOF

### Growth vs latest saved snapshot

- Latest saved snapshot: **${latest_date}**
- VPN_DOMAINS: **${latest_vpn_num:-n/a} -> ${vpn_current}** (${latest_vpn_delta})
- VPN_STATIC_NETS: **${latest_static_num:-n/a} -> ${vpn_static_current}** (${latest_static_delta})
- Manual rules: **${latest_manual_num:-n/a} -> ${manual_count}** (${latest_manual_delta})
- Auto rules: **${latest_auto_num:-n/a} -> ${auto_count}** (${latest_auto_delta})
- Growth level: **${latest_growth_level}**
- Growth note: **${latest_auto_note}**
EOF
  else
    cat <<EOF

### Growth vs latest saved snapshot

- No prior local journal snapshot found.
EOF
  fi

  if [ -n "$week_date" ]; then
    cat <<EOF

### Growth vs week-old snapshot

- Week snapshot: **${week_date}**
- VPN_DOMAINS: **${week_vpn_num:-n/a} -> ${vpn_current}** (${week_vpn_delta})
- VPN_STATIC_NETS: **${week_static_num:-n/a} -> ${vpn_static_current}** (${week_static_delta})
- Manual rules: **${week_manual_num:-n/a} -> ${manual_count}** (${week_manual_delta})
- Auto rules: **${week_auto_num:-n/a} -> ${auto_count}** (${week_auto_delta})
- Growth level: **${week_growth_level}**
- Growth note: **${week_auto_note}**
EOF
  fi

  cat <<EOF

## Freshness

| Artifact | Freshness | Status |
|---|---|---|
| Blocked list | $(router_human_age "$blocked_age") | ${blocked_level} |
| IPSet persistence file | $(router_human_age "$persist_age") | ${persist_level} |
| Interface counters snapshot | $(router_human_age "$iface_age") | ${iface_level} |
| Tailscale snapshot | $(router_human_age "$tailscale_age") | ${tailscale_level} |
| WGS1 snapshot | $(router_human_age "$wgs1_age") | ${wgs1_level} |
| Daily close snapshot | $(router_human_age "$daily_age") | ${daily_level} |

## WGS1 Observability

- Snapshot artifact: **${wgs1_snapshot_state}**
- Collection capability: **$( [ "$(router_wgs1_collection_problem "$state_file")" = "1" ] && printf 'Problem detected' || printf 'OK' )**
- Window peer baseline: **${wgs1_window_state}**
- Snapshot note: **${wgs1_snapshot_note}**
- Window note: **${wgs1_window_note}**

## Traffic Snapshot

- Router-wide window: **${traffic_router_window:-n/a}**
- Per-device byte window: **${traffic_device_window:-n/a}**
- WAN total: **${traffic_wan:-n/a}**
- VPN total: **${traffic_vpn:-n/a}**
- WG server total: **${traffic_wgs1:-n/a}**
- Tailscale total: **${traffic_ts:-n/a}**
- VPN share/WAN: **${traffic_share:-n/a}**
- Device byte total: **${traffic_device_total:-n/a}**
- Via VPN: **${traffic_device_vpn:-n/a}**
- Direct WAN: **${traffic_device_wan:-n/a}**
- Other: **${traffic_device_other:-n/a}**

## Drift
EOF

  if [ "${#drift_lines[@]}" -eq 0 ]; then
    cat <<EOF

- No missing repo-managed invariants detected.
EOF
  else
    local drift_line
    for drift_line in "${drift_lines[@]}"; do
      printf -- '- %s\n' "$drift_line"
    done
  fi

  cat <<EOF

## Notes

- This report is sanitised for repository storage and LLM consumption.
- Security goal here is leak closure, drift detection, and lower attack surface, not traffic disguise.
- VPN_DOMAINS is a live accumulated ipset state, not a day-only metric.
- Growth deltas come from saved journal snapshots when available; otherwise they stay n/a.
EOF
}
