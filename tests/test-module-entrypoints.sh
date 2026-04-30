#!/bin/bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

assert_executable() {
  local path="$1"
  if [ ! -x "${PROJECT_ROOT}/${path}" ]; then
    echo "Expected executable module entrypoint: ${path}" >&2
    exit 1
  fi
}

assert_executable "deploy.sh"
assert_executable "verify.sh"
assert_executable "modules/recovery-verification/bin/verify.sh"
assert_executable "modules/recovery-verification/bin/audit-fixes"
assert_executable "modules/traffic-observatory/bin/traffic-report"
assert_executable "modules/traffic-observatory/bin/traffic-daily-report"
assert_executable "modules/traffic-observatory/bin/live-events-report"
assert_executable "modules/ghostroute-health-monitor/bin/router-health-report"
assert_executable "modules/ghostroute-health-monitor/bin/ghostroute-health-report"
assert_executable "modules/ghostroute-health-monitor/bin/status"
assert_executable "modules/ghostroute-health-monitor/bin/leak-check"
assert_executable "modules/dns-catalog-intelligence/bin/catalog-review-report"
assert_executable "modules/dns-catalog-intelligence/bin/dns-forensics-report"
assert_executable "modules/dns-catalog-intelligence/bin/domain-report"
assert_executable "modules/ghostroute-console/bin/ghostroute-console"
assert_executable "modules/client-profile-factory/bin/client-profiles"
assert_executable "modules/secrets-management/bin/secret-scan"
assert_executable "modules/secrets-management/bin/init-stealth-vault.sh"
assert_executable "modules/secrets-management/bin/cleanup-vault-backups"

if find "${PROJECT_ROOT}/scripts" -type f ! -name README.md | grep . >/dev/null; then
  echo "scripts/ must only contain common utilities, not module aliases:" >&2
  find "${PROJECT_ROOT}/scripts" -type f ! -name README.md >&2
  exit 1
fi

stale_scripts_pattern='[.]/scripts/'
if rg -n "$stale_scripts_pattern" "${PROJECT_ROOT}/README.md" "${PROJECT_ROOT}/README-ru.md" \
  "${PROJECT_ROOT}/docs" "${PROJECT_ROOT}/modules" \
  --glob '!docs/vpn-domain-journal.md' >/tmp/ghostroute-stale-scripts.txt; then
  cat /tmp/ghostroute-stale-scripts.txt >&2
  echo "Found stale scripts-layer references; use module-native paths." >&2
  exit 1
fi

alias_test_name='test-module-aliases'
alias_pattern='stable alias''es|scripts/lib alias'
alias_pattern="${alias_pattern}|${alias_test_name}"
if rg -n "$alias_pattern" \
  "${PROJECT_ROOT}/README.md" "${PROJECT_ROOT}/README-ru.md" "${PROJECT_ROOT}/docs" \
  "${PROJECT_ROOT}/modules" --glob '!docs/vpn-domain-journal.md' >/tmp/ghostroute-stale-aliases.txt; then
  cat /tmp/ghostroute-stale-aliases.txt >&2
  echo "Found stale scripts-alias language." >&2
  exit 1
fi

echo "module entrypoint tests passed"
