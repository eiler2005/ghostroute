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

echo
echo "== IPSet =="
ipset list STEALTH_DOMAINS 2>/dev/null || echo "STEALTH_DOMAINS not found"
ipset list VPN_DOMAINS 2>/dev/null || echo "VPN_DOMAINS not found (expected after Channel A cleanup)"
echo
ipset list VPN_STATIC_NETS 2>/dev/null || echo "VPN_STATIC_NETS not found"

echo
echo "== DNS Fill Test =="
nslookup google.com 127.0.0.1 >/dev/null 2>&1 || true
ipset list STEALTH_DOMAINS 2>/dev/null | sed -n '1,80p' || true
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

vpn_current="$(router_kv_get "$STATE_FILE" STEALTH_DOMAINS_CURRENT)"
vpn_max="$(router_kv_get "$STATE_FILE" STEALTH_DOMAINS_MAX)"
vpn_static="$(router_kv_get "$STATE_FILE" VPN_STATIC_NETS_CURRENT)"
manual_count="$(router_kv_get "$STATE_FILE" MANUAL_RULE_COUNT)"
auto_count="$(router_kv_get "$STATE_FILE" AUTO_RULE_COUNT)"
vpn_mem="$(router_kv_get "$STATE_FILE" STEALTH_DOMAINS_MEM)"

usage_pct="$(awk -v current="${vpn_current:-0}" -v max="${vpn_max:-0}" 'BEGIN { if (max <= 0) print "n/a"; else printf "%.1f", (current / max) * 100 }')"
headroom="$(awk -v current="${vpn_current:-0}" -v max="${vpn_max:-0}" 'BEGIN { if (max <= 0) print "n/a"; else print max - current }')"
capacity_level="$(router_capacity_level "$usage_pct")"

blocked_age="$(router_age_seconds "$now_epoch" "$(router_kv_get "$STATE_FILE" BLOCKED_FILE_EPOCH)")"
persist_age="$(router_age_seconds "$now_epoch" "$(router_kv_get "$STATE_FILE" PERSIST_FILE_EPOCH)")"
iface_age="$(router_age_seconds "$now_epoch" "$(router_kv_get "$STATE_FILE" INTERFACE_COUNTERS_EPOCH)")"
tailscale_age="$(router_age_seconds "$now_epoch" "$(router_kv_get "$STATE_FILE" LATEST_TAILSCALE_EPOCH)")"
daily_age="$(router_age_seconds "$now_epoch" "$(router_kv_get "$STATE_FILE" LATEST_DAILY_EPOCH)")"

blocked_level="$(router_freshness_level "$blocked_age" 172800 345600)"
persist_level="$(router_freshness_level "$persist_age" 28800 86400)"
iface_level="$(router_freshness_level "$iface_age" 28800 86400)"
tailscale_level="$(router_freshness_level "$tailscale_age" 28800 86400)"
daily_level="$(router_freshness_level "$daily_age" 129600 259200)"
ipv6_policy_mode="$(router_ipv6_policy_mode "$STATE_FILE")"
ipv6_policy_level="$(router_ipv6_policy_level "$STATE_FILE")"
ipv6_policy_note="$(router_ipv6_policy_note "$STATE_FILE")"
ipv6_runtime_present="$(router_ipv6_runtime_present "$STATE_FILE")"
ipv6_lan_wan_present="$(router_ipv6_lan_wan_present "$STATE_FILE")"
ipv6_wgc1_path_present="$(router_ipv6_wgc1_path_present "$STATE_FILE")"
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

[ "$(router_kv_get "$STATE_FILE" VPN_DOMAINS_EXISTS)" = "0" ] || add_critical "legacy VPN_DOMAINS ipset should be absent"
[ "$(router_kv_get "$STATE_FILE" VPN_STATIC_NETS_EXISTS)" = "1" ] || add_critical "VPN_STATIC_NETS ipset missing"
[ "$(router_kv_get "$STATE_FILE" STEALTH_DOMAINS_EXISTS)" = "1" ] || add_critical "STEALTH_DOMAINS ipset missing"
[ "$(router_kv_get "$STATE_FILE" WGS1_ENABLE)" = "0" ] || add_critical "wgs1_enable should be 0"
[ "$(router_kv_get "$STATE_FILE" WGC1_ENABLE)" = "0" ] || add_critical "wgc1_enable should be 0"
[ "$(router_kv_get "$STATE_FILE" WGC1_NVRAM_PRESERVED)" = "1" ] || add_critical "wgc1 cold-fallback NVRAM fields are missing"
[ "$(router_kv_get "$STATE_FILE" CHAIN_RC_VPN_ROUTE)" = "0" ] || add_critical "Channel A RC_VPN_ROUTE chain should be absent"
[ "$(router_kv_get "$STATE_FILE" RULE_MARK_0X1000)" = "0" ] || add_critical "Channel A fwmark 0x1000 -> wgc1 rule should be absent"
[ "$(router_kv_get "$STATE_FILE" RULE_DNS_1111)" = "0" ] || add_warning "legacy ip rule for 1.1.1.1 -> wgc1 should be absent"
[ "$(router_kv_get "$STATE_FILE" RULE_DNS_9999)" = "0" ] || add_warning "legacy ip rule for 9.9.9.9 -> wgc1 should be absent"
[ "$(router_kv_get "$STATE_FILE" HOOK_PREROUTING_BR0)" = "0" ] || add_critical "legacy PREROUTING br0 -> RC_VPN_ROUTE hook should be absent"
[ "$(router_kv_get "$STATE_FILE" HOOK_PREROUTING_WGS1)" = "0" ] || add_critical "Channel A PREROUTING wgs1 -> RC_VPN_ROUTE hook should be absent"
[ "$(router_kv_get "$STATE_FILE" HOOK_OUTPUT)" = "0" ] || add_critical "legacy OUTPUT -> RC_VPN_ROUTE hook should be absent"
[ "$(router_kv_get "$STATE_FILE" CHANNEL_B_REDIRECT_LISTENER)" = "1" ] || add_critical "missing sing-box REDIRECT listener on :<lan-redirect-port>"
[ "$(router_kv_get "$STATE_FILE" HOME_REALITY_LISTENER)" = "1" ] || add_critical "missing home Reality listener on :<home-reality-port>"
[ "$(router_kv_get "$STATE_FILE" HOME_REALITY_IPV4_ONLY)" = "1" ] || add_critical "home Reality listener should bind IPv4 0.0.0.0 only"
[ "$(router_kv_get "$STATE_FILE" HOME_REALITY_INPUT_ACCEPT)" = "1" ] || add_critical "missing INPUT allow rule for home Reality :<home-reality-port>"
[ "$(router_kv_get "$STATE_FILE" HOME_REALITY_CONNLIMIT_DROP)" = "1" ] || add_critical "missing connlimit DROP before home Reality :<home-reality-port> ACCEPT"
[ "$(router_kv_get "$STATE_FILE" HOME_REALITY_MSS_CLAMP)" = "1" ] || add_critical "missing LTE-safe MSS clamp for home Reality :<home-reality-port>"
[ "$(router_kv_get "$STATE_FILE" ROUTER_TCP_PERF_TUNING)" = "1" ] || add_critical "router TCP high-BDP performance tuning missing"
[ "$(router_kv_get "$STATE_FILE" HOME_REALITY_DNS_GUARD_RULE)" = "1" ] || add_critical "home Reality ingress missing DNS guard for ports 53/853"
[ "$(router_kv_get "$STATE_FILE" HOME_REALITY_SPLIT_RULE)" = "1" ] || add_critical "home Reality ingress does not use STEALTH/VPN_STATIC split rule"
[ "$(router_kv_get "$STATE_FILE" HOME_REALITY_DIRECT_RULE)" = "1" ] || add_critical "home Reality ingress missing direct fallback rule"
[ "$(router_kv_get "$STATE_FILE" HOME_REALITY_ALL_RELAY_RULE)" = "0" ] || add_critical "home Reality ingress still relays all traffic to VPS"
[ "$(router_kv_get "$STATE_FILE" CHANNEL_B_DNSCRYPT_SOCKS_LISTENER)" = "1" ] || add_critical "missing sing-box SOCKS listener on 127.0.0.1:1080"
[ "$(router_kv_get "$STATE_FILE" CHANNEL_B_DNSCRYPT_PROXY)" = "1" ] || add_critical "dnscrypt-proxy is not routed through sing-box SOCKS"
[ "$(router_kv_get "$STATE_FILE" CHANNEL_B_SINGBOX_KEEPALIVE)" = "1" ] || add_critical "sing-box keepalive tuning missing"
[ "$(router_kv_get "$STATE_FILE" CHANNEL_B_REDIRECT_STEALTH)" = "1" ] || add_critical "missing LAN TCP REDIRECT for STEALTH_DOMAINS"
[ "$(router_kv_get "$STATE_FILE" CHANNEL_B_REDIRECT_STATIC)" = "1" ] || add_critical "missing LAN TCP REDIRECT for VPN_STATIC_NETS"
[ "$(router_kv_get "$STATE_FILE" CHANNEL_B_DROP_QUIC_STEALTH)" = "1" ] || add_critical "missing UDP/443 DROP for STEALTH_DOMAINS"
[ "$(router_kv_get "$STATE_FILE" CHANNEL_B_DROP_QUIC_STATIC)" = "1" ] || add_critical "missing UDP/443 DROP for VPN_STATIC_NETS"
[ "$(router_kv_get "$STATE_FILE" CHANNEL_B_REJECT_QUIC_STEALTH)" = "0" ] || add_critical "UDP/443 REJECT for STEALTH_DOMAINS should be absent"
[ "$(router_kv_get "$STATE_FILE" CHANNEL_B_REJECT_QUIC_STATIC)" = "0" ] || add_critical "UDP/443 REJECT for VPN_STATIC_NETS should be absent"
[ "$(router_kv_get "$STATE_FILE" DNS_REDIRECT_UDP)" = "0" ] || add_critical "Channel A wgs1 udp/53 redirect should be absent"
[ "$(router_kv_get "$STATE_FILE" DNS_REDIRECT_TCP)" = "0" ] || add_critical "Channel A wgs1 tcp/53 redirect should be absent"
[ "$(router_kv_get "$STATE_FILE" CRON_SINGBOX_WATCHDOG)" = "1" ] || add_critical "missing sing-box watchdog cron"

if [ "$ipv6_policy_level" = "Critical" ]; then
  add_critical "IPv6 policy drift: ${ipv6_policy_note}"
elif [ "$ipv6_policy_level" = "Warning" ]; then
  add_warning "IPv6 policy warning: ${ipv6_policy_note}"
fi

[ "$(router_kv_get "$STATE_FILE" CRON_SAVE_IPSET)" = "1" ] || add_warning "missing SaveIPSet cron job"
[ "$(router_kv_get "$STATE_FILE" CRON_TRAFFIC_SNAPSHOT)" = "1" ] || add_warning "missing TrafficSnapshot cron job"
[ "$(router_kv_get "$STATE_FILE" CRON_TRAFFIC_DAILY_CLOSE)" = "1" ] || add_warning "missing TrafficDailyClose cron job"
[ "$(router_kv_get "$STATE_FILE" CRON_DOMAIN_AUTO_ADD)" = "1" ] || add_warning "missing DomainAutoAdd cron job"
[ "$(router_kv_get "$STATE_FILE" CRON_UPDATE_BLOCKED)" = "1" ] || add_warning "missing UpdateBlockedList cron job"

[ "$blocked_level" = "OK" ] || add_warning "blocked list freshness is ${blocked_level} ($(router_human_age "$blocked_age"))"
[ "$persist_level" = "OK" ] || add_warning "ipset persistence freshness is ${persist_level} ($(router_human_age "$persist_age"))"
[ "$iface_level" = "OK" ] || add_warning "traffic snapshot freshness is ${iface_level} ($(router_human_age "$iface_age"))"
[ "$tailscale_level" = "OK" ] || add_warning "tailscale snapshot freshness is ${tailscale_level} ($(router_human_age "$tailscale_age"))"
[ "$daily_level" = "OK" ] || add_warning "daily close snapshot freshness is ${daily_level} ($(router_human_age "$daily_age"))"

if [ "$(router_kv_get "$STATE_FILE" WGS1_IFACE_EXISTS)" = "1" ]; then
  add_critical "Channel A wgs1 interface should be absent"
else
  add_info "Channel A wgs1 interface absent"
fi

if [ "$capacity_level" = "Warning" ] || [ "$capacity_level" = "Critical" ]; then
  add_warning "catalog usage level is ${capacity_level} at ${usage_pct}%"
elif [ "$capacity_level" = "Watch" ]; then
  add_info "catalog usage reached watch band: ${usage_pct}%"
fi

latest_snapshot_date="$(router_kv_get "$HISTORY_FILE" HISTORY_LATEST_DATE)"
latest_vpn_raw="$(router_kv_get "$HISTORY_FILE" HISTORY_LATEST_STEALTH_DOMAINS)"
latest_static_raw="$(router_kv_get "$HISTORY_FILE" HISTORY_LATEST_VPN_STATIC)"
latest_manual_raw="$(router_kv_get "$HISTORY_FILE" HISTORY_LATEST_MANUAL)"
latest_auto_raw="$(router_kv_get "$HISTORY_FILE" HISTORY_LATEST_AUTO)"
week_snapshot_date="$(router_kv_get "$HISTORY_FILE" HISTORY_WEEK_DATE)"
week_vpn_raw="$(router_kv_get "$HISTORY_FILE" HISTORY_WEEK_STEALTH_DOMAINS)"
week_static_raw="$(router_kv_get "$HISTORY_FILE" HISTORY_WEEK_VPN_STATIC)"
week_manual_raw="$(router_kv_get "$HISTORY_FILE" HISTORY_WEEK_MANUAL)"
week_auto_raw="$(router_kv_get "$HISTORY_FILE" HISTORY_WEEK_AUTO)"

latest_vpn_prev="$(router_extract_int "$latest_vpn_raw")"
latest_static_prev="$(router_extract_int "$latest_static_raw")"
latest_manual_prev="$(router_extract_int "$latest_manual_raw")"
latest_auto_prev="$(router_extract_int "$latest_auto_raw")"
week_vpn_prev="$(router_extract_int "$week_vpn_raw")"
week_static_prev="$(router_extract_int "$week_static_raw")"
week_manual_prev="$(router_extract_int "$week_manual_raw")"
week_auto_prev="$(router_extract_int "$week_auto_raw")"

latest_vpn_delta="n/a"
latest_static_delta="n/a"
latest_manual_delta="n/a"
latest_auto_delta="n/a"
latest_rule_total_delta="n/a"
latest_growth_level="Unknown"
latest_growth_note="n/a"

week_vpn_delta="n/a"
week_static_delta="n/a"
week_manual_delta="n/a"
week_auto_delta="n/a"
week_rule_total_delta="n/a"
week_growth_level="Unknown"
week_growth_note="n/a"

if [ -n "$latest_vpn_prev" ]; then
  latest_vpn_delta="$(awk -v cur="${vpn_current:-0}" -v prev="${latest_vpn_prev:-0}" 'BEGIN { printf "%+d", cur - prev }')"
  latest_growth_level="$(router_growth_level "$(router_extract_int "$latest_vpn_delta")" "$usage_pct" "$vpn_max")"
fi
if [ -n "$latest_static_prev" ]; then
  latest_static_delta="$(awk -v cur="${vpn_static:-0}" -v prev="${latest_static_prev:-0}" 'BEGIN { printf "%+d", cur - prev }')"
fi
if [ -n "$latest_manual_prev" ]; then
  latest_manual_delta="$(awk -v cur="${manual_count:-0}" -v prev="${latest_manual_prev:-0}" 'BEGIN { printf "%+d", cur - prev }')"
fi
if [ -n "$latest_auto_prev" ]; then
  latest_auto_delta="$(awk -v cur="${auto_count:-0}" -v prev="${latest_auto_prev:-0}" 'BEGIN { printf "%+d", cur - prev }')"
fi
if [ -n "$latest_manual_prev" ] && [ -n "$latest_auto_prev" ]; then
  latest_rule_total_delta="$(awk -v cur_m="${manual_count:-0}" -v prev_m="${latest_manual_prev:-0}" -v cur_a="${auto_count:-0}" -v prev_a="${latest_auto_prev:-0}" 'BEGIN { printf "%+d", (cur_m + cur_a) - (prev_m + prev_a) }')"
  latest_growth_note="$(router_auto_growth_note "$(router_extract_int "$latest_rule_total_delta")" "$(router_extract_int "$latest_auto_delta")")"
fi

if [ -n "$week_vpn_prev" ]; then
  week_vpn_delta="$(awk -v cur="${vpn_current:-0}" -v prev="${week_vpn_prev:-0}" 'BEGIN { printf "%+d", cur - prev }')"
  week_growth_level="$(router_growth_level "$(router_extract_int "$week_vpn_delta")" "$usage_pct" "$vpn_max")"
fi
if [ -n "$week_static_prev" ]; then
  week_static_delta="$(awk -v cur="${vpn_static:-0}" -v prev="${week_static_prev:-0}" 'BEGIN { printf "%+d", cur - prev }')"
fi
if [ -n "$week_manual_prev" ]; then
  week_manual_delta="$(awk -v cur="${manual_count:-0}" -v prev="${week_manual_prev:-0}" 'BEGIN { printf "%+d", cur - prev }')"
fi
if [ -n "$week_auto_prev" ]; then
  week_auto_delta="$(awk -v cur="${auto_count:-0}" -v prev="${week_auto_prev:-0}" 'BEGIN { printf "%+d", cur - prev }')"
fi
if [ -n "$week_manual_prev" ] && [ -n "$week_auto_prev" ]; then
  week_rule_total_delta="$(awk -v cur_m="${manual_count:-0}" -v prev_m="${week_manual_prev:-0}" -v cur_a="${auto_count:-0}" -v prev_a="${week_auto_prev:-0}" 'BEGIN { printf "%+d", (cur_m + cur_a) - (prev_m + prev_a) }')"
  week_growth_note="$(router_auto_growth_note "$(router_extract_int "$week_rule_total_delta")" "$(router_extract_int "$week_auto_delta")")"
fi

if [ -n "$latest_snapshot_date" ]; then
  add_info "latest saved catalog snapshot: ${latest_snapshot_date} (STEALTH_DOMAINS ${latest_vpn_raw}, auto rules ${latest_auto_raw})"
else
  add_info "no prior local journal snapshot found for capacity deltas"
fi

if [ "$latest_growth_level" = "Critical" ] || [ "$week_growth_level" = "Critical" ]; then
  add_warning "catalog growth reached critical band (latest ${latest_growth_level}, week ${week_growth_level})"
elif [ "$latest_growth_level" = "Warning" ] || [ "$week_growth_level" = "Warning" ]; then
  add_warning "catalog growth reached warning band (latest ${latest_growth_level}, week ${week_growth_level})"
elif [ "$latest_growth_level" = "Informational" ] || [ "$week_growth_level" = "Informational" ]; then
  add_info "catalog growth entered informational band (latest ${latest_growth_level}, week ${week_growth_level})"
fi

echo "=== Router ==="
echo "Product:                 ${router_product}"
echo "Build:                   ${router_build}${router_extend:+_${router_extend}}"
echo "Uptime:                  ${router_uptime}"
echo
echo "=== Routing Health ==="
printf "%-34s %s\n" "VPN_DOMAINS absent" "$( [ "$(router_kv_get "$STATE_FILE" VPN_DOMAINS_EXISTS)" = "0" ] && echo OK || echo PRESENT )"
printf "%-34s %s\n" "VPN_STATIC_NETS ipset" "$( [ "$(router_kv_get "$STATE_FILE" VPN_STATIC_NETS_EXISTS)" = "1" ] && echo OK || echo MISSING )"
printf "%-34s %s\n" "STEALTH_DOMAINS ipset" "$( [ "$(router_kv_get "$STATE_FILE" STEALTH_DOMAINS_EXISTS)" = "1" ] && echo OK || echo MISSING )"
printf "%-34s %s\n" "wgs1_enable disabled" "$( [ "$(router_kv_get "$STATE_FILE" WGS1_ENABLE)" = "0" ] && echo OK || echo ENABLED )"
printf "%-34s %s\n" "wgc1_enable disabled" "$( [ "$(router_kv_get "$STATE_FILE" WGC1_ENABLE)" = "0" ] && echo OK || echo ENABLED )"
printf "%-34s %s\n" "wgc1 NVRAM preserved" "$( [ "$(router_kv_get "$STATE_FILE" WGC1_NVRAM_PRESERVED)" = "1" ] && echo OK || echo MISSING )"
printf "%-34s %s\n" "RC_VPN_ROUTE chain absent" "$( [ "$(router_kv_get "$STATE_FILE" CHAIN_RC_VPN_ROUTE)" = "0" ] && echo OK || echo PRESENT )"
printf "%-34s %s\n" "legacy 1.1.1.1 rule absent" "$( [ "$(router_kv_get "$STATE_FILE" RULE_DNS_1111)" = "0" ] && echo OK || echo PRESENT )"
printf "%-34s %s\n" "legacy 9.9.9.9 rule absent" "$( [ "$(router_kv_get "$STATE_FILE" RULE_DNS_9999)" = "0" ] && echo OK || echo PRESENT )"
printf "%-34s %s\n" "ip rule fwmark 0x1000 absent" "$( [ "$(router_kv_get "$STATE_FILE" RULE_MARK_0X1000)" = "0" ] && echo OK || echo PRESENT )"
printf "%-34s %s\n" "legacy PREROUTING br0 absent" "$( [ "$(router_kv_get "$STATE_FILE" HOOK_PREROUTING_BR0)" = "0" ] && echo OK || echo PRESENT )"
printf "%-34s %s\n" "PREROUTING wgs1 hook absent" "$( [ "$(router_kv_get "$STATE_FILE" HOOK_PREROUTING_WGS1)" = "0" ] && echo OK || echo PRESENT )"
printf "%-34s %s\n" "legacy OUTPUT hook absent" "$( [ "$(router_kv_get "$STATE_FILE" HOOK_OUTPUT)" = "0" ] && echo OK || echo PRESENT )"
printf "%-34s %s\n" "Channel B listener :<lan-redirect-port>" "$( [ "$(router_kv_get "$STATE_FILE" CHANNEL_B_REDIRECT_LISTENER)" = "1" ] && echo OK || echo MISSING )"
printf "%-34s %s\n" "Home Reality listener :<home-reality-port>" "$( [ "$(router_kv_get "$STATE_FILE" HOME_REALITY_LISTENER)" = "1" ] && echo OK || echo MISSING )"
printf "%-34s %s\n" "Home Reality INPUT :<home-reality-port>" "$( [ "$(router_kv_get "$STATE_FILE" HOME_REALITY_INPUT_ACCEPT)" = "1" ] && echo OK || echo MISSING )"
printf "%-34s %s\n" "Home Reality managed split" "$( [ "$(router_kv_get "$STATE_FILE" HOME_REALITY_SPLIT_RULE)" = "1" ] && echo OK || echo MISSING )"
printf "%-34s %s\n" "Home Reality direct fallback" "$( [ "$(router_kv_get "$STATE_FILE" HOME_REALITY_DIRECT_RULE)" = "1" ] && echo OK || echo MISSING )"
printf "%-34s %s\n" "Home Reality all-relay absent" "$( [ "$(router_kv_get "$STATE_FILE" HOME_REALITY_ALL_RELAY_RULE)" = "0" ] && echo OK || echo PRESENT )"
printf "%-34s %s\n" "dnscrypt SOCKS listener :1080" "$( [ "$(router_kv_get "$STATE_FILE" CHANNEL_B_DNSCRYPT_SOCKS_LISTENER)" = "1" ] && echo OK || echo MISSING )"
printf "%-34s %s\n" "dnscrypt uses sing-box SOCKS" "$( [ "$(router_kv_get "$STATE_FILE" CHANNEL_B_DNSCRYPT_PROXY)" = "1" ] && echo OK || echo MISSING )"
printf "%-34s %s\n" "sing-box keepalive tuning" "$( [ "$(router_kv_get "$STATE_FILE" CHANNEL_B_SINGBOX_KEEPALIVE)" = "1" ] && echo OK || echo MISSING )"
printf "%-34s %s\n" "LAN TCP REDIRECT stealth" "$( [ "$(router_kv_get "$STATE_FILE" CHANNEL_B_REDIRECT_STEALTH)" = "1" ] && echo OK || echo MISSING )"
printf "%-34s %s\n" "LAN TCP REDIRECT static" "$( [ "$(router_kv_get "$STATE_FILE" CHANNEL_B_REDIRECT_STATIC)" = "1" ] && echo OK || echo MISSING )"
printf "%-34s %s\n" "UDP/443 DROP stealth" "$( [ "$(router_kv_get "$STATE_FILE" CHANNEL_B_DROP_QUIC_STEALTH)" = "1" ] && echo OK || echo MISSING )"
printf "%-34s %s\n" "UDP/443 DROP static" "$( [ "$(router_kv_get "$STATE_FILE" CHANNEL_B_DROP_QUIC_STATIC)" = "1" ] && echo OK || echo MISSING )"
printf "%-34s %s\n" "UDP/443 REJECT stealth absent" "$( [ "$(router_kv_get "$STATE_FILE" CHANNEL_B_REJECT_QUIC_STEALTH)" = "0" ] && echo OK || echo PRESENT )"
printf "%-34s %s\n" "UDP/443 REJECT static absent" "$( [ "$(router_kv_get "$STATE_FILE" CHANNEL_B_REJECT_QUIC_STATIC)" = "0" ] && echo OK || echo PRESENT )"
printf "%-34s %s\n" "wgs1 udp/53 redirect absent" "$( [ "$(router_kv_get "$STATE_FILE" DNS_REDIRECT_UDP)" = "0" ] && echo OK || echo PRESENT )"
printf "%-34s %s\n" "wgs1 tcp/53 redirect absent" "$( [ "$(router_kv_get "$STATE_FILE" DNS_REDIRECT_TCP)" = "0" ] && echo OK || echo PRESENT )"
printf "%-34s %s\n" "sing-box watchdog cron" "$( [ "$(router_kv_get "$STATE_FILE" CRON_SINGBOX_WATCHDOG)" = "1" ] && echo OK || echo MISSING )"
echo
echo "=== IPv6 Policy ==="
printf "%-34s %s\n" "Policy mode" "${ipv6_policy_mode}"
printf "%-34s %s\n" "Status" "${ipv6_policy_level}"
printf "%-34s %s\n" "Merlin UI setting" "$(router_kv_get "$STATE_FILE" IPV6_SERVICE)"
printf "%-34s %s\n" "Live IPv6 on LAN/WAN" "$( [ "$ipv6_lan_wan_present" = "1" ] && echo DETECTED || echo NONE )"
printf "%-34s %s\n" "Live IPv6 path on wgc1" "$( [ "$ipv6_wgc1_path_present" = "1" ] && echo DETECTED || echo NONE )"
printf "%-34s %s\n" "Live IPv6 runtime anywhere" "$( [ "$ipv6_runtime_present" = "1" ] && echo DETECTED || echo NONE )"
printf "%-34s %s\n" "Recommendation" "Keep IPv6 -> Отключить"
echo "Note:                    ${ipv6_policy_note}"
echo
echo "=== Catalog Capacity ==="
printf "%-34s %s\n" "STEALTH_DOMAINS current" "${vpn_current}"
printf "%-34s %s\n" "STEALTH_DOMAINS maxelem" "${vpn_max}"
printf "%-34s %s%%\n" "Usage" "${usage_pct}"
printf "%-34s %s\n" "Usage level" "${capacity_level}"
printf "%-34s %s\n" "Headroom" "${headroom}"
printf "%-34s %s B\n" "Memory" "${vpn_mem}"
printf "%-34s %s\n" "VPN_STATIC_NETS current" "${vpn_static}"
printf "%-34s %s\n" "Manual rules" "${manual_count}"
printf "%-34s %s\n" "Auto rules" "${auto_count}"
echo
echo "=== Growth Trends ==="
if [ -n "$latest_snapshot_date" ]; then
  printf "%-34s %s\n" "Latest snapshot" "${latest_snapshot_date}"
  printf "%-34s %s (%s)\n" "STEALTH_DOMAINS delta" "${latest_vpn_delta}" "${latest_growth_level}"
  printf "%-34s %s\n" "VPN_STATIC_NETS delta" "${latest_static_delta}"
  printf "%-34s %s\n" "Manual rules delta" "${latest_manual_delta}"
  printf "%-34s %s\n" "Auto rules delta" "${latest_auto_delta}"
  printf "%-34s %s\n" "Growth note" "${latest_growth_note}"
else
  echo "Latest snapshot:          n/a"
fi
if [ -n "$week_snapshot_date" ]; then
  printf "%-34s %s\n" "Week snapshot" "${week_snapshot_date}"
  printf "%-34s %s (%s)\n" "STEALTH_DOMAINS week delta" "${week_vpn_delta}" "${week_growth_level}"
  printf "%-34s %s\n" "VPN_STATIC_NETS week delta" "${week_static_delta}"
  printf "%-34s %s\n" "Manual rules week delta" "${week_manual_delta}"
  printf "%-34s %s\n" "Auto rules week delta" "${week_auto_delta}"
  printf "%-34s %s\n" "Week growth note" "${week_growth_note}"
else
  echo "Week snapshot:            n/a"
fi
echo
echo "=== Freshness ==="
printf "%-34s %s (%s)\n" "Blocked list" "${blocked_level}" "$(router_human_age "$blocked_age")"
printf "%-34s %s (%s)\n" "IPSet persistence file" "${persist_level}" "$(router_human_age "$persist_age")"
printf "%-34s %s (%s)\n" "Interface counters snapshot" "${iface_level}" "$(router_human_age "$iface_age")"
printf "%-34s %s (%s)\n" "Tailscale snapshot" "${tailscale_level}" "$(router_human_age "$tailscale_age")"
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
