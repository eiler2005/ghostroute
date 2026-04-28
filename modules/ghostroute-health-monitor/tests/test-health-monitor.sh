#!/bin/bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MONITOR_DIR="${PROJECT_ROOT}/modules/ghostroute-health-monitor/router"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

export HEALTH_MONITOR_LOG_DIR="$TMPDIR/health-monitor"
export HEALTH_MONITOR_ALERT_COOLDOWN_SECONDS=3600
export HEALTH_MONITOR_REDIRECT_PORT=61001
export HEALTH_MONITOR_HOME_REALITY_PORT=61002
export HEALTH_MONITOR_SOCKS_PORT=61003

TODAY="$(date +%F)"
RAW_DIR="$HEALTH_MONITOR_LOG_DIR/raw"
RAW_FILE="$RAW_DIR/${TODAY}.jsonl"
mkdir -p "$RAW_DIR"

assert_contains() {
  local file="$1"
  local pattern="$2"
  if ! grep -F -- "$pattern" "$file" >/dev/null 2>&1; then
    echo "Expected pattern not found: $pattern" >&2
    echo "--- file: $file ---" >&2
    cat "$file" >&2
    exit 1
  fi
}

assert_json_valid() {
  local file="$1"
  ruby -rjson -e 'JSON.parse(File.read(ARGV[0]))' "$file"
}

assert_jsonl_valid() {
  local file="$1"
  ruby -rjson -e 'File.foreach(ARGV[0]) { |line| JSON.parse(line) unless line.strip.empty? }' "$file"
}

cat > "$RAW_FILE" <<EOF
{"ts":"2026-04-26T09:59:00+0300","probe":"channel_b_reality","status":"OK","risk":"Channel B / Reality path down","message":"legacy ok","evidence":"exit_ip=198.51.100.10","action":"No action.","version":1}
{"ts":"2026-04-26T10:00:00+0300","probe":"channel_a_reality","status":"OK","risk":"Channel A / Reality path down","message":"ok","evidence":"exit_ip=198.51.100.10","action":"No action.","version":1}
{"ts":"2026-04-26T10:00:00+0300","probe":"rule_set_sync","status":"CRIT","risk":"rule-set drift","message":"drift","evidence":"only_dns=1","action":"Regenerate rule-sets after approval.","version":1}
EOF

"$MONITOR_DIR/aggregate"

assert_json_valid "$HEALTH_MONITOR_LOG_DIR/status.json"
assert_contains "$HEALTH_MONITOR_LOG_DIR/status.json" '"overall":"CRIT"'
assert_contains "$HEALTH_MONITOR_LOG_DIR/status.json" '"channel_a_reality"'
if grep -F -- 'channel_b_reality' "$HEALTH_MONITOR_LOG_DIR/status.json" >/dev/null 2>&1; then
  echo "Expected legacy channel_b_reality to be canonicalized" >&2
  exit 1
fi
assert_contains "$HEALTH_MONITOR_LOG_DIR/summary-latest.md" '# Модуль мониторинга работоспособности GhostRoute'
assert_contains "$HEALTH_MONITOR_LOG_DIR/summary-latest.md" '| `rule_set_sync` | `CRIT` |'
assert_contains "$HEALTH_MONITOR_LOG_DIR/alerts/${TODAY}.md" '| `rule_set_sync` | `CRIT` | `UNKNOWN` |'
assert_jsonl_valid "$HEALTH_MONITOR_LOG_DIR/alerts/${TODAY}.jsonl"

initial_alerts="$(wc -l < "$HEALTH_MONITOR_LOG_DIR/alerts/${TODAY}.jsonl" | tr -d ' ')"
"$MONITOR_DIR/aggregate"
second_alerts="$(wc -l < "$HEALTH_MONITOR_LOG_DIR/alerts/${TODAY}.jsonl" | tr -d ' ')"
if [ "$initial_alerts" != "$second_alerts" ]; then
  echo "Expected no duplicate alert inside cooldown window" >&2
  exit 1
fi

cat >> "$RAW_FILE" <<EOF
{"ts":"2026-04-26T10:05:00+0300","probe":"rule_set_sync","status":"OK","risk":"rule-set drift","message":"ok","evidence":"domains=2","action":"No action.","version":1}
EOF
"$MONITOR_DIR/aggregate"
assert_contains "$HEALTH_MONITOR_LOG_DIR/status.json" '"overall":"OK"'
assert_contains "$HEALTH_MONITOR_LOG_DIR/alerts/${TODAY}.md" '| `rule_set_sync` | `OK` | `CRIT` |'

FIXTURE="$TMPDIR/rules"
mkdir -p "$FIXTURE"
cat > "$FIXTURE/dnsmasq.conf" <<'EOF'
ipset=/youtube.com/STEALTH_DOMAINS
ipset=/github.com/STEALTH_DOMAINS
EOF
cat > "$FIXTURE/rules.json" <<'EOF'
{
  "version": 3,
  "rules": [
    { "domain_suffix": [
      "github.com",
      "youtube.com"
    ] }
  ]
}
EOF

export HEALTH_MONITOR_DNSMASQ_FILE="$FIXTURE/dnsmasq.conf"
export HEALTH_MONITOR_DNSMASQ_AUTO_FILE="$FIXTURE/missing-auto.conf"
export HEALTH_MONITOR_RULESET_FILE="$FIXTURE/rules.json"
export HEALTH_MONITOR_PROBE_FILTER=rule_set_sync
"$MONITOR_DIR/run-probes"
assert_jsonl_valid "$RAW_FILE"
tail -1 "$RAW_FILE" | grep -F '"probe":"rule_set_sync"' | grep -F '"status":"OK"' >/dev/null

cat > "$FIXTURE/rules.json" <<'EOF'
{
  "version": 3,
  "rules": [
    { "domain_suffix": [
      "github.com"
    ] }
  ]
}
EOF
"$MONITOR_DIR/run-probes"
tail -1 "$RAW_FILE" | grep -F '"probe":"rule_set_sync"' | grep -F '"status":"CRIT"' >/dev/null

old_raw="$RAW_DIR/2000-01-01.jsonl"
old_alert="$HEALTH_MONITOR_LOG_DIR/alerts/2000-01-01.md"
mkdir -p "$HEALTH_MONITOR_LOG_DIR/alerts"
: > "$old_raw"
: > "$old_alert"
touch -t 200001010000 "$old_raw" "$old_alert"
"$MONITOR_DIR/aggregate"
[ ! -e "$old_raw" ] || { echo "Old raw file was not removed by retention" >&2; exit 1; }
[ ! -e "$old_alert" ] || { echo "Old alert md file was not removed by retention" >&2; exit 1; }

unset HEALTH_MONITOR_DNSMASQ_FILE HEALTH_MONITOR_DNSMASQ_AUTO_FILE HEALTH_MONITOR_RULESET_FILE
export HEALTH_MONITOR_PROBE_FILTER=performance_rtt
export SINGBOX_LOG_PATH="$TMPDIR/sing-box.log"
rm -rf "$HEALTH_MONITOR_LOG_DIR/state/baselines"
cat > "$SINGBOX_LOG_PATH" <<'EOF'
INFO [abc 100ms] outbound/vless[reality-out]: test
EOF
"$MONITOR_DIR/run-probes"
tail -1 "$RAW_FILE" | grep -F '"probe":"performance_rtt"' | grep -F '"status":"OK"' | grep -F 'baseline=learning' >/dev/null

rm -rf "$HEALTH_MONITOR_LOG_DIR/state/baselines"
(
  . "$MONITOR_DIR/lib.sh"
  now="$(date +%s)"
  i=0
  while [ "$i" -lt 24 ]; do
    hm_baseline_observe performance_rtt 100 $((now - 1000 + i))
    i=$((i + 1))
  done
)
cat > "$SINGBOX_LOG_PATH" <<'EOF'
INFO [abc 500ms] outbound/vless[reality-out]: test
EOF
"$MONITOR_DIR/run-probes"
tail -1 "$RAW_FILE" | grep -F '"probe":"performance_rtt"' | grep -F '"status":"WARN"' | grep -F 'baseline_p95_ms=100' >/dev/null

rm -rf "$HEALTH_MONITOR_LOG_DIR/state/baselines"
cat > "$SINGBOX_LOG_PATH" <<'EOF'
INFO [abc 3101ms] outbound/vless[reality-out]: test
EOF
"$MONITOR_DIR/run-probes"
tail -1 "$RAW_FILE" | grep -F '"probe":"performance_rtt"' | grep -F '"status":"CRIT"' | grep -F 'hard_crit_ms=3000' >/dev/null

STATUS_STATE="$TMPDIR/status-state.env"
STATUS_TRAFFIC="$TMPDIR/status-traffic.txt"
STATUS_HEALTH="$TMPDIR/status.json"
cat > "$STATUS_STATE" <<'EOF'
VPN_DOMAINS_EXISTS=0
VPN_STATIC_NETS_EXISTS=1
STEALTH_DOMAINS_EXISTS=1
STEALTH_DOMAINS_CURRENT=42
STEALTH_DOMAINS_MAX=65536
WGS1_ENABLE=0
WGC1_ENABLE=0
WGC1_NVRAM_PRESERVED=1
CHAIN_RC_VPN_ROUTE=0
RULE_MARK_0X1000=0
CHANNEL_B_REDIRECT_LISTENER=1
HOME_REALITY_LISTENER=1
HOME_REALITY_IPV4_ONLY=1
HOME_REALITY_INPUT_ACCEPT=1
HOME_REALITY_CONNLIMIT_DROP=1
HOME_REALITY_MSS_CLAMP=1
ROUTER_TCP_PERF_TUNING=1
HOME_REALITY_DNS_GUARD_RULE=1
HOME_REALITY_SPLIT_RULE=1
HOME_REALITY_DIRECT_RULE=1
HOME_REALITY_ALL_RELAY_RULE=0
CHANNEL_B_DNSCRYPT_SOCKS_LISTENER=1
CHANNEL_B_DNSCRYPT_PROXY=1
CHANNEL_B_SINGBOX_KEEPALIVE=1
CHANNEL_B_REDIRECT_STEALTH=1
CHANNEL_B_REDIRECT_STATIC=1
CHANNEL_B_DROP_QUIC_STEALTH=1
CHANNEL_B_DROP_QUIC_STATIC=1
CHANNEL_B_REJECT_QUIC_STEALTH=0
CHANNEL_B_REJECT_QUIC_STATIC=0
RULE_MARK_0X2000=0
ROUTE_TABLE_200_SINGBOX=0
HOOK_STEALTH_PREROUTING_BR0=0
HOOK_STEALTH_OUTPUT=0
HOOK_PREROUTING_BR0=0
HOOK_PREROUTING_WGS1=0
HOOK_OUTPUT=0
HOOK_STEALTH_PREROUTING_WGS1=0
DNS_REDIRECT_UDP=0
DNS_REDIRECT_TCP=0
WGS1_IFACE_EXISTS=0
CRON_SINGBOX_WATCHDOG=1
CRON_MOBILE_REALITY_COUNTERS=1
IPV6_SERVICE=disabled
IPV6_DISABLE_ALL=1
IPV6_DISABLE_DEFAULT=1
IPV6_DISABLE_BR0=1
IPV6_DISABLE_WAN0=1
IPV6_DISABLE_WGC1=missing
IPV6_DISABLE_WGS1=missing
IPV6_ADDR_BR0=0
IPV6_ADDR_WAN0=0
IPV6_ADDR_WGC1=0
IPV6_ADDR_WGS1=0
IPV6_ROUTE_MAIN=0
IPV6_ROUTE_WGC1=0
EOF
cat > "$STATUS_TRAFFIC" <<'EOF'
Channel B ingress:       12.3 MiB observed on Channel B ingress enabled on home:45678 (99 accepted packets; router INPUT counter)
Channel B relay split:   VPS 7/10 conn + direct 3/10 + unresolved 0/10  (sing-box channel-b-relay-socks log)
Home Reality profile split: A 1.0 MiB + B 12.3 MiB + C1 0 B  (estimated, Home Reality profile-derived)
EOF
cat > "$STATUS_HEALTH" <<'EOF'
{"overall":"OK","checks":{"channel_a_reality":{"status":"OK","message":"ok"}}}
EOF
STATUS_OUT="$TMPDIR/status.out"
GHOSTROUTE_STATUS_STATE_FILE="$STATUS_STATE" \
  GHOSTROUTE_STATUS_TRAFFIC_FILE="$STATUS_TRAFFIC" \
  GHOSTROUTE_STATUS_HEALTH_STATUS_FILE="$STATUS_HEALTH" \
  GHOSTROUTE_STATUS_MIRROR_COUNT=42 \
  "${PROJECT_ROOT}/modules/ghostroute-health-monitor/bin/status" > "$STATUS_OUT"
assert_contains "$STATUS_OUT" "Overall: OK (drift=0)"
assert_contains "$STATUS_OUT" "Rule-set mirror: 42 /32"
assert_contains "$STATUS_OUT" "home:<channel-b-port>"

LEAK_RAW="$TMPDIR/leak-ok-skip.jsonl"
cat > "$LEAK_RAW" <<'EOF'
{"ts":"2026-04-28T10:00:00+0300","probe":"channel_a_reality","status":"OK","message":"Active SOCKS exit-IP probe is unavailable, but recent reality-out traffic is visible.","evidence":"active_check=unavailable curl_rc=127 recent_reality_out=4 expected=203.0.113.1"}
{"ts":"2026-04-28T10:00:00+0300","probe":"dns_ipv6_leaks","status":"OK","message":"IPv6 policy and DNS leak sample are clean.","evidence":"plain_dns_sample=skip"}
{"ts":"2026-04-28T10:00:00+0300","probe":"rule_set_sync","status":"OK","message":"dnsmasq STEALTH catalog and sing-box domain_suffix rule-set are in sync.","evidence":"domains=42"}
EOF
LEAK_OUT="$TMPDIR/leak-ok-skip.out"
GHOSTROUTE_LEAK_RAW_FILE="$LEAK_RAW" \
  GHOSTROUTE_LEAK_SKIP_REMOTE=1 \
  GHOSTROUTE_LEAK_IPSET_COUNT=42 \
  GHOSTROUTE_LEAK_MIRROR_COUNT=42 \
  "${PROJECT_ROOT}/modules/ghostroute-health-monitor/bin/leak-check" > "$LEAK_OUT"
assert_contains "$LEAK_OUT" "Overall: SKIP"
assert_contains "$LEAK_OUT" "Reality exit: SKIP"
assert_contains "$LEAK_OUT" "Static IP mirror: OK"

LEAK_CRIT_RAW="$TMPDIR/leak-crit.jsonl"
cat > "$LEAK_CRIT_RAW" <<'EOF'
{"ts":"2026-04-28T10:00:00+0300","probe":"channel_a_reality","status":"OK","message":"Reality SOCKS path is reachable.","evidence":"exit_ip=203.0.113.1 expected=203.0.113.1"}
{"ts":"2026-04-28T10:00:00+0300","probe":"dns_ipv6_leaks","status":"CRIT","message":"Potential DNS or IPv6 leak signal was detected.","evidence":"plain_dns_packets=2"}
{"ts":"2026-04-28T10:00:00+0300","probe":"rule_set_sync","status":"OK","message":"dnsmasq STEALTH catalog and sing-box domain_suffix rule-set are in sync.","evidence":"domains=42"}
EOF
LEAK_CRIT_OUT="$TMPDIR/leak-crit.out"
GHOSTROUTE_LEAK_RAW_FILE="$LEAK_CRIT_RAW" \
  GHOSTROUTE_LEAK_SKIP_REMOTE=1 \
  GHOSTROUTE_LEAK_IPSET_COUNT=42 \
  GHOSTROUTE_LEAK_MIRROR_COUNT=42 \
  "${PROJECT_ROOT}/modules/ghostroute-health-monitor/bin/leak-check" > "$LEAK_CRIT_OUT"
assert_contains "$LEAK_CRIT_OUT" "Overall: CRIT"
assert_contains "$LEAK_CRIT_OUT" "DNS/IPv6 policy: CRIT"

echo "health-monitor fixture tests passed"
