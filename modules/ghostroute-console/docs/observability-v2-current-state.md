# GhostRoute Console Observability V2 Current State

This file records the pre-implementation baseline for the Console
observability-v2 work. It is intentionally factual and conservative: it
describes what exists before the new read models and UI screens are added.

## Repository Baseline

- Work branch: `feature/console-observability-v2`.
- Baseline branch before work: `master`.
- Worktree state at branch creation: clean.
- Console stack: Next.js 15, React 19, Tailwind CSS, `better-sqlite3`,
  Playwright smoke/performance tests.
- Console app path: `modules/ghostroute-console/app`.
- Runtime data path in local development:
  `modules/ghostroute-console/data`.
- Runtime data path on VPS: `/opt/ghostroute-console/data`.

## Existing Console Surfaces

- Pages already exist for Dashboard, Traffic Explorer, Clients, Health,
  Catalog, Budget, Live, Reports and Settings.
- `/traffic` is the current traffic explorer and `/traffic/[id]` is the route
  explanation detail page.
- Live data is collected by polling `live-events-report --json`, storing raw
  live snapshots briefly and appending normalized events into SQLite.
- Controlled actions exist for catalog review/dry-run/apply preparation,
  notification ack/snooze and ops audit. They do not deploy router changes.
- No production UI seed data is allowed. Empty factual snapshots render empty
  states.

## Existing Data Contracts

Console consumes JSON from module-owned commands:

- `traffic-summary --json today`
- `traffic-report --json <period>`
- `router-health-report --json`
- `leak-check --json`
- `domain-report --json --all`
- `dns-forensics-report --json`
- `live-events-report --json --since <cursor> --limit N`

Markdown report output is for humans and LLM handoff only. Console must not
parse Markdown as an app contract.

## SQLite V4 Baseline

Current normalized tables include:

- `snapshots`
- `normalized_devices`
- `normalized_flows`
- `normalized_dns`
- `normalized_health`
- `normalized_catalog`
- `normalized_alerts`
- `events`
- `route_decisions`
- `live_cursors`
- `hourly_traffic`
- `audit_log`
- `notifications`
- `notification_settings`
- `catalog_reviews`
- `ops_runs`

V4 already stores evidence fields such as `client_ip`, `destination_ip`,
`destination_port`, `dns_qname`, `dns_answer_ip`, `sni`, `outbound`,
`matched_rule`, `rule_set`, `egress_ip`, `egress_asn`, `egress_country`,
`event_ts`, `source_log` and `event_id`.

## Routing Safety Boundary

Observability-v2 must not change production routing. The following invariants
remain outside this feature:

- Channel A owns LAN/Wi-Fi REDIRECT, DNS classification and the main managed
  data plane.
- Channel B and Channel C stay selected-client lanes and must not take over
  Channel A ownership.
- `STEALTH_DOMAINS` and `VPN_STATIC_NETS` remain the active managed catalogs.
- Legacy `VPN_DOMAINS`, `RC_VPN_ROUTE`, active `wgs1`, active `wgc1` and
  normal-production WireGuard behavior must not be reintroduced.
- Console may collect read-only reports and display prepared/audited actions,
  but must not silently deploy router or VPS routing changes.

## Deployment Baseline

- The deployed Console container listens on `127.0.0.1:3000`.
- Public access is through a dedicated non-443 Caddy HTTPS listener with Basic
  Auth and a local buffering proxy.
- Shared Reality/layer4 `:443` remains reserved for routing traffic, not the
  Console.
- Existing deploy target for this feature is Console-only:
  `modules/ghostroute-console/vps/deploy-readonly.yml`.

