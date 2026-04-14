#!/bin/bash

set -euo pipefail

# Загружаем персональные переменные из локального secrets-файла.
# Рекомендуемый путь: secrets/router.env
# Для обратной совместимости поддерживается и .env.
_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "${_SCRIPT_DIR}/secrets/router.env" ] && set -a && . "${_SCRIPT_DIR}/secrets/router.env" && set +a
[ -f "${_SCRIPT_DIR}/.env" ] && set -a && . "${_SCRIPT_DIR}/.env" && set +a
unset _SCRIPT_DIR

ROUTER_USER="${ROUTER_USER:-admin}"
ROUTER_PORT="${ROUTER_PORT:-22}"
CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-5}"
ROUTER="${ROUTER:-}"
SSH_IDENTITY_FILE="${SSH_IDENTITY_FILE:-${HOME}/.ssh/id_rsa}"
SSH_OPTS=(
  -i "$SSH_IDENTITY_FILE"
  -p "$ROUTER_PORT"
  -o ConnectTimeout="$CONNECT_TIMEOUT"
  -o IdentitiesOnly=yes
  -o PubkeyAcceptedAlgorithms=+ssh-rsa
  -o StrictHostKeyChecking=accept-new
)

detect_router_ip() {
  if [ -n "$ROUTER" ]; then
    printf '%s\n' "$ROUTER"
    return 0
  fi

  if command -v route >/dev/null 2>&1; then
    route -n get default 2>/dev/null | awk '/gateway:/ { print $2; exit }'
    return 0
  fi

  if command -v ip >/dev/null 2>&1; then
    ip route show default 2>/dev/null | awk '/default/ { print $3; exit }'
    return 0
  fi

  return 1
}

ROUTER="$(detect_router_ip)"
if [ -z "$ROUTER" ]; then
  echo "Could not detect router IP automatically. Set ROUTER=<ip> and retry." >&2
  exit 1
fi

ssh "${SSH_OPTS[@]}" "${ROUTER_USER}@${ROUTER}" 'sh -s' <<'REMOTE'
set -eu

echo "== Router =="
nvram get productid 2>/dev/null || true
nvram get buildno 2>/dev/null || true
nvram get extendno 2>/dev/null || true

echo
echo "== Capabilities =="
if which opkg >/dev/null 2>&1; then
  opkg --version | head -n 1
else
  echo "Entware: not detected"
fi
which ipset >/dev/null 2>&1 && echo "ipset: ok" || echo "ipset: missing"
which iptables >/dev/null 2>&1 && echo "iptables: ok" || echo "iptables: missing"

echo
echo "== Routing =="
ip rule show | grep -E '0x1000|to 1\.1\.1\.1|to 9\.9\.9\.9' || echo "routing rules not found"
ip route show table wgc1 || true

echo
echo "== IPSet =="
ipset list VPN_DOMAINS 2>/dev/null || echo "VPN_DOMAINS not found"
echo
ipset list VPN_STATIC_NETS 2>/dev/null || echo "VPN_STATIC_NETS not found"

echo
echo "== DNS Fill Test =="
nslookup google.com 127.0.0.1 >/dev/null 2>&1 || true
ipset list VPN_DOMAINS 2>/dev/null | sed -n '1,80p' || true
REMOTE
