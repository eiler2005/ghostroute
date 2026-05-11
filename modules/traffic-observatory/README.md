# Traffic Observatory Module Overview

## Purpose

Traffic Observatory provides day-to-day usage and routing reports for WAN,
LAN/Wi-Fi, Home Reality QR clients, popular destinations and split-routing
mistakes.

## Features

- Current-day and historical traffic reports.
- LAN/Wi-Fi device counters with redacted labels by default.
- Home Reality QR client accounting for remote iPhone/Mac clients.
- Routing mistake hints for managed domains and direct/VPS exits.

## How It Works

Router-side collector scripts refresh mangle counters and snapshot byte totals.
Control-machine reports pull those counters through the shared router SSH helper,
combine them with local metadata and render safe Markdown/text output for humans
and LLM handoff.

For Console accounting, the router also writes a bounded bottom layer of LAN
flow facts and edge rollups. `lan-flow-facts-snapshot` samples conntrack byte
deltas as `client_ip -> destination_ip -> route -> bytes`; then
`traffic-rollup-snapshot` builds portable `5min/hourly/daily/weekly/monthly`
chunks under the traffic state directory. Both jobs are asynchronous, guarded by
lock/load/row limits, and do not change Channels A/B/C, managed domains,
iptables routing rules or sing-box policy. The VPS/Console remains the main
warehouse/read-model layer and imports router rollups as preferred totals.

## Architecture

- `bin/` contains local reporting commands.
- `router/` contains ASUS Merlin runtime collectors.
- Shared parsing and redaction helpers live in `modules/shared/lib`.

## Read-only / Mutating Contract

The module is read-only for routing policy. It mutates only its own accounting
counters and snapshot files on the router. The LAN flow collector may enable
`nf_conntrack_acct` for byte visibility; it stores the previous value and ships a
rollback script.

## Public Commands

- `./modules/traffic-observatory/bin/traffic-report`
- `./modules/traffic-observatory/bin/traffic-report check`
- `./modules/traffic-observatory/bin/traffic-summary --json today`
- `./modules/traffic-observatory/bin/traffic-summary --json recent --hours 2`
- `./modules/traffic-observatory/bin/traffic-rollup-export --json today`
- `./modules/traffic-observatory/bin/traffic-report today`
- `./modules/traffic-observatory/bin/traffic-report channel-c`
- `./modules/traffic-observatory/bin/traffic-report yesterday`
- `./modules/traffic-observatory/bin/traffic-report week`
- `./modules/traffic-observatory/bin/traffic-daily-report`

`modules/traffic-observatory/bin/live-check` remains a compatibility wrapper,
but the canonical live A/B/C health owner is
`./modules/ghostroute-health-monitor/bin/live-check`.

## Runtime Storage & Artifacts

- Router traffic counters and snapshot files.
- Local report output on stdout.
- Optional local `reports/` artifacts when called by health/report workflows.

## Dependencies On Other Modules

- Routing Core installs and invokes router counter scripts.
- Shared helpers provide router connection and device-label redaction.
- Health Monitor consumes traffic summaries for health snapshots.

## Failure Modes

- Stale traffic snapshots.
- Missing counter chains after firewall restart.
- Device labels unavailable, causing redacted or unknown labels.
- Managed traffic visible on the wrong exit path.

## Tests

- Covered by `./tests/run-all.sh`, `modules/traffic-observatory/tests/test-router-rollups.sh`
  and health/report fixture tests.
- Live behavior is confirmed by `./verify.sh` and traffic report smoke checks.

## Related Docs

- `modules/traffic-observatory/docs/traffic-observability.md`
- `modules/traffic-observatory/docs/llm-traffic-runbook.md`
- `modules/routing-core/docs/network-flow-and-observer-model.md`
