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

## Architecture

- `bin/` contains local reporting commands.
- `router/` contains ASUS Merlin runtime collectors.
- Shared parsing and redaction helpers live in `modules/shared/lib`.

## Read-only / Mutating Contract

The module is read-only for routing policy. It mutates only its own accounting
counters and snapshot files on the router.

## Public Commands

- `./modules/traffic-observatory/bin/traffic-report`
- `./modules/traffic-observatory/bin/traffic-report today`
- `./modules/traffic-observatory/bin/traffic-report channel-c`
- `./modules/traffic-observatory/bin/traffic-report yesterday`
- `./modules/traffic-observatory/bin/traffic-report week`
- `./modules/traffic-observatory/bin/traffic-daily-report`

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

- Covered by `./tests/run-all.sh` and health/report fixture tests.
- Live behavior is confirmed by `./verify.sh` and traffic report smoke checks.

## Related Docs

- `modules/traffic-observatory/docs/traffic-observability.md`
- `modules/traffic-observatory/docs/llm-traffic-runbook.md`
- `modules/routing-core/docs/network-flow-and-observer-model.md`
