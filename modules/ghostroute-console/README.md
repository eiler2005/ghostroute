# GhostRoute Console

Factual web console for the existing GhostRoute operational modules.

This module lives inside `router_configuration` on purpose: Console is a
consumer of module-owned reports, not a second source of truth. It reads JSON
snapshots from Traffic Observatory, Health Monitor and DNS/Catalog Intelligence,
stores them locally, and renders a factual dashboard. The live slice also reads
real router log tails through a restricted `live-events-report --json` command
and appends the resulting DNS/flow/route events to SQLite.

Architecture details live in
[`docs/ghostroute-console-architecture.md`](/docs/ghostroute-console-architecture.md).

The current post-MVP slice adds route explanation, channel attribution,
append-only live events, controlled catalog review actions, notifications
settings, budget history and audited ops actions. It still does not mutate
router runtime or deploy catalog changes implicitly.

## Public Commands

```bash
./modules/ghostroute-console/bin/ghostroute-console dev
./modules/ghostroute-console/bin/ghostroute-console build
./modules/ghostroute-console/bin/ghostroute-console collect-once
./modules/ghostroute-console/bin/ghostroute-console doctor
./modules/traffic-observatory/bin/live-events-report --json --limit 200
```

## Safety Boundaries

- Runtime-safe by default: no router deploy, no hidden service restart, no
  direct catalog deploy.
- Controlled actions require explicit confirmation and write audit records.
- Catalog apply prepares a local patch/rollback reference; router deploy remains
  a separate operator action.
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

Real live tail collection is enabled with `GHOSTROUTE_LIVE_MODE=poll` plus
`GHOSTROUTE_LIVE_COLLECTOR_MODE=ssh|local`. If the live collector mode remains
`disabled`, `/api/live/stream` still serves the stored append-only events from
snapshots.

## Post-MVP Interfaces

- `/traffic` and `/traffic/[id]` explain route decisions with channel, route,
  DNS/catalog/sing-box evidence, site/operator views and gated raw evidence.
- `/api/live/stream` exposes Server-Sent Events for live DNS/flow/route/alert
  updates from append-only real log events, with polling fallback in the UI.
- `/api/actions/catalog/*` implements review, dry-run, apply preparation and
  rollback recording.
- `/api/notifications/*` stores notification settings and supports ack/snooze
  actions without storing delivery secrets.
- `/api/actions/ops` records controlled ops actions such as collect/report
  refresh and collector restart requests.
