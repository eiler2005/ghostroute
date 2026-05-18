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
2026-05-11T09:15:00+0300|192.168.1.11|192.0.2.70|443|tcp|Direct|10|15|25|1|conntrack_snapshot_delta|observed_delta|ip|ok|none|no_ipset||||
EOF

cat > "$TMP_DIR/dns-query-facts.tsv" <<'EOF'
2026-05-10T09:00:00+0300|192.168.1.10|yesterday.invalid|A|192.0.2.10|answer|dnsmasq|ok|parsed_log
2026-05-11T09:00:00+0300|192.168.1.10|example.invalid|A|192.0.2.20|answer|dnsmasq|ok|parsed_log
2026-05-11T09:20:00+0300|192.168.1.10|future.invalid|A|192.0.2.40|answer|dnsmasq|ok|parsed_log
2026-05-11T09:00:00+0300|192.168.1.10|cdn-one.invalid|A|192.0.2.50|answer|dnsmasq|ok|parsed_log
2026-05-11T09:01:00+0300|192.168.1.10|cdn-two.invalid|A|192.0.2.50|answer|dnsmasq|ok|parsed_log
bad-time|192.168.1.10|bad.invalid|A|192.0.2.60|answer|dnsmasq|ok|parsed_log
EOF

cat > "$TMP_DIR/lan-device-counters.tsv" <<'EOF'
2026-05-11T08:55:00+0300|192.168.1.10|test-laptop|0|0|0|0|0|0|aa:bb|test-laptop
2026-05-11T09:20:00+0300|192.168.1.10|test-laptop|2000|4000|1000|2000|0|0|aa:bb|test-laptop
bad-time|192.168.1.10|bad|0|0|0|0|0|0|aa|bad
EOF

cat > "$TMP_DIR/sing-box-route-evidence.tsv" <<'EOF'
2026-05-11T09:10:02+0300|77|Direct|direct-out|192.0.2.50:443|192.0.2.50|443|sing-box.log|ok||
2026-05-11T09:05:02+0300|88|VPS|reality-out|api.example.invalid:443|api.example.invalid|443|sing-box.log|ok|reality-in|iphone-4
2026-05-11T09:05:03+0300|89|Direct|direct-out|direct.example.invalid:443|direct.example.invalid|443|sing-box.log|ok|reality-in|iphone-4
2026-05-11T09:05:04+0300|90|VPS|reality-out|channel-b.example.invalid:443|channel-b.example.invalid|443|sing-box.log|ok|channel-b-relay-socks|
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
GHOSTROUTE_TRAFFIC_EVIDENCE_APPEND_CURRENT_MOBILE=0 \
  "$PROJECT_ROOT/modules/traffic-observatory/bin/traffic-evidence" --json today > "$TMP_DIR/evidence.json"

GHOSTROUTE_TRAFFIC_FACTS_EVIDENCE_FILE="$TMP_DIR/evidence.json" \
  "$PROJECT_ROOT/modules/traffic-observatory/bin/traffic-facts" --json today > "$TMP_DIR/facts.json"

ruby -rjson -e '
  evidence = JSON.parse(File.read(ARGV[0]))
  facts = JSON.parse(File.read(ARGV[1]))
  abort "expected evidence schema v1" unless evidence["schema_version"] == 1
  abort "expected window bounds" unless evidence.dig("window", "start_ts_utc") && evidence.dig("window", "end_ts_utc")
  abort "expected four today flow samples" unless evidence["flow_samples"].length == 4
  abort "expected LAN route counter delta" unless evidence["lan_device_route_deltas"].length == 1
  abort "expected sing-box route evidence" unless evidence["sing_box_route_evidence"].length == 4
  abort "expected three Home Reality samples" unless evidence["home_reality_samples"].length == 3
  abort "yesterday flow leaked into today evidence" if evidence["flow_samples"].any? { |row| row["remote_ip"] == "192.0.2.10" }
  abort "expected timestamp warnings" unless evidence["warnings"].any? { |row| row["code"] == "unparsable_timestamp" }
  abort "expected traffic-facts schema v3" unless facts["schema_version"] == 3
  abort "expected ten traffic facts" unless facts["traffic_facts"].length == 10
  abort "yesterday flow leaked into today facts" if facts["traffic_facts"].any? { |row| row["destination_ip"] == "192.0.2.10" }
  facts["traffic_facts"].each do |row|
    sum = row["via_vps_bytes"].to_i + row["direct_bytes"].to_i + row["unknown_bytes"].to_i
    abort "byte split mismatch: #{row.inspect}" unless row["bytes"].to_i == sum
  end
  linked = facts["traffic_facts"].find { |row| row["destination_ip"] == "192.0.2.20" }
  abort "expected dns link" unless linked && linked["dns_qname"] == "example.invalid" && linked["dns_link_confidence"] == "high" && linked["dns_status"] == "exact"
  abort "expected counter allocated route" unless linked["route"] == "Mixed" && linked["intended_route"] == "VPS" && linked["route_verification"] == "counter_allocated" && linked["route_status"] == "counter_allocated"
  abort "accounting_status should only describe accounting" unless linked["accounting_status"] == "ok"
  abort "expected no synthetic outbound" unless linked["outbound"].to_s.empty?
  abort "expected counter allocated split" unless linked["unknown_bytes"].to_i == 0 && linked["via_vps_bytes"].to_i == 2800 && linked["direct_bytes"].to_i == 1400
  future = facts["traffic_facts"].find { |row| row["destination_ip"] == "192.0.2.40" }
  abort "future DNS was linked" unless future && future["dns_link_confidence"] == "no_dns_match" && future["dns_qname"].to_s.empty?
  shared = facts["traffic_facts"].find { |row| row["destination_ip"] == "192.0.2.50" }
  abort "shared answer should be low confidence" unless shared && shared["dns_link_confidence"] == "low" && shared["dns_qname"].to_s.empty? && shared["destination"] == "192.0.2.50"
  abort "sing-box mismatch should be visible" unless shared["route_verification"] == "mismatch" && shared["outbound"] == "direct-out" && shared["unknown_bytes"].to_i == shared["bytes"].to_i
  no_ipset = facts["traffic_facts"].find { |row| row["destination_ip"] == "192.0.2.70" }
  abort "no_ipset should not become intent_only" unless no_ipset && no_ipset["route_verification"] == "unknown" && no_ipset["route_status"] == "unknown"
  home = facts["traffic_facts"].select { |row| row["client_key"] == "iphone-4" && row["evidence_level"] == "home_reality_sing_box_destination_estimate" }
  abort "expected estimated Home Reality destination facts" unless home.length == 6
  abort "Home Reality ingress should be residual-only" if facts["traffic_facts"].any? { |row| row["destination"] == "Home Reality ingress" }
  abort "expected Home Reality profile key" unless home.all? { |row| row["traffic_class"] == "client" }
  abort "Home Reality should use ingress route allocation" unless home.all? { |row| row["route_verification"] == "ingress_route_allocated" && row["route_status"] == "counter_allocated" }
  abort "Home Reality bytes must use route split invariant" unless home.all? { |row| row["bytes"].to_i == row["unknown_bytes"].to_i + row["via_vps_bytes"].to_i + row["direct_bytes"].to_i }
  abort "Home Reality must stay estimated without DNS proof" unless home.all? { |row| row["dns_link_confidence"] == "no_dns_match" && row["dns_qname"].to_s.empty? && row["destination_confidence"] == "sing_box_destination" && row["confidence"] == "estimated" }
  abort "Home Reality should preserve exact counter total" unless home.sum { |row| row["bytes"].to_i } == evidence["home_reality_samples"].sum { |row| row["total_bytes"].to_i }
  vps_home = home.select { |row| row["destination"] == "api.example.invalid" }
  direct_home = home.select { |row| row["destination"] == "direct.example.invalid" }
  abort "expected three VPS and three Direct Home Reality destination facts" unless vps_home.length == 3 && direct_home.length == 3
  abort "expected VPS destination split" unless vps_home.all? { |row| row["route"] == "VPS" && row["via_vps_bytes"].to_i == row["bytes"].to_i && row["direct_bytes"].to_i == 0 && row["unknown_bytes"].to_i == 0 }
  abort "expected Direct destination split" unless direct_home.all? { |row| row["route"] == "Direct" && row["direct_bytes"].to_i == row["bytes"].to_i && row["via_vps_bytes"].to_i == 0 && row["unknown_bytes"].to_i == 0 }
' "$TMP_DIR/evidence.json" "$TMP_DIR/facts.json"

CURRENT_DIR="$TMP_DIR/current-home-reality"
mkdir -p "$CURRENT_DIR"
cat > "$CURRENT_DIR/mobile-reality-counters.tsv" <<'EOF'
2026-05-11T09:00:00+0300|198.51.100.20|remote:198.51.100.20|1000|2000
EOF
cat > "$CURRENT_DIR/current-mobile.tsv" <<'EOF'
198.51.100.20|remote:198.51.100.20|1250|2600
EOF

GHOSTROUTE_TRAFFIC_WINDOW_NOW="2026-05-11T09:10:00+0300" \
GHOSTROUTE_TRAFFIC_STATE_DIR="$CURRENT_DIR" \
TRAFFIC_MOBILE_CURRENT_FILE="$CURRENT_DIR/current-mobile.tsv" \
  "$PROJECT_ROOT/modules/traffic-observatory/bin/traffic-evidence" --json today > "$CURRENT_DIR/evidence-current.json"

GHOSTROUTE_TRAFFIC_FACTS_EVIDENCE_FILE="$CURRENT_DIR/evidence-current.json" \
  "$PROJECT_ROOT/modules/traffic-observatory/bin/traffic-facts" --json today > "$CURRENT_DIR/facts-current.json"

ruby -rjson -e '
  evidence = JSON.parse(File.read(ARGV[0]))
  facts = JSON.parse(File.read(ARGV[1]))
  home_samples = evidence["home_reality_samples"]
  abort "unprofiled current Home Reality sample leaked into client evidence" unless home_samples.empty?
  home = facts["traffic_facts"].select { |row| row["destination"] == "Home Reality ingress" }
  abort "unprofiled current Home Reality fact leaked into traffic facts" unless home.empty?
  warning = evidence.fetch("warnings").find { |row| row["code"] == "home_reality_unprofiled_ingress_not_client_observed" }
  abort "expected unprofiled current Home Reality warning" unless warning && warning["bytes"].to_i == 850
' "$CURRENT_DIR/evidence-current.json" "$CURRENT_DIR/facts-current.json"

IPTABLES_DIR="$TMP_DIR/current-home-reality-iptables"
FAKE_BIN="$IPTABLES_DIR/bin"
mkdir -p "$FAKE_BIN"
cat > "$IPTABLES_DIR/mobile-reality-counters.tsv" <<'EOF'
2026-05-11T09:00:00+0300|198.51.100.30|phone-profile|1000|2000
EOF
cat > "$FAKE_BIN/iptables-save" <<'EOF'
#!/bin/sh
cat <<'RULES'
[10:2000] -A RC_MOBILE_REALITY_IN -s 198.51.100.30/32 -j RETURN
[20:5000] -A RC_MOBILE_REALITY_OUT -d 198.51.100.30/32 -j RETURN
RULES
EOF
chmod +x "$FAKE_BIN/iptables-save"

PATH="$FAKE_BIN:$PATH" \
GHOSTROUTE_TRAFFIC_WINDOW_NOW="2026-05-11T09:10:00+0300" \
GHOSTROUTE_TRAFFIC_STATE_DIR="$IPTABLES_DIR" \
  "$PROJECT_ROOT/modules/traffic-observatory/bin/traffic-evidence" --json today > "$IPTABLES_DIR/evidence-current.json"

ruby -rjson -e '
  evidence = JSON.parse(File.read(ARGV[0]))
  home_samples = evidence["home_reality_samples"]
  abort "expected iptables Home Reality current sample" unless home_samples.length == 1
  sample = home_samples.first
  abort "expected iptables current Home Reality delta bytes" unless sample["bytes_up"].to_i == 1000 && sample["bytes_down"].to_i == 3000 && sample["total_bytes"].to_i == 4000
  abort "expected iptables current sample to preserve known profile label" unless sample["client_label"] == "phone-profile"
' "$IPTABLES_DIR/evidence-current.json"

echo "traffic evidence/facts v3 tests passed"
