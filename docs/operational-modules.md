# GhostRoute Operational Modules

This document is the canonical module map for the repository. The physical
implementations and module-owned public commands live under `modules/`. The
top-level `scripts/` directory is reserved for future cross-repo utilities that
do not have a clear module owner. Generated reports remain local or on
router/VPS runtime storage.

## Module Map

| Module | Purpose | Implementation | Public commands | Runtime / deploy target | Main docs | Tests | Mode |
|---|---|---|---|---|---|---|---|
| Routing Core | Production split-routing data plane: DNS classification, ipsets, sing-box REDIRECT, home Reality ingress, Reality egress and direct fallback. | `modules/routing-core` | `./deploy.sh`, `./modules/routing-core/router/update-singbox-rule-sets.sh` | router `/jffs/scripts/*`, `/opt/etc/sing-box/rule-sets` | `architecture.md`, `network-flow-and-observer-model.md`, `stealth-channel-implementation-guide.md`, `channel-routing-operations.md` | `./verify.sh`, router health fixtures | Mutating only during explicit deploy |
| GhostRoute Health Monitor | Read-only health checks for router + VPS with local status, summaries, digests and alert ledgers. | `modules/ghostroute-health-monitor` | `./modules/ghostroute-health-monitor/bin/router-health-report`, `./modules/ghostroute-health-monitor/bin/ghostroute-health-report`, `/jffs/scripts/health-monitor/run-once` | router `health-monitor/`, VPS `/var/log/ghostroute/health-monitor`, local `reports/` | `stealth-monitoring-implementation-guide.md`, `stealth-monitor-runbook.md`, `troubleshooting.md` | `./modules/ghostroute-health-monitor/tests/test-health-monitor.sh`, `./modules/ghostroute-health-monitor/tests/test-vps-health-monitor.sh` | Read-only diagnostics |
| Traffic Observatory | WAN/LAN/Wi-Fi/Home Reality usage, QR-client activity, destination popularity and routing mistake checks. | `modules/traffic-observatory` | `./modules/traffic-observatory/bin/traffic-report`, `./modules/traffic-observatory/bin/traffic-daily-report` | router traffic counters, local report output | `traffic-observability.md`, `llm-traffic-runbook.md` | traffic fixtures via health/report tests | Read-only diagnostics |
| DNS & Catalog Intelligence | DNS lookup observation, domain discovery, managed catalog review and local domain journal. | `modules/dns-catalog-intelligence` | `./modules/dns-catalog-intelligence/bin/domain-report`, `./modules/dns-catalog-intelligence/bin/catalog-review-report`, `./modules/dns-catalog-intelligence/bin/dns-forensics-report` | router auto catalog, local `docs/vpn-domain-journal.md`, local `reports/` | `domain-management.md`, `x3mrouting-roadmap.md`, `stealth-domains-curation-audit.md`, `ai-tooling-domains.md` | `./modules/dns-catalog-intelligence/tests/test-catalog-review.sh`, `./modules/dns-catalog-intelligence/tests/test-dns-forensics.sh` | Discovery can update router auto catalog; repo changes are manual |
| Performance Diagnostics Toolkit | Latency, retransmits, TCP tuning, MSS clamp, keepalive and LTE/Home Reality troubleshooting. | `modules/performance-diagnostics` | `./verify.sh`, `./modules/ghostroute-health-monitor/bin/router-health-report`, documented diagnostics | health reports, router counters, local notes | `routing-performance-troubleshooting.md`, `traffic-observability.md`, `stealth-monitor-runbook.md` | health baseline fixtures, live verify | Read-only diagnostics unless operator applies a fix |
| Reality SNI Rotation Guide | Validate, rotate, document and roll back Reality cover SNI choices. | `modules/reality-sni-rotation` | documented Ansible/Vault workflow | Ansible Vault, generated client artifacts | `sni-rotation-candidates.md`, `secrets-management.md`, `stealth-channel-implementation-guide.md` | Ansible syntax + post-rotation verify | Mutating only with explicit operator approval |
| Client Profile Factory | Generate, view and clean QR/VLESS profiles for router identity, home-mobile clients and emergency profiles. | `modules/client-profile-factory` | `./modules/client-profile-factory/bin/client-profiles`, `ansible-playbook playbooks/30-generate-client-profiles.yml` | `ansible/out/clients*` gitignored artifacts | `client-profiles.md`, `getting-started.md`, `secrets-management.md` | syntax + secret hygiene checks | Local artifact generation; credentials stay outside git |
| Secrets Management | Vault templates, local secret storage, generated artifact isolation and pre-push hygiene. | `modules/secrets-management` | `./modules/secrets-management/bin/init-stealth-vault.sh`, `./modules/secrets-management/bin/secret-scan`, `ansible-vault edit` | `secrets/`, `ansible/secrets/`, `configs/private/`, `docs/private/`, `reports/` | `secrets-management.md` | `./modules/secrets-management/bin/secret-scan` | Local/private; never public tracked output |
| Recovery & Verification Toolkit | Live verification, invariant checks, incident recovery and cold fallback procedures. | `modules/recovery-verification` | `./verify.sh`, `./modules/recovery-verification/bin/verify.sh`, `ansible-playbook playbooks/99-verify.yml` | verification output, router runtime state, `/jffs/scripts/emergency-enable-wgc1.sh` | `failure-modes.md`, `troubleshooting.md`, `stealth-monitor-runbook.md`, `channel-routing-operations.md` | `./modules/recovery-verification/tests/test-router-health.sh` | Read-only by default; fallback scripts mutate only with explicit operator action |

## Operating Rules

- Module-owned commands live in `modules/<module>/bin`, router runtime scripts
  in `modules/<module>/router`, VPS runtime scripts in `modules/<module>/vps`,
  and shared helpers in `modules/shared/lib`.
- `scripts/` is reserved for common repo utilities without a clear module
  owner. It is not a place for module aliases.
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
| Understand current traffic flow | `network-flow-and-observer-model.md` |
| Check whether the setup is healthy | `stealth-monitor-runbook.md` |
| Read traffic usage and QR-client activity | `traffic-observability.md` |
| Add or review managed domains | `domain-management.md` |
| Investigate slow clients | `routing-performance-troubleshooting.md` |
| Rotate Reality SNI | `sni-rotation-candidates.md` |
| Generate QR profiles | `client-profiles.md` |
| Prepare or audit secrets | `secrets-management.md` |
| Recover from incidents | `failure-modes.md` and `troubleshooting.md` |
