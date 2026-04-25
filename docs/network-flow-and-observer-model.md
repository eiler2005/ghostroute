# Network Flow and Observer Model

Этот документ является человекочитаемой картой текущей production-схемы
GhostRoute: какие клиенты куда подключаются, какие процессы участвуют на
роутере/VPS, где принимается routing decision, и что видит каждая внешняя
сторона.

## Executive Summary

В steady state активны два сценария:

1. Домашние Wi-Fi/LAN устройства используют transparent routing на роутере.
   Только managed-направления из `STEALTH_DOMAINS` и `VPN_STATIC_NETS` уходят
   через VPS Reality. Остальное идет напрямую через домашний WAN.

2. iPhone/Mac вне дома подключаются не к VPS напрямую, а к домашнему ASUS на
   TCP/<home-reality-port>. После входа в домашний роутер применяется тот же split policy:
   managed-направления идут через VPS, non-managed-направления идут через
   домашний WAN.

Ключевой результат: для LTE-оператора первый hop мобильного клиента выглядит
как domestic `iPhone -> home RU IP`. Для сайтов страна/IP зависят от того,
попал ли конечный домен/IP в managed catalog.

## Components

| Layer | Component | Role |
|---|---|---|
| Client outside home | OneXray / VLESS+Reality profile | Подключается к домашнему ASUS на TCP/<home-reality-port> |
| Client at home | Browser/app on Wi-Fi/LAN | Работает без VPN-приложения; роутер принимает решение прозрачно |
| Router OS | ASUS RT-AX88U Pro + Asuswrt-Merlin | dnsmasq, ipset, iptables, sing-box hooks |
| Router DNS | `dnsmasq` | Наполняет `STEALTH_DOMAINS`, фильтрует AAAA while IPv6 is off |
| Router DNS upstream | `dnscrypt-proxy` on `127.0.0.1:5354` | Upstream DNS, при необходимости через локальный sing-box SOCKS |
| Router packet policy | `iptables` + `ipset` | REDIRECT TCP to `:<lan-redirect-port>`, DROP managed UDP/443, allow TCP/<home-reality-port> |
| Router proxy | `sing-box` single process | `redirect-in`, `reality-in`, `reality-out`, `direct-out` |
| VPS ingress | VPS VPS + Caddy L4 TCP/443 | Принимает router-side Reality connection |
| VPS proxy | Xray Reality inbound | Финальный Reality ingress перед выходом в интернет |
| Cold fallback | Preserved `wgc1_*` NVRAM | Не активен; включается только emergency script вручную |

## Scenario A: Home Wi-Fi / LAN

### Managed Destination

Пример: YouTube, Googlevideo, selected AI/dev/social domains, или IP из
`VPN_STATIC_NETS`.

```text
Laptop / TV / phone at home
  -> DNS query to router
  -> dnsmasq
       -> domain matches configs/dnsmasq-stealth.conf.add
       -> resolved IPv4 is added to STEALTH_DOMAINS
  -> app opens TCP connection to matched IPv4
  -> ASUS iptables PREROUTING on br0
       -> match STEALTH_DOMAINS or VPN_STATIC_NETS
       -> REDIRECT to 127.0.0.1:<lan-redirect-port>
  -> sing-box redirect-in
  -> sing-box route rule: managed rule-set
  -> sing-box reality-out
  -> VPS VPS TCP/443
  -> Caddy L4
  -> Xray Reality inbound
  -> target site
```

Expected website-facing exit: VPS/datacenter IP.

UDP/443 for managed destinations is dropped on the router. This forces apps to
fall back from QUIC/HTTP3 to TCP, where the transparent REDIRECT path can carry
the flow.

### Non-Managed Destination

Пример: обычный российский сайт, которого нет в `STEALTH_DOMAINS` и чьи IP не
попали в `VPN_STATIC_NETS`.

```text
Laptop / TV / phone at home
  -> DNS query to router
  -> dnsmasq
       -> no managed match
  -> app opens connection
  -> ASUS router
       -> no STEALTH_DOMAINS/VPN_STATIC_NETS match
  -> home ISP WAN
  -> target site
```

Expected website-facing exit: домашний российский WAN IP.

## Scenario B: Remote iPhone / Mac over LTE or Other Networks

### First Hop: Mobile Client to Home

```text
iPhone LTE / Mac outside home
  -> OneXray profile generated from ansible-vault
  -> VLESS+Reality TCP/<home-reality-port>
  -> home public RU IP
  -> ASUS router WAN
  -> sing-box reality-in
```

The mobile profile uses router-side Reality identity:

- router-side UUIDs, not VPS-side client UUIDs
- router-side Reality keypair, not VPS-side keypair
- router-side short IDs
- TCP/<home-reality-port> on home WAN

This means the LTE carrier sees the phone connecting to the home Russian IP,
not to the VPS VPS.

### Managed Destination from Mobile

Пример: YouTube video traffic from `iphone-1-home`.

```text
iPhone LTE
  -> home public RU IP TCP/<home-reality-port>
  -> ASUS sing-box reality-in
  -> sing-box route rule:
       destination matches STEALTH_DOMAINS or VPN_STATIC_NETS rule-set
  -> sing-box reality-out
  -> VPS VPS TCP/443
  -> Caddy L4
  -> Xray Reality inbound
  -> YouTube / checker / managed site
```

Expected website-facing exit: VPS/datacenter IP.

### Non-Managed Destination from Mobile

Пример: Russian service intentionally left outside the managed catalog.

```text
iPhone LTE
  -> home public RU IP TCP/<home-reality-port>
  -> ASUS sing-box reality-in
  -> sing-box route rule:
       no STEALTH_DOMAINS or VPN_STATIC_NETS match
  -> sing-box direct-out
  -> home ISP WAN
  -> target site
```

Expected website-facing exit: домашний российский WAN IP.

This is the important post-cleanup nuance: Home Reality ingress is not an
all-traffic relay to VPS. It is a home ingress plus split routing policy.

## Scenario C: Router-Originated Traffic

```text
Router process
  -> main routing table by default
  -> explicit proxy only when a tool is configured that way
```

Router `OUTPUT` is intentionally not globally captured. Transparent capture of
router-originated traffic can loop sing-box outbound connections.

## Who Sees What

| Observer | Managed mobile traffic | Non-managed mobile traffic | Home LAN managed traffic | Home LAN non-managed traffic |
|---|---|---|---|---|
| LTE carrier | iPhone -> home RU IP TCP/<home-reality-port> | iPhone -> home RU IP TCP/<home-reality-port> | n/a | n/a |
| Home ISP | home router -> VPS TCP/443 | home router -> target site directly | home router -> VPS TCP/443 | home router -> target site directly |
| VPS VPS | connection from home router | does not see this flow | connection from home router | does not see this flow |
| Target website | VPS/datacenter IP | home Russian WAN IP | VPS/datacenter IP | home Russian WAN IP |
| Router logs | destination metadata and selected outbound | destination metadata and `direct-out` | REDIRECT/reality metadata | normal WAN path |
| Router traffic report | TCP/<home-reality-port> byte counters + `reality-out` connection counts | TCP/<home-reality-port> byte counters + `direct-out` connection counts | LAN mangle byte counters | LAN direct WAN byte counters |

HTTPS content remains encrypted end-to-end from the application perspective.
Observers can still see network metadata such as IPs, ports, timing and volume.

## Checker Interpretation

Checker result depends on whether the checker domain itself is managed.

```text
checker domain in STEALTH_DOMAINS or VPN_STATIC_NETS
  -> checker sees VPS/datacenter IP

checker domain not managed
  -> checker sees home Russian WAN IP
```

So a result like "VPS datacenter / suspicious" is expected only
for managed checker traffic. It describes the final website-facing exit, not
what the LTE carrier saw as the first hop.

## Current Steady-State Invariants

- One router-side `sing-box` process handles both LAN and mobile ingress.
- LAN managed TCP enters `redirect-in` on `:<lan-redirect-port>`.
- Mobile clients enter `reality-in` on TCP/<home-reality-port>.
- Managed destinations route to `reality-out`.
- Non-managed destinations from mobile route to `direct-out`.
- `STEALTH_DOMAINS` is the active domain set.
- `VPN_STATIC_NETS` remains as the historical static CIDR set name.
- `VPN_DOMAINS` is absent.
- IPv6 is disabled and AAAA answers are filtered.
- Channel A WireGuard `wgs1`/`wgc1` is inactive; `wgc1_*` NVRAM is cold fallback only.

## Useful Checks

```bash
ROUTER=192.168.50.1 ./verify.sh
./scripts/router-health-report
./scripts/traffic-report
```

On the router:

```sh
netstat -lntp | grep -E ':(<lan-redirect-port>|<home-reality-port>) '
ipset list STEALTH_DOMAINS | head
ipset list VPN_STATIC_NETS | head
ipset list VPN_DOMAINS
tail -100 /opt/var/log/sing-box.log | grep -E 'reality-in|redirect-in|reality-out|direct-out'
iptables-save -t mangle -c | grep -E 'RC_LAN_REALITY|RC_MOBILE_REALITY'
```

Expected:

- `:<lan-redirect-port>` and `:<home-reality-port>` listeners exist.
- `STEALTH_DOMAINS` and `VPN_STATIC_NETS` exist.
- `VPN_DOMAINS` does not exist.
- Managed mobile flows show `reality-in -> reality-out`.
- Non-managed mobile flows show `reality-in -> direct-out`.

`./scripts/traffic-report` includes mobile Home Reality byte totals and
connection attribution. Bytes come from encrypted TCP/<home-reality-port> counters
(`RC_MOBILE_REALITY_IN/OUT`) keyed by remote source IP/profile label. The
`reality-out` vs `direct-out` split still comes from `sing-box.log` connection
counts, because sing-box logs do not expose per-profile byte totals in the
current setup. If multiple mobile profiles share the same carrier NAT IP, the
byte row is shown under a combined source label.
