#!/bin/bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

assert_contains() {
  local path="$1"
  local pattern="$2"
  if ! rg -n "$pattern" "${PROJECT_ROOT}/${path}" >/dev/null; then
    echo "Expected ${path} to contain pattern: ${pattern}" >&2
    exit 1
  fi
}

assert_not_contains_fixed() {
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
FIREWALL_TEMPLATE="ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2"
VERIFY="ansible/playbooks/99-verify.yml"

assert_contains "ansible/group_vars/routers.yml" 'channel_m_maxtg_enabled'
assert_contains "ansible/group_vars/routers.yml" 'channel_m_maxtg_allowed_source_cidrs'
assert_contains "ansible/group_vars/routers.yml" 'channel_m_maxtg_tls_cert_path'
assert_contains "ansible/group_vars/routers.yml" 'channel_m_maxtg_clients'
assert_contains "ansible/group_vars/routers.yml" 'channel_m_maxtg_reverse_enabled'
assert_contains "ansible/group_vars/routers.yml" 'channel_m_maxtg_reverse_listen_port'

assert_contains "$SINGBOX_TEMPLATE" '"tag": "channel-m-maxtg-max-egress"'
assert_contains "$SINGBOX_TEMPLATE" '"tag": "channel-m-maxtg-reverse-egress"'
assert_contains "$SINGBOX_TEMPLATE" '"type": "http"'
assert_contains "$SINGBOX_TEMPLATE" 'channel_m_maxtg_tls_cert_path'
assert_compact_contains "$SINGBOX_TEMPLATE" '"inbound":"channel-m-maxtg-max-egress","outbound":"direct-out"'
assert_compact_contains "$SINGBOX_TEMPLATE" '"inbound":"channel-m-maxtg-reverse-egress","outbound":"direct-out"'
assert_not_contains_fixed "$SINGBOX_TEMPLATE" '"inbound": "channel-m-maxtg-max-egress", "rule_set"'
assert_not_contains_fixed "$SINGBOX_TEMPLATE" '"inbound": "channel-m-maxtg-max-egress", "outbound": "reality-out"'
assert_not_contains_fixed "$SINGBOX_TEMPLATE" '"inbound": "channel-m-maxtg-reverse-egress", "rule_set"'
assert_not_contains_fixed "$SINGBOX_TEMPLATE" '"inbound": "channel-m-maxtg-reverse-egress", "outbound": "reality-out"'

assert_contains "$FIREWALL_TEMPLATE" 'CHANNEL_M_MAXTG_ENABLED'
assert_contains "$FIREWALL_TEMPLATE" 'channel_m_maxtg_allowed_source_cidrs'
assert_contains "$FIREWALL_TEMPLATE" 'channel-m-maxtg-allow'
assert_contains "$FIREWALL_TEMPLATE" 'channel-m-maxtg-deny'
assert_contains "$FIREWALL_TEMPLATE" 'CHANNEL_M_MAXTG_PUBLIC_PORT'
assert_contains "$FIREWALL_TEMPLATE" 'CHANNEL_M_MAXTG_PORT'
assert_contains "$FIREWALL_TEMPLATE" 'REDIRECT --to-ports'

assert_contains "$VERIFY" 'Channel M maxtg MAX egress listener is running when enabled'
assert_contains "$VERIFY" 'Channel M maxtg public port redirects to dedicated ingress port'
assert_contains "$VERIFY" 'Channel M maxtg ingress is source allowlisted by INPUT firewall'
assert_contains "$VERIFY" 'sing-box has Channel M HTTP inbound with direct-only routing'
assert_contains "$VERIFY" 'Channel M reverse listener is bound on the VPS docker bridge'
assert_contains "$VERIFY" 'Channel M reverse tunnel cron watchdog is installed when enabled'
assert_contains "$VERIFY" 'sing-box has Channel M reverse HTTP inbound with direct-only routing'

assert_contains "ansible/playbooks/23-channel-m-reverse.yml" 'channel-m-reverse-firewall.service'
assert_contains "ansible/playbooks/23-channel-m-reverse.yml" 'channel-m-reverse-firewall.timer'
assert_contains "ansible/playbooks/23-channel-m-reverse.yml" 'GatewayPorts clientspecified'

assert_contains "configs/runtime-inventory.yml" 'channel_m_maxtg_public'
assert_contains "configs/runtime-inventory.yml" 'channel_m_maxtg_ingress'
assert_contains "configs/runtime-inventory.yml" 'channel_m_maxtg_reverse_ingress'
assert_contains "configs/runtime-inventory.yml" 'channel_m_maxtg_reverse_vps_listener'
assert_contains "ansible/roles/stealth_routing/templates/ghostroute-runtime.env.j2" 'GHOSTROUTE_CHANNEL_M_MAXTG_PORT'
assert_contains "ansible/roles/stealth_routing/templates/ghostroute-runtime.env.j2" 'GHOSTROUTE_CHANNEL_M_MAXTG_REVERSE_PORT'

assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'channel_m_out_dir'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'MAX_EGRESS_PROXY_URL=http://'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'MAX_EGRESS_PROXY_URL=https://'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'MAX_EGRESS_PROXY_HOST='
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'channel_m_artifacts_only'
assert_contains "modules/client-profile-factory/bin/client-profiles" 'channel-m-list'
assert_contains "modules/client-profile-factory/docs/client-profiles.md" 'Channel M maxtg Service Egress Artifact'
assert_contains "docs/channel-m-environment.md" 'channel-m-maxtg-reverse-egress -> direct-out'
assert_contains "docs/channel-m-environment.md" 'channel_m_maxtg_reverse_listen_port'
assert_contains "docs/channel-m-environment.md" 'No public home inbound port is required'
assert_contains "docs/channels.md" 'channel-m-environment.md'
assert_contains ".gitignore" '/ansible/out/channel-m-maxtg/*'

echo "channel-m static tests passed"
