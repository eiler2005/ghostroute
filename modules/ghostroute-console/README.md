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
modules. It consumes JSON snapshots from Traffic Observatory, Health Monitor,
DNS/Catalog Intelligence and a sanitized local routing-policy snapshot, rebuilds
bounded SQLite read models, and renders Dashboard, Flow Explorer, DNS, Clients,
Health, Live, Catalog, Budget, Reports and Settings surfaces. The module is
intentionally a consumer of evidence, not a second source of truth or a hidden
deploy mechanism.

```text
Module-owned JSON snapshots
  Traffic Observatory     Health Monitor     DNS/Catalog Intelligence
  Sanitized routing policy snapshot
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
| Mobile Console | `/m`, `/m/traffic`, `/m/dns`, `/m/clients`, `/m/health`, `/m/live`, `/m/catalog`, `/m/settings` | Remote triage from iPhone/Safari or constrained networks. | Capped rows, plain document links, compact cards and raw no-JS `/m/health`; every page links back to the full desktop route with `desktop=1`. |

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
| Settings `/settings` | Active | non-secret runtime inventory and sanitized routing-policy snapshot | Shows runtime posture, selected Home Wi-Fi/LAN full-VPS clients and Channel A/B/C profile policy without exposing endpoints or raw MAC/IP/DNS. |
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
  /m/settings    Routing policy and runtime posture
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
- Routing policy Settings for selected Home Wi-Fi/LAN full-VPS clients and
  Channel A/B/C profile policy from a sanitized local snapshot.
- Append-only live DNS/flow/route events and client activity summaries.
- Controlled catalog review, notification settings and audited ops actions.
- Mobile `/m` pages for reliable remote triage from iPhone/Safari.

## How It Works

Console is a read-only evidence pipeline with two browser editions on top of the
same prepared data.

```text
1. Source modules produce JSON
     traffic-summary / traffic-facts / traffic-daily-report
     router-health-report / leak-check / deploy-gate evidence
     domain-report / dns-forensics-report
     policy-snapshot.local.json for selected full-VPS/profile policy
       (rendered from Vault during Console deploy)
     live-events-report for bounded router log-tail events

2. The collector stores facts
     raw JSON snapshots -> data/snapshots/
     normalized rows    -> SQLite source tables
     append-only live   -> events / route_decisions / live_cursors

3. Read-model rebuild prepares UI data
     flow_sessions          -> Dashboard, Flow Explorer, Clients, Live activity
     dns_query_log          -> DNS Query Log and DNS-interest evidence
     device_inventory       -> Clients physical inventory and attribution
     alarm_events           -> Alarm Center and operator state overlay
     console_page_summaries -> fast Health, Live and mobile shells
     read_model_state       -> freshness, source versions and cache keys

4. Request-time selectors stay bounded
     pages read prepared rows, not full raw reports
     missing evidence renders as not observed
     route accounting keeps Total = Via VPS + Direct + Unknown
     legacy traffic-report rows stay debug-only and are excluded from GUI totals
     short in-process cache follows read_model_state and snapshot metadata

5. Full Console serves investigations
     /traffic, /dns, /clients, /health and /live keep wide tables,
     filters, selected-row panels, charts and deeper evidence where useful.

6. Mobile Console serves remote triage
     /m/* uses the same read models with capped rows and plain links.
     /m/health is raw no-JS HTML so iPhone/Safari can read health state from one
     authenticated document without waiting for React hydration.
```

The key boundary is simple: Console renders prepared facts and operator state
overlays; router/VPS runtime changes remain separate explicit actions.

Traffic accounting has an additional guardrail: operational Dashboard, Clients
and Live totals are built only from eligible Traffic Observatory facts whose byte
split satisfies `bytes = via_vps_bytes + direct_bytes + unknown_bytes` with no
negative components. Legacy `traffic-report`-derived allocation rows can remain
stored for debug/history, but they are not allowed into prepared traffic windows.

## Public Commands

```bash
./modules/ghostroute-console/bin/ghostroute-console dev
./modules/ghostroute-console/bin/ghostroute-console build
./modules/ghostroute-console/bin/ghostroute-console collect-once
./modules/ghostroute-console/bin/ghostroute-console collect-light
./modules/ghostroute-console/bin/ghostroute-console repair-aggregates --from 2026-05-07 --to 2026-05-08 --dry-run
./modules/ghostroute-console/bin/ghostroute-console verify-post-deploy
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
| `client_traffic_5min`, `client_traffic_hourly`, `client_traffic_daily` | Prepared client-first traffic aggregates for Dashboard, Clients, Budget and week/month windows. |
| `client_traffic_by_lane` | GUI-ready per-client lane summary for `/clients` tabs: `all`, `client_observed`, `service_system`, `privacy_risk`, `shared_infra` and `unknown_review`. |
| `client_destination_by_lane` | Matching per-client destination drilldown by lane/category/decision hint for the Clients side panel. |
| `client_route_evidence_defects` | Per-client/per-destination route evidence diagnostics for `unknown_route`, `counter_allocated`, `mismatch` and `intent_only_*` bytes; rendered separately from content lanes. |
| `ip_prefix_catalog`, `ip_enrichment_cache` | Optional local-first IP/provider enrichment cache. Advisory metadata only; never changes routing or blocking. |
| `dns_log_5min` | Prepared DNS query aggregate for DNS Query Log and DNS-interest counts. |
| `top_clients_window`, `top_destinations_window` | Pre-ranked today/week/month lists built by the collector for every traffic class. |
| `traffic_window_snapshots` | Prepared today/week/month dashboard, client, DNS and report payloads for `all`, `client`, `personal_cloud`, `service_background` and `unclassified`. |
| `aggregate_state` | Watermarks/status for prepared aggregate layers and dashboard windows. |
| `console_page_summaries` | Prepared Health/Live/mobile summaries for fast request paths. |
| `read_model_state` | Rebuild freshness, source version and cache keys. |
| `console_settings` | Non-secret settings and runtime posture. |

Prepared traffic rankings are intentionally registry-first. Top clients contain
only non-zero client traffic that resolves through the private operator device
attribution registry; service channel labels, DNS-interest rows and accounting
buckets stay available for diagnostics but are not ranked as clients. Detail
workbenches (`/traffic`, `/dns`, `/live` and their mobile/API variants) always
force the current Moscow day, while Dashboard/Clients/Reports use the prepared
`today`, `week` and `month` aggregate windows.

Default GUI destination labels prefer DNS/SNI/domain evidence and platform or
category labels. Raw IP addresses remain available in DNS answers, route
diagnostics, exports and raw evidence, but they are not used as primary
destination labels in Dashboard, Flow Explorer, Live, Clients or mobile lists.
When an IP-only row has local IP-ASN enrichment, the primary label can be a
provider/source label such as `Facebook network`, `Google network` or
`Yandex network`; the raw IP remains in diagnostics.
Pseudo channel/accounting labels such as Home Reality ingress are route context,
not Top destinations.

Traffic-driven surfaces use one selected traffic window at a time. Dashboard
route analytics preserve the accounting invariant:

```text
Total = Via VPS + Direct + Unknown
```

`Mixed` rows are split only when explicit VPS/direct evidence exists; remaining
unproven bytes stay `Unknown`. Destination views keep concrete destination rows
separate from explicit unattributed buckets. Selected-client popular-sites views
rank byte-attributed destinations only; DNS query popularity is rendered in its
own selected-device DNS panel so query volume is not confused with traffic
volume.

The client lane layer is rebuilt after the normal traffic pyramid. It lets the
operator inspect client traffic by lane locally before changing GUI filters:
for example a device can have non-zero `all` traffic while `client_observed`
is small and most bytes sit in `service_system` or `unknown_review`.
The Clients page also renders selected-device drilldowns. Popular sites come
from byte-attributed client destinations, service/system sites remain separate,
and unmapped counter residual is shown as a summary rather than ranked as a
site. The separate Latest DNS domains block lists DNS query counts for the
selected device without turning those counts into byte estimates.

IP-only destinations can be enriched locally from an iptoasn TSV snapshot. For
the current IPv4 traffic, download `ip2asn-v4-u32.tsv.gz` and run:

```bash
cd modules/ghostroute-console/app
npm run import:iptoasn -- --file /path/to/ip2asn-v4-u32.tsv.gz --refresh-cache
npm run repair:aggregates -- --full
npm run verify:aggregates
```

The importer fills `ip_prefix_catalog` and `ip_enrichment_cache`, then the lane
read model maps IP-only destinations into conservative provider families such as
messaging, social, meeting, CDN/cloud hosting, vendor infra or generic network
provider. It does not call public APIs and does not change routing, blocking,
filters or facts.

For a one-off live review pass, an operator may also import a gitignored RDAP
review export into the same advisory cache:

```bash
cd modules/ghostroute-console/app
npm run import:rdap-review -- --file ../../data/review/rdap-enrichment.json
npm run repair:aggregates -- --full
npm run verify:aggregates
```

RDAP review imports are manual and local: they cache provider/category hints for
already observed IP destinations, but they do not add static routes, managed
domains, direct exceptions or blocking rules. Shared CDN/cloud ranges should
remain provider labels unless separate DNS or narrow service-owned CIDR evidence
justifies a routing catalog change.

Unknown or weakly classified destinations are reviewed through local files, not
manual per-flow GUI buttons. After rebuilding aggregates, export the queue:

```bash
cd modules/ghostroute-console/app
npm run export:review-queue -- --window today --limit 100
```

The command writes gitignored JSON and Markdown files under
`modules/ghostroute-console/data/review/`. These files include destination
addresses/domains, current lane/category hints, bytes, client counts and route
evidence defects. They are intended for offline/LLM-assisted classification;
stable findings should become deterministic local rules and then be verified
with `repair:aggregates` + `verify:aggregates`.

The collector stores timestamps in UTC and derives UI windows in Moscow local
time. `today`, `week` and `month` are rebuilt into prepared aggregate tables and
`traffic_window_snapshots` after each collection. Dashboard, Clients and safe
report payloads must exist for `all`, `client`, `personal_cloud`,
`service_background` and `unclassified`; `all` must never be narrower than
`client`. Week/month request paths must read those prepared entities and must
not scan raw `normalized_flows`, `normalized_dns`, `events` or snapshot
payloads. If a prepared historical window is absent, the UI should render a
bounded empty/fallback state until the next collector rebuild rather than doing
heavy request-time work.

Operational pruning keeps raw normalized traffic/DNS/live rows bounded by
retention defaults while the aggregate/read-model tables carry the UI history.
Heavy `traffic`, `dns` and `live` snapshot payloads older than the short
troubleshooting window may be stripped once a newer payload of the same type is
available.

Local full SQLite copies are disabled by default on the VPS
(`GHOSTROUTE_DB_BACKUP_MODE=none`) so the Console cannot duplicate a large
`ghostroute.db` onto the same small disk after every cleanup. In this disabled
mode, retention prunes existing local full DB copies to zero. Operators who want
same-disk safety copies must opt in with `GHOSTROUTE_DB_BACKUP_MODE=local_daily`;
retention then enforces max file count, max total bytes, and the disk guard
(`GHOSTROUTE_DB_BACKUP_MIN_FREE_BYTES` / `GHOSTROUTE_DB_BACKUP_MAX_USED_PCT`).
The collector also folds legacy `ghostroute.db.backup-*` files into the managed
`backups/` retention set. Durable production backup should live outside this
filesystem, for example a host-level encrypted backup or restic target.

Private client identity lives in gitignored
`modules/ghostroute-console/data/device-attribution.json`,
`modules/ghostroute-console/data/device-attribution.local.json` or the VPS
runtime data directory. Raw evidence keeps observed labels separately; Console
resolves stable display names through that private registry before grouping and
rendering. The registry may include `lan-host-*`, profile aliases, hostnames,
`ip_aliases` and `mac_aliases`; use the `.local.json` file for real household
addresses so private LAN/MAC data does not enter git.

Private routing-policy display state lives in the same gitignored data
directory as `policy-snapshot.local.json`, or in the file pointed to by
`GHOSTROUTE_CONSOLE_POLICY_SNAPSHOT_PATH`. It must contain only sanitized
selectors: friendly labels/profile names plus masked tokens such as
`ip-<hash>` and `mac-<hash>`. Console ignores raw MAC/IP/DNS values for display,
recomputes summary counts, and shows Channel B/C profiles as managed-split or
compatibility lanes without full-VPS support. The read-only Console deploy
renders this snapshot from the Ansible/Vault selected full-VPS variables before
syncing private Console data, so Settings does not depend on a manually-created
local JSON file.

LAN/Wi-Fi attribution is registry-first end to end. Router
`lan-device-counters-snapshot` emits the historical eight counter columns plus
optional MAC/hostname columns, while `traffic-evidence` / `traffic-facts` carry
flow/DNS identity hints such as `client_ip`, DNS qname/answer and route
evidence. Console prepared windows use those hints only to resolve rows to
explicit registry clients. Pseudo channels, DNS-interest rows, accounting
buckets without a registry client, and zero-byte rows are excluded from client
rankings and client APIs.

For Console-only deployment use the Console playbook, not root `./deploy.sh`.
When changing attribution collection or deliberately discarding polluted
snapshots, run from `ansible/`:

```bash
ansible-playbook ../modules/ghostroute-console/vps/deploy-readonly.yml -e ghostroute_console_reset_db=true
```

The reset quarantines old SQLite files under the VPS Console data backups
directory and starts fresh collection from the new registry/collector contract.

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
pages without waiting for real snapshots. Seeding also rebuilds prepared
today/week/month traffic windows.

## Testing

Module-owned checks live under `modules/ghostroute-console/app`. The root
`tests/` layer orchestrates them through
[`tests/run-console.sh`](/tests/run-console.sh) without owning Console internals.

```bash
cd modules/ghostroute-console/app
npm test
npm run build
npm run verify:timezone
GHOSTROUTE_CONSOLE_DATA_DIR=../data/gui-test npm run verify:aggregates
GHOSTROUTE_CONSOLE_DATA_DIR=../data/gui-test npm run bench:dashboard
GHOSTROUTE_CONSOLE_DATA_DIR=../data/gui-test npm run report:db-size
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

The live VPS performance gate uses the same
`tests/e2e/performance.spec.ts` against the deployed Console runtime. Run it from
the control machine after deploy/post-deploy verification:

```bash
cd ansible
ansible-playbook -e @group_vars/all.yml -e @group_vars/vps_stealth.yml -e @secrets/stealth.yml ../modules/ghostroute-console/vps/performance-live.yml
```

The playbook copies the current checkout's existing performance specs to a
temporary VPS workspace, starts an ephemeral Playwright sidecar on the VPS host
network, and points it at the local Console listener. It does not seed test data
or mutate Console runtime state; temporary npm/test artifacts are created under
`/tmp` and removed after the run.

`verify:timezone` protects UTC-storage/MSK-window math. `verify:aggregates`
checks that prepared windows exist and reconcile to dashboard attribution
coverage. `verify:post-deploy` is the runtime guard after a Console release: it
requires the latest full collector to finish cleanly, checks the required
Traffic Observatory snapshots, verifies class-aware prepared windows for
Dashboard/Clients/reports and enforces aggregate byte splits. `bench:dashboard`
reads Dashboard from prepared windows repeatedly and fails if request-time reads
regress. `report:db-size` prints SQLite table sizes for retention review.

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

After a Console deploy, wait for any startup collector lock to clear, then run a
standard full collection (`npm run collector:once` inside the container or the
module wrapper on a local runtime). The post-deploy gate is:

```bash
npm run verify:post-deploy
npm run verify:aggregates
npm run verify:timezone
npm run bench:dashboard
npm run report:db-size
```

For the browser/API timing gate on the deployed VPS runtime:

```bash
cd ansible
ansible-playbook -e @group_vars/all.yml -e @group_vars/vps_stealth.yml -e @secrets/stealth.yml ../modules/ghostroute-console/vps/performance-live.yml
```

The expected full collector set includes `traffic_summary`, `router_rollups`,
`traffic_evidence` and `traffic_facts`; the prepared `dashboard`, `clients` and
`reports_llm_safe` windows must exist for `all`, `client`, `personal_cloud`,
`service_background` and `unclassified`.

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
- [Data pyramid](/modules/ghostroute-console/docs/data-pyramid.md)
- [Operator runbook](/modules/ghostroute-console/docs/operator-runbook.md)
- [Root test orchestration](/tests/README.md)
- [Console post-MVP roadmap](/docs/ghostroute-console-post-mvp-roadmap.md)
