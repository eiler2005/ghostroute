#!/bin/bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Platform-level health gate kept at repo root for operator ergonomics.
# The implementation is module-native and lives in Recovery & Verification.
exec "${PROJECT_ROOT}/modules/recovery-verification/bin/verify.sh" "$@"
