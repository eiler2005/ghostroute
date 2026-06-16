# Product Requirements Brief

GhostRoute is a personal, single-operator routing platform for an ASUS Merlin
edge router and a VPS-managed Reality egress. This document frames the existing
system as a product: who it serves, what it must guarantee, what it deliberately
does not try to do, and which engineering constraints matter for future changes.

It is intentionally a brief, not a marketing roadmap. Runtime behavior is still
defined by the architecture docs, ADRs, module READMEs and tests.

## Problem

A home network can contain many devices that should not each need a VPN app,
manual proxy profile, or per-device debugging. At the same time, selected mobile
clients need a home-first entry point and selected destinations need managed
Reality egress through an active VPS backend.

The hard parts are not only packet routing. The operator also needs safe deploys,
clear recovery boundaries, read-only observability, explicit secret handling and
a public repository that explains the architecture without leaking production
state.

## Users

| User | Need | Constraint |
|---|---|---|
| Primary operator | Run and debug the routing platform from a control machine. | Must not leak real endpoints, ports, keys, UUIDs, QR payloads or provider details. |
| Home LAN / Wi-Fi devices | Use ordinary apps without installing VPN clients. | Routing policy must live on the router and avoid broad accidental capture. |
| Selected remote clients | Enter through the home endpoint first, then follow managed split policy. | Generated client artifacts are credentials and stay outside git. |
| Reviewer / hiring manager | Understand the architecture, safety model and engineering maturity quickly. | Public docs must distinguish implemented behavior from plans and local operator notes. |

## Goals

1. **Home-first managed routing.** Keep the first hop for selected clients at the
   home endpoint, while selected managed destinations use the active Reality
   egress and non-managed traffic can remain direct.
2. **Module-native operations.** Keep routing, health, traffic, catalog,
   client-profile, secrets, Console and recovery ownership separated.
3. **Read-only observability by default.** Reports, health snapshots and Console
   read models explain runtime state without becoming hidden deploy mechanisms.
4. **Explicit safety boundaries.** Preserve no-auto-failover channel semantics,
   manual cold fallback, deploy gates and recoverable rollback paths.
5. **Public-safe documentation.** Explain enough architecture to be auditable
   while using placeholders for every sensitive deployment-specific value.

## Non-goals

- Public VPN service, multi-tenant access, billing or user management.
- Automatic B/C/D failover into Channel A or automatic WireGuard recovery.
- Public disclosure of real infrastructure, provider mapping, listener values,
  device identities, QR payloads, UUIDs or credentials.
- High-availability guarantees beyond the single-operator, home-WAN and VPS
  assumptions documented in `docs/operational-slos.md`.
- Console-driven router/VPS runtime mutation. The Console is a read-only evidence
  surface except for documented, audited operator-state overlays.

## Current capabilities

| Capability | Current status | Primary references |
|---|---|---|
| Channel A router data plane | Production | `README.md`, `docs/architecture.md`, `modules/routing-core/docs/` |
| Channel A selected full-VPS override | Implemented for selected LAN/Wi-Fi devices and Home Reality profiles | `docs/channel-a-selected-full-vps.md`, ADR-0010 |
| Channel B home-first selected-client lane | Production for selected profiles | `docs/channels.md`, Ansible `21-*` playbook docs |
| Channel C compatibility lane | C1-Shadowrocket live-proven; native sing-box Naive blocked by client support | `docs/channel-c.md`, ADR-0008 |
| Channel D NaiveProxy lab | Experimental, disabled by default | `docs/channel-d.md`, `playbooks/24-channel-d-router.yml` |
| Channel M MAX service egress | Dedicated service lane, not client failover | `docs/channel-m-environment.md` |
| Health / traffic / catalog observability | Implemented as read-only modules and reports | `docs/operational-modules.md`, module docs |
| GhostRoute Console | Read-only prepared-data workbench with desktop and mobile routes | `modules/ghostroute-console/README.md` |
| Secrets management | Vault and gitignored generated artifacts with repo-specific scanning | `SECURITY.md`, `modules/secrets-management/docs/secrets-management.md` |

## Functional requirements

### Routing policy

- Preserve the managed split: `STEALTH_DOMAINS` and `VPN_STATIC_NETS` are the
  public names for the managed domain and static CIDR catalogs.
- Keep Channel A/B/C/D ownership isolated. A selected-client lane must not
  silently mutate Channel A REDIRECT, router DNS, TUN state or recovery hooks.
- Keep Channel M separate from managed client routing. It exists for MAX service
  egress through the home WAN and never uses `reality-out`.
- Keep legacy WireGuard as explicit cold fallback only.

### Operations

- Every mutating path must have a documented pre-check and post-check.
- Read-only checks must be runnable without generated client profiles whenever
  possible.
- Live checks that require router/VPS access must remain explicit operator steps,
  not hidden CI requirements.
- Rollback instructions must name the smallest affected component: router data
  plane, selected-client channel, VPS edge, DNS/catalog, Console or cold fallback.

### Observability

- Machine contracts should prefer JSON facts and prepared read models over ad-hoc
  parsing of human reports.
- Console request paths should read bounded prepared data, not scan large raw
  snapshots on every page render.
- Health, traffic and catalog reports must remain safe for LLM handoff only after
  redaction and placeholder rules are satisfied.

### Security and privacy

- Real production values live in Ansible Vault or gitignored local files only.
- Public docs and examples must use placeholders such as `<router_lan_ip>`,
  `<home-reality-port>`, `<console-host>`, `example.invalid` or RFC 5737-style
  documentation IPs when an example must look concrete.
- Generated client profiles, QR images, VLESS URIs, keys and local reports are
  credentials or private evidence and must not be committed.

## Quality attributes

| Attribute | Requirement | Evidence |
|---|---|---|
| Maintainability | Changes stay module-scoped and preserve documented ownership. | `AGENTS.md`, `CONTRIBUTING.md`, module READMEs. |
| Testability | Repo-only checks cover syntax, static routing invariants, fixtures, Console smoke and secret hygiene. | `docs/testing.md`, `.github/workflows/ci.yml`. |
| Recoverability | Manual rollback paths and cold fallback are explicit. | `docs/deployment-and-rollback.md`, `SECURITY.md`. |
| Auditability | Architecture decisions are recorded as ADRs; planning docs are marked as non-runtime direction. | `docs/adr/`, `docs/README.md`. |
| Public safety | Docs describe roles and placeholders, not real endpoints or provider mapping. | `SECURITY.md`, secret scan. |

## Success metrics

These are repository and operator-quality metrics rather than SaaS business
metrics:

- `./tests/run-fast.sh` passes for repo-only changes.
- GitHub Actions `CI` passes on pull requests.
- `./modules/secrets-management/bin/secret-scan` reports clean before push.
- `./verify.sh` and `ansible/playbooks/99-verify.yml` pass when live targets are
  intentionally checked by the operator.
- Console performance and post-deploy checks stay within the targets documented
  in module runbooks.
- Public documentation can answer: what the system does, what it does not do,
  how it is tested, how it fails, how it recovers and where secrets live.

## Future direction

The backlog lives in `docs/future-improvements-backlog.md`. Planning documents
under `docs/` are design direction unless they explicitly state that a feature is
implemented. New work should promote a backlog item into an ADR or module doc
only when the behavior is concrete, tested and safe to describe publicly.
