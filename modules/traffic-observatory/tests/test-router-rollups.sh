#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

cat > "$TMPDIR/lan-flow-facts.tsv" <<'EOF'
2026-05-11T12:35:12+0300|192.0.2.10|198.51.100.20|443|tcp|VPS|10|90|100|1|conntrack_snapshot_delta|observed_delta|ip|ok
2026-05-11T12:39:59+0300|192.0.2.10|198.51.100.21|443|tcp|Direct|20|30|50|1|conntrack_snapshot_delta|observed_delta|ip|ok
EOF

GHOSTROUTE_TRAFFIC_STATE_DIR="$TMPDIR" "${PROJECT_ROOT}/modules/traffic-observatory/router/traffic-rollup-snapshot"

for layer in 5min hourly daily weekly monthly; do
  test -s "$TMPDIR/rollups/router_traffic_${layer}.tsv"
  test -s "$TMPDIR/rollups/router_destination_traffic_${layer}.tsv"
done

hourly_start="$(awk -F'|' 'NR == 1 { print $1 }' "$TMPDIR/rollups/router_traffic_hourly.tsv")"
daily_start="$(awk -F'|' 'NR == 1 { print $1 }' "$TMPDIR/rollups/router_traffic_daily.tsv")"
weekly_start="$(awk -F'|' 'NR == 1 { print $1 }' "$TMPDIR/rollups/router_traffic_weekly.tsv")"
monthly_start="$(awk -F'|' 'NR == 1 { print $1 }' "$TMPDIR/rollups/router_traffic_monthly.tsv")"

[[ "$hourly_start" == "2026-05-11T12:00:00+0300" ]]
[[ "$daily_start" == "2026-05-11T00:00:00+0300" ]]
[[ "$weekly_start" == "2026-05-11T00:00:00+0300" ]]
[[ "$monthly_start" == "2026-05-01T00:00:00+0300" ]]

export_json="$(
  GHOSTROUTE_TRAFFIC_STATE_DIR="$TMPDIR" "${PROJECT_ROOT}/modules/traffic-observatory/router/traffic-rollup-export" --json today
)"
node -e 'const j = JSON.parse(process.argv[1]); if (j.schema_version !== 1) process.exit(1); if (j.traffic_totals.length < 5) process.exit(2); if (j.traffic_destinations.length < 5) process.exit(3);' "$export_json"

cat > "$TMPDIR/sing-box.log" <<'EOF'
+0300 2026-05-11 12:39:59 INFO [100 10ms] inbound/vless[reality-in]: [iphone-1] inbound connection to api.example.invalid:443
+0300 2026-05-11 12:40:00 INFO [100 10ms] outbound/vless[reality-out]: outbound connection to api.example.invalid:443
+0300 2026-05-11 12:40:59 INFO [101 10ms] inbound/http[channel-c-shadowrocket-http-in]: [client] inbound connection to local.example.invalid:443
+0300 2026-05-11 12:41:00 INFO [101 10ms] outbound/direct[direct-out]: outbound connection to local.example.invalid:443
EOF

SINGBOX_LOG_PATH="$TMPDIR/sing-box.log" \
GHOSTROUTE_TRAFFIC_STATE_DIR="$TMPDIR" \
  "${PROJECT_ROOT}/modules/traffic-observatory/router/sing-box-route-evidence-snapshot"

test -s "$TMPDIR/sing-box-route-evidence.tsv"
grep -q 'VPS|reality-out|api.example.invalid:443|api.example.invalid|443|sing-box.log|ok|reality-in|iphone-1' "$TMPDIR/sing-box-route-evidence.tsv"
grep -q 'Direct|direct-out|local.example.invalid:443|local.example.invalid|443|sing-box.log|ok|channel-c-shadowrocket-http-in|client' "$TMPDIR/sing-box-route-evidence.tsv"

echo "router rollup fixture test passed"
