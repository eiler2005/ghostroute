# GhostRoute Architecture Improvement Roadmap

This document turns the architecture review in
`docs/architecture-review-2026-04-26.md` into an implementation roadmap.
It is intentionally more selective than the review: the goal is to improve
architecture, security visibility and maintainability without changing
production routing behavior.

## Executive Summary

GhostRoute already has the right operational shape: module-native code,
reserved common scripts, local runtime artifacts, vault-backed secrets and a
read-only monitoring layer. The next improvement slice should make those
decisions easier to audit and harder to accidentally regress.

The highest-value work is:

- make security claims machine-checkable;
- document load-bearing architecture decisions as ADRs;
- add minimal Ansible role contracts;
- expand module tests where coverage is thin;
- defer broad idempotency rewrites until they can be done role by role.

## Accepted Findings

| Finding | Importance | Decision |
| --- | --- | --- |
| Security claims need a machine-readable audit path | Critical | Implement a read-only audit command in Recovery & Verification. |
| Major architecture decisions are buried in long guides | High | Add ADRs for stable decisions. |
| Ansible roles lack visible contracts | High | Add minimal `defaults/main.yml` and `meta/main.yml` for every role. |
| Module coverage is uneven | Medium | Add focused tests for uncovered modules over time. |
| Project hygiene can improve | Medium | Add CI/lint/project files in later small slices, not all at once. |

## Already Covered Or Downgraded Findings

| Review item | Status | Why |
| --- | --- | --- |
| UDP/443 DROP may be missing | Already covered | The routing template installs DROP rules, Ansible verify checks them, `verify.sh` checks them, and health common checks them. |
| Channel A decommission guide may be lost | Downgraded | The old execution guide should not be restored verbatim. The durable need is a concise cold-fallback ADR/policy. |
| Full reusable Galaxy-grade Ansible roles | Deferred | These roles are project roles for ASUS Merlin/VPS operations, not generic Galaxy roles. |
| Full idempotency rewrite | Deferred | Merlin/BusyBox/NVRAM/`cru` work often needs raw commands; broad rewrites are higher risk than incremental role-level cleanup. |
| Mermaid diagrams everywhere | Deferred | Diagrams are useful, but secondary to audited invariants and ADRs. |

## Roadmap

### P0 — Security Claims And Drift Control

Importance: Critical.

- Keep `UDP/443 DROP` as a verified invariant.
- Add `modules/recovery-verification/bin/audit-fixes` for repo/static checks.
- Add Channel A cold-fallback ADR.
- Keep all checks read-only by default.

### P1 — Repo Engineering Hygiene

Importance: High.

- Add minimal Ansible `defaults/main.yml` and `meta/main.yml` to every role.
- Keep vault/group_vars ownership explicit; do not put fake secrets in defaults.
- Start extracting hardcoded paths only in later targeted role refactors.
- Treat future CI as static-only: no router/VPS deploy, no production secrets.

### P2 — Architecture Documentation

Importance: High / Medium.

- Maintain `docs/adr/` as the canonical decision log.
- Add compact diagrams only where they clarify the current production shape.
- Add Public API / Runtime Contract sections to module READMEs later.

### P3 — Module Test Coverage

Importance: Medium.

- Add golden tests for Client Profile Factory.
- Add syntax/smoke tests for Routing Core router hooks.
- Add vault/secret hygiene tests for Secrets Management.
- Keep cross-module smoke tests in `tests/`.

## What We Do Not Implement Now

### Full Ansible Idempotency Rewrite

Importance: Medium, but risky now.

The review is right that many `raw:` commands and `changed_when: false`
statements deserve attention. We do not rewrite them wholesale because Merlin
router operations use BusyBox, NVRAM, `cru`, shell hooks and firewall state that
do not map cleanly to ordinary Ansible modules. Cleanup should happen one role
at a time with live verification.

### Makefile As Main Interface

Importance: Medium.

A Makefile can be helpful later, but the public repo interface is now
module-native. Adding a Makefile should be a convenience layer, not a new
contract that hides module ownership.

### CHANGELOG / CONTRIBUTING / SECURITY.md

Importance: Medium.

These files improve public project polish. They are useful after the security
audit and ADR layer exists, but they do not directly improve routing safety.

### Automated Architecture Review

Importance: Low for now.

Automation is useful only after the invariant set is stable. Otherwise it risks
repeating false positives instead of preventing regressions.

### SBOM

Importance: Low.

GhostRoute is mostly shell, Ansible and documentation. SBOM work can wait until
dependency surfaces become larger.

### Module Renames

Importance: Low.

The current module names are clear enough. Renaming would create link churn with
little operational benefit.

## What Not To Change

- Do not change router/VPS runtime paths.
- Do not change ports, cron cadence or routing behavior.
- Do not add external alerts to v1 health monitoring.
- Do not store real endpoints, UUIDs, ports, keys or VLESS URIs in tracked docs.
- Do not turn `scripts/` back into a module-command alias layer.
- Do not automatically enable Channel A fallback.

## Acceptance Criteria

- Architecture decisions are captured as short ADRs.
- `audit-fixes` provides a fast read-only answer for key repo-level security claims.
- Ansible roles have minimum visible contracts.
- Existing tests stay green.
- Secret scanning stays green.
- Production behavior is unchanged.

## Source Review

The detailed review remains available at
`docs/architecture-review-2026-04-26.md`. This roadmap is the implementation
filter for that review, not a replacement for it.
