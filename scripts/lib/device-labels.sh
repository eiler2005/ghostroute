#!/bin/sh
if [ -n "${PROJECT_ROOT:-}" ]; then
  GHOSTROUTE_PROJECT_ROOT="$PROJECT_ROOT"
else
  GHOSTROUTE_PROJECT_ROOT="$(CDPATH= cd -- "$(dirname "${BASH_SOURCE:-$0}")/../.." && pwd)"
fi
. "${GHOSTROUTE_PROJECT_ROOT}/modules/shared/lib/device-labels.sh"
