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
Monitoring semantics live in
[`docs/monitoring-principles.md`](docs/monitoring-principles.md).

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
./modules/ghostroute-console/bin/ghostroute-console collect-light
./modules/ghostroute-console/bin/ghostroute-console doctor
./modules/traffic-observatory/bin/traffic-summary --json today
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
  uses a dedicated Caddy HTTPS listener on a non-443 port, backed by a tiny local
  buffering proxy, so Console does not share the Reality/layer4 `:443` listener.
  Tailnet-only access through `tailscale serve` remains a valid hardening
  option, but it is not required for the MVP.

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
The dedicated public listener is owned by Caddy and proxies to
`/usr/local/bin/ghostroute-console-buffer-proxy` on the VPS. Legacy nginx files
may remain on disk but should be stopped when Caddy owns the Console port.
The Caddy listener is pinned to HTTP/1.1 and HTTP/2 so browsers do not try
HTTP/3/QUIC on the dedicated Console port. Provider-level firewalls must allow
the configured public TCP port; host UFW alone is not enough if the cloud
firewall drops packets before they reach the VPS.

Operator-local client identity is stored in the same data directory as
`device-attribution.json`. It is intentionally gitignored runtime data: Console
uses it as the private authoritative client registry for stable labels, roles,
primary channel and explicit Channel A/B/C/LAN aliases. Dashboard, Traffic
Explorer, Clients, Live, Budget, Reports, Settings and JSON endpoints all pass
raw rows through the same resolver before grouping or rendering client names.
Raw evidence still keeps the observed labels separately. New or unmatched
`mobile-source-*` counters remain diagnostics until the operator adds an
explicit profile, MAC or IP alias.
Registry entries may also define a physical `device_key`, `device_label`,
`owner` and `device_type`. The Clients page renders that physical Device
Inventory first, then lists observed identities such as Channel A/B/C profiles,
LAN host ids, MAC/IP aliases and report-local redacted labels as evidence for
the selected device.
Home Reality report-local aliases such as `mobile-client-N` or
`report-mobile-profile-N` are not stable client identities. When a row carries a
stable `profile` such as `iphone-N`, Console resolves and aggregates by that
profile/registry entry and keeps the redacted report alias only as evidence.
`traffic-report` JSON rows carry evidence-contract fields such as
`canonical_hint`, `observed_label`, `redacted_label`, `identity_type`,
`matched_by`, `bytes_confidence`, `allocation_basis`, `counter_scope`,
`destination_class`, `destination_evidence` and `flow_group_key`. Console treats
these fields as evidence hints, while private ownership and physical-device
grouping remain in the operator-local registry.

Real live tail collection is enabled with `GHOSTROUTE_LIVE_MODE=poll` plus
`GHOSTROUTE_LIVE_COLLECTOR_MODE=ssh|local`. If the live collector mode remains
`disabled`, `/api/live/stream` still serves the stored append-only events from
snapshots.

The VPS deployment defaults to read-only SSH collection through the generated
`ghostroute_readonly` forced-command key:

- lightweight current-day traffic summaries every 5 minutes for Dashboard KPI
  cards;
- full snapshots every 30 minutes during 07:00-23:59 Moscow time;
- full snapshots every 3 hours during 00:00-06:59 Moscow time;
- live event polling every 10 minutes by default.

Traffic-driven UI surfaces use one selected traffic window at a time. The
default `today` window means the operator-local day, from Moscow midnight to the
latest collected traffic window. Dashboard, Traffic Explorer and Clients do not
borrow stale historical traffic totals when the current-day window is empty.
Clients still keeps historical inventory metadata for names, roles, aliases and
last-seen state, but the displayed traffic totals, route split and selected
client domains come from the selected window only. Because detailed snapshots
can be cumulative, Console derives current-window client rows from positive
deltas between same-day samples per observed source, then aggregates those
sources into the canonical registry client and reconciles them to the
authoritative `traffic-summary`/`traffic` KPI totals before rendering Dashboard,
Traffic Explorer and Clients. This prevents several cumulative snapshots or
Channel A/B/C aliases from being summed into impossible Top clients or Top
destination totals.
For selected-client details, Console derives an activity series from sequential
current-window device snapshots. Multiple snapshots become hourly deltas; if a
client only appears in one current snapshot, the chart shows that hour as a
snapshot total rather than pretending to know the earlier peak time.

Retention defaults are intentionally small enough for a 40 GB VPS: raw factual
snapshots are kept for 7 days, live raw snapshots for 6 hours, hourly aggregates
for 30 days, and SQLite safety backups are daily with at most 2 recent files.
The live collector stores normalized events in SQLite; the per-poll raw JSON is
only short-term troubleshooting material. Live views show event snapshots and
client activity summaries, not a continuous per-second stream.

The Console header shows the runtime/data source and build marker on every page:
`local dev data` or `VPS/runtime data`, the short build commit, and the latest
`traffic` / `traffic_summary` snapshot timestamps. `/api/health` exposes the
same metadata under `runtime` so deploy-vs-data differences can be checked
without opening the GUI.

Freshness uses the same cadence: stale after 75 minutes during the day and
after 210 minutes overnight.

The public Console URL uses the configured dedicated HTTPS port, not bare
`:443`; bare `:443` remains reserved for the existing Reality/layer4 surface
and may intentionally return 404 for the Console hostname.

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

## Local Checks

```bash
cd modules/ghostroute-console/app
npm test
npm run test:e2e
npm run test:perf
```

`test:perf` warms the local Playwright dev server, then checks that the main
Console pages render within 2.5 seconds and key JSON APIs respond within 1.5
seconds.
