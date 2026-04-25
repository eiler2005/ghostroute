# Архитектура GhostRoute

## Коротко

Текущая архитектура — Reality-first, без активного WireGuard Channel A:

```text
LAN/Wi-Fi clients
  -> dnsmasq fills STEALTH_DOMAINS / VPN_STATIC_NETS
  -> br0 TCP nat REDIRECT :<lan-redirect-port>
  -> ASUS sing-box redirect inbound
  -> VLESS+Reality outbound
  -> VPS Caddy :443
  -> Xray Reality inbound
  -> Internet

Remote mobile QR clients
  -> home public IP :<home-reality-port>
  -> ASUS sing-box Reality inbound
  -> managed split:
       STEALTH_DOMAINS/VPN_STATIC_NETS -> Reality outbound to VPS
       other destinations              -> direct-out via home WAN
```

`wgs1`/`wgc1` are decommissioned in normal operation. `wgc1_*` NVRAM is preserved
only as a cold fallback through `scripts/emergency-enable-wgc1.sh`.

## Components

| Component | Role |
|---|---|
| ASUS RT-AX88U Pro + Merlin | dnsmasq/ipset/iptables, sing-box, dnscrypt-proxy |
| `dnsmasq` | fills `STEALTH_DOMAINS`, includes static/auto catalogs, filters AAAA while IPv6 is off |
| `dnscrypt-proxy` | upstream DNS on `127.0.0.1:5354`, proxied through sing-box SOCKS |
| `sing-box` on router | `redirect-in :<lan-redirect-port>`, home Reality inbound `:<home-reality-port>`, Reality outbound to VPS |
| VPS VPS | Caddy :443 plus Xray Reality backend on localhost |
| `VPN_STATIC_NETS` | historical ipset name for static CIDR routes used by Channel B |
| `wgc1` NVRAM | cold fallback only, disabled in steady state |

## Routing Matrix

| Source | Selector | Mechanism | Egress |
|---|---|---|---|
| LAN/Wi-Fi TCP (`br0`) | `STEALTH_DOMAINS`, `VPN_STATIC_NETS` | nat REDIRECT `:<lan-redirect-port>` | sing-box -> Reality |
| LAN/Wi-Fi UDP/443 (`br0`) | same sets | DROP | client fallback to TCP |
| Mobile QR/VLESS | generated Reality profile plus managed rule-sets | TCP/<home-reality-port> to home router | managed -> Reality; non-managed -> home WAN |
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
IP. See [network-flow-and-observer-model.md](network-flow-and-observer-model.md)
for the full workflow and observer table.

### Router-Originated Traffic

Router `OUTPUT` is not transparently captured. Capturing router-originated
traffic globally can loop sing-box outbound connections. Diagnostics that need
Reality should use an explicit proxy or client profile.

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
