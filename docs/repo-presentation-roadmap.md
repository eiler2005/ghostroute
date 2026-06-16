# GhostRoute — Public Repository Presentation Roadmap

> Expert review and prioritized plan to present this repository as a
> production-like, hiring-grade public showcase. Written from four lenses:
> Staff/Principal engineer, hiring manager, security reviewer, technical writer.
>
> **Scope of this document:** assessment + roadmap only. It does not change code
> or other docs. Each item below is an explicit, reviewable action you can take.
> No secrets, real endpoints, providers, or personal data appear here — only
> mnemonic roles and placeholders.

## Execution status (this pass)

Landed: README "Engineering Highlights" (EN + RU), a Mermaid architecture
diagram, a "Repository conventions" framing note, `docs/prd.md`,
`docs/testing.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, `CODEOWNERS`,
`.editorconfig`, `.github/` issue + PR templates and `dependabot.yml`.

Deliberate deviation from P0-3: the `repo-review-*`, `vpn-domain-journal.md` and
`*-draft.md` files were **framed as intentional conventions in the README rather
than moved**, because they are load-bearing — `vpn-domain-journal.md` is read by
several module scripts and the `repo-review-*` files are the wired contributor
review gate. Moving them would break code and links for no reviewer benefit.

## TL;DR verdict

This is **not a starter repo that needs scaffolding** — it is a mature,
module-native platform with CI, ADRs, a bilingual README with badges and
diagrams, sanitized health tooling, mock-based tests, and disciplined secret
hygiene. The work to make it shine for employers is **polish and framing**, not
construction.

A hiring reviewer who opens this repo today already sees real engineering. What
is missing is the 30-second "why this is impressive and what it demonstrates"
hook, a consolidated product-thinking artifact, a few standard repo-health
files, and a slightly cleaner first impression (internal/agent notes sitting
next to public docs).

Estimated effort to land the high-value items: roughly half a day of writing,
no new features required.

## What is already strong (existing hiring signals)

These are real differentiators — lead with them, do not rebuild them.

- **Module-native architecture with explicit ownership.** 13 modules under
  [`modules/`](../modules/) (routing-core, ghostroute-health-monitor,
  traffic-observatory, traffic-intelligence, dns-catalog-intelligence,
  client-profile-factory, secrets-management, recovery-verification,
  reality-sni-rotation, performance-diagnostics, ghostroute-console, shared).
  Each owns its `bin/`, `router/`/`vps/` runtime, `docs/`, and tests. The
  ownership table in [`docs/operational-modules.md`](operational-modules.md) is
  exactly what senior reviewers look for.
- **Decision records.** 10 ADRs in [`docs/adr/`](adr/) covering terminology,
  secrets-outside-git, deprecated-WireGuard fallback, channel rollout strategy,
  and DNS design. ADR discipline signals senior judgment.
- **Real CI, not a badge for show.** [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
  runs `./tests/run-fast.sh` (14 static/fixture suites) plus a Playwright
  **Console smoke** job with trace upload. Green CI on every push/PR.
- **Layered, mock-driven tests.** ~22 suites under [`tests/`](../tests/) plus
  module tests; runners split by cost (`run-fast`, `run-all`, `run-smoke`,
  `run-console`, `run-performance`). The newest example,
  `modules/ghostroute-health-monitor/tests/test-egress-backend-health.sh`,
  stubs `ssh`/`ansible-vault`/`curl`/`ncat`/`openssl` to drive the tool
  end-to-end without network — a strong testability signal.
- **Security as a first-class module.** [`modules/secrets-management/`](../modules/secrets-management/)
  with a `secret-scan` gate, [`SECURITY.md`](../SECURITY.md), Vault-backed
  secrets, and a **role-only** posture: health tooling prints mnemonic roles
  (`primary_vps` / `backup_reality` / `hermes_vps`), resolves real endpoints
  from Vault locally, and sanitizes IPs/hosts/users out of all output.
- **Operability docs.** SLOs ([`docs/operational-slos.md`](operational-slos.md)),
  a sanitized runtime map ([`docs/router-runtime-map.md`](router-runtime-map.md)),
  deployment/rollback, troubleshooting, and a deliberate egress-failover model
  ([`docs/managed-egress-failover-roadmap.md`](managed-egress-failover-roadmap.md)).
- **Bilingual, badge-fronted README** with an architecture concept diagram and a
  detailed runtime map.

## Gaps for a public hiring showcase

Honest weak spots, ordered by impact on a reviewer's first impression.

1. **No consolidated PRD / product-thinking artifact.** Roadmaps and ADRs exist,
   but there is no single "problem → users → goals/non-goals → requirements →
   key decisions → success metrics → risks" document. Hiring managers explicitly
   look for product thinking; right now it is implicit.
2. **README is operator-centric, not reviewer-centric.** It explains *how to run*
   the platform well, but lacks an explicit, near-the-top "Engineering
   highlights / what this project demonstrates" block that maps the project to
   the competencies an employer scores (architecture, testing, security,
   product thinking, maintainability, DX).
3. **First-impression noise in the repo root and `docs/`.** AI-agent instruction
   files ([`AGENTS.md`](../AGENTS.md), [`CLAUDE.md`](../CLAUDE.md),
   [`LEAN-CTX.md`](../LEAN-CTX.md)) sit at the root, and `docs/` mixes stable
   public docs with internal artifacts (`repo-review-2026-*.md` ×3,
   `vpn-domain-journal.md`, `*-draft.md`). Agent files are a *modern-workflow*
   signal worth keeping — but the review journals and drafts dilute the public
   surface.
4. **Missing standard repo-health files.** No `CODE_OF_CONDUCT.md`,
   `CHANGELOG.md`, `CODEOWNERS`, `.editorconfig`, issue/PR templates, or
   `dependabot.yml`. These are cheap, expected, and signal maintainership.
5. **Diagrams are PNG-first.** Diagrams render via committed PNGs in
   [`docs/assets/diagrams/`](assets/diagrams/); Mermaid appears in only one doc
   ([`docs/router-runtime-map.md`](router-runtime-map.md)). GitHub renders
   Mermaid natively (no binary asset, diffable in PRs).
6. **No single TESTING.md.** The test strategy is excellent but undocumented as a
   narrative (what each runner covers, the static/fixture/smoke/e2e layering,
   how to run locally vs CI).

## Prioritized roadmap

Each item: **what**, **why (hiring signal)**, **effort**, **files**. Do P0
first; it carries most of the reviewer impact.

### P0 — highest reviewer impact (do these first)

| # | What | Why (signal) | Effort | Files |
|---|---|---|---|---|
| P0-1 | Add an **"Engineering highlights"** block near the top of the README: 5–7 bullets mapping the project to architecture / testing / security / product thinking / DX, each linking to proof in-repo. | Lets a reviewer grade you in 30s. | S | [`README.md`](../README.md) (+ mirror in [`README-ru.md`](../README-ru.md)) |
| P0-2 | Write a **PRD**: problem, target user (single-operator), goals/non-goals, functional + non-functional requirements, key decisions (link ADRs), success metrics (tie to [`operational-slos.md`](operational-slos.md)), risks. | Demonstrates product thinking explicitly. | M | new `docs/prd.md` (link from README + [`docs/README.md`](README.md)) |
| P0-3 | **De-noise the public surface.** Keep `AGENTS.md`/`CLAUDE.md`/`LEAN-CTX.md` (workflow signal) but add a one-line note in README explaining they are agent-workflow config. Move `repo-review-2026-*.md`, `vpn-domain-journal.md`, and `*-draft.md` into [`docs/archive/`](archive/) (already exists) or gitignore the journals. | Clean first impression; shows curation. | S | `docs/repo-review-2026-*.md`, `docs/vpn-domain-journal.md`, `docs/*-draft.md`, [`docs/README.md`](README.md) |

### P1 — expected polish

| # | What | Why | Effort | Files |
|---|---|---|---|---|
| P1-1 | Add `CODE_OF_CONDUCT.md` (Contributor Covenant) and `CHANGELOG.md` (Keep a Changelog; seed from the recent feature commits). | Maintainership signal. | S | new root files |
| P1-2 | Add `.github/ISSUE_TEMPLATE/` (bug + feature) and `PULL_REQUEST_TEMPLATE.md`; reference the existing contributor review gate in [`CONTRIBUTING.md`](../CONTRIBUTING.md). | DX + process maturity. | S | new `.github/` files |
| P1-3 | Add `CODEOWNERS` and `.editorconfig`. | Consistency + ownership. | S | new root/`.github/` files |
| P1-4 | Add **`TESTING.md`**: the test pyramid (static → fixture/mock → smoke → Console e2e), what each runner covers, how to run locally vs CI. | Testing-discipline signal. | M | new `docs/testing.md`, link from README + [`CONTRIBUTING.md`](../CONTRIBUTING.md) |
| P1-5 | Add **one Mermaid architecture diagram** (flowchart of ingress → router policy split → managed egress backends) to the README/`architecture.md`, alongside the existing PNG. | GitHub-native, diffable diagram. | S | [`README.md`](../README.md) / [`docs/architecture.md`](architecture.md) |

### P2 — nice-to-have

| # | What | Why | Effort |
|---|---|---|---|
| P2-1 | `.github/dependabot.yml` for the Console `npm` app. | Supply-chain hygiene. | S |
| P2-2 | Add a markdown link-check / doc-lint job to CI. | Doc quality gate. | S |
| P2-3 | Consolidate the three `repo-review-*` into one rolling review and archive the rest. | Less duplication. | S |
| P2-4 | Extend badges (test count, last-commit) only if they stay truthful. | Minor polish. | S |

## Security & privacy review

**Overall: clean.** The repo's privacy posture is itself a hiring signal worth
calling out in the README.

- **No leaks found in tracked files.** Backend banks use mnemonic roles and Vault
  references, not endpoints
  ([`modules/ghostroute-health-monitor/config/managed-egress-backends.tsv`](../modules/ghostroute-health-monitor/config/managed-egress-backends.tsv));
  app canaries are public domains only. Health tools sanitize IPs/hosts/users.
- **Sensitive metadata is policy-fenced.** Role→country/provider mapping lives in
  the gitignored `docs/private/` note and Vault, documented in
  [`managed-egress-failover-roadmap.md`](managed-egress-failover-roadmap.md).
- **`secret-scan` gate** runs in `run-fast`/CI and currently passes.

Preventive rules to keep stated in `SECURITY.md` / `CONTRIBUTING.md`:

| Area | Risk type | Remediation (keep enforced) |
|---|---|---|
| `docs/private/` | Provider/country/geo leak | Stays gitignored; never quoted in public docs or commits. |
| Backend/canary banks | Endpoint/provider leak | Banks hold only public domains and Vault refs; no hosts/IPs/SNIs. |
| `.env.example` / docs | Credential/endpoint leak | Placeholders only (`<router_lan_ip>`, `example.invalid`, `198.51.100.10`). |
| Generated artifacts | Client-profile/key leak | `ansible/out/`, local `reports/` remain gitignored. |
| Commits/PRs | Accidental secret | `secret-scan` gate + review before merge. |

If any future change adds a real value, report it as `file | risk type |
remediation` and replace the value with a placeholder rather than printing it.

## Final report

**What to change (recommended order):** P0-1 README highlights → P0-2 PRD →
P0-3 de-noise docs → P1 community/testing/Mermaid → P2 polish.

**Files to create:** `docs/prd.md`, `docs/testing.md`, `CODE_OF_CONDUCT.md`,
`CHANGELOG.md`, `CODEOWNERS`, `.editorconfig`, `.github/ISSUE_TEMPLATE/*`,
`.github/PULL_REQUEST_TEMPLATE.md`, optional `.github/dependabot.yml`.

**Files to update:** `README.md` / `README-ru.md` (highlights + agent-file note +
Mermaid), `docs/README.md` (index after de-noising), `docs/architecture.md`
(Mermaid), `CONTRIBUTING.md` (link TESTING.md).

**Files to move/archive:** `docs/repo-review-2026-*.md`,
`docs/vpn-domain-journal.md`, `docs/*-draft.md` → `docs/archive/` or gitignore.

**Hiring signals strengthened:** product thinking (PRD), instant readability
(README highlights), maintainership (community files), testing discipline
(TESTING.md), security maturity (explicit privacy posture), DX (templates,
editorconfig), curation (clean public surface).

**Risks found:** none active. The model to preserve is role-only labels +
Vault-resolved endpoints + gitignored `docs/private/`.

**What to improve next (beyond this pass):** a short architecture decision log
"why Reality over WireGuard/OpenVPN" essay; a one-page demo/screenshot of the
Console (sanitized); a coverage or runtime-evidence summary the CI can publish.

**Verification commands (run before pushing any of the above):**

```bash
./tests/run-fast.sh                                   # fast static/fixture suites
./tests/run-all.sh                                    # full suite (slower)
./modules/secrets-management/bin/secret-scan          # secret gate
cd ansible && ansible-playbook --syntax-check playbooks/99-verify.yml && cd ..
# markdown link sanity (if a link-checker is available locally):
#   npx --yes markdown-link-check README.md docs/prd.md docs/testing.md
```

## Reference inspiration (do not copy)

Treat these as *patterns*, adapt to GhostRoute's voice: top-tier infra OSS
READMEs that open with a crisp problem statement + architecture diagram +
"why it's built this way"; PRD templates that separate goals from non-goals and
tie requirements to measurable success metrics; ADR practice (already in use
here); and security-conscious projects that document their threat model and
secret-handling posture up front (already a strength here).
