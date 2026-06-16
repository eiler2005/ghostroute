# Testing Strategy

GhostRoute is infrastructure: most behavior lives in shell, Ansible templates,
router runtime hooks and a Node/SQLite Console. The test strategy is built so the
**contract** of each layer can be verified **offline, deterministically, and in
CI**, without touching a live router or VPS.

## Test pyramid

```text
            Playwright Console e2e        (browser, slow)        run-console
                  ^
            Console smoke + node unit      (headless, medium)    run-smoke
                  ^
            Mock / fixture integration      (offline, fast)      run-fast (subset)
                  ^
            Static contract checks          (offline, fastest)   run-fast
```

- **Static contract checks** — assert that rendered Ansible templates, router
  scripts, catalogs and docs keep their invariants (e.g. the managed split routes
  to `reality-out`, ports stay sanitized in docs, no legacy WireGuard state
  reappears). Pure `grep`/`rg` over tracked files; no network. Examples:
  [`tests/test-channel-a-deploy-static.sh`](../tests/test-channel-a-deploy-static.sh),
  [`tests/test-managed-split-parity-static.sh`](../tests/test-managed-split-parity-static.sh),
  [`tests/test-docs-port-sanitization.sh`](../tests/test-docs-port-sanitization.sh).
- **Mock / fixture integration** — drive a tool end-to-end against **stubbed**
  external binaries and fixtures so real logic runs without a live target. The
  canonical example stubs `ssh`, `ansible-vault`, `curl`, `ncat` and `openssl` to
  exercise the egress health tool:
  [`modules/ghostroute-health-monitor/tests/test-egress-backend-health.sh`](../modules/ghostroute-health-monitor/tests/test-egress-backend-health.sh).
  Traffic accounting is verified against recorded fixtures, e.g.
  [`tests/test-traffic-evidence-v3.sh`](../tests/test-traffic-evidence-v3.sh).
- **Console smoke + unit** — Node unit tests and a headless smoke run for the
  read-only Console.
- **Playwright e2e** — browser coverage of Console pages against a seeded local
  GUI database.

## Runners

| Runner | Scope | Network | Used by |
|---|---|---|---|
| [`tests/check-shell-syntax.sh`](../tests/check-shell-syntax.sh) | `bash -n` / `sh -n` across scripts | none | local, CI |
| [`tests/run-fast.sh`](../tests/run-fast.sh) | static + fixture suites + Console fast tests | none | **CI (every push/PR)** |
| [`tests/run-smoke.sh`](../tests/run-smoke.sh) | Console smoke (Playwright Chromium) | local browser | **CI** |
| [`tests/run-all.sh`](../tests/run-all.sh) | full suite (slower, broader) | none | local pre-merge |
| [`tests/run-console.sh`](../tests/run-console.sh) | Console unit + e2e | local browser | local |
| [`tests/run-performance.sh`](../tests/run-performance.sh) | performance-diagnostics checks | none | local |

Module-owned tests live next to their module under
`modules/<module>/tests/` and are invoked by the runners above.

## What is intentionally NOT unit-tested here

Live behavior that requires a real router/VPS — actual Reality handshakes, live
DNS, real egress reachability — is validated by **read-only operator checks**, not
CI: `./verify.sh`, `ansible-playbook playbooks/99-verify.yml`,
`./modules/ghostroute-health-monitor/bin/live-check`, and
`./modules/ghostroute-health-monitor/bin/egress-backend-health`. These connect to
real targets and are run by the operator, deliberately outside CI.

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs two jobs on every
push and pull request:

1. **Repo checks** — installs Node + `ripgrep`, then runs `./tests/run-fast.sh`.
2. **Console smoke** — installs Playwright Chromium and runs `./tests/run-smoke.sh`,
   uploading traces on failure.

The `secret-scan` gate
([`modules/secrets-management/bin/secret-scan`](../modules/secrets-management/bin/secret-scan))
also runs as part of the fast checks so no secret can merge.

## Running locally

```bash
./tests/check-shell-syntax.sh          # shell syntax
./tests/run-fast.sh                    # the CI fast gate (offline)
./tests/run-all.sh                     # full offline suite before a PR
./modules/secrets-management/bin/secret-scan
cd ansible && ansible-playbook --syntax-check playbooks/99-verify.yml && cd ..

# Console (Node) work:
cd modules/ghostroute-console/app
npm run dev:gui          # seeded local GUI for visual review
npm run test:e2e:gui     # browser coverage
```

## Conventions for new tests

- Prefer the **narrowest** check that proves the change (a static contract test
  over a broad suite).
- New behavior that calls an external binary should ship a **stubbed** fixture
  test (see the egress-backend-health example) so it runs offline.
- Keep router scripts BusyBox `ash`-compatible; keep tests `bash`/`rg`-portable.
- Register new suites in the appropriate runner so CI picks them up.
