# Testing Strategy

GhostRoute tests are split by risk and by access boundary. Public CI proves the
repository contract without requiring a router, VPS, Vault password or generated
client artifacts. Live verification is deliberately separate and must be run only
by the operator when real targets are reachable.

## Test layers

| Layer | Scope | Requires live infrastructure | Primary command |
|---|---|---:|---|
| Secret hygiene | Tracked-file scan for endpoints, UUIDs, keys, ports, VLESS/QR-style payloads and production literals. | No | `./modules/secrets-management/bin/secret-scan` |
| Static/syntax checks | Shell syntax, BusyBox/router script compatibility, static routing invariants and module entrypoints. | No | `./tests/run-fast.sh` |
| Console unit/contract checks | Next.js/Node selectors, migrations, aggregate contracts and seeded GUI database behavior. | No | `npm --prefix modules/ghostroute-console/app test` |
| Console smoke | Build plus Playwright smoke over a seeded local GUI database. | No | `./tests/run-smoke.sh` |
| Console performance | Deterministic local Playwright performance budget on seeded data. | No | `npm --prefix modules/ghostroute-console/app run test:perf` |
| Ansible syntax | Playbook parse checks for the selected router/VPS surface. | No | `cd ansible && ansible-playbook --syntax-check playbooks/<playbook>.yml` |
| Live read-only verification | Router/VPS facts, channel invariants, health and traffic checks. | Yes | `./verify.sh`, `ansible-playbook playbooks/99-verify.yml` |
| Mutating deploy gate | Pre/post canary before runtime mutation. | Yes | `./modules/ghostroute-health-monitor/bin/live-check --active-probe --deploy-gate` |

## Recommended local flow

For documentation-only or small static changes:

```bash
./modules/secrets-management/bin/secret-scan
./tests/run-fast.sh
```

For Console UI, selector, database or API changes:

```bash
npm --prefix modules/ghostroute-console/app ci
npm --prefix modules/ghostroute-console/app test
npm --prefix modules/ghostroute-console/app run build
./tests/run-smoke.sh
```

For broad Console read-model or performance-sensitive changes:

```bash
npm --prefix modules/ghostroute-console/app run test:gui:all
```

For Ansible/router changes, add the smallest syntax set that matches the touched
surface:

```bash
cd ansible
ansible-playbook --syntax-check playbooks/20-stealth-router.yml
ansible-playbook --syntax-check playbooks/21-channel-b-router.yml
ansible-playbook --syntax-check playbooks/22-channel-c-router.yml
ansible-playbook --syntax-check playbooks/24-channel-d-router.yml
ansible-playbook --syntax-check playbooks/99-verify.yml
```

Do not run mutating playbooks as a test. Use syntax checks and read-only verify
first; deploy remains a separate operator decision.

## CI contract

`.github/workflows/ci.yml` runs two pull-request jobs by default:

1. **Repo checks** install Node/Python/ripgrep, install Console dependencies and
   run `./tests/run-fast.sh`.
2. **Console smoke** installs Console dependencies, installs Playwright Chromium
   and runs `./tests/run-smoke.sh`.

The Console performance job is manual (`workflow_dispatch`) so ordinary PRs do
not pay the heavier browser-performance cost unless the change needs it.

## What the tests protect

| Risk | Covered by |
|---|---|
| Secret or private deployment value committed to public repo | `secret-scan`, `.gitignore`, pre-commit hook |
| Router shell script no longer parses on the target shell | `tests/check-shell-syntax.sh`, `run-fast` |
| Channel B/C/D accidentally mutates Channel A ownership | Static channel tests, `AGENTS.md` invariants, `99-verify.yml` live checks |
| Legacy WireGuard or `RC_VPN_ROUTE` returns as production state | Static grep-style invariant tests and live verify |
| Console read model breaks accounting invariants | Console tests, aggregate verification, post-deploy checks |
| Console UI only works with live data | Seeded GUI database plus Playwright smoke/perf tests |
| Public docs expose real values | Secret scan plus documentation placeholder policy |

## Live checks

Live checks are intentionally not part of public CI. They may require the current
router access profile, Vault values, a reachable VPS and fresh operator network
state.

Read-only live sequence:

```bash
./verify.sh --verbose
cd ansible && ansible-playbook playbooks/99-verify.yml
cd ..
./modules/ghostroute-health-monitor/bin/router-health-report
./modules/traffic-observatory/bin/traffic-report check
./modules/traffic-observatory/bin/traffic-report today
```

Mutating deploys must follow `docs/deployment-and-rollback.md`. A green local or
CI suite does not authorize deployment by itself.

## Pre-commit hooks

`.pre-commit-config.yaml` provides two local hooks:

```bash
pre-commit install
pre-commit run --all-files
```

The hooks run the GhostRoute secret scan and shell syntax checks. Do not bypass
hooks for normal work; if an emergency requires bypassing, document why in the PR
or operator note.

## Evidence to include in PRs

A good PR test plan should say exactly what ran and what did not run. Example for
a docs-only PR:

```text
Tests:
- Not run: docs-only change; no runtime, Console or Ansible behavior changed.
- Recommended before merge: ./modules/secrets-management/bin/secret-scan
```

Example for a Console PR:

```text
Tests:
- npm --prefix modules/ghostroute-console/app test
- npm --prefix modules/ghostroute-console/app run build
- ./tests/run-smoke.sh
Not run:
- Live router/VPS verification; change is local Console read-model/UI only.
```
