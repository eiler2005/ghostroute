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
- **User-interest signal** — repeated candidate requests over a week (`count7d` + active days) increase probe priority even when current-hour traffic is low
- **Service-family domain detection** — subdomains usually collapse to a shared family (`www.example-provider.invalid` → `example-provider.invalid`), while IP-encoded dynamic DNS keeps a narrower family (`openclaw.203-0-113-10.sslip.io` → `203-0-113-10.sslip.io`)
- **Ancestor dedupe + cleanup** — if `fbcdn.net` is already routed, child hosts like `video.xx.fbcdn.net` are skipped automatically; stale child rules in the auto file are pruned during cleanup
- **Static IP routing** — for services that still open direct TCP/IP sessions outside the usual DNS path (Telegram, imo, Apple flows), CIDR ranges are added to a separate ipset
- **Idempotent deployment** — managed blocks pattern (`# BEGIN router_configuration`) makes `deploy.sh` safe to run repeatedly without duplicating config
- **ipset persistence** — firewall sets are saved to USB storage via cron and restored after reboots
- **Remote access via WireGuard server or Tailscale** — raw `wgs1` clients with a public IPv4 and optional `Tailscale Exit Node` both honor `VPN_DOMAINS` / `VPN_STATIC_NETS`
- **Peer-level observability** — `traffic-report` / `traffic-daily-report` show router-wide totals plus per-peer deltas for both `Tailscale` and raw `WireGuard server` clients

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
          iptables PREROUTING / OUTPUT
          └─ IP in VPN_DOMAINS? → mark packet 0x1000
                ↓
          ip rule: fwmark 0x1000 → lookup routing table wgc1
                ↓
          WireGuard wgc1 tunnel → VPN exit → internet
```

`PREROUTING` handles ordinary LAN clients arriving on `br0` and raw WireGuard server clients arriving on `wgs1`. `OUTPUT` mirrors the same destination-based marking for router-originated traffic, which is required for `Tailscale Exit Node` because those proxied flows are generated locally on the router.

Raw `WireGuard server` clients also have plain DNS (`tcp/udp 53`) redirected to the router-local `dnsmasq`. This keeps `VPN_DOMAINS` working even if a reconnecting mobile client comes back with stale DNS settings and would otherwise bypass the router's `ipset` population path.

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
          ├─ Skip: already covered by a broader VPN suffix
          ├─ Normalize auto file: drop child rules already covered by parent rules
          │
          └─ Check vs /opt/tmp/blocked-domains.lst
                ├─ In blocked list → add to dnsmasq-autodiscovered.conf.add
                │                    restart dnsmasq
                └─ Not in list → candidate
                                   ├─ count24h threshold / priority entry?
                                   ├─ weekly user-interest signal?
                                   │    (count7d + active_days7d)
                                   ├─ scheduler:
                                   │    2 interest + 10 top-score + 4 fair
                                   ├─ ISP probe says HTTP 000 → add as geo-blocked
                                   └─ otherwise stay logged as candidate
```

`blocked-domains.lst` is updated daily by `update-blocked-list.sh` from [community.antifilter.download](https://community.antifilter.download) — a curated list of ~500 key services blocked in Russia, downloaded through the VPN tunnel itself.

When a domain passes auto-discovery, the script writes a **service-family domain**:
- regular subdomains usually collapse to the registrable domain (`api.example-provider.invalid` → `example-provider.invalid`)
- IP-encoded dynamic DNS keeps the family at the IP label (`openclaw.203-0-113-10.sslip.io` → `203-0-113-10.sslip.io`)

Before writing, the script also does a full **suffix coverage check** across manual rules and already-kept auto rules:
- if `fbcdn.net` already exists, `static.xx.fbcdn.net` is skipped as redundant
- if an old child rule is still present in `dnsmasq-autodiscovered.conf.add`, cleanup rewrites the auto file without that child

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
| AI Tools | Claude / Anthropic, ChatGPT / OpenAI, Google AI Studio, NotebookLM, Smithery, Wispr Flow |
| Dev tools | GitHub, GitLab, Bitbucket, Azure DevOps, Visual Studio |
| Video | YouTube (all subdomains + CDN) |
| Messengers | Telegram (domains + ASN-based IP ranges), imo (imo.im + PageBites IP ranges), WhatsApp |
| Social | Instagram, Facebook / Messenger, Twitter / X, TikTok, LinkedIn |
| Other | Apple Podcasts, Atlassian, cobalt.tools |

Plus dynamically discovered domains filtered by the community blocked list.

---

## Project Structure

```
configs/
  dnsmasq.conf.add                # ipset rules: which domains → VPN_DOMAINS
  dnsmasq-vpn-upstream.conf.add   # per-domain DNS upstream via wgc1
  dnsmasq-logging.conf.add        # DNS query logging config (for auto-discovery)
  static-networks.txt             # static CIDR ranges (Telegram / imo / Apple and similar direct-IP cases)
  domains-no-vpn.txt              # explicit exclusions (never route via VPN)
  no-vpn-ip-ports.txt             # per-IP:port exceptions that must stay on WAN

scripts/
  firewall-start                  # creates ipsets, loads static nets, sets iptables rules
  nat-start                       # adds ip rules for fwmark + DNS routing
  services-start                  # installs cron jobs (ipset save, auto-add, blocked-list update)
  domain-auto-add.sh              # auto-discovery: DNS log → blocked-list check → dnsmasq config
  update-blocked-list.sh          # downloads blocked domain list daily via VPN
  domain-report                   # CLI tool: view / manage / reset auto-discovered domains
  traffic-report                  # CLI tool: today's WAN/Wi-Fi/VPN/WG-server/Tailscale totals + LAN/WGS snapshots
  traffic-daily-report            # CLI tool: closed-day report from stored snapshots, incl. WGS peers
  router-health-report            # CLI tool: sanitised health/capacity/traffic summary for humans and LLMs
  catalog-review-report           # CLI tool: advisory review of manual domains + static CIDR coverage
  cron-save-ipset                 # saves VPN_DOMAINS ipset to disk every 6h
  cron-traffic-snapshot           # stores traffic counters / Tailscale / WGS snapshots every 6h
  cron-traffic-daily-close        # stores end-of-day LAN/WGS conntrack snapshot at 23:55

docs/
  architecture.md                 # packet flow, DNS upstream, deployment mechanics (RU)
  getting-started.md              # step-by-step setup from scratch (RU)
  domain-management.md            # how to add/remove domains (RU)
  future-improvements-backlog.md  # deferred improvements / future LLM handoff context (RU)
  telegram-deep-dive.md           # why Telegram needs special treatment (RU)
  troubleshooting.md              # diagnostics and common issues (RU)
  current-routing-explained.md    # full catalog of routed domains (RU)
  traffic-observability.md        # traffic-report architecture and counter semantics (RU)
  llm-traffic-runbook.md          # minimal instructions for an LLM / agent (RU)
  router-health-latest.md         # tracked sanitised snapshot of the latest saved health report
  catalog-review-latest.md        # tracked sanitised advisory snapshot for catalog cleanup review

deploy.sh                         # idempotent deploy to router via SSH/SCP
verify.sh                         # compact health-summary + drift/freshness checks
.env.example                      # configuration template
```

Local-only overrides belong in `secrets/`:

- `secrets/router.env` — router IP / SSH settings
- `secrets/no-vpn-ip-ports.local.txt` — per-IP:port WAN bypass overrides

The entire `secrets/` directory is gitignored.

---

## Quick Start

**Prerequisites**: ASUS router with Asuswrt-Merlin firmware, WireGuard client `wgc1` connected, SSH enabled, Entware installed on USB.

```bash
# Clone
git clone https://github.com/eiler2005/router_configuration
cd router_configuration

# Configure local secrets (router IP is auto-detected from default gateway if not set)
mkdir -p secrets
cp .env.example secrets/router.env
# Optional: edit secrets/router.env to override ROUTER=, SSH_IDENTITY_FILE=, etc.

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

## Optional: Tailscale Exit Node

If the router is behind CGNAT/private WAN, direct inbound VPN (`Instant Guard`, raw WireGuard server, OpenVPN server) will not work from the public internet without a public IPv4. In that case, `Tailscale` can be installed on Merlin through `Entware` and used as an `Exit Node`.

Important notes:

- `Tailscale Exit Node` traffic is processed as router-originated traffic, so `OUTPUT -> RC_VPN_ROUTE` is required for split routing to match normal LAN behavior
- destinations in `VPN_DOMAINS` / `VPN_STATIC_NETS` still go through `wgc1`
- everything else still uses the normal WAN path
- performance can be lower than plain LAN routing because `Tailscale` runs in `userspace` on the router, and some mobile sessions may fall back to `DERP/relay`

### Traffic reporting

`traffic-report` uses snapshots stored on the router every 6 hours and reports totals since the first sample of the current day:

- `WAN total` — all external traffic via the ISP-facing interface
- `VPN total` — all traffic that traversed `wgc1`
- `WG server total` — all traffic that traversed raw WireGuard server interface `wgs1`
- `Wi-Fi total` — all traffic on the router radios
- `Tailscale total` — per-peer `RxBytes` / `TxBytes` deltas reported by `tailscaled`
- `LAN device bytes` — cumulative per-device deltas from router-side mangle accounting (`VPN` / `WAN` / `Other` / upload / download)
- `Device traffic mix` — explicit per-device summary of `Via VPN` vs `Direct WAN`, plus top devices by VPN bytes and direct-WAN bytes
- `WireGuard server peers` — per-peer deltas from `wg show wgs1 dump`, plus current/end-of-day conntrack snapshots for remote peers on `wgs1`
- `Top by WG server peers` / `Top by Tailscale peers` — short peer-level summaries that surface the busiest remote clients without scanning the full tables
- `LAN devices` — current connection snapshot from `conntrack` (`Total` / `VPN` / `WAN` / `Local` are active connection counts, not bytes)

By default, report output redacts peer names, LAN hostnames, tunnel addresses, and endpoints. Use `REPORT_REDACT_NAMES=0` only for trusted local inspection.

If you want trusted local reports to show your own device aliases and generic types without committing them to git, create `secrets/device-metadata.local.tsv` locally. Format:

```txt
# ip|alias|type|notes
192.168.50.42||iPhone|router UI label
192.168.50.34|Living-room-speaker|IoT|local-only hint
```

The `secrets/` directory is gitignored, so these overrides stay local. With redaction enabled, reports still show `lan-host-*`.

For raw `WireGuard server` peers, the router can report both per-peer transfer counters and current conntrack snapshots because decrypted traffic keeps the peer tunnel address from `wgs1` when it enters `PREROUTING`.

For `Tailscale Exit Node`, the router can reliably report **per-peer Tailscale bytes**, but it cannot reliably split each peer's bytes into `through wgc1` vs `direct WAN` after userspace proxying. Treat `VPN total` as the router-wide VPN volume, not a per-peer Tailscale breakdown.

Detailed collection / delta / network-counter architecture: [docs/traffic-observability.md](docs/traffic-observability.md)
LLM runbook for reading these reports, including a ready-to-paste agent prompt for `day / week / month` traffic requests: [docs/llm-traffic-runbook.md](docs/llm-traffic-runbook.md)

Quick commands:

```bash
./scripts/traffic-report
./scripts/traffic-daily-report yesterday
./scripts/traffic-daily-report week
./scripts/traffic-daily-report month
```

`LAN device bytes` and `Device traffic mix` appear after the router has collected at least two byte snapshots for the same day/period. Until then, reports show a note that the byte baseline is not available yet.

For `week/month`, router-wide totals may cover a wider window than `LAN device bytes`. In that case the report now prints a dedicated `Per-device byte window` line so you can see exactly what interval the per-device split covers.

### Health summary and LLM-friendly snapshot

On top of the traffic reports there are now two safe operational commands:

- `./verify.sh`
  compact summary grouped into `Router`, `Routing Health`, `Catalog Capacity`, `Growth Trends`, `Freshness`, `Drift`, `Result`
- `./verify.sh --verbose`
  deeper live diagnostic dump
- `./scripts/router-health-report`
  sanitised Markdown health snapshot for humans and LLMs
- `./scripts/router-health-report --save`
  updates all three layers at once:
  - tracked [docs/router-health-latest.md](docs/router-health-latest.md)
  - local operational journal `docs/vpn-domain-journal.md`
  - router-side USB-backed copy in `/opt/var/log/router_configuration/reports/`
    or fallback `/jffs/addons/router_configuration/traffic/reports/` when Entware is unavailable
- `./scripts/catalog-review-report`
  advisory-only catalog review: highlights broad static CIDRs and parent-covered child domains without changing runtime config
- `./scripts/catalog-review-report --save`
  updates:
  - tracked [docs/catalog-review-latest.md](docs/catalog-review-latest.md)
  - local operational journal `docs/vpn-domain-journal.md`
  - router-side USB-backed copy in `/opt/var/log/router_configuration/reports/`
    or fallback `/jffs/addons/router_configuration/traffic/reports/`

Quick commands:

```bash
./verify.sh
./verify.sh --verbose
./scripts/router-health-report
./scripts/router-health-report --save
./scripts/catalog-review-report
./scripts/catalog-review-report --save
```

`router-health-report` combines:

- repo-managed routing invariants
- catalog capacity and headroom
- growth trends against the latest saved snapshot and week-old snapshot when history exists
- freshness of blocked-list, ipset persistence, and traffic snapshots
- base traffic totals and device traffic mix
- explicit growth level / growth note so you can quickly tell whether auto-catalog growth is becoming operationally relevant

This gives a safe two-layer operational model:

- tracked `docs/router-health-latest.md` for repository/LLM consumption
- local `docs/vpn-domain-journal.md` for operational history
- router-side USB copy for quick access even without the local git checkout

Runbook: [docs/llm-traffic-runbook.md](docs/llm-traffic-runbook.md)
Latest sanitised snapshot: [docs/router-health-latest.md](docs/router-health-latest.md)

### Tests and smoke checks

Recommended safe validation after observability/reporting changes:

```bash
bash -n verify.sh scripts/router-health-report scripts/traffic-report scripts/traffic-daily-report scripts/lib/router-health-common.sh tests/test-router-health.sh
bash -n scripts/catalog-review-report tests/test-catalog-review.sh
./tests/test-router-health.sh
./tests/test-catalog-review.sh
./verify.sh
./scripts/traffic-report
./scripts/traffic-daily-report week
./scripts/router-health-report
./scripts/router-health-report --save
./scripts/catalog-review-report
./scripts/catalog-review-report --save
```

These commands do not change router runtime config. They only:

- validate shell syntax
- smoke-test parser/formatter logic on fixtures
- read live router state over SSH

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

# Prune redundant child auto-domains on the router
./scripts/domain-report --cleanup

# Remove all auto-discovered domains and restart dnsmasq
./scripts/domain-report --reset
```

To add a domain permanently, edit `configs/dnsmasq.conf.add` and `configs/dnsmasq-vpn-upstream.conf.add`, then re-run `./deploy.sh`.

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
| Telegram / imo domain + IP subnet routing | Active |
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
