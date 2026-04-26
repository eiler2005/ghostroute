#!/bin/bash
if [ -n "${PROJECT_ROOT:-}" ]; then
  GHOSTROUTE_PROJECT_ROOT="$PROJECT_ROOT"
else
  GHOSTROUTE_PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi
. "${GHOSTROUTE_PROJECT_ROOT}/modules/shared/lib/router-health-common.sh"
