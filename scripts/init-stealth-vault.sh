#!/bin/sh
set -eu
PROJECT_ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
exec "${PROJECT_ROOT}/modules/secrets-management/bin/init-stealth-vault.sh" "$@"
