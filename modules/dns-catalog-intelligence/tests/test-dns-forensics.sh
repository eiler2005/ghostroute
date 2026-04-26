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

REPORT_OUT="$TMPDIR/dns-forensics.txt"
FILTERED_OUT="$TMPDIR/dns-forensics-filtered.txt"
WRITER_DIR="$TMPDIR/writer"
mkdir -p "$WRITER_DIR"

DOMAIN_AUTO_ADD_LOG_FILE="${MODULE_DIR}/fixtures/dns-forensics/dnsmasq-sample.log" \
DOMAIN_AUTO_ADD_LEASES_FILE="${MODULE_DIR}/fixtures/dns-forensics/dnsmasq-leases-sample.txt" \
DOMAIN_AUTO_ADD_FORENSICS_DIR="$WRITER_DIR" \
sh "${PROJECT_ROOT}/scripts/domain-auto-add.sh" --forensics-only

WRITER_SNAPSHOT="$(find "$WRITER_DIR" -type f -name '*.tsv' | sort | tail -1)"
[ -n "$WRITER_SNAPSHOT" ] || { echo "Writer snapshot was not created" >&2; exit 1; }

assert_contains "$WRITER_SNAPSHOT" "WINDOW|2026-04-21T05|Apr 21|05:00:42|05:59:59|9|3"
assert_contains "$WRITER_SNAPSHOT" "CLIENT|1|192.168.50.34|?|5|3|aaplimg.com|3"
assert_contains "$WRITER_SNAPSHOT" "TOPDOMAIN|192.168.50.34|1|3|stocks-data-service.v.aaplimg.com"
assert_contains "$WRITER_SNAPSHOT" "TOPFAMILY|192.168.50.36|2|1|github.com"

DNS_FORENSICS_SOURCE_DIR="${MODULE_DIR}/fixtures/dns-forensics" \
DNS_FORENSICS_DEVICE_METADATA_FILE="${MODULE_DIR}/fixtures/dns-forensics/device-metadata-sample.tsv" \
"${PROJECT_ROOT}/scripts/dns-forensics-report" 2026-04-21T05 > "$REPORT_OUT"

assert_contains "$REPORT_OUT" "=== WINDOW ==="
assert_contains "$REPORT_OUT" "Window key:              2026-04-21T05"
assert_contains "$REPORT_OUT" "Clients in snapshot:     3"
assert_contains "$REPORT_OUT" "192.168.50.34"
assert_contains "$REPORT_OUT" "Work-Mac (MacBook)"
assert_contains "$REPORT_OUT" "stocks-data-service.v.aaplimg.com"
assert_contains "$REPORT_OUT" "Top domain families:"
assert_contains "$REPORT_OUT" "chatgpt.com"
assert_contains "$REPORT_OUT" "=== NOTES ==="

DNS_FORENSICS_SOURCE_DIR="${MODULE_DIR}/fixtures/dns-forensics" \
DNS_FORENSICS_DEVICE_METADATA_FILE="${MODULE_DIR}/fixtures/dns-forensics/device-metadata-sample.tsv" \
"${PROJECT_ROOT}/scripts/dns-forensics-report" 2026-04-21T05 --ip 192.168.50.36 > "$FILTERED_OUT"

assert_contains "$FILTERED_OUT" "=== CLIENT 192.168.50.36 ==="
assert_contains "$FILTERED_OUT" "api.github.com"
assert_contains "$FILTERED_OUT" "dropbox.com"

echo "dns-forensics fixture smoke tests passed"
