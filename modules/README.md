# GhostRoute Modules

This directory is the physical implementation map for GhostRoute's operational
modules. Public command names stay stable through wrappers in `scripts/`, while
deploy and Ansible copy the real router/VPS implementations from these module
directories.

| Module | Implementation focus |
|---|---|
| `routing-core` | Production router data plane hooks and rule-set refresh. |
| `ghostroute-health-monitor` | Router/VPS health monitor and merged health reports. |
| `traffic-observatory` | Traffic counters, snapshots and usage reports. |
| `dns-catalog-intelligence` | Domain discovery, DNS forensics and catalog review. |
| `performance-diagnostics` | Performance troubleshooting knowledge and checks. |
| `reality-sni-rotation` | Reality cover SNI validation and rotation workflow. |
| `client-profile-factory` | QR/VLESS profile generation from Vault. |
| `secrets-management` | Vault bootstrap and repository secret hygiene. |
| `recovery-verification` | Verification, runbooks and manual fallback tools. |
| `shared` | Internal helper libraries used by several modules. |

The high-level navigation table lives in
`docs/operational-modules.md`; module README files describe local contracts and
implementation boundaries.
