# GhostRoute Console — Database Schema Reference

This is a navigation reference for the Console's local SQLite store. It groups the
tables by functional area and points at the authoritative definitions; it does
**not** restate every column. For the schema *narrative* (how versions v4–v16
evolved and why), see
[ghostroute-console-architecture.md](../../../docs/ghostroute-console-architecture.md);
for the exact DDL, see the migrations in
[app/src/lib/server/store.ts](../app/src/lib/server/store.ts).

The Console database is **read-derived**: collectors ingest sanitized router/VPS
snapshots, the store normalizes them, and an aggregate "pyramid" prepares the
window/page tables the GUI reads. The Console never mutates routing state.

## Versioning

Migrations are applied forward-only and tracked in `schema_migrations` (one row
per applied `version`). `getDb()` in
[store.ts](../app/src/lib/server/store.ts) runs `create table if not exists`
statements plus additive `addColumnIfMissing(...)` steps, so an existing database
is upgraded in place. There is no down-migration path; rebuild from snapshots if a
schema needs to be reset.

## Tables by area

Period-partitioned families (written as `name_<period>`) exist per
`hourly` / `daily` / `weekly` / `monthly` rollup; the base prefix row below
represents the whole family.

| Area | Tables | Purpose |
|---|---|---|
| Migrations & bookkeeping | `schema_migrations`, `read_model_state`, `aggregate_state`, `retention_runs`, `collector_runs`, `collector_errors`, `live_cursors`, `ops_runs` | Migration ledger, ingest/aggregate cursors, retention and collector run accounting. |
| Raw ingest | `snapshots` | Sanitized router/VPS snapshot payloads as ingested, before normalization. |
| Normalized layer | `normalized_devices`, `normalized_flows`, `normalized_dns`, `normalized_health`, `normalized_catalog`, `normalized_alerts` | Per-snapshot normalized rows the higher layers derive from. |
| Traffic facts & rollups | `traffic_facts`, `router_traffic_rollups`, `traffic_clients`, `traffic_dns_links`, `traffic_attribution_gaps`, `hourly_traffic` | `traffic-facts`-derived byte/flow accounting, client rollups and attribution-gap tracking. |
| Client traffic pyramid | `client_traffic_<period>`, `client_traffic_by_lane`, `client_destination_traffic_<period>`, `client_destination_by_lane` | Pre-aggregated per-client and per-destination traffic windows, including lane (channel) splits. |
| DNS pyramid | `dns_query_log`, `dns_log_<period>` | Raw DNS query log plus pre-aggregated DNS activity windows. |
| Prepared window/page tables | `console_page_summaries`, `traffic_window_snapshots`, `top_clients_window`, `top_destinations_window`, `console_settings` | Page-scoped prepared summaries and window snapshots the GUI serves directly. |
| Devices & enrichment | `device_inventory`, `destination_enrichment`, `ip_enrichment_cache`, `ip_prefix_catalog` | Device identity and destination/IP enrichment caches. |
| Routing decisions & evidence | `route_decisions`, `decision_candidates`, `client_route_evidence_defects`, `flow_sessions` | Observed routing decisions, candidate evidence and per-flow session state. |
| Filters | `filter_decisions`, `filter_rules` | Filter-rule definitions and the decisions they produced. |
| Events, alerts & notifications | `events`, `alarm_events`, `notifications`, `notification_settings` | Event stream, alarm lifecycle and notification delivery/settings. |
| Audit & catalog ops | `audit_log`, `catalog_reviews` | Operator action audit trail and catalog review records. |

## Related

- [data-pyramid.md](data-pyramid.md) — how the aggregate pyramid is built and read.
- [api-contracts.md](api-contracts.md) — endpoints that read these tables.
- [ghostroute-console-architecture.md](../../../docs/ghostroute-console-architecture.md) — data sources, schema evolution and trust model.
