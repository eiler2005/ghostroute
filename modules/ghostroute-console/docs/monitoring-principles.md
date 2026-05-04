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
Traffic Explorer, Clients, Live, Budget, Reports, Settings and API payloads. If
a source is not in the registry and the snapshots do not identify it, Console
displays it as `Unknown device`, `Unknown Home Reality profile` or
`Unattributed source` instead of guessing.

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
