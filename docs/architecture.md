# Архитектура GhostRoute

## Коротко

Текущая production-архитектура — Channel A Reality-first, без активного legacy
WireGuard. Channel B реализован как manual home-first lane, Channel C остается
planned/manual lane:

- Channel A — прозрачная домашняя магистраль: роутер сам перехватывает managed
  LAN/Wi-Fi traffic и отправляет его через Reality/Vision на VPS.
- Channel B — protocol-diverse fallback candidate в home-first форме:
  selected device подключается к отдельному домашнему XHTTP/TLS ingress, а
  роутер relays трафик дальше через sing-box Reality outbound на VPS.
- Channel C — camouflage experiment: selected device подключается к
  Naive/HTTPS-forward-proxy-style hostname на VPS, не меняя роутер.

```text
LAN/Wi-Fi clients
  -> dnsmasq fills STEALTH_DOMAINS / VPN_STATIC_NETS
  -> br0 TCP nat REDIRECT :<lan-redirect-port>
  -> ASUS sing-box redirect inbound
  -> Channel A VLESS+Reality+Vision outbound
  -> VPS Caddy :443
  -> Xray Reality inbound
  -> Internet

Remote mobile QR clients
  -> home public IP :<home-reality-port>
  -> ASUS sing-box Reality inbound
  -> managed split:
       STEALTH_DOMAINS/VPN_STATIC_NETS -> Reality outbound to VPS
       other destinations              -> direct-out via home WAN

Channel B manual live-tested protocol-diverse clients
  -> VLESS+XHTTP+TLS profile to home public IP :<home-channel-b-port>
  -> router local Xray Channel B ingress
  -> local sing-box SOCKS inbound
  -> Channel A Reality outbound to VPS
  -> Caddy :443 -> Xray Reality inbound
  -> Internet

Channel C future camouflage clients
  -> NaiveProxy or HTTPS forward-proxy-compatible profile
  -> separate public VPS hostname on :443
  -> Caddy forward_proxy / compatible backend
  -> Internet
```

During a WAN incident where `wan0` reports `carrier=0`, the router has no
physical/provider link. That condition is below GhostRoute and does not change
the architectural status of Channel A.

Legacy `wgs1`/`wgc1` are decommissioned in normal operation. `wgc1_*` NVRAM is preserved
only as a cold fallback through `modules/recovery-verification/router/emergency-enable-wgc1.sh`.

## Components

| Component | Role |
|---|---|
| ASUS RT-AX88U Pro + Merlin | dnsmasq/ipset/iptables, sing-box, dnscrypt-proxy |
| `dnsmasq` | fills `STEALTH_DOMAINS`, includes static/auto catalogs, filters AAAA while IPv6 is off |
| `dnscrypt-proxy` | upstream DNS on `127.0.0.1:<dnscrypt-port>`, proxied through sing-box SOCKS |
| `sing-box` on router | `redirect-in :<lan-redirect-port>`, home Reality inbound `:<home-reality-port>`, local SOCKS inbound for dnscrypt/Channel B relay, Reality outbound to VPS |
| VPS host | Caddy :443 plus Xray Reality backend on localhost |
| Channel A | active production `sing-box -> VLESS+Reality+Vision` path |
| Channel B | non-production manual live-tested home-first lane: router XHTTP ingress + local relay -> sing-box Reality upstream |
| Channel C | future camouflage-oriented NaiveProxy / HTTPS forward-proxy device-client lane |
| `VPN_STATIC_NETS` | historical ipset name for static CIDR routes used by Channel A |
| `wgc1` NVRAM | cold fallback only, disabled in steady state |

## Ansible Deployment Boundaries

Разделение playbooks по каналам:

| Playbook | Scope | Ownership boundary |
|---|---|---|
| `10-stealth-vps.yml` | VPS base | Shared Caddy listener, Channel A/Reality backend, UFW, VPS health. |
| `11-channel-b-vps.yml` | VPS Channel B | Optional direct-XHTTP backend + Caddy route validation for direct Channel B mode. |
| `12-channel-c-vps.yml` | VPS Channel C | Only Channel C compatibility backend/Caddy path. |
| `20-stealth-router.yml` | Router | Channel A router data plane and router runtime hooks. |
| `21-channel-b-router.yml` | Router Channel B | Channel B home XHTTP ingress + local relay add-on, isolated from Channel A REDIRECT ownership. |

`21` включает home-first вариант Channel B на роутере. `11` нужен только для
direct-XHTTP варианта Channel B. `12` остается отдельным manual Channel C lane.
Эти playbooks не должны мутировать Channel A/Reality state.

## Routing Matrix

| Source | Selector | Mechanism | Egress |
|---|---|---|---|
| LAN/Wi-Fi TCP (`br0`) | `STEALTH_DOMAINS`, `VPN_STATIC_NETS` | nat REDIRECT `:<lan-redirect-port>` | Channel A sing-box -> Reality |
| LAN/Wi-Fi UDP/443 (`br0`) | same sets | DROP | client fallback to TCP |
| Mobile QR/VLESS | generated Reality profile plus managed rule-sets | TCP/<home-reality-port> to home router | managed -> Reality; non-managed -> home WAN |
| Channel B manual live-tested profile | selected device only | TCP/<home-channel-b-port> to home router, then local relay into sing-box SOCKS -> Reality | manual home-first egress |
| Channel C future manual profile | selected device only | separate Naive/HTTPS hostname on VPS `:443` | future experimental device-client egress |
| Router `OUTPUT` | none | no transparent capture | default WAN or explicit proxy |
| Emergency fallback | `STEALTH_DOMAINS`, `VPN_STATIC_NETS` | explicit `0x1000` mark from fallback script | `wgc1` |

## Domain Catalog

Single repo source:

```text
configs/dnsmasq-stealth.conf.add
```

Live include:

```text
/jffs/configs/dnsmasq.conf.add
  conf-file=/jffs/configs/dnsmasq-stealth.conf.add
```

Auto-discovery writes only:

```text
ipset=/example.com/STEALTH_DOMAINS
```

`VPN_DOMAINS` should be absent in the new steady state.

## Packet Flow

### LAN Client

```text
client DNS query
  -> dnsmasq
  -> matching IPv4 added to STEALTH_DOMAINS

client TCP connection
  -> PREROUTING -i br0
  -> match STEALTH_DOMAINS or VPN_STATIC_NETS
  -> REDIRECT :<lan-redirect-port>
  -> sing-box redirect inbound
  -> Reality outbound
  -> VPS exit
```

### Mobile Home QR

```text
client app
  -> VLESS+Reality to home public IP :<home-reality-port>
  -> router Reality inbound validates router-side UUID/key/short_id
  -> if destination matches STEALTH_DOMAINS or VPN_STATIC_NETS:
       sing-box Reality outbound to VPS -> VPS exit
  -> otherwise:
       sing-box direct-out -> home WAN exit
```

The mobile carrier sees domestic home ingress traffic. Websites still see the
VPS exit IP for managed traffic; non-managed destinations see the home WAN
IP. See [modules/routing-core/docs/network-flow-and-observer-model.md](/modules/routing-core/docs/network-flow-and-observer-model.md)
for the full workflow and observer table.

### Router-Originated Traffic

Router `OUTPUT` is not transparently captured. Capturing router-originated
traffic globally can loop sing-box outbound connections. Diagnostics that need
Reality should use an explicit proxy or client profile.

### Channel B/C Manual Clients

Channel B and Channel C remain manual lanes and are documented separately from
normal Home Reality and emergency Reality profiles.

Current Channel B shape is home-first:

```text
client app
  -> VLESS+XHTTP+TLS to home public IP :<home-channel-b-port>
  -> router local Xray Channel B ingress
  -> router local relay -> sing-box SOCKS inbound
  -> sing-box Reality outbound -> VPS Caddy/Xray Reality
  -> Internet
```

This keeps the first hop domestic for the mobile operator while keeping a
different first-hop fingerprint from Channel A.

Channel C remains direct device-to-VPS on its dedicated public `:443` hostname
with NaiveProxy / HTTPS forward-proxy-compatible profiles.

## Boot Hooks

| Hook | Responsibility |
|---|---|
| `firewall-start` | create `STEALTH_DOMAINS` as `hash:ip`, replay persisted `add STEALTH_DOMAINS ...` entries, load `VPN_STATIC_NETS`, enforce LAN-only SSH, call stealth-route-init |
| `stealth-route-init.sh` | apply REDIRECT, QUIC DROP and mobile Reality INPUT rules |
| `cron-save-ipset` | persist `STEALTH_DOMAINS.ipset` |
| `cron-traffic-snapshot` | collect WAN/LAN/Tailscale/device counters |
| `nat-start` | intentionally no Channel A work |

`STEALTH_DOMAINS` is a dnsmasq-populated set of resolved IPv4 addresses, so it
must stay `hash:ip`. `VPN_STATIC_NETS` is the static CIDR set and remains
`hash:net`. Replaying only saved `add STEALTH_DOMAINS ...` lines avoids Merlin
`ipset restore` aborting on the saved `create` line after a reboot or firewall
rebuild.

## Verification

```bash
ROUTER=192.168.50.1 ./verify.sh
cd ansible && ansible-playbook playbooks/99-verify.yml --limit routers
```

Critical invariants:

- `wgs1_enable=0`
- `wgc1_enable=0`
- `VPN_DOMAINS` absent
- `STEALTH_DOMAINS` present
- `VPN_STATIC_NETS` present
- no `RC_VPN_ROUTE`
- no `0x1000` rule outside emergency fallback
- `filter-AAAA` present while IPv6 is disabled
- Channel B/C are not required for production health; any manual enablement
  must keep Channel A REDIRECT/TUN/DNS ownership unchanged and remain explicit
  (`11` + `21` for B, `12` for C)
