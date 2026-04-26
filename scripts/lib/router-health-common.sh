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
  local wgc1_disable
  local wgs1_disable

  wgc1_disable="$(router_kv_get "$state_file" IPV6_DISABLE_WGC1)"
  wgs1_disable="$(router_kv_get "$state_file" IPV6_DISABLE_WGS1)"

  if [ "$(router_kv_get "$state_file" IPV6_DISABLE_ALL)" = "1" ] &&
    [ "$(router_kv_get "$state_file" IPV6_DISABLE_DEFAULT)" = "1" ] &&
    [ "$(router_kv_get "$state_file" IPV6_DISABLE_BR0)" = "1" ] &&
    [ "$(router_kv_get "$state_file" IPV6_DISABLE_WAN0)" = "1" ] &&
    { [ "$wgc1_disable" = "1" ] || [ "$wgc1_disable" = "missing" ]; } &&
    { [ "$wgs1_disable" = "1" ] || [ "$wgs1_disable" = "missing" ]; }; then
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

legacy_vpn_current=$(ipset list VPN_DOMAINS 2>/dev/null | awk '/^Number of entries:/ {print $4; exit}')
legacy_vpn_exists=0
[ -n "${legacy_vpn_current:-}" ] && legacy_vpn_exists=1

vpn_static_current=$(ipset list VPN_STATIC_NETS 2>/dev/null | awk '/^Number of entries:/ {print $4; exit}')
vpn_static_exists=0
[ -n "${vpn_static_current:-}" ] && vpn_static_exists=1

stealth_current=$(ipset list STEALTH_DOMAINS 2>/dev/null | awk '/^Number of entries:/ {print $4; exit}')
stealth_header=$(ipset list STEALTH_DOMAINS 2>/dev/null | awk -F'Header: ' '/^Header:/ {print $2; exit}')
stealth_max=$(printf '%s\n' "$stealth_header" | awk '{for (i = 1; i <= NF; i++) if ($i == "maxelem") {print $(i+1); exit}}')
stealth_mem=$(ipset list STEALTH_DOMAINS 2>/dev/null | awk '/^Size in memory:/ {print $4; exit}')
stealth_exists=0
[ -n "${stealth_current:-}" ] && stealth_exists=1

manual_count=$(cat /jffs/configs/dnsmasq.conf.add /jffs/configs/dnsmasq-stealth.conf.add 2>/dev/null | grep -c '^ipset=.*/STEALTH_DOMAINS' || printf '0\n')
auto_count=$(grep -c '^ipset=.*/STEALTH_DOMAINS' /jffs/configs/dnsmasq-autodiscovered.conf.add 2>/dev/null || printf '0\n')

cron_list=$(cru l 2>/dev/null || true)
dnscrypt_config=$(cat /opt/etc/dnscrypt-proxy.toml 2>/dev/null || true)
singbox_config=$(cat /opt/etc/sing-box/config.json 2>/dev/null || true)
singbox_config_compact=$(printf '%s\n' "$singbox_config" | awk '{ gsub(/[[:space:]]/, ""); printf "%s", $0 }')
prerouting_mangle=$(iptables -t mangle -S PREROUTING 2>/dev/null || true)
output_mangle=$(iptables -t mangle -S OUTPUT 2>/dev/null || true)
nat_prerouting=$(iptables -t nat -S PREROUTING 2>/dev/null || true)
filter_input=$(iptables -S INPUT 2>/dev/null || true)
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
wgs1_enable=$(nvram get wgs1_enable 2>/dev/null || true)
wgc1_enable=$(nvram get wgc1_enable 2>/dev/null || true)
wgc1_nvram_missing=""
for nvram_field in wgc1_priv wgc1_addr wgc1_aips wgc1_ep_addr wgc1_ep_port wgc1_ppub wgc1_dns wgc1_mtu wgc1_alive; do
  nvram_value=$(nvram get "$nvram_field" 2>/dev/null || true)
  [ -n "$nvram_value" ] || wgc1_nvram_missing="${wgc1_nvram_missing}${nvram_field} "
done
wgc1_nvram_preserved=1
[ -n "$wgc1_nvram_missing" ] && wgc1_nvram_preserved=0
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
if [ -f /opt/tmp/STEALTH_DOMAINS.ipset ]; then
  persist_file="/opt/tmp/STEALTH_DOMAINS.ipset"
elif [ -f /jffs/addons/router_configuration/STEALTH_DOMAINS.ipset ]; then
  persist_file="/jffs/addons/router_configuration/STEALTH_DOMAINS.ipset"
else
  persist_file="/opt/tmp/STEALTH_DOMAINS.ipset"
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

printf 'VPN_DOMAINS_EXISTS=%s\n' "$legacy_vpn_exists"
printf 'VPN_DOMAINS_CURRENT=%s\n' "${legacy_vpn_current:-0}"
printf 'VPN_STATIC_NETS_EXISTS=%s\n' "$vpn_static_exists"
printf 'VPN_STATIC_NETS_CURRENT=%s\n' "${vpn_static_current:-0}"
printf 'STEALTH_DOMAINS_EXISTS=%s\n' "$stealth_exists"
printf 'STEALTH_DOMAINS_CURRENT=%s\n' "${stealth_current:-0}"
printf 'STEALTH_DOMAINS_MAX=%s\n' "${stealth_max:-65536}"
printf 'STEALTH_DOMAINS_MEM=%s\n' "${stealth_mem:-0}"
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
printf 'WGS1_ENABLE=%s\n' "${wgs1_enable:-}"
printf 'WGC1_ENABLE=%s\n' "${wgc1_enable:-}"
printf 'WGC1_NVRAM_PRESERVED=%s\n' "$wgc1_nvram_preserved"
printf 'WGC1_NVRAM_MISSING=%s\n' "$wgc1_nvram_missing"
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
printf 'HOME_REALITY_LISTENER=%s\n' "$(bool_grep "$listen_sockets" '0.0.0.0:<home-reality-port>')"
printf 'HOME_REALITY_IPV4_ONLY=%s\n' "$( { bool_grep "$listen_sockets" '0.0.0.0:<home-reality-port>' | grep -q 1; } && ! printf '%s\n' "$listen_sockets" | grep -Eq ':::<home-reality-port>|\[::\]:<home-reality-port>|\*:<home-reality-port>' && printf '1\n' || printf '0\n' )"
printf 'HOME_REALITY_INPUT_ACCEPT=%s\n' "$(bool_grep "$filter_input" '--dport <home-reality-port> -j ACCEPT')"
printf 'HOME_REALITY_CONNLIMIT_DROP=%s\n' "$(printf '%s\n' "$filter_input" | awk '/--dport <home-reality-port>/ { if ($0 ~ /connlimit/ && $0 ~ /--connlimit-above 300/ && $0 ~ /-j DROP/) drop = NR; if ($0 ~ /-j ACCEPT/ && first_accept == 0) first_accept = NR } END { print (drop > 0 && first_accept > 0 && drop < first_accept) ? 1 : 0 }')"
printf 'HOME_REALITY_MSS_CLAMP=%s\n' "$( { printf '%s\n' "$prerouting_mangle" | awk '/--dport <home-reality-port>/ && /TCPMSS/ && /--set-mss 1360/ { found = 1 } END { exit(found ? 0 : 1) }'; } && { printf '%s\n' "$output_mangle" | awk '/--sport <home-reality-port>/ && /TCPMSS/ && /--set-mss 1360/ { found = 1 } END { exit(found ? 0 : 1) }'; } && printf '1\n' || printf '0\n' )"
printf 'ROUTER_TCP_PERF_TUNING=%s\n' "$( [ "$(cat /proc/sys/net/core/rmem_max 2>/dev/null)" = "16777216" ] && [ "$(cat /proc/sys/net/core/wmem_max 2>/dev/null)" = "16777216" ] && [ "$(awk '{$1=$1; print}' /proc/sys/net/ipv4/tcp_rmem 2>/dev/null)" = "4096 262144 16777216" ] && [ "$(awk '{$1=$1; print}' /proc/sys/net/ipv4/tcp_wmem 2>/dev/null)" = "4096 65536 16777216" ] && [ "$(cat /proc/sys/net/ipv4/tcp_mtu_probing 2>/dev/null)" = "1" ] && [ "$(cat /proc/sys/net/ipv4/tcp_slow_start_after_idle 2>/dev/null)" = "0" ] && [ "$(cat /proc/sys/net/ipv4/tcp_window_scaling 2>/dev/null)" = "1" ] && [ "$(cat /proc/sys/net/ipv4/tcp_sack 2>/dev/null)" = "1" ] && [ "$(cat /proc/sys/net/ipv4/tcp_timestamps 2>/dev/null)" = "1" ] && printf '1\n' || printf '0\n' )"
printf 'HOME_REALITY_DNS_GUARD_RULE=%s\n' "$(bool_grep "$singbox_config_compact" '"inbound":"reality-in","port":[53,853],"outbound":"reality-out"')"
printf 'HOME_REALITY_SPLIT_RULE=%s\n' "$(bool_grep "$singbox_config_compact" '"inbound":"reality-in","rule_set":["stealth-domains","stealth-static"],"outbound":"reality-out"')"
printf 'HOME_REALITY_DIRECT_RULE=%s\n' "$(bool_grep "$singbox_config_compact" '"inbound":"reality-in","outbound":"direct-out"')"
printf 'HOME_REALITY_ALL_RELAY_RULE=%s\n' "$(bool_grep "$singbox_config_compact" '"inbound":"reality-in","outbound":"reality-out"')"
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
printf 'CRON_MOBILE_REALITY_COUNTERS=%s\n' "$(bool_grep "$cron_list" '/jffs/scripts/mobile-reality-accounting-refresh')"
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
    /^Mobile byte window:/   { key = "TRAFFIC_MOBILE_BYTE_WINDOW"; value = substr($0, index($0, ":") + 1) }
    /^Mobile\/QR byte window:/ { key = "TRAFFIC_MOBILE_BYTE_WINDOW"; value = substr($0, index($0, ":") + 1) }
    /^Home Reality byte window:/ { key = "TRAFFIC_MOBILE_BYTE_WINDOW"; value = substr($0, index($0, ":") + 1) }
    /^WAN total:/            { key = "TRAFFIC_WAN_TOTAL"; value = substr($0, index($0, ":") + 1) }
    /^VPN total:/            { key = "TRAFFIC_REALITY_TOTAL"; value = substr($0, index($0, ":") + 1) }
    /^Reality-managed total:/ { key = "TRAFFIC_REALITY_TOTAL"; value = substr($0, index($0, ":") + 1) }
    /^Tailscale total:/      { key = "TRAFFIC_TS_TOTAL"; value = substr($0, index($0, ":") + 1) }
    /^VPN share\/WAN:/       { key = "TRAFFIC_REALITY_SHARE"; value = substr($0, index($0, ":") + 1) }
    /^Reality share\/WAN:/   { key = "TRAFFIC_REALITY_SHARE"; value = substr($0, index($0, ":") + 1) }
    /^Device byte total:/    { key = "TRAFFIC_DEVICE_TOTAL"; value = substr($0, index($0, ":") + 1) }
    /^Via VPN:/              { key = "TRAFFIC_DEVICE_VIA_REALITY"; value = substr($0, index($0, ":") + 1) }
    /^Via Reality:/          { key = "TRAFFIC_DEVICE_VIA_REALITY"; value = substr($0, index($0, ":") + 1) }
    /^Direct WAN:/           { key = "TRAFFIC_DEVICE_DIRECT_WAN"; value = substr($0, index($0, ":") + 1) }
    /^Other:/                { key = "TRAFFIC_DEVICE_OTHER"; value = substr($0, index($0, ":") + 1) }
    /^Client profiles seen:/ { key = "TRAFFIC_MOBILE_CLIENTS"; value = substr($0, index($0, ":") + 1) }
    /^Mobile connections:/   { key = "TRAFFIC_MOBILE_TOTAL"; value = substr($0, index($0, ":") + 1) }
    /^QR connections:/       { key = "TRAFFIC_MOBILE_TOTAL"; value = substr($0, index($0, ":") + 1) }
    /^Ingress connections:/  { key = "TRAFFIC_MOBILE_TOTAL"; value = substr($0, index($0, ":") + 1) }
    /^Mobile byte sources:/  { key = "TRAFFIC_MOBILE_BYTE_SOURCES"; value = substr($0, index($0, ":") + 1) }
    /^QR byte sources:/      { key = "TRAFFIC_MOBILE_BYTE_SOURCES"; value = substr($0, index($0, ":") + 1) }
    /^Ingress byte sources:/ { key = "TRAFFIC_MOBILE_BYTE_SOURCES"; value = substr($0, index($0, ":") + 1) }
    /^Mobile byte total:/    { key = "TRAFFIC_MOBILE_BYTE_TOTAL"; value = substr($0, index($0, ":") + 1) }
    /^QR byte total:/        { key = "TRAFFIC_MOBILE_BYTE_TOTAL"; value = substr($0, index($0, ":") + 1) }
    /^Ingress byte total:/   { key = "TRAFFIC_MOBILE_BYTE_TOTAL"; value = substr($0, index($0, ":") + 1) }
    /^Mobile via Reality:/   { key = "TRAFFIC_MOBILE_REALITY"; value = substr($0, index($0, ":") + 1) }
    /^QR via Reality:/       { key = "TRAFFIC_MOBILE_REALITY"; value = substr($0, index($0, ":") + 1) }
    /^Ingress via Reality:/  { key = "TRAFFIC_MOBILE_REALITY"; value = substr($0, index($0, ":") + 1) }
    /^Mobile direct-out:/    { key = "TRAFFIC_MOBILE_DIRECT"; value = substr($0, index($0, ":") + 1) }
    /^QR direct-out:/        { key = "TRAFFIC_MOBILE_DIRECT"; value = substr($0, index($0, ":") + 1) }
    /^Ingress direct-out:/   { key = "TRAFFIC_MOBILE_DIRECT"; value = substr($0, index($0, ":") + 1) }
    /^Mobile unresolved:/    { key = "TRAFFIC_MOBILE_UNRESOLVED"; value = substr($0, index($0, ":") + 1) }
    /^QR unresolved:/        { key = "TRAFFIC_MOBILE_UNRESOLVED"; value = substr($0, index($0, ":") + 1) }
    /^Ingress unresolved:/   { key = "TRAFFIC_MOBILE_UNRESOLVED"; value = substr($0, index($0, ":") + 1) }
    /^Mobile EOF\/errors:/   { key = "TRAFFIC_MOBILE_ERRORS"; value = substr($0, index($0, ":") + 1) }
    /^QR EOF\/errors:/       { key = "TRAFFIC_MOBILE_ERRORS"; value = substr($0, index($0, ":") + 1) }
    /^Ingress EOF\/errors:/  { key = "TRAFFIC_MOBILE_ERRORS"; value = substr($0, index($0, ":") + 1) }
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
      puts "HISTORY_LATEST_STEALTH_DOMAINS=#{latest["`STEALTH_DOMAINS` — IP в ipset"] || latest["STEALTH_DOMAINS — IP в ipset"] || latest["`VPN_DOMAINS` — IP в ipset"] || latest["VPN_DOMAINS — IP в ipset"]}"
      puts "HISTORY_LATEST_VPN_STATIC=#{latest["`VPN_STATIC_NETS`"] || latest["VPN_STATIC_NETS"]}"
      puts "HISTORY_LATEST_MANUAL=#{latest["Ручные доменные правила"]}"
      puts "HISTORY_LATEST_AUTO=#{latest["Auto-discovered доменные правила"]}"
    end

    if week
      puts "HISTORY_WEEK_DATE=#{week["date"]}"
      puts "HISTORY_WEEK_STEALTH_DOMAINS=#{week["`STEALTH_DOMAINS` — IP в ipset"] || week["STEALTH_DOMAINS — IP в ipset"] || week["`VPN_DOMAINS` — IP в ipset"] || week["VPN_DOMAINS — IP в ipset"]}"
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
  local blocked_epoch persist_epoch iface_epoch tailscale_epoch daily_epoch
  local blocked_age persist_age iface_age tailscale_age daily_age
  local blocked_level persist_level iface_level tailscale_level daily_level
  local ipv6_policy_mode ipv6_policy_level ipv6_policy_note ipv6_runtime_present ipv6_lan_wan_present ipv6_wgc1_path_present
  local latest_date latest_vpn latest_static latest_manual latest_auto
  local week_date week_vpn week_static week_manual week_auto
  local latest_vpn_num latest_static_num latest_manual_num latest_auto_num
  local week_vpn_num week_static_num week_manual_num week_auto_num
  local latest_vpn_delta latest_static_delta latest_manual_delta latest_auto_delta
  local week_vpn_delta week_static_delta week_manual_delta week_auto_delta
  local latest_rule_total_delta week_rule_total_delta
  local latest_growth_level week_growth_level latest_auto_note week_auto_note
  local traffic_router_window traffic_device_window traffic_wan traffic_reality traffic_ts traffic_share traffic_device_total traffic_device_reality traffic_device_wan traffic_device_other
  local result_level
  local -a drift_lines

  now_epoch="$(router_kv_get "$state_file" NOW_EPOCH)"
  router_product="$(router_kv_get "$state_file" ROUTER_PRODUCT)"
  router_build="$(router_kv_get "$state_file" ROUTER_BUILDNO)"
  router_extend="$(router_kv_get "$state_file" ROUTER_EXTENDNO)"
  router_uptime="$(router_kv_get "$state_file" ROUTER_UPTIME)"

  vpn_current="$(router_kv_get "$state_file" STEALTH_DOMAINS_CURRENT)"
  vpn_max="$(router_kv_get "$state_file" STEALTH_DOMAINS_MAX)"
  vpn_mem="$(router_kv_get "$state_file" STEALTH_DOMAINS_MEM)"
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
  daily_epoch="$(router_kv_get "$state_file" LATEST_DAILY_EPOCH)"

  blocked_age="$(router_age_seconds "$now_epoch" "$blocked_epoch")"
  persist_age="$(router_age_seconds "$now_epoch" "$persist_epoch")"
  iface_age="$(router_age_seconds "$now_epoch" "$iface_epoch")"
  tailscale_age="$(router_age_seconds "$now_epoch" "$tailscale_epoch")"
  daily_age="$(router_age_seconds "$now_epoch" "$daily_epoch")"

  blocked_level="$(router_freshness_level "$blocked_age" 172800 345600)"
  persist_level="$(router_freshness_level "$persist_age" 28800 86400)"
  iface_level="$(router_freshness_level "$iface_age" 28800 86400)"
  tailscale_level="$(router_freshness_level "$tailscale_age" 28800 86400)"
  daily_level="$(router_freshness_level "$daily_age" 129600 259200)"
  ipv6_policy_mode="$(router_ipv6_policy_mode "$state_file")"
  ipv6_policy_level="$(router_ipv6_policy_level "$state_file")"
  ipv6_policy_note="$(router_ipv6_policy_note "$state_file")"
  ipv6_runtime_present="$(router_ipv6_runtime_present "$state_file")"
  ipv6_lan_wan_present="$(router_ipv6_lan_wan_present "$state_file")"
  ipv6_wgc1_path_present="$(router_ipv6_wgc1_path_present "$state_file")"
  latest_date="$(router_kv_get "$history_file" HISTORY_LATEST_DATE)"
  latest_vpn="$(router_kv_get "$history_file" HISTORY_LATEST_STEALTH_DOMAINS)"
  latest_static="$(router_kv_get "$history_file" HISTORY_LATEST_VPN_STATIC)"
  latest_manual="$(router_kv_get "$history_file" HISTORY_LATEST_MANUAL)"
  latest_auto="$(router_kv_get "$history_file" HISTORY_LATEST_AUTO)"
  week_date="$(router_kv_get "$history_file" HISTORY_WEEK_DATE)"
  week_vpn="$(router_kv_get "$history_file" HISTORY_WEEK_STEALTH_DOMAINS)"
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
  traffic_mobile_byte_window="$(router_kv_get "$traffic_file" TRAFFIC_MOBILE_BYTE_WINDOW)"
  traffic_wan="$(router_kv_get "$traffic_file" TRAFFIC_WAN_TOTAL)"
  traffic_reality="$(router_kv_get "$traffic_file" TRAFFIC_REALITY_TOTAL)"
  traffic_ts="$(router_kv_get "$traffic_file" TRAFFIC_TS_TOTAL)"
  traffic_share="$(router_kv_get "$traffic_file" TRAFFIC_REALITY_SHARE)"
  traffic_device_total="$(router_kv_get "$traffic_file" TRAFFIC_DEVICE_TOTAL)"
  traffic_device_reality="$(router_kv_get "$traffic_file" TRAFFIC_DEVICE_VIA_REALITY)"
  traffic_device_wan="$(router_kv_get "$traffic_file" TRAFFIC_DEVICE_DIRECT_WAN)"
  traffic_device_other="$(router_kv_get "$traffic_file" TRAFFIC_DEVICE_OTHER)"
  traffic_mobile_clients="$(router_kv_get "$traffic_file" TRAFFIC_MOBILE_CLIENTS)"
  traffic_mobile_total="$(router_kv_get "$traffic_file" TRAFFIC_MOBILE_TOTAL)"
  traffic_mobile_byte_sources="$(router_kv_get "$traffic_file" TRAFFIC_MOBILE_BYTE_SOURCES)"
  traffic_mobile_byte_total="$(router_kv_get "$traffic_file" TRAFFIC_MOBILE_BYTE_TOTAL)"
  traffic_mobile_reality="$(router_kv_get "$traffic_file" TRAFFIC_MOBILE_REALITY)"
  traffic_mobile_direct="$(router_kv_get "$traffic_file" TRAFFIC_MOBILE_DIRECT)"
  traffic_mobile_unresolved="$(router_kv_get "$traffic_file" TRAFFIC_MOBILE_UNRESOLVED)"
  traffic_mobile_errors="$(router_kv_get "$traffic_file" TRAFFIC_MOBILE_ERRORS)"
  drift_lines=()
  [ "$(router_kv_get "$state_file" VPN_DOMAINS_EXISTS)" = "0" ] || drift_lines+=("legacy VPN_DOMAINS ipset should be absent")
  [ "$(router_kv_get "$state_file" VPN_STATIC_NETS_EXISTS)" = "1" ] || drift_lines+=("VPN_STATIC_NETS ipset missing")
  [ "$(router_kv_get "$state_file" STEALTH_DOMAINS_EXISTS)" = "1" ] || drift_lines+=("STEALTH_DOMAINS ipset missing")
  [ "$(router_kv_get "$state_file" WGS1_ENABLE)" = "0" ] || drift_lines+=("wgs1_enable should be 0")
  [ "$(router_kv_get "$state_file" WGC1_ENABLE)" = "0" ] || drift_lines+=("wgc1_enable should be 0")
  [ "$(router_kv_get "$state_file" WGC1_NVRAM_PRESERVED)" = "1" ] || drift_lines+=("wgc1 cold-fallback NVRAM fields are missing")
  [ "$(router_kv_get "$state_file" CHAIN_RC_VPN_ROUTE)" = "0" ] || drift_lines+=("Channel A RC_VPN_ROUTE chain should be absent")
  [ "$(router_kv_get "$state_file" RULE_MARK_0X1000)" = "0" ] || drift_lines+=("Channel A fwmark 0x1000 -> wgc1 rule should be absent")
  [ "$(router_kv_get "$state_file" CHANNEL_B_REDIRECT_LISTENER)" = "1" ] || drift_lines+=("missing sing-box REDIRECT listener on :<lan-redirect-port>")
  [ "$(router_kv_get "$state_file" HOME_REALITY_LISTENER)" = "1" ] || drift_lines+=("missing home Reality listener on :<home-reality-port>")
  [ "$(router_kv_get "$state_file" HOME_REALITY_IPV4_ONLY)" = "1" ] || drift_lines+=("home Reality listener should bind IPv4 0.0.0.0 only, not IPv6 wildcard")
  [ "$(router_kv_get "$state_file" HOME_REALITY_INPUT_ACCEPT)" = "1" ] || drift_lines+=("missing INPUT allow rule for home Reality :<home-reality-port>")
  [ "$(router_kv_get "$state_file" HOME_REALITY_CONNLIMIT_DROP)" = "1" ] || drift_lines+=("missing connlimit DROP >300 before home Reality :<home-reality-port> ACCEPT")
  [ "$(router_kv_get "$state_file" HOME_REALITY_MSS_CLAMP)" = "1" ] || drift_lines+=("missing LTE-safe MSS clamp for home Reality :<home-reality-port>")
  [ "$(router_kv_get "$state_file" ROUTER_TCP_PERF_TUNING)" = "1" ] || drift_lines+=("router TCP high-BDP performance tuning is missing")
  [ "$(router_kv_get "$state_file" HOME_REALITY_DNS_GUARD_RULE)" = "1" ] || drift_lines+=("home Reality ingress missing DNS guard rule for ports 53/853")
  [ "$(router_kv_get "$state_file" HOME_REALITY_SPLIT_RULE)" = "1" ] || drift_lines+=("home Reality ingress does not use STEALTH/VPN_STATIC split rule")
  [ "$(router_kv_get "$state_file" HOME_REALITY_DIRECT_RULE)" = "1" ] || drift_lines+=("home Reality ingress missing direct fallback rule")
  [ "$(router_kv_get "$state_file" HOME_REALITY_ALL_RELAY_RULE)" = "0" ] || drift_lines+=("home Reality ingress still relays all traffic to VPS")
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
  [ "$(router_kv_get "$state_file" HOOK_PREROUTING_WGS1)" = "0" ] || drift_lines+=("Channel A PREROUTING wgs1 -> RC_VPN_ROUTE hook should be absent")
  [ "$(router_kv_get "$state_file" HOOK_OUTPUT)" = "0" ] || drift_lines+=("legacy OUTPUT -> RC_VPN_ROUTE hook should be disabled")
  [ "$(router_kv_get "$state_file" HOOK_STEALTH_PREROUTING_WGS1)" = "0" ] || drift_lines+=("wgs1 should not be hooked into STEALTH_DOMAINS")
  [ "$(router_kv_get "$state_file" DNS_REDIRECT_UDP)" = "0" ] || drift_lines+=("Channel A wgs1 udp/53 redirect should be absent")
  [ "$(router_kv_get "$state_file" DNS_REDIRECT_TCP)" = "0" ] || drift_lines+=("Channel A wgs1 tcp/53 redirect should be absent")
  [ "$(router_kv_get "$state_file" WGS1_IFACE_EXISTS)" = "0" ] || drift_lines+=("Channel A wgs1 interface should be absent")
  [ "$(router_kv_get "$state_file" CRON_SINGBOX_WATCHDOG)" = "1" ] || drift_lines+=("missing sing-box watchdog cron")
  [ "$(router_kv_get "$state_file" CRON_MOBILE_REALITY_COUNTERS)" = "1" ] || drift_lines+=("missing Mobile Home Reality byte-counter refresh cron")
  if [ "$ipv6_policy_level" = "Critical" ]; then
    drift_lines+=("IPv6 policy drift: ${ipv6_policy_note}")
  elif [ "$ipv6_policy_level" = "Warning" ]; then
    drift_lines+=("IPv6 policy warning: ${ipv6_policy_note}")
  fi

  result_level="OK"
  if [ "${#drift_lines[@]}" -gt 0 ] || [ "$capacity_level" = "Critical" ] || [ "$blocked_level" = "Critical" ] || [ "$persist_level" = "Critical" ] || [ "$iface_level" = "Critical" ] || [ "$tailscale_level" = "Critical" ] || [ "$daily_level" = "Critical" ] || [ "$ipv6_policy_level" = "Critical" ]; then
    result_level="Critical"
  elif [ "$capacity_level" = "Warning" ] || [ "$blocked_level" = "Warning" ] || [ "$persist_level" = "Warning" ] || [ "$iface_level" = "Warning" ] || [ "$tailscale_level" = "Warning" ] || [ "$daily_level" = "Warning" ] || [ "$blocked_level" = "Missing" ] || [ "$persist_level" = "Missing" ] || [ "$iface_level" = "Missing" ] || [ "$tailscale_level" = "Missing" ] || [ "$daily_level" = "Missing" ] || [ "$ipv6_policy_level" = "Warning" ]; then
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
- STEALTH catalog usage: **${vpn_current}/${vpn_max}** (**${usage_pct}%**, level **${capacity_level}**)
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
| legacy VPN_DOMAINS ipset absent | $( [ "$(router_kv_get "$state_file" VPN_DOMAINS_EXISTS)" = "0" ] && printf 'OK' || printf 'Present' ) |
| VPN_STATIC_NETS ipset | $( [ "$(router_kv_get "$state_file" VPN_STATIC_NETS_EXISTS)" = "1" ] && printf 'OK' || printf 'Missing' ) |
| STEALTH_DOMAINS ipset | $( [ "$(router_kv_get "$state_file" STEALTH_DOMAINS_EXISTS)" = "1" ] && printf 'OK' || printf 'Missing' ) |
| wgs1_enable disabled | $( [ "$(router_kv_get "$state_file" WGS1_ENABLE)" = "0" ] && printf 'OK' || printf 'Enabled' ) |
| wgc1_enable disabled | $( [ "$(router_kv_get "$state_file" WGC1_ENABLE)" = "0" ] && printf 'OK' || printf 'Enabled' ) |
| wgc1 cold-fallback NVRAM preserved | $( [ "$(router_kv_get "$state_file" WGC1_NVRAM_PRESERVED)" = "1" ] && printf 'OK' || printf 'Missing fields' ) |
| RC_VPN_ROUTE chain absent | $( [ "$(router_kv_get "$state_file" CHAIN_RC_VPN_ROUTE)" = "0" ] && printf 'OK' || printf 'Present' ) |
| ip rule fwmark 0x1000 -> wgc1 absent | $( [ "$(router_kv_get "$state_file" RULE_MARK_0X1000)" = "0" ] && printf 'OK' || printf 'Present' ) |
| Channel B REDIRECT listener :<lan-redirect-port> | $( [ "$(router_kv_get "$state_file" CHANNEL_B_REDIRECT_LISTENER)" = "1" ] && printf 'OK' || printf 'Missing' ) |
| Home Reality listener :<home-reality-port> | $( [ "$(router_kv_get "$state_file" HOME_REALITY_LISTENER)" = "1" ] && printf 'OK' || printf 'Missing' ) |
| Home Reality IPv4-only listener | $( [ "$(router_kv_get "$state_file" HOME_REALITY_IPV4_ONLY)" = "1" ] && printf 'OK' || printf 'IPv6/wildcard drift' ) |
| Home Reality INPUT allow :<home-reality-port> | $( [ "$(router_kv_get "$state_file" HOME_REALITY_INPUT_ACCEPT)" = "1" ] && printf 'OK' || printf 'Missing' ) |
| Home Reality connlimit >300 before ACCEPT | $( [ "$(router_kv_get "$state_file" HOME_REALITY_CONNLIMIT_DROP)" = "1" ] && printf 'OK' || printf 'Missing' ) |
| Home Reality LTE MSS clamp :<home-reality-port> | $( [ "$(router_kv_get "$state_file" HOME_REALITY_MSS_CLAMP)" = "1" ] && printf 'OK' || printf 'Missing' ) |
| Router TCP high-BDP tuning | $( [ "$(router_kv_get "$state_file" ROUTER_TCP_PERF_TUNING)" = "1" ] && printf 'OK' || printf 'Missing' ) |
| Home Reality DNS guard :53/:853 | $( [ "$(router_kv_get "$state_file" HOME_REALITY_DNS_GUARD_RULE)" = "1" ] && printf 'OK' || printf 'Missing' ) |
| Home Reality managed split | $( [ "$(router_kv_get "$state_file" HOME_REALITY_SPLIT_RULE)" = "1" ] && printf 'OK' || printf 'Missing' ) |
| Home Reality direct fallback | $( [ "$(router_kv_get "$state_file" HOME_REALITY_DIRECT_RULE)" = "1" ] && printf 'OK' || printf 'Missing' ) |
| Home Reality all-relay absent | $( [ "$(router_kv_get "$state_file" HOME_REALITY_ALL_RELAY_RULE)" = "0" ] && printf 'OK' || printf 'Still enabled' ) |
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
| PREROUTING wgs1 -> RC_VPN_ROUTE absent | $( [ "$(router_kv_get "$state_file" HOOK_PREROUTING_WGS1)" = "0" ] && printf 'OK' || printf 'Present' ) |
| OUTPUT -> RC_VPN_ROUTE disabled | $( [ "$(router_kv_get "$state_file" HOOK_OUTPUT)" = "0" ] && printf 'OK' || printf 'Still enabled' ) |
| PREROUTING wgs1 -> STEALTH_DOMAINS disabled | $( [ "$(router_kv_get "$state_file" HOOK_STEALTH_PREROUTING_WGS1)" = "0" ] && printf 'OK' || printf 'Still enabled' ) |
| wgs1 interface absent | $( [ "$(router_kv_get "$state_file" WGS1_IFACE_EXISTS)" = "0" ] && printf 'OK' || printf 'Present' ) |
| wgs1 udp/53 redirect absent | $( [ "$(router_kv_get "$state_file" DNS_REDIRECT_UDP)" = "0" ] && printf 'OK' || printf 'Present' ) |
| wgs1 tcp/53 redirect absent | $( [ "$(router_kv_get "$state_file" DNS_REDIRECT_TCP)" = "0" ] && printf 'OK' || printf 'Present' ) |
| sing-box watchdog cron | $( [ "$(router_kv_get "$state_file" CRON_SINGBOX_WATCHDOG)" = "1" ] && printf 'OK' || printf 'Missing' ) |
| Mobile Reality byte-counter cron | $( [ "$(router_kv_get "$state_file" CRON_MOBILE_REALITY_COUNTERS)" = "1" ] && printf 'OK' || printf 'Missing' ) |

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
| STEALTH_DOMAINS current | ${vpn_current} |
| STEALTH_DOMAINS maxelem | ${vpn_max} |
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
- STEALTH_DOMAINS: **${latest_vpn_num:-n/a} -> ${vpn_current}** (${latest_vpn_delta})
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
- STEALTH_DOMAINS: **${week_vpn_num:-n/a} -> ${vpn_current}** (${week_vpn_delta})
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
| Daily close snapshot | $(router_human_age "$daily_age") | ${daily_level} |

## Traffic Snapshot

- Router-wide window: **${traffic_router_window:-n/a}**
- Per-device byte window: **${traffic_device_window:-n/a}**
- Home Reality byte window: **${traffic_mobile_byte_window:-n/a}**
- WAN total: **${traffic_wan:-n/a}**
- Reality-managed total: **${traffic_reality:-n/a}**
- Tailscale total: **${traffic_ts:-n/a}**
- Reality share/WAN: **${traffic_share:-n/a}**
- Device byte total: **${traffic_device_total:-n/a}**
- Via Reality: **${traffic_device_reality:-n/a}**
- Direct WAN: **${traffic_device_wan:-n/a}**
- Other: **${traffic_device_other:-n/a}**
- Home Reality clients seen: **${traffic_mobile_clients:-n/a}**
- Home Reality connections: **${traffic_mobile_total:-n/a}**
- Home Reality byte sources: **${traffic_mobile_byte_sources:-n/a}**
- Home Reality byte total: **${traffic_mobile_byte_total:-n/a}**
- Home Reality via Reality: **${traffic_mobile_reality:-n/a}**
- Home Reality direct-out: **${traffic_mobile_direct:-n/a}**
- Home Reality unresolved: **${traffic_mobile_unresolved:-n/a}**
- Home Reality EOF/errors: **${traffic_mobile_errors:-n/a}**

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
- STEALTH_DOMAINS is a live accumulated ipset state, not a day-only metric.
- Growth deltas come from saved journal snapshots when available; otherwise they stay n/a.
EOF
}
