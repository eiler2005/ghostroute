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
assert_executable "modules/traffic-observatory/bin/traffic-report"
assert_executable "modules/traffic-observatory/bin/traffic-daily-report"
assert_executable "modules/ghostroute-health-monitor/bin/router-health-report"
assert_executable "modules/ghostroute-health-monitor/bin/ghostroute-health-report"
assert_executable "modules/dns-catalog-intelligence/bin/catalog-review-report"
assert_executable "modules/dns-catalog-intelligence/bin/dns-forensics-report"
assert_executable "modules/dns-catalog-intelligence/bin/domain-report"
assert_executable "modules/client-profile-factory/bin/client-profiles"
assert_executable "modules/secrets-management/bin/secret-scan"
assert_executable "modules/secrets-management/bin/init-stealth-vault.sh"

if find "${PROJECT_ROOT}/scripts" -type f ! -name README.md | grep . >/dev/null; then
  echo "scripts/ must only contain common utilities, not module wrappers:" >&2
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

wrapper_test_name='test-wrapper''-compat'
wrapper_pattern='compatibility wrapper''s|stable wrapper''s|scripts/lib wrap''per'
wrapper_pattern="${wrapper_pattern}|${wrapper_test_name}"
if rg -n "$wrapper_pattern" \
  "${PROJECT_ROOT}/README.md" "${PROJECT_ROOT}/README-ru.md" "${PROJECT_ROOT}/docs" \
  "${PROJECT_ROOT}/modules" --glob '!docs/vpn-domain-journal.md' >/tmp/ghostroute-stale-wrappers.txt; then
  cat /tmp/ghostroute-stale-wrappers.txt >&2
  echo "Found stale compatibility-wrapper language." >&2
  exit 1
fi

echo "module entrypoint tests passed"
