#!/bin/bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

assert_contains() {
  local path="$1"
  local needle="$2"
  if ! rg -n -F -- "$needle" "${PROJECT_ROOT}/${path}" >/dev/null; then
    echo "Expected ${path} to contain text: ${needle}" >&2
    exit 1
  fi
}

assert_not_contains() {
  local path="$1"
  local needle="$2"
  if rg -n -F -- "$needle" "${PROJECT_ROOT}/${path}" >/dev/null; then
    echo "Expected ${path} not to contain text: ${needle}" >&2
    rg -n -F -- "$needle" "${PROJECT_ROOT}/${path}" >&2
    exit 1
  fi
}

assert_compact_contains() {
  local path="$1"
  local needle="$2"
  local compact
  compact="$(tr -d '[:space:]' < "${PROJECT_ROOT}/${path}")"
  if ! grep -F -- "$needle" >/dev/null <<<"$compact"; then
    echo "Expected ${path} compact form to contain text: ${needle}" >&2
    exit 1
  fi
}

SINGBOX_TEMPLATE="ansible/roles/singbox_client/templates/config.json.j2"
RULESET_SCRIPT="modules/routing-core/router/update-singbox-rule-sets.sh"
ROUTER_TASKS="ansible/roles/stealth_routing/tasks/main.yml"
DNSCRYPT_TASKS="ansible/roles/dnscrypt_proxy/tasks/main.yml"
VERIFY="ansible/playbooks/99-verify.yml"

assert_contains "ansible/group_vars/routers.yml" "router_dns_egress_mode"
assert_contains "ansible/group_vars/routers.yml" "router_vps_dns_forward_port"
assert_contains "ansible/group_vars/routers.yml" "router_vps_dnsmasq_conf_path"
assert_contains "ansible/group_vars/routers.yml" "vps_unbound_reality_target_host"
assert_contains "ansible/group_vars/vps_stealth.yml" "vps_unbound_enabled"
assert_contains "ansible/group_vars/vps_stealth.yml" "vps_unbound_docker_bridge_host"
assert_contains "ansible/group_vars/vps_stealth.yml" "vps_unbound_reality_listen_host"
assert_contains "ansible/group_vars/vps_stealth.yml" "vps_unbound_xray_allow_port"
assert_contains "ansible/playbooks/10-stealth-vps.yml" "vps_unbound"
assert_contains "ansible/roles/xray_reality/tasks/main.yml" "Persist Xray template route for private VPS Unbound endpoint"
assert_contains "ansible/roles/xray_reality/tasks/main.yml" "geoip:private"
assert_contains "ansible/roles/vps_unbound/templates/ghostroute-unbound.conf.j2" "interface: {{ vps_unbound_listen_host }}"
assert_contains "ansible/roles/vps_unbound/templates/ghostroute-unbound.conf.j2" "interface: {{ vps_unbound_docker_bridge_host }}"
assert_contains "ansible/roles/vps_unbound/templates/ghostroute-unbound.conf.j2" "interface: {{ vps_unbound_reality_listen_host }}"
assert_contains "ansible/roles/vps_unbound/templates/ghostroute-unbound.conf.j2" "port: {{ vps_unbound_listen_port }}"
assert_contains "ansible/roles/vps_unbound/templates/ghostroute-unbound.conf.j2" "access-control: {{ vps_unbound_docker_bridge_cidr }} allow"
assert_contains "ansible/roles/vps_unbound/templates/ghostroute-unbound.conf.j2" "access-control: 0.0.0.0/0 allow"
assert_contains "ansible/roles/ufw_stealth/tasks/main.yml" "Deny public DNS on VPS"
assert_contains "ansible/roles/ufw_stealth/tasks/main.yml" "Allow Xray Docker bridge to reach VPS Unbound policy resolver"

assert_contains "$ROUTER_TASKS" "conf-file={{ router_vps_dnsmasq_conf_path }}"
assert_contains "$DNSCRYPT_TASKS" "Keep default dnsmasq upstream in policy-split DNS mode"
assert_contains "$DNSCRYPT_TASKS" "^no-resolv$"
assert_contains "$RULESET_SCRIPT" "DNSMASQ_VPS_DNS_CONF"
assert_contains "$RULESET_SCRIPT" "filter_vps_dns_domains"
assert_contains "$RULESET_SCRIPT" "server=/%s/%s#%s"
assert_contains "$RULESET_SCRIPT" "return domain ~ /(^|[.])(ru|su|рф)$/"

assert_contains "$SINGBOX_TEMPLATE" '"tag": "vps-dns-in"'
assert_contains "$SINGBOX_TEMPLATE" '"tag": "vps-dns-server"'
assert_contains "$SINGBOX_TEMPLATE" '"action": "hijack-dns"'
assert_compact_contains "$SINGBOX_TEMPLATE" '"inbound":"vps-dns-in","action":"hijack-dns"'
for inbound in reality-in channel-b-relay-socks channel-c-naive-in channel-c-shadowrocket-http-in; do
  assert_compact_contains "$SINGBOX_TEMPLATE" "\"inbound\":\"${inbound}\",\"port\":53,\"action\":\"route-options\",\"override_address\":\"127.0.0.1\",\"override_port\":53"
  assert_compact_contains "$SINGBOX_TEMPLATE" "\"inbound\":\"${inbound}\",\"port\":53,\"outbound\":\"direct-out\""
done
assert_not_contains "$SINGBOX_TEMPLATE" '"port": [53, 853]'

assert_contains "$VERIFY" "VPS Unbound resolver listens only on private hosts when enabled"
assert_contains "$VERIFY" "Xray permits only the private VPS Unbound endpoint before private-IP block"
assert_contains "$VERIFY" "Managed DNS include sends BrowserLeaks DNS to VPS forwarder"
assert_contains "$VERIFY" "RU and direct domains are absent from managed VPS DNS include"
assert_contains "$VERIFY" "Router-side Reality ingress sends plain DNS to router-local dnsmasq"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
mkdir -p "$TMPDIR/rules"
cat > "$TMPDIR/manual.conf" <<'EOF_MANUAL'
ipset=/browserleaks.com/STEALTH_DOMAINS
ipset=/browserleaks.net/STEALTH_DOMAINS
ipset=/browserleaks.org/STEALTH_DOMAINS
ipset=/openai.com/STEALTH_DOMAINS
ipset=/4pda.ru/STEALTH_DOMAINS
ipset=/vtb.ru/STEALTH_DOMAINS
ipset=/championat.com/STEALTH_DOMAINS
EOF_MANUAL
: > "$TMPDIR/auto.conf"
: > "$TMPDIR/static.txt"

MANUAL_DNSMASQ="$TMPDIR/manual.conf" \
AUTO_DNSMASQ="$TMPDIR/auto.conf" \
DOMAINS_NO_VPN="${PROJECT_ROOT}/configs/domains-no-vpn.txt" \
STATIC_NETS="$TMPDIR/static.txt" \
SINGBOX_RULE_DIR="$TMPDIR/rules" \
DNSMASQ_VPS_DNS_CONF="$TMPDIR/vps-dns.conf" \
  "${PROJECT_ROOT}/${RULESET_SCRIPT}" --no-restart >/dev/null

rg -n -F 'server=/browserleaks.com/127.0.0.1#15353' "$TMPDIR/vps-dns.conf" >/dev/null
rg -n -F 'server=/browserleaks.net/127.0.0.1#15353' "$TMPDIR/vps-dns.conf" >/dev/null
rg -n -F 'server=/browserleaks.org/127.0.0.1#15353' "$TMPDIR/vps-dns.conf" >/dev/null
rg -n -F 'server=/openai.com/127.0.0.1#15353' "$TMPDIR/vps-dns.conf" >/dev/null
if rg -n -F 'server=/4pda.ru/' "$TMPDIR/vps-dns.conf" >/dev/null ||
   rg -n -F 'server=/vtb.ru/' "$TMPDIR/vps-dns.conf" >/dev/null ||
   rg -n -F 'server=/championat.com/' "$TMPDIR/vps-dns.conf" >/dev/null; then
  echo "direct/RU domains leaked into VPS DNS include" >&2
  sed -n '1,160p' "$TMPDIR/vps-dns.conf" >&2
  exit 1
fi

echo "dns policy split static tests passed"
