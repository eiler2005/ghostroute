#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
case "${1:-}" in
  --collection)
    echo '[traffic/collection] Router readers, cadence, DNS cursor and source contracts'
    python3 "$ROOT/tests/test-traffic-evidence-cadence.py"
    python3 "$ROOT/tests/test-traffic-evidence-retention.py"
    bash "$ROOT/tests/test-dns-query-snapshot.sh"
    bash "$ROOT/tests/test-traffic-evidence-v3.sh"
    bash "$ROOT/tests/test-traffic-summary-midnight.sh"
    bash "$ROOT/modules/traffic-observatory/tests/test-router-rollups.sh"
    bash "$ROOT/modules/traffic-observatory/tests/test-traffic-facts-home-reality.sh"
    ;;
  --data)
    echo '[traffic/data] SQLite normalization, aggregate ownership, prepared windows and reconciliation'
    npm --prefix "$ROOT/modules/ghostroute-console/app" test
    ;;
  --gui)
    echo '[traffic/gui] Seeded desktop/mobile rendering and API-to-card parity'
    npm --prefix "$ROOT/modules/ghostroute-console/app" run test:e2e:gui
    ;;
  --all)
    "$0" --collection
    "$0" --data
    "$0" --gui
    ;;
  *) echo 'Usage: tests/run-traffic.sh --collection|--data|--gui|--all' >&2; exit 2 ;;
esac
