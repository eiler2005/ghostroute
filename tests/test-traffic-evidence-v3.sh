#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cat > "$TMP_DIR/lan-flow-facts.tsv" <<'EOF'
2026-05-11T09:00:00+0300|192.168.1.10|192.0.2.20|443|tcp|VPS|1200|3000|4200|1|conntrack_snapshot_delta|observed_delta|ip|ok
2026-05-11T09:05:00+0300|192.168.1.10|192.0.2.30|443|tcp|Direct|100|200|300|1|conntrack_snapshot_delta|observed_delta|ip|ok|ipset|default_direct||||
EOF

cat > "$TMP_DIR/dns-query-facts.tsv" <<'EOF'
2026-05-11T09:00:00+0300|192.168.1.10|example.invalid|A|192.0.2.20|answer|dnsmasq|ok
EOF

GHOSTROUTE_TRAFFIC_STATE_DIR="$TMP_DIR" \
  "$PROJECT_ROOT/modules/traffic-observatory/bin/traffic-evidence" --json today > "$TMP_DIR/evidence.json"

GHOSTROUTE_TRAFFIC_FACTS_EVIDENCE_FILE="$TMP_DIR/evidence.json" \
  "$PROJECT_ROOT/modules/traffic-observatory/bin/traffic-facts" --json today > "$TMP_DIR/facts.json"

ruby -rjson -e '
  evidence = JSON.parse(File.read(ARGV[0]))
  facts = JSON.parse(File.read(ARGV[1]))
  abort "expected evidence schema v1" unless evidence["schema_version"] == 1
  abort "expected two flow samples" unless evidence["flow_samples"].length == 2
  abort "expected traffic-facts schema v3" unless facts["schema_version"] == 3
  abort "expected two traffic facts" unless facts["traffic_facts"].length == 2
  facts["traffic_facts"].each do |row|
    sum = row["via_vps_bytes"].to_i + row["direct_bytes"].to_i + row["unknown_bytes"].to_i
    abort "byte split mismatch: #{row.inspect}" unless row["bytes"].to_i == sum
  end
  linked = facts["traffic_facts"].find { |row| row["destination_ip"] == "192.0.2.20" }
  abort "expected dns link" unless linked && linked["dns_qname"] == "example.invalid" && linked["dns_link_confidence"] != "none"
' "$TMP_DIR/evidence.json" "$TMP_DIR/facts.json"

echo "traffic evidence/facts v3 tests passed"
