# GhostRoute Console Data Pyramid

GhostRoute Console must not rebuild a data warehouse during deploy, restart or
ordinary UI navigation. Large raw tables are troubleshooting input, not the
steady-state read path. The steady-state path is a prepared aggregate pyramid
with small watermarked chunks.

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

- router edge rollups for authoritative LAN/Wi-Fi totals;
- `traffic_evidence` for raw flow/DNS/route evidence;
- `traffic_facts` v3 for audit, detail, DNS links, route/accounting metadata and
  fallback;
- `traffic_attribution_gaps` for attribution debt;
- DNS facts for factual DNS views and DNS pyramid chunks.

Synthetic accounting buckets and attribution gaps are not normal client rows.
They may appear in coverage and Needs attribution, but not in Top clients or
normal destination rankings.

## Layers

```text
router edge rollups / traffic_evidence / traffic_facts snapshots
  -> router rollups are preferred totals
  -> facts remain audit/detail/fallback source

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

DNS Query Log is factual evidence. DNS rows may be visible even when the source
is not yet registry-attributed, but only registry-backed clients participate in
DNS top-client grouping or client inventory rows.

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
