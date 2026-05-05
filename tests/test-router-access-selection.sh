#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

STUB_BIN="${TMP_DIR}/bin"
mkdir -p "${STUB_BIN}"

cat >"${STUB_BIN}/route" <<'SH'
#!/bin/sh
if [ "$1" = "-n" ] && [ "$2" = "get" ] && [ "$3" = "default" ]; then
  printf 'gateway: 192.168.50.1\n'
  printf 'interface: %s\n' "${ROUTE_IFACE:-en0}"
  exit 0
fi
if [ "$1" = "-n" ] && [ "$2" = "get" ]; then
  printf 'interface: %s\n' "${ROUTE_IFACE:-en0}"
  exit 0
fi
exit 1
SH
chmod +x "${STUB_BIN}/route"

cat >"${STUB_BIN}/ifconfig" <<'SH'
#!/bin/sh
cat <<EOF
en0: flags=8863<UP,BROADCAST,RUNNING,SIMPLEX,MULTICAST>
        inet 192.168.50.20 netmask 0xffffff00 broadcast 192.168.50.255
utun4: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST>
        inet 192.168.50.30 --> 192.168.50.30 netmask 0xffffffff
EOF
SH
chmod +x "${STUB_BIN}/ifconfig"

cat >"${STUB_BIN}/nc" <<'SH'
#!/bin/sh
[ "${NC_SUCCESS:-1}" = "1" ]
SH
chmod +x "${STUB_BIN}/nc"

cat >"${STUB_BIN}/ssh" <<'SH'
#!/bin/sh
host=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -i|-p|-o)
      shift 2
      ;;
    *@*)
      host="${1#*@}"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

case " ${SSH_FAIL_HOSTS:-} " in
  *" $host "*) exit 255 ;;
esac
exit 0
SH
chmod +x "${STUB_BIN}/ssh"

ENV_FILE="${TMP_DIR}/router.env"
cat >"${ENV_FILE}" <<EOF
ROUTER=router.example.invalid
ROUTER_PORT=22022
ROUTER_WAN_PORT=22
ROUTER_USER=admin
ROUTER_ACCESS_MODE=auto
ROUTER_LAN=192.168.50.1
ROUTER_LAN_PORT=22
SSH_IDENTITY_FILE=${TMP_DIR}/router-key
SSH_KNOWN_HOSTS_FILE=${TMP_DIR}/known-hosts
CONNECT_TIMEOUT=5
EOF

run_case() (
  local route_iface="$1"
  local env_file="${2:-${ENV_FILE}}"
  local ssh_fail_hosts="${3:-}"

  export PATH="${STUB_BIN}:${PATH}"
  export ROUTE_IFACE="$route_iface"
  export NC_SUCCESS=1
  export SSH_FAIL_HOSTS="$ssh_fail_hosts"
  export GHOSTROUTE_ROUTER_ENV_FILE="$env_file"
  unset ROUTER_HEALTH_INIT_DONE ROUTER ROUTER_PORT ROUTER_WAN_PORT ROUTER_USER ROUTER_ACCESS_MODE ROUTER_LAN ROUTER_LAN_PORT
  unset SSH_IDENTITY_FILE SSH_KNOWN_HOSTS_FILE CONNECT_TIMEOUT SSH_OPTS

  # shellcheck source=/dev/null
  . "${PROJECT_ROOT}/modules/shared/lib/router-health-common.sh"
  router_health_load_env
  printf '%s|%s|' "$ROUTER" "$ROUTER_PORT"
  printf '%s\n' "${SSH_OPTS[*]}"
)

lan_result="$(run_case en0)"
if [[ "$lan_result" != 192.168.50.1\|22\|* ]]; then
  echo "Expected auto mode to use LAN:22 on a non-VPN route, got: $lan_result" >&2
  exit 1
fi

vpn_result="$(run_case utun4)"
if [[ "$vpn_result" != router.example.invalid\|22\|* ]]; then
  echo "Expected auto mode to use remote WAN SSH on a VPN route, got: $vpn_result" >&2
  exit 1
fi

vpn_fallback_result="$(run_case utun4 "${ENV_FILE}" router.example.invalid 2>/dev/null)"
if [[ "$vpn_fallback_result" != 192.168.50.1\|22\|* ]]; then
  echo "Expected auto mode to fall back to direct LAN when WAN SSH preflight fails, got: $vpn_fallback_result" >&2
  exit 1
fi

REMOTE_ENV_FILE="${TMP_DIR}/router-remote.env"
cp "${ENV_FILE}" "${REMOTE_ENV_FILE}"
printf '%s\n' 'ROUTER_ACCESS_MODE=remote' >>"${REMOTE_ENV_FILE}"
remote_result="$(run_case en0 "${REMOTE_ENV_FILE}")"
if [[ "$remote_result" != router.example.invalid\|22\|* ]]; then
  echo "Expected remote mode to force WAN SSH, got: $remote_result" >&2
  exit 1
fi

if [[ "$vpn_result" != *BatchMode=yes* ]] || [[ "$vpn_result" != *ConnectionAttempts=1* ]]; then
  echo "Expected non-interactive SSH options in router helper, got: $vpn_result" >&2
  exit 1
fi

echo "router access selection tests passed"
