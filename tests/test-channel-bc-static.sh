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

assert_path_absent() {
  local path="$1"
  if [ -e "${PROJECT_ROOT}/${path}" ]; then
    echo "Expected ${path} to be absent" >&2
    exit 1
  fi
}

assert_not_contains "ansible/playbooks/10-stealth-vps.yml" 'xray_xhttp|channel_c_home|Channel C'
assert_contains "ansible/playbooks/11-channel-b-vps.yml" 'xray_xhttp'
assert_contains "ansible/playbooks/11-channel-b-vps.yml" 'Channel B Caddy route is present'
assert_not_contains "ansible/playbooks/11-channel-b-vps.yml" 'xray_reality|channel_c_home|Channel C1'
assert_contains "ansible/playbooks/21-channel-b-router.yml" 'channel_b_home_relay'
assert_contains "ansible/playbooks/21-channel-b-router.yml" 'Deploy Channel B home-first XHTTP lane on router'
assert_not_contains "ansible/playbooks/21-channel-b-router.yml" 'channel_c|Channel C|NaiveProxy'
assert_path_absent "ansible/playbooks/12-channel-c-vps.yml"
assert_contains "ansible/playbooks/22-channel-c-router.yml" 'Deploy Channel C1 home-first Naive lane on router'
assert_contains "ansible/playbooks/22-channel-c-router.yml" 'channel_c_home_enabled'
assert_contains "ansible/playbooks/22-channel-c-router.yml" 'Refresh sing-box rule-sets after Channel C1 deploy'
assert_not_contains "ansible/playbooks/22-channel-c-router.yml" 'caddy_l4|xray_xhttp|channel_c_naive|squid|stunnel|tinyproxy'
assert_not_contains "ansible/playbooks/20-stealth-router.yml" 'xray_xhttp|channel_c|Channel C|NaiveProxy|XHTTP'
assert_not_contains "ansible/playbooks/20-stealth-router.yml" 'channel_b_home_relay'

assert_contains "ansible/roles/xray_xhttp/defaults/main.yml" 'channel_b_xhttp_enabled: false'
assert_contains "ansible/roles/xray_xhttp/defaults/main.yml" 'ghcr.io/xtls/xray-core:26\.3\.27'
assert_contains "ansible/roles/channel_b_home_relay/templates/config.json.j2" '"network": "xhttp"'
assert_contains "ansible/roles/channel_b_home_relay/templates/config.json.j2" '"tag": "channel-b-home-in"'
assert_contains "ansible/roles/channel_b_home_relay/templates/config.json.j2" '"tag": "channel-b-upstream-socks"'
assert_contains "ansible/roles/channel_b_home_relay/tasks/main.yml" 'xray-core'

assert_contains "ansible/roles/singbox_client/templates/config.json.j2" '"tag": "reality-in"'
assert_contains "ansible/roles/singbox_client/templates/config.json.j2" '"tag": "channel-b-relay-socks"'
assert_contains "ansible/roles/singbox_client/templates/config.json.j2" '"type": "naive"'
assert_contains "ansible/roles/singbox_client/templates/config.json.j2" '"tag": "channel-c-naive-in"'
assert_contains "ansible/roles/singbox_client/templates/config.json.j2" '"inbound": "channel-c-naive-in", "action": "sniff"'
assert_contains "ansible/roles/singbox_client/templates/config.json.j2" 'certificate_path'
assert_contains "ansible/roles/singbox_client/tasks/main.yml" 'Validate Channel C1 home Naive settings'
assert_contains "ansible/roles/singbox_client/tasks/main.yml" 'Require sing-box version with Naive inbound support for Channel C1'
assert_contains "ansible/roles/singbox_client/tasks/main.yml" 'channel_c_home_tls_cert_path'
assert_contains "ansible/group_vars/routers.yml" 'channel_c_home_enabled'
assert_contains "ansible/group_vars/routers.yml" 'channel_c_home_public_port'
assert_contains "ansible/group_vars/routers.yml" 'channel_c_home_tls_cert_path'
assert_contains "ansible/group_vars/vps_stealth.yml" 'Channel C is'
assert_not_contains "ansible/group_vars/vps_stealth.yml" 'channel_c_naive|channel-c-squid|channel-c-stunnel|channel-c-tinyproxy'

assert_contains "ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2" 'CHANNEL_B_HOME_PORT'
assert_contains "ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2" 'mobile-reality-channel-b-ingress'
assert_contains "ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2" 'CHANNEL_C_HOME_PUBLIC_PORT'
assert_contains "ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2" 'mobile-naive-channel-c-ingress'
assert_contains "ansible/roles/stealth_routing/templates/ghostroute-runtime.env.j2" 'GHOSTROUTE_CHANNEL_C_HOME_PORT'

assert_contains "ansible/roles/caddy_l4/templates/SystemCaddyfile.j2" 'protocols h1 h2'
assert_contains "ansible/roles/caddy_l4/templates/SystemCaddyfile.j2" 'matching_timeout \{\{ caddy_l4_matching_timeout'
assert_contains "ansible/roles/caddy_l4/templates/SystemCaddyfile.j2" 'reverse_proxy 127\.0\.0\.1:\{\{ channel_b_xhttp_local_port \}\}'
assert_contains "ansible/roles/caddy_l4/templates/SystemCaddyfile.j2" 'log channel_b_xhttp'
assert_not_contains "ansible/roles/caddy_l4/templates/SystemCaddyfile.j2" 'forward_proxy|channel_c_naive|channel-c-subscriptions|tinyproxy|squid|stunnel'
assert_not_contains "ansible/roles/caddy_l4/tasks/main.yml" 'channel_c_naive|channel-c-tinyproxy|channel-c-stunnel|channel-c-squid|forward_proxy|Squid|Tinyproxy|stunnel'
assert_not_contains "ansible/roles/caddy_l4/templates/Dockerfile.j2" 'forwardproxy|channel_c_naive'
assert_not_contains "ansible/roles/caddy_l4/handlers/main.yml" 'channel c|channel-c'
assert_path_absent "ansible/roles/caddy_l4/templates/channel-c-tinyproxy.conf.j2"
assert_path_absent "ansible/roles/caddy_l4/templates/channel-c-squid.conf.j2"
assert_path_absent "ansible/roles/caddy_l4/templates/channel-c-stunnel.conf.j2"

assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'clients-channel-b'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'clients-channel-c'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'Validate Channel C1 client profile fields'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'Render Channel C1 SFI sing-box full config'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" '"type": "naive"'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'channel_c_home_public_host'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'method=connect,tls=true'
assert_contains "ansible/playbooks/30-generate-client-profiles.yml" 'bypass-system = false'
assert_not_contains "ansible/playbooks/30-generate-client-profiles.yml" 'channel_c_naive|channel_c_https_proxy_url|shadowrocket-positional|shadowrocket-add|fields-host-port-user-pass|Channel C.*direct-VPS|direct-VPS.*Channel C'

assert_contains "ansible/playbooks/99-verify.yml" 'Channel B home ingress listener is running when enabled'
assert_contains "ansible/playbooks/99-verify.yml" 'Channel B home relay config is XHTTP ingress to local sing-box SOCKS when enabled'
assert_contains "ansible/playbooks/99-verify.yml" 'Channel C1 Naive ingress listener is running when enabled'
assert_contains "ansible/playbooks/99-verify.yml" 'sing-box has Channel C1 Naive inbound with managed split routing'
assert_not_contains "ansible/playbooks/99-verify.yml" 'channel_c_naive|channel-c-squid|channel-c-stunnel|forward_proxy'

assert_contains "modules/client-profile-factory/bin/client-profiles" 'channel-b-list'
assert_contains "modules/client-profile-factory/bin/client-profiles" 'channel-c-list'
assert_contains ".gitignore" 'clients-channel-b'
assert_contains ".gitignore" 'clients-channel-c'

assert_contains "README.md" 'Channel A'
assert_contains "README.md" 'Channel B'
assert_contains "README.md" 'Channel C'
assert_contains "README-ru.md" 'Channel A'
assert_contains "README-ru.md" 'Channel B'
assert_contains "README-ru.md" 'Channel C'
assert_contains "docs/architecture.md" 'Channel C1'
assert_contains "modules/client-profile-factory/docs/client-profiles.md" 'Channel C1 Home-First Naive'
assert_contains "modules/routing-core/docs/stealth-channel-implementation-guide.md" 'Channel C1'

echo "channel-b/c static tests passed"
