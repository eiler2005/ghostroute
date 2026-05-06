# GhostRoute Console Architecture

GhostRoute Console is a factual read-only observability surface inside the
`router_configuration` repository. It consumes module-owned JSON reports and
router log-tail evidence; it is not a routing engine and must not become a
second source of truth for router runtime state.

## Data Sources

Console reads machine-readable JSON from existing operational modules:

- `traffic-summary --json today` for frequent current-day Dashboard traffic
  cards without destination analytics.
- `traffic-report --json` and `traffic-daily-report --json` for detailed usage,
  devices, route events and destination summaries.
- `router-health-report --json` and `leak-check --json` for health, leak and
  egress identity evidence.
- `domain-report --json` and `dns-forensics-report --json` for catalog, DNS
  interest and query-window evidence.
- `live-events-report --json --since <cursor> --limit N` for read-only log-tail
  events from `sing-box.log`, `dnsmasq.log` and `domain-activity.log`.

Markdown report output remains human-facing. Console must not parse Markdown as
an application contract.

## Evidence Model

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
For the default `today` period, that window is the operator-local Moscow day:
from `00:00` to the latest collected traffic snapshot. Historical known-device
rows may enrich inventory labels and roles, but they must not contribute traffic
totals, top clients, selected-client domains or route split values for the
current window. If no current-day traffic snapshot exists, traffic views should
show an empty state instead of presenting stale bytes as today's data.

Traffic report snapshots can contain cumulative counters. Console therefore
does not sum multiple same-day snapshots as independent traffic rows. Current
client/device views use positive deltas between sequential samples when they are
available, then reconcile the displayed rows to the authoritative
`traffic-summary`/`traffic` KPI totals for the selected window. Reconciled rows
may keep their raw snapshot total as troubleshooting evidence, but the primary
UI amount must remain bounded by the current-window KPI. Destination rows follow
the same rule: a generic category can enrich a row as class/type, but a Top
destination needs concrete DNS/SNI/domain/IP evidence.

Traffic UI must also explain operator-facing terms in-product:

- `VPS`, `Direct`, `Mixed` and `Unknown` describe the final route decision.
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
are short-term troubleshooting evidence. SQLite backups are daily by default
and capped by retention/count settings so a small VPS disk is not filled by
collector safety copies.

Runtime switches:

- `GHOSTROUTE_LIVE_MODE=poll` enables the live polling loop in the container.
- `GHOSTROUTE_LIVE_COLLECTOR_MODE=ssh|local` selects how the collector runs
  `live-events-report`.
- `GHOSTROUTE_LIVE_COLLECTOR_MODE=disabled` keeps the UI read-only over stored
  events and avoids noisy SSH failures.
- `GHOSTROUTE_LIVE_POLL_SECONDS=15` is the default production poll interval.

Light traffic summary collection is intended for frequent Dashboard refreshes
and defaults to every 5 minutes when enabled. Full snapshot collection is
scheduled to avoid router load: every 30 minutes from 07:00 to 23:59 Moscow
time, and every 3 hours from 00:00 to 06:59. The UI uses matching freshness
thresholds: stale after 75 minutes during the day and 210 minutes overnight.

## Deployment And Access

The deployed Console app runs as a single Docker container on
`127.0.0.1:3000` on the VPS. Public access uses a dedicated non-443 nginx HTTPS
listener with Basic Auth and a small local buffering proxy in front of the app.
This keeps Console off the shared Reality/layer4 `:443` listener while avoiding
a second owner for the Reality surface. Caddy still owns certificate storage and
the separate Reality/layer4 listener. Legacy dedicated Caddy Console blocks may
remain only as rollback configuration and must be disabled while nginx owns the
Console port. The nginx listener uses an explicit small TLS buffer so larger
HTML pages do not depend on a single large TLS write over the operator network
path. Provider-level firewalls must allow the configured Console TCP port before
host UFW or nginx can receive traffic. The data directory is
`/opt/ghostroute-console/data`; repo sources are mounted read-only at
`/opt/ghostroute-console/repo`.

The operator UI intentionally keeps first-page HTML small. Large evidence
surfaces use paging and explicit exports instead of rendering full datasets in
one response; `/traffic` defaults to a small page and accepts `pageSize` up to
100 for operator browsing. First-render pages use scoped read models rather
than the full report model: Budget, Dashboard, Live, Clients, Health, Catalog
and Settings load only the data each view renders. Short in-process caching is
allowed for read-only derived snapshot/window data and is invalidated by a
small TTL plus the latest snapshot timestamp; write/action endpoints do not use
that cache.
Playwright performance checks cover the main pages and JSON APIs with local
budgets of 2.5 seconds for page content and 1.5 seconds for API responses.

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
