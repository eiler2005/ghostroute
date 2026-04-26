#!/bin/bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"${PROJECT_ROOT}/tests/test-router-health.sh"
"${PROJECT_ROOT}/tests/test-catalog-review.sh"
"${PROJECT_ROOT}/tests/test-dns-forensics.sh"
"${PROJECT_ROOT}/tests/test-health-monitor.sh"
"${PROJECT_ROOT}/tests/test-vps-health-monitor.sh"
"${PROJECT_ROOT}/tests/test-wrapper-compat.sh"

echo "all fixture tests passed"
