# GhostRoute Operational Modules

This document is the canonical module map for the repository. The physical
implementations and module-owned public commands live under `modules/`.
Repository-wide platform entrypoints remain visible at the root (`deploy.sh`,
`verify.sh`). The top-level `scripts/` directory is reserved for future
cross-repo utilities that do not have a clear module owner. Generated reports
remain local or on router/VPS runtime storage.

## Module Map

| Module | Purpose | Implementation | Public commands | Runtime / deploy target | Main docs | Tests | Mode |
|---|---|---|---|---|---|---|---|
| Routing Core | Production split-routing data plane: DNS classification, ipsets, sing-box REDIRECT, home Reality ingress, Reality egress and direct fallback. | `modules/routing-core` | `./deploy.sh`, `./modules/routing-core/router/update-singbox-rule-sets.sh` | router `/jffs/scripts/*`, `/opt/etc/sing-box/rule-sets` | `architecture.md`, `modules/routing-core/docs/network-flow-and-observer-model.md`, `modules/routing-core/docs/stealth-channel-implementation-guide.md`, `modules/routing-core/docs/channel-routing-operations.md` | `./verify.sh`, router health fixtures | Mutating only during explicit deploy |
| GhostRoute Health Monitor | Read-only health checks for router + VPS with local status, summaries, digests and alert ledgers. | `modules/ghostroute-health-monitor` | `./modules/ghostroute-health-monitor/bin/router-health-report`, `./modules/ghostroute-health-monitor/bin/ghostroute-health-report`, `/jffs/scripts/health-monitor/run-once` | router `health-monitor/`, VPS `/var/log/ghostroute/health-monitor`, local `reports/` | `modules/ghostroute-health-monitor/docs/stealth-monitoring-implementation-guide.md`, `modules/ghostroute-health-monitor/docs/stealth-monitor-runbook.md`, `troubleshooting.md` | `./modules/ghostroute-health-monitor/tests/test-health-monitor.sh`, `./modules/ghostroute-health-monitor/tests/test-vps-health-monitor.sh` | Read-only diagnostics |
| Traffic Observatory | WAN/LAN/Wi-Fi/Home Reality usage, QR-client activity, destination popularity and routing mistake checks. | `modules/traffic-observatory` | `./modules/traffic-observatory/bin/traffic-report`, `./modules/traffic-observatory/bin/traffic-daily-report` | router traffic counters, local report output | `modules/traffic-observatory/docs/traffic-observability.md`, `modules/traffic-observatory/docs/llm-traffic-runbook.md` | traffic fixtures via health/report tests | Read-only diagnostics |
| DNS & Catalog Intelligence | DNS lookup observation, domain discovery, managed catalog review and local domain journal. | `modules/dns-catalog-intelligence` | `./modules/dns-catalog-intelligence/bin/domain-report`, `./modules/dns-catalog-intelligence/bin/catalog-review-report`, `./modules/dns-catalog-intelligence/bin/dns-forensics-report` | router auto catalog, local `docs/vpn-domain-journal.md`, local `reports/` | `modules/dns-catalog-intelligence/docs/domain-management.md`, `modules/dns-catalog-intelligence/docs/x3mrouting-roadmap.md`, `modules/dns-catalog-intelligence/docs/stealth-domains-curation-audit.md`, `modules/dns-catalog-intelligence/docs/ai-tooling-domains.md` | `./modules/dns-catalog-intelligence/tests/test-catalog-review.sh`, `./modules/dns-catalog-intelligence/tests/test-dns-forensics.sh` | Discovery can update router auto catalog; repo changes are manual |
| Performance Diagnostics Toolkit | Latency, retransmits, TCP tuning, MSS clamp, keepalive and LTE/Home Reality troubleshooting. | `modules/performance-diagnostics` | `./verify.sh`, `./modules/ghostroute-health-monitor/bin/router-health-report`, documented diagnostics | health reports, router counters, local notes | `modules/performance-diagnostics/docs/routing-performance-troubleshooting.md`, `modules/traffic-observatory/docs/traffic-observability.md`, `modules/ghostroute-health-monitor/docs/stealth-monitor-runbook.md` | health baseline fixtures, live verify | Read-only diagnostics unless operator applies a fix |
| Reality SNI Rotation Guide | Validate, rotate, document and roll back Reality cover SNI choices. | `modules/reality-sni-rotation` | documented Ansible/Vault workflow | Ansible Vault, generated client artifacts | `modules/reality-sni-rotation/docs/sni-rotation-candidates.md`, `modules/secrets-management/docs/secrets-management.md`, `modules/routing-core/docs/stealth-channel-implementation-guide.md` | Ansible syntax + post-rotation verify | Mutating only with explicit operator approval |
| Client Profile Factory | Generate, view and clean QR/VLESS profiles for router identity, home-mobile clients and emergency profiles. | `modules/client-profile-factory` | `./modules/client-profile-factory/bin/client-profiles`, `ansible-playbook playbooks/30-generate-client-profiles.yml` | `ansible/out/clients*` gitignored artifacts | `modules/client-profile-factory/docs/client-profiles.md`, `getting-started.md`, `modules/secrets-management/docs/secrets-management.md` | syntax + secret hygiene checks | Local artifact generation; credentials stay outside git |
| Secrets Management | Vault templates, local secret storage, generated artifact isolation and pre-push hygiene. | `modules/secrets-management` | `./modules/secrets-management/bin/init-stealth-vault.sh`, `./modules/secrets-management/bin/secret-scan`, `ansible-vault edit` | `secrets/`, `ansible/secrets/`, `configs/private/`, `docs/private/`, `reports/` | `modules/secrets-management/docs/secrets-management.md` | `./modules/secrets-management/bin/secret-scan` | Local/private; never public tracked output |
| Recovery & Verification Toolkit | Live verification, invariant checks, repo/static architecture audits, incident recovery and cold fallback procedures. | `modules/recovery-verification` | `./verify.sh`, `./modules/recovery-verification/bin/verify.sh`, `./modules/recovery-verification/bin/audit-fixes`, `ansible-playbook playbooks/99-verify.yml` | verification output, router runtime state, `/jffs/scripts/emergency-enable-wgc1.sh` | `modules/recovery-verification/docs/failure-modes.md`, `docs/architecture-improvement-roadmap-2026-04-26.md`, `docs/adr/`, `troubleshooting.md`, `modules/ghostroute-health-monitor/docs/stealth-monitor-runbook.md`, `modules/routing-core/docs/channel-routing-operations.md` | `./modules/recovery-verification/tests/test-router-health.sh`, `./modules/recovery-verification/tests/test-audit-fixes.sh` | Read-only by default; fallback scripts mutate only with explicit operator action |

## Operating Rules

- Module-owned commands live in `modules/<module>/bin`, router runtime scripts
  in `modules/<module>/router`, VPS runtime scripts in `modules/<module>/vps`,
  shared helpers in `modules/shared/lib`, and module-owned deep dives in
  `modules/<module>/docs`.
- Root `deploy.sh` and `verify.sh` are platform entrypoints, not module-owned
  commands. Keep them at the repository root for operator visibility.
- `scripts/` is reserved for common repo utilities without a clear module
  owner. It is not a place for module shortcuts.
- Install router/VPS runtime implementations from `modules/`; remote runtime
  paths such as `/jffs/scripts/*` remain stable.
- Generated latest reports belong in local `reports/` or router/VPS runtime
  storage, not in tracked public docs.
- `docs/vpn-domain-journal.md` is a local gitignored STEALTH/Reality catalog
  journal. It may be updated by local reports, but raw journal entries should
  not be committed.
- Global `README.md` and `README-ru.md` are protected surfaces: update them
  only with small additive notes, not structural rewrites.
- Public docs should describe stable behavior, interfaces and recovery paths;
  incident snapshots and one-off execution plans should stay local or be
  summarized into stable docs.

## Quick Navigation

| Need | Start here |
|---|---|
| Understand current traffic flow | `modules/routing-core/docs/network-flow-and-observer-model.md` |
| Check whether the setup is healthy | `modules/ghostroute-health-monitor/docs/stealth-monitor-runbook.md` |
| Read traffic usage and QR-client activity | `modules/traffic-observatory/docs/traffic-observability.md` |
| Add or review managed domains | `modules/dns-catalog-intelligence/docs/domain-management.md` |
| Investigate slow clients | `modules/performance-diagnostics/docs/routing-performance-troubleshooting.md` |
| Rotate Reality SNI | `modules/reality-sni-rotation/docs/sni-rotation-candidates.md` |
| Generate QR profiles | `modules/client-profile-factory/docs/client-profiles.md` |
| Prepare or audit secrets | `modules/secrets-management/docs/secrets-management.md` |
| Recover from incidents | `modules/recovery-verification/docs/failure-modes.md` and `troubleshooting.md` |
| Review architecture improvement priorities | `docs/architecture-improvement-roadmap-2026-04-26.md` and `docs/adr/` |
