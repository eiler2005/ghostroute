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

The current observability v2 slice adds Flow Explorer read models, DNS Query
Log, Alarm Center, route explanation, channel attribution, known-device history,
scheduled read-only collection, append-only live events, controlled catalog
review actions, notifications settings, budget history and audited ops actions.
It still does not mutate router runtime or deploy catalog changes implicitly.

## Public Commands

```bash
./modules/ghostroute-console/bin/ghostroute-console dev
./modules/ghostroute-console/bin/ghostroute-console build
./modules/ghostroute-console/bin/ghostroute-console collect-once
./modules/ghostroute-console/bin/ghostroute-console collect-light
./modules/ghostroute-console/bin/ghostroute-console alarm-state --json get
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
  uses a dedicated nginx HTTPS listener on a non-443 port, backed by a tiny
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
The dedicated public listener defaults to nginx and proxies to
`/usr/local/bin/ghostroute-console-buffer-proxy` on the VPS. Caddy still owns
certificate storage and the separate Reality/layer4 surface. Legacy dedicated
Caddy Console blocks may remain only as rollback configuration and should be
removed or disabled while nginx owns the Console port. The dedicated Console
port is TCP/TLS only and uses nginx response compression plus a small TLS buffer
so larger HTML/JSON responses stay reliable over the operator network path;
browsers must not depend on HTTP/3/QUIC for Console access. Provider-level
firewalls must allow the configured public TCP port; host UFW alone is not
enough if the cloud firewall drops packets before they reach the VPS.

Operator-local client identity is stored in the same data directory as
`device-attribution.json`. It is intentionally gitignored runtime data: Console
uses it as the private authoritative client registry for stable labels, roles,
primary channel and explicit Channel A/B/C/LAN aliases. Dashboard, Traffic
Explorer, DNS Query Log, Clients, Live, Budget, Reports, Settings and JSON endpoints all pass
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
- deploy-gate snapshots with the full pass. CRIT output is stored even when the
  command exits non-zero, so Health Center can show the exact deploy blocker.

Collectors keep per-job locks to avoid duplicate runs and a short shared SQLite
writer lock only while storing snapshots and rebuilding read models. Stale locks
are recovered by PID; writer contention waits for up to 120 seconds before a
collector skips; startup light/live collection is serialized after the full
startup pass. The full snapshot timeout defaults to 15 minutes because it may
run several read-only reports in one pass. The observability read models are
bounded caches for the Console UI: by default they keep the most recent 5,000
flow rows, 20,000 DNS rows, 10,000 live DNS rows, 5,000 device rows and 2,000
alarm rows while raw snapshots remain under the normal retention policy.

Traffic-driven UI surfaces use one selected traffic window at a time. The
default `today` window means the operator-local day, from Moscow midnight to the
latest collected traffic window. Dashboard, Flow Explorer and Clients do not
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
Destination views share the `traffic-report --json`
`destination_attribution_coverage` contract. Concrete destination rows plus
explicit `Unknown/Unattributed ...` accounting buckets must add back to the
observed client/channel total for the selected window. The unknown buckets carry
real counter bytes, `destination_evidence=none` and
`allocation_basis=unattributed_bucket`; DNS-interest families remain
investigation hints and are not converted into byte accounting. Dashboard, Flow
Explorer, Clients and Live all read the same normalized accounting rows, so an
attribution gap is visible consistently instead of disappearing on one page and
looking like a mismatch on another.
Observability v2 also rebuilds additive SQLite read models after each
collection: `flow_sessions`, `dns_query_log`, `device_inventory`,
`alarm_events`, `read_model_state` and non-secret `console_settings`. These
tables feed `/api/flows`, `/api/dns`, `/api/alarms`, Flow Explorer, DNS Query
Log and Alarm Center while preserving the normalized source tables as the
fallback contract. The `flow_sessions` read model includes the safe DNS/SNI and
egress evidence fields needed by the Flow Explorer inline detail panel; missing
source evidence is rendered as `not observed`, not inferred.
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
The dedicated public listener defaults to nginx on the non-443 Console port and
proxies through the local Python buffering proxy to the Next.js container on
`127.0.0.1:3000`; Caddy still owns certificate storage and the separate
Reality/layer4 surface.

## Browser Loading Diagnostics

If `/health` or another Console page appears blank or takes much longer than
the usual first render, do not tune nginx, Caddy, Next.js or router runtime
blindly. First collect browser evidence, then compare it with the server-side
baseline. If the page is currently fast, leave runtime unchanged and treat the
existing `nginx -> buffer proxy -> Next.js` path as healthy.

Browser evidence:

- Chrome: open DevTools, use the Network panel, enable Preserve log and Disable
  cache, hard reload the page, then inspect the `Document`, `?_rsc`, JS chunks,
  CSS and API rows. Save a HAR/export if available; otherwise keep a waterfall
  screenshot and the names of stalled requests.
- Safari on macOS or iOS: use Web Inspector Network, reload the same page and
  compare whether the stalled resource is the HTML document, an RSC request,
  a static chunk or an API call. For iPhone, use Safari remote Web Inspector
  from the Mac before changing server config.

Classify the failure before changing anything:

- slow TTFB on the HTML document means a Console server/render/SQLite/snapshot
  issue is more likely.
- fast TTFB with slow download or a mid-body stall points to proxy, TLS,
  transport, MTU or client-path behavior.
- JS or CSS chunk failures point to static asset, auth, proxy or browser cache
  handling.
- hanging `?_rsc` requests point to Next.js App Router navigation/RSC behavior.
- fast API responses with stuck HTML point to HTML streaming, proxy buffering or
  client transport, not to the collector itself.

Server-side baseline:

```bash
# From the VPS:
curl -o /dev/null -sS -w 'ttfb=%{time_starttransfer} total=%{time_total} size=%{size_download}\n' \
  http://127.0.0.1:3000/health

curl -o /dev/null -sS -w 'ttfb=%{time_starttransfer} total=%{time_total} size=%{size_download}\n' \
  https://<console-host>:<console-port>/health

# From the operator workstation, with Basic Auth configured locally:
curl -o /dev/null -sS -w 'ttfb=%{time_starttransfer} total=%{time_total} size=%{size_download}\n' \
  -u '<console-user>:<console-password>' \
  https://<console-host>:<console-port>/api/health
```

Use the browser waterfall and these timings together: server-local fast plus
operator-browser slow means the next change belongs in the Console public
listener/proxy/client path, not in Channel A/B/C, managed DNS, sing-box or
router firewall.

References for this runbook: Chrome DevTools Network
(`https://developer.chrome.com/docs/devtools/network/overview`),
Safari/WebKit Web Inspector Network (`https://webkit.org/web-inspector/network-tab/`),
nginx proxy buffering (`https://nginx.org/en/docs/http/ngx_http_proxy_module.html`)
and Next.js App Router streaming
(`https://nextjs.org/learn/dashboard-app/streaming`) docs.

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

- `/` keeps the existing read-only operator overview and adds Dashboard traffic
  analytics above it: Traffic today, Top clients, Top destinations, monthly VPS
  usage, LTE reserve for mobile/selected-client traffic and a cumulative usage
  chart with VPS forecast. These cards are derived from `flow_sessions`; quota
  bars use `GHOSTROUTE_CONSOLE_VPS_QUOTA_*`,
  `GHOSTROUTE_CONSOLE_LTE_QUOTA_*` and
  `GHOSTROUTE_CONSOLE_BILLING_RESET_DAY`.
- `/traffic` is a read-only Flow Explorer workbench with KPI cards, a dense
  paged flow table and a right-side selected-flow detail panel keyed by
  `?flow=<flow-id>`. `/traffic/[id]` remains the share/export route
  explanation with client, destination, port, policy, route, duration, risk,
  DNS/catalog/sing-box evidence, site/operator views and gated raw evidence.
- `/traffic` keeps wide flow tables horizontally scrollable and treats
  category-only rows as aggregates in the route explanation instead of implying
  a concrete site saw the category label.
- `/dns` shows DNS Query Log rows with the resolved Console client label,
  observed client IP, millisecond event time, domain, answer IP, route decision,
  catalog status, status and risk context. It defaults to a compact first page;
  `/dns?page=&pageSize=` can page up to 500 rows for larger troubleshooting
  windows.
- `/catalog?page=&pageSize=` pages the read-only catalog snapshot up to 1,000
  rows per page; catalog review actions remain separate from runtime deploy.
- `/health` includes Alarm Center rows with severity, source, evidence,
  suggested action and status. Ack/snooze/reopen is stored as a narrow operator
  state overlay on the router at the Console alarm-state JSON path; it does not
  change routing, services or catalog runtime.
- `/health` also renders the latest deploy-gate snapshot. It is informational:
  Console does not run deploys, but it shows whether the current canary would
  block a mutating deploy.
- `/clients` shows all known devices with `Online`, `Recently seen` or
  `Inactive` state and last-seen timestamps, so devices do not disappear just
  because they are absent from today's latest snapshot.
- `/live?eventsPage=&eventsPageSize=&servicePage=&servicePageSize=` renders
  client and service/background live events separately, with millisecond event
  times and page sizes up to 500 rows.
- `/api/live/stream` exposes Server-Sent Events for live DNS/flow/route/alert
  updates from append-only real log events, with polling fallback in the UI.
- `/api/actions/catalog/*` implements review, dry-run, apply preparation and
  rollback recording.
- `/api/notifications/*` stores notification settings and supports ack/snooze
  actions without storing delivery secrets.
- `/api/actions/ops` records controlled ops actions such as collect/report
  refresh and collector restart requests.
- `/api/alarms/:id/(ack|snooze|open)` updates only the router-backed alarm
  state overlay and keeps derived `alarm_events` as factual snapshot evidence.
  It never mutates DNS, sing-box, dnsmasq or router firewall.
- `/settings` is a readonly runtime inventory: collectors, retention, read
  models, access posture, router profile status, safety gates and notification
  readiness are shown without exposing real endpoints, ports, users, keys or
  local device identifiers.

Mobile Safari/iPhone gets a separate ultra-light Console surface under `/m`.
Mobile requests for `/`, `/traffic`, `/dns`, `/clients`, `/live` and `/catalog`
redirect to `/m`, `/m/traffic`, `/m/dns`, `/m/clients`, `/m/live` and
`/m/catalog` unless `desktop=1` is present. The `/m` pages use the same
read-only snapshots and selectors, but render a single compact list per page,
cap page size to 25 rows, omit side panels/raw evidence/charts, and use plain
document links. Each mobile page includes a `Desktop version` link back to the
full workbench with `desktop=1`. No `m.` subdomain is used in v1, so nginx/TLS
and Basic Auth remain unchanged.

## Local Checks

GUI changes should be reviewed on a local seeded Console before any deploy. The
seeded database is synthetic, lives under the gitignored
`modules/ghostroute-console/data/gui-test/`, and gives Flow Explorer, DNS Query
Log, Dashboard analytics, Clients and Live enough rows to verify compact
tables, charts, filters, horizontal scroll, pagination and mobile-light
rendering without waiting for real snapshots. `dev:gui` and `test:e2e:gui` also
provide local-only default VPS/LTE quota env values unless the operator has
already set them.

Refresh that seeded data layer before local checks whenever GUI selectors,
read models, cache keys or page rendering change:

```bash
cd modules/ghostroute-console/app
npm run seed:gui
```

```bash
cd modules/ghostroute-console/app
npm run dev:gui
```

For automated browser checks against the same seeded database:

```bash
cd modules/ghostroute-console/app
npm test
npm run build
npm run test:e2e:gui
npm run test:perf
```

`test:perf` warms the local Playwright dev server, then checks that the main
Console pages render within 2.5 seconds and key JSON APIs respond within 1.5
seconds. It also clicks through the sidebar quickly to catch regressions where
one page rebuilds the full Console evidence model during navigation.

Release hardening:

- PR smoke uses the seeded GUI database across desktop and mobile Playwright
  projects; performance remains a manual/release gate.
- Collectors validate incoming JSON snapshots against tolerant versioned
  contracts. Unknown fields are preserved, but missing core fields are recorded
  as collector errors instead of being inserted as broken snapshots.
- Read-only derived selectors use a short in-process cache keyed by latest
  snapshot version, filters and pagination. The cache covers the heavy sidebar
  pages and is paired with browser-side route/API warmup after the first page
  loads.
- The source strip and `/api/health` expose both build commit and UTC build
  timestamp so operators can confirm which deployed container is serving the UI.
- The VPS read-only deploy builds the new Console image before replacing the
  running container, tags the prepared image with the build commit, passes the
  build timestamp into the app, and attempts rollback to the previous image if
  local health/UI/API smoke fails.
