# GhostRoute Traffic Accounting Refactor — Combined Plan (traffic-facts v3 + pyramid)

> **Status**: deliverable for the implementing LLM. Combines the `traffic-facts` v3 machine-contract refactor with the Console pyramid aggregates, retention, and TZ unification. Successor to the data-architecture plan that was previously kept under `peaceful-napping-fox.md`.
>
> **Cross-references**:
> - [`docs/repo-review-2026-05-10.md`](repo-review-2026-05-10.md) — the audit that motivated this plan.
> - [`docs/future-improvements-backlog.md`](future-improvements-backlog.md) — long-term backlog (this refactor closes Section 12).
> - [`docs/architecture.md`](architecture.md) — target architecture diagram (kept in sync).
> - [`SECURITY.md`](../SECURITY.md), [`AGENTS.md`](../AGENTS.md) — hard constraints respected here.
>
> **Top principle**: correctness of traffic accounting and complete population of GUI fields for `today` / `week` / `month`. Visual GUI layout unchanged. Router routing data plane unchanged.

---

## 1. Goals and non-goals

### Goals

1. One canonical byte source for `traffic_facts`: `traffic-evidence.flow_samples`. No `app_flows + destinations` summation.
2. Invariant `bytes == via_vps_bytes + direct_bytes + unknown_bytes` on every `traffic_fact` by construction, with no silent normalization.
3. Clear separation `client` / `service_background` / `unclassified` stamped at ingest, with GUI filter.
4. All twelve new v3 fields reach the UI (`Flow Explorer`, `DNS Query Log`, `Live`, `Clients`).
5. Today / Week / Month filters read **prepared** aggregates, not raw `traffic_facts` or `normalized_flows`.
6. Operational raw retention ≤ 7 days (target DB size < 500 MB, vs current ~3 GB).
7. Unified timezone: UTC in DB, MSK in bucket-keys and UI filters.
8. DNS-flow correlation: `dns_link_id` + `dns_link_confidence` on every `traffic_fact` where DNS evidence is available.
9. `traffic-report` becomes a debug-only legacy artifact. Console does not consume it.
10. Visual GUI unchanged. Only the data underneath.

### Non-goals

- **Active** filtering / blocking / auto-route decisions in this refactor. Scaffold (types, tables, dry-run evaluator) is in scope (see §5 Step 8.5). Active blocking comes in a separate follow-up refactor.
- VirusTotal / Shodan / IPinfo / GreyNoise / Censys / MCP / any external enrichment.
- TLS MITM, packet payload capture, DoH interception.
- Any change that **breaks** Channel A / Channel B / Channel C / managed-domain routing logic. Additional read-only fields in router-side artifacts (TSV columns, log evidence) are allowed as long as they do **not** change routing decisions. ipset contents (`STEALTH_DOMAINS`, `VPN_STATIC_NETS`, `domains-no-vpn.txt`), Reality keys, and VPS routing rules are not edited.
- Full visual GUI redesign. Spot edits to components (a new badge, an extra row in a Detail panel, a new dropdown option) for displaying new v3 fields are **allowed** where needed to meet "all fields populated". Base layout stays.
- `traffic-report` is **fully deprecated** in this refactor. Console does **not** read it; GUI does not depend on it. The file remains runnable as a legacy operator artifact only.
- Console deploy actions.

---

## 2. Hard constraints

This refactor explicitly **allows**:

- Adding read-only router scripts (`dns-query-snapshot`) via existing Ansible mechanisms.
- Extending `lan-flow-facts-snapshot` (reads conntrack/ipset, adds TSV columns) — but v1 parse compatibility must remain.
- Extending `cron-traffic-snapshot` (best-effort call to the new script).
- Adding new commands in `traffic-observatory/bin/` (`traffic-evidence`).
- Full rewrite of `bin/traffic-facts` (v3).
- Changes to Console schema, normalize, selectors, API handlers.

This refactor explicitly **forbids**:

- Any change that breaks Channel A / B / C or managed-domain routing.
- Changes to routing-decision logic in `modules/routing-core/router/`, sing-box outbound config, dnsmasq forwarding, iptables / nftables rules.
- Editing the contents of `STEALTH_DOMAINS`, `VPN_STATIC_NETS`, `domains-no-vpn.txt`.
- Reintroducing `VPN_DOMAINS`, `RC_VPN_ROUTE`, `0x1000`, `wgs1`, `wgc1` as production state.
- Full visual GUI redesign (`app/src/app/**/*.tsx`) — large re-layouts are forbidden.
- Any external network calls from the new code.
- Active blocking / auto-route within the filter scaffold — dry-run only.

Explicitly **allowed** (in addition to the standard hard constraints):

- Minimal spot edits to GUI components to display new v3 fields (badge in an existing slot, extra row in an existing Detail panel, extra option in an existing dropdown). Base layout unchanged.
- Additional read-only fields in router-side artifacts (TSV columns, sniff/log metadata) — provided they do not change routing decisions.
- Scaffold (types, tables, API endpoint stubs, dry-run evaluator) for future filtering — without implementing active blocking in this refactor.

Any mutating action on router / VPS / git push requires explicit operator authorization.

---

## 3. Current state (2026-05-11 audit)

### 3.1 traffic-observatory

- `bin/traffic-facts` exists, schema **v2**, calls `traffic-report --json` (line 38), merges `app_flows + destinations + route_events` (lines 205-216). Potential double-count.
- `bin/traffic-summary`, `bin/traffic-daily-report`, `bin/traffic-rollup-export` — work, support `--json`.
- `bin/traffic-evidence` — **does not exist**.
- `router/lan-flow-facts-snapshot` writes TSV v1, 14 columns: `ts|client|remote|port|proto|route|out_delta|in_delta|total|conns|allocation_basis|byte_confidence|destination_kind|status`. `route_for_ip()` (lines 141-150) tests `STEALTH_DOMAINS` and `VPN_STATIC_NETS` via `ipset test`, returns `VPS`/`Direct`/`Unknown`. Fields `route_source`, `route_basis`, `matched_ipset`, `egress_iface`, `fwmark`, `conn_state` **are missing**.
- `router/dns-query-snapshot` — **does not exist**. DNS evidence currently comes from `modules/dns-catalog-intelligence/router/dns-forensics-*`.
- `router/cron-traffic-snapshot` invokes: `lan-traffic-accounting-refresh`, `mobile-reality-accounting-refresh`, `lan-flow-facts-snapshot`, `traffic-rollup-snapshot`, interface counters, `lan-device-counters-snapshot`, `mobile-reality-counters-snapshot`.
- `STATE_DIR`: `/jffs/addons/router_configuration/traffic` or `/opt/var/log/router_configuration`.

### 3.2 ghostroute-console

- `app/scripts/collect-once.mjs` already calls `traffic_summary`, `router_rollups`, `traffic_facts`, `traffic`, `health`, `deploy_gate`, `leaks`, `domains`, `dns`. **Does not call** `traffic-evidence`.
- `app/scripts/lib/snapshot-contracts.mjs` accepts `traffic_facts` strictly with `schema_version: z.literal(2)`. **No** `traffic_evidence` type.
- `app/scripts/lib/normalize.mjs::normalizeTrafficFacts()` (line ~3341) writes ~36 columns. **Missing**: `protocol`, `bytes_up`, `bytes_down`, `route_source`, `route_basis`, `matched_ipset`, `egress_iface`, `fwmark`, `route_verification`, `dns_link_id`, `dns_link_confidence`, `accounting_status`.
- Table `traffic_dns_links` (`store.ts` / `normalize.mjs:506`) columns: `snapshot_id, collected_at, client_key, client_ip, domain, destination, link_type, confidence, evidence_json`. **Missing**: `id`, `destination_ip`, `destination_port`, `protocol`, `dns_answer_ip`, `dns_event_ts_utc`, `flow_event_ts_utc`.
- Table `traffic_attribution_gaps` (`normalize.mjs:3531`) — exists.
- UI does **not** read `traffic_facts` directly. Dashboard and Flow Explorer read `normalized_flows` / `flow_sessions`. Plumbing requires updates to read-models, not just the base table.
- `app/src/lib/intelligence/` — does not exist.
- `derivedCache` in `selectors.ts:47-95`, TTL `60_000` ms, invalidation by `latestSnapshotVersion()` — exists.
- Pyramid tables (`client_traffic_5min`, `client_traffic_hourly`, `client_traffic_daily`, `dns_log_5min`, `dns_log_hourly`, `dns_log_daily`, `top_clients_window`, `top_destinations_window`) **do not exist** — will be created in this refactor.
- Retention today: `snapshots` 7 d, `hourly_traffic` 30 d. **No** retention for `normalized_flows`, `normalized_dns`, `events`, `route_decisions`, `traffic_facts`, `traffic_dns_links`, `traffic_attribution_gaps`. Main cause of ~3 GB DB.
- TZ: mix of MSK (`moscowDateKey()` in `traffic-window.mjs`) and UTC (SQLite default).

---

## 4. Target architecture

```text
router snapshots / logs
        ↓
  router scripts (read-only):
    - lan-flow-facts-snapshot         (extended v2 TSV)
    - traffic-rollup-snapshot         (existing)
    - dns-query-snapshot              (new)
    - cron-traffic-snapshot           (extended: calls dns-query-snapshot)
        ↓
traffic-observatory/bin/traffic-evidence --json
  Raw machine evidence:
    flow_samples[], dns_queries[], route_evidence[], rollups, warnings
  Single canonical byte source.
  No human formatting. No traffic-report dependency.
        ↓
traffic-observatory/bin/traffic-facts --json
  Stable machine contract (schema_version: 3):
    clients[], traffic_facts[], dns_links[], attribution_gaps[], coverage
  Source: traffic-evidence.flow_samples (one fact per sample).
  Invariant: bytes == via_vps + direct + unknown, by construction.
        ↓
ghostroute-console collector
  Stores raw snapshots, normalizes SQLite tables, builds aggregates.
        ↓
Pyramid (Console SQLite) — client traffic covered up to a month via the cascade
                              5min → hourly → daily; DNS — 5min only for one day,
                              then hourly/daily symmetric:
  client_traffic_5min     (7 d client / 48 h service_background / 24 h unclassified)
  client_traffic_hourly   (35 d — full month at hourly granularity)
  client_traffic_daily    (400 d — year+ at daily granularity)
  dns_log_5min            (1 d — high cardinality; granularity only on recent window)
  dns_log_hourly          (35 d — month at hourly, symmetric with client_traffic_hourly)
  dns_log_daily           (100 d — ~3 months of DNS trends; low-cardinality at daily)
  top_clients_window      (overwritten on each rollup)
  top_destinations_window (overwritten on each rollup)
        ↓
Read models + cache
  normalized_flows / flow_sessions / dns_query_log / console_page_summaries
  derivedCache (TTL 300s) keyed by latestSnapshotVersion()
        ↓
Console UI (visual unchanged)
  Today: client_traffic_hourly filtered MSK-today
  Week / Month: client_traffic_daily
  Flow Explorer: flow_sessions enriched with v3 fields
  DNS Query Log: dns_query_log
  Live: client_traffic_5min × 12 + flow_sessions top 50
```

`traffic-report` after the refactor:

```text
traffic-report
  = legacy / deprecated artifact
  = debug-only operator wrapper (kept runnable)
  = Console does NOT read; GUI does NOT depend
  = the entire Console flow goes through traffic-facts v3
```

In this refactor `traffic-report` is recommended **not** to be rewritten and not to be used as the source of anything machine-facing. Console fully switches to `traffic-facts` v3.

---

## 5. Implementation — step by step

### Step 1. Router-side read-only evidence (lowest risk)

#### 1.1 Extend `lan-flow-facts-snapshot` to v2 schema

File: `modules/traffic-observatory/router/lan-flow-facts-snapshot`.

Add TSV columns (v2) while preserving v1 parse compatibility for legacy consumers:

```text
ts|client_ip|remote_ip|remote_port|proto|route|out_bytes|in_bytes|total_bytes|connections|source|allocation_basis|destination_kind|status|route_source|route_basis|matched_ipset|egress_iface|fwmark|conn_state
```

Update `route_for_ip()` (lines 141-150) to emit `route_source` / `route_basis` / `matched_ipset`:

| `STEALTH_DOMAINS` hit | route=VPS, route_source=ipset, route_basis=managed_domain, matched_ipset=STEALTH_DOMAINS |
| `VPN_STATIC_NETS` hit | route=VPS, route_source=ipset, route_basis=static_network, matched_ipset=VPN_STATIC_NETS |
| ipset readable, no hit | route=Direct, route_source=ipset, route_basis=default_direct, matched_ipset='' |
| ipset unavailable | route=Unknown, route_source=none, route_basis=no_ipset, matched_ipset='' |

`egress_iface`, `fwmark`, `conn_state` — best-effort from conntrack/ip rule; empty if unavailable.

Hard rule: the existing v1 parser **must** continue to work with v2 output. Achieved by reading on `IFS='|'` and consuming the first N columns; new columns sit after.

Tests:
- `tests/test-router-rollups.sh` stays green.
- New `tests/test-lan-flow-facts-v2.sh` with a TSV fixture validates new columns parse.

#### 1.2 Add `dns-query-snapshot`

New file: `modules/traffic-observatory/router/dns-query-snapshot`.

Output: `$STATE_DIR/dns-query-facts.tsv`. Columns:

```text
ts|client_ip|qname|qtype|answer_ip|rcode|source|status
```

Sources (fallback order):
1. dnsmasq query log (if enabled).
2. Existing `dns-forensics-*` files in `modules/dns-catalog-intelligence/router/`.
3. Any existing GhostRoute DNS evidence files.

Requirements: read-only, bounded output (limit by line count and time window via env), exit 0 if source unavailable (with warning file), no external network calls, no packet capture, support A/AAAA, lowercase qname, strip trailing dot.

#### 1.3 Extend `cron-traffic-snapshot`

Add a best-effort call to `dns-query-snapshot` near `traffic-rollup-snapshot`:

```sh
if [ -x /jffs/scripts/dns-query-snapshot ]; then
  /jffs/scripts/dns-query-snapshot >/dev/null 2>&1 || true
fi
```

#### 1.4 Ansible deployment integration

Extend the existing `20-stealth-router.yml` task list (or a dedicated role):
- Copy `dns-query-snapshot` to `/jffs/scripts/`.
- Ensure the cron hook references it.

**Do not** run on the live router as part of this refactor without explicit operator authorization. Fixture tests + `ansible-playbook --syntax-check` — mandatory.

### Step 2. `bin/traffic-evidence` (new command)

New file: `modules/traffic-observatory/bin/traffic-evidence`.

CLI: `traffic-evidence --json [today|current|yesterday|week|month|YYYY-MM-DD]`

Behavior:
- `--json` mode only. No human format.
- Parses router-side artifacts: `lan-flow-facts.tsv` (v1 + v2), `traffic-rollup-export`, `dns-query-facts.tsv`, `dns-forensics-*` (if present), sing-box/xray outbound logs (if present), interface counters.
- **Does not** invoke `traffic-report`.
- Missing files → warning in output, never fatal.

Output (`traffic-evidence-v1`):

```json
{
  "schema_version": 1,
  "generated_at": "2026-05-11T09:00:00.000Z",
  "window": { "period": "today", "start_ts_utc": "...", "end_ts_utc": "..." },
  "source": { "command": "traffic-evidence", "schema": "traffic-evidence-v1" },
  "flow_samples": [ /* per-flow rows from lan-flow-facts */ ],
  "dns_queries": [ /* DNS rows */ ],
  "route_evidence": [ /* outbound/egress verification */ ],
  "rollups": { /* coverage/parity metadata only */ },
  "interface_counters": [],
  "source_files": [],
  "warnings": []
}
```

Item schemas — see §6.

`route_evidence.verification` values:
- `verified_vps` — outbound/egress evidence confirms VPS/tunnel/reality.
- `verified_direct` — outbound/egress confirms WAN/direct.
- `intent_only` — only ipset/policy says route.
- `mismatch` — ipset conflicts with outbound evidence.
- `unknown` — no evidence.

### Step 3. `bin/traffic-facts` v3 (rewrite)

File: `modules/traffic-observatory/bin/traffic-facts`.

CLI: `traffic-facts --json [today|current|yesterday|week|month|YYYY-MM-DD] [--deep]`

Source mode (env): `GHOSTROUTE_TRAFFIC_FACTS_SOURCE=evidence|report`. Default `evidence`.
- `evidence` (default): invokes `traffic-evidence --json <period>`.
- `report`: legacy compat for debugging.
- **No silent fallback**: if evidence fails and `source!=report`, fail clearly.

Output `schema_version: 3`:

```json
{
  "schema_version": 3,
  "generated_at": "...",
  "window": {},
  "source": { "command": "traffic-facts", "period": "today", "source_report": "traffic-evidence", "schema": "traffic-facts-v3", "deep": false },
  "collector_metrics": {},
  "confidence": "observed|mixed|estimated",
  "clients": [],
  "traffic_facts": [],
  "dns_links": [],
  "attribution_gaps": [],
  "coverage": {}
}
```

**Critical rule**: one `traffic_fact` per `flow_sample`. No `app_flows + destinations` summation.

#### 3.1 `traffic_fact` fields (see §6.2)

#### 3.2 Route byte split

```text
route = VPS     → via_vps_bytes = bytes, direct = 0, unknown = 0
route = Direct  → via_vps_bytes = 0,     direct = bytes, unknown = 0
route = Unknown → via_vps_bytes = 0,     direct = 0,     unknown = bytes
route = Mixed   → split only with explicit evidence; otherwise unknown = bytes
```

**Invariant**: `bytes == via_vps_bytes + direct_bytes + unknown_bytes` by construction. If violated → `accounting_status='accounting_error'`, originals in `evidence_json.original_accounting`, warning in `collector_metrics.warnings`.

When `route_verification='mismatch'` → `accounting_status='route_mismatch'`, evidence in evidence_json.

#### 3.3 DNS-flow correlation

Correlation flow ↔ DNS:
- key: same `client_ip`
- `dns_query.answer_ip == flow_sample.remote_ip`
- `dns_query.ts` within window before `flow_sample.ts`
- window: default 600s, env `GHOSTROUTE_DNS_LINK_WINDOW_SECONDS`

Link types and confidence:
- exact `client_ip + answer_ip + recent` → `exact_client_ip`, `high`
- `answer_ip` match, missing `client_ip` → `recent_answer`, `medium`
- shared answer across multi-client → `shared_answer`, `low`
- no match → `no_dns_match`, `none`

`dns_link` schema — see §6.3.

`traffic_fact` carries `dns_qname`, `dns_answer_ip`, `dns_link_id`, `dns_link_confidence`. Without DNS — IP-only with `destination_confidence='ip_only'`. **Never invent a domain from an IP.**

### Step 4. Console schema (UTC, v3 fields, pyramid)

#### 4.1 Schema migration v8 (combined)

File: `app/src/lib/server/store.ts` plus mirror in `app/scripts/lib/normalize.mjs::ensureConsoleSchema`. Bump `MIGRATION_VERSION` to 8.

##### 4.1.1 Extend `traffic_facts`

Add via `addColumnIfMissing`:

```sql
ALTER TABLE traffic_facts ADD COLUMN protocol TEXT NOT NULL DEFAULT '';
ALTER TABLE traffic_facts ADD COLUMN bytes_up INTEGER NOT NULL DEFAULT 0;
ALTER TABLE traffic_facts ADD COLUMN bytes_down INTEGER NOT NULL DEFAULT 0;
ALTER TABLE traffic_facts ADD COLUMN route_source TEXT NOT NULL DEFAULT '';
ALTER TABLE traffic_facts ADD COLUMN route_basis TEXT NOT NULL DEFAULT '';
ALTER TABLE traffic_facts ADD COLUMN matched_ipset TEXT NOT NULL DEFAULT '';
ALTER TABLE traffic_facts ADD COLUMN egress_iface TEXT NOT NULL DEFAULT '';
ALTER TABLE traffic_facts ADD COLUMN fwmark TEXT NOT NULL DEFAULT '';
ALTER TABLE traffic_facts ADD COLUMN route_verification TEXT NOT NULL DEFAULT '';
ALTER TABLE traffic_facts ADD COLUMN dns_link_id TEXT NOT NULL DEFAULT '';
ALTER TABLE traffic_facts ADD COLUMN dns_link_confidence TEXT NOT NULL DEFAULT '';
ALTER TABLE traffic_facts ADD COLUMN accounting_status TEXT NOT NULL DEFAULT 'ok';
```

NB: do not store `category` / `provider` / `asn` / `action_hint` in `traffic_facts` — those are interpretation, not accounting facts. They go into `destination_enrichment` (§4.1.4).

##### 4.1.2 Extend `traffic_dns_links`

```sql
ALTER TABLE traffic_dns_links ADD COLUMN id TEXT NOT NULL DEFAULT '';
ALTER TABLE traffic_dns_links ADD COLUMN destination_ip TEXT NOT NULL DEFAULT '';
ALTER TABLE traffic_dns_links ADD COLUMN destination_port TEXT NOT NULL DEFAULT '';
ALTER TABLE traffic_dns_links ADD COLUMN protocol TEXT NOT NULL DEFAULT '';
ALTER TABLE traffic_dns_links ADD COLUMN dns_answer_ip TEXT NOT NULL DEFAULT '';
ALTER TABLE traffic_dns_links ADD COLUMN dns_event_ts_utc TEXT NOT NULL DEFAULT '';
ALTER TABLE traffic_dns_links ADD COLUMN flow_event_ts_utc TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_traffic_dns_links_client_dest
  ON traffic_dns_links(client_ip, destination_ip, collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_traffic_dns_links_domain_answer
  ON traffic_dns_links(domain, dns_answer_ip, collected_at DESC);
```

##### 4.1.3 Pyramid tables — see §7.

##### 4.1.4 `destination_enrichment` (for the classification scaffold)

```sql
CREATE TABLE IF NOT EXISTS destination_enrichment (
  destination_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'unknown',
  provider TEXT NOT NULL DEFAULT '',
  action_hint TEXT NOT NULL DEFAULT 'monitor',
  confidence TEXT NOT NULL DEFAULT 'unknown',
  reason_code TEXT NOT NULL DEFAULT '',
  sources_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  expires_at TEXT NOT NULL DEFAULT ''
);
```

##### 4.1.5 TZ unification

Rename all `*_at` columns to `*_at_utc` via temp-copy-swap (SQLite doesn't support `RENAME COLUMN` compatibly with older code paths). Create a single helper `app/src/lib/time/window.ts`:

```ts
export const TZ = 'Europe/Moscow';
export function nowUtcIso(): string;
export function toMskKey(utcIso: string, granularity: '5min'|'hour'|'day'): string;
export function toUtcIsoFromMskKey(mskKey: string, granularity): string;
export function mskWindowBounds(window: 'today'|'week'|'month'): { startUtc: string; endUtc: string };
export function parseSourceTimestamp(raw: string): string;
```

Rewrite `moscowDateKey()` in `traffic-window.mjs` as a thin wrapper over this helper.

### Step 5. Console normalization update

File: `app/scripts/lib/normalize.mjs`.

#### 5.1 Snapshot contract

In `snapshot-contracts.mjs`:

```js
traffic_facts: { schema_version: z.union([z.literal(2), z.literal(3)]) }
traffic_evidence: { schema_version: z.literal(1) }  // NEW
```

Prefer v3. Accept v2 for compat. Mark `source_schema_version` in metadata.

#### 5.2 `normalizeTrafficFacts()` extension

Add all 12 new fields to the INSERT into `traffic_facts`. Apply `flowTrafficClass()` (port of `app/src/lib/traffic-classification.mjs`) inline at ingest, so `traffic_class` is stamped at write time, not at render.

#### 5.3 `normalizeTrafficDnsLinks()` extension

INSERT into `traffic_dns_links` now includes all 7 new fields. `id` — stable hash `(snapshot_id, client_ip, destination_ip, dns_answer_ip, dns_event_ts_utc)`.

#### 5.4 Pyramid rollup

New function `rollupTrafficWindow(db, snapshotId, collectedAtUtc)` at the end of `applyNormalization()`, after the `flow_sessions` rebuild and before `console_page_summaries`:

1. 5-min bucket: recompute the last 2 buckets (DELETE+INSERT) from `traffic_facts.event_ts_utc >= bucket_start - 5m`.
2. Hourly: recompute the current + previous hour from `client_traffic_5min`.
3. Daily: recompute today + yesterday from `client_traffic_hourly`.
4. Top-windows: recompute `today` always; `week`/`month` only when crossing a day boundary.

`rollupDnsWindow()` analogously — from `traffic_dns_links`:
- 5-min bucket: recompute the last 2 buckets in `dns_log_5min`.
- Hourly: recompute current + previous hour in `dns_log_hourly` from `dns_log_5min`.
- Daily: recompute today + yesterday in `dns_log_daily` from `dns_log_hourly`.

Symmetric cascade with the client traffic pyramid: 5min → hourly → daily; retention drops granularity as data ages.

#### 5.5 `pruneOperationalTables()`

Add to `applyNormalization()` next to the existing `pruneSnapshots`:

```sql
DELETE FROM normalized_flows         WHERE collected_at_utc < ?;  -- 7 d
DELETE FROM normalized_dns           WHERE collected_at_utc < ?;  -- 7 d
DELETE FROM events                   WHERE occurred_at_utc < ?;   -- 7 d
DELETE FROM route_decisions          WHERE occurred_at_utc < ?;   -- 7 d
DELETE FROM traffic_facts            WHERE event_ts_utc < ?;      -- 7 d client / 48 h service_background / 24 h unclassified
DELETE FROM traffic_dns_links        WHERE collected_at_utc < ?;  -- 7 d
DELETE FROM traffic_attribution_gaps WHERE collected_at_utc < ?;  -- 7 d
DELETE FROM client_traffic_5min      WHERE bucket_start_utc < ?;  -- 7 d client / 48 h service / 24 h unclassified
DELETE FROM client_traffic_hourly    WHERE hour_start_utc < ?;    -- 35 d (covers full month at hourly)
DELETE FROM client_traffic_daily     WHERE day_start_utc < ?;     -- 400 d (year+ at daily)
DELETE FROM dns_log_5min             WHERE bucket_start_utc < ?;  -- 1 d (high cardinality)
DELETE FROM dns_log_hourly           WHERE hour_start_utc < ?;    -- 35 d (NEW, symmetric with client_traffic_hourly)
DELETE FROM dns_log_daily            WHERE day_start_utc < ?;     -- 100 d (NEW, ~3 months for trends)
DELETE FROM collector_errors         WHERE collected_at_utc < ?;  -- 14 d
UPDATE snapshots SET payload_json='' WHERE payload_json != '' AND id < (SELECT MAX(id) FROM snapshots) - 6;
```

Nightly conditional `PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize; VACUUM` — only when `retention_runs.raw_deleted > 100000`.

#### 5.6 `collect-once.mjs` update

Add `traffic_evidence` to the command list **before** `traffic_facts`. **Remove** `traffic` (the `traffic-report` call) — Console no longer consumes it:

```js
{ key: 'traffic_evidence', cmd: 'modules/traffic-observatory/bin/traffic-evidence --json today' },
{ key: 'traffic_facts',    cmd: 'modules/traffic-observatory/bin/traffic-facts --json today' },
// 'traffic' (traffic-report) — REMOVED: deprecated, Console is not a consumer
```

`traffic_evidence` comes first so `traffic-facts` can read it. In the Console-collector context the JSON snapshot is used directly (via `GHOSTROUTE_TRAFFIC_FACTS_SOURCE=evidence`).

`traffic-report` remains available as a CLI for the operator but is not invoked by the collector.

### Step 6. Console read-path plumbing (UI plumbing)

Goal: the new v3 fields **reach the UI without changing the visual design**.

#### 6.1 `normalized_flows` extension

`normalized_flows` is the read-model that backs `Flow Explorer`. Add v3 columns (via `addColumnIfMissing`):

```sql
ALTER TABLE normalized_flows ADD COLUMN protocol TEXT NOT NULL DEFAULT '';
ALTER TABLE normalized_flows ADD COLUMN bytes_up INTEGER NOT NULL DEFAULT 0;
ALTER TABLE normalized_flows ADD COLUMN bytes_down INTEGER NOT NULL DEFAULT 0;
ALTER TABLE normalized_flows ADD COLUMN route_source TEXT NOT NULL DEFAULT '';
ALTER TABLE normalized_flows ADD COLUMN route_basis TEXT NOT NULL DEFAULT '';
ALTER TABLE normalized_flows ADD COLUMN matched_ipset TEXT NOT NULL DEFAULT '';
ALTER TABLE normalized_flows ADD COLUMN route_verification TEXT NOT NULL DEFAULT '';
ALTER TABLE normalized_flows ADD COLUMN dns_link_id TEXT NOT NULL DEFAULT '';
ALTER TABLE normalized_flows ADD COLUMN dns_link_confidence TEXT NOT NULL DEFAULT '';
ALTER TABLE normalized_flows ADD COLUMN accounting_status TEXT NOT NULL DEFAULT 'ok';
ALTER TABLE normalized_flows ADD COLUMN traffic_class TEXT NOT NULL DEFAULT 'client';
```

Update `buildNormalizedFlows()` (approximately `normalize.mjs:1000+`) to copy the new fields when building flows from `traffic_facts`.

#### 6.2 `flow_sessions` extension

`flow_sessions` (TRUNCATE+INSERT top-10000) is the Flow Explorer pagination table. Add the same columns. Selectors `flowSelect()` / `listTrafficRows()` / `getTrafficRowById()` in `app/src/lib/server/selectors.ts` (~lines 2400-2500) — extend SELECT to return the new columns in the API response.

#### 6.3 API response shape

Existing components expect a specific shape. Do not rename existing keys. Add new keys under `route` and `attribution` objects:

```ts
{
  // existing fields preserved
  route: 'VPS' | 'Direct' | 'Mixed' | 'Unknown',
  // NEW nested object — components ignore if undefined
  route_meta: {
    source: 'ipset' | 'none',
    basis: 'managed_domain' | 'static_network' | 'default_direct' | 'no_ipset',
    matched_ipset: 'STEALTH_DOMAINS' | 'VPN_STATIC_NETS' | '',
    verification: 'verified_vps' | 'verified_direct' | 'intent_only' | 'mismatch' | 'unknown',
    egress_iface: string,
    fwmark: string,
  },
  attribution: {
    bytes: number, bytes_up: number, bytes_down: number,
    via_vps: number, direct: number, unknown: number,
    accounting_status: 'ok' | 'accounting_error' | 'route_mismatch' | 'incomplete_evidence' | 'no_dns_match',
    confidence: 'observed' | 'estimated' | 'unknown',
  },
  dns_link: { id: string, qname: string, answer_ip: string, confidence: 'high' | 'medium' | 'low' | 'none' | 'no_dns_match' },
  traffic_class: 'client' | 'service_background' | 'unclassified',
  protocol: string,
}
```

Existing Flow Explorer / DNS Query Log components consume these defensively (`row?.route_meta?.verification ?? ''`). When the field is undefined the renderer emits an empty string — no visual change.

#### 6.4 Existing components — where new fields land automatically

- **Flow Explorer** (`app/src/app/traffic/...`): the Detail panel already shows `Route`, `Policy / Rule`, `Outbound`. The new `route_meta.verification` renders in the existing `Route` slot as a `verified` / `intent` / `mismatch` badge. `route_meta.matched_ipset` — new row in the Detail panel under `Policy / Rule` (the component already supports extra key-value pairs).
- **DNS Query Log** (`app/src/app/dns/...`): the new `dns_link.confidence` shows in the existing Status column (`Review` / `OK`) as an extra badge value.
- **Clients page**: the `traffic_class` filter (`client` / `service_background` / `unclassified`) is wired into the existing "Confidence" dropdown as an additional category.
- **Live page**: SSE payload already includes `event` / `route` / `client`; the new `traffic_class` is added; the existing renderer ignores unknown keys.

#### 6.5 Aggregate-driven selectors

| Endpoint | period=today | period=week\|month |
|---|---|---|
| `/api/dashboard` | `client_traffic_hourly` MSK-today | `client_traffic_daily` |
| `/api/dashboard` top-clients | `top_clients_window WHERE window='today'` | `…='week'\|'month'` |
| `/api/dashboard` top-destinations | `top_destinations_window` | direct |
| `/api/clients` | `client_traffic_daily` JOIN `device_inventory` | same |
| `/api/dns` filters/counts | `dns_log_5min` last 1d, `dns_log_hourly` for last 35d | `dns_log_daily` for 100d |
| `/api/dns` table | `dns_query_log` LIMIT 500 | same |
| `/api/flows` | `flow_sessions` + traffic_class | same |
| `/api/live` | `client_traffic_5min` × 12 + `flow_sessions` top 50 | n/a |

Default filter `traffic_class='client'`. `?class=all` returns everything.

#### 6.6 derivedCache extension

In `selectors.ts:47-95`: raise the default `GHOSTROUTE_CONSOLE_DERIVED_CACHE_TTL_MS` from 60_000 to 300_000. Extend `cacheGet()` coverage to the new aggregate selectors. Call `clearDerivedCache()` at the end of `applyNormalization()` to explicitly invalidate after each new snapshot.

Enrich `console_page_summaries` with new `page` keys `dashboard_today`, `dashboard_week`, `dashboard_month`, `clients_today`, `dns_today` — pre-rendered JSON updated inside `rollupTrafficWindow()`.

### Step 7. Pyramid tables (full DDL)

```sql
CREATE TABLE client_traffic_5min (
  bucket_start_utc TEXT NOT NULL,
  bucket_msk_key   TEXT NOT NULL,
  client_key       TEXT NOT NULL,
  channel          TEXT NOT NULL DEFAULT 'Unknown',
  route            TEXT NOT NULL DEFAULT 'Unknown',
  confidence       TEXT NOT NULL DEFAULT 'unknown',
  traffic_class    TEXT NOT NULL DEFAULT 'client',
  destination_key  TEXT NOT NULL DEFAULT '',
  bytes            INTEGER NOT NULL DEFAULT 0,
  via_vps_bytes    INTEGER NOT NULL DEFAULT 0,
  direct_bytes     INTEGER NOT NULL DEFAULT 0,
  unknown_bytes    INTEGER NOT NULL DEFAULT 0,
  flows            INTEGER NOT NULL DEFAULT 0,
  connections      INTEGER NOT NULL DEFAULT 0,
  observed_bytes   INTEGER NOT NULL DEFAULT 0,
  attributed_bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_start_utc, client_key, channel, route, confidence, traffic_class, destination_key)
);
-- + idx_ct5_msk, idx_ct5_class_msk, idx_ct5_client_msk

CREATE TABLE client_traffic_hourly (
  hour_msk_key     TEXT NOT NULL,
  hour_start_utc   TEXT NOT NULL,
  client_key       TEXT NOT NULL DEFAULT '',
  channel          TEXT NOT NULL DEFAULT 'Unknown',
  route            TEXT NOT NULL DEFAULT 'Unknown',
  confidence       TEXT NOT NULL DEFAULT 'unknown',
  traffic_class    TEXT NOT NULL DEFAULT 'client',
  bytes            INTEGER NOT NULL DEFAULT 0,
  via_vps_bytes    INTEGER NOT NULL DEFAULT 0,
  direct_bytes     INTEGER NOT NULL DEFAULT 0,
  unknown_bytes    INTEGER NOT NULL DEFAULT 0,
  observed_bytes   INTEGER NOT NULL DEFAULT 0,
  attributed_bytes INTEGER NOT NULL DEFAULT 0,
  flows            INTEGER NOT NULL DEFAULT 0,
  clients          INTEGER NOT NULL DEFAULT 0,
  updated_at_utc   TEXT NOT NULL,
  PRIMARY KEY (hour_msk_key, client_key, channel, route, confidence, traffic_class)
);

CREATE TABLE client_traffic_daily (
  day_msk_key      TEXT NOT NULL,
  day_start_utc    TEXT NOT NULL,
  client_key       TEXT NOT NULL DEFAULT '',
  channel          TEXT NOT NULL DEFAULT 'Unknown',
  route            TEXT NOT NULL DEFAULT 'Unknown',
  confidence       TEXT NOT NULL DEFAULT 'unknown',
  traffic_class    TEXT NOT NULL DEFAULT 'client',
  bytes            INTEGER NOT NULL DEFAULT 0,
  via_vps_bytes    INTEGER NOT NULL DEFAULT 0,
  direct_bytes     INTEGER NOT NULL DEFAULT 0,
  unknown_bytes    INTEGER NOT NULL DEFAULT 0,
  observed_bytes   INTEGER NOT NULL DEFAULT 0,
  attributed_bytes INTEGER NOT NULL DEFAULT 0,
  flows            INTEGER NOT NULL DEFAULT 0,
  clients          INTEGER NOT NULL DEFAULT 0,
  updated_at_utc   TEXT NOT NULL,
  PRIMARY KEY (day_msk_key, client_key, channel, route, confidence, traffic_class)
);

CREATE TABLE dns_log_5min (
  bucket_start_utc TEXT NOT NULL,
  bucket_msk_key   TEXT NOT NULL,
  client_key       TEXT NOT NULL DEFAULT '',
  domain           TEXT NOT NULL DEFAULT '',
  qtype            TEXT NOT NULL DEFAULT '',
  catalog_status   TEXT NOT NULL DEFAULT 'unknown',
  route            TEXT NOT NULL DEFAULT 'Unknown',
  confidence       TEXT NOT NULL DEFAULT 'dns-interest',
  query_count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_start_utc, client_key, domain, qtype, catalog_status, route)
);
-- + idx_dl5_msk, idx_dl5_domain

CREATE TABLE dns_log_hourly (
  hour_msk_key     TEXT NOT NULL,
  hour_start_utc   TEXT NOT NULL,
  client_key       TEXT NOT NULL DEFAULT '',
  domain           TEXT NOT NULL DEFAULT '',
  qtype            TEXT NOT NULL DEFAULT '',
  catalog_status   TEXT NOT NULL DEFAULT 'unknown',
  route            TEXT NOT NULL DEFAULT 'Unknown',
  confidence       TEXT NOT NULL DEFAULT 'dns-interest',
  query_count      INTEGER NOT NULL DEFAULT 0,
  updated_at_utc   TEXT NOT NULL,
  PRIMARY KEY (hour_msk_key, client_key, domain, qtype, catalog_status, route)
);
CREATE INDEX IF NOT EXISTS idx_dlh_msk    ON dns_log_hourly(hour_msk_key DESC);
CREATE INDEX IF NOT EXISTS idx_dlh_domain ON dns_log_hourly(domain, hour_msk_key DESC);

CREATE TABLE dns_log_daily (
  day_msk_key      TEXT NOT NULL,
  day_start_utc    TEXT NOT NULL,
  client_key       TEXT NOT NULL DEFAULT '',
  domain           TEXT NOT NULL DEFAULT '',
  qtype            TEXT NOT NULL DEFAULT '',
  catalog_status   TEXT NOT NULL DEFAULT 'unknown',
  route            TEXT NOT NULL DEFAULT 'Unknown',
  confidence       TEXT NOT NULL DEFAULT 'dns-interest',
  query_count      INTEGER NOT NULL DEFAULT 0,
  updated_at_utc   TEXT NOT NULL,
  PRIMARY KEY (day_msk_key, client_key, domain, qtype, catalog_status, route)
);
CREATE INDEX IF NOT EXISTS idx_dld_msk    ON dns_log_daily(day_msk_key DESC);
CREATE INDEX IF NOT EXISTS idx_dld_domain ON dns_log_daily(domain, day_msk_key DESC);

CREATE TABLE top_clients_window (
  window TEXT NOT NULL, rank INTEGER NOT NULL,
  client_key TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT 'Unknown', route TEXT NOT NULL DEFAULT 'Unknown',
  traffic_class TEXT NOT NULL DEFAULT 'client',
  bytes INTEGER NOT NULL DEFAULT 0, via_vps_bytes INTEGER NOT NULL DEFAULT 0,
  direct_bytes INTEGER NOT NULL DEFAULT 0, flows INTEGER NOT NULL DEFAULT 0,
  computed_at_utc TEXT NOT NULL,
  PRIMARY KEY (window, traffic_class, rank)
);

CREATE TABLE top_destinations_window (
  window TEXT NOT NULL, rank INTEGER NOT NULL,
  destination TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'Unknown', route TEXT NOT NULL DEFAULT 'Unknown',
  traffic_class TEXT NOT NULL DEFAULT 'client',
  bytes INTEGER NOT NULL DEFAULT 0, flows INTEGER NOT NULL DEFAULT 0,
  observed_bytes INTEGER NOT NULL DEFAULT 0, attributed_bytes INTEGER NOT NULL DEFAULT 0,
  computed_at_utc TEXT NOT NULL,
  PRIMARY KEY (window, traffic_class, rank)
);
```

### Step 8. Classification scaffold

Create `app/src/lib/intelligence/`:

```
classify-destination.mjs
destination-rules.mjs
explain-classification.mjs
catalogs/
  system-apple.json
  system-google.json
  analytics-trackers.json
  cdn-hosting.json
  personal-cloud.json
  local-overrides.example.json
```

API:

```ts
classifyDestination({ domain, ip, sni, dns_qname, destination, destination_ip, matched_rule, outbound, evidence })
  → { category, provider, traffic_class, action_hint, confidence, reason_code, sources, evidence }
```

Categories: `system.apple.{push|appstore|icloud}`, `system.google.connectivity`, `analytics.{firebase|google}`, `tracker.ads`, `cdn.{gcore|cloudflare|akamai}`, `hosting.{hetzner|generic_vps}`, `personal_cloud.{icloud|dropbox}`, `unknown.{ip_only|no_dns_match}`.

Default action_hints: `system.*` → allow / monitor, `analytics.*` → block_candidate, `tracker.ads` → block_candidate, `cdn.*` → monitor, `hosting.*` → investigate.

Hard rule: classification **does not** change accounting. **Does not** block. **Does not** call external APIs.

Refactor wrappers: `app/src/lib/domain-attribution.mjs` and `app/src/lib/traffic-classification.mjs` preserve their existing exports (call sites unchanged); internally they delegate to the new `classifyDestination()`.

### Step 8.5. Filter scaffold (foundation only — no active filtering)

**Goal**: lay the rails for future filtering in the next refactor without implementing blocking itself. In this refactor the `evaluator` operates in **dry-run mode only** — it writes "would have done X", and never blocks anything.

#### 8.5.1 Schema (part of migration v8)

```sql
CREATE TABLE filter_rules (
  rule_id          TEXT PRIMARY KEY,
  scope            TEXT NOT NULL,                  -- 'destination' | 'client' | 'route' | 'category'
  match_kind       TEXT NOT NULL,                  -- 'domain' | 'domain_suffix' | 'ip' | 'cidr' | 'asn' | 'category' | 'client_key'
  match_value      TEXT NOT NULL,
  action           TEXT NOT NULL,                  -- 'allow' | 'block' | 'route_via_vps' | 'route_direct' | 'monitor'
  priority         INTEGER NOT NULL DEFAULT 100,
  enabled          INTEGER NOT NULL DEFAULT 0,     -- 0 = disabled by default; scaffold ships disabled
  dry_run          INTEGER NOT NULL DEFAULT 1,     -- 1 always in this refactor; active mode comes later
  reason           TEXT NOT NULL DEFAULT '',
  created_by       TEXT NOT NULL DEFAULT 'operator',
  created_at_utc   TEXT NOT NULL,
  updated_at_utc   TEXT NOT NULL,
  evidence_json    TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_filter_rules_match    ON filter_rules(scope, match_kind, match_value);
CREATE INDEX IF NOT EXISTS idx_filter_rules_enabled  ON filter_rules(enabled, priority);

CREATE TABLE filter_decisions (
  decision_id        TEXT PRIMARY KEY,
  snapshot_id        TEXT NOT NULL,
  observed_at_utc    TEXT NOT NULL,
  rule_id            TEXT NOT NULL,
  client_key         TEXT NOT NULL DEFAULT '',
  client_ip          TEXT NOT NULL DEFAULT '',
  destination        TEXT NOT NULL DEFAULT '',
  destination_ip     TEXT NOT NULL DEFAULT '',
  matched_field      TEXT NOT NULL DEFAULT '',
  matched_value      TEXT NOT NULL DEFAULT '',
  would_have_action  TEXT NOT NULL,                -- what the rule would have done in active mode
  applied            INTEGER NOT NULL DEFAULT 0,   -- 0 in scaffold; 1 only after active filtering is enabled later
  evidence_json      TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_filter_decisions_obs  ON filter_decisions(observed_at_utc DESC);
CREATE INDEX IF NOT EXISTS idx_filter_decisions_rule ON filter_decisions(rule_id, observed_at_utc DESC);
CREATE INDEX IF NOT EXISTS idx_filter_decisions_client ON filter_decisions(client_key, observed_at_utc DESC);
```

Retention of `filter_decisions`: 30 d, in line with other audit tables.

#### 8.5.2 Module layout

`modules/ghostroute-console/app/src/lib/filters/`:

- `types.ts` — TypeScript interfaces `FilterRule`, `FilterMatch`, `FilterAction`, `FilterDecision`.
- `rules.ts` — CRUD helpers on top of `filter_rules` (read-only API in this refactor: load/list only, no insert/update).
- `evaluator.ts` — function `evaluateFlow(trafficFact, rules): FilterDecision[]`. **Dry-run only**: writes `filter_decisions` with `applied=0`. No side-effects on routing.
- `evaluate-snapshot.ts` — wrapper called inside `applyNormalization()` after the rollup step. Iterates fresh `traffic_facts` against enabled (`enabled=1`) rules, writes `filter_decisions` for review.

#### 8.5.3 API endpoint stubs (read-only)

- `GET /api/filters/rules` — list rules (paginated).
- `GET /api/filters/decisions` — recent dry-run decisions (paginated).

POST/PUT/DELETE — **not implemented** in this refactor. Stubs return `405 Method Not Allowed` with a clear message "filter mutation API ships in the next refactor".

#### 8.5.4 GUI surface (minimal)

- On the Flow Explorer Detail panel — a new row "Filter decisions" with a count of recent `filter_decisions.would_have_action`. No separate page. No active UI actions.
- On the Catalog page — a new read-only section "Filter rules" (rendered only if any rules exist). Empty state — standard.

The base layout of existing pages is unchanged.

#### 8.5.5 Hard rules for the filter scaffold

- **No blocking / mutation** of routing decisions.
- `evaluator.applied` is always `0` in this refactor.
- `filter_rules.dry_run` is always `1` in the scaffold (guard against accidental activation).
- Activation requires a **separate refactor** with explicit review and operator approval.
- No external API calls from `evaluator`.

#### 8.5.6 Tests (Track E — filter scaffold)

- Synthetic `filter_rules` with different `match_kind` → `evaluator` produces expected `filter_decisions`.
- Dry-run: zero routing-mutation side-effects. Audit snapshot before/after `evaluate-snapshot` is byte-identical row by row.
- `traffic_facts` are not modified after the evaluator runs.
- API endpoint `POST /api/filters/rules` returns 405 with a clear message.

---

### Step 9. `traffic-report` full deprecation

File: `modules/traffic-observatory/bin/traffic-report`.

Changes:
- Header comment: `traffic-report is DEPRECATED as a machine source. Console does not consume it. Machine consumers MUST use traffic-facts (schema_version=3) which reads traffic-evidence. traffic-report remains runnable for operator debug only.`
- Do not delete. Do not simplify.
- **Do not** add new filtering / intelligence logic.
- Optional: print a deprecation warning to stderr on `--json` — but without breaking existing call sites.
- Remove `traffic-report` from the Console `collect-once` command list (see §5 Step 5.6); its snapshot is no longer needed.
- Documentation update is mandatory — replace "traffic-report is the stable machine contract" everywhere with "traffic-report is debug-only legacy".

### Step 10. Documentation (mandatory)

Update files to the new target architecture:

| File | Change |
|---|---|
| [README.md](../README.md) | Refresh Observability section: traffic-evidence → traffic-facts → Console. Mark traffic-report debug-only. |
| [README-ru.md](../README-ru.md) | Mirror the EN changes. |
| [docs/architecture.md](architecture.md) | "Observability And Console" block — replace the old diagram with the one in §4 of this plan. |
| [docs/operational-modules.md](operational-modules.md) | Module map: traffic-observatory inventory with traffic-evidence (new), traffic-facts (machine), traffic-report (human/debug). |
| [docs/glossary.md](glossary.md) | Add terms: traffic-evidence, traffic-facts v3, flow_sample, dns_link, route_verification, traffic_class. |
| [docs/repo-review-2026-05-10.md](repo-review-2026-05-10.md) | Postscript: this refactor closes Part B B1 (snapshot validators) and parts of B2-B6. |
| [docs/future-improvements-backlog.md](future-improvements-backlog.md) | Phase markers: add `Section 12. traffic-facts v3 + pyramid (◐ in progress)`. |
| [modules/traffic-observatory/README.md](../modules/traffic-observatory/README.md) | Rework for the new pipeline. |
| [modules/traffic-observatory/docs/traffic-observability.md](../modules/traffic-observatory/docs/traffic-observability.md) | Replace "traffic-facts is the stable contract consumed by read models" with the evidence→facts→console story. |
| [modules/traffic-observatory/docs/llm-traffic-runbook.md](../modules/traffic-observatory/docs/llm-traffic-runbook.md) | Update LLM consumer guidance: use `traffic-facts --json` (v3), not `traffic-report`. |
| [modules/ghostroute-console/docs/data-pyramid.md](../modules/ghostroute-console/docs/data-pyramid.md) | Replace with the actual pyramid description: traffic_facts → 5min → hourly → daily + DNS → 5min. |
| [modules/ghostroute-console/docs/monitoring-principles.md](../modules/ghostroute-console/docs/monitoring-principles.md) | Update: "UI reads from pyramid aggregates, not from raw traffic_facts." |
| [AGENTS.md](../AGENTS.md) | Clarify: "sing-box / dnsmasq / iptables / Reality / VPS / routing-core router scripts — do not touch. traffic-observatory CLI and read-only router scripts (lan-flow-facts-snapshot, dns-query-snapshot) — allowed through review." |

### Step 11. Tests

Add (Track A — Router/parser):

1. `tests/test-lan-flow-facts-v2.sh` — TSV v2 columns parse OK, v1 lines still parsed.
2. `tests/test-dns-query-snapshot.sh` — fixture dnsmasq log → expected TSV; missing source → exit 0 + warning file.

Add (Track B — traffic-evidence + traffic-facts):

3. `tests/test-traffic-evidence-json.sh` — `--json` produces a valid evidence-v1 shape; missing sources → warnings, not failure; does not call traffic-report.
4. `tests/test-traffic-facts-v3-invariant.sh` — synthetic flow_samples → every traffic_fact has `bytes == via_vps + direct + unknown`.
5. `tests/test-traffic-facts-v3-dns-link.sh` — exact match → high, no match → no_dns_match, IP-only → no invented domain.
6. `tests/test-traffic-facts-v3-no-doublecount.sh` — given app_flows + destinations both present, output bytes == flow_samples sum, NOT sum of both views.
7. `tests/test-traffic-facts-route-mismatch.sh` — verification=mismatch → accounting_status=route_mismatch + evidence in evidence_json.

Add (Track C — Console):

8. `app/tests/normalize-traffic-facts-v3.test.mjs` — v3 ingest persists all 12 new columns.
9. `app/tests/snapshot-contracts-v3.test.mjs` — schema_version=3 accepted, v2 still accepted, traffic_evidence accepted.
10. `app/tests/pyramid-rollup.test.mjs` — synthetic traffic_facts → expected sums in 5min, hourly, daily.
11. `app/tests/dashboard-aggregates.test.mjs` — `/api/dashboard?period=today|week|month` reads from pyramid, not raw scan.
12. `app/tests/verify-aggregates.mjs` — sum(pyramid) within 1% of sum(traffic_facts) per (route, traffic_class) cell.

Add (Track D — Classification):

13. `app/tests/classify-destination.test.mjs` — `app-measurement.com → analytics.firebase / block_candidate`; `push.apple.com → system.apple.push / allow`; `bag.itunes.apple.com → system.apple.appstore / allow`; `dropbox-dns.com → personal_cloud.dropbox / monitor`; known CDN suffix → cdn.* / monitor; IP-only → unknown.ip_only / investigate.

Add (Track E — filter scaffold): tests listed in §5 Step 8.5.6.

Run:
- `./tests/run-fast.sh` (existing — must stay green)
- `./tests/run-smoke.sh` (Console Playwright)
- `node app/tests/run.mjs`
- `cd modules/ghostroute-console/app && npm run lint && npm run build`
- New: `node app/scripts/verify-aggregates.mjs`, `node app/scripts/db-size-report.mjs`, `node app/scripts/bench-dashboard.mjs`, `node app/scripts/verify-timezone.mjs`

---

## 6. Schemas (full reference)

### 6.1 `flow_sample` (in traffic-evidence)

```json
{
  "sample_id": "sha1(client_ip|remote_ip|remote_port|proto|ts)",
  "ts": "2026-05-11T09:00:00.000Z",
  "client_ip": "192.168.1.50",
  "remote_ip": "192.0.2.20",
  "remote_port": "443",
  "proto": "tcp",
  "route": "VPS",
  "out_bytes": 1200,
  "in_bytes": 3000,
  "total_bytes": 4200,
  "connections": 1,
  "source": "conntrack_snapshot_delta",
  "allocation_basis": "observed_delta",
  "destination_kind": "ip",
  "status": "ok",
  "route_source": "ipset",
  "route_basis": "managed_domain",
  "matched_ipset": "STEALTH_DOMAINS",
  "egress_iface": "",
  "fwmark": "",
  "conn_state": "ESTABLISHED",
  "raw_refs": []
}
```

### 6.2 `traffic_fact` (in traffic-facts v3)

```json
{
  "fact_id": "stable hash",
  "sample_id": "...",
  "event_ts": "...",
  "display_ts_utc": "...",
  "time_precision": "second",

  "client_key": "lan-host-04",
  "client_label": "lan-host-04 (iPad)",
  "client_ip": "192.168.1.50",
  "channel": "Home Wi-Fi/LAN",

  "route": "VPS",
  "route_verification": "intent_only",
  "route_source": "ipset",
  "route_basis": "managed_domain",
  "matched_ipset": "STEALTH_DOMAINS",
  "egress_iface": "",
  "fwmark": "",

  "traffic_class": "client",
  "destination": "icloud.com",
  "destination_kind": "domain",
  "destination_ip": "192.0.2.20",
  "destination_port": "443",
  "protocol": "tcp",

  "dns_qname": "icloud.com",
  "dns_answer_ip": "192.0.2.20",
  "dns_link_id": "stable hash",
  "dns_link_confidence": "high",

  "sni": "",
  "policy": "STEALTH_DOMAINS",
  "matched_rule": "STEALTH_DOMAINS",
  "outbound": "reality-out",

  "bytes": 4200,
  "bytes_up": 1200,
  "bytes_down": 3000,
  "via_vps_bytes": 4200,
  "direct_bytes": 0,
  "unknown_bytes": 0,
  "connections": 1,

  "identity_confidence": "registry",
  "byte_confidence": "observed",
  "destination_confidence": "dns_exact",
  "confidence": "observed",
  "accounting_status": "ok",
  "allocation_basis": "observed_delta",
  "evidence_level": "flow_sample",
  "sources": ["lan-flow-facts", "dns-query-facts"],
  "evidence_json": "{}"
}
```

### 6.3 `dns_link`

```json
{
  "id": "stable hash",
  "snapshot_id": "",
  "collected_at_utc": "...",
  "client_key": "...",
  "client_ip": "192.168.1.50",
  "domain": "app-measurement.com",
  "destination": "192.0.2.10:443",
  "destination_ip": "192.0.2.10",
  "destination_port": "443",
  "protocol": "tcp",
  "dns_answer_ip": "192.0.2.10",
  "dns_event_ts_utc": "...",
  "flow_event_ts_utc": "...",
  "link_type": "exact_client_ip",
  "confidence": "high",
  "evidence_json": "{}"
}
```

---

## 7. Acceptance criteria

The refactor is done when:

1. `traffic-facts` default source mode is `evidence`, not `report`.
2. `traffic-report` is marked deprecated but still runnable.
3. `traffic-facts` emits `schema_version: 3`.
4. `traffic-facts` uses **one** canonical byte source: `flow_samples`. No `app_flows + destinations` summation.
5. Every `traffic_fact` satisfies `bytes == via_vps + direct + unknown` by construction.
6. `traffic_facts` row includes: `protocol`, `bytes_up`, `bytes_down`, `route_source`, `route_basis`, `matched_ipset`, `egress_iface`, `fwmark`, `route_verification`, `dns_link_id`, `dns_link_confidence`, `accounting_status`.
7. Router `lan-flow-facts-snapshot` writes v2 TSV with route evidence; v1 parse compatibility preserved.
8. `dns-query-snapshot` collects DNS query/answer evidence (best-effort).
9. DNS-flow correlation works: `domain → answer_ip → flow.destination_ip` via `traffic-facts.dns_links`.
10. Console accepts `schema_version=3` and the `traffic_evidence` snapshot type.
11. Console SQLite stores all new fields.
12. Pyramid tables (5min, hourly, daily, dns 5min/hourly/daily, top-windows) exist and are populated by the rollup function.
13. Retention is applied to all operational tables (`normalized_*`, `events`, `route_decisions`, `traffic_*`, `client_traffic_*`, `dns_log_5min`, `dns_log_hourly`, `dns_log_daily`).
14. `/api/dashboard?period=today|week|month` reads from the pyramid, not from raw.
15. Default filter `traffic_class='client'`; `?class=all` available.
16. All 12 new fields reach the GUI components via the API response (route_meta, attribution, dns_link, traffic_class, protocol). Visual unchanged.
17. DB size target < 500 MB after a 7-day soak (vs current ~3 GB).
18. TZ unified: UTC in DB, MSK in bucket keys and UI filters.
19. `derivedCache` TTL = 300s. `clearDerivedCache()` called at the end of `applyNormalization()`.
20. No active blocking / OSINT / external API calls.
21. Base GUI layout preserved; new v3 fields surfaced via minimal spot edits (badge / row / dropdown option).
22. Channel A / B / C / managed-domain routing logic is not broken. Additional read-only router fields added but routing decisions are unchanged.
23. Filter scaffold (Step 8.5) installed: tables `filter_rules` + `filter_decisions`, dry-run `evaluator`, GET-only API endpoints, 405 on mutation. `enabled=0` and `dry_run=1` by default.
24. All docs from §10 updated to the new architecture.
25. CI green (`tests/run-fast.sh`, `tests/run-smoke.sh`, `node app/tests/run.mjs`, new tests from §11).

---

## 8. Implementation order (for the implementing LLM)

### Phase A — Router-side evidence (least risk)

1. Add v2 columns to `lan-flow-facts-snapshot` (route_source / route_basis / matched_ipset / egress_iface / fwmark / conn_state). Keep v1 parse compat. Tests #1.
2. Add `dns-query-snapshot`. Extend `cron-traffic-snapshot` to call it. Tests #2.
3. Ansible task additions (copy script). Syntax-check only — no live deploy.

### Phase B — traffic-observatory bin/

4. Implement `bin/traffic-evidence` — JSON output from router artifacts. Tests #3.
5. Rewrite `bin/traffic-facts` v3 reading from `traffic-evidence`. Tests #4-7. Mark `traffic-report` deprecated (header only).

### Phase C — Console DB + ingest

6. Schema migration v8: extend `traffic_facts` and `traffic_dns_links`. Create pyramid tables and `destination_enrichment`. Test #8.
7. Update `snapshot-contracts.mjs` to accept v3 + `traffic_evidence` type. Test #9.
8. Extend `normalizeTrafficFacts()` and `normalizeTrafficDnsLinks()`. Apply `flowTrafficClass()` at ingest.
9. Implement `rollupTrafficWindow()` and `rollupDnsWindow()`. Implement `top_*_window` recompute. Tests #10-11.
10. Idempotent backfill block in `ensureConsoleSchema` (populates hourly/daily from existing traffic_facts on first v8 boot).
11. `pruneOperationalTables()` + nightly conditional VACUUM. Tests for retention behaviour.
12. Add `traffic_evidence` to `collect-once.mjs` command list (before `traffic_facts`); remove `traffic` (traffic-report).

### Phase D — Console read-path

13. Extend `normalized_flows` and `flow_sessions` schemas with new columns.
14. Update `buildNormalizedFlows()` to copy new v3 fields.
15. Rewrite `selectors/{dashboard,clients,dns,live,traffic}.ts` to read from the pyramid; extend response shape with `route_meta`, `attribution`, `dns_link`, `traffic_class`, `protocol`. Test #11.
16. Plumb `destination_attribution_coverage` from upstream into the dashboard payload.
17. Raise `GHOSTROUTE_CONSOLE_DERIVED_CACHE_TTL_MS` default to 300_000. Wrap new aggregate selectors with `cacheGet()`. Call `clearDerivedCache()` at end of `applyNormalization()`.
18. Expand `console_page_summaries` with `dashboard_today|week|month`, `clients_today`, `dns_today`.

### Phase E — Classification + Filter scaffolds

19. Create `app/src/lib/intelligence/`. Implement `classifyDestination()` and refactor `domain-attribution.mjs` / `traffic-classification.mjs` as wrappers. Test #13.
19a. Create `app/src/lib/filters/`: `types.ts`, `rules.ts`, `evaluator.ts` (dry-run only), `evaluate-snapshot.ts`. Add `filter_rules` and `filter_decisions` tables in migration v8. Wire `evaluate-snapshot` into `applyNormalization()` after rollup. Add GET-only API endpoints `/api/filters/rules` and `/api/filters/decisions`; POST/PUT/DELETE → 405. Tests (Track E).

### Phase F — Verify + docs + cleanup

20. Add verify scripts (`verify-aggregates.mjs`, `db-size-report.mjs`, `bench-dashboard.mjs`, `verify-timezone.mjs`).
21. Extend `app/tests/run.mjs` to call verify scripts in unit mode.
22. Manual smoke: `npm run dev:gui` against seeded DB. Visual diff = none.
23. Update all docs from §10.
24. Open PR with full test plan and risk analysis.

---

## 9. Verification scripts

- `app/scripts/verify-aggregates.mjs` — sum(pyramid) vs sum(traffic_facts) within 1% per cell.
- `app/scripts/db-size-report.mjs` — page_count*page_size per table; gate < 500 MB.
- `app/scripts/bench-dashboard.mjs` — `/api/dashboard?period=...` p95 < 500 ms over 50 runs.
- `app/scripts/verify-timezone.mjs` — MSK midnight bounds match UTC offset; pyramid `bucket_msk_key` matches `hour_start_utc`.

Live read-only checks (operator runs; the agent does **not** auto-run them):

- `./verify.sh`
- `./modules/ghostroute-health-monitor/bin/router-health-report`
- `./modules/traffic-observatory/bin/traffic-evidence --json today | jq '.flow_samples | length'`
- `./modules/traffic-observatory/bin/traffic-facts --json today | jq '.schema_version, (.traffic_facts | length)'`
- `cd ansible && ansible-playbook playbooks/99-verify.yml`

**Forbidden** for the agent without explicit permission: `./deploy.sh`, any mutating playbooks, any SSH/SCP mutations, `git push`, live router/VPS changes.

---

## 10. Risks and rollback

### Risks

1. **Pyramid backfill drift** on the oldest day (partial 7-day archive). Mitigation: mark backfilled windows `confidence='estimated'`.
2. **Double-count on re-processing the same snapshot.** Mitigation: 2-bucket recompute window + dedupe shadow table `rollup_applied(snapshot_id, bucket_start_utc)`.
3. **LLM-safe report regression.** Mitigation: keys (`per_route`, `per_class`, `per_client.top`) preserved; snapshot test.
4. **Visual GUI regression** if the default `traffic_class='client'` hides client traffic misclassified as service_background. Mitigation: `?class=all` query param remains; alert "client traffic dropped >50% WoW".
5. **TZ double-conversion** during backfill. Mitigation: `verify-timezone.mjs` runs inside one transaction before commit.
6. **Router script regression in v1 parse.** Mitigation: fixture test on a v1 line guarantees existing consumers still work.
7. **DNS query bounded output.** If the router produces many DNS queries, the bounded output limit can drop important rows. Mitigation: env setting `GHOSTROUTE_DNS_QUERY_MAX_LINES`.

### Rollback

- Feature flag `GHOSTROUTE_USE_AGGREGATES=0` returns selectors to the legacy raw-scan path through `traffic_facts`.
- Feature flag `GHOSTROUTE_TRAFFIC_FACTS_SOURCE=report` returns `traffic-facts` to the legacy report source.
- `traffic-report` remains runnable — the operator-facing path is not broken.
- Safety tag `pre-traffic-facts-v3-$(date +%F)` before starting the migration.

---

## 11. Out-of-scope reminders

- No routing data-plane mutations.
- No visual GUI redesign.
- No OSINT / external API.
- No block / allow decisions (filter scaffold is dry-run only).
- No TLS MITM / packet capture.
- No Console deploy actions.
- No rewriting `traffic-report` (deprecation header only).

---

## 12. Critical files

### New files

- `modules/traffic-observatory/bin/traffic-evidence`
- `modules/traffic-observatory/router/dns-query-snapshot`
- `app/src/lib/time/window.ts`
- `app/src/lib/intelligence/classify-destination.mjs`
- `app/src/lib/intelligence/destination-rules.mjs`
- `app/src/lib/intelligence/explain-classification.mjs`
- `app/src/lib/intelligence/catalogs/{system-apple,system-google,analytics-trackers,cdn-hosting,personal-cloud,local-overrides.example}.json`
- `app/src/lib/filters/types.ts`
- `app/src/lib/filters/rules.ts`
- `app/src/lib/filters/evaluator.ts`
- `app/src/lib/filters/evaluate-snapshot.ts`
- `app/src/app/api/filters/rules/route.ts` (GET-only)
- `app/src/app/api/filters/decisions/route.ts` (GET-only)
- `app/scripts/verify-aggregates.mjs`
- `app/scripts/db-size-report.mjs`
- `app/scripts/bench-dashboard.mjs`
- `app/scripts/verify-timezone.mjs`
- Tests #1-13 (see §5 Step 11) + Track E filter scaffold tests

### Modified files

- `modules/traffic-observatory/router/lan-flow-facts-snapshot` (TSV v2 columns)
- `modules/traffic-observatory/router/cron-traffic-snapshot` (call dns-query-snapshot)
- `modules/traffic-observatory/bin/traffic-facts` (full rewrite v3)
- `modules/traffic-observatory/bin/traffic-report` (deprecation header only)
- `modules/ghostroute-console/app/src/lib/server/store.ts` (schema v8)
- `modules/ghostroute-console/app/scripts/lib/normalize.mjs` (v3 ingest, pyramid rollup, retention)
- `modules/ghostroute-console/app/scripts/lib/snapshot-contracts.mjs` (v3 + evidence)
- `modules/ghostroute-console/app/scripts/collect-once.mjs` (add traffic_evidence, remove traffic-report)
- `modules/ghostroute-console/app/src/lib/server/selectors.ts` (read from pyramid)
- `modules/ghostroute-console/app/src/lib/server/selectors/{dashboard,clients,dns,live,traffic}.ts`
- `modules/ghostroute-console/app/src/lib/dashboard-analytics.mjs`
- `modules/ghostroute-console/app/src/lib/traffic-window.mjs` (delegate to time/window.ts)
- `modules/ghostroute-console/app/src/lib/domain-attribution.mjs` (wrapper over classifyDestination)
- `modules/ghostroute-console/app/src/lib/traffic-classification.mjs` (wrapper over classifyDestination)
- Docs (§5 Step 10): README.md, README-ru.md, docs/architecture.md, docs/operational-modules.md, docs/glossary.md, docs/repo-review-2026-05-10.md, docs/future-improvements-backlog.md, AGENTS.md, modules/traffic-observatory/README.md, modules/traffic-observatory/docs/{traffic-observability,llm-traffic-runbook}.md, modules/ghostroute-console/docs/{data-pyramid,monitoring-principles}.md
