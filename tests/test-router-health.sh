#!/bin/bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "${PROJECT_ROOT}/scripts/lib/router-health-common.sh"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# Minimal assertion helper for section-level contract checks.
# We intentionally keep this lightweight instead of pulling a test framework:
# the goal is fast smoke validation of text contracts, not rich test reporting.
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

# Key/value assertion for helper outputs rendered as env-like files.
# This is used for history parsing and traffic-summary extraction.
assert_kv() {
  local file="$1"
  local key="$2"
  local expected="$3"
  local value
  value="$(router_kv_get "$file" "$key")"
  if [ "$value" != "$expected" ]; then
    echo "Expected $key=$expected, got $value" >&2
    exit 1
  fi
}

HISTORY_OUT="$TMPDIR/history.env"
TRAFFIC_OUT="$TMPDIR/traffic.env"
TRAFFIC_WARN_OUT="$TMPDIR/traffic-warn.env"
MARKDOWN_OUT="$TMPDIR/router-health.md"
MARKDOWN_PARTIAL_OUT="$TMPDIR/router-health-ipv6-partial.md"
MARKDOWN_RUNTIME_OUT="$TMPDIR/router-health-ipv6-runtime.md"
MARKDOWN_WGS1_MISSING_OUT="$TMPDIR/router-health-wgs1-missing.md"
MARKDOWN_WGS1_CAP_OUT="$TMPDIR/router-health-wgs1-capability.md"
MARKDOWN_WGS1_BASELINE_OUT="$TMPDIR/router-health-wgs1-baseline.md"

# 1. History parser contract:
#    ensure we can read latest and week-old catalog snapshots from the local journal format.
router_collect_capacity_history \
  "${PROJECT_ROOT}/tests/fixtures/router-health/journal-sample.md" \
  "$HISTORY_OUT" \
  "2026-04-17"

assert_kv "$HISTORY_OUT" "HISTORY_LATEST_DATE" "2026-04-17"
assert_kv "$HISTORY_OUT" "HISTORY_LATEST_VPN_DOMAINS" "7117"
assert_kv "$HISTORY_OUT" "HISTORY_WEEK_DATE" "2026-04-10"
assert_kv "$HISTORY_OUT" "HISTORY_WEEK_VPN_STATIC" "52 активных CIDR в ipset"

# 2. Stable traffic summary contract:
#    ensure router-health-report can safely consume the compact summary emitted by traffic-report.
router_extract_traffic_summary \
  "${PROJECT_ROOT}/tests/fixtures/router-health/traffic-report-sample.txt" \
  "$TRAFFIC_OUT"

assert_kv "$TRAFFIC_OUT" "TRAFFIC_ROUTER_WINDOW" "2026-04-17T00:00:00+0300 -> current router state"
assert_kv "$TRAFFIC_OUT" "TRAFFIC_DEVICE_WINDOW" "2026-04-17T12:00:00+0300 -> current router state"
assert_kv "$TRAFFIC_OUT" "TRAFFIC_DEVICE_VIA_VPN" "5.00 GiB  (86.2%)"
assert_contains "${PROJECT_ROOT}/tests/fixtures/router-health/traffic-report-sample.txt" "=== TOP BY WG SERVER PEERS ==="
assert_contains "${PROJECT_ROOT}/tests/fixtures/router-health/traffic-report-sample.txt" "=== TOP BY TAILSCALE PEERS ==="

router_extract_traffic_summary \
  "${PROJECT_ROOT}/tests/fixtures/router-health/traffic-report-wgs1-baseline-warning-sample.txt" \
  "$TRAFFIC_WARN_OUT"

assert_kv "$TRAFFIC_WARN_OUT" "TRAFFIC_WGS1_PEER_BREAKDOWN_WARNING" "WG server total is non-zero, but per-peer WireGuard deltas are unavailable in this window. This usually means missing wgs1 snapshots or no usable peer baseline yet."

# 3. Markdown renderer contract:
#    ensure the final sanitised report still exposes the sections relied on by humans and LLMs.
router_render_health_markdown \
  "${PROJECT_ROOT}/tests/fixtures/router-health/state-sample.env" \
  "$HISTORY_OUT" \
  "$TRAFFIC_OUT" > "$MARKDOWN_OUT"

assert_contains "$MARKDOWN_OUT" "# Router Health Latest"
assert_contains "$MARKDOWN_OUT" "## Routing Health"
assert_contains "$MARKDOWN_OUT" "Home Reality listener :443"
assert_contains "$MARKDOWN_OUT" "Home Reality INPUT allow :443"
assert_contains "$MARKDOWN_OUT" "## Catalog Capacity"
assert_contains "$MARKDOWN_OUT" "### Growth vs latest saved snapshot"
assert_contains "$MARKDOWN_OUT" "### Growth vs week-old snapshot"
assert_contains "$MARKDOWN_OUT" "Growth level:"
assert_contains "$MARKDOWN_OUT" "Growth note:"
assert_contains "$MARKDOWN_OUT" "## Freshness"
assert_contains "$MARKDOWN_OUT" "## IPv6 Policy"
assert_contains "$MARKDOWN_OUT" "Policy mode: **Disabled**"
assert_contains "$MARKDOWN_OUT" "Status: **OK**"
assert_contains "$MARKDOWN_OUT" "Recommendation: **Keep Merlin UI at IPv6 -> Отключить until a separate dual-stack project exists.**"
assert_contains "$MARKDOWN_OUT" "## WGS1 Observability"
assert_contains "$MARKDOWN_OUT" "Snapshot artifact: **Fresh and usable**"
assert_contains "$MARKDOWN_OUT" "Window peer baseline: **Usable**"
assert_contains "$MARKDOWN_OUT" "## Traffic Snapshot"
assert_contains "$MARKDOWN_OUT" "## Drift"
assert_contains "$MARKDOWN_OUT" "## Notes"

# 4. IPv6 policy drift fixtures:
#    partial LAN/WAN enable without wgc1 IPv6 path must be critical.
router_render_health_markdown \
  "${PROJECT_ROOT}/tests/fixtures/router-health/state-ipv6-partial.env" \
  "$HISTORY_OUT" \
  "$TRAFFIC_OUT" > "$MARKDOWN_PARTIAL_OUT"

assert_contains "$MARKDOWN_PARTIAL_OUT" "- Result: **Critical**"
assert_contains "$MARKDOWN_PARTIAL_OUT" "Policy mode: **Partial enable**"
assert_contains "$MARKDOWN_PARTIAL_OUT" "Status: **Critical**"
assert_contains "$MARKDOWN_PARTIAL_OUT" "wgc1 has no live IPv6 address/route"

# 5. IPv6 runtime present everywhere is still non-OK until a separate dual-stack project exists.
router_render_health_markdown \
  "${PROJECT_ROOT}/tests/fixtures/router-health/state-ipv6-runtime.env" \
  "$HISTORY_OUT" \
  "$TRAFFIC_OUT" > "$MARKDOWN_RUNTIME_OUT"

assert_contains "$MARKDOWN_RUNTIME_OUT" "- Result: **Critical**"
assert_contains "$MARKDOWN_RUNTIME_OUT" "Policy mode: **Runtime drift**"
assert_contains "$MARKDOWN_RUNTIME_OUT" "Status: **Warning**"
assert_contains "$MARKDOWN_RUNTIME_OUT" "repo still has no active dual-stack routing layer"

# 6. WGS1 observability fixtures:
#    missing snapshot vs capability problem vs no usable peer baseline must stay distinguishable.
router_render_health_markdown \
  "${PROJECT_ROOT}/tests/fixtures/router-health/state-wgs1-missing.env" \
  "$HISTORY_OUT" \
  "$TRAFFIC_OUT" > "$MARKDOWN_WGS1_MISSING_OUT"

assert_contains "$MARKDOWN_WGS1_MISSING_OUT" "Snapshot artifact: **Missing**"

router_render_health_markdown \
  "${PROJECT_ROOT}/tests/fixtures/router-health/state-wgs1-capability.env" \
  "$HISTORY_OUT" \
  "$TRAFFIC_OUT" > "$MARKDOWN_WGS1_CAP_OUT"

assert_contains "$MARKDOWN_WGS1_CAP_OUT" "Snapshot artifact: **Capability problem**"

router_render_health_markdown \
  "${PROJECT_ROOT}/tests/fixtures/router-health/state-sample.env" \
  "$HISTORY_OUT" \
  "$TRAFFIC_WARN_OUT" > "$MARKDOWN_WGS1_BASELINE_OUT"

assert_contains "$MARKDOWN_WGS1_BASELINE_OUT" "Window peer baseline: **No usable peer baseline in current traffic window**"
assert_contains "$MARKDOWN_WGS1_BASELINE_OUT" "per-peer WireGuard deltas are unavailable in this window"

echo "router-health fixture smoke tests passed"
