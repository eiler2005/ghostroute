#!/bin/bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "${PROJECT_ROOT}/modules/ghostroute-health-monitor/tests/test-health-monitor.sh" "$@"
