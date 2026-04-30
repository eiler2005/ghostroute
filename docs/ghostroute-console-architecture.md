# GhostRoute Console Architecture

GhostRoute Console is a factual read-only observability surface inside the
`router_configuration` repository. It consumes module-owned JSON reports and
router log-tail evidence; it is not a routing engine and must not become a
second source of truth for router runtime state.

## Data Sources

Console reads machine-readable JSON from existing operational modules:

- `traffic-report --json` and `traffic-daily-report --json` for usage,
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

Route detail pages and the Traffic Explorer use best-evidence ordering. Exact
live route decisions from source logs are shown before DNS-only observations and
aggregate counter rows. This keeps the UI useful while preserving evidence
honesty: an aggregate `Other`/`Mixed` row remains available, but it should not
hide a more precise `sing-box` route event with timestamp, destination IP/port,
outbound and rule evidence.

Traffic UI must also explain operator-facing terms in-product:

- `VPS`, `Direct`, `Mixed` and `Unknown` describe the final route decision.
- `Home Wi-Fi/LAN`, `Channel A`, `Channel B` and `Channel C` describe the
  access/client lane.
- `exact`, `estimated`, `dns-interest`, `mixed` and `unknown` describe source
  confidence, not product success/failure.
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

## Live Tail

The first production-safe live mode is cursor polling, not a long-lived remote
shell tail:

1. `collect-live-once.mjs` calls `live-events-report --json`.
2. The report reads only recent router log lines and emits stable events.
3. Console normalizes those events into SQLite.
4. `/api/live/stream` streams recent SQLite events over Server-Sent Events.
5. The UI falls back to stored snapshot/events if live collection is disabled.

Runtime switches:

- `GHOSTROUTE_LIVE_MODE=poll` enables the live polling loop in the container.
- `GHOSTROUTE_LIVE_COLLECTOR_MODE=ssh|local` selects how the collector runs
  `live-events-report`.
- `GHOSTROUTE_LIVE_COLLECTOR_MODE=disabled` keeps the UI read-only over stored
  events and avoids noisy SSH failures.

## Deployment And Access

The deployed Console is a single Docker container behind the existing Caddy
route and Basic Auth. The app listens on `127.0.0.1:3000` on the VPS. The data
directory is `/opt/ghostroute-console/data`; repo sources are mounted read-only
at `/opt/ghostroute-console/repo`.

The restricted SSH surface is `ghostroute_readonly` with forced-command
whitelisting. Whitelisted commands must require `--json` and must remain
read-only.

## Safety Boundaries

- No hidden router deploy, firewall edit, service restart or catalog apply.
- Catalog apply in Console may prepare an audited local patch/rollback ref; a
  real router deploy remains a separate operator-approved action.
- Production UI must use factual data only. Fixtures are allowed only in tests.
- Public docs and exports must not contain secrets, private endpoint details,
  UUIDs, MACs, QR payloads or raw evidence unless explicitly redacted.
- Any future write/runtime action needs explicit confirmation, audit log,
  rollback path, smoke checks and redaction review.
