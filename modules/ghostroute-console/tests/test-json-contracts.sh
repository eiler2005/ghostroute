#!/bin/bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
TEST_DAY="$(date +%Y-%m-%d)"

assert_json_valid() {
  local file="$1"
  ruby -rjson -e 'JSON.parse(File.read(ARGV[0]))' "$file" >/dev/null
}

assert_json_key() {
  local file="$1"
  local key="$2"
  ruby -rjson -e 'j=JSON.parse(File.read(ARGV[0])); abort("missing #{ARGV[1]}") unless j.key?(ARGV[1])' "$file" "$key"
}

assert_common_contract() {
  local file="$1"
  assert_json_valid "$file"
  assert_json_key "$file" schema_version
  assert_json_key "$file" generated_at
  assert_json_key "$file" source
  assert_json_key "$file" confidence
  ruby -rjson -e '
    j=JSON.parse(File.read(ARGV[0]))
    allowed=%w[exact estimated dns-interest unknown mixed]
    confidence=j["confidence"]
    abort("bad confidence #{confidence}") unless confidence.nil? || allowed.include?(confidence)
  ' "$file"
}

cat > "$TMPDIR/interface.tsv" <<EOF
${TEST_DAY}T00:00:00+0300|wan0|100|200
${TEST_DAY}T01:00:00+0300|wan0|1100|2200
${TEST_DAY}T00:00:00+0300|br0|10|20
${TEST_DAY}T01:00:00+0300|br0|210|420
EOF
cat > "$TMPDIR/lan.tsv" <<EOF
${TEST_DAY}T00:00:00+0300|192.168.50.10|phone|10|20|5|5|0|0
${TEST_DAY}T01:00:00+0300|192.168.50.10|phone|110|220|55|45|5|5
EOF
cat > "$TMPDIR/mobile.tsv" <<EOF
${TEST_DAY}T00:00:00+0300|iphone-1|iPhone|10|20
${TEST_DAY}T01:00:00+0300|iphone-1|iPhone|110|220
EOF

TRAFFIC_OUT="$TMPDIR/traffic.json"
TRAFFIC_REPORT_SKIP_REFRESH=1 \
  TRAFFIC_INTERFACE_COUNTERS_FILE="$TMPDIR/interface.tsv" \
  TRAFFIC_LAN_COUNTERS_FILE="$TMPDIR/lan.tsv" \
  TRAFFIC_MOBILE_COUNTERS_FILE="$TMPDIR/mobile.tsv" \
  "${PROJECT_ROOT}/modules/traffic-observatory/bin/traffic-report" --json today > "$TRAFFIC_OUT"
assert_json_valid "$TRAFFIC_OUT"
assert_common_contract "$TRAFFIC_OUT"
ruby -rjson -e '
  j=JSON.parse(File.read(ARGV[0]))
  coverage=j.fetch("destination_attribution_coverage")
  abort("missing coverage observed") unless coverage["observed_bytes"].to_i > 0
  abort("missing coverage sources") unless coverage.fetch("sources").key?("lan_wifi")
  buckets=j.fetch("destinations").select { |row| row["accounting_bucket"] }
  abort("missing accounting bucket") if buckets.empty?
  lan=buckets.find { |row| row["destination"] == "Unknown/Unattributed LAN-Wi-Fi" }
  abort("missing LAN accounting bucket") unless lan
  abort("bad LAN bucket confidence") unless lan["bytes_confidence"] == "exact-counter"
  abort("bad LAN bucket evidence") unless lan["destination_evidence"] == "none"
' "$TRAFFIC_OUT"

cat > "$TMPDIR/current-interface.tsv" <<'EOF'
wan0|1100|2200
br0|210|420
EOF
cat > "$TMPDIR/current-lan.tsv" <<'EOF'
192.168.50.10|phone|110|220|55|45|5|5
EOF
cat > "$TMPDIR/current-mobile.tsv" <<'EOF'
iphone-1|iPhone|110|220
EOF
TRAFFIC_SUMMARY_OUT="$TMPDIR/traffic-summary.json"
TRAFFIC_SUMMARY_NOW="${TEST_DAY}T01:00:00+0300" \
  TRAFFIC_INTERFACE_COUNTERS_FILE="$TMPDIR/interface.tsv" \
  TRAFFIC_CURRENT_COUNTERS_FILE="$TMPDIR/current-interface.tsv" \
  TRAFFIC_LAN_COUNTERS_FILE="$TMPDIR/lan.tsv" \
  TRAFFIC_LAN_CURRENT_FILE="$TMPDIR/current-lan.tsv" \
  TRAFFIC_MOBILE_COUNTERS_FILE="$TMPDIR/mobile.tsv" \
  TRAFFIC_MOBILE_CURRENT_FILE="$TMPDIR/current-mobile.tsv" \
  "${PROJECT_ROOT}/modules/traffic-observatory/bin/traffic-summary" --json today > "$TRAFFIC_SUMMARY_OUT"
assert_json_valid "$TRAFFIC_SUMMARY_OUT"
assert_common_contract "$TRAFFIC_SUMMARY_OUT"
assert_json_key "$TRAFFIC_SUMMARY_OUT" totals
assert_json_key "$TRAFFIC_SUMMARY_OUT" source_limits
ruby -rjson -e '
  j=JSON.parse(File.read(ARGV[0]))
  abort("bad summary command") unless j.dig("source", "command") == "traffic-summary"
  abort("bad summary period") unless j.dig("source", "period") == "today"
  abort("bad observed bytes") unless j.dig("totals", "client_observed_bytes").to_i > 0
' "$TRAFFIC_SUMMARY_OUT"

cat > "$TMPDIR/history.env" <<'EOF'
HISTORY_LATEST_DATE=2026-04-28
HISTORY_LATEST_STEALTH_DOMAINS=7000
HISTORY_LATEST_VPN_STATIC=67
HISTORY_LATEST_MANUAL=98
HISTORY_LATEST_AUTO=60
EOF
cat > "$TMPDIR/traffic-summary.env" <<'EOF'
TRAFFIC_WAN_TOTAL=12.34 GiB
TRAFFIC_REALITY_TOTAL=5.67 GiB
TRAFFIC_TS_TOTAL=0.00 GiB
TRAFFIC_REALITY_SHARE=45.9%
EOF
HEALTH_OUT="$TMPDIR/health.json"
ROUTER_HEALTH_STATE_FILE="${PROJECT_ROOT}/modules/recovery-verification/fixtures/router-health/state-sample.env" \
  ROUTER_HEALTH_HISTORY_FILE="$TMPDIR/history.env" \
  ROUTER_HEALTH_TRAFFIC_SUMMARY_FILE="$TMPDIR/traffic-summary.env" \
  "${PROJECT_ROOT}/modules/ghostroute-health-monitor/bin/router-health-report" --json > "$HEALTH_OUT"
assert_json_valid "$HEALTH_OUT"
assert_common_contract "$HEALTH_OUT"
assert_json_key "$HEALTH_OUT" checks

cat > "$TMPDIR/leak.jsonl" <<'EOF'
{"ts":"2026-04-28T10:00:00+0300","probe":"channel_a_reality","status":"OK","message":"Reality path is reachable.","evidence":"exit_ip=203.0.113.1"}
{"ts":"2026-04-28T10:00:00+0300","probe":"mobile_routing_leaks","status":"OK","message":"No leak.","evidence":"total=2"}
{"ts":"2026-04-28T10:00:00+0300","probe":"channel_b_routing_leaks","status":"OK","message":"No leak.","evidence":"total=2"}
{"ts":"2026-04-28T10:00:00+0300","probe":"channel_c_routing_leaks","status":"OK","message":"No leak.","evidence":"total=0"}
{"ts":"2026-04-28T10:00:00+0300","probe":"dns_ipv6_leaks","status":"CRIT","message":"Potential DNS leak.","evidence":"plain_dns_packets=2"}
{"ts":"2026-04-28T10:00:00+0300","probe":"rule_set_sync","status":"OK","message":"In sync.","evidence":"domains=42"}
EOF
LEAK_OUT="$TMPDIR/leak.json"
GHOSTROUTE_LEAK_RAW_FILE="$TMPDIR/leak.jsonl" \
  GHOSTROUTE_LEAK_SKIP_REMOTE=1 \
  GHOSTROUTE_LEAK_IPSET_COUNT=42 \
  GHOSTROUTE_LEAK_MIRROR_COUNT=42 \
  "${PROJECT_ROOT}/modules/ghostroute-health-monitor/bin/leak-check" --json > "$LEAK_OUT"
assert_json_valid "$LEAK_OUT"
assert_common_contract "$LEAK_OUT"
assert_json_key "$LEAK_OUT" leaks

cat > "$TMPDIR/auto.conf" <<'EOF'
ipset=/telegram.org/STEALTH_DOMAINS
ipset=/openai.com/STEALTH_DOMAINS
EOF
cat > "$TMPDIR/activity.log" <<'EOF'
│  ? example.org seen
│  ? example.org seen
│  ? candidate.net seen
EOF
cat > "$TMPDIR/blocked.lst" <<'EOF'
telegram.org
openai.com
EOF
DOMAIN_OUT="$TMPDIR/domain.json"
DOMAIN_REPORT_AUTO_FILE="$TMPDIR/auto.conf" \
  DOMAIN_REPORT_ACTIVITY_LOG_FILE="$TMPDIR/activity.log" \
  DOMAIN_REPORT_BLOCKED_LIST_FILE="$TMPDIR/blocked.lst" \
  "${PROJECT_ROOT}/modules/dns-catalog-intelligence/bin/domain-report" --json --all > "$DOMAIN_OUT"
assert_json_valid "$DOMAIN_OUT"
assert_common_contract "$DOMAIN_OUT"
assert_json_key "$DOMAIN_OUT" auto

DNS_OUT="$TMPDIR/dns.json"
DNS_FORENSICS_SOURCE_DIR="${PROJECT_ROOT}/modules/dns-catalog-intelligence/fixtures/dns-forensics" \
  DNS_FORENSICS_DEVICE_METADATA_FILE="${PROJECT_ROOT}/modules/dns-catalog-intelligence/fixtures/dns-forensics/device-metadata-sample.tsv" \
  "${PROJECT_ROOT}/modules/dns-catalog-intelligence/bin/dns-forensics-report" --json 2026-04-21T05 > "$DNS_OUT"
assert_json_valid "$DNS_OUT"
assert_common_contract "$DNS_OUT"
assert_json_key "$DNS_OUT" queries

LIVE_OUT="$TMPDIR/live.json"
GHOSTROUTE_LIVE_SINGBOX_LOG_FILE="${PROJECT_ROOT}/modules/traffic-observatory/fixtures/live-events/sing-box-sample.log" \
  GHOSTROUTE_LIVE_DNSMASQ_LOG_FILE="${PROJECT_ROOT}/modules/traffic-observatory/fixtures/live-events/dnsmasq-sample.log" \
  GHOSTROUTE_LIVE_DOMAIN_ACTIVITY_LOG_FILE="${PROJECT_ROOT}/modules/traffic-observatory/fixtures/live-events/domain-activity-sample.log" \
  "${PROJECT_ROOT}/modules/traffic-observatory/bin/live-events-report" --json --limit 50 > "$LIVE_OUT"
assert_json_valid "$LIVE_OUT"
assert_common_contract "$LIVE_OUT"
assert_json_key "$LIVE_OUT" events
assert_json_key "$LIVE_OUT" route_events
ruby -rjson -e '
  j=JSON.parse(File.read(ARGV[0]))
  abort("not all live events have millisecond timestamps") unless j.fetch("events").all? { |row| row["ts"].to_s.match?(/\.\d{3}/) }
  abort("missing timestamp precision metadata") unless j.fetch("events").all? { |row| row["ts_precision"].to_s != "" }
  dns=j.fetch("events").find { |row| row["event_type"] == "dns.query" && row["destination"] == "telegram.org" }
  abort("missing dns query event") unless dns
  abort("dns event did not receive ordered milliseconds") unless dns["ts"].to_s.match?(/\.\d{3}/)
  abort("bad dns timestamp precision") unless dns["ts_precision"] == "second_ordered"
  catalog=j.fetch("events").find { |row| row["event_type"] == "catalog.candidate" }
  abort("missing catalog candidate event") unless catalog
  abort("bad catalog timestamp precision") unless catalog["ts_precision"] == "collector_time"
  event=j.fetch("route_events").find { |row| row["destination"] == "telegram.org" && row["sing_box_outbound"] == "reality-out" }
  abort("missing exact telegram route event") unless event
  abort("missing client ip") unless event["client_ip"] == "192.168.1.24"
  abort("missing destination port") unless event["destination_port"] == "443"
  abort("missing millisecond timestamp") unless event["ts"].include?(".812")
  abort("bad route timestamp precision") unless event["ts_precision"] == "millisecond"
' "$LIVE_OUT"

echo "ghostroute-console JSON contract tests passed"
