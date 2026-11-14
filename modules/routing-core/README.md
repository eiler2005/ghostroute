# Routing Core Module Overview

## Purpose

Routing Core owns the production data plane: dnsmasq/ipset classification,
Merlin firewall hooks, sing-box REDIRECT, home Reality ingress, managed Reality
egress to the VPS and direct-out fallback for non-managed traffic.

## Features

- Builds and refreshes router-side hooks for NAT, firewall and service startup.
- Guards managed LAN TCP against direct forwarding when REDIRECT is missing;
  the same first FORWARD jump blocks managed UDP/443 while rules are refreshed.
- Persists the dynamic `STEALTH_DOMAINS` snapshot atomically, retaining the last
  valid file when `ipset save` fails or emits fewer entries than the live set.
- Maintains sing-box rule-set synchronization from the repo-managed catalogs.
- Provides opt-in Sensitive sites mode: a reviewed domain catalog selects
  `sensitive-out -> hermes_vps` before general managed routes, without automatic
  fallback to a different egress identity.
- Installs the runtime supervisor that owns router reboot recovery, watchdog cron
  registration, dependency-ordered listener recovery and delayed firewall
  stabilization.
- Installs the sing-box listener watchdog used to recover from process death or
  listener loss.
- Preserves legacy WireGuard only as a cold fallback path, not as steady-state
  routing.
- Provides the optional Channel Amn home-first lab: isolated AmneziaWG and
  `sing-box-amn` processes, with the existing sensitive/managed/direct policy.
  It starts manually and is not owned by production boot/watchdog recovery.
- Provides an isolated [AnyTLS compatibility lab](docs/channel-anytls-lab.md)
  with verified TLS, a projected selected-client policy and explicit rollback.

## How It Works

`deploy.sh` copies the router scripts from this module to the ASUS Merlin
runtime paths. Merlin then calls `/jffs/scripts/nat-start`,
`/jffs/scripts/firewall-start` and `/jffs/scripts/services-start`; those hooks
install the REDIRECT and counter behavior used by the rest of GhostRoute.
`services-start` is single-owner: it launches
`/jffs/scripts/ghostroute-runtime-supervisor.sh boot`, and the supervisor
registers crons, starts/checks components in dependency order, validates LAN
REDIRECT, the managed egress guard and UDP/443 DROP rules, then runs a delayed
post-boot firewall stabilization pass after Merlin chain rebuilds. The
[router flow diagram](../../docs/architecture.md#layer-2--home-router) shows
where the guard acts and which ingress paths have separate owners.
The [privacy and recovery checks](../../docs/privacy-assurance.md) describe
the live proof levels and classification limits.

## Architecture

- `router/` contains BusyBox-compatible router scripts.
- `deploy.sh` and Ansible install those scripts to stable `/jffs/scripts/*`
  runtime paths.
- sing-box rule-sets are generated under the configured router rule-set
  directory, currently `/opt/etc/sing-box/rule-sets`.
- `/jffs/scripts/singbox-watchdog.sh` runs from cron and checks the critical
  redirect, SOCKS, router DNS-forward and Home Reality listeners.
- `configs/runtime-inventory.yml` records Routing Core runtime ownership,
  compatibility notes and symbolic port/listener sources.

## Read-only / Mutating Contract

This module mutates routing only during explicit deploy, explicit rule-set
refresh, or explicit manual recovery. Health, traffic and DNS report modules may
inspect its state, but must not silently change routing.

## Public Commands

- `./deploy.sh`
- `./modules/routing-core/bin/managed-egress-mode`
- `./modules/routing-core/router/update-singbox-rule-sets.sh`
- Runtime-only router hooks under `/jffs/scripts/*`
- `bash modules/routing-core/bin/build-channel-amn` (local pinned lab build)
- `./modules/routing-core/bin/channel-amn-profile --export-eight ansible/out/channel-amn`
- `ansible-playbook playbooks/28-channel-amn-lab.yml` from `ansible/` (status;
  explicit `channel_amn_action=start|stop|sync-peers` mutates only the lab)

`managed-egress-mode status|set` is the local operator switch for the shared
Channel A/B/C managed upstream behind `reality-out`. It edits only the Vault
selector, saves an encrypted backup and can optionally deploy
`20-stealth-router.yml`; it does not regenerate client QR/VLESS artifacts.
`set <mode> --channel d` selects an independent Channel D backend behind
`reality-out-d` (default `follow` = same as A/B/C), deploying
`24-channel-d-router.yml`; this is the canary lane for validating a new owned
backend on Channel D before moving A/B/C. Channel M is never switched here.

## Runtime Storage & Artifacts

- `/jffs/scripts/firewall-start`
- `/jffs/scripts/nat-start`
- `/jffs/scripts/services-start`
- `/jffs/scripts/ghostroute-runtime-supervisor.sh`
- `/jffs/scripts/update-singbox-rule-sets.sh`
- `/jffs/scripts/singbox-watchdog.sh`
- `/opt/etc/sing-box/rule-sets`
- `/opt/tmp/singbox-watchdog.state`
- Optional Amn: `/opt/etc/ghostroute-amn/` on writable Entware USB;
  `/tmp/ghostroute-amn/` holds volatile PID/lock/log/ownership state.
- Amn keys, build output and eight named imports: ignored local
  `ansible/out/channel-amn/`; keep an encrypted private backup.

## Dependencies On Other Modules

- DNS & Catalog Intelligence provides domain/static network inputs.
- Traffic Observatory installs counters that are invoked from the firewall path.
- Recovery & Verification validates the routing invariants.

## Failure Modes

- Missing Merlin hook files.
- Rule-set drift between router runtime and repo catalogs.
- sing-box REDIRECT not receiving managed traffic.
- Merlin firewall rebuild after reboot removes LAN REDIRECT or the guard before
  `firewall-start` reinstalls them; the hook cannot protect packets sent before
  Merlin invokes it.
- sing-box process death after local rule-set hot reload; the watchdog should
  restart the service when critical listeners disappear.
- WireGuard cold fallback accidentally re-enabled.
- Amn is stopped by reboot and needs stop/start after firewall or policy
  changes. A missing Amn TUN must retain its terminal unreachable guard.

## Tests

- `./modules/recovery-verification/tests/test-router-health.sh`
- `./verify.sh`
- Ansible `playbooks/99-verify.yml`
- `bash tests/test-channel-amn.sh`
- `bash tests/test-channel-anytls.sh`

## Related Docs

- [Router-only managed egress profile rotation](docs/managed-egress-profile-rotation.md):
  TCP or gRPC with Reality, preserving client imports and isolated policy ownership.
- `modules/routing-core/docs/sensitive-sites-mode.md`
- [Channel Amn runbook](docs/channel-amn-research.md)
- Amn diagrams: [English](../../docs/assets/diagrams/channel-amn-architecture-en.html)
  / [Русский](../../docs/assets/diagrams/channel-amn-architecture.html)
- `docs/architecture.md`
- `modules/routing-core/docs/current-routing-explained.md`
- `modules/routing-core/docs/network-flow-and-observer-model.md`
- `modules/routing-core/docs/channel-routing-operations.md`
- `modules/routing-core/docs/stealth-channel-implementation-guide.md`
- `docs/runtime-inventory.md`
