#!/bin/bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_RISK="${PROJECT_ROOT}/modules/ghostroute-health-monitor/bin/deploy-risk"

assert_json_field() {
  local json="$1"
  local expression="$2"
  node -e "
    const payload = JSON.parse(process.argv[1]);
    if (!(${expression})) {
      console.error('Assertion failed: ${expression}');
      console.error(JSON.stringify(payload, null, 2));
      process.exit(1);
    }
  " "$json"
}

docs_json="$("$DEPLOY_RISK" --json docs/troubleshooting.md README.md)"
assert_json_field "$docs_json" 'payload.gate_required === false'
assert_json_field "$docs_json" 'payload.classification === "docs_or_tests_only"'

console_json="$("$DEPLOY_RISK" --json modules/ghostroute-console/app/src/app/health/page.tsx modules/ghostroute-console/README.md)"
assert_json_field "$console_json" 'payload.gate_required === false'
assert_json_field "$console_json" 'payload.classification === "console_only"'

runtime_json="$("$DEPLOY_RISK" --json modules/routing-core/router/firewall-start configs/dnsmasq-stealth.conf.add)"
assert_json_field "$runtime_json" 'payload.gate_required === true'
assert_json_field "$runtime_json" 'payload.classification === "runtime_critical"'

unknown_json="$("$DEPLOY_RISK" --json tools/new-helper.sh)"
assert_json_field "$unknown_json" 'payload.gate_required === true'
assert_json_field "$unknown_json" 'payload.classification === "unknown_risk"'

if "$DEPLOY_RISK" --fail-if-gate-required modules/routing-core/router/firewall-start >/tmp/ghostroute-deploy-risk-test.txt 2>&1; then
  echo "Expected --fail-if-gate-required to exit non-zero for runtime changes" >&2
  exit 1
fi

echo "deploy-risk tests passed"
