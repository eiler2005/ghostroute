#!/bin/bash
set -euo pipefail

# Offline fixture test for egress-dpi-probe.
#
# Covers: arg parsing, Vault resolution, the per-vantage verdict mapping, the
# control-vs-router cross verdict, output sanitization, and JSON shape.
# Does NOT cover live TCP/TLS probing — that is exercised by running the tool
# against real backends. The GHOSTROUTE_DPI_PROBE_STUB_DIR seam feeds canned
# probe lines so the classification/comparison logic runs without a network.

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

STUB_BIN="$TMPDIR/bin"; mkdir -p "$STUB_BIN"
STUB_PROBES="$TMPDIR/probes"; mkdir -p "$STUB_PROBES"

ROUTER_ENV="$TMPDIR/router.env"
VAULT_FILE="$TMPDIR/stealth.yml"
BACKENDS_FILE="$TMPDIR/managed-egress-backends.tsv"

cat >"$ROUTER_ENV" <<'EOF'
ROUTER_ACCESS_MODE=remote
ROUTER=router.example.invalid
ROUTER_WAN_PORT=2222
ROUTER_USER=admin
SSH_IDENTITY_FILE=/tmp/fake-router-key
ROUTER_ACCESS_PREFLIGHT=ssh
EOF

: >"$VAULT_FILE"

cat >"$BACKENDS_FILE" <<'EOF'
# role	label	host_ref	port_ref	port_default	sni_ref	note
primary_vps	primary owned VPS	vps_ssh_host	-	443	reality_server_names[0]	owned production backend
backup_reality	reserve Reality backend	vault_router_backup_reality_server	vault_router_backup_reality_server_port	443	vault_router_backup_reality_server_name	incident reserve backend
hermes_vps	owned clone VPS	vault_router_hermes_vps_host|vault_router_hermes_vps_ssh_host	vault_router_hermes_vps_port	443	vault_router_hermes_vps_server_name|reality_server_names[0]	owned clone candidate
EOF

cat >"$STUB_BIN/ansible-vault" <<'EOF'
#!/bin/sh
if [ "${1:-}" = "view" ]; then
  cat <<'VAULT'
vps_ssh_host: "primary.example.invalid"
reality_server_names:
  - "cover.example.invalid"
vault_router_managed_egress_mode: "backup_reality"
vault_router_backup_reality_server: "198.51.100.20"
vault_router_backup_reality_server_port: 443
vault_router_backup_reality_server_name: "backup.example.invalid"
vault_router_hermes_vps_host: "203.0.113.50"
vault_router_hermes_vps_port: 443
vault_router_hermes_vps_server_name: "hermes.example.invalid"
VAULT
  exit 0
fi
echo "unsupported ansible-vault call" >&2
exit 1
EOF

# ssh stub: only needs to satisfy the preflight `true` from router_health_load_env.
cat >"$STUB_BIN/ssh" <<'EOF'
#!/bin/sh
for arg in "$@"; do
  [ "$arg" = "true" ] && exit 0
done
exit 0
EOF

chmod +x "$STUB_BIN/ansible-vault" "$STUB_BIN/ssh"

# Canned probe results. Filenames: <vantage>-<role>.tsv with role<TAB>stage<TAB>bytes<TAB>elapsed.
# Scenario:
#   primary_vps    : clear on both vantages
#   backup_reality : router clear, control reset -> network_specific_filtering
#   hermes_vps     : tcp refused on both -> host_or_fw
printf 'primary_vps\tok\t4097\t0.210\n'        >"$STUB_PROBES/control-primary_vps.tsv"
printf 'primary_vps\tok\t4097\t0.180\n'        >"$STUB_PROBES/router-primary_vps.tsv"
printf 'backup_reality\ttls_reset\t0\t0.090\n' >"$STUB_PROBES/control-backup_reality.tsv"
printf 'backup_reality\tok\t4097\t0.200\n'     >"$STUB_PROBES/router-backup_reality.tsv"
printf 'hermes_vps\ttcp_refused\t0\t0.050\n'   >"$STUB_PROBES/control-hermes_vps.tsv"
printf 'hermes_vps\ttcp_refused\t0\t0.050\n'   >"$STUB_PROBES/router-hermes_vps.tsv"

assert_contains() {
  local file="$1" pattern="$2"
  if ! grep -F -- "$pattern" "$file" >/dev/null 2>&1; then
    echo "Expected pattern not found: $pattern" >&2
    echo "--- file: $file ---" >&2; cat "$file" >&2; exit 1
  fi
}
assert_not_contains() {
  local file="$1" pattern="$2"
  if grep -F -- "$pattern" "$file" >/dev/null 2>&1; then
    echo "Unexpected pattern found: $pattern" >&2
    echo "--- file: $file ---" >&2; cat "$file" >&2; exit 1
  fi
}

COMMON_ENV=(
  "PATH=$STUB_BIN:$PATH"
  "GHOSTROUTE_ROUTER_ENV_FILE=$ROUTER_ENV"
  "GHOSTROUTE_STEALTH_VAULT_FILE=$VAULT_FILE"
  "GHOSTROUTE_MANAGED_EGRESS_BACKENDS_FILE=$BACKENDS_FILE"
  "GHOSTROUTE_DPI_PROBE_STUB_DIR=$STUB_PROBES"
)

HUMAN_OUT="$TMPDIR/human.out"
env "${COMMON_ENV[@]}" \
  "${PROJECT_ROOT}/modules/ghostroute-health-monitor/bin/egress-dpi-probe" --from both >"$HUMAN_OUT"

assert_contains "$HUMAN_OUT" "from=both"
assert_contains "$HUMAN_OUT" "open"
assert_contains "$HUMAN_OUT" "reset"
assert_contains "$HUMAN_OUT" "refused"
assert_contains "$HUMAN_OUT" "Switching backend will NOT help"
assert_contains "$HUMAN_OUT" "heuristic signal, not a certainty"

# No real endpoint material may appear.
for secretish in primary.example.invalid backup.example.invalid hermes.example.invalid cover.example.invalid 198.51.100 203.0.113; do
  assert_not_contains "$HUMAN_OUT" "$secretish"
done

JSON_OUT="$TMPDIR/json.out"
env "${COMMON_ENV[@]}" \
  "${PROJECT_ROOT}/modules/ghostroute-health-monitor/bin/egress-dpi-probe" --from both --json >"$JSON_OUT"

ruby -rjson - "$JSON_OUT" <<'RUBY'
j = JSON.parse(File.read(ARGV[0]))
raise "schema" unless j["schema_version"] == 1
raise "from" unless j["from"] == "both"
raise "active" unless j["active_backend"] == "backup_reality"
raise "rows" unless j["results"].length == 3

prim = j["results"].find { |r| r["role"] == "primary_vps" }
raise "primary open" unless prim.dig("vantages", "control", "verdict") == "open"
raise "primary cross" unless prim["cross_verdict"] == "clear_both"

bk = j["results"].find { |r| r["role"] == "backup_reality" }
raise "backup active" unless bk["active"] == true
raise "backup control reset" unless bk.dig("vantages", "control", "verdict") == "reset"
raise "backup cross" unless bk["cross_verdict"] == "network_specific_filtering"

hz = j["results"].find { |r| r["role"] == "hermes_vps" }
raise "hermes refused" unless hz.dig("vantages", "control", "verdict") == "refused"
raise "hermes cross" unless hz["cross_verdict"] == "consistent_degraded"
RUBY

for secretish in primary.example.invalid backup.example.invalid hermes.example.invalid cover.example.invalid 198.51.100 203.0.113; do
  assert_not_contains "$JSON_OUT" "$secretish"
done

# Single-vantage control-only run must not require the router and yields no cross verdict.
CONTROL_OUT="$TMPDIR/control.out"
env "${COMMON_ENV[@]}" \
  "${PROJECT_ROOT}/modules/ghostroute-health-monitor/bin/egress-dpi-probe" --from control --json >"$CONTROL_OUT"
ruby -rjson - "$CONTROL_OUT" <<'RUBY'
j = JSON.parse(File.read(ARGV[0]))
raise "from control" unless j["from"] == "control"
j["results"].each do |r|
  raise "no router vantage" if r.dig("vantages", "router")
  raise "no cross" unless r["cross_verdict"].nil?
end
RUBY

echo "egress-dpi-probe fixture tests passed"
