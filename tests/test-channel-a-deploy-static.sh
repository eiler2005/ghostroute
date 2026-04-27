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
assert_contains "ansible/roles/stealth_routing/tasks/main.yml" 'Ensure Channel A persistence and catalog cron entries'
assert_contains "ansible/roles/stealth_routing/tasks/main.yml" 'Refresh blocked-domain cache opportunistically'

echo "channel-a deploy static tests passed"
