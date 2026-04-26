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

The current production model has two active paths:

- Home Wi-Fi/LAN uses Channel B: `sing-box REDIRECT :<lan-redirect-port> -> VLESS+Reality -> VPS/Xray`.
- Remote mobile QR/VLESS clients connect to the home ASUS first:
  `iPhone/Mac -> home public IP :<home-reality-port> -> sing-box home Reality inbound`.
  The router then applies the same managed split: `STEALTH_DOMAINS`/`VPN_STATIC_NETS`
  leave through VPS Reality, while non-managed destinations leave through the home WAN.

Channel A (`wgs1` + `wgc1`) is decommissioned in normal operation. `wgc1_*` NVRAM remains only as a cold fallback.

---

## Key Features

- Domain-based routing with `dnsmasq` + `ipset`.
- Single active domain catalog for home LAN (`STEALTH_DOMAINS`).
- Shared static CIDR catalog for direct-IP services via `VPN_STATIC_NETS`.
- VLESS+Reality egress through a VPS host behind shared Caddy L4 on TCP/443.
- Router-side VLESS+Reality ingress on TCP/<home-reality-port> for remote mobile clients, so LTE carriers see the home Russian IP instead of the VPS IP.
- Stable router-side `sing-box` TCP REDIRECT instead of unstable Merlin TUN routing.
- Automatic domain discovery that writes `STEALTH_DOMAINS` only.
- Local QR/VLESS profile generation from Ansible Vault.
- Health, traffic and catalog reports suitable for humans and LLM handoff.
- Local GhostRoute health monitor with router-side `STATUS_OK` / `STATUS_FAIL`,
  `summary-latest.md`, and internal alert ledgers on router storage.

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
[docs/network-flow-and-observer-model.md](docs/network-flow-and-observer-model.md).

### 3. Cold Fallback

WireGuard is not active in steady state. The preserved `wgc1_*` NVRAM can be used only with `scripts/emergency-enable-wgc1.sh` during a catastrophic Reality outage.

---

## Technical Stack

```text
Router:
  ASUS RT-AX88U Pro + Asuswrt-Merlin
  dnsmasq + ipset + iptables
  sing-box REDIRECT inbound on :<lan-redirect-port>
  sing-box home Reality inbound on :<home-reality-port>
  dnscrypt-proxy on 127.0.0.1:<dnscrypt-port>
  WireGuard Channel A disabled; wgc1 NVRAM preserved for cold fallback

VPS:
  VPS Ubuntu host
  shared system Caddy with layer4 plugin on :443
  Xray/3x-ui Reality inbound on 127.0.0.1:<xray-local-port>
  stealth stack under /opt/stealth

Control:
  deploy.sh for router base scripts/catalogs
  Ansible for VPS, router stealth layer, verification and QR generation
  ansible-vault for real credentials and client parameters
```

---

## Project Structure

```text
configs/
  dnsmasq-stealth.conf.add        # STEALTH_DOMAINS for home LAN Channel B
  static-networks.txt             # shared CIDR catalog

ansible/
  playbooks/10-stealth-vps.yml
  playbooks/20-stealth-router.yml
  playbooks/30-generate-client-profiles.yml
  playbooks/99-verify.yml
  secrets/stealth.yml             # ansible-vault, gitignored
  out/clients/                    # generated QR/profile artifacts, gitignored

scripts/
  firewall-start
  nat-start
  domain-auto-add.sh
  client-profiles
  secret-scan
  router-health-report
  traffic-report

docs/
  architecture.md
  network-flow-and-observer-model.md
  channel-routing-operations.md
  stealth-channel-implementation-guide.md
  domain-management.md
  secrets-management.md
  client-profiles.md
  troubleshooting.md
```

---

## Quick Start

```bash
# Base router deploy: dnsmasq, firewall-start, nat-start, cron scripts
ROUTER=192.168.50.1 ./deploy.sh

# Channel B router layer: sing-box, dnscrypt-proxy, REDIRECT routing
cd ansible
ansible-playbook playbooks/20-stealth-router.yml

# End-to-end verification: VPS + router
ansible-playbook playbooks/99-verify.yml
cd ..

# Local health snapshot
./verify.sh
./scripts/router-health-report
```

Traffic and observability:

```bash
# Main usage report: exits, devices, Home Reality ingress clients,
# popular destinations and routing mistake checks.
./scripts/traffic-report today
./scripts/traffic-report yesterday
./scripts/traffic-report week
./scripts/traffic-report month

# Human/LLM-safe operational snapshot.
./scripts/router-health-report
```

The traffic report answers how much went through the VPS, how much
stayed on the home Russian WAN, which devices and Home Reality ingress clients
were active, and whether likely routing mistakes appeared. See
[docs/traffic-observability.md](docs/traffic-observability.md).

Health monitor:

```bash
# Install/update with deploy.sh or ansible, then run a local router-side sample.
ssh admin@192.168.50.1 '/jffs/scripts/health-monitor/run-once'

# Primary storage on the router:
ssh admin@192.168.50.1 'cat /opt/var/log/router_configuration/health-monitor/summary-latest.md'
ssh admin@192.168.50.1 'cat /opt/var/log/router_configuration/health-monitor/alerts/$(date +%F).md'
ssh admin@192.168.50.1 'cat /opt/var/log/router_configuration/health-monitor/status.json'

# Unified router+VPS report from the control machine.
./scripts/ghostroute-health-report
./scripts/ghostroute-health-report --save
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
./scripts/client-profiles generate
./scripts/client-profiles open
```

Generated files live under `ansible/out/clients/`, including `iphone-*.png`, `macbook.png`, matching `.conf` files and a local `qr-index.html` gallery.

The `router.conf` profile still targets the VPS directly because it is the router's outbound identity. `iphone-*` and `macbook` profiles target the home public IP first.

Never commit or paste real VLESS URIs, UUIDs, Reality keys, short IDs, admin paths or QR payloads into documentation. Use fake placeholders only.

See [docs/client-profiles.md](docs/client-profiles.md) and [docs/secrets-management.md](docs/secrets-management.md).

---

## Detailed Documentation

- [README-ru.md](README-ru.md) - main Russian documentation
- [docs/architecture.md](docs/architecture.md) - current routing architecture
- [docs/network-flow-and-observer-model.md](docs/network-flow-and-observer-model.md) - detailed traffic flows and observer model
- [docs/traffic-observability.md](docs/traffic-observability.md) - traffic reports, device/app popularity and routing mistake checks
- [docs/stealth-monitoring-implementation-guide.md](docs/stealth-monitoring-implementation-guide.md) - GhostRoute health monitor implementation
- [docs/stealth-monitor-runbook.md](docs/stealth-monitor-runbook.md) - health monitor alerts and recovery runbook
- [docs/routing-performance-troubleshooting.md](docs/routing-performance-troubleshooting.md) - LTE/Home Reality performance diagnostics and fixes
- [docs/channel-routing-operations.md](docs/channel-routing-operations.md) - day-2 operations and channel switching
- [docs/stealth-channel-implementation-guide.md](docs/stealth-channel-implementation-guide.md) - implemented VLESS+Reality guide
- [docs/domain-management.md](docs/domain-management.md) - domain and static-network catalog management
- [docs/stealth-domains-curation-audit.md](docs/stealth-domains-curation-audit.md) - advisory STEALTH_DOMAINS curation review
- [docs/secrets-management.md](docs/secrets-management.md) - vault, local secrets and pre-push scan
- [docs/client-profiles.md](docs/client-profiles.md) - VLESS/Reality QR workflow
- [docs/troubleshooting.md](docs/troubleshooting.md) - incident diagnostics

---

## License

[MIT](LICENSE) - Copyright (c) 2025 Denis Ermilov
