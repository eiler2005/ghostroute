# Архитектура GhostRoute

## Коротко

Текущая architecture model — layered routing setup: endpoint/client routing,
managed channels, home router и VPS egress. Channel A остается основным
Reality-first router data plane без активного legacy WireGuard. Channel B
реализован как production home-first lane для selected device-client profiles.
Channel C — C1 home-first Naive lane, который будет считаться production только
после отдельного live client proof на выбранном iPhone-клиенте.

- Layer 0 — optional endpoint/client-side routing: device/client config может
  выбрать `DIRECT` или `MANAGED/PROXY` до входа в GhostRoute.
- Channel A — home-first managed channel: endpoint или LAN traffic попадает на
  home router, а managed traffic уходит через Reality/Vision на VPS.
- Channel B — production selected-client lane в home-first форме:
  selected device подключается к отдельному домашнему XHTTP/TLS ingress, а
  роутер relays трафик дальше через local sing-box SOCKS c managed split: managed
  домены идут через Reality на VPS, non-managed домены уходят прямо в home WAN.
- Channel C — C1 home-first selected-client lane: selected device подключается
  к домашнему Naive/HTTPS-H2-CONNECT-like ingress, а router-side sing-box
  применяет тот же managed split, что и для других home-first каналов.

```text
Layer 0 endpoint/client routing
  -> optional rules on the endpoint:
       local/private/captive/trusted domestic -> DIRECT
       foreign/non-local/unknown/selected     -> MANAGED/PROXY
       FINAL                                  -> MANAGED/PROXY

Layer 1 managed channels
  Channel A -> endpoint -> home endpoint -> router -> VLESS+Reality+Vision -> VPS
  Channel B -> endpoint -> VLESS+XHTTP+TLS -> home endpoint -> router -> VLESS+Reality+Vision -> VPS
  Channel C -> endpoint -> Naive/HTTPS-H2-CONNECT-like -> home endpoint -> router -> VLESS+Reality+Vision -> VPS

Layer 2 home router
  LAN/Wi-Fi clients
    -> dnsmasq fills STEALTH_DOMAINS / VPN_STATIC_NETS
    -> br0 TCP nat REDIRECT :<lan-redirect-port>
    -> ASUS sing-box redirect inbound
    -> Channel A VLESS+Reality+Vision outbound
    -> VPS Caddy :443
    -> Xray Reality inbound
    -> Internet

  Remote QR clients
    -> home public IP :<home-reality-port>
    -> ASUS sing-box Reality inbound
    -> managed split:
         STEALTH_DOMAINS/VPN_STATIC_NETS -> Reality outbound to VPS
         other destinations              -> direct-out via home WAN

  Channel B selected device-client traffic
    -> VLESS+XHTTP+TLS profile to home public IP :<home-channel-b-port>
    -> router local Xray Channel B ingress
    -> local sing-box SOCKS inbound
    -> managed split (same rule-sets as Channel A)
    -> Channel A Reality outbound to VPS
    -> Caddy :443 -> Xray Reality inbound
    -> Internet

  Channel C1 selected device-client traffic
    -> Naive/HTTPS-H2-CONNECT-like profile to home public IP :<home-channel-c-public-port>
    -> router sing-box Naive inbound `channel-c-naive-in`
    -> managed split (same rule-sets as Channel A)
    -> Channel A Reality outbound to VPS
    -> Caddy :443 -> Xray Reality inbound
    -> Internet

Layer 3 VPS
  -> remote egress for selected managed traffic
  -> sites see VPS IP for managed traffic
```

## Layered Architecture

### Layer 0 — Endpoint / Client-Side Routing

Layer 0 is optional and lives on the endpoint device. Any client app or system
VPN profile that supports rule-based routing can decide whether a request goes
`DIRECT` or into a GhostRoute managed channel.

The production policy is country-neutral in the public docs:

```text
local/private/captive/trusted domestic -> DIRECT
foreign/non-local/unknown/selected     -> MANAGED/PROXY
FINAL                                  -> MANAGED/PROXY
```

Shadowrocket on iPhone/iPad/MacBook is the primary current example: its config
can use domain, IP, GEOIP and rule lists as the first routing layer. This is an
example implementation of Layer 0, not an Apple-only architecture constraint.
Country suffixes, GEOIP datasets and trusted service lists belong to deployment
profiles, not this general architecture document.

### Layer 1 — Managed Channels

Layer 1 is the set of managed paths selected by Layer 0 or by explicit local
choice. Channel A and B are production paths with different client scopes;
Channel C1 is planned until import, connection and real app egress are proven:

```text
Channel A: endpoint -> home endpoint -> router -> VLESS+Reality+Vision -> VPS
Channel B: endpoint -> VLESS+XHTTP+TLS -> home endpoint -> router -> VLESS+Reality+Vision -> VPS
Channel C: endpoint -> Naive/HTTPS-H2-CONNECT-like -> home endpoint -> router -> VLESS+Reality+Vision -> VPS
```

Channel A/B/C are home-first for managed traffic: the first network sees
endpoint -> home endpoint, not endpoint -> VPS. The VPS provider sees the home
router as the source for managed traffic.

### Layer 2 — Home Router

The home router terminates home-based channels and applies managed routing and
DNS policy. It owns dnsmasq/ipset classification, sing-box REDIRECT, home
Reality ingress, Channel B home ingress relay, Channel C1 Naive ingress, and
the Reality/Vision outbound to VPS. Router policy may further split managed and
non-managed destinations.

### Layer 3 — VPS

The VPS is remote egress for selected managed traffic. Sites and checkers see
the VPS IP for managed traffic; non-managed traffic selected as `DIRECT` or
home-WAN direct does not use the VPS egress.

## Channel A / Channel B / Channel C (текущая схема)

### Channel A

Для Channel A применяем home-first production-схему:

```text
Endpoint QR-клиент
  -> home public IP :<home-reality-port>
  -> ASUS sing-box Reality inbound
  -> managed split:
       STEALTH_DOMAINS / VPN_STATIC_NETS -> Reality outbound to VPS
       other destinations                 -> direct home WAN
  -> Интернет
```

### Channel B

В текущей схеме Channel B работает как отдельная production selected-client
home-first lane:

```text
Endpoint client
  -> VLESS + XHTTP + TLS to home ingress :<home-channel-b-port>
  -> router local Xray ingress `channel-b-home-in`
  -> local sing-box SOCKS (inbound `channel-b-relay-socks`)
  -> managed split по `stealth-domains` / `stealth-static`
       - managed    -> reality-out -> VPS Caddy :443 -> Xray Reality
       - non-managed -> direct-out -> home WAN
  -> Интернет
```

Как это понимать в проде:

- A/B/C дают первичный hop в home-network для managed endpoint traffic.
- У A managed split делается прямо на home Reality inbound.
- У B managed split делается после локального relay в sing-box.
- У C managed split делается прямо после sing-box Naive inbound.
- Власть над инкапсуляцией и правилами изолирована: `20-stealth-router.yml` для A и
  `21-channel-b-router.yml` / `22-channel-c-router.yml` для B/C.

### Channel C

Channel C работает как C1 home-first Naive lane:

```text
Endpoint client
  -> Naive / HTTPS-H2-CONNECT-like to home public IP :<home-channel-c-public-port>
  -> optional WAN REDIRECT to router internal :<home-channel-c-ingress-port>
  -> ASUS sing-box Naive inbound `channel-c-naive-in`
  -> managed split по `stealth-domains` / `stealth-static`
       - managed     -> reality-out -> VPS Caddy :443 -> Xray Reality
       - non-managed -> direct-out -> home WAN
  -> Интернет
```

C1 не имеет VPS-only Squid/stunnel/tinyproxy backend. Старый direct-to-VPS
Channel C дизайн удалён из активного кода.
C1 requires a Naive-capable sing-box build (`>= 1.13`) on the router; when C1 is
enabled the router config uses route `action: sniff` rules instead of legacy
inbound sniff fields so the same generated config can pass modern `sing-box
check`.

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
| `sing-box` on router | `redirect-in :<lan-redirect-port>`, home Reality inbound `:<home-reality-port>`, local SOCKS inbound for dnscrypt/Channel B relay, Channel C1 Naive inbound, managed split, Reality outbound to VPS |
| VPS host | Caddy :443 plus Xray Reality backend on localhost |
| Channel A | active production `sing-box -> VLESS+Reality+Vision` path |
| Channel B | production selected-client home-first lane: router XHTTP ingress + local relay -> sing-box Reality upstream |
| Channel C | planned C1 home-first Naive / HTTPS-H2-CONNECT-like device-client lane |
| `VPN_STATIC_NETS` | historical ipset name for static CIDR routes used by Channel A |
| `wgc1` NVRAM | cold fallback only, disabled in steady state |

## Ansible Deployment Boundaries

Разделение playbooks по каналам:

| Playbook | Scope | Ownership boundary |
|---|---|---|
| `10-stealth-vps.yml` | VPS base | Shared Caddy listener, Channel A/Reality backend, UFW, VPS health. |
| `11-channel-b-vps.yml` | VPS Channel B | Optional direct-XHTTP backend + Caddy route validation for direct Channel B mode. |
| `20-stealth-router.yml` | Router | Channel A router data plane and router runtime hooks. |
| `21-channel-b-router.yml` | Router Channel B | Channel B home XHTTP ingress + local relay add-on, isolated from Channel A REDIRECT ownership. |
| `22-channel-c-router.yml` | Router Channel C | Channel C1 home Naive ingress add-on, isolated from Channel A REDIRECT ownership. |

`21` включает home-first вариант Channel B на роутере. `11` нужен только для
direct-XHTTP варианта Channel B.
`22` включает home-first Channel C1 на роутере.
Эти playbooks не должны мутировать Channel A/Reality state.

## Routing Matrix

| Source | Selector | Mechanism | Egress |
|---|---|---|---|
| LAN/Wi-Fi TCP (`br0`) | `STEALTH_DOMAINS`, `VPN_STATIC_NETS` | nat REDIRECT `:<lan-redirect-port>` | Channel A sing-box -> Reality |
| LAN/Wi-Fi UDP/443 (`br0`) | same sets | DROP | client fallback to TCP |
| Endpoint QR/VLESS | generated Reality profile plus managed rule-sets | TCP/<home-reality-port> to home router | managed -> Reality; non-managed -> home WAN |
| Channel B selected-client profile | selected device only | TCP/<home-channel-b-port> to home router, then local relay into sing-box SOCKS with managed split | production home-first egress |
| Channel C1 selected-client profile | selected device only | TCP/<home-channel-c-public-port> to home router, then sing-box Naive inbound with managed split | planned home-first egress |
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

### Endpoint Home QR

```text
client app
  -> VLESS+Reality to home public IP :<home-reality-port>
  -> router Reality inbound validates router-side UUID/key/short_id
  -> if destination matches STEALTH_DOMAINS or VPN_STATIC_NETS:
       sing-box Reality outbound to VPS -> VPS exit
  -> otherwise:
       sing-box direct-out -> home WAN exit
```

The first network sees endpoint -> home endpoint traffic for Channel A/B managed
sessions. Websites still see the VPS exit IP for managed traffic; non-managed
destinations see the home WAN IP. See [modules/routing-core/docs/network-flow-and-observer-model.md](/modules/routing-core/docs/network-flow-and-observer-model.md)
for the full workflow and observer table.

### Router-Originated Traffic

Router `OUTPUT` is not transparently captured. Capturing router-originated
traffic globally can loop sing-box outbound connections. Diagnostics that need
Reality should use an explicit proxy or client profile.

### Channel B/C Device Clients

Channel B is production for selected device-client profiles and is documented
separately from normal Home Reality and emergency Reality profiles. Channel C is
C1 home-first Naive and remains planned until its import, connection and real
app egress proof is complete.

Current Channel B shape is home-first:

```text
client app
  -> VLESS+XHTTP+TLS to home public IP :<home-channel-b-port>
  -> router local Xray Channel B ingress
  -> router local relay -> sing-box SOCKS inbound
  -> managed split (same rule-sets as Channel A)
  -> sing-box Reality outbound -> VPS Caddy/Xray Reality
  -> Internet
```

This keeps Channel B home-first while giving it a different first-hop
fingerprint from Channel A.

Current Channel C shape is home-first:

```text
client app
  -> Naive/HTTPS-H2-CONNECT-like to home public IP :<home-channel-c-public-port>
  -> router sing-box Naive inbound
  -> managed split (same rule-sets as Channel A)
  -> sing-box Reality outbound -> VPS Caddy/Xray Reality
  -> Internet
```

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
- Channel B is not required for Channel A health, and Channel C is not required
  for production health until promoted; any channel enablement must keep Channel
  A REDIRECT/TUN/DNS ownership unchanged and remain explicit (`11` + `21` for B,
  `22` for C)
