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
known-device history, scheduled read-only collection, append-only live events,
controlled catalog review actions, notifications settings, budget history and
audited ops actions. It still does not mutate router runtime or deploy catalog
changes implicitly.

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
- Runtime access is protected by Basic Auth. The public read-only deployment
  uses a dedicated HTTPS listener on a non-443 port, backed by nginx and a tiny
  local buffering proxy, so Console does not share the Reality/layer4 `:443`
  listener. Tailnet-only access through `tailscale serve` remains a valid
  hardening option, but it is not required for the MVP.

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
The dedicated public listener uses `/opt/ghostroute-console/nginx/nginx.conf`
and `/usr/local/bin/ghostroute-console-buffer-proxy` on the VPS.

Real live tail collection is enabled with `GHOSTROUTE_LIVE_MODE=poll` plus
`GHOSTROUTE_LIVE_COLLECTOR_MODE=ssh|local`. If the live collector mode remains
`disabled`, `/api/live/stream` still serves the stored append-only events from
snapshots.

The VPS deployment defaults to read-only SSH collection through the generated
`ghostroute_readonly` forced-command key:

- full snapshots every 30 minutes during 07:00-23:59 Moscow time;
- full snapshots every 3 hours during 00:00-06:59 Moscow time;
- live log-tail polling every 15 seconds.

Freshness uses the same cadence: stale after 75 minutes during the day and
after 210 minutes overnight.

Router access for this collector is runtime-secret only. Clean deploys should
store `ghostroute_router_remote_host`, `ghostroute_router_remote_port`,
`ghostroute_router_remote_user` and `ghostroute_router_remote_private_key` in
`ansible/secrets/stealth.yml` (Ansible Vault). Operator workstations may use the
gitignored fallback key under `secrets/router-remote-ssh/`, but the key is never
tracked and is copied only to `/opt/ghostroute-console/router-ssh/` on the VPS.

VPS egress identity is configured explicitly with
`GHOSTROUTE_VPS_EGRESS_IP`, `GHOSTROUTE_VPS_EGRESS_ASN` and
`GHOSTROUTE_VPS_EGRESS_COUNTRY`. Console does not infer egress IP/ASN/country
from the public Console URL.

## Post-MVP Interfaces

- `/traffic` and `/traffic/[id]` explain route decisions with channel, route,
  DNS/catalog/sing-box evidence, site/operator views and gated raw evidence.
- `/clients` shows all known devices with `Online`, `Recently seen` or
  `Inactive` state and last-seen timestamps, so devices do not disappear just
  because they are absent from today's latest snapshot.
- `/api/live/stream` exposes Server-Sent Events for live DNS/flow/route/alert
  updates from append-only real log events, with polling fallback in the UI.
- `/api/actions/catalog/*` implements review, dry-run, apply preparation and
  rollback recording.
- `/api/notifications/*` stores notification settings and supports ack/snooze
  actions without storing delivery secrets.
- `/api/actions/ops` records controlled ops actions such as collect/report
  refresh and collector restart requests.
