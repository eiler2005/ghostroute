#!/bin/bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"${PROJECT_ROOT}/tests/run-fast.sh"

case "${1:-}" in
  --full)
    npm --prefix "${PROJECT_ROOT}/modules/ghostroute-console/app" run test:e2e
    echo "all fixture and full e2e tests passed"
    ;;
  ""|--smoke)
    "${PROJECT_ROOT}/tests/run-smoke.sh"
    echo "all fixture and smoke tests passed"
    ;;
  *)
    echo "usage: $0 [--smoke|--full]" >&2
    exit 2
    ;;
esac
