#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

STUB_BIN="$TMPDIR/bin"
mkdir -p "$STUB_BIN"

ROUTER_ENV="$TMPDIR/router.env"
VAULT_FILE="$TMPDIR/stealth.yml"
BACKENDS_FILE="$TMPDIR/managed-egress-backends.tsv"
CANARIES_FILE="$TMPDIR/managed-app-canaries.tsv"

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

cat >"$CANARIES_FILE" <<'EOF'
telegram	https://core.telegram.org/	2,3
google	https://www.google.com/generate_204	2
blocked-app	https://blocked.example.invalid/	2,3
EOF

cat >"$STUB_BIN/ansible-vault" <<'EOF'
#!/bin/sh
if [ "${1:-}" = "view" ]; then
  cat <<'VAULT'
vps_ssh_host: "primary.example.invalid"
reality_server_names:
  - "cover.example.invalid"
vault_router_managed_egress_mode: "backup_reality"
vault_channel_d_managed_egress_mode: "follow"
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

cat >"$STUB_BIN/ssh" <<'EOF'
#!/bin/sh
for arg in "$@"; do
  [ "$arg" = "-N" ] && { sleep 600; exit 0; }
done

for arg in "$@"; do
  case "$arg" in
    true)
      exit 0
      ;;
    *ghostroute-runtime*)
      printf '%s\n' \
        'GHOSTROUTE_DNSCRYPT_SOCKS_PORT=1080' \
        'GHOSTROUTE_CHANNEL_D_NAIVEPROXY_ENABLED=1' \
        'GHOSTROUTE_CHANNEL_D_NAIVEPROXY_SOCKS_PORT=2080'
      exit 0
      ;;
    *GHOSTROUTE_PROBE_ROLE*)
      case "$arg" in
        *"GHOSTROUTE_PROBE_ROLE='primary_vps'"*)
          printf '%s_tcp\tOK\tconnect_ok\n' primary_vps
          printf '%s_tls\tWARN\tConnecting to 198.51.100.10\n' primary_vps
          ;;
        *"GHOSTROUTE_PROBE_ROLE='backup_reality'"*)
          printf '%s_tcp\tOK\tconnect_ok\n' backup_reality
          printf '%s_tls\tWARN\tConnecting to 198.51.100.20\n' backup_reality
          ;;
        *"GHOSTROUTE_PROBE_ROLE='hermes_vps'"*)
          printf '%s_tcp\tCRIT\tconnect_failed 203.0.113.50\n' hermes_vps
          printf '%s_tls\tUNKNOWN\topenssl_missing\n' hermes_vps
          ;;
      esac
      exit 0
      ;;
  esac
done

echo "unexpected ssh call: $*" >&2
exit 1
EOF

cat >"$STUB_BIN/curl" <<'EOF'
#!/bin/sh
last=""
for arg in "$@"; do
  last="$arg"
done

case "$last" in
  *core.telegram.org*) printf '200 0.100000' ;;
  *google.com*) printf '204 0.050000' ;;
  *blocked.example.invalid*) printf '403 0.200000' ;;
  *) printf '000 0' ;;
esac
EOF

chmod +x "$STUB_BIN/ansible-vault" "$STUB_BIN/ssh" "$STUB_BIN/curl"

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

assert_not_contains() {
  local file="$1"
  local pattern="$2"
  if grep -F -- "$pattern" "$file" >/dev/null 2>&1; then
    echo "Unexpected pattern found: $pattern" >&2
    echo "--- file: $file ---" >&2
    cat "$file" >&2
    exit 1
  fi
}

COMMON_ENV=(
  "PATH=$STUB_BIN:$PATH"
  "GHOSTROUTE_ROUTER_ENV_FILE=$ROUTER_ENV"
  "GHOSTROUTE_STEALTH_VAULT_FILE=$VAULT_FILE"
  "GHOSTROUTE_MANAGED_EGRESS_BACKENDS_FILE=$BACKENDS_FILE"
  "GHOSTROUTE_MANAGED_APP_CANARIES_FILE=$CANARIES_FILE"
)

HUMAN_OUT="$TMPDIR/human.out"
env "${COMMON_ENV[@]}" \
  "${PROJECT_ROOT}/modules/ghostroute-health-monitor/bin/egress-backend-health" >"$HUMAN_OUT"

assert_contains "$HUMAN_OUT" "managed egress backend bank: active=backup_reality"
assert_contains "$HUMAN_OUT" "rollup=degraded"
assert_contains "$HUMAN_OUT" "primary_vps"
assert_contains "$HUMAN_OUT" "backup_reality"
assert_contains "$HUMAN_OUT" "hermes_vps"
assert_contains "$HUMAN_OUT" "primary_vps"
assert_contains "$HUMAN_OUT" "OK       OK       WARN"
assert_contains "$HUMAN_OUT" "blocked-app  DEGRADED"
assert_contains "$HUMAN_OUT" "inactive backend TCP/TLS probes are advisory"

for secretish in primary.example.invalid backup.example.invalid hermes.example.invalid cover.example.invalid 198.51.100 203.0.113; do
  assert_not_contains "$HUMAN_OUT" "$secretish"
done

JSON_OUT="$TMPDIR/json.out"
env "${COMMON_ENV[@]}" \
  "${PROJECT_ROOT}/modules/ghostroute-health-monitor/bin/egress-backend-health" --json >"$JSON_OUT"

ruby -rjson - "$JSON_OUT" <<'RUBY'
path = ARGV.fetch(0)
j = JSON.parse(File.read(path))
raise "schema" unless j["schema_version"] == 1
raise "active" unless j["active_backend"] == "backup_reality"
raise "channel d" unless j["channel_d_backend"] == "follow"
raise "rollup" unless j["rollup"] == "degraded"
raise "backend rows" unless j["backend_bank"].length == 3
raise "canary rows" unless j["app_canaries"].length == 3
blocked = j["app_canaries"].find { |row| row["app"] == "blocked-app" }
raise "blocked-app degraded" unless blocked && blocked["status"] == "DEGRADED"
backup = j["backend_bank"].find { |row| row["role"] == "backup_reality" }
raise "backup active" unless backup && backup["active"] == true
primary = j["backend_bank"].find { |row| row["role"] == "primary_vps" }
raise "primary configured" unless primary && primary["configured"] == "OK"
raise "primary tcp" unless primary["tcp_status"] == "OK"
raise "primary tls" unless primary["tls_status"] == "WARN"
RUBY

for secretish in primary.example.invalid backup.example.invalid hermes.example.invalid cover.example.invalid 198.51.100 203.0.113; do
  assert_not_contains "$JSON_OUT" "$secretish"
done

echo "egress-backend-health fixture tests passed"
