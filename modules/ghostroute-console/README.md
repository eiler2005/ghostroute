# GhostRoute Console

Read-only web console for the existing GhostRoute operational modules.

This module lives inside `router_configuration` on purpose: Console is a
consumer of module-owned reports, not a second source of truth. It reads JSON
snapshots from Traffic Observatory, Health Monitor and DNS/Catalog Intelligence,
stores them locally, and renders a factual dashboard.

## Public Commands

```bash
./modules/ghostroute-console/bin/ghostroute-console dev
./modules/ghostroute-console/bin/ghostroute-console build
./modules/ghostroute-console/bin/ghostroute-console collect-once
./modules/ghostroute-console/bin/ghostroute-console doctor
```

## MVP Boundaries

- Read-only only: no router deploy, no service restart, no catalog edit.
- No seed data in production UI. Empty snapshots render as empty states.
- JSON reports are the machine contract; Markdown remains for humans and LLMs.
- Runtime access is protected by the existing Caddy stack with Basic Auth for
  the current read-only deployment. Tailnet-only access through `tailscale
  serve` remains a valid hardening option, but it is not required for the MVP.

## Data Directory

Local development defaults to:

```text
modules/ghostroute-console/data/
```

VPS runtime uses:

```text
/opt/ghostroute-console/data
```

The collector writes raw JSON snapshots under `snapshots/` and an embedded
SQLite database at `ghostroute.db`.
