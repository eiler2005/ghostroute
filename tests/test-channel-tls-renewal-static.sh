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

assert_not_contains() {
  local path="$1"
  local pattern="$2"
  if rg -n -- "$pattern" "${PROJECT_ROOT}/${path}" >/dev/null; then
    echo "Expected ${path} not to contain pattern: ${pattern}" >&2
    exit 1
  fi
}

TLS_SYNC="modules/routing-core/router/channel-c-tls-sync.sh"
ACME_RENEW="modules/routing-core/router/channel-c-acme-renew.sh"
SUPERVISOR="modules/routing-core/router/ghostroute-runtime-supervisor"

sh -n "${PROJECT_ROOT}/${TLS_SYNC}"
sh -n "${PROJECT_ROOT}/${ACME_RENEW}"
sh -n "${PROJECT_ROOT}/${SUPERVISOR}"

assert_contains "ansible/group_vars/routers.yml" 'channel_c_home_tls_source'
assert_contains "ansible/group_vars/routers.yml" 'channel_c_home_asus_acme_cert_path'
assert_contains "ansible/group_vars/routers.yml" 'channel_d_naiveproxy_tls_source'
assert_contains "ansible/secrets/stealth.yml.example" 'vault_channel_c_home_tls_source: "asus_acme"'
assert_contains "ansible/roles/singbox_client/tasks/main.yml" 'Install Channel C1 TLS material from ASUS ACME'
assert_contains "ansible/roles/singbox_client/tasks/main.yml" 'checkend 0'
assert_contains "ansible/roles/channel_d_naiveproxy/tasks/main.yml" 'Install Channel D TLS material from ASUS ACME'
assert_contains "ansible/roles/channel_d_naiveproxy/tasks/main.yml" 'checkend 0'
assert_contains "ansible/roles/stealth_routing/tasks/main.yml" 'channel-c-tls-sync.sh'
assert_contains "ansible/roles/stealth_routing/tasks/main.yml" 'channel-c-acme-renew.sh'
assert_contains "ansible/roles/stealth_routing/templates/ghostroute-runtime.env.j2" 'GHOSTROUTE_CHANNEL_C_ACME_RENEW'
assert_contains "ansible/roles/stealth_routing/templates/ghostroute-runtime.env.j2" 'GHOSTROUTE_CHANNEL_D_TLS_SOURCE'

assert_contains "$TLS_SYNC" 'copy_atomic\(\)'
assert_contains "$TLS_SYNC" 'certificate_expires_soon\(\)'
assert_contains "$TLS_SYNC" 'Channel D TLS changed but Caddy restart failed'
assert_not_contains "$TLS_SYNC" 'iptables '
assert_contains "$ACME_RENEW" 'iptables -t nat -I PREROUTING'
assert_contains "$ACME_RENEW" 'cleanup\(\)'
assert_contains "$ACME_RENEW" '\-\-renew -d'
assert_not_contains "$ACME_RENEW" '\-\-force'
assert_contains "$SUPERVISOR" 'ChannelCTlsSync'
assert_contains "$SUPERVISOR" 'ChannelCAcmeRenew'
assert_contains "$SUPERVISOR" 'ensure_channel_c_tls\(\)'

assert_contains "ansible/playbooks/99-verify.yml" 'Channel C1 TLS certificate is currently valid'
assert_contains "ansible/playbooks/99-verify.yml" 'Channel D NaiveProxy TLS certificate is currently valid'
assert_contains "ansible/playbooks/99-verify.yml" 'listener serves a current TLS certificate'
assert_contains "ansible/playbooks/24-channel-d-router.yml" 'Channel D selected TLS certificate is current'
assert_contains "ansible/playbooks/24-channel-d-router.yml" 'Channel D Caddy serves a current TLS certificate'
assert_contains "modules/ghostroute-health-monitor/bin/live-check" 'channel_c_tls'
assert_contains "modules/ghostroute-health-monitor/bin/live-check" 'channel_d_tls'
assert_contains "modules/ghostroute-health-monitor/bin/live-check" 'channel_c_acme_crons'
assert_contains "modules/ghostroute-health-monitor/bin/live-check" 'tls_listener_state\(\)'
assert_contains "docs/channel-c.md" '## TLS Lifecycle'
assert_contains "docs/channel-d.md" '## Shared TLS Lifecycle'
assert_contains "modules/routing-core/docs/channel-routing-operations.md" '### Channel C/D TLS Renewal'

echo "channel TLS renewal static tests passed"
