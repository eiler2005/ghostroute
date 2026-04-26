#!/bin/bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"${PROJECT_ROOT}/modules/recovery-verification/tests/test-router-health.sh"
"${PROJECT_ROOT}/modules/dns-catalog-intelligence/tests/test-catalog-review.sh"
"${PROJECT_ROOT}/modules/dns-catalog-intelligence/tests/test-dns-forensics.sh"
"${PROJECT_ROOT}/modules/ghostroute-health-monitor/tests/test-health-monitor.sh"
"${PROJECT_ROOT}/modules/ghostroute-health-monitor/tests/test-vps-health-monitor.sh"
"${PROJECT_ROOT}/tests/test-module-entrypoints.sh"
"${PROJECT_ROOT}/modules/recovery-verification/tests/test-audit-fixes.sh"

echo "all fixture tests passed"
