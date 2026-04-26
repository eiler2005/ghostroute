#!/bin/bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

assert_wrapper() {
  local wrapper="$1"
  local target_fragment="$2"
  local path="${PROJECT_ROOT}/${wrapper}"

  [ -x "$path" ] || { echo "Wrapper is not executable: $wrapper" >&2; exit 1; }
  grep -F -- "$target_fragment" "$path" >/dev/null || {
    echo "Wrapper $wrapper does not reference $target_fragment" >&2
    exit 1
  }
}

assert_source_wrapper() {
  local wrapper="$1"
  local target_fragment="$2"
  local path="${PROJECT_ROOT}/${wrapper}"

  [ -f "$path" ] || { echo "Source wrapper is missing: $wrapper" >&2; exit 1; }
  grep -F -- "$target_fragment" "$path" >/dev/null || {
    echo "Source wrapper $wrapper does not reference $target_fragment" >&2
    exit 1
  }
}

assert_wrapper "verify.sh" "modules/recovery-verification/bin/verify.sh"
assert_wrapper "scripts/traffic-report" "modules/traffic-observatory/bin/traffic-report"
assert_wrapper "scripts/router-health-report" "modules/ghostroute-health-monitor/bin/router-health-report"
assert_wrapper "scripts/catalog-review-report" "modules/dns-catalog-intelligence/bin/catalog-review-report"
assert_wrapper "scripts/dns-forensics-report" "modules/dns-catalog-intelligence/bin/dns-forensics-report"
assert_wrapper "scripts/domain-auto-add.sh" "modules/dns-catalog-intelligence/router/domain-auto-add.sh"
assert_wrapper "scripts/client-profiles" "modules/client-profile-factory/bin/client-profiles"
assert_wrapper "scripts/secret-scan" "modules/secrets-management/bin/secret-scan"
assert_wrapper "scripts/firewall-start" "modules/routing-core/router/firewall-start"
assert_wrapper "scripts/health-monitor/run-probes" "modules/ghostroute-health-monitor/router/run-probes"
assert_wrapper "scripts/vps-health-monitor/run-probes" "modules/ghostroute-health-monitor/vps/run-probes"
assert_source_wrapper "scripts/lib/router-health-common.sh" "modules/shared/lib/router-health-common.sh"
assert_source_wrapper "scripts/lib/device-labels.sh" "modules/shared/lib/device-labels.sh"

echo "wrapper compatibility tests passed"
