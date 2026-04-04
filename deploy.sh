#!/bin/bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Загружаем персональные переменные из .env, если он есть.
# .env добавлен в .gitignore и не попадает в git.
# Шаблон: .env.example
[ -f "${PROJECT_ROOT}/.env" ] && set -a && . "${PROJECT_ROOT}/.env" && set +a

ROUTER_USER="${ROUTER_USER:-admin}"
ROUTER_PORT="${ROUTER_PORT:-22}"
CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-5}"
ROUTER="${ROUTER:-}"
SSH_IDENTITY_FILE="${SSH_IDENTITY_FILE:-${HOME}/.ssh/id_rsa}"
ENABLE_DNSMASQ_LOGGING="${ENABLE_DNSMASQ_LOGGING:-1}"
REMOTE_STAGE="/tmp/router_configuration.$$"
SSH_OPTS=(
  -i "$SSH_IDENTITY_FILE"
  -p "$ROUTER_PORT"
  -o ConnectTimeout="$CONNECT_TIMEOUT"
  -o IdentitiesOnly=yes
  -o PubkeyAcceptedAlgorithms=+ssh-rsa
  -o StrictHostKeyChecking=accept-new
)
SCP_OPTS=(
  -O
  -i "$SSH_IDENTITY_FILE"
  -P "$ROUTER_PORT"
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

require_local_file() {
  local file_path="$1"
  [ -f "$file_path" ] || {
    echo "Missing required file: $file_path" >&2
    exit 1
  }
}

router_has_port() {
  local port="$1"
  nc -z -w "$CONNECT_TIMEOUT" "$ROUTER" "$port" >/dev/null 2>&1
}

ssh_cmd() {
  ssh "${SSH_OPTS[@]}" "${ROUTER_USER}@${ROUTER}" "$@"
}

upload_file() {
  local source_path="$1"
  local target_path="$2"
  scp "${SCP_OPTS[@]}" "$source_path" "${ROUTER_USER}@${ROUTER}:${target_path}"
}

ROUTER="$(detect_router_ip)"
if [ -z "$ROUTER" ]; then
  echo "Could not detect router IP automatically. Set ROUTER=<ip> and retry." >&2
  exit 1
fi

require_local_file "${PROJECT_ROOT}/configs/dnsmasq.conf.add"
require_local_file "${PROJECT_ROOT}/configs/dnsmasq-vpn-upstream.conf.add"
require_local_file "${PROJECT_ROOT}/configs/static-networks.txt"
require_local_file "${PROJECT_ROOT}/configs/no-vpn-ip-ports.txt"
require_local_file "${PROJECT_ROOT}/scripts/firewall-start"
require_local_file "${PROJECT_ROOT}/scripts/nat-start"
require_local_file "${PROJECT_ROOT}/scripts/cron-save-ipset"
require_local_file "${PROJECT_ROOT}/scripts/services-start"
if [ "${ENABLE_DNSMASQ_LOGGING}" = "1" ]; then
  require_local_file "${PROJECT_ROOT}/configs/dnsmasq-logging.conf.add"
fi

echo "Router: ${ROUTER}"
echo "SSH target: ${ROUTER_USER}@${ROUTER}:${ROUTER_PORT}"

if ! router_has_port "$ROUTER_PORT"; then
  echo "SSH port ${ROUTER_PORT} is not reachable on ${ROUTER}." >&2
  if router_has_port 80 || router_has_port 8443; then
    echo "The router web UI is reachable, so the device is online." >&2
    echo "Enable SSH in the ASUS admin UI before running deploy.sh." >&2
    echo "Path: Administration -> System -> Enable SSH" >&2
  fi
  exit 1
fi

ssh_cmd "mkdir -p '${REMOTE_STAGE}/configs' '${REMOTE_STAGE}/scripts' /jffs/configs /jffs/scripts"

upload_file "${PROJECT_ROOT}/configs/dnsmasq.conf.add" "${REMOTE_STAGE}/configs/dnsmasq.conf.add"
upload_file "${PROJECT_ROOT}/configs/dnsmasq-vpn-upstream.conf.add" "${REMOTE_STAGE}/configs/dnsmasq-vpn-upstream.conf.add"
upload_file "${PROJECT_ROOT}/configs/static-networks.txt" "${REMOTE_STAGE}/configs/static-networks.txt"
upload_file "${PROJECT_ROOT}/configs/no-vpn-ip-ports.txt" "${REMOTE_STAGE}/configs/no-vpn-ip-ports.txt"
upload_file "${PROJECT_ROOT}/scripts/firewall-start" "${REMOTE_STAGE}/scripts/firewall-start"
upload_file "${PROJECT_ROOT}/scripts/nat-start" "${REMOTE_STAGE}/scripts/nat-start"
upload_file "${PROJECT_ROOT}/scripts/cron-save-ipset" "${REMOTE_STAGE}/scripts/cron-save-ipset"
upload_file "${PROJECT_ROOT}/scripts/services-start" "${REMOTE_STAGE}/scripts/services-start"
upload_file "${PROJECT_ROOT}/scripts/domain-auto-add.sh" "${REMOTE_STAGE}/scripts/domain-auto-add.sh"
upload_file "${PROJECT_ROOT}/scripts/update-blocked-list.sh" "${REMOTE_STAGE}/scripts/update-blocked-list.sh"
upload_file "${PROJECT_ROOT}/configs/domains-no-vpn.txt" "${REMOTE_STAGE}/configs/domains-no-vpn.txt"
if [ "${ENABLE_DNSMASQ_LOGGING}" = "1" ]; then
  upload_file "${PROJECT_ROOT}/configs/dnsmasq-logging.conf.add" "${REMOTE_STAGE}/configs/dnsmasq-logging.conf.add"
fi

ssh_cmd "REMOTE_STAGE='${REMOTE_STAGE}' ENABLE_DNSMASQ_LOGGING='${ENABLE_DNSMASQ_LOGGING}' sh -s" <<'REMOTE'
set -eu

timestamp="$(date +%Y%m%d%H%M%S)"

backup_if_present() {
  target="$1"
  if [ -f "$target" ]; then
    cp "$target" "${target}.bak.${timestamp}"
  fi
}

merge_managed_block() {
  source_file="$1"
  target_file="$2"
  marker_name="$3"
  strip_shebang="${4:-0}"

  start_marker="# BEGIN ${marker_name}"
  end_marker="# END ${marker_name}"
  base_tmp="/tmp/router_configuration.base.$$"
  source_tmp="/tmp/router_configuration.source.$$"

  if [ -f "$target_file" ]; then
    awk -v start="$start_marker" -v end="$end_marker" '
      $0 == start { skip = 1; next }
      $0 == end { skip = 0; next }
      !skip { print }
    ' "$target_file" > "$base_tmp"
  else
    : > "$base_tmp"
  fi

  if [ "$strip_shebang" = "1" ]; then
    sed '1{/^#!/d;}' "$source_file" > "$source_tmp"
  else
    cp "$source_file" "$source_tmp"
  fi

  {
    cat "$base_tmp"
    if [ -s "$base_tmp" ]; then
      printf '\n'
    fi
    printf '%s\n' "$start_marker"
    cat "$source_tmp"
    printf '\n%s\n' "$end_marker"
  } > "${target_file}.new"

  mv "${target_file}.new" "$target_file"
  rm -f "$base_tmp" "$source_tmp"
}

install_script() {
  source_file="$1"
  target_file="$2"
  marker_name="$3"

  if [ -f "$target_file" ]; then
    backup_if_present "$target_file"
    merge_managed_block "$source_file" "$target_file" "$marker_name" 1
  else
    cp "$source_file" "$target_file"
  fi

  chmod a+rx "$target_file"
}

backup_if_present /jffs/configs/dnsmasq.conf.add
merge_managed_block \
  "$REMOTE_STAGE/configs/dnsmasq.conf.add" \
  /jffs/configs/dnsmasq.conf.add \
  "router_configuration dnsmasq.conf.add"

merge_managed_block \
  "$REMOTE_STAGE/configs/dnsmasq-vpn-upstream.conf.add" \
  /jffs/configs/dnsmasq.conf.add \
  "router_configuration dnsmasq-vpn-upstream.conf.add"

rm -f /jffs/configs/dnsmasq-vpn-upstream.conf.add

backup_if_present /jffs/configs/router_configuration.static_nets
cp "$REMOTE_STAGE/configs/static-networks.txt" /jffs/configs/router_configuration.static_nets

backup_if_present /jffs/configs/router_configuration.no_vpn_ip_ports
cp "$REMOTE_STAGE/configs/no-vpn-ip-ports.txt" /jffs/configs/router_configuration.no_vpn_ip_ports

install_script \
  "$REMOTE_STAGE/scripts/firewall-start" \
  /jffs/scripts/firewall-start \
  "router_configuration firewall-start"

install_script \
  "$REMOTE_STAGE/scripts/nat-start" \
  /jffs/scripts/nat-start \
  "router_configuration nat-start"

install_script \
  "$REMOTE_STAGE/scripts/cron-save-ipset" \
  /jffs/scripts/cron-save-ipset \
  "router_configuration cron-save-ipset"

install_script \
  "$REMOTE_STAGE/scripts/services-start" \
  /jffs/scripts/services-start \
  "router_configuration services-start"

mkdir -p /jffs/addons/x3mRouting
cp "$REMOTE_STAGE/scripts/domain-auto-add.sh" /jffs/addons/x3mRouting/domain-auto-add.sh
chmod +x /jffs/addons/x3mRouting/domain-auto-add.sh
cp "$REMOTE_STAGE/scripts/update-blocked-list.sh" /jffs/addons/x3mRouting/update-blocked-list.sh
chmod +x /jffs/addons/x3mRouting/update-blocked-list.sh
cp "$REMOTE_STAGE/configs/domains-no-vpn.txt" /jffs/configs/domains-no-vpn.txt

if [ "${ENABLE_DNSMASQ_LOGGING:-1}" = "1" ]; then
  mkdir -p /opt/var/log
  merge_managed_block \
    "$REMOTE_STAGE/configs/dnsmasq-logging.conf.add" \
    /jffs/configs/dnsmasq.conf.add \
    "router_configuration dnsmasq-logging"
fi

sh /jffs/scripts/nat-start
sh /jffs/scripts/firewall-start
sh /jffs/scripts/services-start
service restart_dnsmasq

if ! ip route show table wgc1 | grep -q '.'; then
  echo "Warning: routing table wgc1 is empty. Ensure the WGC1 client is connected." >&2
fi

rm -rf "$REMOTE_STAGE"
REMOTE

echo "Deployment complete. Run ./verify.sh to validate the router state."
