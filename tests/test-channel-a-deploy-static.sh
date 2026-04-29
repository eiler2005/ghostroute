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
assert_contains "ansible/roles/singbox_client/tasks/main.yml" 'Install sing-box log rotation helper'
assert_contains "ansible/roles/singbox_client/tasks/main.yml" 'RotateSingBoxLog'
assert_contains "modules/routing-core/router/services-start" 'RotateSingBoxLog'
assert_contains "deploy.sh" 'rotate-singbox-log'
assert_contains "ansible/playbooks/20-stealth-router.yml" 'Refresh sing-box rule-sets after catalog deploy'
assert_contains "ansible/playbooks/20-stealth-router.yml" 'update-singbox-rule-sets.sh --restart-if-changed'
assert_contains "configs/dnsmasq-stealth.conf.add" 'ipset=/googleapis.com/STEALTH_DOMAINS'

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

echo "channel-a deploy static tests passed"
