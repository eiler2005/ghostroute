# Архитектура GhostRoute

## Коротко

Текущая архитектура — Channel A Reality-first, без активного legacy WireGuard:

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

Channel B manual clients
  -> separate generated VLESS+XHTTP+TLS profile
  -> separate public VPS hostname on :443
  -> Caddy TLS routing
  -> local-only XHTTP backend
  -> Internet

Channel C manual clients
  -> separate generated NaiveProxy profile
     (plus HTTPS forward-proxy compatibility profile where needed)
  -> separate public VPS hostname on :443
  -> Caddy layer4 SNI routing
  -> TLS wrapper to localhost-only Squid compatibility proxy
  -> Internet
```

Legacy `wgs1`/`wgc1` are decommissioned in normal operation. `wgc1_*` NVRAM is preserved
only as a cold fallback through `modules/recovery-verification/router/emergency-enable-wgc1.sh`.

## Components

| Component | Role |
|---|---|
| ASUS RT-AX88U Pro + Merlin | dnsmasq/ipset/iptables, sing-box, dnscrypt-proxy |
| `dnsmasq` | fills `STEALTH_DOMAINS`, includes static/auto catalogs, filters AAAA while IPv6 is off |
| `dnscrypt-proxy` | upstream DNS on `127.0.0.1:<dnscrypt-port>`, proxied through sing-box SOCKS |
| `sing-box` on router | `redirect-in :<lan-redirect-port>`, home Reality inbound `:<home-reality-port>`, Reality outbound to VPS |
| VPS host | Caddy :443 plus Xray Reality backend on localhost |
| Channel A | primary `sing-box -> VLESS+Reality+Vision` path |
| Channel B | optional manual XHTTP `packet-up` device profiles via local-only Xray backend |
| Channel C | optional manual NaiveProxy profile artifacts, plus HTTPS proxy compatibility artifacts backed by a localhost-only Squid proxy |
| `VPN_STATIC_NETS` | historical ipset name for static CIDR routes used by Channel A |
| `wgc1` NVRAM | cold fallback only, disabled in steady state |

## Routing Matrix

| Source | Selector | Mechanism | Egress |
|---|---|---|---|
| LAN/Wi-Fi TCP (`br0`) | `STEALTH_DOMAINS`, `VPN_STATIC_NETS` | nat REDIRECT `:<lan-redirect-port>` | Channel A sing-box -> Reality |
| LAN/Wi-Fi UDP/443 (`br0`) | same sets | DROP | client fallback to TCP |
| Mobile QR/VLESS | generated Reality profile plus managed rule-sets | TCP/<home-reality-port> to home router | managed -> Reality; non-managed -> home WAN |
| Channel B manual profile | selected device only | separate XHTTP hostname on VPS `:443` | manual fallback egress |
| Channel C manual profile | selected device only | separate Naive hostname on VPS `:443` | manual fallback egress |
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

Channel B and Channel C profiles are generated separately from normal Home
Reality and emergency Reality profiles. They are imported manually on selected
devices and connect directly to dedicated VPS hostnames on public `:443`.

In v1, Channel B/C do not install binaries on the router, do not add local
router SOCKS/HTTP ports, and do not add domain routing rules.

## Boot Hooks

| Hook | Responsibility |
|---|---|
| `firewall-start` | create/restore `STEALTH_DOMAINS`, load `VPN_STATIC_NETS`, enforce LAN-only SSH, call stealth-route-init |
| `stealth-route-init.sh` | apply REDIRECT, QUIC DROP and mobile Reality INPUT rules |
| `cron-save-ipset` | persist `STEALTH_DOMAINS.ipset` |
| `cron-traffic-snapshot` | collect WAN/LAN/Tailscale/device counters |
| `nat-start` | intentionally no Channel A work |

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
- Channel B/C, when enabled, are VPS/client-profile only and keep router
  REDIRECT/TUN/DNS unchanged
