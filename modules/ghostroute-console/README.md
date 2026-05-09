# GhostRoute Console

### Read-only operational workbench for GhostRoute routes, clients and health

[![Status](https://img.shields.io/badge/Status-Active-brightgreen)]()
[![Mode](https://img.shields.io/badge/Mode-Read--only-2F80ED)]()
[![Mobile](https://img.shields.io/badge/Mobile-%2Fm%20no--JS%20health-5B5FC7)]()
[![Tests](https://img.shields.io/badge/Tests-Functional%20%2B%20Performance-18A058)]()
[![Safety](https://img.shields.io/badge/Safety-No%20runtime%20deploys-F2B84B)]()

Documentation policy: English docs are the developer-facing ground truth. The
Console UI and module docs should describe factual read-only evidence, not imply
live control-plane authority.

Architecture details live in
[`docs/ghostroute-console-architecture.md`](/docs/ghostroute-console-architecture.md).
Monitoring semantics live in
[`monitoring-principles.md`](/modules/ghostroute-console/docs/monitoring-principles.md).
Operational details live in
[`operator-runbook.md`](/modules/ghostroute-console/docs/operator-runbook.md).

---

## TL;DR

GhostRoute Console is the read-only GUI for the existing GhostRoute operational
modules. It consumes JSON snapshots from Traffic Observatory, Health Monitor and
DNS/Catalog Intelligence, rebuilds bounded SQLite read models, and renders
Dashboard, Flow Explorer, DNS, Clients, Health, Live, Catalog, Budget, Reports
and Settings surfaces. The module is intentionally a consumer of evidence, not a
second source of truth or a hidden deploy mechanism.

```text
Module-owned JSON snapshots
  Traffic Observatory     Health Monitor     DNS/Catalog Intelligence
             |                 |                       |
             +-----------------+-----------------------+
                               |
                               v
SQLite read models and prepared summaries
  flow_sessions / dns_query_log / device_inventory / alarm_events
  console_page_summaries / read_model_state / console_settings
                               |
             +-----------------+------------------+
             v                                    v
Full Console workbenches                    Mobile Console /m
  wide tables, charts, panels                 capped rows, plain links,
  and deeper evidence                         no-JS mobile health
```

## Surface Status

Console has two operator surfaces over the same prepared data:

| Edition | Routes | Intended use | Shape |
|---|---|---|---|
| Full Console | `/`, `/traffic`, `/dns`, `/clients`, `/health`, `/live`, `/catalog`, `/budget`, `/reports`, `/settings` | Desktop/laptop investigations, wide tables, charts and evidence panels. | Next.js workbench with sidebar, filters, selected-row panels and deeper raw evidence where appropriate. |
| Mobile Console | `/m`, `/m/traffic`, `/m/dns`, `/m/clients`, `/m/health`, `/m/live`, `/m/catalog` | Remote triage from iPhone/Safari or constrained networks. | Capped rows, plain document links, compact cards and raw no-JS `/m/health`; every page links back to the full desktop route with `desktop=1`. |

| Surface | Status | Evidence source | Notes |
|---|---|---|---|
| Dashboard `/` | Active | `flow_sessions`, traffic summaries, quotas | Read-only traffic analytics, top clients and top destinations. |
| Flow Explorer `/traffic` | Active | `flow_sessions` | Dense flow workbench with URL-selected detail panel. |
| DNS Query Log `/dns` | Active | `dns_query_log` | Paged DNS evidence with client and catalog context. |
| Clients `/clients` | Active | `device_inventory`, flow rows | Physical-device inventory with channel and traffic evidence. |
| Health Center `/health` | Active | prepared health summaries, alarms, probes | Desktop triage with Deploy Gate, leaks and Alarm Center. |
| Live `/live` | Active | append-only live events and bounded summaries | Event snapshots and client activity, not a continuous per-second stream. |
| Catalog `/catalog` | Active | catalog snapshot read models | Review surface; runtime deploy remains separate. |
| Budget `/budget` | Active | traffic quota settings and summaries | VPS/LTE usage and quota posture. |
| Reports `/reports` | Active | stored snapshots and summaries | Read-only reporting surface. |
| Settings `/settings` | Active | non-secret runtime inventory | Shows posture without exposing endpoints or secrets. |
| Mobile `/m/*` | Active | same read models, capped pages | Ultra-light iPhone/Safari surface with no-JS `/m/health`. |

```text
Full Console
  /              Dashboard analytics and status overview
  /traffic       Flow Explorer workbench
  /dns           DNS Query Log
  /clients       Device Inventory
  /health        Health Center, Alarm Center, Deploy Gate and leaks
  /live          Event snapshots and client activity
  /catalog       Read-only catalog review
  /budget        Quota posture
  /reports       Stored reports
  /settings      Runtime inventory and safety gates

Mobile Console
  /m             Compact ops summary
  /m/traffic     Lightweight flow list
  /m/dns         Lightweight DNS list
  /m/clients     Lightweight clients list
  /m/health      Raw no-JS triage page
  /m/live        Compact event stream
  /m/catalog     Lightweight catalog list
```

## Why This Exists

GhostRoute already has module-owned CLI reports for routing, health, DNS,
catalog and traffic. Console exists to make those prepared facts easier to
inspect from a browser without creating a second operational authority. It keeps
the operator loop compact: confirm freshness, inspect flows, explain routing
decisions, verify client attribution, review alarms and decide whether a
separate deploy action is safe.

The design favors boring boundaries over convenience magic:

- JSON reports and SQLite read models are the machine contracts.
- Router/VPS runtime changes stay outside the GUI unless an explicit controlled
  action prepares an audited operator artifact.
- Empty or missing evidence renders as `not observed` or an empty state.
- Mobile pages are intentionally lighter than desktop workbenches.

## Overview

Console reads raw snapshots into `modules/ghostroute-console/data/` during local
development and into `/opt/ghostroute-console/data` on the VPS. The collector
stores raw JSON under `snapshots/` and an embedded SQLite database at
`ghostroute.db`. After each collection it rebuilds additive read models for the
GUI and APIs.

The current observability slice includes:

- Flow Explorer read models and route explanation evidence.
- DNS Query Log with route, catalog, risk and client context.
- Alarm Center, Deploy Gate, Health Center probes and leak-check evidence.
- Dashboard traffic analytics, quota posture and top clients/destinations.
- Client/device attribution with private operator-local registry support.
- Append-only live DNS/flow/route events and client activity summaries.
- Controlled catalog review, notification settings and audited ops actions.
- Mobile `/m` pages for reliable remote triage from iPhone/Safari.

## Public Commands

```bash
./modules/ghostroute-console/bin/ghostroute-console dev
./modules/ghostroute-console/bin/ghostroute-console build
./modules/ghostroute-console/bin/ghostroute-console collect-once
./modules/ghostroute-console/bin/ghostroute-console collect-light
./modules/ghostroute-console/bin/ghostroute-console alarm-state --json get
./modules/ghostroute-console/bin/ghostroute-console doctor
./modules/traffic-observatory/bin/traffic-summary --json today
./modules/traffic-observatory/bin/live-events-report --json --limit 200
```

## Safety Boundaries

- Runtime-safe by default: no router deploy, hidden service restart or direct
  catalog deploy.
- Controlled actions require explicit confirmation and write audit records.
- Catalog apply prepares local patch/rollback references; router deploy remains
  a separate operator action.
- No seed data appears in production UI.
- Basic Auth protects HTML, API and operator data routes in public deployment.
- Immutable Next.js assets and browser metadata probes may bypass Basic Auth to
  avoid iOS Safari static-asset auth loops.
- The public Console listener is separate from the Reality/layer4 `:443`
  surface.

## Data And Read Models

Core read models are rebuilt from factual snapshots:

| Read model | Purpose |
|---|---|
| `flow_sessions` | Flow Explorer, Dashboard route analytics, client traffic, safe DNS/SNI/egress evidence. |
| `dns_query_log` | DNS Query Log and DNS-interest context. |
| `device_inventory` | Clients inventory, attribution and selected-device detail. |
| `alarm_events` | Alarm Center evidence and operator state overlay. |
| `console_page_summaries` | Prepared Health/Live/mobile summaries for fast request paths. |
| `read_model_state` | Rebuild freshness, source version and cache keys. |
| `console_settings` | Non-secret settings and runtime posture. |

Traffic-driven surfaces use one selected traffic window at a time. Dashboard
route analytics preserve the accounting invariant:

```text
Total = Via VPS + Direct + Unknown
```

`Mixed` rows are split only when explicit VPS/direct evidence exists; remaining
unproven bytes stay `Unknown`. Destination views keep concrete destination rows
separate from explicit unattributed buckets, so attribution gaps remain visible
instead of being silently converted into invented sites.

Private client identity lives in gitignored
`modules/ghostroute-console/data/device-attribution.json` or the VPS runtime
data directory. Raw evidence keeps observed labels separately; Console resolves
stable display names through that private registry before grouping and rendering.

More detail: [operator-runbook.md](/modules/ghostroute-console/docs/operator-runbook.md).

## Local Development

GUI changes should be reviewed on a local seeded Console before any deploy. The
seeded database is synthetic, gitignored and lives under
`modules/ghostroute-console/data/gui-test/`.

```bash
cd modules/ghostroute-console/app
npm run seed:gui
npm run dev:gui
```

Use the local UI to inspect desktop wide, laptop and mobile layouts. The seeded
data includes enough flows, DNS rows, clients, live events and dashboard
analytics to test pagination, filters, charts, horizontal scroll and mobile
pages without waiting for real snapshots.

## Testing

Module-owned checks live under `modules/ghostroute-console/app`. The root
`tests/` layer orchestrates them through
[`tests/run-console.sh`](/tests/run-console.sh) without owning Console internals.

```bash
cd modules/ghostroute-console/app
npm test
npm run build
npm run test:e2e:gui
npm run test:perf
```

Root bridge commands:

```bash
./tests/run-console.sh --fast
./tests/run-console.sh --smoke
./tests/run-console.sh --perf
./tests/run-console.sh --all
```

`test:e2e:gui` is the functional desktop+mobile GUI/API smoke suite. It checks
rendered content, filters, row selection, mobile redirects, compact mobile pages
and JSON contracts. It must not contain timing assertions.

`test:perf` is the only local Playwright suite with timing budgets. Public
operator-network or VPN curl timings are deployment diagnostics, not
deterministic Playwright gates.

For one local pre-deploy gate:

```bash
cd modules/ghostroute-console/app
npm run test:gui:all
```

## Deployment Notes

The VPS deployment is still read-only from the Console perspective. It builds a
new Console image before replacing the running container, tags the prepared
image with the build commit, passes build metadata into the app, runs local
health/UI/API smoke and attempts rollback if smoke fails.

The dedicated public listener defaults to nginx on the configured non-443
Console port and proxies through a local buffering proxy to the Next.js
container. Caddy still owns certificate storage and the separate Reality/layer4
surface. Provider firewalls must allow the configured public TCP port; host UFW
alone is not enough if the cloud firewall drops packets before they reach the
VPS.

## Troubleshooting

If a page appears blank or much slower than usual, classify the failure before
changing runtime:

- slow TTFB on HTML suggests Console render, SQLite or snapshot path.
- fast TTFB with slow download suggests proxy, TLS, transport, MTU or client
  path.
- JS/CSS chunk failures suggest static asset, auth, proxy or browser cache
  handling.
- hanging `?_rsc` requests suggest Next.js App Router navigation/RSC behavior.
- fast API responses with stuck HTML suggest HTML streaming, proxy buffering or
  client transport.

Use the browser waterfall together with server-side curl baselines. If
server-local checks are fast but the operator browser is slow, change the public
listener/proxy/client path first, not Channel A/B/C, managed DNS, sing-box or
router firewall.

Detailed runbook:
[`operator-runbook.md`](/modules/ghostroute-console/docs/operator-runbook.md).

## Further Reading

- [Root GhostRoute README](/README.md)
- [GhostRoute Console architecture](/docs/ghostroute-console-architecture.md)
- [Monitoring principles](/modules/ghostroute-console/docs/monitoring-principles.md)
- [Operator runbook](/modules/ghostroute-console/docs/operator-runbook.md)
- [Root test orchestration](/tests/README.md)
- [Console post-MVP roadmap](/docs/ghostroute-console-post-mvp-roadmap.md)
