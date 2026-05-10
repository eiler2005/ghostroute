# Repository Quality Audit — 2026-05-10

> **Status**: snapshot review, current as of 2026-05-10. Findings to be addressed against `docs/future-improvements-backlog.md`. Successor to `docs/repo-review-2026-04-28.md`.
>
> **Scope**: documentation surface, GhostRoute Console architecture and code quality, product-level repo hygiene, git presentation. Hard non-goal: no router / channel A/B/C / sing-box / dnsmasq / iptables / Reality / VPS / traffic-observatory changes — this audit describes **what to improve**, it does not change runtime.

---

## Executive summary

The repo reads as **confident mid-tier with staff-leaning intent**. Discipline is visible: DB migrations, ADRs, audit tables, version-keyed cache, pre-commit hooks, GitHub Actions CI with three jobs, nine modules following one convention, lean SECURITY.md without filler. Rare combination for a one-operator project.

What lowers the bar: **the doc surface is drifting** (RU/EN divergence, prescriptive "archived" plans living in the public tree), **type safety leaks at the DB↔API boundary**, and **snapshot ingestion has no schema validation** — the single class of silent bugs that no current test catches. Git presentation has the foundation (CI, hooks, conventional safety-tags) but the release story and external-reader presentation are incomplete.

**Aggregate scores**: documentation **6.5/10**, console code **7.5/10**, product maturity **7/10**, git presentation **6/10**.

---

## A. Documentation (fix in this iteration)

Grouped by severity. Each item: **file — what's wrong — one-line fix**.

### A1. Critical (misleading or contract-breaking)

1. **`README.md` ↔ `README-ru.md` drift.** RU is a summary, not a translation (576 vs 753 lines). EN has the channel-maturity table, Quick Start, ADR index — RU does not. The "both are equivalent references" contract from `AGENTS.md §Docs to Read` is broken in practice.
   *Fix*: explicit header in both READMEs — "English README is the developer-facing ground truth; Russian README is a localized operator summary." Sync top-level section headings.

2. **Channel C status is ambiguous.** `README.md` says "C1-Shadowrocket is live-proven", but `docs/channels.md` and `docs/archive/channel-c/` read like ongoing research. `C1-sing-box native Naive` is marked client-blocked but it's not surfaced at the top.
   *Fix*: add a "Production status" column to the channel table in README — A (production), B (selected-clients), C1-Shadowrocket (live-proven), C1-sing-box (server-ready, client-blocked).

3. **Prescriptive "archived" plans live in the public tree.** `docs/repo-review-2026-04-28.md` (498 lines) and `docs/archive/roadmaps/architecture-improvement-roadmap-2026-04-26.md` are tagged "archived/superseded" but the body is written in the imperative ("must add SECURITY.md" — which already exists). New readers get confused about whether to act on them.
   *Fix*: add a banner at the top of each — "Status: historical snapshot. Items completed / cancelled / deferred — see `docs/future-improvements-backlog.md`." Stronger option: move `repo-review-2026-04-28.md` into `docs/archive/`.

4. **WireGuard contradiction.** `AGENTS.md §Architecture Invariants` forbids reactivating `wgs1` / `wgc1`. README says "cold fallback preserved." Missing: a one-line operational instruction "how to enable in a catastrophe only." Risk that someone reads "cold fallback" as "auto-failover capable."
   *Fix*: a "Cold fallback: manual WireGuard recovery only" block in `docs/architecture.md` with explicit "no auto-failover" wording and the single activation command.

### A2. Quality (clarity, drift, duplication)

5. **Console docs are fragmented.** `modules/ghostroute-console/docs/` has `data-pyramid.md`, `monitoring-principles.md`, `operator-runbook.md`, `device-attribution.example.json` — but no `database-schema.md` or `api-contracts.md`. The 20+ table SQLite schema and API contracts live only in code.
   *Fix*: add `database-schema.md` (auto-generatable from migrations in `store.ts:36-318`) and `api-contracts.md` (endpoint → params → shape).

6. **Three modules are missing a README entry.** `modules/shared/`, `modules/performance-diagnostics/`, `modules/reality-sni-rotation/` have `docs/` but no `README.md`.
   *Fix*: 3-5 sentences per module — "what does this module do, pointer to deep dive."

7. **Troubleshooting is split.** `docs/troubleshooting.md` (RU, 308 lines) + `modules/ghostroute-health-monitor/docs/stealth-monitor-runbook.md` (EN) + `modules/routing-core/docs/channel-routing-operations.md` — no single-entry decision tree of the form "I have problem X, where do I look?"
   *Fix*: top section in `docs/troubleshooting.md` becomes a decision tree (Reality down → / DNS leak → / mobile-not-routing →). Body distributed via links to the existing module runbooks.

8. **`docs/future-improvements-backlog.md` (581 lines, RU-only).** Excellent doc, but no EN summary and no phase markers. Some items are already done (Phase 0 console exposure), some deferred — not annotated.
   *Fix*: 10-line EN summary at the top + `✓ done / ◐ in progress / ○ deferred` markers per item.

9. **TODO placeholders in `modules/client-profile-factory/docs/client-profiles.md:261-267`.** Example table with TODO cells for `iphone-1..6`. Not a draft — it's a live doc.
   *Fix*: either fill with fake data (`iphone-X`, `user-***`) or replace the table with "Profiles are generated dynamically; see vault."

10. **RU-only docs are hard to discover.** `docs/troubleshooting.md` and `docs/future-improvements-backlog.md` are operationally critical, but a non-RU reader will skip them.
    *Fix*: `[RU only]` badge in the top of each RU-only doc; explicit cross-link from the EN README — "Operational troubleshooting lives in `docs/troubleshooting.md` (RU)."

### A3. Missing (what a senior contributor expects to find and doesn't)

11. **`CONTRIBUTING.md`** is absent. No description of dev setup, doc style (when RU when EN), PR checklist, how to run tests locally.
    *Fix*: ~50 lines, draws from `AGENTS.md` safety rules + pointer to `tests/run-*.sh`.

12. **Deployment & rollback playbook.** `ansible/README.md` describes how to deploy, but there's no "5-minute rollback" and no operator pre-flight checklist.
    *Fix*: `docs/deployment-and-rollback.md` — pre-deploy checklist (vault, secrets-scan, tests), deploy commands, post-deploy verify, rollback triggers, per-component rollback (router routing / VPS / DNS / Channel B/C).

13. **SLO / success criteria.** Nowhere is "working correctly" defined. ADR-0003 explicitly rejects external alerts but doesn't set internal SLOs.
    *Fix*: `docs/operational-slos.md` — availability (Reality listener), latency (managed→internet), correctness (no DNS leaks), billing (mobile sees home IP). Each with a measurement procedure via existing health/traffic commands.

14. **`SECURITY.md` threat model is thin.** 74 lines total, ~30 of them threat-model. A real threat model lists ISP DPI, RKN block, endpoint compromise, VPS takeover, vault loss + mitigations + out-of-scope.
    *Fix*: extend `SECURITY.md` with sections "Threat scenarios", "Mitigations", "Out-of-scope risks", "Recovery boundaries" (~+150 lines).

15. **Glossary.** "managed domain", "split routing", "home-first", "WAN exit", "Reality ingress" — used without definitions. New reader spends 30 min stitching terms together.
    *Fix*: `docs/glossary.md` with 15-20 entries (no more).

16. **ADR gaps.** The existing 9 ADRs are good. Missing decisions:
    - ADR-0010: monitoring/alerting strategy (ADR-0003 defers; the deferral itself is ADR-worthy).
    - ADR-0011: IPv6 policy (`backlog §5` mentions "explicit policy needed").
    - ADR-0012: Channel B/C release criteria (when does a selected-client lane become production).
    - ADR-0013: VPS failover strategy (what we do on VPS loss).

---

## B. Console architecture and code (deferred — tech debt)

I'm not repeating strengths here — they live in the data-architecture refactor plan. This section is **where the code will fail first** and **what to take in the next iteration**.

### B1. Biggest architectural risk

**Snapshot ingestion has no payload schema validation.** `app/scripts/lib/normalize.mjs` accepts raw JSON from 7 different CLIs and stores it in `snapshots.payload_json` without structural validation. If an upstream CLI changes format (and it's not a controlled dependency — `traffic-observatory` is a separate module), the console will either silently store garbage or crash 10 queries deep inside selectors.

**Mitigation (1 file, ~150 lines)**: add `app/src/lib/snapshot-validators.ts` with one validator per type (`validateTraffic()`, `validateDns()`, etc.). Invalid snapshots → `collector_errors.kind='schema_violation'`, never reach `normalized_*`.

**Why it matters**: this is the only bug class not covered by any existing test — `model.test.mjs` runs on pre-baked fixtures with known-valid structure.

### B2. Highest-value low-effort quick win

**Three-query pagination.** `listTrafficRows()` / `listDnsQueryLog()` (`app/src/lib/server/selectors.ts`) issue `count → data → offset-count` separately. Replacing with `SELECT *, COUNT(*) OVER() AS total FROM ... LIMIT ? OFFSET ?` **halves TTFB** on paginated views (Traffic, DNS, Live), without changing the API contract.

### B3. Type safety — gaps at the DB↔API boundary

- `tsconfig.json` doesn't have `strict: true`. That's a default decision, not a deliberate one.
- DB rows are read as `any` everywhere (`row.payload_json`, `row.via_vps_bytes`).
- API handlers return `NextResponse.json({...})` without `satisfies ResponseShape`.

*Fix (incremental)*: `db-types.ts` with row interfaces (per-table); `noImplicitAny: true` first, then full `strict`.

### B4. Concurrency / SQLite writer locks

The git log shows commits like "keep collector writer locks short", "serialize collector sqlite writers", "tolerate transient sqlite writer contention" (on `chore/gui-stability` and master). Those are **symptoms** of one of the problems already resolved reactively. Root cause: SELECTs during COLLECT hold locks on large tables.

*Fix*: after the data-architecture refactor lands aggregate tables, this resolves naturally. Until then, keep the TTL-retry pattern but document it in `operator-runbook.md`.

### B5. Test coverage — one weak spot

`normalize.mjs` has no unit tests. `model.test.mjs` runs on a seeded DB, but the ingestion pipeline (CLI JSON → normalized rows) is not directly tested. See B1.

### B6. SQL is scattered

13+ `db.prepare(...)` sites in `selectors.ts` and `store.ts`, no shared layer. A repository pattern is overkill, but `app/src/lib/server/db-queries.ts` with the top ~15 prepared queries would reduce duplication and ease the upcoming aggregate migration.

---

## C. Product level (good, but underdone)

### C1. Already in place (OK)

- **GitHub Actions CI** (`.github/workflows/ci.yml`): 3 jobs — `repo-checks` (`tests/run-fast.sh`), `console-smoke` (Playwright + traces upload), `console-performance` (gated on `workflow_dispatch`). Above the level of most hobby projects.
- **Pre-commit hooks** (`.pre-commit-config.yaml`): secret-scan + shell-syntax. Minimal but correct.
- **Test tier**: `run-all.sh` / `run-fast.sh` / `run-smoke.sh` / `run-console.sh` / `run-performance.sh` — clean hierarchy by safety (fixture vs live).
- **Module convention** held across 9 modules.
- **`.gitignore`** at 75 lines — covers secrets / reports / build artifacts.
- **ADR directory** with README.

### C2. Where it's underdone

1. **Empty stubs `scripts/health-monitor/` and `scripts/vps-health-monitor/`.** AGENTS.md says "top-level scripts is reserved for future cross-repo utilities", but empty dirs read as "started and abandoned."
   *Fix*: either remove them, or add `scripts/README.md` with a one-liner "reserved for future cross-module utilities; module-owned commands live in `modules/<name>/bin`."

2. **No vault backup automation.** `modules/secrets-management/docs/vault-offsite-backup.md` describes the procedure, but there's no cron / hook. **Vault loss = total loss** for a one-operator setup — that's the primary operational risk.
   *Fix*: cron helper `bin/vault-snapshot --to <encrypted-path>` + integrity check. Document weekly minimum cadence.

3. **Console DB backup destination unclear.** Deploy mentions `GHOSTROUTE_DB_BACKUP_MODE=daily`, but the destination isn't visible and there's no integrity check after backup.
   *Fix*: document destination + add `PRAGMA integrity_check` after snapshot.

4. **`.nvmrc` is missing.** CI hardcodes `node-version: "22"`, but local devs don't see this.
   *Fix*: `echo "22" > .nvmrc`.

5. **Renovate / Dependabot not configured.** Not critical for one-operator, but 2 minutes to add `.github/dependabot.yml` for `modules/ghostroute-console/app/`.

6. **Operator-level alerting**: ADR-0003 explicitly declines external alerts, but even a local syslog/journald line "reality disconnected at <ts>" isn't written. Single operator → one missed connection drop can stay unnoticed for a day.
   *Fix*: optional `--alert local-journal` mode in `router-health-report`.

### C3. Biggest remaining gap (after correcting the CI assessment)

Not CI (it exists). Not code (it's clean). **The biggest gap is the disaster-recovery story**: what to do on vault loss, on console DB corruption, on VPS unavailability >24 h. The docs describe "how to deploy" but not "how to recover." For a one-operator setup, that's the **only scenario where the entire project can be lost at once**.

---

## D. Git and presentation

### D1. What's there

- **CI workflow** on push / PR / manual.
- **Pre-commit hooks** (bypassable, but normal for one-operator).
- **2 safety tags**: `pre-channel-a-final-cleanup-2026-04-25`, `pre-mobile-relay-2026-04-25`. Correct pattern for risky migrations.
- **Clean master**: last commit 2026-05-10.
- Active work: `chore/gui-stability` 2026-05-07 — 3 days old, normal.

### D2. What's off / missing

1. **Inconsistent commit message style.** Master uses imperative English without prefixes:
   - `Resolve traffic facts through client registry`
   - `Stabilize LAN flow fact identity`
   - `Add console traffic accounting v10`
   
   The branch `chore/gui-stability` uses Conventional Commits on the merge commit (`chore: harden ghostroute console gui stability`). Inside the branch — back to no prefix. Minor inconsistency, but **discipline-eroding** — and it gives up automatic changelog generation.
   
   *Fix*: pick one. Recommended: **Conventional Commits** (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`) with scope mandatory for big modules (`feat(console):`, `fix(routing-core):`). Lock it in via `CONTRIBUTING.md` and a commitlint hook.

2. **No CHANGELOG.md / release notes.** The only way to learn "what's new" is `git log`. For a portfolio repo, that's a lost signal.
   *Fix*: `CHANGELOG.md` in keep-a-changelog format. Can be generated from conventional commits via `git-cliff` / `conventional-changelog`.

3. **No version tags / semver.** Two safety-tags only. No release history.
   *Fix*: start with `v0.1.0` from current master + tag stable cuts every 2-3 weeks. Semi-formal semver is fine.

4. **PR / Issue templates absent.** `.github/` exists, templates inside don't.
   *Fix*: 2 files — `.github/pull_request_template.md` (Summary / Test plan / Risk) and `.github/ISSUE_TEMPLATE/bug.md`. ~30 lines each.

5. **No branch protection on master.** Can't verify from CLI, but probably absent (one-operator). For portfolio purposes, at minimum enable `Require status checks` (CI) and `Require linear history`.
   *Fix*: configure in GitHub Settings → Branches.

6. **`Co-Authored-By: Claude` footers.** Not visible in commits. Policy decision needed — either add everywhere (honest, but noisy) or nowhere. Currently "nowhere." Whatever the choice — **lock it in `CONTRIBUTING.md`** so it doesn't drift.

7. **`feature/console-observability-v2` local branch.** Exists locally, not on origin (`unknown revision` for `origin/feature/console-observability-v2`). If already merged-and-deleted upstream — clean it up locally (`git branch -D`). If not — describe its fate. Hanging unmerged branches are a typical mid-tier signal.
   *Action item*: operator decides — merge / discard / preserve, and records the decision.

8. **`pre-channel-a-final-cleanup-2026-04-25` / `pre-mobile-relay-2026-04-25`** are the right pattern. Should be **codified in `CONTRIBUTING.md`**: "Before any potentially breaking migration, create a safety tag with prefix `pre-<event>-<date>`."

### D3. Repo presentation (for an external reader / employer)

- **`README.md` lacks a demo section.** Screenshots exist around the codebase but aren't embedded in the README.
  *Fix*: 2-3 PNGs from the console (Dashboard, Flow Explorer) embedded via `<img src="docs/img/...">`.
- **No mermaid architecture diagram in README.** The text is good, the visual isn't there.
  *Fix*: one ~20-line mermaid diagram "client → router → channel A/B/C → VPS / direct".
- **No CI badge in README.**
  *Fix*: GitHub Actions CI status badge.

---

## E. Prioritized fixlist

### P0 — current iteration (documentation)

1. RU/EN headers in both READMEs (5 min).
2. Channel C production-status table column (10 min).
3. "Historical snapshot" banners on `docs/repo-review-2026-04-28.md` and `docs/archive/roadmaps/...` (10 min).
4. Cold-fallback WireGuard section in `docs/architecture.md` (10 min).
5. EN summary + phase markers in `docs/future-improvements-backlog.md` (30 min).
6. `[RU only]` badge on RU-only docs + cross-link from EN README (10 min).
7. Cleanup of TODO rows in `client-profiles.md` (5 min).
8. `CONTRIBUTING.md` (~50 lines, ~40 min).
9. `docs/glossary.md` (~15 entries, ~30 min).
10. `SECURITY.md` threat-model expansion (~+150 lines, ~1.5 h).
11. `docs/deployment-and-rollback.md` (~1 h).
12. `docs/operational-slos.md` (~45 min).

**P0 total**: ~6 hours of focused time.

### P1 — next session (low-risk code)

1. Pagination via window function — `listTrafficRows()`, `listDnsQueryLog()` (1 h, measurable perf win).
2. Snapshot validators (~150 lines, ~2 h, closes a whole class of silent bugs).
3. `db-types.ts` + targeted `noImplicitAny` (4-6 h, incremental).
4. `.nvmrc` + commitlint hook + `.github/pull_request_template.md` (1 h).

### P2 — careful (regression risk)

1. Data-architecture refactor (Part 1 of the prior plan) — separate LLM, separate iteration.
2. `app/src/lib/server/db-queries.ts` consolidation (a few hours, requires tests).
3. Conventional-commits migration — going-forward only, do not rewrite existing history.

### P3 — when there's time

1. ADR-0010..0013.
2. Mermaid diagram + screenshot embeds in README.
3. CI badge.
4. Renovate / Dependabot.
5. Vault backup automation (low risk in design, but the action itself is mutating — needs careful design).

---

## F. Out of scope for this audit

- Ansible playbooks (verified syntax only, not semantics — needs a separate security review).
- Channels B/C behavioral analysis (operator's domain, not reviewer's).
- VPS-side threat model (Reality / Xray) — covered by the SECURITY.md expansion in P0.
- Real-load performance benchmarks against the live router (require live access, blocked by hard constraints).

---

## G. Cross-reference

After landing this file, add a one-line pointer at the top of `docs/future-improvements-backlog.md`:

> See also: [`docs/repo-review-2026-05-10.md`](repo-review-2026-05-10.md) for the 2026-05-10 audit and prioritized fixlist.

And update phase markers in `docs/future-improvements-backlog.md` for items repeated here, so the two stay reconciled.
