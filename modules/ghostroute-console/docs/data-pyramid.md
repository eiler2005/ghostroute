# GhostRoute Console Data Pyramid

## Accounting and attribution boundaries

Source and presentation gates are separate. Router evidence polling runs every
minute, while full Console ingestion defaults to fifteen minutes both day and
night. Summary polling is independent. A fresh summary alone does not prove fresh
destination detail. Source retention must cover ingestion gaps; poll sampling and
offload can still leave genuine attribution gaps.

Prepared Dashboard destination rows use the same local IP/provider metadata as
detail selectors, and app rankings are built from measured detail before display
limits. A provider label is a hint, not a DNS/SNI observation. The collector and
Dashboard fallback share the app-ranking function. These enrichments never change
volumes, assign residual bytes to popular apps, or turn unknown route evidence into
known zeroes. Mobile Apps' DNS list reads DNS evidence, not the application byte list.

Facts may declare `measurement_role` (`volume` or `detail`), measurement scope,
and UTC interval bounds. Volume counter facts with
`destination_kind=unattributed_counter` contribute to totals without becoming
destinations. Covered connection samples contribute to destination detail only.
The reader applies interval ownership to retained legacy samples as well, so a
new complete counter does not add the same sampled bytes twice. Uncovered
samples remain partial evidence. LAN counter intervals are emitted by the source
instead of being used only as route-allocation weights.
Live LAN and profile reads use a temporary copy and append a fresh counter
endpoint. A containing counter interval supersedes its earlier partial
observations; adjacent intervals remain additive. All-lane client summaries
read the total pyramid, while destination lanes retain their partial coverage.
Completed proxy streams are independent events and do not use counter interval
replacement.
The rebuild range expands to the latest counter snapshot's original interval
start, including superseded partials older than the normal rolling horizon.
Interval ownership includes the source counter identity (such as the observed
client address), so two interfaces mapped to one operator device remain additive.

Connection counts do not allocate profile bytes to destinations or routes.
Profile counters for every supported channel are volume-only evidence until
matching byte observations exist. Retained connection-share estimates preserve
their original profile volume as unattributed bytes; their fabricated app and
route split is excluded, and a new counter for the same sample supersedes them.

Ranking percentages use the sum of the explicitly displayed evidence set;
bar geometry uses its maximum. These denominators are distinct. Byte confidence
and app-match confidence are also independent: exact bytes to a provider do not
prove an exact application identity. Aggregate residuals cannot inherit app or
provider hints and remain separate from classified application evidence.

Traffic-active stable profile identities remain eligible for client rankings
without an operator alias. Missing ownership is a review state, not a reason to
drop bytes. Router summary, prepared client evidence and destination evidence
are exposed together with their measurement scopes. They must not be silently
scaled to a shared total when their coverage differs.
Verification compares inventory to the same-scope prepared client evidence and
compares every all-lane layer exactly to its total pyramid, rather than requiring
all-channel client evidence to equal a LAN/Home Reality-only summary.
Local aggregate validation and the post-deployment gate share that same volume
contract. Neither gate requires partial destination coverage to equal total
profile traffic; both reject any disagreement between total read models.

Dashboard totals and the complete client list use one selected client-volume
model across channels. The daily cumulative chart uses the same source selection
with retained time buckets and counter intervals. Destination-detail buckets,
including unattributed destinations, cannot become a second copy of volume.
Client totals are computed before display limits or pagination. Unregistered
measured identities remain visible in the attribution queue. A registry primary
channel never replaces the measured access channel.
Current channel totals and channel-client rankings are prepared from that same
source selection and reused by desktop and mobile selectors; their sum equals
the all-client total for the same period and class.

The chart does not spread a daily total into fabricated hours, fill future hours
with zero, or rescale historical route components. Its filled area ends at the
last observation. A router-summary-only chart is a fallback when no client-volume
evidence exists; that narrower summary remains separately labeled as diagnostic
coverage when client evidence is present.

Client site evidence retains original measured and source-estimated byte rows.
DNS query counts never allocate the unexplained byte remainder. Unexplained
traffic is a separate residual; excess evidence is flagged as a conflict and
is not reduced proportionally. The Dashboard coverage panel distinguishes the
router summary from client and destination evidence.

Calendar-month windows read daily buckets from the beginning of the month and
use hourly/five-minute buckets for the current day. Weekly buckets that begin
outside the month cannot represent its initial partial week. Channel History
uses the selected period and does not treat absent day rows as measured zero.

Channel totals, client rankings within a channel, and daily channel history read
the total traffic pyramid. Destination-lane rows are used for app evidence only;
the absence of a destination must not erase measured channel bytes.

Device summary counters and traffic-fact client sums are different sources.
Only summary samples participate in summary-counter deltas. A conflicting
incremental route split is left unattributed rather than exceeding the observed
increment. This does not resolve missing baselines or counter resets; those
intervals still require coverage-aware accounting.

The source counter reader sums adjacent non-negative increments. One sample
reports a missing baseline; a decrease reports a reset gap and does not turn
the new lifetime value into proven window traffic. Summary warnings expose
these incomplete intervals. An unrecoverable gap is not reconstructed from
destination popularity or DNS counts.

GhostRoute Console must not rebuild a data warehouse during deploy, restart or
ordinary UI navigation. Large raw tables are troubleshooting input, not the
steady-state read path. The steady-state path is a prepared aggregate pyramid
with small watermarked chunks.

Recent fact snapshots are retained through the bounded raw-retention window.
A new snapshot may be partial or empty and therefore does not revoke earlier
observations. Rebuilds deduplicate their union by stable fact identity, with
the latest observation replacing the same identity. Expired raw evidence still
follows normal retention; this does not reconstruct already deleted history.
The normalized-flow copy is also replaced by fact identity using an indexed
lookup, so replaying a full snapshot does not append another copy of every flow.

## Goals

- Keep client traffic accounting correct while avoiding request-time raw scans.
- Make deploy/startup fast: verify existing chunks, catch up only missing gaps,
  and leave large repair work to background jobs.
- Keep `today`, `week` and `month` filters available from prepared data.
- Bound disk use: raw rows are short-lived; aggregates carry the UI history.
- Prefer client traffic. Service/background evidence is retained for diagnostics
  and attribution gaps, not ranked as client traffic.

## Schema v14 Boundary

Schema v12 is the aggregate reset boundary. Schema v13 introduced
`traffic-facts` v3 fields, raw `traffic_evidence` snapshots and dry-run filter
scaffold tables. Schema v14 is an idempotent guard that keeps fresh and migrated
DBs aligned for route/accounting metadata, detailed DNS links and fact lookup
indexes. Old Console SQLite and old snapshot-derived aggregates are quarantined
for audit only and must not seed new calculations. The current source model is:

- router edge rollups for independently scoped LAN/Wi-Fi diagnostics;
- `traffic_evidence` for raw flow/DNS/route evidence;
- `traffic_facts` v3 for measured volume, separate destination detail, DNS links
  and route/accounting metadata;
- `traffic_attribution_gaps` for attribution debt;
- DNS facts for factual DNS views and DNS pyramid chunks.

Synthetic accounting buckets and attribution gaps are not normal client rows.
They may appear in coverage and Needs attribution, but not in Top clients or
normal destination rankings.

## Layers

```text
router edge rollups / traffic_evidence / traffic_facts snapshots
  -> traffic facts feed the volume and destination pyramids separately
  -> router rollups remain independently scoped diagnostics

client_traffic_5min / client_destination_traffic_5min / dns_log_5min
  -> fine current-day chunks

client_traffic_hourly / client_destination_traffic_hourly / dns_log_hourly
  -> built from 5-minute chunks

client_traffic_daily / client_destination_traffic_daily / dns_log_daily
  -> built from hourly chunks

client_traffic_weekly / client_destination_traffic_weekly / dns_log_weekly
  -> MSK Monday-start chunks

client_traffic_monthly / client_destination_traffic_monthly / dns_log_monthly
  -> MSK month-start report chunks

traffic_window_snapshots
  -> small prepared payloads for today/week/month

console_page_summaries
  -> small prepared Health/Live/mobile first-screen payloads

client_traffic_by_lane / client_destination_by_lane
  -> GUI-ready client lane summary and destination drilldown

client_route_evidence_defects
  -> GUI/review-ready route proof defects by client and destination
```

`client_traffic_*` tables are compact totals and do not contain
`destination_key`. Destination breakdown lives in
`client_destination_traffic_*`. This prevents Top clients from being multiplied
by destination cardinality while keeping destination attribution available.

`client_traffic_by_lane` and `client_destination_by_lane` are the client-centric
Traffic Intelligence view over those destination chunks. They group traffic by
`traffic_lane`, `dns_category` and `decision_hint` so Clients/Intelligence can
show all observed traffic, service/system traffic, privacy-risk traffic,
shared/CDN infrastructure and unknown/review traffic without rescanning raw
facts on request. They are rebuildable read models, not a second ledger.

`client_route_evidence_defects` is the matching diagnostics view for route
proof quality. It keeps destination addresses/domains next to
`route_evidence`, `intended_route`, `route_verification` and the byte split, so
route-unknown problems can be reviewed separately from content classification.

For high-volume unknown classification, Console exports local review files from
the read models:

```bash
cd modules/ghostroute-console/app
npm run export:review-queue -- --window today --limit 100
```

The files land in gitignored `modules/ghostroute-console/data/review/` as JSON
and Markdown. They are the handoff point for offline/LLM analysis; the GUI
should primarily display/filter the queue, while durable decisions become local
deterministic rules and are rechecked by rebuilding aggregates.
The same export includes a Device Inventory review queue. Raw-IP sources,
service/system sources, stale historical observations and low-signal active
rows are review states, not automatic delete decisions.

## Window Planning

Prepared windows are composed from the coarsest accurate chunks:

- `today`: current partial hour from 5-minute chunks, completed current-day
  hours from hourly chunks.
- `week`: the `today` plan plus previous MSK days from daily chunks.
- `month`: the `today` plan, previous days in the current MSK week from daily
  chunks, and completed MSK weeks from weekly chunks.

The physical monthly layer is for reports and long windows. The UI `month` path
must not rescan the month.

`Flow Explorer`, `DNS Query Log` and `Live` are detail workbenches, not
historical aggregate surfaces. They always force `today` on the server,
including mobile pages and `/api/flows`, `/api/dns`, `/api/live` and
`/api/live/stream`.

## Traffic Classes

The traffic-class contract is:

- `client`: user-meaningful traffic such as sites, apps, messaging and torrents.
- `personal_cloud`: iCloud, Drive, Photos, Dropbox, OneDrive and similar sync or
  backup traffic.
- `service_background`: DNS resolver, router control-plane, OS connectivity
  checks, telemetry, updates, analytics, CDN-only infrastructure and probes.
- `unclassified`: insufficient evidence, IP-only gaps or accounting debt.

Default client views prioritize `client + personal_cloud`. Service/background
and unclassified traffic stay visible as diagnostics and coverage debt.

## Client And DNS Policy

Top-client prepared rows are operator-client rows only: non-zero
`traffic_class in ('client', 'personal_cloud')` traffic that resolves through the
private device-attribution registry. Service channels, DNS-interest rows,
accounting buckets and pseudo clients such as channel labels are retained for
diagnostics, but they are not ranked as clients.

Device Inventory is a union view, not a direct dump of the prepared `clients`
payload. It combines active prepared rows, client lane/destination aggregates,
historical normalized devices and the private device-attribution registry.
Default inventory pages show traffic-active rows for the selected window,
including unresolved active rows as Needs attribution; inactive registry rows
are hidden until the operator enables `showInactive=1`.
Rows resolved through the private registry use the canonical registry label and
device type. Unresolved IP-only LAN sources remain attribution debt as Unknown
LAN devices, with the raw IP preserved in evidence fields rather than promoted
to a trusted client name.

DNS Query Log is factual evidence. DNS rows may be visible even when the source
is not yet registry-attributed. Prepared DNS windows resolve raw IP,
`lan-host-*`, hostname/MAC and private-registry aliases through the same
canonical client resolver used by flow and destination rows, so DNS evidence
and byte rows for one physical device land on the same `client_key`.

The Clients page, Apps page and Dashboard ranking/API cards use one site/DNS
evidence selector. Exact domain/SNI byte rows stay factual. Provider/category
byte rows provide coarse evidence, with app-match confidence separate from byte
confidence. DNS interest and connection logs never distribute residual bytes.
The selected-client volume comes from the total pyramid; destination rows
explain only their observed portion. The unexplained remainder stays separate
as `Other / uncategorized`. Synthetic `all` lanes are not summed together with
class-specific lanes, and global/router totals never manufacture client bytes.

When one registry client is seen through several lanes, channel labels are
normalized as a small deduplicated set such as
`A/Home Reality + Home Wi-Fi/LAN`. Compound labels from older prepared rows are
split before merging, so repeated evidence cannot grow into long synthetic
channel strings.

The shared `assertTrafficVolumeContract` gate requires exact agreement between
prepared Dashboard totals, the complete prepared client sum and the current-day
chart. Its route components must also sum exactly to total bytes. Independent
router summaries and partial destination evidence are not forced to equal that
all-channel client volume. Browser coverage additionally compares the Dashboard
API with every page of the Clients API.

Latest DNS domains uses the same selector, but ranks by recency/query count and
keeps DNS query counts visible as evidence. Service DNS stays excluded unless
the operator explicitly enables it.

Unresolved loopback, router-local and private source addresses are not displayed
as normal clients. Registry-backed DNS sources use the canonical device label;
service/router DNS evidence is displayed as a service source and keeps raw
addresses only in detail/title evidence.

Destination rankings are built from destination-bearing chunks. Unknown or
accounting-only traffic contributes to coverage, not to concrete Top
destinations.

Client lane drilldowns are built from destination-bearing chunks plus
`destination_enrichment` and optional IP enrichment cache rows. If a destination
cannot be classified, the lane layer preserves it as `unknown_review` instead
of filtering it out. The synthetic `all` lane is stored only as a GUI
convenience total; facts and route accounting remain authoritative in
`traffic_facts` and the core aggregate pyramid.

## Router Edge Rollups

The router edge layer is a bounded cache/spool, not the primary warehouse.
`cron-traffic-snapshot` launches `lan-flow-facts-snapshot` and then
`traffic-rollup-snapshot` asynchronously with low priority. The rollup layer:

- reads only existing accounting files such as `lan-flow-facts.tsv`;
- writes line-oriented `router_traffic_*` and `router_destination_traffic_*`
  chunks for `5min/hourly/daily/weekly/monthly`;
- writes `router_dns_*` status as `missing_source` when DNS source is not
  available on the router;
- exposes machine JSON through `traffic-rollup-export --json`;
- never changes iptables, NAT, REDIRECT, sing-box, dnsmasq, Channels A/B/C or
  managed-domain rules.

Router chunk starts are aligned to Moscow time: 5-minute buckets, `HH:00:00`,
MSK day start, MSK Monday week start and MSK month start.

Prepared Dashboard totals for every traffic class prefer the same selected
client-volume rows used by client rankings. Existing per-device summary counter
fallbacks are selected per client/channel and never added to overlapping facts.
The global LAN/Home Reality summary is not an all-channel denominator and cannot
replace that total merely because it is newer. Missing aliases do not erase bytes.

## Collector Contract

Normal collection has separate jobs:

- Router edge rollup: bounded async chunk building on the router.
- VPS incremental rollup: import router chunks as preferred totals, use
  `traffic_facts` v3 for detail/fallback, update 5-minute chunks, roll them
  into hourly/daily/weekly/monthly chunks, and rewrite prepared windows.
- Backfill/repair: rebuild missing or suspect historical chunks separately.
  Deploy/startup should not wait for full historical repair.

The steady-state dirty overlap is bounded to the current Moscow day and a small
recent window (`GHOSTROUTE_ROLLUP_REBUILD_HOURS`, default 6h). This is a
correction window, not the main source for historical `week`/`month` data.

`aggregate_state(model, window_key, source_snapshot_id, built_until_utc, status)`
tracks 5-minute, hourly, daily, weekly, monthly, DNS and prepared-window layers.
Status values are `ok`, `partial`, `missing_source`, `fallback` and `error`.

Historical correction is explicit:

```bash
./modules/ghostroute-console/bin/ghostroute-console repair-aggregates --from 2026-05-07 --to 2026-05-08 --dry-run
./modules/ghostroute-console/bin/ghostroute-console repair-aggregates --from 2026-05-07 --to 2026-05-08
```

Date-only arguments are Moscow-day boundaries; `--to` is exclusive. Repair uses
retained facts only. If retention has removed the source, it records
`missing_source` and keeps existing aggregates.

## Retention

Default retention should preserve the one-month UI window without keeping
unbounded raw data:

- raw normalized client rows and client `traffic_facts`: about 7 days;
- service/background raw rows: shorter diagnostic retention;
- DNS link evidence: about 7 days;
- dry-run filter decisions: about 30 days;
- router raw/delta files: short bounded history;
- router 5-minute chunks: about 8 days;
- router hourly/daily/weekly/monthly chunks: about 35 days;
- VPS 5-minute chunks: about 8 days;
- VPS hourly/daily/weekly/monthly traffic chunks and DNS aggregates: about 35
  days;
- heavy raw `traffic`, `dns` and `live` snapshot payloads: short
  troubleshooting window once newer payloads exist.

Retention must prune oldest layers after prepared aggregates exist, not before.

## Rollback

`GHOSTROUTE_CONSOLE_USE_PREPARED_WINDOWS=0` is a diagnostic compatibility
switch. It must not become the production path for large databases, because it
allows request paths to revisit heavier selectors.
