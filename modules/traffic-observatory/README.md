# Traffic Observatory Module Overview

## Purpose

Traffic Observatory provides day-to-day usage and routing reports for WAN,
LAN/Wi-Fi, Home Reality QR clients, popular destinations and split-routing
mistakes.

## Architecture

Control-machine reports live in `bin/`. Router-side collectors and counter
snapshots live in `router/` and are installed to the existing `/jffs/scripts/*`
paths so cron and Merlin hooks remain stable.

## Contract

The module is read-only except for its own accounting counters and snapshots.
It must not change routing policy or managed catalogs.

## Commands And Storage

- Public wrappers: `scripts/traffic-report`, `scripts/traffic-daily-report`,
  traffic collector wrappers in `scripts/*traffic*` and `scripts/*counters*`.
- Router artifacts: traffic counter chains and daily snapshot files.
- Related docs: `docs/traffic-observability.md`,
  `docs/llm-traffic-runbook.md`.
- Tests: covered through traffic fixtures consumed by router-health and live
  report smoke checks.
