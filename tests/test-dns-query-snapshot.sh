#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cat > "$TMP_DIR/dnsmasq.log" <<'EOF'
May 11 09:00:00 dnsmasq[123]: query[A] example.invalid from 192.168.1.10
May 11 09:00:00 dnsmasq[123]: reply example.invalid is 192.0.2.20
EOF

GHOSTROUTE_TRAFFIC_STATE_DIR="$TMP_DIR" \
GHOSTROUTE_DNSMASQ_LOG="$TMP_DIR/dnsmasq.log" \
  "$PROJECT_ROOT/modules/traffic-observatory/router/dns-query-snapshot"

test -s "$TMP_DIR/dns-query-facts.tsv"
grep -q 'example.invalid' "$TMP_DIR/dns-query-facts.tsv"
grep -q '192.0.2.20' "$TMP_DIR/dns-query-facts.tsv"

echo "dns-query-snapshot tests passed"
