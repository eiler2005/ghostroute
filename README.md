# GhostRoute

### Smart Domain-Based VPN Routing for ASUS Router

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Router-ASUS%20Asuswrt--Merlin-blue)](https://github.com/RMerl/asuswrt-merlin.ng)
[![VPN](https://img.shields.io/badge/VPN-WireGuard-88171A)](https://www.wireguard.com/)
[![Shell](https://img.shields.io/badge/Shell-POSIX%20sh%20%2F%20BusyBox-4EAA25)](https://www.busybox.net/)
[![Status](https://img.shields.io/badge/Status-Active-brightgreen)]()

> Traffic routes itself. Invisibly.

Transparent, domain-aware VPN routing for ASUS routers running Asuswrt-Merlin. Blocked services go through WireGuard automatically — no VPN apps on devices, no proxy settings, no manual lists. The router handles everything silently.

**[Русская версия / Russian version →](README-ru.md)**

---

## Overview

Russia's internet restrictions block many services at the ISP level — not just by domain name, but through deep packet inspection (DPI) and IP-range blocking. A VPN on every individual device is an inelegant solution: slow to update, hard to maintain, visible to apps.

This project implements **transparent, router-level routing**: devices on the LAN connect normally, and the router silently redirects blocked services through a WireGuard VPN tunnel. No per-device VPN apps, no proxy settings, no manual lists to update.

The core insight: instead of trying to define "what is Russian" (impossible to enumerate), the system uses a community-maintained list of domains [actually blocked in Russia](https://community.antifilter.download) and auto-discovers new ones from real DNS traffic.

---

## Key Features

- **Domain + subdomain routing** — `ipset=/youtube.com/VPN_DOMAINS` covers the domain and every subdomain automatically
- **DNS geo-alignment** — VPN-routed domains are resolved via Cloudflare/Quad9 *over the VPN tunnel*, so IPs are geographically correct for the exit node, not ISP-localized
- **Auto-discovery** — parses DNS logs every hour and adds newly-seen blocked domains to VPN routing automatically
- **Smart filtering** — auto-discovered domains are validated against a community blocked list; non-blocked domains become candidates and may still be auto-added after an ISP-side reachability probe
- **Service-family domain detection** — subdomains usually collapse to a shared family (`www.example-provider.invalid` → `example-provider.invalid`), while IP-encoded dynamic DNS keeps a narrower family (`openclaw.203-0-113-10.sslip.io` → `203-0-113-10.sslip.io`)
- **Static IP routing** — for services blocked at the TCP/IP level rather than DNS (Telegram), CIDR ranges are added to a separate ipset
- **Idempotent deployment** — managed blocks pattern (`# BEGIN router_configuration`) makes `deploy.sh` safe to run repeatedly without duplicating config
- **ipset persistence** — firewall sets are saved to USB storage via cron and restored after reboots

---

## How It Works

### Packet flow

```
Device (iPhone / PC)
      │
      ├─ DNS query: "youtube.com?"
      │         ↓
      │   dnsmasq (router, port 53)
      │   ├─ domain in VPN config? → forward query to 1.1.1.1 via wgc1 interface
      │   │                          → add resolved IP to ipset VPN_DOMAINS
      │   │                          → return IP to device
      │   └─ other domain? → forward to ISP DNS as usual
      │
      └─ TCP/UDP connection to resolved IP
                ↓
          iptables PREROUTING
          └─ IP in VPN_DOMAINS? → mark packet 0x1000
                ↓
          ip rule: fwmark 0x1000 → lookup routing table wgc1
                ↓
          WireGuard wgc1 tunnel → VPN exit → internet
```

### Auto-discovery pipeline

```
/opt/var/log/dnsmasq.log   ←  all DNS queries (rotated daily)
          │
          │  domain-auto-add.sh  (cron, every hour)
          ▼
    Extract unique domains
          │
          ├─ Skip: system/CDN/infra patterns
          ├─ Skip: Russian TLDs (.ru, .su, .рф, ...)
          ├─ Skip: domains in domains-no-vpn.txt
          ├─ Skip: already routed via VPN
          │
          └─ Check vs /opt/tmp/blocked-domains.lst
                ├─ In blocked list → add to dnsmasq-autodiscovered.conf.add
                │                    restart dnsmasq
                └─ Not in list → candidate
                                   ├─ short entry domain / IP-encoded family?
                                   │    → probe early
                                   ├─ ISP probe says HTTP 000 → add as geo-blocked
                                   └─ otherwise stay logged as candidate
```

`blocked-domains.lst` is updated daily by `update-blocked-list.sh` from [community.antifilter.download](https://community.antifilter.download) — a curated list of ~500 key services blocked in Russia, downloaded through the VPN tunnel itself.

When a domain passes auto-discovery, the script writes a **service-family domain**:
- regular subdomains usually collapse to the registrable domain (`api.example-provider.invalid` → `example-provider.invalid`)
- IP-encoded dynamic DNS keeps the family at the IP label (`openclaw.203-0-113-10.sslip.io` → `203-0-113-10.sslip.io`)

---

## Technical Stack

| Layer | Technology |
|---|---|
| **Router** | ASUS RT-AX88U Pro, Asuswrt-Merlin 3006.x, BusyBox ash |
| **VPN** | WireGuard (kernel module, client `wgc1`) |
| **DNS** | dnsmasq 2.93 — per-domain upstream routing via `@interface` |
| **Firewall** | iptables mangle table + ipset (hash:ip, hash:net) |
| **Routing** | Linux policy routing: ip rule + ip route tables |
| **Persistence** | Entware on USB (ext4), ipset save/restore via cron |
| **Scripts** | POSIX sh — compatible with BusyBox ash on aarch64 |
| **Deploy** | SSH + SCP with managed block merging; auto-detects router IP |

---

## Covered Services

Manually curated domain families, each with VPN DNS upstream + ipset rules:

| Category | Services |
|---|---|
| AI Tools | Claude / Anthropic, ChatGPT / OpenAI, Google AI Studio, NotebookLM, Smithery |
| Dev tools | GitHub, GitLab, Bitbucket, Azure DevOps, Visual Studio |
| Video | YouTube (all subdomains + CDN) |
| Messengers | Telegram (domains + ASN-based IP ranges), WhatsApp |
| Social | Instagram, Facebook / Messenger, Twitter / X, TikTok, LinkedIn |
| Other | Apple Podcasts, Atlassian |

Plus dynamically discovered domains filtered by the community blocked list.

---

## Project Structure

```
configs/
  dnsmasq.conf.add                # ipset rules: which domains → VPN_DOMAINS
  dnsmasq-vpn-upstream.conf.add   # per-domain DNS upstream via wgc1
  dnsmasq-logging.conf.add        # DNS query logging config (for auto-discovery)
  static-networks.txt             # static CIDR ranges (Telegram ASN ranges)
  domains-no-vpn.txt              # explicit exclusions (never route via VPN)

scripts/
  firewall-start                  # creates ipsets, loads static nets, sets iptables rules
  nat-start                       # adds ip rules for fwmark + DNS routing
  services-start                  # installs cron jobs (ipset save, auto-add, blocked-list update)
  domain-auto-add.sh              # auto-discovery: DNS log → blocked-list check → dnsmasq config
  update-blocked-list.sh          # downloads blocked domain list daily via VPN
  domain-report                   # CLI tool: view / manage / reset auto-discovered domains
  cron-save-ipset                 # saves VPN_DOMAINS ipset to disk every 6h

docs/
  architecture.md                 # packet flow, DNS upstream, deployment mechanics (RU)
  getting-started.md              # step-by-step setup from scratch (RU)
  domain-management.md            # how to add/remove domains (RU)
  telegram-deep-dive.md           # why Telegram needs special treatment (RU)
  troubleshooting.md              # diagnostics and common issues (RU)
  current-routing-explained.md    # full catalog of routed domains (RU)

deploy.sh                         # idempotent deploy to router via SSH/SCP
verify.sh                         # validates router state after deploy
.env.example                      # configuration template
```

---

## Quick Start

**Prerequisites**: ASUS router with Asuswrt-Merlin firmware, WireGuard client `wgc1` connected, SSH enabled, Entware installed on USB.

```bash
# Clone
git clone https://github.com/eiler2005/router_configuration
cd router_configuration

# Configure (router IP is auto-detected from default gateway if not set)
cp .env.example .env
# Optional: edit .env to override ROUTER=, SSH_IDENTITY_FILE=, etc.

# Deploy
./deploy.sh

# Validate
./verify.sh
```

The deploy script:
1. Uploads config files and scripts via SCP
2. Merges each file into the router's config using managed blocks (idempotent)
3. Runs `nat-start`, `firewall-start`, `services-start` in sequence
4. Restarts dnsmasq

---

## Domain Management

```bash
# Summary: auto-added domains + last run report
./scripts/domain-report

# Full activity log (what was seen, what was added)
./scripts/domain-report --log

# Show domains seen in DNS but skipped (not in blocked list)
./scripts/domain-report --candidates

# List all auto-added domains
./scripts/domain-report --all

# Remove all auto-discovered domains and restart dnsmasq
./scripts/domain-report --reset
```

To add a domain permanently, edit `configs/dnsmasq.conf.add` and `configs/dnsmasq-vpn-upstream.conf.add`, then re-run `./deploy.sh`.

---

## Adding a New Domain Manually

Two lines in each config file:

**`configs/dnsmasq.conf.add`** — tells dnsmasq to add resolved IPs to ipset:
```
ipset=/example.com/VPN_DOMAINS
```

**`configs/dnsmasq-vpn-upstream.conf.add`** — tells dnsmasq to use VPN DNS for this domain:
```
server=/example.com/1.1.1.1@wgc1
server=/example.com/9.9.9.9@wgc1
```

Then run `./deploy.sh`.

---

## Diagnostics

```bash
# On the router (SSH in):

# Check ip rules
ip rule show | grep -E "0x1000|wgc1"

# Check routing table
ip route show table wgc1

# Check ipset contents
ipset list VPN_DOMAINS | head -20
ipset list VPN_STATIC_NETS

# Test DNS resolution (should return IP and log ipset add)
nslookup youtube.com 127.0.0.1

# Verify a specific IP is being routed via VPN
ip route get <IP> mark 0x1000

# WireGuard status
wg show wgc1
```

---

## Project Status

**Active** — running on production router (ASUS RT-AX88U Pro).

| Component | Status |
|---|---|
| dnsmasq + ipset + iptables + ip rule pipeline | Running |
| WireGuard client wgc1 | Connected (handshake every 20s) |
| Telegram domain + IP subnet routing | Active |
| Auto-discovery (every 1h) | Active |
| Blocked-list filter (antifilter.download) | Active, ~500 curated entries |
| ipset persistence on USB | Active (saves every 6h) |
| Idempotent deploy | Tested |

---

## Why This Approach

Several alternatives were considered:

| Approach | Problem |
|---|---|
| VPN on each device | Manual setup per device, apps can detect/bypass |
| Transparent proxy (squid/mitmproxy) | TLS inspection required, breaks HSTS |
| Full tunnel VPN on router | All traffic through VPN: slow, wastes bandwidth |
| DNS-only blocking (Pi-hole style) | No actual routing, just DNS; apps use hardcoded IPs |
| **Domain-based split routing** | Surgical: only blocked traffic goes through VPN, rest stays fast |

The auto-discovery filter also took a deliberate approach: instead of trying to enumerate "Russian domains" (impossible), the system checks discovered domains against a maintained list of what's actually blocked — and gracefully falls back to adding everything if the list isn't available.

---

## License

[MIT](LICENSE) — Copyright (c) 2025 Denis Ermilov

---

*See [README-ru.md](README-ru.md) for full Russian documentation.*
