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
MARKDOWN_OUT="$TMPDIR/router-health.md"
MARKDOWN_PARTIAL_OUT="$TMPDIR/router-health-ipv6-partial.md"
MARKDOWN_RUNTIME_OUT="$TMPDIR/router-health-ipv6-runtime.md"

# 1. History parser contract:
#    ensure we can read latest and week-old catalog snapshots from the local journal format.
router_collect_capacity_history \
  "${PROJECT_ROOT}/tests/fixtures/router-health/journal-sample.md" \
  "$HISTORY_OUT" \
  "2026-04-17"

assert_kv "$HISTORY_OUT" "HISTORY_LATEST_DATE" "2026-04-17"
assert_kv "$HISTORY_OUT" "HISTORY_LATEST_STEALTH_DOMAINS" "7117"
assert_kv "$HISTORY_OUT" "HISTORY_WEEK_DATE" "2026-04-10"
assert_kv "$HISTORY_OUT" "HISTORY_WEEK_VPN_STATIC" "52 активных CIDR в ipset"

# 2. Stable traffic summary contract:
#    ensure router-health-report can safely consume the compact summary emitted by traffic-report.
router_extract_traffic_summary \
  "${PROJECT_ROOT}/tests/fixtures/router-health/traffic-report-sample.txt" \
  "$TRAFFIC_OUT"

assert_kv "$TRAFFIC_OUT" "TRAFFIC_ROUTER_WINDOW" "2026-04-17T00:00:00+0300 -> current router state"
assert_kv "$TRAFFIC_OUT" "TRAFFIC_DEVICE_WINDOW" "2026-04-17T12:00:00+0300 -> current router state"
assert_kv "$TRAFFIC_OUT" "TRAFFIC_MOBILE_BYTE_WINDOW" "2026-04-17T12:00:00+0300 -> current router state"
assert_kv "$TRAFFIC_OUT" "TRAFFIC_DEVICE_VIA_REALITY" "5.00 GiB  (86.2%)"
assert_kv "$TRAFFIC_OUT" "TRAFFIC_MOBILE_TOTAL" "42"
assert_kv "$TRAFFIC_OUT" "TRAFFIC_MOBILE_BYTE_SOURCES" "2"
assert_kv "$TRAFFIC_OUT" "TRAFFIC_MOBILE_BYTE_TOTAL" "812.0 MiB  (upload 90.0 MiB / download 722.0 MiB)"
assert_kv "$TRAFFIC_OUT" "TRAFFIC_MOBILE_REALITY" "30  (71.4%)"
assert_kv "$TRAFFIC_OUT" "TRAFFIC_MOBILE_DIRECT" "12  (28.6%)"
assert_contains "${PROJECT_ROOT}/tests/fixtures/router-health/traffic-report-sample.txt" "=== TOP BY TAILSCALE PEERS ==="
assert_contains "${PROJECT_ROOT}/tests/fixtures/router-health/traffic-report-sample.txt" "=== MOBILE HOME REALITY ==="

# 3. Markdown renderer contract:
#    ensure the final sanitised report still exposes the sections relied on by humans and LLMs.
router_render_health_markdown \
  "${PROJECT_ROOT}/tests/fixtures/router-health/state-sample.env" \
  "$HISTORY_OUT" \
  "$TRAFFIC_OUT" > "$MARKDOWN_OUT"

assert_contains "$MARKDOWN_OUT" "# Router Health Latest"
assert_contains "$MARKDOWN_OUT" "## Routing Health"
assert_contains "$MARKDOWN_OUT" "Home Reality listener :<home-reality-port>"
assert_contains "$MARKDOWN_OUT" "Home Reality IPv4-only listener"
assert_contains "$MARKDOWN_OUT" "Home Reality INPUT allow :<home-reality-port>"
assert_contains "$MARKDOWN_OUT" "Home Reality connlimit >300 before ACCEPT"
assert_contains "$MARKDOWN_OUT" "Home Reality LTE MSS clamp :<home-reality-port>"
assert_contains "$MARKDOWN_OUT" "Router TCP high-BDP tuning"
assert_contains "$MARKDOWN_OUT" "Home Reality DNS guard :53/:853"
assert_contains "$MARKDOWN_OUT" "Home Reality managed split"
assert_contains "$MARKDOWN_OUT" "Home Reality direct fallback"
assert_contains "$MARKDOWN_OUT" "Home Reality all-relay absent"
assert_contains "$MARKDOWN_OUT" "legacy VPN_DOMAINS ipset absent"
assert_contains "$MARKDOWN_OUT" "wgc1 cold-fallback NVRAM preserved"
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
assert_contains "$MARKDOWN_OUT" "## Traffic Snapshot"
assert_contains "$MARKDOWN_OUT" "Reality-managed total:"
assert_contains "$MARKDOWN_OUT" "Via Reality:"
assert_contains "$MARKDOWN_OUT" "Home Reality connections:"
assert_contains "$MARKDOWN_OUT" "Home Reality byte total:"
assert_contains "$MARKDOWN_OUT" "Home Reality via Reality:"
assert_contains "$MARKDOWN_OUT" "Home Reality direct-out:"
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

echo "router-health fixture smoke tests passed"
