#!/bin/bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

STAGE="$TMPDIR/vps-health-monitor"
mkdir -p "$STAGE" "$TMPDIR/bin"
cp "$PROJECT_ROOT/scripts/vps-health-monitor/lib.sh" "$STAGE/lib.sh"
cp "$PROJECT_ROOT/scripts/vps-health-monitor/run-probes" "$STAGE/run-probes"
cp "$PROJECT_ROOT/scripts/health-monitor/aggregate" "$STAGE/aggregate"
cp "$PROJECT_ROOT/scripts/health-monitor/daily-digest" "$STAGE/daily-digest"
cp "$PROJECT_ROOT/scripts/health-monitor/run-once" "$STAGE/run-once"
chmod 0755 "$STAGE"/*

cat > "$TMPDIR/bin/ss" <<'EOF'
#!/bin/sh
case "$*" in
  *":443"*) [ "${FAKE_CADDY_DOWN:-0}" = "1" ] || echo 'LISTEN 0 4096 *:443 *:* users:(("caddy",pid=10,fd=3))' ;;
  *":62010"*) echo 'LISTEN 0 4096 127.0.0.1:62010 0.0.0.0:* users:(("xray",pid=20,fd=3))' ;;
esac
EOF
cat > "$TMPDIR/bin/caddy" <<'EOF'
#!/bin/sh
[ "$1" = "list-modules" ] && { echo layer4; exit 0; }
exit 0
EOF
cat > "$TMPDIR/bin/docker" <<'EOF'
#!/bin/sh
if [ "$1" = "ps" ]; then
  echo xray
elif [ "$1" = "logs" ]; then
  echo 'accepted reality inbound test'
fi
EOF
cat > "$TMPDIR/bin/curl" <<'EOF'
#!/bin/sh
exit 0
EOF
cat > "$TMPDIR/bin/df" <<'EOF'
#!/bin/sh
echo 'Filesystem 1024-blocks Used Available Capacity Mounted on'
echo '/dev/test 100000 10000 90000 10% /var/log'
EOF
chmod 0755 "$TMPDIR/bin"/*

export PATH="$TMPDIR/bin:$PATH"
export HEALTH_MONITOR_LOG_DIR="$TMPDIR/vps-log"
export VPS_HEALTH_CADDY_BIN="$TMPDIR/bin/caddy"
export VPS_HEALTH_XRAY_PORT=62010
export VPS_HEALTH_XUI_PORT=62011

"$STAGE/run-probes"
"$STAGE/aggregate"
ruby -rjson -e 'j = JSON.parse(File.read(ARGV[0])); raise "not OK" unless j["overall"] == "OK"' "$HEALTH_MONITOR_LOG_DIR/status.json"
grep -F '| `caddy_listener` | `OK` |' "$HEALTH_MONITOR_LOG_DIR/summary-latest.md" >/dev/null

FAKE_CADDY_DOWN=1 "$STAGE/run-probes"
"$STAGE/aggregate"
ruby -rjson -e 'j = JSON.parse(File.read(ARGV[0])); raise "not CRIT" unless j["overall"] == "CRIT"' "$HEALTH_MONITOR_LOG_DIR/status.json"
grep -F '| `caddy_listener` | `CRIT` |' "$HEALTH_MONITOR_LOG_DIR/summary-latest.md" >/dev/null
grep -F '| `caddy_listener` | `CRIT` | `OK` |' "$HEALTH_MONITOR_LOG_DIR/alerts/$(date +%F).md" >/dev/null

ROUTER_STATUS="$TMPDIR/router-status.json"
ROUTER_SUMMARY="$TMPDIR/router-summary.md"
VPS_STATUS="$TMPDIR/vps-status.json"
VPS_SUMMARY="$TMPDIR/vps-summary.md"

cat > "$ROUTER_STATUS" <<'EOF'
{"overall":"OK","checks":{}}
EOF
cat > "$ROUTER_SUMMARY" <<'EOF'
# Router
Router OK
EOF
cat > "$VPS_STATUS" <<'EOF'
{"overall":"OK","checks":{}}
EOF
cat > "$VPS_SUMMARY" <<'EOF'
# VPS
VPS OK
EOF
GHOSTROUTE_ROUTER_STATUS_JSON="$ROUTER_STATUS" GHOSTROUTE_ROUTER_SUMMARY_MD="$ROUTER_SUMMARY" \
GHOSTROUTE_VPS_STATUS_JSON="$VPS_STATUS" GHOSTROUTE_VPS_SUMMARY_MD="$VPS_SUMMARY" \
  "$PROJECT_ROOT/scripts/ghostroute-health-report" > "$TMPDIR/global-ok.md"
grep -F 'Overall: **OK**' "$TMPDIR/global-ok.md" >/dev/null

cat > "$VPS_STATUS" <<'EOF'
{"overall":"CRIT","checks":{}}
EOF
GHOSTROUTE_ROUTER_STATUS_JSON="$ROUTER_STATUS" GHOSTROUTE_ROUTER_SUMMARY_MD="$ROUTER_SUMMARY" \
GHOSTROUTE_VPS_STATUS_JSON="$VPS_STATUS" GHOSTROUTE_VPS_SUMMARY_MD="$VPS_SUMMARY" \
  "$PROJECT_ROOT/scripts/ghostroute-health-report" > "$TMPDIR/global-vps-crit.md"
grep -F 'Overall: **CRIT**' "$TMPDIR/global-vps-crit.md" >/dev/null
grep -F 'VPS observer: **CRIT**' "$TMPDIR/global-vps-crit.md" >/dev/null

cat > "$ROUTER_STATUS" <<'EOF'
{"overall":"WARN","checks":{}}
EOF
cat > "$VPS_STATUS" <<'EOF'
{"overall":"OK","checks":{}}
EOF
GHOSTROUTE_ROUTER_STATUS_JSON="$ROUTER_STATUS" GHOSTROUTE_ROUTER_SUMMARY_MD="$ROUTER_SUMMARY" \
GHOSTROUTE_VPS_STATUS_JSON="$VPS_STATUS" GHOSTROUTE_VPS_SUMMARY_MD="$VPS_SUMMARY" \
  "$PROJECT_ROOT/scripts/ghostroute-health-report" > "$TMPDIR/global-router-warn.md"
grep -F 'Overall: **WARN**' "$TMPDIR/global-router-warn.md" >/dev/null

echo "vps-health-monitor fixture tests passed"
