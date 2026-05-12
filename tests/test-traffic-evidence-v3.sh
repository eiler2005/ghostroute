#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cat > "$TMP_DIR/lan-flow-facts.tsv" <<'EOF'
2026-05-10T09:00:00+0300|192.168.1.10|192.0.2.10|443|tcp|VPS|1|2|3|1|conntrack_snapshot_delta|observed_delta|ip|ok|ipset|ipset_membership|STEALTH_DOMAINS|||
not-a-time|192.168.1.10|192.0.2.11|443|tcp|VPS|1|2|3|1|conntrack_snapshot_delta|observed_delta|ip|ok|ipset|ipset_membership|STEALTH_DOMAINS|||
2026-05-11T09:00:00+0300|192.168.1.10|192.0.2.20|443|tcp|VPS|1200|3000|4200|1|conntrack_snapshot_delta|observed_delta|ip|ok|ipset|ipset_membership|STEALTH_DOMAINS|||
2026-05-11T09:05:00+0300|192.168.1.10|192.0.2.40|443|tcp|Direct|100|200|300|1|conntrack_snapshot_delta|observed_delta|ip|ok|route_lookup|default_direct||||
2026-05-11T09:10:00+0300|192.168.1.10|192.0.2.50|443|tcp|VPS|10|20|30|1|conntrack_snapshot_delta|observed_delta|ip|ok|ipset|ipset_membership|STEALTH_DOMAINS|||
2026-05-11T09:15:00+0300|192.168.1.10|192.0.2.70|443|tcp|Direct|10|15|25|1|conntrack_snapshot_delta|observed_delta|ip|ok|none|no_ipset||||
EOF

cat > "$TMP_DIR/dns-query-facts.tsv" <<'EOF'
2026-05-10T09:00:00+0300|192.168.1.10|yesterday.invalid|A|192.0.2.10|answer|dnsmasq|ok|parsed_log
2026-05-11T09:00:00+0300|192.168.1.10|example.invalid|A|192.0.2.20|answer|dnsmasq|ok|parsed_log
2026-05-11T09:20:00+0300|192.168.1.10|future.invalid|A|192.0.2.40|answer|dnsmasq|ok|parsed_log
2026-05-11T09:00:00+0300|192.168.1.10|cdn-one.invalid|A|192.0.2.50|answer|dnsmasq|ok|parsed_log
2026-05-11T09:01:00+0300|192.168.1.10|cdn-two.invalid|A|192.0.2.50|answer|dnsmasq|ok|parsed_log
bad-time|192.168.1.10|bad.invalid|A|192.0.2.60|answer|dnsmasq|ok|parsed_log
EOF

cat > "$TMP_DIR/mobile-reality-counters.tsv" <<'EOF'
2026-05-10T09:00:00+0300|198.51.100.10|iphone-4|1000|2000
2026-05-11T08:55:00+0300|198.51.100.10|iphone-4|2000|4000
2026-05-11T09:05:00+0300|198.51.100.10|iphone-4|2600|4600
2026-05-11T09:10:00+0300|198.51.100.10|iphone-4|100|200
2026-05-11T09:15:00+0300|198.51.100.10|iphone-4|150|250
bad-time|198.51.100.11|iphone-5|1|2
EOF

GHOSTROUTE_TRAFFIC_WINDOW_NOW="2026-05-11T12:00:00+0300" \
GHOSTROUTE_TRAFFIC_STATE_DIR="$TMP_DIR" \
  "$PROJECT_ROOT/modules/traffic-observatory/bin/traffic-evidence" --json today > "$TMP_DIR/evidence.json"

GHOSTROUTE_TRAFFIC_FACTS_EVIDENCE_FILE="$TMP_DIR/evidence.json" \
  "$PROJECT_ROOT/modules/traffic-observatory/bin/traffic-facts" --json today > "$TMP_DIR/facts.json"

ruby -rjson -e '
  evidence = JSON.parse(File.read(ARGV[0]))
  facts = JSON.parse(File.read(ARGV[1]))
  abort "expected evidence schema v1" unless evidence["schema_version"] == 1
  abort "expected window bounds" unless evidence.dig("window", "start_ts_utc") && evidence.dig("window", "end_ts_utc")
  abort "expected four today flow samples" unless evidence["flow_samples"].length == 4
  abort "expected three Home Reality samples" unless evidence["home_reality_samples"].length == 3
  abort "yesterday flow leaked into today evidence" if evidence["flow_samples"].any? { |row| row["remote_ip"] == "192.0.2.10" }
  abort "expected timestamp warnings" unless evidence["warnings"].any? { |row| row["code"] == "unparsable_timestamp" }
  abort "expected traffic-facts schema v3" unless facts["schema_version"] == 3
  abort "expected seven traffic facts" unless facts["traffic_facts"].length == 7
  abort "yesterday flow leaked into today facts" if facts["traffic_facts"].any? { |row| row["destination_ip"] == "192.0.2.10" }
  facts["traffic_facts"].each do |row|
    sum = row["via_vps_bytes"].to_i + row["direct_bytes"].to_i + row["unknown_bytes"].to_i
    abort "byte split mismatch: #{row.inspect}" unless row["bytes"].to_i == sum
  end
  linked = facts["traffic_facts"].find { |row| row["destination_ip"] == "192.0.2.20" }
  abort "expected dns link" unless linked && linked["dns_qname"] == "example.invalid" && linked["dns_link_confidence"] == "high" && linked["dns_status"] == "exact"
  abort "expected intent-only route" unless linked["route"] == "VPS" && linked["intended_route"] == "VPS" && linked["route_verification"] == "intent_only" && linked["route_status"] == "intent_only"
  abort "accounting_status should only describe accounting" unless linked["accounting_status"] == "ok"
  abort "expected no synthetic outbound" unless linked["outbound"].to_s.empty?
  abort "expected intent-only bytes to stay unknown" unless linked["unknown_bytes"].to_i == linked["bytes"].to_i && linked["via_vps_bytes"].to_i == 0
  future = facts["traffic_facts"].find { |row| row["destination_ip"] == "192.0.2.40" }
  abort "future DNS was linked" unless future && future["dns_link_confidence"] == "no_dns_match" && future["dns_qname"].to_s.empty?
  shared = facts["traffic_facts"].find { |row| row["destination_ip"] == "192.0.2.50" }
  abort "shared answer should be low confidence" unless shared && shared["dns_link_confidence"] == "low" && shared["dns_qname"].to_s.empty? && shared["destination"] == "192.0.2.50"
  no_ipset = facts["traffic_facts"].find { |row| row["destination_ip"] == "192.0.2.70" }
  abort "no_ipset should not become intent_only" unless no_ipset && no_ipset["route_verification"] == "unknown" && no_ipset["route_status"] == "unknown"
  home = facts["traffic_facts"].select { |row| row["destination"] == "Home Reality ingress" }
  abort "expected Home Reality facts" unless home.length == 3
  abort "expected Home Reality profile key" unless home.all? { |row| row["client_key"] == "iphone-4" && row["traffic_class"] == "client" }
  abort "Home Reality bytes must remain unknown route split" unless home.all? { |row| row["bytes"].to_i == row["unknown_bytes"].to_i && row["via_vps_bytes"].to_i == 0 && row["direct_bytes"].to_i == 0 }
  abort "Home Reality must not invent DNS/domain attribution" unless home.all? { |row| row["dns_link_confidence"] == "no_dns_match" && row["destination_confidence"] == "none" }
' "$TMP_DIR/evidence.json" "$TMP_DIR/facts.json"

echo "traffic evidence/facts v3 tests passed"
