# GhostRoute Modules

This directory is the canonical implementation map for GhostRoute. Module-owned
commands, router runtime scripts, VPS runtime scripts, tests and helper
libraries live here; the top-level `scripts/` directory is reserved only for
future cross-repo utilities that do not belong to a specific module.

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

The detailed navigation table lives in `docs/operational-modules.md`. Each
module README is a Module Overview: what the module owns, how it works, which
commands are public, which artifacts it writes, and which tests cover it.
