# GhostRoute Console Architecture

GhostRoute Console is a factual read-only observability surface inside the
`router_configuration` repository. It consumes module-owned JSON reports and
router log-tail evidence; it is not a routing engine and must not become a
second source of truth for router runtime state.

## Architecture At A Glance

This is the current Console v1 data path. It is intentionally documented as a
plain text model because the read-model and cache layer will continue to evolve.

```text
Layer 0 source modules
  Traffic Observatory
    -> traffic-summary --json today
    -> traffic-evidence --json <period>
    -> traffic-facts --json <period>
    -> router_rollups snapshots
    -> traffic-report for human/debug only

  Health Monitor
    -> router-health-report --json
    -> leak-check --json
    -> deploy-gate snapshot evidence

  DNS / Catalog Intelligence
    -> domain-report --json
    -> dns-forensics-report --json

  Sanitized routing policy snapshot
    -> policy-snapshot.local.json from operator/Ansible context
    -> selected Home Wi-Fi/LAN full-VPS clients and Channel A/B/C profile policy

  Router log-tail evidence
    -> live-events-report --json --since <cursor> --limit N
    -> sing-box / dnsmasq / domain-activity event rows

Layer 1 collector
  ghostroute-console collect-once
    -> runs read-only module commands
    -> stores raw JSON snapshots under data/snapshots/
    -> records collector errors instead of publishing invalid snapshots
    -> rebuilds bounded SQLite read models
    -> rebuilds prepared today/week/month traffic windows
    -> prunes short-lived operational raw rows after prepared data exists

  ghostroute-console collect-light
    -> refreshes frequent current-day traffic summary cards
    -> avoids the full detailed report cost

  collect-live-once
    -> ingests recent read-only log-tail events
    -> advances live_cursors
    -> keeps raw live payloads short-lived

Layer 2 normalized storage
  raw snapshots
    -> factual source payloads with retention

  normalized source tables
    -> normalized_flows
    -> normalized_dns
    -> normalized_events
    -> normalized_health
    -> normalized_catalog / settings / metadata

  append-only live tables
    -> events
    -> route_decisions
    -> live_cursors

Layer 3 UI read models
  flow_sessions
    -> Dashboard route accounting from traffic_facts
    -> Flow Explorer rows and selected-flow detail
    -> Clients traffic windows
    -> Live client activity summary

  dns_query_log
    -> DNS Query Log
    -> DNS-interest evidence

  device_inventory
    -> Clients physical inventory
    -> owner/profile/channel attribution
    -> selected-device detail

  alarm_events
    -> Alarm Center
    -> ack/snooze/open state overlay

  client_traffic_5min / client_traffic_hourly / client_traffic_daily
    -> prepared client-first traffic aggregates
    -> Dashboard, Clients, Budget and historical traffic windows
    -> incremental dirty-window rollup after initial backfill

  dns_log_5min
    -> prepared DNS query aggregates
    -> DNS Query Log and DNS-interest counts

  top_clients_window / top_destinations_window
    -> pre-ranked today/week/month lists

  traffic_window_snapshots
    -> prepared dashboard, client, DNS and report payloads
    -> no raw scans for week/month request paths

  client_traffic_by_lane / client_destination_by_lane
    -> client-centric lane summary and destination detail
    -> GUI-ready All / Client / Service / Privacy / Shared / Unknown views
    -> rebuilt from traffic aggregates and destination enrichment

  client_route_evidence_defects
    -> route-proof diagnostics by client and destination
    -> separates content classification from VPS/Direct proof gaps

  ip_prefix_catalog / ip_enrichment_cache
    -> optional local-first IP/provider enrichment cache
    -> advisory metadata only; no route or blocking decisions

  console_page_summaries
    -> health_shell
    -> health_mobile
    -> live_mobile
    -> capped prepared payloads for fast Health/Live/mobile request paths

  read_model_state
    -> source versions
    -> rebuild timestamps
    -> cache keys

  destination_enrichment
    -> local Traffic Intelligence labels and explanations
    -> client / personal_cloud / service_background / unclassified

  decision_candidates
    -> advisory review actions
    -> dry-run only; applied=0 in this phase

Layer 4 request-time cache
  in-process derived selector cache
    -> keyed by read_model_state / lightweight snapshot metadata
    -> short TTL, default 300 seconds
    -> bypassed or cleared for action/state-changing endpoints
    -> disabled with GHOSTROUTE_CONSOLE_DERIVED_CACHE_TTL_MS=0

Layer 5 public interfaces
  Full Console
    -> / dashboard analytics and status overview
    -> /traffic Flow Explorer workbench
    -> /dns DNS Query Log
    -> /intelligence Traffic Intelligence review
    -> /clients Device Inventory
    -> /health Health Center, Alarm Center, Deploy Gate, leaks
    -> /live event snapshots and client activity
    -> /catalog read-only catalog review
    -> /budget quota posture
    -> /reports stored reports
    -> /settings runtime inventory, routing policy and safety gates

  Mobile Console
    -> /m compact ops summary
    -> /m/traffic lightweight flow list
    -> /m/dns lightweight DNS list
    -> /m/clients lightweight clients list
    -> /m/health raw no-JS health triage
    -> /m/live compact event stream
    -> /m/catalog lightweight catalog list
    -> /m/settings compact routing policy and runtime posture

  JSON APIs
    -> /api/health
    -> /api/flows
    -> /api/dns
    -> /api/clients
    -> /api/live
    -> /api/alarms

Layer 6 deployment/access
  Browser
    -> dedicated Console HTTPS port with Basic Auth
    -> nginx listener
    -> local buffering proxy
    -> Next.js container on 127.0.0.1:3000
    -> SQLite data directory

  Safety invariant
    -> Console renders prepared facts
    -> Traffic Intelligence never changes accounting or routing
    -> Console does not deploy router/VPS runtime from review pages
    -> controlled actions prepare audited operator artifacts only
```

`traffic_facts` is the authoritative accounting source for prepared Dashboard,
Clients and Flow Explorer totals. `router_rollups` remains useful as bounded
router-side evidence and as a fallback when no `traffic_facts` rows exist for a
window, but it must not override v3 fact bytes or route split when facts are
available.

## Data Sources

Console reads machine-readable JSON from existing operational modules:

- `traffic-summary --json today` for frequent current-day Dashboard traffic
  cards without destination analytics.
- `traffic-evidence --json <period>` for raw machine evidence: flow samples,
  Home Reality profile-counter deltas, DNS queries/answers, route evidence and
  warnings.
- `traffic-facts --json <period>` for the authoritative v3 accounting contract:
  traffic facts, DNS links, attribution gaps, route status and byte split.
- router rollup snapshots for prepared aggregate windows.
- `router-health-report --json` and `leak-check --json` for health, leak and
  egress identity evidence.
- `domain-report --json` and `dns-forensics-report --json` for catalog, DNS
  interest and query-window evidence.
- `policy-snapshot.local.json`, or `GHOSTROUTE_CONSOLE_POLICY_SNAPSHOT_PATH`,
  for sanitized Settings display of selected Home Wi-Fi/LAN full-VPS clients
  and Channel A/B/C profile policy. This file is operator/Vault-derived data,
  stays gitignored, and must not contain raw MAC/IP/DNS values.
- `live-events-report --json --since <cursor> --limit N` for read-only log-tail
  events from `sing-box.log`, `dnsmasq.log` and `domain-activity.log`.

Markdown report output remains human-facing. Console must not parse Markdown as
an application contract.

`traffic-report` remains runnable for operator/debug workflows, but it is not a
new Console machine source. New accounting/read-model work must start from
`traffic-facts --json` and the SQLite pyramid/read models.

## Evidence And Intelligence Model

The canonical route evidence shape is assembled in Console from normalized
rows. A route explanation can include:

- client/device and client IP;
- access channel: Home Wi-Fi/LAN, Channel A, Channel B, Channel C or Unknown;
- destination, destination IP/port, protocol, TLS/SNI;
- DNS qname and answer IP;
- matched catalog/rule-set evidence;
- sing-box outbound and route decision;
- visible egress IP, ASN and country when the source proves it;
- confidence: `exact`, `estimated`, `dns-interest`, `unknown` or `mixed`;
- raw evidence refs gated behind explicit UI disclosure/export.

If a source does not prove a field, Console should show `not observed` or an
estimated confidence note rather than fabricating a value.

The authoritative accounting source is `traffic_facts`. It owns bytes,
`via_vps_bytes`, `direct_bytes`, `unknown_bytes`, route intent, route
verification, route status, DNS link confidence and DNS timestamp status.
Every normal traffic fact must preserve the invariant
`bytes = via_vps_bytes + direct_bytes + unknown_bytes`.

Traffic Intelligence is a separate interpretation layer above those facts. It
reads traffic facts and DNS links, then writes local deterministic labels into
`destination_enrichment` and dry-run review rows into `decision_candidates`.
Those rows can power the `/intelligence` GUI, coarse `trafficClass` filters,
fine categories, action hints and human explanations. They must not alter fact
bytes, route verification, DNS confidence, managed-domain policy, filter rules
or router/VPS state.

Home Reality byte totals remain anchored to observed encrypted ingress profile
counter deltas. When matching `sing_box_route_evidence` exists for the same
profile, `traffic-facts` may split that exact counter total into estimated
per-destination facts using connection share. These rows keep
`dns_status=no_match`, use `destination_confidence=sing_box_destination`, and
must be presented as estimated attribution rather than DNS proof. If no
destination evidence exists, the pipeline keeps the trusted residual
`Home Reality ingress` counter fact.

The Traffic Intelligence GUI axes are:

- `traffic_lane`: `client_observed`, `service_system`, `privacy_risk`,
  `shared_infra` or `unknown_review`.
- `dns_category`: local purpose/category such as `personal_cloud`,
  `system_push`, `analytics`, `cdn_shared` or `unknown_ip_only`.
- `decision_hint`: advisory only (`allow`, `monitor`, `block_candidate`,
  `route_vps_candidate`, `direct_candidate`, `investigate`, `ask_user`).

The status fields are deliberately split:

- `accounting_status`: `ok` or `accounting_error`.
- `route_status`: `verified`, `counter_allocated`, `intent_only`, `mismatch`
  or `unknown`.
- `dns_status`: `exact`, `shared`, `no_match` or `approximate_ts`.
- `dns_ts_source`: `parsed_log` or `snapshot_approx`.

Optional enrichment providers are future advisory inputs for unknown/IP-only
destinations; they are not part of the primary client-vs-service classifier and
must remain disabled-by-default unless a separate privacy/review design enables
them.

VPS egress identity is an explicit source, not an inference from the public
Console URL. Operators configure it through `GHOSTROUTE_VPS_EGRESS_IP`,
`GHOSTROUTE_VPS_EGRESS_ASN` and `GHOSTROUTE_VPS_EGRESS_COUNTRY`; the health
report can then expose it as factual evidence. If those values are missing,
Console shows a compact setup hint instead of synthetic IP/ASN/country data.

Route detail pages use best-evidence enrichment, but the Traffic Explorer table
is an operator traffic view by default. It shows traffic rows with meaningful
client labels and observed traffic bytes/counters. Technical zero-byte live
events, unknown-client `sing-box` rows, latency-like pseudo-clients and
router/self/service destinations are classified as diagnostics and hidden from
the default table. They remain available behind `?diagnostics=1` and in raw
evidence/live views.

Exact live route decisions can enrich a traffic row when they correlate by
destination/DNS/client evidence. They must not replace the traffic row as the
primary UI object when they only prove `rule/outbound/time/destination IP` and
do not prove client traffic or bytes.

Dashboard, Traffic Explorer and Clients share the same selected traffic window.
Source timestamps are stored in UTC, while UI windows are keyed by the
operator-local Moscow day. For the default `today` period, the window runs from
Moscow `00:00` to the latest collected traffic snapshot; `week` covers the
current Moscow day plus the previous six days; `month` starts at the first
Moscow day of the month. Historical known-device rows may enrich inventory labels
and roles, but they must not contribute traffic totals, top clients,
selected-client domains or route split values outside the selected window. If no
prepared current-window traffic exists, traffic views should show an empty state
instead of presenting stale bytes as today's data.

Traffic snapshots can contain retained evidence tails and cumulative counters.
Console therefore does not sum multiple same-day snapshots as independent
traffic rows. `traffic-evidence` first cuts flow/DNS rows to the requested
window; `traffic-facts` then emits one normal fact per flow sample plus explicit
attribution gaps. Current client/device views use the prepared factual rows and
rollups for the selected window. Destination rows follow the same rule: a
generic category can enrich a row as class/type, but concrete destinations need
DNS/SNI/domain/IP evidence. When attributed destinations cover only part of the
client/device counter total, `traffic-facts --json` emits `attribution_gaps`
with residual bytes. Those rows carry real counter bytes and no destination
evidence, so Dashboard, Flow Explorer, Clients, Live and API selectors can all
show the same complete accounting total without pretending that DNS-interest
hints prove per-site bytes.

Traffic UI must also explain operator-facing terms in-product:

- `VPS`, `Direct`, `Mixed` and `Unknown` describe the final route decision.
  Dashboard accounting still renders `Mixed` rows as a byte split: total traffic
  must equal the sum of proved VPS bytes, proved Direct bytes and residual
  Unknown bytes.
- `Home Wi-Fi/LAN`, `Channel A`, `Channel B` and `Channel C` describe the
  access/client lane.
- `exact`, `estimated`, `dns-interest`, `mixed` and `unknown` describe source
  confidence, not product success/failure.
- `Traffic row` means client traffic; `Evidence event` means a technical log
  event that may have no bytes or client attribution.
- `not observed` means the current JSON/log source did not contain that field.

## Storage Flow

The collector stores raw JSON snapshots under `data/snapshots/` and normalizes
them into SQLite. Schema v4 adds source-evidence fields to flows, DNS rows,
events and route decisions:

- `client_ip`, `destination_ip`, `destination_port`;
- `dns_qname`, `dns_answer_ip`, `sni`;
- `outbound`, `matched_rule`, `rule_set`;
- `egress_ip`, `egress_asn`, `egress_country`;
- `event_ts`, `ts_confidence`, `source_log`, `event_id`.

Schema v6 carries the safe flow evidence subset from `normalized_flows` into the
bounded `flow_sessions` read model as well: `dns_qname`, `dns_answer_ip`, `sni`,
`egress_ip`, `egress_asn`, `egress_country` and `ts_confidence`. Flow Explorer
uses those fields for its inline detail panel and still shows `not observed`
when an upstream report did not prove a value.

Schema v7 adds `console_page_summaries`, a page-scoped prepared summary table
for operational shells that should never rebuild the full desktop model on the
request path. The collector/read-model rebuild writes `health_mobile`,
`health_shell` and `live_mobile` summaries with capped arrays for status cards,
active alarms, Deploy Gate checks, health probes and leak evidence. Mobile
Health reads that single prepared JSON row; if it is absent, it renders a
minimal fallback instead of parsing raw snapshots.

Schema v8 adds the prepared traffic-window layer:
`client_traffic_5min`, `client_traffic_hourly`, `client_traffic_daily`,
`dns_log_5min`, `top_clients_window`, `top_destinations_window` and
`traffic_window_snapshots`. These tables are rebuilt by the collector from
normalized evidence and then read by Dashboard, Clients, DNS and safe report
APIs for `today`, `week` and `month`. Week/month request paths must not scan
`normalized_flows`, `normalized_dns`, `events` or raw snapshot payloads. The
temporary rollback switch is `GHOSTROUTE_CONSOLE_USE_PREPARED_WINDOWS=0`, but
the steady-state large-database contract is prepared-window reads only.
The detailed anti-warehouse-rebuild contract is documented in
[data-pyramid.md](/modules/ghostroute-console/docs/data-pyramid.md).

Schema v15 is the current guard for the trustworthy v3 pipeline and the local
Traffic Intelligence read model. It ensures factual tables carry the v3
route/DNS/accounting fields (`intended_route`, `route_status`, `dns_status`,
`dns_ts_source`, detailed DNS link columns) and keeps interpretation outside
`traffic_facts` in `destination_enrichment` / `decision_candidates`, including
`traffic_lane` and `dns_category` for GUI review grouping. Fresh and migrated
databases must converge to the same columns and indexes.

Schema v16 adds the client lane data layer. `client_traffic_by_lane` is a
materialized client/lane summary, and `client_destination_by_lane` is the
matching destination detail for drilldown. Both are rebuildable caches derived
from `client_destination_traffic_*`, `destination_enrichment` and the optional
`ip_enrichment_cache`; they are not a second source of truth. The synthetic
`traffic_lane = 'all'` rows are aggregate convenience rows for GUI filters.
When a destination has no classification, it lands in
`unknown_review / unknown_ip_only|unknown_domain / ask_user`.
`client_route_evidence_defects` is the sibling diagnostics table for route
proof quality and keeps affected destination addresses/domains with
`unknown_route` and `intent_only_*` buckets. Review exports are local files
under gitignored Console data and are meant for offline/LLM classification, with
the GUI acting as a viewer/filter rather than a manual per-flow labeling tool.
The Clients page consumes these lane and route-evidence read models directly:
content lanes answer "what kind of traffic is this?", while route evidence
answers "how well was VPS/direct proven?".
Below the inventory, the selected-client popular-sites panel reads the same
destination layer and splits byte-attributed destinations into client traffic
and service/system traffic. DNS-interest rows are rendered in a separate
selected-device panel and are never converted into byte-ranked popular sites.

Destination presentation is intentionally split from raw evidence. Default
HTML views render DNS/SNI/domain, platform or category labels first and collapse
IP-only rows to a type or provider/source label when local IP-ASN enrichment is
available. Raw IP addresses remain in DNS answer columns, route diagnostics,
exports and raw evidence, but are not primary destination labels or Top
destinations. Channel/accounting labels such as Home Reality ingress describe
ingress context and are excluded from destination rankings. During import and
read-model rebuilds, concrete `dns_qname`, SNI, explicit domain and DNS-link
evidence wins over pseudo labels such as `not observed`, `Client` or `Home
Reality ingress`; if no concrete evidence exists, the pseudo label can remain
as route context but not as a ranked destination.

Append-only live events use `events`, `route_decisions` and `live_cursors`.
`event_id` is used for idempotent live-tail ingestion.

Clients are shown as a known-device inventory, not only a latest-snapshot
active list. Console keeps historical device rows, preserves the last known
channel when a newer source is weaker, and displays status as `Online`,
`Recently seen` or `Inactive` with a short last-seen timestamp.
The inventory key is the operator-local physical `device_key` when present, so
multiple observed identities can collapse into one physical device row. Raw
snapshot labels such as Channel A/B/C profiles, LAN host ids, MAC/IP aliases and
redacted report-local labels remain available as observed identities in the
detail panel and raw evidence.
Traffic columns inside Clients are window-scoped: the inventory row may remain
visible with `0 B` when the device has no traffic in the selected period.
Selected-client activity charts are derived from the same window-scoped device
snapshots. They use positive deltas between sequential cumulative samples when
available; a single sample is rendered as a snapshot total so the UI does not
invent a peak time that the collector did not observe.
Traffic Observatory reports do not encode private ownership. They expose
evidence-contract fields such as `canonical_hint`, `identity_type`, `matched_by`,
`bytes_confidence`, `allocation_basis`, `counter_scope`, `destination_class`,
`destination_evidence` and `flow_group_key` so Console can explain why a row was
grouped or estimated while still resolving owner/device names privately.

## Live Tail

The first production-safe live mode is cursor polling, not a long-lived remote
shell tail:

1. `collect-live-once.mjs` calls `live-events-report --json`.
2. The report reads only recent router log lines and emits stable events.
3. Console normalizes those events into SQLite.
4. `/api/live/stream` streams recent SQLite events over Server-Sent Events.
5. The UI falls back to stored snapshot/events if live collection is disabled.

Raw live JSON snapshots are retained only briefly (`GHOSTROUTE_LIVE_RAW_RETENTION_HOURS`,
default 6h) because live polling can create thousands of files per day. The
durable contract is the normalized SQLite event tables, while raw live payloads
are short-term troubleshooting evidence. Full local SQLite backups are disabled
by default on the VPS; `GHOSTROUTE_DB_BACKUP_MODE=local_daily` is the explicit
opt-in for same-disk daily safety copies. In disabled mode, retention removes
existing local full DB copies. When enabled, retention enforces both max count
and max total bytes, migrates legacy root-level
`ghostroute.db.backup-*` files into the managed backup set, and skips creating a
new copy if free disk or used-percent guards would be violated.

Operational pruning keeps `normalized_flows`, `normalized_dns`, `events`,
`route_decisions` and `collector_errors` inside their retention windows.
Service/background traffic may be pruned sooner than client traffic. Fine
5-minute traffic buckets are short-lived; hourly/daily traffic aggregates and DNS
aggregates are retained around the monthly UI window. Heavy `traffic`, `dns` and
`live` snapshot payloads can be stripped after the short troubleshooting window
once a newer payload of the same type exists; the UI history then lives in
aggregate/read-model tables.

Runtime switches:

- `GHOSTROUTE_LIVE_MODE=poll` enables the live polling loop in the container.
- `GHOSTROUTE_LIVE_COLLECTOR_MODE=ssh|local` selects how the collector runs
  `live-events-report`.
- `GHOSTROUTE_LIVE_COLLECTOR_MODE=disabled` keeps the UI read-only over stored
  events and avoids noisy SSH failures.
- `GHOSTROUTE_LIVE_POLL_SECONDS=15` is the default production poll interval.

Light traffic summary collection is intended for frequent Dashboard refreshes
and defaults to every 5 minutes during the day and every 30 minutes during
23:00-06:00 Moscow time. Full snapshot collection is scheduled to avoid router
load: every 30 minutes from 06:00 to 22:59 Moscow time, and every 3 hours from
23:00 to 05:59. Live polling defaults to 10 minutes during the day and 30 minutes
overnight. The UI uses matching freshness thresholds: stale after 75 minutes
during the day and 210 minutes overnight.

## Deployment And Access

The deployed Console app runs as a single Docker container on
`127.0.0.1:3000` on the VPS. Public access uses a dedicated non-443 nginx HTTPS
listener with Basic Auth and a small local buffering proxy in front of the app.
The proxy preserves the external `Host`, `X-Forwarded-Host`, `X-Forwarded-Proto`
and `X-Forwarded-Port` headers so server-side mobile redirects never leak the
internal `localhost:3000` upstream address.
This keeps Console off the shared Reality/layer4 `:443` listener while avoiding
a second owner for the Reality surface. Caddy still owns certificate storage and
the separate Reality/layer4 listener. Legacy dedicated Caddy Console blocks may
remain only as rollback configuration and must be disabled while nginx owns the
Console port. The nginx listener uses response compression plus an explicit
small TLS buffer so larger HTML/JSON pages stay reliable over the operator
network path. Immutable Next.js assets under `/_next/static/` and browser
metadata probes such as `/favicon.ico` are served without Basic Auth because
they contain no operator snapshot data and iOS Safari may otherwise
re-challenge those subresources; HTML, API and read-model routes stay behind
Basic Auth. Provider-level firewalls must allow the configured Console TCP port
before host UFW or nginx can receive traffic. The data directory is
`/opt/ghostroute-console/data`; repo sources are mounted read-only at
`/opt/ghostroute-console/repo`.

The operator UI intentionally keeps first-page HTML small. Dashboard analytics
are derived from scoped read models and render SVG/CSS charts for today's route
split and forecasted cumulative usage without adding a browser chart dependency.
The primary observed traffic cards sit directly under the daily chart; quota
cards are intentionally omitted from the Dashboard so current route accounting
stays visually separated from billing/reserve views. The `today` route chart
uses cumulative `traffic_summary` deltas when available so it stays in the same
accounting scope as the Dashboard KPI. The route series use explicit read-model
split evidence, so `Total` is always the sum of `Via VPS`, `Direct` and
`Unknown`, including rows whose route badge is `Mixed`.
Dashboard `Top clients` uses the same union Device Inventory selector as
`/clients`, so the card and the Clients page share client labels, active-window
traffic totals and route splits. The older lower duplicate `Top clients` and
`Destination coverage` tables are intentionally omitted from the Dashboard.
Clients selected-device DNS panels default to client-facing query domains and
offer an explicit service/system toggle on both desktop and mobile; DNS counts
remain separate from byte-ranked popular sites.
Apps uses the same active-window Device Inventory source but includes any
traffic-active client at or above 1 MiB, including low-signal and unattributed
sources. When a selected client has counter bytes but no site/app evidence, Apps
shows a residual `Other / uncategorized` app row with zero DNS queries instead
of hiding the client or rendering an empty app-family table.
Large evidence
surfaces use paging and explicit exports instead of rendering full datasets in
one response. `/traffic`, `/dns` and `/live` default to compact first pages and
allow larger page sizes only when the operator asks for them. First-render pages
use scoped read models rather than the full report model: Dashboard, Flow
Explorer, DNS Query Log, Clients, Health, Catalog, Budget, Live, Reports and
Settings load only the data each view renders.

Mobile browsers, especially iPhone Safari behind the Console auth/proxy path,
use a separate `/m` surface rather than the desktop workbench shell. Middleware
redirects mobile requests for `/`, `/traffic`, `/dns`, `/clients`, `/health`,
`/live`, `/catalog` and `/settings` to matching `/m` pages, while `desktop=1`, `/api/*`,
`/_next/*`, `/m/*` and shared route-detail URLs bypass the redirect. The mobile
pages use the same read-only selectors, cap page size to 25 rows, omit side
panels and desktop charts, and keep navigation as plain document links. Mobile
Health Center renders status cards, Alarm Center, Deploy Gate, Health Center
probes, Leak-check evidence and freshness from the same health/alarm read
models. `/m/health` is intentionally a raw no-JS HTML route instead of a React
page so iOS Safari can show the triage state from one authenticated document
without depending on hydration chunks. Mobile Live renders the event stream plus
a compact Client activity summary from `flow_sessions`; Mobile Settings renders
the same sanitized routing-policy snapshot as desktop Settings. No `m.` subdomain is
used in v1, so public nginx/TLS stays on the same listener; only immutable
`/_next/static/` chunks and browser metadata probes bypass Basic Auth to keep
iOS Safari navigation reliable.

Read-only derived selectors use a short in-process cache inside the Console
Node process. The default TTL is 300 seconds and can be disabled with
`GHOSTROUTE_CONSOLE_DERIVED_CACHE_TTL_MS=0`. Cache keys use lightweight snapshot
metadata (`type` + `collected_at`) rather than parsing every latest snapshot
payload. Request-path shells for Health, Live, mobile pages and JSON APIs then
load prepared SQLite rows: traffic/DNS/client tables from their bounded read
models and Health/Live chrome from `console_page_summaries`. New collected data
naturally changes the metadata version and moves the UI to a new cache key
without making ordinary navigation parse the full traffic report.

Cached selectors cover heavy flow, DNS, alarm, client, client activity and
live-event lists, plus the page models for every sidebar view. Action/write
endpoints either bypass this cache or clear it after a state change. Console
intentionally avoids browser prefetch for the heavy sidebar views; warmup made
mobile Safari less predictable and could leave the operator staring at a
navigation fallback even though direct URLs worked.

Flow Explorer and Clients keep row inspection as URL-addressable state rather
than hidden browser state. Flow rows use `?flow=<flow_sessions.id>` and render
destination evidence as `DNS`, `SNI`, `IP`, `category`, `counter` or
`not observed`, so exact site evidence is not confused with aggregate traffic
groups. Device Inventory uses `?client=<device-or-client-id>` for the right
detail panel while the table itself remains an inventory list; row cells are
plain document links to keep selection reliable over Safari/proxy paths.

Each deployed build carries both a short git commit and a UTC build timestamp.
The source strip renders them together as `build <commit> - <date>`, and
`/api/health` exposes the same `runtime.buildCommit` and `runtime.buildAt`
values. This makes it possible to confirm from the UI that the browser is
seeing the freshly deployed container rather than a stale image or cached page.
Playwright functional checks cover content, redirects, row selection and JSON
contracts without timing assertions. Playwright performance checks are a separate
local seeded-GUI suite that owns timing budgets: 2.5 seconds for page content and
1.5 seconds for API responses. Data-layer releases also run
`npm run verify:timezone`,
`GHOSTROUTE_CONSOLE_DATA_DIR=../data/gui-test npm run verify:aggregates`,
`GHOSTROUTE_CONSOLE_DATA_DIR=../data/gui-test npm run bench:dashboard` and
`GHOSTROUTE_CONSOLE_DATA_DIR=../data/gui-test npm run report:db-size`.

Snapshot ingestion has a small runtime contract gate before data reaches the
UI read models. JSON reports must carry the common machine-contract fields
(`schema_version`, `generated_at` and `source.command`) plus the minimal shape
expected for their snapshot type. The schemas are tolerant and preserve unknown
fields so upstream reports can evolve, but invalid snapshots are recorded in
`collector_errors` and skipped rather than becoming the latest UI state.

The read-only VPS deploy keeps the existing Console container running while the
new image builds. Only after the image is prepared does compose recreate the
container and run local health, UI and API smoke checks. If those checks fail,
the playbook tags the previous image back to `ghostroute-console:latest` and
attempts a rollback start before failing the deploy.

Browser loading incidents must be diagnosed from the browser edge first. For a
blank or long-loading page, collect a Chrome DevTools Network waterfall with
Preserve log and Disable cache enabled, or Safari/WebKit Web Inspector Network
evidence for Safari/iOS. Compare the HTML document, `?_rsc` requests, static
chunks and API timings with a VPS-local curl baseline to
`127.0.0.1:3000/health` and a public curl baseline to the dedicated Console
URL. A slow document TTFB points toward server render/read-model work; fast TTFB
with a slow body points toward proxy/TLS/client-path behavior; failed chunks
point toward static asset/auth/cache handling; hanging `?_rsc` requests point
toward App Router navigation. Do not change Channel A/B/C, managed DNS,
sing-box, dnsmasq or router firewall while investigating Console-only browser
loading.
Public/VPN curl checks are deploy diagnostics for the operator network path; they
are not deterministic Playwright performance gates.

The restricted SSH surface is `ghostroute_readonly` with forced-command
whitelisting. Whitelisted commands must require `--json` and must remain
read-only.

The deployed container SSHes to the VPS host over localhost using a generated
key under `/opt/ghostroute-console/ssh/`. The forced command executes only
whitelisted JSON report commands from the synced repo checkout. The
`ghostroute_readonly` account is additionally constrained by sshd hardening: no
password or keyboard-interactive auth, no TTY, no forwarding and no tunnel.

Router access for read-only report collection is a separate runtime secret. The
preferred source is Ansible Vault (`ghostroute_router_remote_host`,
`ghostroute_router_remote_port`, `ghostroute_router_remote_user`,
`ghostroute_router_remote_private_key`). Deploys may fall back to the
gitignored local operator key under `secrets/router-remote-ssh/`, but the key is
never tracked and is installed only as `/opt/ghostroute-console/router-ssh/*`
with root ownership and `ghostroute_readonly` read-only group access.

## Safety Boundaries

- No hidden router deploy, firewall edit, service restart or catalog apply.
- Catalog apply in Console may prepare an audited local patch/rollback ref; a
  real router deploy remains a separate operator-approved action.
- Production UI must use factual data only. Fixtures are allowed only in tests.
- Public docs and exports must not contain secrets, private endpoint details,
  UUIDs, MACs, QR payloads or raw evidence unless explicitly redacted.
- Any future write/runtime action needs explicit confirmation, audit log,
  rollback path, smoke checks and redaction review.
