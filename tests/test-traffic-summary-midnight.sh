#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

INTERFACE_COUNTERS="$TMP_DIR/interface-counters.tsv"
LAN_COUNTERS="$TMP_DIR/lan-device-counters.tsv"
EMPTY_CURRENT="$TMP_DIR/empty-current.tsv"
METADATA="$TMP_DIR/device-metadata.tsv"

cat > "$INTERFACE_COUNTERS" <<'EOF'
2026-05-17T00:00:00+0300|wan0|1000|2000
2026-05-17T00:30:00+0300|wan0|2000|4000
EOF

cat > "$LAN_COUNTERS" <<'EOF'
2026-05-17T00:00:00+0300|192.168.1.10|test-laptop|0|0|0|0|0|0|aa:bb|test-laptop
2026-05-17T00:30:00+0300|192.168.1.10|test-laptop|100|200|300|400|500|600|aa:bb|test-laptop
EOF

: > "$EMPTY_CURRENT"
: > "$METADATA"

run_summary() {
  local mobile_file="$1"
  local now_value="$2"
  local output_file="$3"
  TRAFFIC_SUMMARY_NOW="$now_value" \
  TRAFFIC_INTERFACE_COUNTERS_FILE="$INTERFACE_COUNTERS" \
  TRAFFIC_LAN_COUNTERS_FILE="$LAN_COUNTERS" \
  TRAFFIC_MOBILE_COUNTERS_FILE="$mobile_file" \
  TRAFFIC_CURRENT_COUNTERS_FILE="$EMPTY_CURRENT" \
  TRAFFIC_LAN_CURRENT_FILE="$EMPTY_CURRENT" \
  TRAFFIC_MOBILE_CURRENT_FILE="$EMPTY_CURRENT" \
  DEVICE_METADATA_FILE="$METADATA" \
  REPORT_REDACT_NAMES=0 \
    "$PROJECT_ROOT/modules/traffic-observatory/bin/traffic-summary" --json today > "$output_file"
}

cat > "$TMP_DIR/mobile-single.tsv" <<'EOF'
2026-05-17T00:12:56+0300|198.51.100.10|iphone-6|48000000000|598536610
EOF
run_summary "$TMP_DIR/mobile-single.tsv" "2026-05-17T00:12:56+0300" "$TMP_DIR/single.json"

ruby -rjson -e '
  payload = JSON.parse(File.read(ARGV[0]))
  totals = payload.fetch("totals")
  abort "single mobile sample leaked into home_reality_ingress_bytes" unless totals["home_reality_ingress_bytes"].to_i == 0
  abort "single mobile sample leaked into client_observed_bytes" unless totals["client_observed_bytes"].to_i == totals["lan_wifi_bytes"].to_i
  warnings = payload.fetch("warnings")
  warning = warnings.find { |row| row["code"] == "home_reality_counter_baseline_missing" }
  abort "expected baseline missing warning" unless warning && warning["skipped_sources"].to_i == 1
' "$TMP_DIR/single.json"

cat > "$TMP_DIR/mobile-delta.tsv" <<'EOF'
2026-05-17T00:12:00+0300|198.51.100.10|iphone-6|1000|2000
2026-05-17T00:30:00+0300|198.51.100.10|iphone-6|6000|9000
EOF
run_summary "$TMP_DIR/mobile-delta.tsv" "2026-05-17T00:30:00+0300" "$TMP_DIR/delta.json"

ruby -rjson -e '
  payload = JSON.parse(File.read(ARGV[0]))
  total = payload.fetch("totals").fetch("home_reality_ingress_bytes").to_i
  abort "expected in-window mobile delta, got #{total}" unless total == 12_000
  warnings = payload.fetch("warnings")
  abort "did not expect baseline warning for two samples" if warnings.any? { |row| row["code"] == "home_reality_counter_baseline_missing" }
' "$TMP_DIR/delta.json"

cat > "$TMP_DIR/mobile-reset.tsv" <<'EOF'
2026-05-17T00:12:00+0300|198.51.100.10|iphone-6|6000|9000
2026-05-17T00:30:00+0300|198.51.100.10|iphone-6|500|700
EOF
run_summary "$TMP_DIR/mobile-reset.tsv" "2026-05-17T00:30:00+0300" "$TMP_DIR/reset.json"

ruby -rjson -e '
  payload = JSON.parse(File.read(ARGV[0]))
  total = payload.fetch("totals").fetch("home_reality_ingress_bytes").to_i
  abort "expected reset current mobile value, got #{total}" unless total == 1_200
' "$TMP_DIR/reset.json"

TRAFFIC_REPORT_SKIP_REFRESH=1 \
TRAFFIC_INTERFACE_COUNTERS_FILE="$INTERFACE_COUNTERS" \
TRAFFIC_LAN_COUNTERS_FILE="$LAN_COUNTERS" \
TRAFFIC_MOBILE_COUNTERS_FILE="$TMP_DIR/mobile-single.tsv" \
DEVICE_METADATA_FILE="$METADATA" \
REPORT_REDACT_NAMES=0 \
  "$PROJECT_ROOT/modules/traffic-observatory/bin/traffic-daily-report" --json 2026-05-17 > "$TMP_DIR/daily-single.json"

ruby -rjson -e '
  payload = JSON.parse(File.read(ARGV[0]))
  total = payload.fetch("totals").fetch("home_reality_ingress_bytes").to_i
  abort "daily report single mobile sample leaked into totals" unless total == 0
' "$TMP_DIR/daily-single.json"

echo "traffic-summary midnight counter tests passed"
