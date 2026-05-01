#!/bin/bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

npm --prefix "${PROJECT_ROOT}/modules/ghostroute-console/app" run test:e2e -- --grep 'renders /$|api smoke endpoints respond'

echo "console smoke tests passed"
