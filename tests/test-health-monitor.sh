#!/bin/bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

export HEALTH_MONITOR_LOG_DIR="$TMPDIR/health-monitor"
export HEALTH_MONITOR_ALERT_COOLDOWN_SECONDS=3600

TODAY="$(date +%F)"
RAW_DIR="$HEALTH_MONITOR_LOG_DIR/raw"
RAW_FILE="$RAW_DIR/${TODAY}.jsonl"
mkdir -p "$RAW_DIR"

assert_contains() {
  local file="$1"
  local pattern="$2"
  if ! grep -F -- "$pattern" "$file" >/dev/null 2>&1; then
    echo "Expected pattern not found: $pattern" >&2
    echo "--- file: $file ---" >&2
    cat "$file" >&2
    exit 1
  fi
}

assert_json_valid() {
  local file="$1"
  ruby -rjson -e 'JSON.parse(File.read(ARGV[0]))' "$file"
}

assert_jsonl_valid() {
  local file="$1"
  ruby -rjson -e 'File.foreach(ARGV[0]) { |line| JSON.parse(line) unless line.strip.empty? }' "$file"
}

cat > "$RAW_FILE" <<EOF
{"ts":"2026-04-26T10:00:00+0300","probe":"channel_b_reality","status":"OK","risk":"Channel B / Reality path down","message":"ok","evidence":"exit_ip=198.51.100.10","action":"No action.","version":1}
{"ts":"2026-04-26T10:00:00+0300","probe":"rule_set_sync","status":"CRIT","risk":"rule-set drift","message":"drift","evidence":"only_dns=1","action":"Regenerate rule-sets after approval.","version":1}
EOF

"$PROJECT_ROOT/scripts/health-monitor/aggregate"

assert_json_valid "$HEALTH_MONITOR_LOG_DIR/status.json"
assert_contains "$HEALTH_MONITOR_LOG_DIR/status.json" '"overall":"CRIT"'
assert_contains "$HEALTH_MONITOR_LOG_DIR/summary-latest.md" '# Модуль мониторинга работоспособности GhostRoute'
assert_contains "$HEALTH_MONITOR_LOG_DIR/summary-latest.md" '| `rule_set_sync` | `CRIT` |'
assert_contains "$HEALTH_MONITOR_LOG_DIR/alerts/${TODAY}.md" '| `rule_set_sync` | `CRIT` | `UNKNOWN` |'
assert_jsonl_valid "$HEALTH_MONITOR_LOG_DIR/alerts/${TODAY}.jsonl"

initial_alerts="$(wc -l < "$HEALTH_MONITOR_LOG_DIR/alerts/${TODAY}.jsonl" | tr -d ' ')"
"$PROJECT_ROOT/scripts/health-monitor/aggregate"
second_alerts="$(wc -l < "$HEALTH_MONITOR_LOG_DIR/alerts/${TODAY}.jsonl" | tr -d ' ')"
if [ "$initial_alerts" != "$second_alerts" ]; then
  echo "Expected no duplicate alert inside cooldown window" >&2
  exit 1
fi

cat >> "$RAW_FILE" <<EOF
{"ts":"2026-04-26T10:05:00+0300","probe":"rule_set_sync","status":"OK","risk":"rule-set drift","message":"ok","evidence":"domains=2","action":"No action.","version":1}
EOF
"$PROJECT_ROOT/scripts/health-monitor/aggregate"
assert_contains "$HEALTH_MONITOR_LOG_DIR/status.json" '"overall":"OK"'
assert_contains "$HEALTH_MONITOR_LOG_DIR/alerts/${TODAY}.md" '| `rule_set_sync` | `OK` | `CRIT` |'

FIXTURE="$TMPDIR/rules"
mkdir -p "$FIXTURE"
cat > "$FIXTURE/dnsmasq.conf" <<'EOF'
ipset=/youtube.com/STEALTH_DOMAINS
ipset=/github.com/STEALTH_DOMAINS
EOF
cat > "$FIXTURE/rules.json" <<'EOF'
{
  "version": 3,
  "rules": [
    { "domain_suffix": [
      "github.com",
      "youtube.com"
    ] }
  ]
}
EOF

export HEALTH_MONITOR_DNSMASQ_FILE="$FIXTURE/dnsmasq.conf"
export HEALTH_MONITOR_DNSMASQ_AUTO_FILE="$FIXTURE/missing-auto.conf"
export HEALTH_MONITOR_RULESET_FILE="$FIXTURE/rules.json"
export HEALTH_MONITOR_PROBE_FILTER=rule_set_sync
"$PROJECT_ROOT/scripts/health-monitor/run-probes"
assert_jsonl_valid "$RAW_FILE"
tail -1 "$RAW_FILE" | grep -F '"probe":"rule_set_sync"' | grep -F '"status":"OK"' >/dev/null

cat > "$FIXTURE/rules.json" <<'EOF'
{
  "version": 3,
  "rules": [
    { "domain_suffix": [
      "github.com"
    ] }
  ]
}
EOF
"$PROJECT_ROOT/scripts/health-monitor/run-probes"
tail -1 "$RAW_FILE" | grep -F '"probe":"rule_set_sync"' | grep -F '"status":"CRIT"' >/dev/null

old_raw="$RAW_DIR/2000-01-01.jsonl"
old_alert="$HEALTH_MONITOR_LOG_DIR/alerts/2000-01-01.md"
mkdir -p "$HEALTH_MONITOR_LOG_DIR/alerts"
: > "$old_raw"
: > "$old_alert"
touch -t 200001010000 "$old_raw" "$old_alert"
"$PROJECT_ROOT/scripts/health-monitor/aggregate"
[ ! -e "$old_raw" ] || { echo "Old raw file was not removed by retention" >&2; exit 1; }
[ ! -e "$old_alert" ] || { echo "Old alert md file was not removed by retention" >&2; exit 1; }

unset HEALTH_MONITOR_DNSMASQ_FILE HEALTH_MONITOR_DNSMASQ_AUTO_FILE HEALTH_MONITOR_RULESET_FILE
export HEALTH_MONITOR_PROBE_FILTER=performance_rtt
export SINGBOX_LOG_PATH="$TMPDIR/sing-box.log"
rm -rf "$HEALTH_MONITOR_LOG_DIR/state/baselines"
cat > "$SINGBOX_LOG_PATH" <<'EOF'
INFO [abc 100ms] outbound/vless[reality-out]: test
EOF
"$PROJECT_ROOT/scripts/health-monitor/run-probes"
tail -1 "$RAW_FILE" | grep -F '"probe":"performance_rtt"' | grep -F '"status":"OK"' | grep -F 'baseline=learning' >/dev/null

rm -rf "$HEALTH_MONITOR_LOG_DIR/state/baselines"
(
  . "$PROJECT_ROOT/scripts/health-monitor/lib.sh"
  now="$(date +%s)"
  i=0
  while [ "$i" -lt 24 ]; do
    hm_baseline_observe performance_rtt 100 $((now - 1000 + i))
    i=$((i + 1))
  done
)
cat > "$SINGBOX_LOG_PATH" <<'EOF'
INFO [abc 500ms] outbound/vless[reality-out]: test
EOF
"$PROJECT_ROOT/scripts/health-monitor/run-probes"
tail -1 "$RAW_FILE" | grep -F '"probe":"performance_rtt"' | grep -F '"status":"WARN"' | grep -F 'baseline_p95_ms=100' >/dev/null

rm -rf "$HEALTH_MONITOR_LOG_DIR/state/baselines"
cat > "$SINGBOX_LOG_PATH" <<'EOF'
INFO [abc 3101ms] outbound/vless[reality-out]: test
EOF
"$PROJECT_ROOT/scripts/health-monitor/run-probes"
tail -1 "$RAW_FILE" | grep -F '"probe":"performance_rtt"' | grep -F '"status":"CRIT"' | grep -F 'hard_crit_ms=3000' >/dev/null

echo "health-monitor fixture tests passed"
