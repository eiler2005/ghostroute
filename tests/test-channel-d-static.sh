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
  local pattern="$2"
  if ! rg -n -F -- "$pattern" "${PROJECT_ROOT}/${path}" >/dev/null; then
    echo "Expected ${path} to contain fixed string: ${pattern}" >&2
    exit 1
  fi
}

assert_not_contains() {
  local path="$1"
  local pattern="$2"
  if rg -n "$pattern" "${PROJECT_ROOT}/${path}" >/dev/null; then
    echo "Expected ${path} not to contain pattern: ${pattern}" >&2
    rg -n "$pattern" "${PROJECT_ROOT}/${path}" >&2
    exit 1
  fi
}

assert_contains_fixed "ansible/group_vars/routers.yml" 'channel_d_naiveproxy_enabled: "{{ vault_channel_d_naiveproxy_enabled | default(false) }}"'
assert_contains_fixed "ansible/group_vars/routers.yml" 'channel_d_naiveproxy_profiles_enabled: "{{ vault_channel_d_naiveproxy_profiles_enabled | default(channel_d_naiveproxy_enabled, true) }}"'
assert_contains_fixed "ansible/group_vars/routers.yml" 'channel_d_naiveproxy_public_port: "{{ vault_channel_d_naiveproxy_public_port | default(4444, true) }}"'
assert_contains "ansible/group_vars/routers.yml" 'channel_d_naiveproxy_upstream_socks_port'
assert_contains "ansible/group_vars/routers.yml" 'channel_d_naiveproxy_local_binary_path'

assert_contains "ansible/playbooks/24-channel-d-router.yml" 'Deploy or remove Channel D router-native NaiveProxy lab'
assert_contains "ansible/playbooks/24-channel-d-router.yml" 'channel_d_naiveproxy'
assert_contains "ansible/playbooks/24-channel-d-router.yml" 'Build the Channel D Caddy binary first'
assert_contains "ansible/playbooks/24-channel-d-router.yml" 'channel-d-naiveproxy-socks-in|channel_d_naiveproxy_upstream_socks_port'
assert_contains "ansible/playbooks/24-channel-d-router.yml" 'GhostRoute runtime supervisor'
assert_not_contains "ansible/playbooks/24-channel-d-router.yml" 'ChannelMReverse managed by ansible'
assert_not_contains "ansible/playbooks/24-channel-d-router.yml" 'caddy_l4|xray_xhttp|vps_stealth'

assert_contains "ansible/roles/channel_d_naiveproxy/templates/Caddyfile.j2" 'forward_proxy'
assert_contains_fixed "ansible/roles/channel_d_naiveproxy/templates/Caddyfile.j2" 'upstream socks5://127.0.0.1:{{ channel_d_naiveproxy_upstream_socks_port }}'
assert_contains "ansible/roles/channel_d_naiveproxy/templates/Caddyfile.j2" 'probe_resistance'
assert_contains_fixed "ansible/roles/channel_d_naiveproxy/tasks/main.yml" 'The site is available.'
assert_not_contains "ansible/roles/channel_d_naiveproxy/tasks/main.yml" '<title>.*(GhostRoute|Naive|Karing|Proxy)|<h1>.*(GhostRoute|Naive|Karing|Proxy)'
assert_contains "ansible/roles/channel_d_naiveproxy/templates/S99caddy-channel-d-naiveproxy.j2" 'caddy-channel-d-naiveproxy'
assert_contains "ansible/roles/channel_d_naiveproxy/tasks/main.yml" 'Remove legacy Channel D services-start bootstrap'
assert_not_contains "ansible/roles/channel_d_naiveproxy/tasks/main.yml" 'Ensure services-start hook starts Channel D Caddy'
assert_contains_fixed "modules/routing-core/bin/build-channel-d-caddy" 'github.com/caddyserver/forwardproxy=github.com/klzgrad/forwardproxy@d62c80d3dd2c706b6b87579844d2397bddd18317'
assert_not_contains "modules/routing-core/bin/build-channel-d-caddy" 'github.com/caddyserver/forwardproxy=github.com/klzgrad/forwardproxy@naive'

assert_contains "ansible/roles/singbox_client/templates/config.json.j2" '"tag": "channel-d-naiveproxy-socks-in"'
assert_contains "ansible/roles/singbox_client/templates/config.json.j2" '"listen": "127.0.0.1"'
assert_contains_fixed "ansible/roles/singbox_client/templates/config.json.j2" '"inbound": "channel-d-naiveproxy-socks-in", "rule_set": ["stealth-domains", "stealth-static"], "outbound": "{{ d_out }}"'
assert_contains_fixed "ansible/roles/singbox_client/templates/config.json.j2" '"inbound": "channel-d-naiveproxy-socks-in", "outbound": "direct-out"'
assert_contains "ansible/roles/singbox_client/tasks/main.yml" 'Validate Channel D NaiveProxy sing-box relay settings'
assert_contains "ansible/roles/singbox_client/tasks/main.yml" 'opkg list-installed'

# Channel D independent managed egress selector (reality-out-d canary lane).
assert_contains_fixed "ansible/roles/singbox_client/templates/config.json.j2" "set d_mode = channel_d_managed_egress_mode | default('follow')"
assert_contains_fixed "ansible/roles/singbox_client/templates/config.json.j2" 'set d_effective_mode = managed_egress_mode if d_mode'
assert_contains_fixed "ansible/roles/singbox_client/templates/config.json.j2" "set d_out = 'reality-out' if d_mode == 'follow' else 'reality-out-d'"
assert_contains_fixed "ansible/roles/singbox_client/templates/config.json.j2" 'macro reality_outbound_body(mode)'
assert_contains_fixed "ansible/roles/singbox_client/templates/config.json.j2" '"tag": "reality-out-d"'
assert_contains_fixed "ansible/roles/singbox_client/templates/config.json.j2" "if d_mode != 'follow'"
assert_contains_fixed "ansible/roles/singbox_client/templates/config.json.j2" 'reality_outbound_body(d_effective_mode)'
assert_contains_fixed "ansible/group_vars/routers.yml" "channel_d_managed_egress_mode: \"{{ vault_channel_d_managed_egress_mode | default('follow') }}\""
assert_contains_fixed "ansible/secrets/stealth.yml.example" 'vault_channel_d_managed_egress_mode: "follow"'
assert_contains_fixed "ansible/roles/singbox_client/tasks/main.yml" "channel_d_managed_egress_mode | default('follow') in ['follow', 'primary_vps', 'backup_reality', 'hermes_vps']"
assert_contains_fixed "ansible/roles/singbox_client/tasks/main.yml" "channel_d_managed_egress_mode | default('follow') == 'hermes_vps'"
assert_contains_fixed "ansible/roles/singbox_client/tasks/main.yml" "channel_d_managed_egress_mode | default('follow') == 'backup_reality'"
assert_contains_fixed "modules/routing-core/bin/managed-egress-mode" 'D_MODES="follow primary_vps backup_reality hermes_vps"'
assert_contains_fixed "modules/routing-core/bin/managed-egress-mode" '--channel'
assert_contains "modules/routing-core/bin/managed-egress-mode" 'vault_channel_d_managed_egress_mode'
assert_contains "modules/routing-core/bin/managed-egress-mode" '24-channel-d-router.yml'

# Operator verify commands at parity with Channel A/B/C: live-check channel-d + managed-egress-check D selector.
assert_contains_fixed "modules/ghostroute-health-monitor/bin/live-check" 'channel-d|d)'
assert_contains_fixed "modules/ghostroute-health-monitor/bin/live-check" 'all|channel-a|channel-b|channel-c|channel-d'
assert_contains "modules/ghostroute-health-monitor/bin/live-check" 'split_ok_d'
assert_contains "modules/ghostroute-health-monitor/bin/live-check" 'channel_d_chain'
assert_contains "modules/ghostroute-health-monitor/bin/live-check" 'GHOSTROUTE_CHANNEL_D_NAIVEPROXY_SOCKS_PORT'
assert_contains_fixed "modules/ghostroute-health-monitor/bin/live-check" 'reality-out(-d)?'
assert_contains "modules/ghostroute-health-monitor/bin/managed-egress-check" 'active_mode_d'
assert_contains "modules/ghostroute-health-monitor/bin/managed-egress-check" 'vault_channel_d_managed_egress_mode'

assert_contains "ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2" 'CHANNEL_D_NAIVEPROXY_PUBLIC_PORT'
assert_contains "ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2" 'mobile-naiveproxy-channel-d-ingress'
assert_contains "ansible/roles/stealth_routing/templates/ghostroute-runtime.env.j2" 'GHOSTROUTE_CHANNEL_D_NAIVEPROXY_PORT'

assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'clients-channel-d'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'channel_d_profile_generation_enabled'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'channel_d_naiveproxy_karing_trial_enabled'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'example.invalid'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'karing-trial'
assert_contains_fixed "ansible/playbooks/30-generate-client-profiles.yml" 'Validate Channel D live Karing profile host is a TLS hostname'
assert_contains_fixed "ansible/playbooks/30-generate-client-profiles.yml" 'Live Channel D Karing artifacts require a TLS hostname, not a numeric IP'
assert_contains_fixed "ansible/playbooks/30-generate-client-profiles.yml" 'naive+https://'
assert_contains_fixed "ansible/playbooks/30-generate-client-profiles.yml" 'karing://install-config?url={{ channel_d_client_url | urlencode }}&name={{ channel_d_client_remark | urlencode }}'
assert_contains_fixed "ansible/playbooks/30-generate-client-profiles.yml" '-channel-d-karing.txt'
assert_contains_fixed "ansible/playbooks/30-generate-client-profiles.yml" 'Remark: <code>{{ client.name }}-channel-d</code>'
assert_contains_fixed "ansible/playbooks/30-generate-client-profiles.yml" 'cert common name invalid'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'channel_d_clients_only'
assert_contains "modules/client-profile-factory/bin/client-profiles" 'channel-d-list'
assert_contains ".gitignore" 'clients-channel-d'
assert_contains ".gitignore" 'channel-d-naiveproxy'

assert_contains "ansible/playbooks/99-verify.yml" 'Channel D NaiveProxy Caddy listener is running when enabled'
assert_contains "ansible/playbooks/99-verify.yml" 'Channel D Caddy cover site responds to ordinary TLS GET when enabled'
assert_contains "ansible/playbooks/99-verify.yml" 'Channel D unauthenticated CONNECT is not an open proxy when enabled'
assert_contains "ansible/playbooks/99-verify.yml" 'sing-box has Channel D NaiveProxy SOCKS inbound with managed split routing'
assert_contains_fixed "ansible/playbooks/99-verify.yml" "channel_d_out=\"{{ 'reality-out' if (channel_d_managed_egress_mode | default('follow')) == 'follow' else 'reality-out-d' }}\""
assert_contains_fixed "ansible/playbooks/99-verify.yml" '\"outbound\":\"$channel_d_out\"'
assert_contains "ansible/playbooks/99-verify.yml" 'forward_proxy'
assert_contains "ansible/roles/stealth_routing/templates/ghostroute-runtime.env.j2" 'GHOSTROUTE_CHANNEL_D_NAIVEPROXY_SOCKS_PORT'
assert_contains "modules/ghostroute-health-monitor/bin/status" 'proof expects channel-d-naiveproxy-socks-in -> reality-out/direct-out'
assert_contains "modules/shared/lib/router-health-common.sh" 'CHANNEL_D_NAIVEPROXY_COVER_SITE'
assert_contains "configs/runtime-inventory.yml" 'router_channel_d_caddy_naiveproxy'
assert_contains "configs/runtime-inventory.yml" 'channel_d_naiveproxy_public_port'
assert_contains "configs/runtime-inventory.yml" 'channel_d_naiveproxy_upstream_socks_port'
assert_contains "docs/runtime-inventory.md" 'Channel D is represented as an experimental router-native Caddy'
assert_contains "docs/deployment-and-rollback.md" '24-channel-d-router.yml'
assert_contains_fixed "docs/channel-d.md" 'cert common name invalid'
assert_contains_fixed "docs/channel-d.md" 'GhostRoute Console was not updated for Channel D'
assert_contains_fixed "docs/future-improvements-backlog.md" 'Channel D Console integration debt'
assert_contains_fixed "docs/ghostroute-console-post-mvp-roadmap.md" 'Channel D Console Integration Debt'

assert_not_contains "ansible/roles/caddy_l4/templates/SystemCaddyfile.j2" 'channel_d|Channel D|channel-d'
assert_not_contains "ansible/roles/caddy_l4/tasks/main.yml" 'channel_d|Channel D|channel-d|forward_proxy'
assert_contains_fixed "ansible/group_vars/routers.yml" 'channel_c_home_public_port: "{{ vault_channel_c_home_public_port | default(443, true) }}"'
assert_contains_fixed "ansible/group_vars/routers.yml" 'channel_c_shadowrocket_public_port: "{{ vault_channel_c_shadowrocket_public_port | default(4443, true) }}"'

echo "channel-d static tests passed"
