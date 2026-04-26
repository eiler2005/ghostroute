# GhostRoute Health Monitor Module Overview

## Purpose

GhostRoute Health Monitor is a read-only reliability module for router + VPS
health. It produces local sentinels, `status.json`, Markdown summaries, daily
digests and disk-based alert ledgers without changing production routing state.

## Architecture

- `router/` contains BusyBox-compatible router monitor scripts installed to
  `/jffs/scripts/health-monitor`.
- `vps/` contains VPS-side observer probes installed to
  `/opt/stealth/health-monitor`.
- `bin/` contains control-machine reports that merge router and VPS status.

## Contract

Probe and report scripts are read-only. They may write their own health state,
alerts and summaries, but they must not repair routing, restart services or
change catalogs without an explicit operator action outside the monitor.

## Commands And Storage

- Public wrappers: `scripts/router-health-report`,
  `scripts/ghostroute-health-report`, `scripts/health-monitor/*`.
- Router storage: `/opt/var/log/router_configuration/health-monitor`, fallback
  `/jffs/addons/router_configuration/health-monitor`.
- VPS storage: `/var/log/ghostroute/health-monitor`.
- Related docs: `docs/stealth-monitoring-implementation-guide.md`,
  `docs/stealth-monitor-runbook.md`, `docs/troubleshooting.md`.
- Tests: `modules/ghostroute-health-monitor/tests/*`, also exposed through
  `tests/test-health-monitor.sh` and `tests/test-vps-health-monitor.sh`.
