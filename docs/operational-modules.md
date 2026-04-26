# GhostRoute Operational Modules

This document is the canonical module map for the repository. It is a
navigation layer only: current top-level directories and public commands stay
stable, and generated reports remain local or on router/VPS runtime storage.

## Module Map

| Module | Purpose | Primary commands | Main docs | Storage / artifacts | Mode |
|---|---|---|---|---|---|
| Routing Core | Production split-routing data plane: DNS classification, ipsets, sing-box REDIRECT, home Reality ingress, Reality egress and direct fallback. | `deploy.sh`, `ansible-playbook playbooks/20-stealth-router.yml`, `ansible-playbook playbooks/10-stealth-vps.yml` | `architecture.md`, `network-flow-and-observer-model.md`, `stealth-channel-implementation-guide.md`, `channel-routing-operations.md` | router `/jffs`, `/opt/etc/sing-box`, VPS `/opt/stealth` | Mutating only during explicit deploy |
| GhostRoute Health Monitor | Read-only health checks for router + VPS with local status, summaries, digests and alert ledgers. | `/jffs/scripts/health-monitor/run-once`, `scripts/ghostroute-health-report`, `scripts/router-health-report` | `stealth-monitoring-implementation-guide.md`, `stealth-monitor-runbook.md`, `troubleshooting.md` | router `health-monitor/`, VPS `/var/log/ghostroute/health-monitor`, local `reports/` | Read-only diagnostics |
| Traffic Observatory | WAN/LAN/Wi-Fi/Home Reality usage, QR-client activity, destination popularity and routing mistake checks. | `scripts/traffic-report`, `scripts/traffic-daily-report`, traffic snapshot cron scripts | `traffic-observability.md`, `llm-traffic-runbook.md` | router traffic counters, local report output | Read-only diagnostics |
| DNS & Catalog Intelligence | DNS lookup observation, domain discovery, managed catalog review and local domain journal. | `scripts/domain-auto-add.sh`, `scripts/domain-report`, `scripts/catalog-review-report`, `scripts/update-singbox-rule-sets.sh` | `domain-management.md`, `x3mrouting-roadmap.md`, `stealth-domains-curation-audit.md`, `ai-tooling-domains.md` | `configs/dnsmasq-stealth.conf.add`, `configs/static-networks.txt`, local `docs/vpn-domain-journal.md`, local `reports/` | Discovery can update router auto catalog; repo changes are manual |
| Performance Diagnostics Toolkit | Latency, retransmits, TCP tuning, MSS clamp, keepalive and LTE/Home Reality performance troubleshooting. | `verify.sh`, `scripts/router-health-report`, targeted router diagnostics from docs | `routing-performance-troubleshooting.md`, `traffic-observability.md`, `stealth-monitor-runbook.md` | health reports, router counters, local notes | Read-only diagnostics unless operator applies a fix |
| Reality SNI Rotation Guide | Validate, rotate, document and roll back Reality cover SNI choices. | documented Ansible/vault workflow; no standalone command | `sni-rotation-candidates.md`, `secrets-management.md`, `stealth-channel-implementation-guide.md` | Ansible Vault, generated client artifacts | Mutating only with explicit operator approval |
| Client Profile Factory | Generate, view and clean QR/VLESS profiles for router identity, home-mobile clients and emergency profiles. | `scripts/client-profiles`, `ansible-playbook playbooks/30-generate-client-profiles.yml` | `client-profiles.md`, `getting-started.md`, `secrets-management.md` | `ansible/out/clients*` gitignored artifacts | Local artifact generation; credentials stay outside git |
| Secrets Management | Vault templates, local secret storage, generated artifact isolation and pre-push hygiene. | `scripts/init-stealth-vault.sh`, `scripts/secret-scan`, `ansible-vault edit` | `secrets-management.md` | `secrets/`, `ansible/secrets/`, `configs/private/`, `docs/private/`, `reports/` | Local/private; never public tracked output |
| Recovery & Verification Toolkit | Live verification, invariant checks, incident recovery and cold fallback procedures. | `verify.sh`, `ansible-playbook playbooks/99-verify.yml`, `scripts/emergency-enable-wgc1.sh` | `failure-modes.md`, `troubleshooting.md`, `stealth-monitor-runbook.md`, `channel-routing-operations.md` | verification output, router runtime state | Read-only by default; fallback scripts mutate only with explicit operator action |

## Operating Rules

- Do not physically move scripts into module folders in this phase.
- Do not rename existing commands; they are treated as stable local interfaces.
- Generated latest reports belong in local `reports/` or router/VPS runtime
  storage, not in tracked public docs.
- `docs/vpn-domain-journal.md` is a local gitignored STEALTH/Reality catalog
  journal. It may be updated by local reports, but raw journal entries should
  not be committed.
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
