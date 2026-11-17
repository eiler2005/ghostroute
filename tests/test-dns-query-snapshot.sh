#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cat > "$TMP_DIR/dnsmasq.log" <<'EOF'
May 11 09:00:00 dnsmasq[123]: query[A] example.invalid from 192.168.1.10
May 11 09:00:00 dnsmasq[123]: reply example.invalid is 192.0.2.20
May 11 09:01:00 dnsmasq[123]: query[AAAA] ipv6.example.invalid from 192.168.1.10
May 11 09:01:00 dnsmasq[123]: reply ipv6.example.invalid is 2001:db8::20
EOF

GHOSTROUTE_TRAFFIC_STATE_DIR="$TMP_DIR" \
GHOSTROUTE_DNSMASQ_LOG="$TMP_DIR/dnsmasq.log" \
  "$PROJECT_ROOT/modules/traffic-observatory/router/dns-query-snapshot"

test -s "$TMP_DIR/dns-query-facts.tsv"
grep -q 'example.invalid' "$TMP_DIR/dns-query-facts.tsv"
grep -q '192.0.2.20' "$TMP_DIR/dns-query-facts.tsv"
grep -q 'ipv6.example.invalid' "$TMP_DIR/dns-query-facts.tsv"
grep -q '2001:db8::20' "$TMP_DIR/dns-query-facts.tsv"
grep -q -- '-05-11T09:00:00.*example.invalid.*source_seconds' "$TMP_DIR/dns-query-facts.tsv"

initial_rows=$(wc -l < "$TMP_DIR/dns-query-facts.tsv")
run_sampler() {
  GHOSTROUTE_TRAFFIC_STATE_DIR="$TMP_DIR" GHOSTROUTE_DNSMASQ_LOG="$TMP_DIR/dnsmasq.log" \
    "$PROJECT_ROOT/modules/traffic-observatory/router/dns-query-snapshot"
}
run_sampler
test "$(wc -l < "$TMP_DIR/dns-query-facts.tsv")" -eq "$initial_rows"
printf '%s\n' 'May 11 09:02:00 dnsmasq[123]: query[A] next.invalid from 192.168.1.10' >> "$TMP_DIR/dnsmasq.log"
run_sampler
test "$(wc -l < "$TMP_DIR/dns-query-facts.tsv")" -eq "$((initial_rows + 1))"
mv "$TMP_DIR/dnsmasq.log" "$TMP_DIR/old.log"
printf '%s\n' 'May 11 09:03:00 dnsmasq[123]: query[A] rotated.invalid from 192.168.1.10' > "$TMP_DIR/dnsmasq.log"
run_sampler
grep -q 'rotated.invalid' "$TMP_DIR/dns-query-facts.tsv"
: > "$TMP_DIR/dnsmasq.log"
run_sampler
printf '%s\n' 'May 11 09:04:00 dnsmasq[123]: query[A] truncated.invalid from 192.168.1.10' > "$TMP_DIR/dnsmasq.log"
run_sampler
grep -q 'truncated.invalid' "$TMP_DIR/dns-query-facts.tsv"
before=$(wc -l < "$TMP_DIR/dns-query-facts.tsv")
printf '%s' 'May 11 09:05:00 dnsmasq[123]: query[A] unfinished.invalid' >> "$TMP_DIR/dnsmasq.log"
run_sampler
test "$(wc -l < "$TMP_DIR/dns-query-facts.tsv")" -eq "$before"
printf '%s\n' ' from 192.168.1.10' >> "$TMP_DIR/dnsmasq.log"
run_sampler
test "$(wc -l < "$TMP_DIR/dns-query-facts.tsv")" -eq "$((before + 1))"

echo "dns-query-snapshot tests passed"
