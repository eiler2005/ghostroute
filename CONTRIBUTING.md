# Contributing to GhostRoute

GhostRoute is a single-operator routing platform. This file documents how the
operator and AI agents should make changes locally, in PRs and at the docs /
commit level.

The default posture is conservative: understand the owning module, keep the diff
small, prove the change with the narrowest safe checks and never publish real
runtime state.

## Project context

Read these first; the rest of this file assumes the rules they document.

- [`AGENTS.md`](AGENTS.md) — primary contract for working in this repo:
  workflow, safety rules, secret handling, architecture invariants and directory
  ownership.
- [`CLAUDE.md`](CLAUDE.md) — Claude-specific working notes; imports
  `AGENTS.md`. Both files are equivalent for non-Claude agents.
- [`SECURITY.md`](SECURITY.md) — protected assets, threat model, secret policy
  and recovery boundaries.
- [`docs/product-requirements.md`](docs/product-requirements.md) — product brief:
  users, goals, non-goals and quality attributes.
- [`docs/testing.md`](docs/testing.md) — test layers, CI contract and live-check
  boundaries.
- [`docs/operational-modules.md`](docs/operational-modules.md) — canonical module
  map and ownership table.

## Development setup

This repo is operated from a control machine (macOS/Linux) and targets an ASUS
Asuswrt-Merlin router plus a small VPS. Local-only checks do not require router,
VPS or Vault access.

Prerequisites:

- Node.js 22. Run `nvm use` if you use nvm; `.nvmrc` pins the local version to
  the same major version used in GitHub Actions.
- Python 3.x for Ansible-related tooling.
- POSIX shell. Control-machine scripts may use Bash; router-side scripts must
  remain compatible with BusyBox `ash` unless a file clearly opts into Bash.
- `ripgrep` (`rg`) for static checks.
- Optional: `pre-commit` for local hooks.

Recommended local setup:

```bash
nvm use
npm --prefix modules/ghostroute-console/app ci
cp .env.example secrets/router.env   # then fill placeholders locally only
```

`secrets/router.env`, `.env.local`, generated client artifacts and Console data
are gitignored. Do not commit real endpoints, ports, users, keys, UUIDs, VLESS
URIs, QR payloads, provider details or device names.

## Verification

Use the narrowest check that proves the change. See [`docs/testing.md`](docs/testing.md)
for the full matrix.

Local-only repo checks:

```bash
./modules/secrets-management/bin/secret-scan
./tests/run-fast.sh
./tests/run-smoke.sh   # Console smoke tests via Playwright
bash -n verify.sh tests/run-all.sh tests/run-fast.sh
```

Console-specific checks:

```bash
npm --prefix modules/ghostroute-console/app test
npm --prefix modules/ghostroute-console/app run build
npm --prefix modules/ghostroute-console/app run test:e2e:gui
npm --prefix modules/ghostroute-console/app run test:perf
```

Ansible syntax checks for touched surfaces:

```bash
cd ansible
ansible-playbook --syntax-check playbooks/20-stealth-router.yml
ansible-playbook --syntax-check playbooks/21-channel-b-router.yml
ansible-playbook --syntax-check playbooks/22-channel-c-router.yml
ansible-playbook --syntax-check playbooks/24-channel-d-router.yml
ansible-playbook --syntax-check playbooks/99-verify.yml
```

Live checks (`./verify.sh --verbose`, `99-verify.yml`, health reports, traffic
reports and deploy gates) require real operator infrastructure. They are
read-only unless the command documentation says otherwise, but they are not
public CI requirements.

## Documentation conventions

- `README.md` is the developer-facing ground truth. `README-ru.md` is the
  localized operator-facing summary; if EN and RU drift, EN wins.
- Use language tags for non-EN-primary docs: `[RU primary]` at the top of any
  operator-Russian doc, plus a cross-link to its English entry point if one
  exists.
- Internal links use repo-root paths from root docs and depth-correct relative
  paths from nested module docs so they render both on GitHub and in local
  previews.
- Module-owned deep dives live in `modules/<module>/docs/`. Cross-cutting docs
  live in `docs/`.
- Planning documents must say when they are planning or draft material. Do not
  imply future work is already implemented.
- Sensitive values must use placeholders only: `<router_lan_ip>`,
  `<home-reality-port>`, `<console-host>`, `<console-port>`, `example.invalid`,
  or documentation-only IPs. Never paste real endpoints, ports, UUIDs, Reality
  keys, short IDs, admin paths, QR payloads or VLESS URIs.

## Commit conventions

- **Format**: prefer Conventional Commits going forward — `<type>(<scope>):
  <imperative subject>`. Example: `fix(console): resolve traffic facts via
  client registry`. Existing history uses plain imperative English without
  prefixes; do not rewrite it.
- **Allowed types**: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`,
  `perf`, `build`, `ci`. Use a `scope` for module-bounded changes such as
  `console`, `routing-core`, `traffic-observatory`, `health-monitor`,
  `dns-catalog`, `recovery`, `secrets`, `client-profiles`, `ansible` or `docs`.
- **Subject line**: imperative, ≤72 chars, no trailing period.
- **Body**: explain *why*, not just *what*. Reference ADRs, runbooks or
  `AGENTS.md` sections for non-obvious decisions.
- **Co-authorship**: when an AI agent meaningfully contributed, include a
  `Co-Authored-By: <Agent name> <noreply@…>` trailer. Otherwise omit it. Do not
  retroactively add or remove these.
- **Safety tags**: before any potentially breaking migration (router data plane,
  channel ownership, secrets layout), create a tag of the form
  `pre-<event>-<YYYY-MM-DD>` so the prior state is recoverable.

## Pull requests

Keep PRs small and module-scoped. A good PR body answers:

- **Summary**: what changed and why.
- **Scope**: modules/files affected; explicitly call out anything that touches
  router data plane, sing-box, dnsmasq, iptables, Reality, VPS or
  `traffic-observatory` contracts.
- **Test plan**: checks run locally, checks skipped intentionally and why.
- **Risk**: rollback plan, blast radius, irreversible steps and whether a safety
  tag is needed.
- **Secrets**: confirm no real endpoints, credentials, QR payloads, UUIDs or
  generated artifacts are included.

All PRs should pass the GitHub Actions `CI` workflow (`tests/run-fast.sh` plus
`tests/run-smoke.sh`). The heavier Console performance suite runs only on manual
`workflow_dispatch` unless the PR specifically needs that proof.

## Pre-commit hooks

`.pre-commit-config.yaml` runs:

- `ghostroute-secret-scan` — `./modules/secrets-management/bin/secret-scan`
  catches real endpoints, UUIDs, keys, ports, public IPs and admin paths before
  they reach a commit.
- `ghostroute-shell-syntax` — `./tests/check-shell-syntax.sh` validates shell
  scripts for Bash or BusyBox `sh` parsing based on each file's shebang.

Install once:

```bash
pre-commit install
pre-commit run --all-files
```

Do not skip hooks (`--no-verify`) unless the operator explicitly authorizes it
for an emergency commit.

## Safety boundaries

These rules are restated in `AGENTS.md` and apply to human and AI contributors:

- Never run `git commit`, `git push`, `./deploy.sh`, mutating Ansible playbooks
  (`00-*`, `10-*`, `11-*`, `20-*`, `21-*`, `22-*`,
  `30-generate-client-profiles.yml`) or any router/VPS-mutating SSH/SCP/rsync
  command without explicit operator permission.
- Never reintroduce `VPN_DOMAINS`, `RC_VPN_ROUTE`, `0x1000`, active `wgs1` or
  active `wgc1` as production state.
- Never deploy if relevant local checks have not passed; if checks were
  intentionally skipped, say so and ask before deploying.
- Never disable hooks (`--no-verify`, `--no-gpg-sign`) without explicit operator
  authorization.

## Where to put new findings

- A specific bug or regression: open a focused PR or issue.
- A long-term improvement: add to
  [`docs/future-improvements-backlog.md`](docs/future-improvements-backlog.md)
  with an appropriate phase marker (`✓ done` / `◐ in progress` / `○ deferred`).
- A repo-wide review: write a snapshot under `docs/repo-review-YYYY-MM-DD.md`
  and link it from `docs/README.md`.

## Reporting security issues

This is a personal operations repo. For sensitive findings, do not open a public
issue. Share only sanitized evidence with placeholders. See [`SECURITY.md`](SECURITY.md)
for the full policy.
