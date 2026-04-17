#!/bin/bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "${PROJECT_ROOT}/scripts/lib/router-health-common.sh"

VERBOSE=0
if [ "${1:-}" = "--verbose" ]; then
  VERBOSE=1
elif [ -n "${1:-}" ]; then
  echo "Usage: ./verify.sh [--verbose]" >&2
  exit 1
fi

router_health_load_env

run_verbose_dump() {
  router_ssh 'sh -s' <<'REMOTE'
set -eu

echo "== Router =="
nvram get productid 2>/dev/null || true
nvram get buildno 2>/dev/null || true
nvram get extendno 2>/dev/null || true

echo
echo "== Capabilities =="
if which opkg >/dev/null 2>&1; then
  opkg --version | head -n 1
else
  echo "Entware: not detected"
fi
which ipset >/dev/null 2>&1 && echo "ipset: ok" || echo "ipset: missing"
which iptables >/dev/null 2>&1 && echo "iptables: ok" || echo "iptables: missing"

echo
echo "== Routing =="
ip rule show | grep -E '0x1000|to 1\.1\.1\.1|to 9\.9\.9\.9' || echo "routing rules not found"
ip route show table wgc1 || true

echo
echo "== IPSet =="
ipset list VPN_DOMAINS 2>/dev/null || echo "VPN_DOMAINS not found"
echo
ipset list VPN_STATIC_NETS 2>/dev/null || echo "VPN_STATIC_NETS not found"

echo
echo "== DNS Fill Test =="
nslookup google.com 127.0.0.1 >/dev/null 2>&1 || true
ipset list VPN_DOMAINS 2>/dev/null | sed -n '1,80p' || true
REMOTE
}

if [ "$VERBOSE" = "1" ]; then
  run_verbose_dump
  exit 0
fi

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

STATE_FILE="$TMPDIR/router-health-state.env"
HISTORY_FILE="$TMPDIR/router-health-history.env"

router_collect_health_state "$STATE_FILE"
router_collect_capacity_history "${PROJECT_ROOT}/docs/vpn-domain-journal.md" "$HISTORY_FILE" "$(date +%F)"

now_epoch="$(router_kv_get "$STATE_FILE" NOW_EPOCH)"
router_product="$(router_kv_get "$STATE_FILE" ROUTER_PRODUCT)"
router_build="$(router_kv_get "$STATE_FILE" ROUTER_BUILDNO)"
router_extend="$(router_kv_get "$STATE_FILE" ROUTER_EXTENDNO)"
router_uptime="$(router_kv_get "$STATE_FILE" ROUTER_UPTIME)"

vpn_current="$(router_kv_get "$STATE_FILE" VPN_DOMAINS_CURRENT)"
vpn_max="$(router_kv_get "$STATE_FILE" VPN_DOMAINS_MAX)"
vpn_static="$(router_kv_get "$STATE_FILE" VPN_STATIC_NETS_CURRENT)"
manual_count="$(router_kv_get "$STATE_FILE" MANUAL_RULE_COUNT)"
auto_count="$(router_kv_get "$STATE_FILE" AUTO_RULE_COUNT)"
vpn_mem="$(router_kv_get "$STATE_FILE" VPN_DOMAINS_MEM)"

usage_pct="$(awk -v current="${vpn_current:-0}" -v max="${vpn_max:-0}" 'BEGIN { if (max <= 0) print "n/a"; else printf "%.1f", (current / max) * 100 }')"
headroom="$(awk -v current="${vpn_current:-0}" -v max="${vpn_max:-0}" 'BEGIN { if (max <= 0) print "n/a"; else print max - current }')"
capacity_level="$(router_capacity_level "$usage_pct")"

blocked_age="$(router_age_seconds "$now_epoch" "$(router_kv_get "$STATE_FILE" BLOCKED_FILE_EPOCH)")"
persist_age="$(router_age_seconds "$now_epoch" "$(router_kv_get "$STATE_FILE" PERSIST_FILE_EPOCH)")"
iface_age="$(router_age_seconds "$now_epoch" "$(router_kv_get "$STATE_FILE" INTERFACE_COUNTERS_EPOCH)")"
tailscale_age="$(router_age_seconds "$now_epoch" "$(router_kv_get "$STATE_FILE" LATEST_TAILSCALE_EPOCH)")"
wgs1_age="$(router_age_seconds "$now_epoch" "$(router_kv_get "$STATE_FILE" LATEST_WGS1_EPOCH)")"
daily_age="$(router_age_seconds "$now_epoch" "$(router_kv_get "$STATE_FILE" LATEST_DAILY_EPOCH)")"

blocked_level="$(router_freshness_level "$blocked_age" 172800 345600)"
persist_level="$(router_freshness_level "$persist_age" 28800 86400)"
iface_level="$(router_freshness_level "$iface_age" 28800 86400)"
tailscale_level="$(router_freshness_level "$tailscale_age" 28800 86400)"
wgs1_level="$(router_freshness_level "$wgs1_age" 28800 86400)"
daily_level="$(router_freshness_level "$daily_age" 129600 259200)"

declare -a critical_items=()
declare -a warning_items=()
declare -a info_items=()
critical_count=0
warning_count=0
info_count=0

add_critical() {
  critical_items+=("$1")
  critical_count=$((critical_count + 1))
}

add_warning() {
  warning_items+=("$1")
  warning_count=$((warning_count + 1))
}

add_info() {
  info_items+=("$1")
  info_count=$((info_count + 1))
}

[ "$(router_kv_get "$STATE_FILE" VPN_DOMAINS_EXISTS)" = "1" ] || add_critical "VPN_DOMAINS ipset missing"
[ "$(router_kv_get "$STATE_FILE" VPN_STATIC_NETS_EXISTS)" = "1" ] || add_critical "VPN_STATIC_NETS ipset missing"
[ "$(router_kv_get "$STATE_FILE" CHAIN_RC_VPN_ROUTE)" = "1" ] || add_critical "mangle chain RC_VPN_ROUTE missing"
[ "$(router_kv_get "$STATE_FILE" RULE_DNS_1111)" = "1" ] || add_critical "missing ip rule for 1.1.1.1 -> wgc1"
[ "$(router_kv_get "$STATE_FILE" RULE_DNS_9999)" = "1" ] || add_critical "missing ip rule for 9.9.9.9 -> wgc1"
[ "$(router_kv_get "$STATE_FILE" RULE_MARK_0X1000)" = "1" ] || add_critical "missing ip rule for fwmark 0x1000 -> wgc1"
[ "$(router_kv_get "$STATE_FILE" HOOK_PREROUTING_BR0)" = "1" ] || add_critical "missing PREROUTING br0 -> RC_VPN_ROUTE hook"
[ "$(router_kv_get "$STATE_FILE" HOOK_PREROUTING_WGS1)" = "1" ] || add_critical "missing PREROUTING wgs1 -> RC_VPN_ROUTE hook"
[ "$(router_kv_get "$STATE_FILE" HOOK_OUTPUT)" = "1" ] || add_critical "missing OUTPUT -> RC_VPN_ROUTE hook"
[ "$(router_kv_get "$STATE_FILE" DNS_REDIRECT_UDP)" = "1" ] || add_critical "missing wgs1 udp/53 -> dnsmasq redirect"
[ "$(router_kv_get "$STATE_FILE" DNS_REDIRECT_TCP)" = "1" ] || add_critical "missing wgs1 tcp/53 -> dnsmasq redirect"

[ "$(router_kv_get "$STATE_FILE" CRON_SAVE_IPSET)" = "1" ] || add_warning "missing SaveIPSet cron job"
[ "$(router_kv_get "$STATE_FILE" CRON_TRAFFIC_SNAPSHOT)" = "1" ] || add_warning "missing TrafficSnapshot cron job"
[ "$(router_kv_get "$STATE_FILE" CRON_TRAFFIC_DAILY_CLOSE)" = "1" ] || add_warning "missing TrafficDailyClose cron job"
[ "$(router_kv_get "$STATE_FILE" CRON_DOMAIN_AUTO_ADD)" = "1" ] || add_warning "missing DomainAutoAdd cron job"
[ "$(router_kv_get "$STATE_FILE" CRON_UPDATE_BLOCKED)" = "1" ] || add_warning "missing UpdateBlockedList cron job"

[ "$blocked_level" = "OK" ] || add_warning "blocked list freshness is ${blocked_level} ($(router_human_age "$blocked_age"))"
[ "$persist_level" = "OK" ] || add_warning "ipset persistence freshness is ${persist_level} ($(router_human_age "$persist_age"))"
[ "$iface_level" = "OK" ] || add_warning "traffic snapshot freshness is ${iface_level} ($(router_human_age "$iface_age"))"
[ "$tailscale_level" = "OK" ] || add_warning "tailscale snapshot freshness is ${tailscale_level} ($(router_human_age "$tailscale_age"))"
[ "$wgs1_level" = "OK" ] || add_warning "wgs1 snapshot freshness is ${wgs1_level} ($(router_human_age "$wgs1_age"))"
[ "$daily_level" = "OK" ] || add_warning "daily close snapshot freshness is ${daily_level} ($(router_human_age "$daily_age"))"

if [ "$capacity_level" = "Warning" ] || [ "$capacity_level" = "Critical" ]; then
  add_warning "catalog usage level is ${capacity_level} at ${usage_pct}%"
elif [ "$capacity_level" = "Watch" ]; then
  add_info "catalog usage reached watch band: ${usage_pct}%"
fi

latest_snapshot_date="$(router_kv_get "$HISTORY_FILE" HISTORY_LATEST_DATE)"
if [ -n "$latest_snapshot_date" ]; then
  latest_vpn="$(router_kv_get "$HISTORY_FILE" HISTORY_LATEST_VPN_DOMAINS)"
  latest_auto="$(router_kv_get "$HISTORY_FILE" HISTORY_LATEST_AUTO)"
  add_info "latest saved catalog snapshot: ${latest_snapshot_date} (VPN_DOMAINS ${latest_vpn}, auto rules ${latest_auto})"
else
  add_info "no prior local journal snapshot found for capacity deltas"
fi

echo "=== Router ==="
echo "Product:                 ${router_product}"
echo "Build:                   ${router_build}${router_extend:+_${router_extend}}"
echo "Uptime:                  ${router_uptime}"
echo
echo "=== Routing Health ==="
printf "%-34s %s\n" "VPN_DOMAINS ipset" "$( [ "$(router_kv_get "$STATE_FILE" VPN_DOMAINS_EXISTS)" = "1" ] && echo OK || echo MISSING )"
printf "%-34s %s\n" "VPN_STATIC_NETS ipset" "$( [ "$(router_kv_get "$STATE_FILE" VPN_STATIC_NETS_EXISTS)" = "1" ] && echo OK || echo MISSING )"
printf "%-34s %s\n" "RC_VPN_ROUTE chain" "$( [ "$(router_kv_get "$STATE_FILE" CHAIN_RC_VPN_ROUTE)" = "1" ] && echo OK || echo MISSING )"
printf "%-34s %s\n" "ip rule 1.1.1.1 -> wgc1" "$( [ "$(router_kv_get "$STATE_FILE" RULE_DNS_1111)" = "1" ] && echo OK || echo MISSING )"
printf "%-34s %s\n" "ip rule 9.9.9.9 -> wgc1" "$( [ "$(router_kv_get "$STATE_FILE" RULE_DNS_9999)" = "1" ] && echo OK || echo MISSING )"
printf "%-34s %s\n" "ip rule fwmark 0x1000" "$( [ "$(router_kv_get "$STATE_FILE" RULE_MARK_0X1000)" = "1" ] && echo OK || echo MISSING )"
printf "%-34s %s\n" "PREROUTING br0 hook" "$( [ "$(router_kv_get "$STATE_FILE" HOOK_PREROUTING_BR0)" = "1" ] && echo OK || echo MISSING )"
printf "%-34s %s\n" "PREROUTING wgs1 hook" "$( [ "$(router_kv_get "$STATE_FILE" HOOK_PREROUTING_WGS1)" = "1" ] && echo OK || echo MISSING )"
printf "%-34s %s\n" "OUTPUT hook" "$( [ "$(router_kv_get "$STATE_FILE" HOOK_OUTPUT)" = "1" ] && echo OK || echo MISSING )"
printf "%-34s %s\n" "wgs1 udp/53 redirect" "$( [ "$(router_kv_get "$STATE_FILE" DNS_REDIRECT_UDP)" = "1" ] && echo OK || echo MISSING )"
printf "%-34s %s\n" "wgs1 tcp/53 redirect" "$( [ "$(router_kv_get "$STATE_FILE" DNS_REDIRECT_TCP)" = "1" ] && echo OK || echo MISSING )"
echo
echo "=== Catalog Capacity ==="
printf "%-34s %s\n" "VPN_DOMAINS current" "${vpn_current}"
printf "%-34s %s\n" "VPN_DOMAINS maxelem" "${vpn_max}"
printf "%-34s %s%%\n" "Usage" "${usage_pct}"
printf "%-34s %s\n" "Usage level" "${capacity_level}"
printf "%-34s %s\n" "Headroom" "${headroom}"
printf "%-34s %s B\n" "Memory" "${vpn_mem}"
printf "%-34s %s\n" "VPN_STATIC_NETS current" "${vpn_static}"
printf "%-34s %s\n" "Manual rules" "${manual_count}"
printf "%-34s %s\n" "Auto rules" "${auto_count}"
echo
echo "=== Freshness ==="
printf "%-34s %s (%s)\n" "Blocked list" "${blocked_level}" "$(router_human_age "$blocked_age")"
printf "%-34s %s (%s)\n" "IPSet persistence file" "${persist_level}" "$(router_human_age "$persist_age")"
printf "%-34s %s (%s)\n" "Interface counters snapshot" "${iface_level}" "$(router_human_age "$iface_age")"
printf "%-34s %s (%s)\n" "Tailscale snapshot" "${tailscale_level}" "$(router_human_age "$tailscale_age")"
printf "%-34s %s (%s)\n" "WGS1 snapshot" "${wgs1_level}" "$(router_human_age "$wgs1_age")"
printf "%-34s %s (%s)\n" "Daily close snapshot" "${daily_level}" "$(router_human_age "$daily_age")"
echo
echo "=== Drift ==="
if [ "$critical_count" -eq 0 ] && [ "$warning_count" -eq 0 ]; then
  echo "No missing repo-managed invariants detected."
else
  for item in "${critical_items[@]-}"; do
    [ -n "$item" ] || continue
    printf 'CRITICAL: %s\n' "$item"
  done
  for item in "${warning_items[@]-}"; do
    [ -n "$item" ] || continue
    printf 'WARNING:  %s\n' "$item"
  done
fi
echo
echo "=== Result ==="
if [ "$critical_count" -gt 0 ]; then
  echo "Critical"
elif [ "$warning_count" -gt 0 ]; then
  echo "Warning"
else
  echo "OK"
fi

if [ "$info_count" -gt 0 ]; then
  echo
  echo "=== Notes ==="
  for item in "${info_items[@]-}"; do
    [ -n "$item" ] || continue
    printf -- '- %s\n' "$item"
  done
fi

if [ "$critical_count" -gt 0 ]; then
  exit 2
fi

if [ "$warning_count" -gt 0 ]; then
  exit 1
fi

exit 0
