# GhostRoute

### Router-level Reality routing for ASUS Merlin: home ingress for mobile clients, Reality egress to VPS

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Router-ASUS%20Asuswrt--Merlin-blue)](https://github.com/RMerl/asuswrt-merlin.ng)
[![Routing](https://img.shields.io/badge/Routing-VLESS%2BReality-5B5FC7)]()
[![Status](https://img.shields.io/badge/Status-Active-brightgreen)]()

**[Русская версия / Russian version ->](README-ru.md)**

---

## Overview

GhostRoute lets an ASUS Merlin router decide which domains and IP networks should leave through a stealth Reality channel, while ordinary home devices stay configuration-free.

The channel model separates three responsibilities:

- Channel A is the router-managed home lane:
  `sing-box REDIRECT :<lan-redirect-port> -> VLESS+Reality+Vision -> VPS/Xray`.
- Remote mobile QR/VLESS clients connect to the home ASUS first:
  `iPhone/Mac -> home public IP :<home-reality-port> -> sing-box home Reality inbound`.
  The router then applies the same managed split: `STEALTH_DOMAINS`/`VPN_STATIC_NETS`
  leave through VPS Reality, while non-managed destinations leave through the home WAN.
- Channel B is a non-production, manual live-tested device-client lane:
  device client -> `VLESS+XHTTP+TLS` -> separate Xray backend on the VPS.
- Channel C is the future camouflage-oriented manual lane:
  device client -> NaiveProxy / HTTPS forward-proxy style hostname on the VPS.

Only Channel A is part of the active router data plane. Channel B is live-tested
as a manual selected-device lane on the VPS, while Channel C remains a planned
manual compatibility lane; neither may change router REDIRECT, TUN, DNS, local
ports, or automatic failover.

Legacy WireGuard (`wgs1` + `wgc1`) is decommissioned in normal operation.
`wgc1_*` NVRAM remains only as a cold fallback.

If the router reports WAN `carrier=0` or "network cable unplugged", that is a
physical/provider WAN-link incident. It is not evidence that Channel A,
Caddy/VPS, or the Reality/Vision data plane is broken.

---

## Key Features

- Domain-based routing with `dnsmasq` + `ipset`.
- Single active domain catalog for home LAN (`STEALTH_DOMAINS`).
- Shared static CIDR catalog for direct-IP services via `VPN_STATIC_NETS`.
- Channel A VLESS+Reality+Vision egress through a VPS host behind shared Caddy L4 on TCP/443.
- Channel B manual live-tested lane: VLESS+XHTTP+TLS for selected device-client
  tests on a separate public hostname sharing the VPS `:443`.
- Channel C design lane: NaiveProxy / HTTPS forward proxy for camouflage
  experiments on a separate public hostname sharing the VPS `:443`.
- Router-side VLESS+Reality ingress on TCP/<home-reality-port> for remote mobile clients, so LTE carriers see the home Russian IP instead of the VPS IP.
- Stable router-side `sing-box` TCP REDIRECT instead of unstable Merlin TUN routing.
- Automatic domain discovery that writes `STEALTH_DOMAINS` only.
- Local QR/VLESS profile generation from Ansible Vault.
- Health, traffic and catalog reports suitable for humans and LLM handoff.
- Local GhostRoute health monitor with router-side `STATUS_OK` / `STATUS_FAIL`,
  `summary-latest.md`, and internal alert ledgers on router storage.

---

## Operational Modules

GhostRoute is organized as a small operational platform around the routing
core, not just a set of firewall scripts:

- **Routing Core** — the production data plane: dnsmasq/ipset classification,
  sing-box REDIRECT and home Reality ingress, managed Reality egress to VPS,
  direct-out fallback for non-managed traffic, and WireGuard cold fallback.
- **GhostRoute Health Monitor** — a read-only reliability module for the
  router + VPS setup. It produces local `STATUS_OK` / `STATUS_FAIL` sentinels,
  `status.json`, Markdown summaries, daily digests and disk-based alert
  ledgers without changing production routing state.
- **Traffic Observatory** — usage and routing reports for WAN, LAN/Wi-Fi,
  Home Reality QR clients, popular destinations and split-routing mistakes.
  It is designed for day-to-day inspection and safe LLM handoff with redacted
  device labels by default.
- **DNS & Catalog Intelligence** — DNS lookup observation, domain discovery
  and managed-catalog maintenance. It helps identify which domains a service
  uses, keeps manual and auto-discovered rules separated, and feeds
  `STEALTH_DOMAINS` / `VPN_STATIC_NETS` without requiring VPN apps on home
  devices.
- **Performance Diagnostics Toolkit** — checks and documentation for latency,
  retransmits, TCP tuning, MSS clamp, keepalive behavior and LTE/Home Reality
  performance symptoms, so speed issues can be diagnosed separately from
  routing correctness.
- **SNI Rotation Guide for Reality** - operational guidance for validating,
  rotating and documenting Reality cover SNI choices, including client behavior,
  regional reachability and rollback considerations.
- **Client Profile Factory** — local generation and cleanup of QR/VLESS
  profiles from Ansible Vault, including separate router, home-mobile,
  emergency, Channel B and Channel C artifact flows. Generated credentials stay
  outside git.
- **Secrets Management** — Ansible Vault templates, local secret storage rules,
  generated-artifact isolation and a repo-specific `secret-scan` for catching
  real URIs, UUIDs, keys, public endpoints and production literals before push.
- **Recovery & Verification Toolkit** — `verify.sh`, Ansible verification,
  incident runbooks and explicit cold-fallback scripts for controlled manual
  recovery when Reality, VPS, DNS or routing invariants drift.

Together these modules make the repo auditable: routing, health, traffic,
performance and recovery procedures are documented as separate operational
surfaces with clear read-only diagnostics and explicit manual recovery steps.
See the full module map in
[docs/operational-modules.md](/docs/operational-modules.md).

---

## Architecture At A Glance

```text
                         Control machine
                deploy.sh / Ansible / reports / vault
                              |
                              v
Home Wi-Fi/LAN ---- DNS ----> ASUS Merlin router <---- Reality QR ---- iPhone/Mac
 devices          lookup      dnsmasq + ipset          :<home-reality-port>
                              |
                              +-- managed match
                              |     STEALTH_DOMAINS / VPN_STATIC_NETS
                              |     -> sing-box REDIRECT / reality-in
                              |     -> VLESS+Reality outbound
                              |     -> VPS Caddy L4 -> Xray -> Internet
                              |
                              +-- non-managed match
                                    -> direct-out -> home WAN -> Internet

Future manual device-client lanes:
  Channel B -> Device client -> XHTTP hostname :443
            -> Caddy TLS -> local Xray XHTTP -> Internet
  Channel C -> Device client -> Naive/HTTPS hostname :443
            -> Caddy forward_proxy / compatible backend -> Internet

Operational layer:
  Routing Core        -> dnsmasq/ipset/sing-box/Reality split
  Health Monitor      -> STATUS_OK/FAIL, summaries, local alerts
  Traffic Observatory -> WAN/LAN/Home Reality usage and routing checks
  DNS Intelligence    -> lookup evidence, domain discovery, catalog review
  Performance Toolkit -> RTT/retransmit/TCP/MSS diagnostics
  SNI Rotation Guide  -> Reality cover validation, rotation, rollback
  Client Profiles     -> QR/VLESS and manual Channel B/C artifacts from Vault
  Secrets Management  -> vault, generated artifacts, secret-scan
  Recovery Toolkit    -> verify.sh, Ansible verify, runbooks, cold fallback
```

---

## How It Works

### 1. Home Wi-Fi / LAN Devices

```text
Home Wi-Fi / LAN devices
      |
      +-- DNS query
      |     |
      |     v
      |  dnsmasq
      |  +-- managed domain -> STEALTH_DOMAINS
      |  +-- static network -> VPN_STATIC_NETS
      |  +-- other domain   -> normal DNS path
      |
      +-- TCP connection to matched IP
            |
            v
      ASUS Router / Merlin
      +-- nat REDIRECT :<lan-redirect-port>
      +-- sing-box redirect inbound
      +-- VLESS+Reality TCP/443
            |
            v
      VPS host
      +-- shared Caddy :443
      +-- Xray Reality inbound
            |
            v
      Internet
```

Home devices do not need VPN apps. The router sees DNS answers, fills `STEALTH_DOMAINS`, redirects matching TCP traffic into sing-box, and sends it through Reality. UDP/443 for managed destinations is silently dropped so apps fall back from QUIC to TCP.

### 2. Remote Mobile QR / VLESS Clients

```text
Remote iPhone/MacBook outside home
      |
      v
Client app imports generated QR profile
      |
      v
Home public IP :<home-reality-port>
      |
      v
ASUS Router / Merlin
+-- sing-box home Reality inbound
+-- managed destination
|     +-- STEALTH_DOMAINS / VPN_STATIC_NETS
|     +-- sing-box Reality outbound
|     +-- VPS host / Caddy / Xray
|     +-- Internet
+-- non-managed destination
      +-- sing-box direct outbound
      +-- home ISP WAN
      +-- Internet
```

Mobile carriers see the phone connecting to the home Russian IP. Managed
websites/checkers see the VPS exit IP. Non-managed websites see the home
Russian WAN IP.

Detailed workflow, ports, components and observer model:
[modules/routing-core/docs/network-flow-and-observer-model.md](/modules/routing-core/docs/network-flow-and-observer-model.md).

### 3. Cold Fallback

WireGuard is not active in steady state. The preserved `wgc1_*` NVRAM can be used only with `modules/recovery-verification/router/emergency-enable-wgc1.sh` during a catastrophic Reality outage.

### 4. Channel B/C Manual Profiles

Channel B and Channel C are manual device-client lanes with different design
goals. Channel B is the protocol-diverse fallback candidate: ordinary TLS on a
separate hostname, XHTTP transport, and a local-only Xray backend. Channel C is
the camouflage experiment: a separate hostname that behaves like an ordinary
authenticated HTTPS/Naive-style proxy surface.

The intended v1 model is manual testing on selected devices through separate
VPS hostnames on the same public `:443`: Channel B with VLESS+XHTTP+TLS,
Channel C with NaiveProxy or an HTTPS forward-proxy-compatible variant.

They do not install binaries on the router, do not add router SOCKS/HTTP
listeners, do not change REDIRECT/TUN/DNS, and do not provide automatic
failover. Channel B has a VPS-side live smoke pass as of 2026-04-27 using a
local Xray client container and generated `macbook-b` profile; iOS and Android
app import remain manual compatibility checks. Treat any generated
`ansible/out/clients-channel-b/` or `ansible/out/clients-channel-c/` artifacts
as non-production manual profiles.

---

## Technical Stack

```text
Router:
  ASUS RT-AX88U Pro + Asuswrt-Merlin
  dnsmasq + ipset + iptables
  sing-box REDIRECT inbound on :<lan-redirect-port>
  sing-box home Reality inbound on :<home-reality-port>
  dnscrypt-proxy on 127.0.0.1:<dnscrypt-port>
  Legacy WireGuard disabled; wgc1 NVRAM preserved for cold fallback

VPS:
  VPS Ubuntu host
  shared system Caddy with layer4 plugin on :443
  Xray/3x-ui Reality inbound on 127.0.0.1:<xray-local-port>
  manual live-tested Channel B Xray XHTTP on 127.0.0.1:<xhttp-local-port>
  future Channel C NaiveProxy / HTTPS forward-proxy scaffolding
  stealth stack under /opt/stealth

Control:
  deploy.sh for router base runtime files/catalogs
  Ansible for VPS, router stealth layer, verification and QR generation
  ansible-vault for real credentials and client parameters
```

---

## Project Structure

```text
configs/
  dnsmasq-stealth.conf.add        # STEALTH_DOMAINS for home LAN Channel A
  static-networks.txt             # shared CIDR catalog

ansible/
  README.md                       # Ansible control plane overview
  playbooks/10-stealth-vps.yml
  playbooks/11-channel-b-vps.yml
  playbooks/12-channel-c-vps.yml
  playbooks/20-stealth-router.yml
  playbooks/30-generate-client-profiles.yml
  playbooks/99-verify.yml
  secrets/stealth.yml             # ansible-vault, gitignored
  out/clients/                    # generated QR/profile artifacts, gitignored
  out/clients-home/               # generated home QR/profile artifacts, gitignored
  out/clients-emergency/          # generated emergency artifacts, gitignored
  out/clients-channel-b/          # generated Channel B artifacts, gitignored
  out/clients-channel-c/          # generated Channel C artifacts, gitignored

modules/
  routing-core/
  ghostroute-health-monitor/
  traffic-observatory/
  dns-catalog-intelligence/
  performance-diagnostics/
  reality-sni-rotation/
  client-profile-factory/
  secrets-management/
  recovery-verification/

scripts/
  README.md                       # reserved for future cross-repo utilities

docs/
  architecture.md
  operational-modules.md
  getting-started.md
  troubleshooting.md
  future-improvements-backlog.md
```

The detailed physical module map lives in
[docs/operational-modules.md](/docs/operational-modules.md). The global README
keeps the high-level workflow; module folders contain local implementation
overviews. The Ansible router/VPS deployment component map lives in
[ansible/README.md](/ansible/README.md).

---

## Quick Start

```bash
# Base router deploy: dnsmasq, firewall-start, nat-start, cron scripts
ROUTER=192.168.50.1 ./deploy.sh

# Channel A router layer: sing-box, dnscrypt-proxy, reboot-safe REDIRECT routing
cd ansible
ansible-playbook playbooks/20-stealth-router.yml

# Manual VPS device-client lanes (do not mutate router Channel A path)
ansible-playbook playbooks/11-channel-b-vps.yml
ansible-playbook playbooks/12-channel-c-vps.yml

# End-to-end verification: VPS + router
ansible-playbook playbooks/99-verify.yml
cd ..

# Local health snapshot
./verify.sh
./modules/ghostroute-health-monitor/bin/router-health-report
```

`20-stealth-router.yml` also installs the Channel A reboot hooks and catalog
scripts (`firewall-start`, `cron-save-ipset`, `domain-auto-add.sh`,
`update-blocked-list.sh`) so REDIRECT and the accumulated `STEALTH_DOMAINS`
state survive router reboots and Merlin firewall rebuilds.

Traffic and observability:

```bash
# Main usage report: exits, devices, Home Reality ingress clients,
# popular destinations and routing mistake checks.
./modules/traffic-observatory/bin/traffic-report today
./modules/traffic-observatory/bin/traffic-report yesterday
./modules/traffic-observatory/bin/traffic-report week
./modules/traffic-observatory/bin/traffic-report month

# Human/LLM-safe operational snapshot.
./modules/ghostroute-health-monitor/bin/router-health-report
```

The traffic report answers how much went through the VPS, how much
stayed on the home Russian WAN, which devices and Home Reality ingress clients
were active, and whether likely routing mistakes appeared. See
[modules/traffic-observatory/docs/traffic-observability.md](/modules/traffic-observatory/docs/traffic-observability.md).

Health monitor:

```bash
# Install/update with deploy.sh or ansible, then run a local router-side sample.
ssh admin@192.168.50.1 '/jffs/scripts/health-monitor/run-once'

# Primary storage on the router:
ssh admin@192.168.50.1 'cat /opt/var/log/router_configuration/health-monitor/summary-latest.md'
ssh admin@192.168.50.1 'cat /opt/var/log/router_configuration/health-monitor/alerts/$(date +%F).md'
ssh admin@192.168.50.1 'cat /opt/var/log/router_configuration/health-monitor/status.json'

# Unified router+VPS report from the control machine.
./modules/ghostroute-health-monitor/bin/ghostroute-health-report
./modules/ghostroute-health-monitor/bin/ghostroute-health-report --save
```

The health monitor is read-only for production routing state. It writes local
internal alerts and reports to router storage only. Primary path:
`/opt/var/log/router_configuration/health-monitor`; fallback:
`/jffs/addons/router_configuration/health-monitor`.
Scheduled collection runs hourly; use `/jffs/scripts/health-monitor/run-once`
for an immediate fresh snapshot.
The VPS observer keeps its own local-only status on the VPS under
`/var/log/ghostroute/health-monitor`. `ghostroute-health-report --save` stores
merged latest/history reports on the router under `health-monitor/global/` and
keeps 31 days of history.

How to read a router-side alert:

1. Check `STATUS_OK` / `STATUS_FAIL`.
2. Read `summary-latest.md`.
3. Read `alerts/<today>.md`.
4. Use `raw/<today>.jsonl` only for exact evidence.
5. After manual recovery, run `run-once` or wait for the next hourly cycle and
   confirm `STATUS_OK`; do not delete alert history.

Expected invariants:

- LAN TCP for `STEALTH_DOMAINS` and `VPN_STATIC_NETS` is redirected to `:<lan-redirect-port>`.
- LAN UDP/443 for those sets is silently dropped to force TCP fallback.
- Remote QR/VLESS clients connect to the home public IP on `:<home-reality-port>`, not directly to VPS.
- Router-side `sing-box` accepts `reality-in` on `0.0.0.0:<home-reality-port>`.
- Mobile managed destinations route to `reality-out`; mobile non-managed destinations route to `direct-out`.
- `STEALTH_DOMAINS` and `VPN_STATIC_NETS` exist.
- `VPN_DOMAINS`, `RC_VPN_ROUTE`, `0x1000`, active `wgs1` and active `wgc1` are absent.

---

## Client QR Profiles

Client profiles are generated locally from Ansible Vault:

```bash
./modules/client-profile-factory/bin/client-profiles generate
./modules/client-profile-factory/bin/client-profiles open
```

Generated files live under `ansible/out/clients/`, including `iphone-*.png`, `macbook.png`, matching `.conf` files and a local `qr-index.html` gallery.

The `router.conf` profile still targets the VPS directly because it is the router's outbound identity. `iphone-*` and `macbook` profiles target the home public IP first.

Never commit or paste real VLESS URIs, UUIDs, Reality keys, short IDs, admin paths or QR payloads into documentation. Use fake placeholders only.

See [modules/client-profile-factory/docs/client-profiles.md](/modules/client-profile-factory/docs/client-profiles.md) and [modules/secrets-management/docs/secrets-management.md](/modules/secrets-management/docs/secrets-management.md).

---

## Detailed Documentation

- [README-ru.md](README-ru.md) - main Russian documentation
- [ansible/README.md](/ansible/README.md) - deployment, Vault, profile generation and live verification control plane
- [docs/operational-modules.md](/docs/operational-modules.md) - canonical module map and operating surfaces
- [docs/archive/roadmaps/architecture-improvement-roadmap-2026-04-26.md](/docs/archive/roadmaps/architecture-improvement-roadmap-2026-04-26.md) - archived architecture/security improvement roadmap
- [docs/adr/](/docs/adr/) - concise architecture decision records
- [docs/architecture.md](/docs/architecture.md) - current routing architecture
- [modules/routing-core/docs/network-flow-and-observer-model.md](/modules/routing-core/docs/network-flow-and-observer-model.md) - detailed traffic flows and observer model
- [modules/traffic-observatory/docs/traffic-observability.md](/modules/traffic-observatory/docs/traffic-observability.md) - traffic reports, device/app popularity and routing mistake checks
- [modules/ghostroute-health-monitor/docs/stealth-monitoring-implementation-guide.md](/modules/ghostroute-health-monitor/docs/stealth-monitoring-implementation-guide.md) - GhostRoute health monitor implementation
- [modules/ghostroute-health-monitor/docs/stealth-monitor-runbook.md](/modules/ghostroute-health-monitor/docs/stealth-monitor-runbook.md) - health monitor alerts and recovery runbook
- [modules/performance-diagnostics/docs/routing-performance-troubleshooting.md](/modules/performance-diagnostics/docs/routing-performance-troubleshooting.md) - LTE/Home Reality performance diagnostics and fixes
- [modules/routing-core/docs/channel-routing-operations.md](/modules/routing-core/docs/channel-routing-operations.md) - day-2 operations and channel switching
- [modules/routing-core/docs/stealth-channel-implementation-guide.md](/modules/routing-core/docs/stealth-channel-implementation-guide.md) - implemented VLESS+Reality guide
- [modules/dns-catalog-intelligence/docs/domain-management.md](/modules/dns-catalog-intelligence/docs/domain-management.md) - domain and static-network catalog management
- [modules/dns-catalog-intelligence/docs/stealth-domains-curation-audit.md](/modules/dns-catalog-intelligence/docs/stealth-domains-curation-audit.md) - advisory STEALTH_DOMAINS curation review
- [modules/secrets-management/docs/secrets-management.md](/modules/secrets-management/docs/secrets-management.md) - vault, local secrets and pre-push scan
- [modules/client-profile-factory/docs/client-profiles.md](/modules/client-profile-factory/docs/client-profiles.md) - VLESS/Reality QR workflow
- [docs/troubleshooting.md](/docs/troubleshooting.md) - incident diagnostics

---

## License

[MIT](LICENSE) - Copyright (c) 2025 Denis Ermilov
