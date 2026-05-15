# GhostRoute Console Monitoring Principles

GhostRoute Console is client-first by default. Main traffic views prioritize
human/client activity by observed traffic volume, formatted as MB/GB/TB.
Service/background and unattributed traffic remain visible, but they are shown
separately so they do not hide the client picture.

## Traffic Classes

- `Client` is normal user-facing traffic: messengers, video, social apps, AI,
  productivity, retail, banking and other real destinations with observed
  bytes.
- `Personal cloud` is user-owned sync/backup traffic that may be intentional or
  background: iCloud, Google Drive/Photos, Dropbox, OneDrive and similar backup
  flows. It is counted next to client traffic by default but remains filterable
  because large sync jobs can otherwise hide interactive usage.
- `Service/background` is infrastructure and device service traffic: Apple
  configuration/update checks, OS telemetry, DNS/resolver rows, CDN/infra rows,
  router/system events and local control-plane evidence.
- `Needs attribution` is observed traffic that still lacks a clear app family:
  unclassified domains, IP-only rows and `Other` / `Other/IP` aggregates.

Unclassified traffic is not discarded. If it has bytes, it is counted, sorted by
volume and shown with route, channel and confidence so the operator can improve
attribution later.

Traffic totals are computed from the route split when needed. If a row carries
`unknown_bytes` but a zero total, Console still treats those unknown bytes as
observed client traffic instead of rendering `0 B`.

All detailed event/read-model tables use the v10 timestamp contract:
`event_ts_utc` when a source supplied event time, `observed_at_utc` for the
collector observation time, `display_ts_utc` for UI sorting/rendering and
`time_precision` (`event_ms`, `event_second`, `collector_ms` or `bucket`) so the
UI can show milliseconds without pretending second-only source data was exact.
Flow Explorer, DNS Query Log, Live and Clients display the millisecond timestamp
available from this contract.

## Freshness

- Dashboard traffic KPI uses lightweight `traffic-summary today`: current local
  day from 00:00 to the latest summary snapshot, collected about every 5 minutes.
  The Dashboard `today` route chart uses the same cumulative summary snapshots
  when available, turning summary deltas into Moscow-hour buckets so the chart
  and KPI keep the same accounting scope.
- Detailed traffic views use saved `traffic-report` snapshots. These are heavier
  and refresh less often: about every 30 minutes during the day and every 3
  hours overnight.
- Live events are event snapshots, not a continuous per-second stream. The UI and
  collector default to about 10 minutes to keep the small VPS calm.
- During 23:00-06:00 Moscow time, lightweight and live collectors default to
  wider 30-minute intervals. Full collection already uses the wider overnight
  interval. This trades nighttime freshness for lower VPS/router/SQLite pressure.
- Week/month views must read prepared aggregate tables and
  `traffic_window_snapshots`. They must not launch heavy on-demand full reports
  or scan raw normalized rows on the request path.

## Prepared Traffic Windows

- Source timestamps are stored in UTC; UI windows are keyed in Moscow local time.
  `today` starts at Moscow midnight, `week` covers the current Moscow day plus
  the previous six days, and `month` starts at the first Moscow day of the month.
- After each collection, Console rebuilds `client_traffic_5min`,
  `client_traffic_hourly`, `client_traffic_daily`, `dns_log_5min`,
  `top_clients_window`, `top_destinations_window` and
  `traffic_window_snapshots` for `today`, `week` and `month`.
- The aggregate pyramid is incremental after the initial backfill. New raw rows
  update only a dirty overlap window, then roll up from 5-minute buckets to
  hourly/daily buckets. Week/month request paths read those prepared aggregates
  instead of rescanning raw rows.
- Dashboard, Clients, DNS and report JSON should read prepared windows first.
  Missing historical prepared data should produce a bounded empty/fallback state,
  not a raw-table scan.
- DNS Query Log may show factual DNS rows that do not yet resolve to a private
  registry client. Those rows are attribution diagnostics; they are excluded
  from DNS top-client grouping until a registry alias exists.
- Apps and Clients use the same selected-client site/DNS evidence selector over
  the prepared DNS pyramid, falling back to raw DNS rows only when the prepared
  DNS layer is absent. Exact domain/SNI byte rows remain factual. IP/provider
  residual may be distributed across client-facing DNS domains by query count
  only when it is explicitly marked as inferred/estimated. Without DNS evidence,
  residual stays as `Other / uncategorized`.
- Client popular-site panels rank by `effective_bytes` first, then DNS query
  count and recency. Inferred DNS rows are allowed to cover aggregate residual
  so the panel does not hide a GB-scale selected-client total behind a tiny
  IP-only row, but the UI must not label that allocation as exact factual byte
  accounting.
- Retention keeps fine 5-minute traffic buckets short-lived and hourly/daily/DNS
  aggregates around the monthly window. Raw operational rows remain bounded
  troubleshooting data.
- The rollback switch for diagnosis is
  `GHOSTROUTE_CONSOLE_USE_PREPARED_WINDOWS=0`. It is a temporary compatibility
  path, not the steady-state architecture for large databases.
- Raw operational rows remain short-lived troubleshooting data. Client traffic
  history for the UI belongs in the aggregate/read-model tables.
- Schema v10 is a clean accounting boundary. Old Console SQLite databases and
  old snapshots may be quarantined during rollout and are not backfilled into
  v10 calculations, because historical rows may lack the LAN identity, traffic
  class and timestamp precision needed for correct future accounting.

## Navigation Performance

- Sidebar pages render from page-scoped read models, not from the full
  report/evidence model unless the page is explicitly a report export. The
  current sidebar set is Dashboard, Flow Explorer, DNS Query Log, Clients,
  Health Center, Catalog, Budget, Live, Reports and Settings.
- Read-only derived snapshot data uses a short in-process TTL cache keyed by
  lightweight snapshot metadata, active filters and pagination args. The default
  TTL is 300 seconds and can be disabled with
  `GHOSTROUTE_CONSOLE_DERIVED_CACHE_TTL_MS=0`.
- Health, Live, mobile pages and JSON APIs must build their chrome from
  prepared read models. Mobile Health reads `console_page_summaries.health_mobile`
  for status cards, capped alarms, Deploy Gate, health probes and leak evidence;
  mobile Live uses bounded `events`/`flow_sessions` selectors plus the lightweight
  shell summary. They must not parse the full latest traffic report or rebuild
  desktop Health just to render freshness, nav, cards or small lists.
- The cache covers heavy flow, DNS, alarm, client, client-activity and live
  selectors, plus page models for all sidebar views. Action/write endpoints and
  private credential material must not use that cache; narrow operator-state
  actions clear derived cache after a successful change.
- The browser does not prefetch heavy sidebar views. Plain document navigation
  and server-side read-model selectors keep Safari/iOS predictable; correctness
  still comes from factual snapshots and read models.
- Functional GUI/API smoke tests must verify behavior and contracts only:
  rendering, filters, row selection, redirects, mobile compact pages and JSON
  shape. They must not assert elapsed time.
- `test:perf` is the only local Playwright suite with timing budgets. It covers
  individual page/API budgets and rapid sidebar navigation so read-model/cache
  regressions show up before deploy.

## GUI Development Workflow

- GUI changes must be checked on a local seeded Console before deploy. Use
  `cd modules/ghostroute-console/app && npm run dev:gui` for visual review,
  `npm run test:e2e:gui` for functional browser coverage and `npm run test:perf`
  for local performance budgets against the same synthetic data.
- Refresh the seeded GUI data layer before local checks whenever page models,
  selectors, cache keys or read-model rendering change: run
  `npm run seed:gui` from `modules/ghostroute-console/app`. The seed step also
  rebuilds the prepared today/week/month windows used by GUI/API tests.
- GUI destination checks should verify the primary label and the raw evidence
  separately. Raw IP addresses are valid DNS/route evidence, but the default
  Dashboard, Traffic, Live, Clients and mobile views should show a domain,
  platform/category, IP-ASN provider/source or IP-only type label instead of
  exposing the IP as the main destination.
- The seeded database lives under the gitignored
  `modules/ghostroute-console/data/gui-test/` path. It should contain enough
  Flow Explorer, DNS Query Log, Clients and Live rows to verify dense tables,
  filters, horizontal scroll and pagination without relying on live VPS data.
- Deploy comes after local visual checks and tests pass. The deployment playbook
  must continue to smoke more than `/api/health`: it should cover the key UI and
  API routes that changed.
- Data-layer changes should also pass `npm run verify:timezone`,
  `GHOSTROUTE_CONSOLE_DATA_DIR=../data/gui-test npm run verify:aggregates` and
  `GHOSTROUTE_CONSOLE_DATA_DIR=../data/gui-test npm run bench:dashboard`.
- Every deployed image carries both `GHOSTROUTE_CONSOLE_BUILD_COMMIT` and
  `GHOSTROUTE_CONSOLE_BUILD_AT`. The source strip shows `build <commit> ·
  <date>` so browser checks can confirm the newly deployed container is serving
  the UI.

## Browser Loading Incidents

- If a Console page is currently fast, do not change nginx, Caddy, Next.js or
  runtime routing to chase a stale incident.
- If a page is blank or slow, collect browser evidence before server changes:
  Chrome DevTools Network with Preserve log and Disable cache, or Safari/WebKit
  Web Inspector Network for Safari/iOS.
- Classify the stalled row before changing config: slow document TTFB points to
  server render/read-model work; fast TTFB with slow download points to
  proxy/TLS/client path; failed JS/CSS chunks point to static asset, auth or
  cache handling; hanging `?_rsc` rows point to Next.js App Router navigation.
- Compare browser timings with VPS-local and public curl baselines for
  `/health` and `/api/health`. If API is fast but HTML stalls, the collector and
  router health reports are probably not the bottleneck.
- Console browser loading diagnostics must not mutate Channel A/B/C, managed
  DNS, sing-box, dnsmasq or router firewall.

## Alarm State

- `alarm_events` remains a derived read model from factual snapshots and
  normalized alert evidence.
- Operator state for Alarm Center is a narrow overlay: `acknowledged`,
  `snoozed` or `open`, plus actor, update time and snooze deadline.
- The overlay is stored on router disk through the dedicated Console
  `alarm-state --json` command. It must not restart services, deploy catalog
  changes or touch Channel A/B/C routing state.
- If router state is temporarily unavailable, Console may render the last local
  cache with a `console-cache` source marker; the factual alarm evidence stays
  visible.
- Telegram/e-mail delivery can later consume the same state, but delivery
  secrets and provider credentials must stay outside SQLite and tracked docs.

## Deploy Gate Evidence

- Deploy-gate snapshots come from Health Monitor `live-check --active-probe
  --deploy-gate`.
- They are factual canary evidence for deploy readiness, not a Console deploy
  action.
- Console stores and renders the JSON even when the command exits CRIT, because
  the failed evidence is the useful operator signal.
- Health Center shows the latest gate status and suggested actions; Dashboard
  remains focused on runtime traffic and freshness.
- Checks that require Ansible/Vault on the control machine, such as VPS edge
  probes, may appear in VPS-collected snapshots with
  `evidence=ansible_or_vault=missing`. Health Center renders those rows as
  `N/A` control-machine-only evidence so they do not become false runtime CRIT
  signals inside the read-only Console collector. The same checks remain strict
  blockers when `live-check --active-probe --deploy-gate` is run from the
  control machine before a mutating deploy.

## Evidence Labels

- `exact` means explicit counter, report or log evidence.
- `estimated` means derived from counters or log summaries.
- `dns-interest` means DNS was observed; it is not proof that bytes were routed.
- `Mixed` route means the aggregate includes both VPS and Direct evidence.

## Device Roles

The Clients page shows a role next to each source. Known labels can become
`iPhone`, `iPad`, `MacBook`, `Windows laptop`, `Windows PC`, `Home LAN device`,
`Home Reality profile`, Channel B/C profile or `Unattributed mobile ingress
source`. The Console does not invent real device names; it only uses labels,
profiles and safe inference from observed metadata.

Device Inventory rows also carry a review state: `registry_known`,
`active_unattributed`, `raw_ip_source`, `stale_historical`, `service_source` or
`low_signal`. Primary inventory favors registry/current-window devices; noisy
states are shown under Needs attribution or exported to the local review queue.

Operators may add a private `device-attribution.json` file in the Console data
directory to pin the canonical client registry: stable names, roles, primary
channel, Channel A/B/C/LAN aliases and optional explicit MAC/IP aliases. That
file is local runtime state, not tracked documentation, because it can contain
household device names. The same resolver is applied consistently in Dashboard,
Flow Explorer, DNS Query Log, Clients, Live, Budget, Reports, Settings and API
payloads. If a source is not in the registry and the snapshots do not identify
it, Console displays it as `Unknown device`, `Unknown Home Reality profile` or
`Unattributed source` instead of guessing.

The Clients page is a physical Device Inventory. A registry profile may point to
a shared `device_key`/`device_label`, so Channel A, Channel B, Channel C,
LAN/Wi-Fi, MAC/IP and report-local aliases can be shown under one device without
pretending those raw labels are independent users. Traffic totals and details
are aggregated by the physical device key for the selected window; observed
aliases stay visible as audit evidence.

Client totals sort by the selected traffic window. Historical rows may enrich
the display label and role, but they must not make an old total look current. If
one canonical client has been seen under several observed labels, the detail
panel can show those labels and the channel badge can show combined access
paths such as A/Home Reality plus Channel B/C. Raw evidence keeps original
observed aliases so attribution decisions remain auditable.

Traffic reports may redact profile names with per-report aliases such as
`report-mobile-profile-N` and older snapshots may contain `mobile-client-N`.
Those aliases are local to that report order and must not be treated as stable
ownership. If the row includes a stable profile id, Console resolves the client
from that profile and only shows the redacted alias as evidence.

`traffic-report` should separate observed evidence from private attribution. JSON
rows can include `canonical_hint`, `identity_type`, `matched_by`,
`unresolved_reason`, `bytes_confidence`, `allocation_basis`, `counter_scope`,
`destination_class`, `destination_evidence` and `flow_group_key`. Console may use
these fields for display, diagnostics and deduplication, but owner/device
identity still comes from the private registry.
