#!/bin/bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

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

cat > "$TMPDIR/interface.tsv" <<'EOF'
2026-04-29T00:00:00+0300|wan0|100|200
2026-04-29T01:00:00+0300|wan0|1100|2200
2026-04-29T00:00:00+0300|br0|10|20
2026-04-29T01:00:00+0300|br0|210|420
EOF
cat > "$TMPDIR/lan.tsv" <<'EOF'
2026-04-29T00:00:00+0300|192.168.50.10|phone|10|20|5|5|0|0
2026-04-29T01:00:00+0300|192.168.50.10|phone|110|220|55|45|5|5
EOF
cat > "$TMPDIR/mobile.tsv" <<'EOF'
2026-04-29T00:00:00+0300|iphone-1|iPhone|10|20
2026-04-29T01:00:00+0300|iphone-1|iPhone|110|220
EOF

TRAFFIC_OUT="$TMPDIR/traffic.json"
TRAFFIC_REPORT_SKIP_REFRESH=1 \
  TRAFFIC_INTERFACE_COUNTERS_FILE="$TMPDIR/interface.tsv" \
  TRAFFIC_LAN_COUNTERS_FILE="$TMPDIR/lan.tsv" \
  TRAFFIC_MOBILE_COUNTERS_FILE="$TMPDIR/mobile.tsv" \
  "${PROJECT_ROOT}/modules/traffic-observatory/bin/traffic-report" --json 2026-04-29 > "$TRAFFIC_OUT"
assert_json_valid "$TRAFFIC_OUT"
assert_common_contract "$TRAFFIC_OUT"

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

echo "ghostroute-console JSON contract tests passed"
