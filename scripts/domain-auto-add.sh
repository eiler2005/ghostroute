#!/bin/sh
set -eu
PROJECT_ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
exec "${PROJECT_ROOT}/modules/dns-catalog-intelligence/router/domain-auto-add.sh" "$@"
