# GhostRoute Platform Docs

`docs/` contains repository-wide documentation: platform architecture,
operator onboarding, the module index, cross-module troubleshooting and future
planning.

Module-owned deep dives live next to their implementation under
`modules/<module>/docs/`. This keeps each module self-contained while leaving
`docs/` as the stable top-level navigation layer.

Public presentation docs are English-first: `README.md`, ADRs and security
docs should be readable without local context. Russian operator notes may stay
where they capture day-to-day maintenance details, especially when they are
local runbooks or historical planning notes.

## Start Here

- [product-requirements.md](product-requirements.md) - product brief: users, goals, non-goals, requirements and success metrics.
- [operational-modules.md](operational-modules.md) - canonical module map and ownership table.
- [architecture.md](architecture.md) - high-level GhostRoute architecture.
- [router-runtime-map.md](router-runtime-map.md) - sanitized map of what is installed on the ASUS Merlin router, with diagrams and runtime guardrails.
- [praefectus-ai/docs/vps-runtime-map.md](https://github.com/eiler2005/praefectus-ai/blob/main/docs/vps-runtime-map.md) - companion VPS-side runtime map for Channel M, Console and routing/app surfaces.
- [channels.md](channels.md) - compact handoff view of Channel A, B, C and D.
- [routing-policy-principles.md](routing-policy-principles.md) - compact routing decision contract across endpoints, channels, router and egress.
- [dns-policy.md](dns-policy.md) - DNS leak and fingerprint policy for Channel A/B/C proofs.
- [channel-c.md](channel-c.md) - detailed Channel C C1 native Naive and Shadowrocket compatibility status.
- [SECURITY.md](../SECURITY.md) - threat model, protected assets, non-goals and security workflow.
- [testing.md](testing.md) - test layers, CI contract, local verification and live-check boundaries.
- [deployment-and-rollback.md](deployment-and-rollback.md) - pre-deploy checklist, rollback triggers and recovery paths.
- [operational-slos.md](operational-slos.md) - availability, correctness, privacy and recovery targets.
- [ansible/README.md](../ansible/README.md) - deployment, Vault, profile generation and verification control plane.
- [getting-started.md](getting-started.md) - first deploy and local setup workflow.
- [troubleshooting.md](troubleshooting.md) - cross-module incident diagnostics.

## Module Docs

- [modules/routing-core/docs/](../modules/routing-core/docs/) - routing data plane, Channel A and Reality flow.
- [modules/ghostroute-health-monitor/docs/](../modules/ghostroute-health-monitor/docs/) - health monitor implementation and runbook.
- [modules/traffic-observatory/docs/](../modules/traffic-observatory/docs/) - traffic reporting and LLM handoff.
- [modules/ghostroute-console/docs/](../modules/ghostroute-console/docs/) - Console read-only GUI, monitoring semantics, operator runbook, database schema and API contracts.
- [modules/dns-catalog-intelligence/docs/](../modules/dns-catalog-intelligence/docs/) - domain discovery and catalog curation.
- [modules/performance-diagnostics/docs/](../modules/performance-diagnostics/docs/) - performance troubleshooting.
- [modules/reality-sni-rotation/docs/](../modules/reality-sni-rotation/docs/) - Reality SNI validation and rotation.
- [modules/client-profile-factory/docs/](../modules/client-profile-factory/docs/) - QR/VLESS profile workflow.
- [modules/secrets-management/docs/](../modules/secrets-management/docs/) - vault, local secrets and scans.
- [modules/secrets-management/docs/vault-offsite-backup.md](../modules/secrets-management/docs/vault-offsite-backup.md) - encrypted offsite Vault backup and restore drill.
- [modules/recovery-verification/docs/](../modules/recovery-verification/docs/) - failure modes and recovery procedures.

## Planning & Future Direction

These documents describe roadmap, draft, and not-yet-implemented work. They are
**not** a description of current runtime state — each carries a status note at the
top. Use them for direction and design intent, not for "what the system does
today."

- [future-improvements-backlog.md](future-improvements-backlog.md) - non-runtime roadmap and improvement ideas (`[RU primary]`).
- [managed-egress-failover-roadmap.md](managed-egress-failover-roadmap.md) - future semi-auto backup VPS egress; manual reserve mode is implemented, semi-automatic failover is a future phase.
- [ghostroute-console-post-mvp-roadmap.md](ghostroute-console-post-mvp-roadmap.md) - Console post-MVP priorities and broader backlog split.
- [traffic-facts-v3-and-pyramid-plan.md](traffic-facts-v3-and-pyramid-plan.md) - traffic-facts v3 machine-contract and Console pyramid refactor plan.
- [traffic-intelligence-layer-plan.md](traffic-intelligence-layer-plan.md) - traffic intelligence layer design on top of the v3 pipeline.
- [managed-domain-app-family-draft.md](managed-domain-app-family-draft.md) - draft app-family catalog over the active managed domains.

## Review Snapshots

- [repo-review-2026-06-16.md](repo-review-2026-06-16.md) - public-repo polish review after the latest docs/schema/API commits.
- [repo-review-2026-05-10.md](repo-review-2026-05-10.md) - previous repository quality audit and prioritized fixlist.
