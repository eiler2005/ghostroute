# GhostRoute — Product Requirements Document (PRD)

> Product framing for an infrastructure project. It states the problem, the
> user, goals and non-goals, requirements, the decisions behind the design, how
> success is measured, and the main risks. Implementation detail lives in
> [`architecture.md`](architecture.md), [`channels.md`](channels.md) and the
> ADRs under [`adr/`](adr/); this document is the "why".

## 1. Problem

Hundreds of users across restrictive-network environments want reliable,
low-friction access to a curated set of foreign internet services — without
installing VPN apps on every device in the household, and without moving routing
intelligence to endpoints where it is fragile and inconsistent.

Off-the-shelf options force a trade-off: per-device VPN apps (high friction,
inconsistent policy), or a kernel VPN tunnel on the router (unstable on consumer
firmware, hard to recover, all-or-nothing routing). Neither gives
**destination-aware** routing that keeps domestic and trusted traffic direct
while only managed destinations take a censorship-resistant egress. GhostRoute
solves this at the **network edge** — one router deployment covers every device
on the LAN with zero client configuration.

## 2. Target user

- **Primary:** technically capable users (households, small teams, remote-work
  setups) running a compatible edge router who want reliable, policy-driven
  access to managed foreign services for everyone on their network — with no
  per-device setup.
- **Secondary:** mobile/remote clients belonging to those users who need a
  home-first ingress that reuses the same managed routing policy as the LAN.
- **Deployer:** the network operator (sysadmin, power-user, or self-hoster) who
  installs and maintains the platform; the non-technical end-users on the LAN
  benefit automatically.

## 3. Goals

- **G1 — App-free home LAN.** Home Wi-Fi/LAN devices get destination-aware
  routing with no client software: managed destinations take the managed egress,
  everything else stays direct.
- **G2 — Router-owned policy.** The managed-vs-direct decision lives on the
  router (DNS classification + ipsets + sing-box), so policy is consistent
  regardless of client.
- **G3 — Home-first remote ingress.** Selected remote clients connect to the
  home endpoint first (so the first network sees home traffic, not the VPS),
  then reuse the same router policy.
- **G4 — Resilient managed egress.** The active foreign egress can be switched
  between an owned primary VPS, an owned clone, and a reserve backend without
  changing client profiles or the routing contract.
- **G5 — Recoverable & observable.** Reboot-safe runtime, read-only health and
  traffic visibility, and explicit recovery paths.
- **G6 — Safe to operate.** Secrets never enter git; tooling is read-only by
  default and never prints real endpoints.

## 4. Non-goals

- Not a hosted SaaS or cloud-managed service; the platform runs on the user's
  own hardware and VPS.
- Not a general-purpose VPN; managed-vs-direct is curated, not "tunnel
  everything" (except explicit opt-in full-VPS device sets).
- No automatic, unattended failover that could flap; egress switchover is an
  explicit, latched operator action.
- No reintroduction of kernel VPN interfaces (legacy WireGuard is cold-fallback
  only — see [`adr/0004-deprecated-wireguard-cold-fallback.md`](adr/0004-deprecated-wireguard-cold-fallback.md)).
- No endpoint-owned routing policy as the source of truth.

## 5. Requirements

### Functional

- **F1** Destination classification on the router (`dnsmasq` + `ipset`) driving a
  managed/direct split; managed catalog is `STEALTH_DOMAINS` + `VPN_STATIC_NETS`.
- **F2** Stable router-side `sing-box` TCP REDIRECT (not kernel TUN) for the LAN
  data plane.
- **F3** Home Reality ingress for remote clients; optional Channel B (XHTTP) and
  Channel C (Naive) home-first lanes; an experimental Channel D NaiveProxy lane.
- **F4** A stable `reality-out` egress contract with an operator-selectable
  backend (`primary_vps` / `backup_reality` / `hermes_vps`) and an independent
  Channel D selector (`reality-out-d`) for canarying a backend.
- **F5** Local generation of client QR/VLESS profiles from Vault.
- **F6** Read-only health, traffic-accounting, and catalog reporting.

### Non-functional

- **N1 — Security/privacy:** secrets in Vault only; `secret-scan` gate; role-only,
  sanitized tooling output; placeholders in all tracked docs.
- **N2 — Reliability:** reboot-safe services + watchdogs; deterministic
  deploy/verify; explicit rollback per channel.
- **N3 — Maintainability:** module-native ownership with per-module tests; ADRs
  for non-obvious decisions; shared instructions for human + agent contributors.
- **N4 — Testability:** behavior covered by static contract checks and
  mock-driven fixtures that run offline in CI.
- **N5 — Portability of policy:** switching egress backends must not change
  client profiles, ingress ports, or managed catalogs.

## 6. Key decisions (with ADRs)

- Router-side REDIRECT over kernel TUN for stability — see
  [`architecture.md`](architecture.md).
- Reality/Vision egress (VLESS) over WireGuard/OpenVPN for the managed path —
  [`adr/0004-deprecated-wireguard-cold-fallback.md`](adr/0004-deprecated-wireguard-cold-fallback.md),
  [`adr/0006-channel-terminology-and-manual-fallbacks.md`](adr/0006-channel-terminology-and-manual-fallbacks.md).
- Module-native repository layout —
  [`adr/0001-module-native-repo.md`](adr/0001-module-native-repo.md).
- Secrets outside git —
  [`adr/0005-secrets-outside-git.md`](adr/0005-secrets-outside-git.md).
- Local-only health alerts —
  [`adr/0003-local-only-health-alerts.md`](adr/0003-local-only-health-alerts.md).
- DNS via a dnscrypt-backed forwarder —
  [`adr/0009-managed-dns-dnscrypt-backed-forwarder.md`](adr/0009-managed-dns-dnscrypt-backed-forwarder.md).
- Stable `reality-out` contract with selectable backends —
  [`managed-egress-failover-roadmap.md`](managed-egress-failover-roadmap.md).

## 7. Success metrics

Measured operationally (see [`operational-slos.md`](operational-slos.md)); SLOs
are the source of truth, summarized here:

- Managed destinations resolve and egress through the active backend (verified by
  the live application canaries in `egress-backend-health` / `live-check`).
- Domestic/trusted and non-managed traffic stays direct (no unintended VPS exit).
- An egress backend switch completes without changing any client profile.
- Reboot recovery restores the data plane without manual intervention.
- No secret ever reaches git (the `secret-scan` gate stays green).

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| DPI/path filtering of the managed egress | Multiple owned/reserve backends behind one contract; canary via Channel D before switching production. |
| Consumer firmware instability after reboot | Reboot-safe init + watchdogs; recovery-verification module. |
| Secret leakage in a public repo | Vault-only secrets, `secret-scan` CI gate, role-only sanitized tooling, gitignored `docs/private/`. |
| Deployer bus factor | ADRs, runtime maps, recovery runbooks, and reproducible local checks that any competent operator can follow. |
| Egress flapping from auto-failover | Switchover is explicit and latched, never automatic. |

## 9. Out of scope / future

Tracked in [`future-improvements-backlog.md`](future-improvements-backlog.md)
and the module roadmaps. This PRD is intentionally stable; incident snapshots and
one-off plans live in local/operator notes, not here.
