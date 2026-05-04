# GhostRoute Console Observability V2 Architecture

Observability-v2 turns Console into a fast operator workspace for route,
client, DNS, alarm, budget and live troubleshooting. The core rule does not
change: operational modules are the source of truth, while Console stores
factual snapshots, normalized evidence and derived read models for display.

## Goals

- Keep router/VPS routing untouched while improving diagnosis speed.
- Build the screens shown in the product mockups using factual data only.
- Add a durable read-model/cache layer so heavy UI pages do not rebuild the
  full evidence model on every request.
- Make route decisions explainable: DNS, catalog, rule, outbound, visible
  egress identity and confidence should be visible in one flow.
- Keep privacy and LLM-safe export behavior explicit and reversible.

## Source Modules

Console continues to call only read-only JSON commands:

- Traffic Observatory for counters, flows, destinations and live events.
- DNS/Catalog Intelligence for DNS queries, candidates and managed catalog
  state.
- Health Monitor for probes, leak checks and egress identity evidence.
- Console-local registry for private device identity and aliases.

All raw JSON snapshots stay available as evidence. Derived tables may be
rebuilt from snapshots.

## Storage Layers

The storage model has three layers:

1. Raw snapshots
   - Immutable JSON files plus `snapshots.payload_json`.
   - Short retention for live raw snapshots.
   - Longer retention for normal report snapshots.

2. Normalized evidence
   - Existing v4 tables remain the compatibility layer.
   - Rows preserve source evidence, confidence and raw refs.

3. Materialized read models
   - New v5 tables are optimized for UI and APIs.
   - They can be cleared and rebuilt without losing evidence.
   - They are invalidated by the latest snapshot ids and by registry mtime.

## SQLite V5 Read Models

Additive schema tables:

- `read_model_state`
  - model name, source snapshot version, registry version, rebuilt timestamp,
    row count, duration and status.
- `flow_sessions`
  - one row per operator flow/session-like record:
    client, device key, destination, IP, port, protocol, route, policy,
    matched rule, bytes, packets or connections, duration, risk, confidence,
    first seen, last seen and evidence refs.
- `dns_query_log`
  - query rows with client, domain, qtype, answer IP, catalog status, route
    decision, status, confidence, first/last observed and count.
- `device_inventory`
  - physical-device read model with aliases, profile, trust state, last seen,
    traffic today, route split, top domains and health status.
- `alarm_events`
  - normalized alarm center rows with severity, source, title, evidence,
    suggested action, status, snooze timestamp and confidence.
- `console_settings`
  - non-secret UI defaults such as redaction mode, quota thresholds and live
    refresh preferences.

## Cache Policy

- Server-side selectors read from v5 read models by default.
- In-process cache keys include latest snapshot version, registry version,
  period, filters and page.
- TTL defaults:
  - Dashboard and top cards: 30 seconds.
  - Flow/DNS/Clients pages: 60 seconds.
  - Live API/SSE snapshots: 5 to 15 seconds when live polling is enabled.
  - Settings and Reports metadata: 60 seconds.
- Write/action endpoints bypass derived cache and clear cache after writes.
- If v5 read models are missing or stale, selectors may rebuild synchronously
  for local/dev or return a compact "rebuild pending" state in production.

## Screen Map

- Dashboard
  - System status, traffic chart, top clients, top destinations, warnings,
    health timeline, route topology, snapshot freshness and safe operator
    actions.
- Flow Explorer (`/traffic`)
  - UniFi/ntopng-style table: client, destination, port, route, policy,
    bytes, duration, risk and confidence.
  - Side drawer shows route explanation, packet/DNS/timeline tabs and raw
    evidence disclosure.
- DNS Query Log (`/dns`)
  - Pi-hole/AdGuard-style query table: who queried, domain, type, answer,
    route decision, catalog status and status.
  - Side panels show top clients, top domains, new domains and DNS trend.
- Clients (`/clients`)
  - Device Inventory first, not only active clients.
  - Device detail shows top domains, route split, recent alarms and route
    behavior.
- Health Center (`/health`)
  - Alarm Center plus health probes. Alarms carry severity, source, evidence,
    suggested action, ack and snooze.
- Catalog (`/catalog`)
  - Managed, direct, candidate and static entries with hit counts, route
    impact and review/audit actions.
- Budget (`/budget`)
  - Quotas, forecast, biggest consumers, thresholds and budget alarms.
- Live (`/live`)
  - Troubleshooting mode with active clients, active destinations, recent DNS,
    route decisions and approximate throughput.
- Reports (`/reports`)
  - Privacy/Redaction mode and LLM-safe exports. Redaction changes display and
    exports only.
- Settings (`/settings`)
  - Data sources, collector cadence, retention, quota thresholds, notification
    settings and redaction defaults.

## Risk And Confidence Model

Risk is an operator signal, not a security verdict. Initial scoring:

- `high`: managed domain went direct, DNS leak signal, blocked/suspicious DNS,
  unknown high-traffic destination or stale critical source.
- `medium`: unknown destination spike, estimated route with large traffic,
  new domain requiring review or unusual direct route.
- `low`: expected managed/direct route with exact or strong estimated evidence.

Confidence remains separate:

- `exact`: direct source evidence from counters/log rows.
- `estimated`: derived from aggregated counters or connection share.
- `dns-interest`: DNS activity only, not proof of traffic bytes.
- `mixed`: multiple evidence sources with different quality.
- `unknown`: source lacks enough evidence.

## Privacy And Exports

- Redaction is a view/export transform only.
- Raw evidence stays in local/VPS runtime storage and is never pasted into
  public docs.
- LLM-safe exports mask device labels, IPs, real domains, VLESS/QR payloads,
  keys, ports and endpoints unless the operator explicitly disables redaction
  locally.
- The UI must label whether a field is real, redacted, estimated or not
  observed.

## Deployment Boundary

This feature deploys only the Console runtime and its local SQLite schema.
It must not run root `deploy.sh` or routing playbooks. Live verification can
use read-only `./verify.sh` and Console health/API checks after local tests
pass.

