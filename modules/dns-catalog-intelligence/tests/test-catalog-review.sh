#!/bin/bash

set -euo pipefail

MODULE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_ROOT="$(cd "${MODULE_DIR}/../.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

assert_contains() {
  local file="$1"
  local pattern="$2"
  if ! grep -F -- "$pattern" "$file" >/dev/null 2>&1; then
    echo "Expected pattern not found: $pattern" >&2
    echo "--- file: $file ---" >&2
    cat "$file" >&2
    exit 1
  fi
}

REPORT_OUT="$TMPDIR/catalog-review.md"

CATALOG_REVIEW_DNSMASQ_FILE="${MODULE_DIR}/fixtures/catalog-review/dnsmasq-sample.conf.add" \
CATALOG_REVIEW_STATIC_FILE="${MODULE_DIR}/fixtures/catalog-review/static-networks-sample.txt" \
CATALOG_REVIEW_STATE_FILE="${MODULE_DIR}/fixtures/catalog-review/state-sample.env" \
"${PROJECT_ROOT}/scripts/catalog-review-report" > "$REPORT_OUT"

assert_contains "$REPORT_OUT" "# Catalog Review Latest"
assert_contains "$REPORT_OUT" "Mode: advisory only"
assert_contains "$REPORT_OUT" "## Static Coverage Review"
assert_contains "$REPORT_OUT" "### Broad CIDR review candidates"
assert_contains "$REPORT_OUT" '`17.0.0.0/8`'
assert_contains "$REPORT_OUT" "## Domain Coverage Review"
assert_contains "$REPORT_OUT" '`api.example.com` is already covered by `example.com`'
assert_contains "$REPORT_OUT" "Recommendation note: these are **cleanup candidates only**."

echo "catalog-review fixture smoke tests passed"
