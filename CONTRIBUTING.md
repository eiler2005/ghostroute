# Contributing to GhostRoute

GhostRoute is a single-operator routing platform. This file documents how the
operator (and any AI agents collaborating on the repo) should make changes —
locally, in PRs, and at the doc / commit level.

## Project context

Read these first; the rest of this file assumes the rules they document.

- [`AGENTS.md`](AGENTS.md) — primary contract for how to work in this repo
  (Karpathy-style workflow, safety rules, secret handling, architecture
  invariants, where things live).
- [`CLAUDE.md`](CLAUDE.md) — Claude-specific working notes; imports
  `AGENTS.md`. Both files are equivalent for non-Claude agents.
- [`SECURITY.md`](SECURITY.md) — protected assets, threat model, secret policy,
  recovery boundaries.
- [`docs/operational-modules.md`](docs/operational-modules.md) — module map.

## Development setup

This repo is operated from a control machine (macOS/Linux) and targets an ASUS
Asuswrt-Merlin router and a small VPS. Local-only checks do not require any
router or VPS access.

Prerequisites:

- Node.js 22 (matches `.github/workflows/ci.yml`). If you use `nvm`, run
  `nvm use 22` (a `.nvmrc` is on the backlog).
- Python 3.x for Ansible-related tooling.
- POSIX shell (`bash` for control-machine scripts, BusyBox `ash` compatibility
  required for anything running on the router).
- `ripgrep` (`rg`) for the doc-syntax scan.

Local-only verification:

```bash
./modules/secrets-management/bin/secret-scan
./tests/run-fast.sh
./tests/run-smoke.sh   # Console smoke tests via Playwright
bash -n verify.sh tests/run-all.sh tests/run-fast.sh
```

## Documentation conventions

- `README.md` is the developer-facing ground truth. `README-ru.md` is the
  localized operator-facing summary; if EN and RU drift, EN wins.
- Use [language tags](docs/repo-review-2026-05-10.md) for non-EN-primary docs:
  `[RU primary]` at the top of any doc that is operator-Russian, plus a
  cross-link to its EN entry point if one exists.
- Internal links use repo-root paths (e.g. `[docs/architecture.md](/docs/architecture.md)`)
  so they resolve identically on GitHub and locally.
- Module-owned deep dives live in `modules/<module>/docs/`. Cross-cutting docs
  live in `docs/`.
- Sensitive values must use placeholders only (`<router_lan_ip>`,
  `<home-reality-port>`, `example.invalid`). Never paste real endpoints, ports,
  UUIDs, Reality keys, short IDs, admin paths, QR payloads, or VLESS URIs.

## Commit conventions

- **Format**: prefer Conventional Commits going forward — `<type>(<scope>):
  <imperative subject>`. Example: `fix(console): resolve traffic facts via
  client registry`. Existing history uses plain imperative English without
  prefixes; do not rewrite it.
- **Allowed types**: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`,
  `perf`, `build`, `ci`. Use a `scope` for module-bounded changes
  (`console`, `routing-core`, `traffic-observatory`, `health-monitor`,
  `dns-catalog`, `recovery`, `secrets`, `client-profiles`, `ansible`, `docs`).
- **Subject line**: imperative, ≤72 chars, no trailing period.
- **Body** (optional): explain *why*, not *what*. Reference ADRs, runbooks or
  AGENTS.md sections for non-obvious decisions.
- **Co-authorship**: when an AI agent meaningfully contributed, include a
  `Co-Authored-By: <Agent name> <noreply@…>` trailer. Otherwise omit it. Do
  not retroactively add or remove these.
- **Safety tags**: before any potentially breaking migration (router data
  plane, channel ownership, secrets layout), create a tag of the form
  `pre-<event>-<YYYY-MM-DD>` so the prior state is recoverable.

## Pull requests

- Title: same convention as commit subject.
- Body should answer:
  - *Summary*: what changes and why (1–3 bullets).
  - *Scope*: which modules / files are affected; explicitly call out anything
    that touches the router data plane, sing-box, dnsmasq, iptables, Reality,
    VPS, or `traffic-observatory`.
  - *Test plan*: which checks were run locally, and which deliberately not
    (live deploy, broad Ansible runs).
  - *Risk*: rollback plan, blast radius, irreversible steps.
- Keep PRs small and module-scoped. If a refactor crosses modules, split it.
- All PRs should pass the GitHub Actions `CI` workflow (`tests/run-fast.sh` +
  `tests/run-smoke.sh`). Performance suite runs only on
  `workflow_dispatch`.

## Pre-commit hooks

`.pre-commit-config.yaml` runs:

- `ghostroute-secret-scan` — `./modules/secrets-management/bin/secret-scan`
  catches real endpoints, UUIDs, keys, ports, public IPs and admin paths
  before they reach a commit.
- `ghostroute-shell-syntax` — `./tests/check-shell-syntax.sh` validates shell
  scripts for both BusyBox `ash` (router) and `bash` (control machine)
  compatibility.

Install once: `pre-commit install`. Do not skip hooks (`--no-verify`) unless
the operator explicitly authorizes it for an emergency commit.

## Safety boundaries

These are restated in `AGENTS.md` and are enforced for all contributors,
human or AI:

- Never run `git commit`, `git push`, `./deploy.sh`, mutating Ansible
  playbooks (`00-*`, `10-*`, `11-*`, `20-*`, `21-*`, `22-*`,
  `30-generate-client-profiles.yml`), or any router/VPS-mutating SSH/SCP/rsync
  command without explicit operator permission.
- Never reintroduce `VPN_DOMAINS`, `RC_VPN_ROUTE`, `0x1000`, active `wgs1` or
  active `wgc1` as production state.
- Never deploy if relevant local checks have not passed; if checks were
  intentionally skipped, say so and ask before deploying.
- Never disable hooks (`--no-verify`, `--no-gpg-sign`) without explicit
  operator authorization.

## Where to put new findings

- A specific bug or regression: open a focused PR or issue.
- A long-term improvement: add to
  [`docs/future-improvements-backlog.md`](docs/future-improvements-backlog.md)
  with an appropriate phase marker (`✓ done` / `◐ in progress` /
  `○ deferred`).
- A repo-wide review: write a snapshot under
  `docs/repo-review-YYYY-MM-DD.md` (latest:
  [`docs/repo-review-2026-05-10.md`](docs/repo-review-2026-05-10.md)).

## Reporting security issues

This is a personal operations repo. For sensitive findings, do not open a
public issue. Share only sanitized evidence with placeholders. See
[`SECURITY.md`](SECURITY.md) for the full policy.
