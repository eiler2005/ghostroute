# GhostRoute Console Operator Runbook

This runbook keeps the dense operational notes that used to live in the module
README. The README is the landing page; this document is the place to look when
debugging collection, browser loading, read-model freshness or public listener
behavior.

## Data Directory

Local development defaults to:

```text
modules/ghostroute-console/data/
```

VPS runtime uses:

```text
/opt/ghostroute-console/data
```

The collector writes raw JSON snapshots under `snapshots/` and an embedded
SQLite database at `ghostroute.db`.

The dedicated public listener defaults to nginx and proxies to
`/usr/local/bin/ghostroute-console-buffer-proxy` on the VPS. Caddy still owns
certificate storage and the separate Reality/layer4 surface. Legacy dedicated
Caddy Console blocks may remain only as rollback configuration and should be
removed or disabled while nginx owns the Console port. The dedicated Console
port is TCP/TLS only and uses nginx response compression plus a small TLS buffer
so larger HTML/JSON responses stay reliable over the operator network path;
browsers must not depend on HTTP/3/QUIC for Console access. Provider-level
firewalls must allow the configured public TCP port; host UFW alone is not
enough if the cloud firewall drops packets before they reach the VPS.

## Device Attribution Registry

Operator-local client identity is stored in the same data directory as
`device-attribution.json`. It is intentionally gitignored runtime data: Console
uses it as the private authoritative client registry for stable labels, roles,
primary channel and explicit Channel A/B/C/LAN aliases. Dashboard, Traffic
Explorer, DNS Query Log, Clients, Live, Budget, Reports, Settings and JSON
endpoints all pass raw rows through the same resolver before grouping or
rendering client names.

Raw evidence still keeps the observed labels separately. New or unmatched
`mobile-source-*` counters remain diagnostics until the operator adds an
explicit profile, MAC or IP alias.

Observed LAN labels may be renamed in this private registry without changing the
router report format. For example, a stable `lan-host-*` alias can carry a
human device/owner label while the raw snapshot still preserves the original
observed id for audit.

Registry entries may also define a physical `device_key`, `device_label`,
`owner` and `device_type`. The Clients page renders that physical Device
Inventory first, then lists observed identities such as Channel A/B/C profiles,
LAN host ids, MAC/IP aliases and report-local redacted labels as evidence for
the selected device.

Home Reality report-local aliases such as `mobile-client-N` or
`report-mobile-profile-N` are not stable client identities. When a row carries a
stable `profile` such as `iphone-N`, Console resolves and aggregates by that
profile/registry entry and keeps the redacted report alias only as evidence.

`traffic-report` JSON rows carry evidence-contract fields such as
`canonical_hint`, `observed_label`, `redacted_label`, `identity_type`,
`matched_by`, `bytes_confidence`, `allocation_basis`, `counter_scope`,
`destination_class`, `destination_evidence` and `flow_group_key`. Console treats
these fields as evidence hints, while private ownership and physical-device
grouping remain in the operator-local registry.

## Collection Cadence

Real live tail collection is enabled with `GHOSTROUTE_LIVE_MODE=poll` plus
`GHOSTROUTE_LIVE_COLLECTOR_MODE=ssh|local`. If the live collector mode remains
`disabled`, `/api/live/stream` still serves the stored append-only events from
snapshots.

The VPS deployment defaults to read-only SSH collection through the generated
`ghostroute_readonly` forced-command key:

- lightweight current-day traffic summaries every 5 minutes during the day and
  every 30 minutes during 23:00-06:00 Moscow time;
- full snapshots every 30 minutes during 06:00-22:59 Moscow time;
- full snapshots every 3 hours during 23:00-05:59 Moscow time;
- live event polling every 10 minutes during the day and every 30 minutes during
  23:00-06:00 Moscow time by default;
- deploy-gate snapshots with the full pass.

Deploy-gate CRIT output is stored even when the command exits non-zero, so
Health Center can show the exact deploy blocker. Deploy-gate JSON must carry a
`source.command`; the Console collector also applies a narrow compatibility
default for older live-check payloads that omitted `source`.

Collectors keep per-job locks to avoid duplicate runs and a short shared SQLite
writer lock only while storing snapshots and rebuilding read models. Stale locks
are recovered by PID; writer contention waits for up to 120 seconds before a
collector skips; startup light/live collection is serialized after the full
startup pass. The full snapshot timeout defaults to 15 minutes because it may
run several read-only reports in one pass.

Retention defaults are intentionally small enough for a 40 GB VPS: raw factual
snapshots are kept for 7 days, fine traffic buckets for 8 days, hourly/daily
traffic and DNS aggregates for about 35 days, live raw snapshots for 6 hours,
and full local SQLite safety backups are disabled unless explicitly enabled with
`GHOSTROUTE_DB_BACKUP_MODE=local_daily`. In disabled mode, retention removes
existing local full DB copies instead of preserving one large same-disk file.
When local backups are enabled, the collector keeps them under `data/backups/`,
moves legacy root-level `ghostroute.db.backup-*` files into that managed set,
and enforces max count, max total bytes and disk guards before creating a new
copy. Raw normalized
traffic, DNS, event and route-decision rows are bounded by the raw retention
window; service/background traffic can be pruned sooner than client traffic.
Heavy `traffic`, `dns` and `live` snapshot payloads older than the short
troubleshooting window may be stripped once a newer payload of the same type
exists. The live collector stores normalized events in SQLite; the per-poll raw
JSON is only short-term troubleshooting material.

## Read Models And Accounting

The observability read models are bounded caches for the Console UI: by default
they keep the most recent 5,000 flow rows, 20,000 DNS rows, 10,000 live DNS
rows, 5,000 device rows and 2,000 alarm rows while raw snapshots remain under
the normal retention policy.

Observability v2 rebuilds additive SQLite read models after each collection:
`flow_sessions`, `dns_query_log`, `device_inventory`, `alarm_events`,
`client_traffic_5min`, `client_traffic_hourly`, `client_traffic_daily`,
`dns_log_5min`, `top_clients_window`, `top_destinations_window`,
`traffic_window_snapshots`, `console_page_summaries`, `read_model_state` and
non-secret `console_settings`. These tables feed `/api/flows`, `/api/dns`,
`/api/alarms`, Flow Explorer, DNS Query Log, Alarm Center, Dashboard, Clients and
the compact mobile Health/Live shells while preserving the normalized source
tables as the collection contract.

The `flow_sessions` read model includes the safe DNS/SNI and egress evidence
fields needed by the Flow Explorer inline detail panel. Missing source evidence
is rendered as `not observed`; when a flow has nearby same-client DNS evidence
or a prepared DNS link, the UI may show the linked domain as `DNS-linked` rather
than promoting pseudo buckets such as encrypted ingress to primary site names.

GUI request paths should read prepared tables and small snapshot payloads only.
Health, Live, mobile pages and JSON APIs use snapshot metadata for cache
versioning and the prepared `health_mobile` / `health_shell` / `live_mobile`
summaries for status cards, capped alarms, Deploy Gate, leak evidence and
freshness. They must not parse the full latest traffic report or rebuild the
desktop Health model just to render the shell, freshness strip or navigation
chrome.

Traffic windows are prepared after each collector pass. Source timestamps stay in
UTC in SQLite, while `today`, `week` and `month` are keyed by Moscow local time.
Dashboard, Clients, DNS and safe report APIs should use
`traffic_window_snapshots` plus the aggregate tables for all three windows. The
prepared Dashboard, Clients and `reports_llm_safe` windows are class-aware and
must exist for `all`, `client`, `personal_cloud`, `service_background` and
`unclassified`; `all` must include any client visible in a narrower class.
Week/month must not scan `normalized_flows`, `normalized_dns`, `events` or raw
snapshot payloads on the request path. If a prepared historical window is
missing, render a bounded empty/fallback state until collection rebuilds it. The
diagnostic rollback switch is `GHOSTROUTE_CONSOLE_USE_PREPARED_WINDOWS=0`; it is
not the production data path for large databases.

The rollup path is incremental: after the first backfill, each collector rebuilds
only the current Moscow day plus a small dirty overlap
(`GHOSTROUTE_ROLLUP_REBUILD_HOURS`, default 6h), updates 5-minute buckets, rolls
those into hourly/daily aggregates, and then rewrites the small prepared
`today`/`week`/`month` payloads. Historical week/month views therefore come from
the aggregate pyramid, not from a fresh raw scan on every deploy or restart. If
an older day needs correction, run an explicit backfill/repair job rather than
making startup collection rescan old raw rows.
Use `ghostroute-console repair-aggregates --from <YYYY-MM-DD> --to <YYYY-MM-DD>`
for that repair path; date-only arguments are Moscow-day boundaries and `--to`
is exclusive. Run `--dry-run` first on live data. If the retained source rows are
already gone, the command records `missing_source` in `aggregate_state` and does
not delete existing historical aggregate chunks.
The detailed data-pyramid contract is documented in
[data-pyramid.md](/modules/ghostroute-console/docs/data-pyramid.md).

## Post-Deploy Collector Guard

Root `./deploy.sh` updates the router/runtime side of the repository. Console
container releases use the module VPS playbook:

```bash
cd ansible
ansible-playbook -i inventory/stealth.yml -e @secrets/stealth.yml ../modules/ghostroute-console/vps/deploy-readonly.yml
```

After the container is replaced, a startup collector may already be running. If
`collector:once` says another run is active, wait and retry; do not delete lock
files unless PID-based stale-lock recovery has failed and the operator has
inspected the process table. The normal post-deploy sequence is:

```bash
npm run collector:once
npm run verify:post-deploy
npm run verify:aggregates
npm run verify:timezone
npm run bench:dashboard
npm run report:db-size
```

`verify:post-deploy` is the fast guard for the class-aware traffic pipeline. It
checks that no collector locks are active, the latest full collector completed
without errors, required full-collector snapshots (`traffic_summary`,
`router_rollups`, `traffic_evidence`, `traffic_facts`) are present,
Dashboard/Clients/reports prepared windows exist for all traffic classes, and
aggregate byte splits still satisfy `bytes = via_vps_bytes + direct_bytes +
unknown_bytes`. This is the guard that catches a release where `/clients` or
Dashboard would accidentally show only `client` traffic while hiding
`personal_cloud` or `service_background` clients from the `all` view.

## Live VPS Performance Gate

Local `npm run test:perf` seeds a synthetic GUI database and is the deterministic
development timing gate. To measure the deployed Console against live VPS data,
use the module playbook instead:

```bash
cd ansible
ansible-playbook -e @group_vars/all.yml -e @group_vars/vps_stealth.yml -e @secrets/stealth.yml ../modules/ghostroute-console/vps/performance-live.yml
```

The playbook runs the existing `tests/e2e/performance.spec.ts`; it does not fork
or replace the performance suite. The Console runtime container is Alpine-based
and read-only, so browser tests run in an ephemeral Microsoft Playwright sidecar
container on the VPS host network. The playbook copies the current checkout's
test directory to a temporary VPS workspace, the sidecar mounts that copy
read-only, installs the matching `@playwright/test` runner in a temporary
workspace, and connects to the local Console listener at `http://127.0.0.1:3000`.

The live config keeps the spec's page/API budgets intact but allows a longer
global test timeout for warmup. The spec itself warms page and API paths before
timed assertions so one-time read-model/cache initialization is not measured as a
steady-state render or API regression. Temporary npm and Playwright artifacts are
removed at the end of the playbook run.

Traffic-driven UI surfaces use one selected traffic window at a time. The
default `today` window means the operator-local day, from Moscow midnight to the
latest collected traffic window. Dashboard, Flow Explorer and Clients do not
borrow stale historical traffic totals when the current-day window is empty.
Clients still keeps historical inventory metadata for names, roles, aliases and
last-seen state, but displayed traffic totals, route split and selected client
domains come from the selected window only.

Operator client attribution is registry-first. Keep real household MAC/IP/host
aliases in gitignored `device-attribution.local.json` in the Console data
directory, with public shape documented by
`docs/device-attribution.example.json`. The collector and bounded fallback
selectors may use inventory-derived IP/MAC/hostname hints only to resolve a row
to an explicit registry client; unresolved `lan-host-*`, channel labels,
DNS-interest rows and zero-byte buckets must stay out of Top clients.
LAN/Wi-Fi identity depends on the router-side Traffic Observatory scripts as
well as the Console container. When `traffic-report` or
`lan-device-counters-snapshot` changes, deploy the router runtime first so new
snapshots carry `client_ip`, `mac`, `hostname` and `observed_label`; then deploy
Console with a DB reset if older snapshots were grouped without that identity.

The Console VPS deploy playbook syncs only `device-attribution.json`,
`device-attribution.local.json`, and `device-aliases.json` from the local
gitignored Console data directory into the VPS Console data directory. It does
not sync SQLite databases, auth files, backups or generated artifacts. After a
collector contract change, deploy Console from `ansible/` with
`ansible-playbook ../modules/ghostroute-console/vps/deploy-readonly.yml -e ghostroute_console_reset_db=true`
so polluted snapshots are quarantined and fresh prepared windows are collected.
For Traffic Accounting v2 rollouts, verify that `/api/health` lists a
`traffic_facts` latest snapshot after the first standard collector run. If
`traffic_facts` is missing while legacy `traffic` is present, check the
read-only forced-command shell whitelist before debugging the Console
normalizer: the collector fetches router/VPS facts through that constrained SSH
path.

Because detailed snapshots can be cumulative, Console derives current-window
client rows from positive deltas between same-day samples per observed source,
then aggregates those sources into the canonical registry client. Dashboard
KPI totals may still reconcile to authoritative summary counters, but
individual clients, Apps and popular-site inference must use only the
canonical client's current-window aggregate rows. Do not reconcile one client
against the global Dashboard total, and do not add synthetic `all` lanes to
class-specific rows.

Destination views share the `traffic-report --json`
`destination_attribution_coverage` contract. Concrete destination rows plus
explicit `Unknown/Unattributed ...` accounting buckets must add back to the
observed client/channel total for the selected window. The unknown buckets carry
real counter bytes, `destination_evidence=none` and
`allocation_basis=unattributed_bucket`. Selected-client popular-sites panels do
not convert DNS-interest into byte accounting. If the destination layer is
incomplete, Console shows the unmapped residual separately and lists
device-specific DNS domains in a query-count panel. The selected-client DNS
panel defaults to client-facing domains; the operator can explicitly include
service/system domains without changing the `/dns` query log.

Dashboard, Flow Explorer, Clients and Live all read the same normalized
accounting rows, so an attribution gap is visible consistently instead of
disappearing on one page and looking like a mismatch on another. Dashboard route
analytics keep the same accounting invariant: `Total` equals `Via VPS + Direct
+ Unknown`. `Mixed` rows are split with explicit VPS/direct evidence from the
read model; only remaining unproven bytes become `Unknown`.

For selected-client details, Console derives an activity series from sequential
current-window device snapshots. Multiple snapshots become hourly deltas; if a
client only appears in one current snapshot, the chart shows that hour as a
snapshot total rather than pretending to know the earlier peak time.

## Browser Loading Diagnostics

If `/health` or another Console page appears blank or takes much longer than the
usual first render, do not tune nginx, Caddy, Next.js or router runtime blindly.
First collect browser evidence, then compare it with the server-side baseline.
If the page is currently fast, leave runtime unchanged and treat the existing
`nginx -> buffer proxy -> Next.js` path as healthy. The buffer proxy requests
upstream HTML over HTTP/1.1 with `Connection: close` so Next.js streaming
responses have a deterministic end before nginx forwards them to browsers.

Browser evidence:

- Chrome: open DevTools, use the Network panel, enable Preserve log and Disable
  cache, hard reload the page, then inspect the `Document`, `?_rsc`, JS chunks,
  CSS and API rows. Save a HAR/export if available; otherwise keep a waterfall
  screenshot and the names of stalled requests.
- Safari on macOS or iOS: use Web Inspector Network, reload the same page and
  compare whether the stalled resource is the HTML document, an RSC request, a
  static chunk or an API call. For iPhone, use Safari remote Web Inspector from
  the Mac before changing server config.

Classify the failure before changing anything:

- slow TTFB on the HTML document means a Console server/render/SQLite/snapshot
  issue is more likely.
- fast TTFB with slow download or a mid-body stall points to proxy, TLS,
  transport, MTU or client-path behavior.
- JS or CSS chunk failures point to static asset, auth, proxy or browser cache
  handling.
- hanging `?_rsc` requests point to Next.js App Router navigation/RSC behavior.
- fast API responses with stuck HTML point to HTML streaming, proxy buffering or
  client transport, not to the collector itself.
- if regular Chrome fails but Incognito prompts for Basic Auth and opens, check
  nginx error logs for `password mismatch`. Chrome can keep stale Basic Auth
  credentials in the profile; clear the origin's site data or bump
  `ghostroute_console_basic_auth_realm` during the expose playbook to force a
  fresh prompt.
- if server-local requests are fast but browser-sized public HTML stalls after
  the first response segment, capture the public listener with `tcpdump` before
  changing the app. Repeated retransmits of the same server-to-client segment
  indicate a client-path MTU/MSS/transport issue. The public listener keeps
  gzip off and lets the buffer proxy return Brotli to browsers so Chrome-sized
  pages stay below the observed stall threshold where possible. The buffer proxy
  strips Next.js hydration scripts from public HTML so the read-only Console
  can render as server HTML plus CSS on constrained home/mobile links. If script
  delivery is explicitly re-enabled, the buffer proxy wraps
  `/_next/static/*.js` chunks in a small synchronous bootstrap and serves the
  chunk body through smaller same-origin part requests. These are transport
  workarounds only; they do not change Console data collection or routing
  state. Desktop and mobile-prefix routes should both pass through this buffer
  proxy; a direct `/m/*` route to Next.js can reintroduce mobile-only stalls.

Server-side baseline:

```bash
# From the VPS:
curl -o /dev/null -sS -w 'ttfb=%{time_starttransfer} total=%{time_total} size=%{size_download}\n' \
  http://127.0.0.1:3000/health

curl -o /dev/null -sS -w 'ttfb=%{time_starttransfer} total=%{time_total} size=%{size_download}\n' \
  https://<console-host>:<console-port>/health

# From the operator workstation, with Basic Auth configured locally:
curl -o /dev/null -sS -w 'ttfb=%{time_starttransfer} total=%{time_total} size=%{size_download}\n' \
  -u '<console-user>:<console-password>' \
  https://<console-host>:<console-port>/api/health

curl -o /dev/null -sS -H 'Accept-Encoding: br' \
  -w 'ttfb=%{time_starttransfer} total=%{time_total} size=%{size_download}\n' \
  -u '<console-user>:<console-password>' \
  https://<console-host>:<console-port>/clients
```

Use the browser waterfall and these timings together: server-local fast plus
operator-browser slow means the next change belongs in the Console public
listener/proxy/client path, not in Channel A/B/C, managed DNS, sing-box or
router firewall.

References for this runbook:

- Chrome DevTools Network: `https://developer.chrome.com/docs/devtools/network/overview`
- Safari/WebKit Web Inspector Network: `https://webkit.org/web-inspector/network-tab/`
- nginx proxy buffering: `https://nginx.org/en/docs/http/ngx_http_proxy_module.html`
- Next.js App Router streaming: `https://nextjs.org/learn/dashboard-app/streaming`

## Runtime Secrets

Router access for this collector is runtime-secret only. Clean deploys should
store `ghostroute_router_remote_host`, `ghostroute_router_remote_port`,
`ghostroute_router_remote_user` and `ghostroute_router_remote_private_key` in
`ansible/secrets/stealth.yml` as Ansible Vault values. Operator workstations may
use the gitignored fallback key under `secrets/router-remote-ssh/`, but the key
is never tracked and is copied only to `/opt/ghostroute-console/router-ssh/` on
the VPS.

VPS egress identity is configured explicitly with `GHOSTROUTE_VPS_EGRESS_IP`,
`GHOSTROUTE_VPS_EGRESS_ASN` and `GHOSTROUTE_VPS_EGRESS_COUNTRY`. Console does
not infer egress IP/ASN/country from the public Console URL.

## Interface Notes

- `/traffic` keeps wide flow tables horizontally scrollable and treats
  category-only rows as aggregates in the route explanation instead of implying
  a concrete site saw the category label.
- `/traffic` labels destination evidence as `DNS`, `SNI`, `DNS-linked`, `IP`,
  `category`, `counter` or `not observed` so exact visited-site evidence stays
  separate from DNS-linked and aggregate traffic groups. Pseudo traffic buckets
  such as encrypted ingress are not shown as primary site names when DNS/SNI or
  linked DNS evidence exists.
- `/dns?page=&pageSize=` can page up to 500 rows for larger troubleshooting
  windows.
- `/catalog?page=&pageSize=` pages the read-only catalog snapshot up to 1,000
  rows per page.
- `/health` alarm ack/snooze/reopen is stored as a narrow operator state overlay
  on the router at the Console alarm-state JSON path. It does not change
  routing, services or catalog runtime.
- `/clients` keeps row selection in `?client=<device-or-client-id>` without
  filtering the table, and each row uses plain document links so the detail
  panel follows the selected device even when browser-side navigation is
  unreliable.
- `/clients` stays a lightweight inventory and selected-client traffic view.
  Heavy selected-device application and DNS evidence is intentionally kept out
  of this render path so the inventory remains fast on the live database.
- `/apps` is a read-only app-family explanation page backed by prepared
  destination bytes and DNS signal counts. It includes the same active Device
  Inventory selector, then renders selected-device app families and latest DNS
  domains. DNS popularity never becomes traffic bytes; unmapped traffic stays
  visible as unmapped/residual evidence. The nDPI column is a diagnostic
  prototype only: it shows expected/offline nDPI protocol comparison when
  samples exist and never changes routing or accounting. Mobile `/m/apps`
  follows the same selected-device default and service-DNS include toggle.
- `/traffic` keeps factual byte/session counters in the flow table, but its
  top-of-page prominence ranking can apply explicit noisy-domain presentation
  weights. This prevents chatty domains from dominating the operator view while
  leaving route/accounting evidence unchanged.
- `/live?eventsPage=&eventsPageSize=&servicePage=&servicePageSize=` renders
  client and service/background live events separately, with millisecond event
  times and page sizes up to 500 rows.
- `/api/live/stream` exposes Server-Sent Events for live DNS/flow/route/alert
  updates from append-only real log events, with polling fallback in the UI.
- `/api/actions/catalog/*` implements review, dry-run, apply preparation and
  rollback recording.
- `/api/notifications/*` stores notification settings and supports ack/snooze
  actions without storing delivery secrets.
- `/api/actions/ops` records controlled ops actions such as collect/report
  refresh and collector restart requests.
- `/api/alarms/:id/(ack|snooze|open)` updates only the router-backed alarm state
  overlay and keeps derived `alarm_events` as factual snapshot evidence. It
  never mutates DNS, sing-box, dnsmasq or router firewall.
- `/settings` is a readonly runtime inventory: collectors, retention, read
  models, access posture, router profile status, safety gates and notification
  readiness are shown without exposing real endpoints, ports, users, keys or
  local device identifiers.

## Mobile Surface

Mobile Safari/iPhone gets a separate ultra-light Console surface under `/m`.
Mobile requests for `/`, `/traffic`, `/dns`, `/clients`, `/health`, `/live` and
`/catalog` redirect to `/m`, `/m/traffic`, `/m/dns`, `/m/clients`, `/m/health`,
`/m/live` and `/m/catalog` unless `desktop=1` is present.

The `/m` pages use the same read-only snapshots and selectors, cap page size to
25 rows, omit side panels and desktop charts, and use plain document links.
`/m/health` exposes compact status cards, Alarm Center, Deploy Gate, Health
Center probes, Leak-check evidence and freshness so remote triage can happen
from an iPhone without loading the desktop workbench. It is served as a raw
no-JS HTML route, so Safari does not need to hydrate a React page or fetch
page-specific chunks before the operator can read the health state.

`/m/live` includes a compact Client activity summary next to the live event
stream. Each mobile page includes a `Desktop version` link back to the full
workbench with `desktop=1`. No `m.` subdomain is used in v1, so the same public
nginx/TLS listener is used.

Basic Auth still protects HTML, API and operator data routes; immutable
`/_next/static/` chunks and browser metadata probes are public cacheable assets
to avoid iOS Safari auth loops. The VPS proxy forwards the external host and
port through `X-Forwarded-*` headers; mobile redirects use those headers so they
stay on the public Console URL instead of the internal `localhost:3000`
container upstream.

## Release Hardening

- PR/functional smoke uses the seeded GUI database across desktop and mobile
  Playwright projects; performance remains a separate release gate.
- Data-layer releases also run timezone, aggregate consistency, dashboard
  benchmark and DB-size checks against the seeded GUI database:
  `npm run verify:timezone`,
  `GHOSTROUTE_CONSOLE_DATA_DIR=../data/gui-test npm run verify:aggregates`,
  `GHOSTROUTE_CONSOLE_DATA_DIR=../data/gui-test npm run bench:dashboard` and
  `GHOSTROUTE_CONSOLE_DATA_DIR=../data/gui-test npm run report:db-size`.
- Collectors validate incoming JSON snapshots against tolerant versioned
  contracts. Unknown fields are preserved, but missing core fields are recorded
  as collector errors instead of being inserted as broken snapshots.
- Read-only derived selectors use a short in-process cache keyed by lightweight
  snapshot metadata, filters and pagination. The default TTL is 300 seconds. The
  cache covers the heavy sidebar pages; browser-side prefetch is intentionally
  avoided for those pages.
- The source strip and `/api/health` expose both build commit and UTC build
  timestamp so operators can confirm which deployed container is serving the UI.
- The VPS read-only deploy builds the new Console image before replacing the
  running container, tags the prepared image with the build commit, passes the
  build timestamp into the app, and attempts rollback to the previous image if
  local health/UI/API smoke fails.
- After successful smoke, deploy keeps the active image plus the current
  rollback tag, removes stale Console rollback and commit tags, and prunes
  unused Docker build cache so repeated deploys do not refill the VPS disk.
