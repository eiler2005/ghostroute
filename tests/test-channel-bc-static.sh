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

assert_not_contains() {
  local path="$1"
  local pattern="$2"
  if rg -n "$pattern" "${PROJECT_ROOT}/${path}" >/dev/null; then
    echo "Expected ${path} not to contain pattern: ${pattern}" >&2
    rg -n "$pattern" "${PROJECT_ROOT}/${path}" >&2
    exit 1
  fi
}

assert_contains "ansible/playbooks/10-stealth-vps.yml" 'xray_xhttp'
assert_not_contains "ansible/playbooks/20-stealth-router.yml" 'xray_xhttp|channel_c|Channel C|NaiveProxy|XHTTP'

assert_contains "ansible/roles/xray_xhttp/defaults/main.yml" 'channel_b_xhttp_enabled: false'
assert_contains "ansible/roles/xray_xhttp/defaults/main.yml" 'ghcr.io/xtls/xray-core:26\.3\.27'
assert_contains "ansible/roles/xray_xhttp/defaults/main.yml" 'channel_b_xhttp_block_udp_443: false'
assert_contains "ansible/roles/xray_xhttp/tasks/main.yml" 'channel_b_xhttp_listen == .127\.0\.0\.1.'
assert_contains "ansible/roles/xray_xhttp/tasks/main.yml" 'channel_b_xhttp_mode == .packet-up.'
assert_contains "ansible/roles/xray_xhttp/templates/config.json.j2" '"network": "udp"'
assert_contains "ansible/roles/xray_xhttp/templates/config.json.j2" '"port": "443"'

assert_contains "ansible/roles/caddy_l4/templates/SystemCaddyfile.j2" 'protocols h1 h2'
assert_contains "ansible/roles/caddy_l4/templates/SystemCaddyfile.j2" 'matching_timeout \{\{ caddy_l4_matching_timeout'
assert_contains "ansible/roles/caddy_l4/templates/SystemCaddyfile.j2" 'forward_proxy'
assert_contains "ansible/roles/caddy_l4/templates/SystemCaddyfile.j2" 'reverse_proxy 127\.0\.0\.1:\{\{ channel_c_naive_tinyproxy_local_port'
assert_contains "ansible/roles/caddy_l4/templates/SystemCaddyfile.j2" 'channel_c_naive_hide_ip_enabled'
assert_contains "ansible/roles/caddy_l4/templates/SystemCaddyfile.j2" 'channel_c_naive_hide_via_enabled'
assert_contains "ansible/roles/caddy_l4/templates/SystemCaddyfile.j2" 'channel_c_naive_probe_resistance_enabled'
assert_contains "ansible/roles/caddy_l4/templates/SystemCaddyfile.j2" 'Padding'
assert_contains "ansible/roles/caddy_l4/templates/SystemCaddyfile.j2" 'Transfer-Encoding'
assert_contains "ansible/roles/caddy_l4/tasks/main.yml" 'channel_c_naive_backend'
assert_contains "ansible/roles/caddy_l4/tasks/main.yml" 'channel-c-tinyproxy'
assert_contains "ansible/roles/caddy_l4/tasks/main.yml" 'channel-c-stunnel'
assert_contains "ansible/roles/caddy_l4/tasks/main.yml" 'channel-c-squid'
assert_contains "ansible/roles/caddy_l4/templates/channel-c-tinyproxy.conf.j2" 'BasicAuth'
assert_contains "ansible/roles/caddy_l4/templates/channel-c-tinyproxy.service.j2" 'tinyproxy -d -c /etc/tinyproxy/channel-c\.conf'
assert_contains "ansible/roles/caddy_l4/templates/channel-c-squid.conf.j2" 'basic_ncsa_auth'
assert_contains "ansible/roles/caddy_l4/templates/channel-c-squid.conf.j2" 'https_port'
assert_contains "ansible/roles/caddy_l4/tasks/main.yml" 'channel-c-tls\.crt'
assert_contains "ansible/roles/caddy_l4/templates/channel-c-squid.conf.j2" 'acl SSL_ports port 5228'
assert_contains "ansible/roles/caddy_l4/templates/channel-c-squid.service.j2" 'squid -N -f /etc/squid/channel-c\.conf'
assert_contains "ansible/roles/caddy_l4/templates/channel-c-stunnel.conf.j2" 'stunnel'
assert_contains "ansible/roles/caddy_l4/templates/channel-c-stunnel.conf.j2" 'channel_c_naive_squid_local_port'
assert_contains "ansible/roles/caddy_l4/templates/channel-c-stunnel.service.j2" 'stunnel4 /etc/stunnel/channel-c\.conf'
assert_contains "ansible/roles/caddy_l4/templates/SystemCaddyfile.j2" 'reverse_proxy 127\.0\.0\.1:\{\{ channel_b_xhttp_local_port \}\}'
assert_contains "ansible/roles/caddy_l4/templates/SystemCaddyfile.j2" 'log channel_b_xhttp'
assert_contains "ansible/roles/caddy_l4/templates/SystemCaddyfile.j2" 'log channel_c_naive'
assert_contains "ansible/roles/caddy_l4/templates/SystemCaddyfile.j2" 'output stdout'
assert_contains "ansible/roles/caddy_l4/tasks/main.yml" 'vpn\|proxy\|xray\|xhttp\|naive'

assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'clients-channel-b'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'clients-channel-c'
assert_contains "ansible/group_vars/vps_stealth.yml" 'channel_c_naive_clients'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" '\{\{ item.name \}\}\.txt'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'outbound-only JSON'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'Render Channel C NaiveProxy URL for each named client'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'naive\+\{\{ channel_c_https_proxy_url \}\}'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'Render Channel C HTTPS proxy compatibility URL for each named client'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'Render Channel C Shadowrocket HTTPS proxy URL for each named client'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'Render Channel C Shadowrocket add-node URL for each named client'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'shadowrocket://add/'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'Render Channel C Shadowrocket field import variants for each named client'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'fields-host-port-user-pass'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'fields-user-pass-host-port'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'method=connect'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'plugin=none'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'Render Channel C Shadowrocket HTTPS proxy config for each named client'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'Render Channel C Shadowrocket config QR PNG for each named client'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'Render Channel C Shadowrocket positional HTTPS proxy config for each named client'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'Render Channel C Shadowrocket positional config QR PNG for each named client'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" '\[Proxy\]'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'tls=true'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'method=connect, tls=true'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'bypass-system = false'
assert_contains "modules/client-profile-factory/docs/client-profiles.md" 'shadowrocket-positional\.conf'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'Render Channel C sing-box Naive outbound JSON for each named client'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" '"type": "naive"'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" ':443'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" '#\{\{ item.name \}\}-naive'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'noalpn'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'h1'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'host=\{\{ channel_b_xhttp_public_host \}\}'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'alpn=h2'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'mode=\{\{ channel_b_xhttp_mode'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" '"mode": \{\{ channel_b_xhttp_mode'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" "replace\\('/', '%2F'\\)"
assert_contains "modules/client-profile-factory/bin/client-profiles" 'channel-b-list'
assert_contains "modules/client-profile-factory/bin/client-profiles" 'channel-b-open'
assert_contains "modules/client-profile-factory/bin/client-profiles" 'channel-b-clean'
assert_contains "modules/client-profile-factory/bin/client-profiles" 'channel-c-list'
assert_contains "modules/client-profile-factory/bin/client-profiles" 'channel-c-open'
assert_contains "modules/client-profile-factory/bin/client-profiles" 'channel-c-clean'
assert_contains ".gitignore" 'clients-channel-b'
assert_contains ".gitignore" 'clients-channel-c'

assert_contains "README.md" 'Channel A'
assert_contains "README.md" 'Channel B'
assert_contains "README.md" 'Channel C'
assert_contains "README-ru.md" 'Channel A'
assert_contains "README-ru.md" 'Channel B'
assert_contains "README-ru.md" 'Channel C'
assert_contains "docs/architecture.md" 'Channel A'
assert_contains "docs/architecture.md" 'Channel B'
assert_contains "docs/architecture.md" 'Channel C'
assert_contains "modules/client-profile-factory/docs/client-profiles.md" 'Channel B XHTTP Manual Fallback Profiles'
assert_contains "modules/client-profile-factory/docs/client-profiles.md" 'Channel C NaiveProxy Manual Fallback Profile'
assert_contains "modules/routing-core/docs/stealth-channel-implementation-guide.md" 'Channel B manual clients'
assert_contains "modules/routing-core/docs/stealth-channel-implementation-guide.md" 'Channel C manual clients'

echo "channel-b/c static tests passed"
