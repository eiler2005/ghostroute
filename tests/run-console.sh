#!/bin/bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONSOLE_APP="${PROJECT_ROOT}/modules/ghostroute-console/app"

usage() {
  cat >&2 <<'EOF'
usage: ./tests/run-console.sh <--fast|--smoke|--perf|--all>

  --fast   Console JSON contracts, unit/model tests, production build
  --smoke  Seeded functional Playwright GUI/API smoke
  --perf   Seeded Playwright performance budget suite
  --all    Full Console local gate from the module npm script
EOF
}

case "${1:-}" in
  --fast)
    "${PROJECT_ROOT}/modules/ghostroute-console/tests/test-json-contracts.sh"
    npm --prefix "${CONSOLE_APP}" test
    npm --prefix "${CONSOLE_APP}" run build
    echo "console fast tests passed"
    ;;
  --smoke)
    npm --prefix "${CONSOLE_APP}" run test:e2e:gui
    echo "console smoke tests passed"
    ;;
  --perf)
    npm --prefix "${CONSOLE_APP}" run test:perf
    echo "console performance tests passed"
    ;;
  --all)
    npm --prefix "${CONSOLE_APP}" run test:gui:all
    echo "console full local gate passed"
    ;;
  -h|--help)
    usage
    ;;
  *)
    usage
    exit 2
    ;;
esac
