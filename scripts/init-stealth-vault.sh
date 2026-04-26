#!/bin/sh

set -eu

PROJECT_ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
SECRETS_DIR="${PROJECT_ROOT}/ansible/secrets"
SECRETS_FILE="${SECRETS_DIR}/stealth.yml"
VAULT_PASS_FILE="${HOME}/.vault_pass.txt"

force=0
encrypt=1
router_ip_override="${ROUTER_IP:-}"
vps_host_override="${VPS_SSH_HOST:-}"
vps_user_override="${VPS_SSH_USER:-deploy}"

while [ $# -gt 0 ]; do
  case "$1" in
    --force) force=1 ;;
    --no-encrypt) encrypt=0 ;;
    --router-ip)
      shift
      [ $# -gt 0 ] || {
        echo "Usage: $0 [--force] [--no-encrypt] [--router-ip <ip>] [--vps-host <host>] [--vps-user <user>]" >&2
        exit 1
      }
      router_ip_override="$1"
      ;;
    --vps-host)
      shift
      [ $# -gt 0 ] || {
        echo "Usage: $0 [--force] [--no-encrypt] [--router-ip <ip>] [--vps-host <host>] [--vps-user <user>]" >&2
        exit 1
      }
      vps_host_override="$1"
      ;;
    --vps-user)
      shift
      [ $# -gt 0 ] || {
        echo "Usage: $0 [--force] [--no-encrypt] [--router-ip <ip>] [--vps-host <host>] [--vps-user <user>]" >&2
        exit 1
      }
      vps_user_override="$1"
      ;;
    *)
      echo "Usage: $0 [--force] [--no-encrypt] [--router-ip <ip>] [--vps-host <host>] [--vps-user <user>]" >&2
      exit 1
      ;;
  esac
  shift
done

detect_router_ip() {
  if command -v netstat >/dev/null 2>&1; then
    netstat -rn 2>/dev/null | awk '
      $1 == "default" &&
      $2 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ &&
      $4 !~ /^(utun|wg|tailscale|tun|tap)/ {
        print $2
        exit
      }
    '
    return 0
  fi

  if command -v ip >/dev/null 2>&1; then
    ip route show default 2>/dev/null | awk '
      $1 == "default" &&
      $3 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ &&
      $5 !~ /^(wg|tailscale|tun|tap)/ {
        print $3
        exit
      }
    '
    return 0
  fi

  return 1
}

rand_hex() {
  openssl rand -hex "$1"
}

rand_b64() {
  openssl rand -base64 "$1" | tr -d '\n'
}

rand_uuid() {
  python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
}

[ -d "$SECRETS_DIR" ] || mkdir -p "$SECRETS_DIR"

if [ -f "$SECRETS_FILE" ] && [ "$force" -ne 1 ]; then
  echo "Refusing to overwrite existing $SECRETS_FILE (use --force)." >&2
  exit 1
fi

if [ ! -f "$VAULT_PASS_FILE" ]; then
  umask 077
  rand_b64 48 > "$VAULT_PASS_FILE"
fi
chmod 600 "$VAULT_PASS_FILE"

router_ip="${router_ip_override}"
[ -n "$router_ip" ] || router_ip="$(detect_router_ip || true)"
[ -n "$router_ip" ] || router_ip="<router_lan_ip>"
vps_host="${vps_host_override:-<vps_ip_or_dns_name>}"
vps_user="${vps_user_override:-deploy}"

xui_password="$(rand_b64 24)"
xui_web_path="/$(rand_hex 8)"
xui_web_port="${XUI_ADMIN_WEB_PORT:-<xui_admin_port>}"
xray_reality_port="${XRAY_REALITY_LISTEN_PORT:-<xray_reality_local_port>}"
singbox_redirect_port="${SINGBOX_REDIRECT_PORT:-<router_redirect_port>}"
singbox_socks_port="${SINGBOX_DNSCRYPT_SOCKS_PORT:-<router_socks_port>}"
dnscrypt_port="${DNSCRYPT_PORT:-<dnscrypt_port>}"
home_reality_ingress_port="${HOME_REALITY_INGRESS_PORT:-<home_reality_ingress_port>}"

tmp_file="$(mktemp)"
trap 'rm -f "$tmp_file"' EXIT

cat > "$tmp_file" <<EOF
# ===== VPS =====
vps_ssh_host: "${vps_host}"
vps_ssh_user: "${vps_user}"

# Existing shared Caddy/OpenClaw site values. Replace placeholders before deploy.
system_caddy_site_host: "openclaw.home.arpa"
system_caddy_site_upstream: "127.0.0.1:<existing_local_port>"
system_caddy_cert_file: "/etc/caddy/certs/openclaw-home-arpa-fullchain.pem"
system_caddy_key_file: "/etc/caddy/certs/openclaw-home-arpa-privkey.pem"
system_caddy_client_ca_file: "/etc/caddy/certs/<site>-access-ca.crt"

# ===== 3x-ui admin =====
xui_admin_username: "admin"
xui_admin_password: "${xui_password}"
xui_admin_web_path: "${xui_web_path}"
xui_admin_web_port: "${xui_web_port}"
vault_xray_reality_listen_port: "${xray_reality_port}"

# ===== Router local/private ports =====
vault_singbox_redirect_port: "${singbox_redirect_port}"
vault_singbox_dnscrypt_socks_port: "${singbox_socks_port}"
vault_dnscrypt_port: "${dnscrypt_port}"

# ===== Reality server =====
reality_dest: "gateway.icloud.com:443"
reality_server_names:
  - "gateway.icloud.com"
reality_server_private_key: ""
reality_server_public_key: ""
reality_short_ids:
  - ""

# ===== Home Reality ingress on ASUS =====
vault_home_reality_public_host: "myhome.asuscomm.com"
vault_home_reality_ingress_port: "${home_reality_ingress_port}"
home_reality_dest_host: "gateway.icloud.com"
home_reality_dest_port: 443
home_reality_server_private_key: ""
home_reality_server_public_key: ""
home_reality_server_short_ids:
  - ""

# Router-side mobile identities. Keep these different from clients[]; mobile
# clients should authenticate at the home Reality ingress, not at VPS.
home_clients:
  - name: "iphone-1"
    uuid: "$(rand_uuid)"
    short_id: ""
  - name: "iphone-2"
    uuid: "$(rand_uuid)"
    short_id: ""
  - name: "iphone-3"
    uuid: "$(rand_uuid)"
    short_id: ""
  - name: "iphone-4"
    uuid: "$(rand_uuid)"
    short_id: ""
  - name: "iphone-5"
    uuid: "$(rand_uuid)"
    short_id: ""
  - name: "iphone-6"
    uuid: "$(rand_uuid)"
    short_id: ""
  - name: "macbook"
    uuid: "$(rand_uuid)"
    short_id: ""

# ===== Clients =====
# VPS-side Reality identities. Keep only the router here; mobile identities
# live in home_clients[] and are relayed through the home router.
clients:
  - name: "router"
    uuid: "$(rand_uuid)"
    short_id: ""
    email: "router@home.lan"

# ===== Router =====
router_ssh_host: "${router_ip}"
router_ssh_user: "admin"
EOF

cp "$tmp_file" "$SECRETS_FILE"

if [ "$encrypt" -eq 1 ]; then
  ANSIBLE_VAULT_PASSWORD_FILE="$VAULT_PASS_FILE" ansible-vault encrypt "$SECRETS_FILE"
fi

echo "Created $SECRETS_FILE"
echo "Vault password file: $VAULT_PASS_FILE"
echo "Detected router IP: ${router_ip}"
echo "VPS host: ${vps_host}"
echo "xui_admin_web_path: ${xui_web_path}"
if [ "$vps_host" = "<vps_ip_or_dns_name>" ]; then
  echo "Warning: edit vps_ssh_host in ansible/secrets/stealth.yml before deploy."
fi
if [ "$encrypt" -eq 0 ]; then
  echo "Warning: file left unencrypted because --no-encrypt was used."
fi
