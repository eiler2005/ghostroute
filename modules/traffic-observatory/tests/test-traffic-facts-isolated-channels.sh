#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/evidence.json" <<'JSON'
{"generated_at":"2026-05-11T09:00:00Z","window":{"period":"today"},"isolated_channel_samples":[
 {"sample_id":"one","ts":"2026-05-11T09:00:00Z","channel":"anyT","client_key":"anyT-01","bytes_up":100,"bytes_down":200},
 {"sample_id":"two","ts":"2026-05-11T09:00:00Z","channel":"Snell","client_key":"Snell-01","bytes_up":400,"bytes_down":500},
 {"sample_id":"three","ts":"2026-05-11T09:00:00Z","channel":"D","client_key":"D-01","bytes_up":20,"bytes_down":30},
 {"sample_id":"four","ts":"2026-05-11T09:00:00Z","channel":"Amn","client_key":"Amn-01","bytes_up":50,"bytes_down":50},
 {"sample_id":"invalid","ts":"2026-05-11T09:00:00Z","channel":"anyT","client_key":"anyT-02","bytes_up":-1,"bytes_down":50},
 {"sample_id":"scope","ts":"2026-05-11T09:00:00Z","channel":"unknown","client_key":"other","bytes_up":20,"bytes_down":20}
]}
JSON
GHOSTROUTE_TRAFFIC_FACTS_EVIDENCE_FILE="$tmp/evidence.json" "$root/modules/traffic-observatory/bin/traffic-facts" --json today > "$tmp/facts.json"
ruby -rjson -e '
  facts = JSON.parse(File.read(ARGV[0]))
  rows = facts.fetch("traffic_facts")
  abort "wrong samples" unless rows.length == 4 && rows.sum { |r| r.fetch("bytes") } == 1350
  abort "unobserved route or destination" unless rows.all? { |r| r["route"] == "Unknown" && r["unknown_bytes"] == r["bytes"] && r["destination_ip"] == "" }
  abort "missing client scope" unless rows.map { |r| r["channel"] }.sort == ["Channel Amn", "Channel D", "Channel Snell", "Channel anyT"]
  abort "wrong evidence semantics" unless rows.find { |r| r["channel"] == "Channel D" }["evidence_level"] == "caddy_connect_stream" && rows.find { |r| r["channel"] == "Channel Amn" }["evidence_level"] == "amneziawg_peer_counter"
  abort "invalid byte split" unless rows.all? { |r| r["bytes_up"] + r["bytes_down"] == r["bytes"] }
' "$tmp/facts.json"
echo 'isolated channel traffic-facts fixture passed'
