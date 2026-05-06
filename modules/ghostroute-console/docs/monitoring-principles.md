# GhostRoute Console Monitoring Principles

GhostRoute Console is client-first by default. Main traffic views prioritize
human/client activity by observed traffic volume, formatted as MB/GB/TB.
Service/background and unattributed traffic remain visible, but they are shown
separately so they do not hide the client picture.

## Traffic Classes

- `Client` is normal user-facing traffic: messengers, video, social apps, AI,
  productivity, retail, banking and other real destinations with observed
  bytes.
- `Service/background` is infrastructure and device service traffic: Apple
  service traffic, DNS/resolver rows, CDN/infra rows, router/system events and
  zero-byte DNS-interest rows.
- `Needs attribution` is observed traffic that still lacks a clear app family:
  unclassified domains, IP-only rows and `Other` / `Other/IP` aggregates.

Unclassified traffic is not discarded. If it has bytes, it is counted, sorted by
volume and shown with route, channel and confidence so the operator can improve
attribution later.

## Freshness

- Dashboard traffic KPI uses lightweight `traffic-summary today`: current local
  day from 00:00 to the latest summary snapshot, collected about every 5 minutes.
- Detailed traffic views use saved `traffic-report` snapshots. These are heavier
  and refresh less often: about every 30 minutes during the day and every 3
  hours overnight.
- Live events are event snapshots, not a continuous per-second stream. The UI and
  collector default to about 10 minutes to keep the small VPS calm.
- Week/month views must read saved snapshots or aggregates. They must not launch
  heavy on-demand full reports.

## Navigation Performance

- Sidebar pages should render from page-scoped read models, not from the full
  report/evidence model unless the page is explicitly a report export.
- Read-only derived snapshot data may use a short in-process TTL cache keyed by
  the latest snapshot timestamp and active filters. Action/write endpoints and
  private credential material must not use that cache.
- `test:perf` covers both individual page/API budgets and rapid sidebar
  navigation so regressions show up before deploy.

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
