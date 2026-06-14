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
    rg -n -- "$pattern" "${PROJECT_ROOT}/${path}" >&2
    exit 1
  fi
}

SUPERVISOR="modules/routing-core/router/ghostroute-runtime-supervisor"
SERVICES_START="modules/routing-core/router/services-start"

assert_contains "$SUPERVISOR" 'boot\)'
assert_contains "$SUPERVISOR" 'recover\)'
assert_contains "$SUPERVISOR" 'status\)'
assert_contains "$SUPERVISOR" 'channel-m-recover\)'
assert_contains "$SUPERVISOR" 'channel-m-status\)'
assert_contains "$SUPERVISOR" 'prepare_runtime\(\)'
assert_contains "$SUPERVISOR" 'ensure_singbox\(\)'
assert_contains "$SUPERVISOR" 'ensure_dnscrypt\(\)'
assert_contains "$SUPERVISOR" 'ensure_channel_b\(\)'
assert_contains "$SUPERVISOR" 'ensure_channel_d\(\)'
assert_contains "$SUPERVISOR" 'ensure_channel_m_reverse\(\)'
assert_contains "$SUPERVISOR" 'recover_channel_m\(\)'
assert_contains "$SUPERVISOR" 'register_crons\(\)'
assert_contains "$SUPERVISOR" 'routing_rules_present\(\)'
assert_contains "$SUPERVISOR" 'stabilize_routing\(\)'
assert_contains "$SUPERVISOR" 'GHOSTROUTE_RUNTIME_POST_ROUTING_DELAY'
assert_contains "$SUPERVISOR" '--dport 443 .*--match-set'
assert_contains "$SUPERVISOR" 'REDIRECT .*--to-ports'
assert_contains "$SUPERVISOR" 'GHOSTROUTE_CHANNEL_C_HOME_PORT'
assert_contains "$SUPERVISOR" 'GHOSTROUTE_CHANNEL_C_SHADOWROCKET_PORT'
assert_not_contains "$SUPERVISOR" 'command -v cru'

assert_contains "$SERVICES_START" 'GhostRouteRuntimeSupervisor'
assert_contains "$SERVICES_START" 'ghostroute-runtime-supervisor.sh boot'
assert_not_contains "$SERVICES_START" 'SingBoxWatchdog|DnscryptWatchdog|ChannelMReverse|cron-save-ipset|channel-d-naiveproxy-bootstrap|channel-b-home-relay-bootstrap|stealth-singbox-bootstrap|stealth-dnscrypt-bootstrap'

assert_contains "ansible/roles/stealth_routing/tasks/main.yml" 'ghostroute-runtime-supervisor'
assert_contains "ansible/roles/stealth_routing/templates/ghostroute-runtime.env.j2" 'GHOSTROUTE_RUNTIME_SUPERVISOR'
assert_contains "ansible/roles/stealth_routing/templates/ghostroute-runtime.env.j2" 'GHOSTROUTE_RUNTIME_POST_ROUTING_DELAY'
assert_contains "ansible/roles/stealth_routing/templates/ghostroute-runtime.env.j2" 'GHOSTROUTE_CHANNEL_B_HOME_SOCKS_PORT'
if LC_ALL=C grep -n "$(printf '\r')" "${PROJECT_ROOT}/ansible/roles/stealth_routing/templates/ghostroute-runtime.env.j2" >/dev/null; then
  echo "Expected ghostroute-runtime.env.j2 not to contain CR bytes" >&2
  exit 1
fi
assert_contains "ansible/playbooks/99-verify.yml" 'services-start is owned by GhostRoute runtime supervisor'
assert_contains "modules/ghostroute-health-monitor/bin/live-check" 'services_start_supervisor'
assert_contains "modules/ghostroute-health-monitor/bin/live-check" 'channel_m_on_demand_control'
assert_contains "modules/shared/lib/router-health-common.sh" 'RUNTIME_SUPERVISOR_INSTALLED'
assert_contains "modules/shared/lib/router-health-common.sh" 'CHANNEL_M_ON_DEMAND_CONTROL'

assert_not_contains "ansible/playbooks/23-channel-m-reverse.yml" 'sleep 45'
assert_not_contains "ansible/playbooks/24-channel-d-router.yml" 'ChannelMReverse managed by ansible'
assert_not_contains "ansible/roles/channel_b_home_relay/tasks/main.yml" 'Ensure services-start hook starts'
assert_not_contains "ansible/roles/channel_d_naiveproxy/tasks/main.yml" 'Ensure services-start hook starts'
assert_not_contains "ansible/roles/dnscrypt_proxy/tasks/main.yml" 'Ensure services-start hook starts'
assert_not_contains "ansible/roles/stealth_routing/tasks/main.yml" 'Ensure services-start hook starts'

echo "runtime supervisor static tests passed"
