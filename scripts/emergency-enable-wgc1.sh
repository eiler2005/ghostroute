#!/bin/sh
set -eu
PROJECT_ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
exec "${PROJECT_ROOT}/modules/recovery-verification/router/emergency-enable-wgc1.sh" "$@"
