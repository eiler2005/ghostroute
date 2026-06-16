#!/bin/bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

assert_contains() {
  local path="$1"
  local pattern="$2"
  if ! rg -n -- "$pattern" "${PROJECT_ROOT}/${path}" >/dev/null; then
    echo "Expected ${path} to contain pattern: ${pattern}" >&2
    exit 1
  fi
}

assert_contains_fixed() {
  local path="$1"
  local needle="$2"
  if ! rg -n -F -- "$needle" "${PROJECT_ROOT}/${path}" >/dev/null; then
    echo "Expected ${path} to contain text: ${needle}" >&2
    exit 1
  fi
}

assert_not_contains() {
  local path="$1"
  local pattern="$2"
  if rg -n -- "$pattern" "${PROJECT_ROOT}/${path}" >/dev/null; then
    echo "Expected ${path} not to contain pattern: ${pattern}" >&2
    rg -n -- "$pattern" "${PROJECT_ROOT}/${path}" >&2
    exit 1
  fi
}

assert_contains "ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2" 'ipset create "\$IPSET" hash:ip'
assert_not_contains "ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2" 'ipset create "\$IPSET" hash:net'

assert_contains "modules/routing-core/router/firewall-start" "grep '\\^add STEALTH_DOMAINS '"
assert_contains "modules/routing-core/router/firewall-start" 'ipset save includes a create line'
assert_not_contains "modules/routing-core/router/firewall-start" 'ipset restore -! < "\$STATE_FILE"'

assert_contains "modules/dns-catalog-intelligence/router/update-blocked-list.sh" '--proxy "\$SOCKS_PROXY"'
assert_contains "modules/dns-catalog-intelligence/router/update-blocked-list.sh" '\|\| curl -sf --max-time "\$MAX_TIME"'

assert_contains "ansible/roles/stealth_routing/tasks/main.yml" 'Install managed routing-core boot hooks'
assert_contains "ansible/roles/stealth_routing/tasks/main.yml" 'firewall-start'
assert_contains "ansible/roles/stealth_routing/tasks/main.yml" 'cron-save-ipset'
assert_contains "ansible/roles/stealth_routing/tasks/main.yml" 'services-start'
assert_contains "ansible/roles/stealth_routing/tasks/main.yml" 'Install Channel A static CIDR catalog'
assert_contains "ansible/roles/stealth_routing/tasks/main.yml" 'Install DNS catalog intelligence scripts'
assert_contains "ansible/roles/stealth_routing/tasks/main.yml" 'Install managed routing-core boot hooks'
assert_contains "ansible/roles/stealth_routing/tasks/main.yml" 'ghostroute-runtime-supervisor'
assert_contains "ansible/roles/stealth_routing/tasks/main.yml" 'Refresh blocked-domain cache opportunistically'
assert_contains "ansible/roles/singbox_client/tasks/main.yml" 'Install sing-box log rotation helper'
assert_not_contains "ansible/roles/singbox_client/tasks/main.yml" 'RotateSingBoxLog'
assert_contains "ansible/roles/singbox_client/tasks/main.yml" 'Validate managed egress mode before rendering config'
assert_contains "ansible/roles/singbox_client/tasks/main.yml" 'Validate backup Reality managed egress settings'
assert_contains "ansible/roles/singbox_client/tasks/main.yml" 'Validate Hermes owned managed egress settings'
assert_contains "ansible/roles/singbox_client/tasks/main.yml" 'Validate Channel A selected full-VPS settings'
assert_contains "ansible/roles/singbox_client/templates/config.json.j2" "managed_egress_mode == 'backup_reality'"
assert_contains "ansible/roles/singbox_client/templates/config.json.j2" "managed_egress_mode == 'hermes_vps'"
assert_contains "ansible/roles/singbox_client/templates/config.json.j2" '"tag": "reality-out"'
assert_contains_fixed "ansible/roles/singbox_client/templates/config.json.j2" '"server": "{{ router_hermes_vps_host }}"'
assert_contains_fixed "ansible/roles/singbox_client/templates/config.json.j2" '"uuid": "{{ (clients | selectattr('
assert_contains_fixed "ansible/roles/singbox_client/templates/config.json.j2" '"public_key": "{{ reality_server_public_key }}"'
assert_contains_fixed "ansible/roles/singbox_client/templates/config.json.j2" '"server": "{{ selected_vps_dns_host }}"'
assert_contains_fixed "ansible/roles/singbox_client/templates/config.json.j2" 'set selected_vps_dns_host = router_hermes_vps_unbound_target_host'
assert_contains_fixed "ansible/roles/singbox_client/templates/config.json.j2" 'set use_cover_dns ='
assert_contains_fixed "ansible/roles/singbox_client/templates/config.json.j2" "router_hermes_dns_mode | default('managed_vps_dns') == 'cover_dns'"
assert_contains "ansible/roles/singbox_client/templates/config.json.j2" '"type": "tproxy"'
assert_contains "ansible/roles/singbox_client/templates/config.json.j2" 'channel-a-selected-lan-full-vps-in'
assert_contains_fixed "ansible/roles/singbox_client/templates/config.json.j2" '"auth_user": {{ selected_full_vps_home_users | to_json }}'
assert_contains "ansible/group_vars/routers.yml" 'router_managed_egress_mode'
assert_contains "ansible/group_vars/routers.yml" 'router_backup_reality_server'
assert_contains "ansible/group_vars/routers.yml" 'router_hermes_vps_host'
assert_contains "ansible/inventory/stealth.yml" 'vps_egress_hermes'
assert_contains "ansible/playbooks/12-hermes-egress-vps.yml" 'xray_reality_seed_existing_material: true'
assert_contains "ansible/playbooks/12-hermes-egress-vps.yml" 'xray_reality_persist_generated_secrets: false'
assert_contains "ansible/roles/ufw_stealth/tasks/main.yml" 'Allow inbound SSH before enabling UFW'
assert_contains "ansible/roles/ufw_stealth/tasks/main.yml" 'Enable UFW after GhostRoute allow rules are present'
assert_contains "ansible/roles/ufw_stealth/defaults/main.yml" 'ufw_stealth_manage_ssh_allow: false'
assert_contains "ansible/playbooks/12-hermes-egress-vps.yml" 'ufw_stealth_manage_ssh_allow: true'
assert_contains "ansible/playbooks/12-hermes-egress-vps.yml" 'ufw_stealth_enable_firewall: true'
assert_contains "modules/routing-core/bin/managed-egress-mode" 'VALID_MODES="primary_vps backup_reality hermes_vps"'
assert_contains "modules/routing-core/bin/managed-egress-mode" 'Channel A/B/C'
assert_contains "modules/routing-core/bin/managed-egress-mode" 'Channel D and Channel M are not switched'
assert_contains_fixed "modules/routing-core/bin/managed-egress-mode" '--skip-deploy-gate'
assert_contains "modules/routing-core/bin/managed-egress-mode" 'ghostroute_skip_deploy_gate=true'
assert_contains "modules/routing-core/README.md" 'managed-egress-mode status|set'
assert_contains "ansible/README.md" 'managed-egress-mode set backup_reality --deploy-router'
assert_contains "docs/operational-modules.md" 'modules/routing-core/bin/managed-egress-mode'
assert_contains_fixed "ansible/group_vars/routers.yml" 'channel_a_selected_full_vps_enabled: "{{ vault_channel_a_selected_full_vps_enabled | default(false) }}"'
assert_contains "ansible/group_vars/routers.yml" 'GR_A_FULL_VPS'
assert_contains_fixed "ansible/group_vars/routers.yml" 'channel_a_selected_full_vps_fwmark: "{{ vault_channel_a_selected_full_vps_fwmark | default'
assert_contains_fixed "ansible/group_vars/routers.yml" "default('0x4100')"
assert_contains_fixed "ansible/group_vars/routers.yml" 'channel_a_selected_full_vps_route_table: "{{ vault_channel_a_selected_full_vps_route_table | default(410) }}"'
assert_contains "ansible/secrets/stealth.yml.example" 'vault_router_managed_egress_mode'
assert_contains "ansible/secrets/stealth.yml.example" 'vault_router_hermes_vps_host'
assert_contains "docs/managed-egress-failover-roadmap.md" 'Implemented Manual Reserve Mode'
assert_contains "docs/managed-egress-failover-roadmap.md" 'hermes_vps'
assert_contains "docs/channel-a-selected-full-vps.md" 'Full-VPS is a selected set policy'
assert_contains "modules/ghostroute-health-monitor/bin/managed-egress-check" 'primary_tls'
assert_contains "modules/ghostroute-health-monitor/bin/managed-egress-check" 'hermes_tls'
assert_contains "modules/ghostroute-health-monitor/bin/managed-egress-check" 'active_managed_app'
assert_contains "modules/ghostroute-health-monitor/README.md" 'managed-egress-check'
assert_contains "modules/ghostroute-health-monitor/docs/stealth-monitor-runbook.md" 'managed-egress-check'
assert_contains "modules/routing-core/router/ghostroute-runtime-supervisor" 'RotateSingBoxLog'
assert_not_contains "modules/routing-core/router/services-start" 'RotateSingBoxLog'
assert_contains "deploy.sh" 'rotate-singbox-log'
assert_contains "ansible/playbooks/20-stealth-router.yml" 'Refresh sing-box rule-sets after catalog deploy'
assert_contains "ansible/playbooks/20-stealth-router.yml" 'update-singbox-rule-sets.sh --restart-if-changed'
assert_contains "configs/dnsmasq-stealth.conf.add" 'ipset=/googleapis.com/STEALTH_DOMAINS'
assert_contains "ansible/scripts/validate-sni-candidate.sh" '2\\[0-9\\]\\[0-9\\]\\|3\\[0-9\\]\\[0-9\\]\\|400\\|401\\|403'
assert_contains "ansible/playbooks/99-verify.yml" 'VPS Reality cover SNI matches Vault'
assert_contains "ansible/playbooks/99-verify.yml" 'Router-side Reality ingress cover SNI matches router config'
assert_contains "ansible/roles/xray_reality/defaults/main.yml" 'xray_reality_seed_existing_material: false'
assert_contains "ansible/roles/xray_reality/defaults/main.yml" 'xray_reality_persist_generated_secrets: true'
assert_contains "ansible/roles/xray_reality/defaults/main.yml" 'xray_reality_docker_network_subnet: ""'
assert_contains "ansible/roles/xray_reality/templates/docker-compose.yml.j2" 'xray_reality_docker_network_subnet'
assert_contains "ansible/roles/xray_reality/tasks/main.yml" 'csrf-token'
assert_contains "ansible/roles/xray_reality/tasks/main.yml" 'X-CSRF-Token'
assert_contains "ansible/roles/xray_reality/tasks/seed_reality.yml" 'X-CSRF-Token'
assert_contains "ansible/playbooks/12-hermes-egress-vps.yml" 'vps_unbound_docker_bridge_host: 172.22.0.1'
assert_contains "ansible/playbooks/12-hermes-egress-vps.yml" 'Set Hermes owned-egress runtime facts after Vault load'
assert_contains "ansible/playbooks/12-hermes-egress-vps.yml" 'Stop Hermes stealth stack before Docker network CIDR change'
assert_contains "ansible/playbooks/12-hermes-egress-vps.yml" 'stealth_caddy_mode: docker_sidecar'
assert_contains "ansible/playbooks/12-hermes-egress-vps.yml" 'vps_unbound_reality_listen_host: ""'
assert_contains_fixed "ansible/playbooks/12-hermes-egress-vps.yml" 'vps_unbound_reality_target_host: "{{ vps_unbound_docker_bridge_host }}"'
assert_contains "ansible/secrets/stealth.yml.example" 'vault_router_hermes_vps_unbound_target_host: "172.22.0.1"'
assert_contains "docs/managed-egress-failover-roadmap.md" 'Do not bind Unbound to the public VPS address'
assert_contains "ansible/roles/xray_reality/tasks/main.yml" 'xray_reality_seed_existing_material'
assert_contains "ansible/roles/xray_reality/tasks/main.yml" 'Probe 3x-ui CSRF token endpoints'
assert_contains "ansible/roles/xray_reality/tasks/seed_reality.yml" 'Reuse configured Reality private key for a new clone inbound'
assert_contains "ansible/roles/xray_reality/tasks/seed_reality.yml" 'Sync existing clone Reality private key and short IDs'
assert_contains "ansible/roles/xray_reality/tasks/seed_reality.yml" 'xray_reality_persist_generated_secrets'
assert_contains "ansible/roles/vps_unbound/tasks/main.yml" 'systemctl reset-failed unbound'
assert_contains "ansible/roles/stealth_routing/tasks/main.yml" 'Install Channel A selected full-VPS dnsmasq policy'
assert_contains_fixed "ansible/roles/stealth_routing/templates/channel-a-selected-full-vps-dnsmasq.conf.j2" 'dhcp-option=tag:{{ channel_a_selected_full_vps_dnsmasq_tag'
assert_contains_fixed "ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2" 'FULL_VPS_MARK={{ channel_a_selected_full_vps_fwmark'
assert_contains "ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2" 'modprobe xt_TPROXY'
assert_contains "ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2" 'ip rule add fwmark "\$FULL_VPS_MARK" table "\$FULL_VPS_TABLE"'
assert_contains "ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2" '-j TPROXY --on-port "\$FULL_VPS_TPROXY_PORT" --tproxy-mark "\$FULL_VPS_MARK"'
assert_contains_fixed "ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2" 'ipset add "$FULL_VPS_IPSET" "{{ client.ip }}" -exist'
assert_contains_fixed "ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2" 'for DNS_LOCAL_CIDR in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do'
assert_contains_fixed "ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2" '-d "$DNS_LOCAL_CIDR" -p udp --dport 53 -j TPROXY --on-port "$FULL_VPS_TPROXY_PORT" --tproxy-mark "$FULL_VPS_MARK"'
assert_contains_fixed "ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2" '-d "$DNS_LOCAL_CIDR" -p tcp --dport 53 -j TPROXY --on-port "$FULL_VPS_TPROXY_PORT" --tproxy-mark "$FULL_VPS_MARK"'
assert_not_contains "ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2" '--dport 53 -j DROP'
assert_contains_fixed "ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2" '-i br0 -m set --match-set "$FULL_VPS_IPSET" src -j RETURN'
assert_contains_fixed "ansible/roles/singbox_client/templates/config.json.j2" '"override_address": "{{ (channel_a_selected_full_vps_dns_servers | default([]) | first) }}"'
assert_contains_fixed "ansible/roles/singbox_client/templates/config.json.j2" '{ "inbound": "{{ channel_a_selected_full_vps_inbound_tag | default('\''channel-a-selected-lan-full-vps-in'\'') }}", "port": 53, "outbound": "reality-out" }'

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
for i in 1 2 3 4 5 6 7 8 9 10; do
  printf 'line-%s payload payload payload payload payload\n' "$i"
done > "$TMPDIR/sing-box.log"
SINGBOX_LOG_PATH="$TMPDIR/sing-box.log" \
SINGBOX_LOG_MAX_BYTES=100 \
SINGBOX_LOG_KEEP_LINES=3 \
SINGBOX_LOG_ARCHIVE_DIR="$TMPDIR/archive" \
SINGBOX_LOG_MIN_FREE_KB=0 \
  "$PROJECT_ROOT/modules/routing-core/router/rotate-singbox-log"
if grep -F 'line-1 ' "$TMPDIR/sing-box.log" >/dev/null 2>&1; then
  echo "Expected rotate-singbox-log to truncate old log head" >&2
  exit 1
fi
grep -F 'line-8 ' "$TMPDIR/sing-box.log" >/dev/null
grep -F 'line-10 ' "$TMPDIR/sing-box.log" >/dev/null

auth_user_line="$(rg -n -F '"auth_user": {{ selected_full_vps_home_users | to_json }}' "$PROJECT_ROOT/ansible/roles/singbox_client/templates/config.json.j2" | head -1 | cut -d: -f1)"
managed_split_line="$(rg -n -F '"inbound": "reality-in", "rule_set": ["stealth-domains", "stealth-static"]' "$PROJECT_ROOT/ansible/roles/singbox_client/templates/config.json.j2" | head -1 | cut -d: -f1)"
if [ -z "$auth_user_line" ] || [ -z "$managed_split_line" ] || [ "$auth_user_line" -ge "$managed_split_line" ]; then
  echo "Expected Channel A selected full-VPS auth_user rule before the normal Home Reality managed split" >&2
  exit 1
fi

echo "channel-a deploy static tests passed"
