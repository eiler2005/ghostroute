# GhostRoute

### Router-level domain routing for ASUS Merlin: Reality for home LAN, WGC1 reserve for remote WireGuard clients

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Router-ASUS%20Asuswrt--Merlin-blue)](https://github.com/RMerl/asuswrt-merlin.ng)
[![VPN](https://img.shields.io/badge/VPN-WireGuard-88171A)](https://www.wireguard.com/)
[![Status](https://img.shields.io/badge/Status-Active-brightgreen)]()

**[Русская версия / Russian version ->](README-ru.md)**

---

## Overview

GhostRoute lets an ASUS Merlin router decide which domains and IP networks should leave through a stealth Reality channel, while ordinary home devices stay configuration-free.

The current production model has three distinct paths:

- Home Wi-Fi/LAN uses Channel B: `sing-box REDIRECT :<lan-redirect-port> -> VLESS+Reality -> VPS/Xray`.
- Remote devices connected to the router WireGuard Server (`wgs1`) keep Channel A: `VPN_DOMAINS -> wgc1`.
- Direct QR/VLESS clients connect straight to the VPS/Xray inbound and do not enter the home LAN.

`wgc1` is no longer the primary home-LAN path. It remains a reserve path for remote WireGuard clients.

---

## Key Features

- Domain-based routing with `dnsmasq` + `ipset`.
- Separate catalogs for home LAN (`STEALTH_DOMAINS`) and remote WireGuard clients (`VPN_DOMAINS`).
- Shared static CIDR catalog for direct-IP services via `VPN_STATIC_NETS`.
- VLESS+Reality egress through a VPS VPS behind shared Caddy L4 on TCP/443.
- Stable router-side `sing-box` TCP REDIRECT instead of unstable Merlin TUN routing.
- Automatic domain discovery that writes both LAN and remote-client catalogs.
- Local QR/VLESS profile generation from Ansible Vault.
- Health, traffic and catalog reports suitable for humans and LLM handoff.

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
      VPS VPS
      +-- shared Caddy :443
      +-- Xray Reality inbound
            |
            v
      Internet
```

Home devices do not need VPN apps. The router sees DNS answers, fills `STEALTH_DOMAINS`, redirects matching TCP traffic into sing-box, and sends it through Reality. UDP/443 for managed destinations is rejected so apps fall back from QUIC to TCP.

### 2. Remote WireGuard Clients

```text
Remote WireGuard client outside home
      |
      v
Router WireGuard Server (wgs1)
      |
      v
VPN_DOMAINS / VPN_STATIC_NETS
      |
      v
mark 0x1000 -> table wgc1
      |
      v
legacy WireGuard client wgc1
      |
      v
Internet
```

Remote WireGuard clients keep the old WGC1 behavior. This protects the existing mobile-client workflow while the home LAN uses the new Reality path.

### 3. Direct QR / VLESS Clients

```text
Direct QR/VLESS client outside home
      |
      v
Client app imports generated QR profile
      |
      v
VLESS+Reality TCP/443
      |
      v
VPS VPS / Caddy / Xray
      |
      v
Internet

Note: this path does not enter the home router or home LAN by itself.
```

QR profiles are direct egress profiles for phones and laptops outside home. They are not a remote-LAN access mechanism unless a separate overlay is added.

---

## Technical Stack

```text
Router:
  ASUS RT-AX88U Pro + Asuswrt-Merlin
  dnsmasq + ipset + iptables
  sing-box REDIRECT inbound on :<lan-redirect-port>
  dnscrypt-proxy on 127.0.0.1:5354
  WireGuard Server interface: wgs1
  WireGuard Client reserve interface: wgc1

VPS:
  VPS Ubuntu host
  shared system Caddy with layer4 plugin on :443
  Xray/3x-ui Reality inbound on 127.0.0.1:8443
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
  dnsmasq.conf.add                # VPN_DOMAINS for remote wgs1 clients
  dnsmasq-stealth.conf.add        # STEALTH_DOMAINS for home LAN Channel B
  dnsmasq-vpn-upstream.conf.add   # retired compatibility block
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

Expected invariants:

- LAN TCP for `STEALTH_DOMAINS` and `VPN_STATIC_NETS` is redirected to `:<lan-redirect-port>`.
- LAN UDP/443 for those sets is rejected to force TCP fallback.
- `wgs1` enters `RC_VPN_ROUTE`.
- `RC_VPN_ROUTE` marks `VPN_DOMAINS` and `VPN_STATIC_NETS` with `0x1000`.
- Legacy `0x2000`, table `200`, and `singbox0` are absent.
- `0x1000` uses table `wgc1`.

---

## Client QR Profiles

Client profiles are generated locally from Ansible Vault:

```bash
./scripts/client-profiles generate
./scripts/client-profiles open
```

Generated files live under `ansible/out/clients/`, including `iphone-*.png`, `macbook.png`, matching `.conf` files and a local `qr-index.html` gallery.

Never commit or paste real VLESS URIs, UUIDs, Reality keys, short IDs, admin paths or QR payloads into documentation. Use fake placeholders only.

See [docs/client-profiles.md](docs/client-profiles.md) and [docs/secrets-management.md](docs/secrets-management.md).

---

## Detailed Documentation

- [README-ru.md](README-ru.md) - main Russian documentation
- [docs/architecture.md](docs/architecture.md) - current routing architecture
- [docs/channel-routing-operations.md](docs/channel-routing-operations.md) - day-2 operations and channel switching
- [docs/stealth-channel-implementation-guide.md](docs/stealth-channel-implementation-guide.md) - implemented VLESS+Reality guide
- [docs/domain-management.md](docs/domain-management.md) - domain and static-network catalog management
- [docs/secrets-management.md](docs/secrets-management.md) - vault, local secrets and pre-push scan
- [docs/client-profiles.md](docs/client-profiles.md) - VLESS/Reality QR workflow
- [docs/troubleshooting.md](docs/troubleshooting.md) - incident diagnostics

---

## License

[MIT](LICENSE) - Copyright (c) 2025 Denis Ermilov
