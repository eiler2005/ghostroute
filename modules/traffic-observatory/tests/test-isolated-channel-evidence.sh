#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/isolated-channel-deltas.jsonl" <<'JSON'
{"sample_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","start":"2026-05-11T09:00:00+03:00","ts":"2026-05-11T09:05:00+03:00","channel":"anyT","client_key":"anyT-01","bytes_up":100,"bytes_down":200}
{"sample_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","start":"2026-05-11T09:00:00+03:00","ts":"2026-05-11T09:05:00+03:00","channel":"anyT","client_key":"anyT-01","bytes_up":100,"bytes_down":200}
{"sample_id":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","start":"2026-05-10T23:59:00+03:00","ts":"2026-05-11T00:01:00+03:00","channel":"Snell","client_key":"Snell-01","bytes_up":50,"bytes_down":50}
{"sample_id":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","start":"2026-05-11T09:00:00+03:00","ts":"2026-05-11T09:05:00+03:00","channel":"Snell","client_key":"Snell-02","bytes_up":-1,"bytes_down":50}
JSON
GHOSTROUTE_TRAFFIC_WINDOW_NOW="2026-05-11T12:00:00+0300" GHOSTROUTE_TRAFFIC_STATE_DIR="$tmp" GHOSTROUTE_TRAFFIC_EVIDENCE_APPEND_CURRENT_MOBILE=0 "$root/modules/traffic-observatory/bin/traffic-evidence" --json today > "$tmp/evidence.json"
GHOSTROUTE_TRAFFIC_FACTS_EVIDENCE_FILE="$tmp/evidence.json" "$root/modules/traffic-observatory/bin/traffic-facts" --json today > "$tmp/facts.json"
ruby -rjson -e '
  evidence, facts = ARGV.map { |path| JSON.parse(File.read(path)) }
  rows = evidence.fetch("isolated_channel_samples")
  abort "duplicate or invalid sample included" unless rows.length == 2 && rows.map { |r| r["client_key"] }.sort == ["Snell-01", "anyT-01"]
  codes = evidence.fetch("warnings").map { |w| w["code"] }
  abort "missing coverage warnings" unless codes.include?("isolated_channel_cross_window_interval") && codes.include?("isolated_channel_invalid_sample")
  row = facts.fetch("traffic_facts").find { |r| r["client_key"] == "anyT-01" }
  abort "counter not preserved" unless row && row["bytes"] == 300 && row["unknown_bytes"] == 300
' "$tmp/evidence.json" "$tmp/facts.json"
echo 'isolated channel evidence fixture passed'
