# GhostRoute Health Monitor Module Overview

## Purpose

GhostRoute Health Monitor is the read-only reliability module for the router +
VPS setup. It writes local sentinels, `status.json`, Markdown summaries, daily
digests and disk-based alert ledgers without changing production routing state.

## Features

- Router probes for sing-box, Reality paths, DNS leaks, rule-set drift and stale
  snapshots.
- VPS observer probes for Caddy, Xray, 3x-ui, disk pressure and recent Reality
  evidence.
- Local-only alert ledgers and merged control-machine reports.
- Rolling baseline learning for RTT and retransmit degradation.

## How It Works

Router and VPS probes emit JSONL evidence into their own runtime storage.
Aggregators turn that evidence into `STATUS_OK` / `STATUS_FAIL`, `status.json`
and `summary-latest.md`. The control-machine report reads both sides and can
save a merged operational report back to router runtime storage.

## Architecture

- `router/` contains BusyBox-compatible router monitor scripts.
- `vps/` contains VPS observer scripts.
- `bin/` contains local report commands.
- `tests/` contains fixture tests for router, VPS and merged report behavior.

## Read-only / Mutating Contract

Probes and reports are read-only relative to production routing. They may write
their own health state, alerts and summaries. They must not restart services,
edit catalogs, rotate secrets or repair routing without a separate explicit
operator action.

## Public Commands

- `./modules/ghostroute-health-monitor/bin/router-health-report`
- `./modules/ghostroute-health-monitor/bin/router-health-report --save`
- `./modules/ghostroute-health-monitor/bin/ghostroute-health-report`
- `./modules/ghostroute-health-monitor/bin/ghostroute-health-report --save`
- Runtime-only router command: `/jffs/scripts/health-monitor/run-once`

## Runtime Storage & Artifacts

- Router primary: `/opt/var/log/router_configuration/health-monitor`
- Router fallback: `/jffs/addons/router_configuration/health-monitor`
- VPS: `/var/log/ghostroute/health-monitor`
- Local generated reports: `reports/`

## Dependencies On Other Modules

- Routing Core supplies the runtime hooks and rule-set state.
- Traffic Observatory supplies traffic context for router health reports.
- DNS & Catalog Intelligence supplies catalog capacity and drift evidence.
- Recovery & Verification is used for live confirmation.

## Failure Modes

- `STATUS_FAIL` or stale `summary-latest.md`.
- Reality path unavailable on router or VPS.
- DNS/plain port 53 leak, IPv6 drift or direct traffic leak.
- Rule-set drift or catalog freshness problems.

## Tests

- `./modules/ghostroute-health-monitor/tests/test-health-monitor.sh`
- `./modules/ghostroute-health-monitor/tests/test-vps-health-monitor.sh`
- `./tests/run-all.sh`

## Related Docs

- `docs/stealth-monitoring-implementation-guide.md`
- `docs/stealth-monitor-runbook.md`
- `docs/troubleshooting.md`
