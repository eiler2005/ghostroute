#!/bin/sh
set -eu
PROJECT_ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
exec "${PROJECT_ROOT}/modules/routing-core/router/update-singbox-rule-sets.sh" "$@"
