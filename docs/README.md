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

- [operational-modules.md](/docs/operational-modules.md) - canonical module map and ownership table.
- [architecture.md](/docs/architecture.md) - high-level GhostRoute architecture.
- [channels.md](/docs/channels.md) - compact handoff view of Channel A, B and C.
- [dns-policy.md](/docs/dns-policy.md) - DNS leak and fingerprint policy for Channel A/B/C proofs.
- [channel-c.md](/docs/channel-c.md) - detailed Channel C C1 native Naive and Shadowrocket compatibility status.
- [managed-egress-failover-roadmap.md](/docs/managed-egress-failover-roadmap.md) - future semi-auto backup VPS egress roadmap.
- [ghostroute-console-post-mvp-roadmap.md](/docs/ghostroute-console-post-mvp-roadmap.md) - Console post-MVP priorities and broader backlog split.
- [SECURITY.md](/SECURITY.md) - threat model, protected assets, non-goals and security workflow.
- [ansible/README.md](/ansible/README.md) - deployment, Vault, profile generation and verification control plane.
- [getting-started.md](/docs/getting-started.md) - first deploy and local setup workflow.
- [troubleshooting.md](/docs/troubleshooting.md) - cross-module incident diagnostics.
- [future-improvements-backlog.md](/docs/future-improvements-backlog.md) - non-runtime roadmap and improvement ideas.

## Module Docs

- [modules/routing-core/docs/](/modules/routing-core/docs/) - routing data plane, Channel A and Reality flow.
- [modules/ghostroute-health-monitor/docs/](/modules/ghostroute-health-monitor/docs/) - health monitor implementation and runbook.
- [modules/traffic-observatory/docs/](/modules/traffic-observatory/docs/) - traffic reporting and LLM handoff.
- [modules/dns-catalog-intelligence/docs/](/modules/dns-catalog-intelligence/docs/) - domain discovery and catalog curation.
- [modules/performance-diagnostics/docs/](/modules/performance-diagnostics/docs/) - performance troubleshooting.
- [modules/reality-sni-rotation/docs/](/modules/reality-sni-rotation/docs/) - Reality SNI validation and rotation.
- [modules/client-profile-factory/docs/](/modules/client-profile-factory/docs/) - QR/VLESS profile workflow.
- [modules/secrets-management/docs/](/modules/secrets-management/docs/) - vault, local secrets and scans.
- [modules/secrets-management/docs/vault-offsite-backup.md](/modules/secrets-management/docs/vault-offsite-backup.md) - encrypted offsite Vault backup and restore drill.
- [modules/recovery-verification/docs/](/modules/recovery-verification/docs/) - failure modes and recovery procedures.
