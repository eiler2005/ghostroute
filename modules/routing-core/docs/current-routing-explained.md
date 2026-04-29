# Current Routing Explained

## Что сейчас сделано

GhostRoute больше не использует active Legacy WireGuard. Текущая модель:

Короткий принципиальный контракт по A/B/C вынесен в
[docs/routing-policy-principles.md](/docs/routing-policy-principles.md). Этот
файл ниже описывает текущую реализацию того же контракта.

```text
LAN/Wi-Fi TCP             -> STEALTH_DOMAINS/VPN_STATIC_NETS
                           -> sing-box REDIRECT :<lan-redirect-port> -> VLESS+Reality -> VPS

LAN/Wi-Fi UDP/443         -> DROP for managed destinations -> client TCP fallback

Remote QR mobile clients  -> home IP :<home-reality-port>
                           -> router Reality inbound
                           -> managed split:
                                STEALTH_DOMAINS/VPN_STATIC_NETS -> Reality outbound -> VPS
                                other destinations -> direct-out -> home WAN

DNS managed names         -> dnsmasq -> vps-dns-in -> hijack-dns
                           -> vps-dns-server -> Reality outbound -> VPS Unbound
DNS RU/direct/default     -> dnsmasq -> home/RF/default resolver

router OUTPUT             -> main routing unless explicitly proxied
```

| Источник | Домены | Static CIDR | Egress |
|---|---|---|---|
| `br0` | `STEALTH_DOMAINS` | `VPN_STATIC_NETS` | sing-box REDIRECT `:<lan-redirect-port>` |
| mobile QR | generated VLESS/Reality profile + `STEALTH_DOMAINS` | `VPN_STATIC_NETS` | home ASUS `:<home-reality-port>` -> managed split |
| `OUTPUT` | no transparent capture | no transparent capture | main routing / explicit proxy |

`wgs1`/`wgc1` are decommissioned in normal operation. `wgc1_*` NVRAM is preserved
only for `modules/recovery-verification/router/emergency-enable-wgc1.sh`.

## Кто что видит

1. **Мобильный оператор iPhone.** Для нового `iphone-*` QR он видит соединение с
   домашним российским IP роутера на TCP/<home-reality-port>. Он не видит прямого подключения
   iPhone к VPS.

2. **Сайт или checker.** Если домен идёт через managed route, финальный выход —
   VPS host. Это нормально для YouTube/Googlevideo/AI/dev/social-доменов,
   которые сознательно отправлены через Reality.

3. **Российские сервисы вне managed route.** Домены, которых нет в
   `STEALTH_DOMAINS`/`VPN_STATIC_NETS`, идут обычным домашним WAN-выходом.
   Это относится и к домашней LAN, и к traffic, который пришёл через mobile
   Home Reality ingress.

Подробная схема от клиента до конечного сайта, включая процессы, порты и
observer model: [modules/routing-core/docs/network-flow-and-observer-model.md](/modules/routing-core/docs/network-flow-and-observer-model.md).

## Доменный каталог

Источник правды один:

```text
configs/dnsmasq-stealth.conf.add
```

Пример:

```text
ipset=/youtube.com/STEALTH_DOMAINS
```

`ipset=/youtube.com/STEALTH_DOMAINS` покрывает `youtube.com`,
`www.youtube.com`, `music.youtube.com` и будущие `*.youtube.com`.

`api.ipify.org` закреплён через `ipset=/ipify.org/STEALTH_DOMAINS` как
проверочный managed-домен. Это только canary: если всё собрано правильно,
LAN/Wi-Fi и mobile Channels A/B/C должны показывать один и тот же VPS egress на
этом checker. Общий контракт шире: любой managed-домен или static CIDR после
попадания на роутер должен идти по тем же router-side правилам managed split,
что и Wi-Fi/LAN.

Источников managed policy несколько:

- ручной каталог `configs/dnsmasq-stealth.conf.add` плюс optional private
  catalog;
- auto-discovered `/jffs/configs/dnsmasq-autodiscovered.conf.add`;
- static CIDR catalog `configs/static-networks.txt` (`VPN_STATIC_NETS`);
- direct/skip policy `configs/domains-no-vpn.txt` и автоматический skip
  российских TLD.

Все managed-источники зеркалятся в sing-box rule-sets для mobile Channels A/B/C.
Skip/direct источники не должны auto-добавляться в managed route.

`VPN_DOMAINS` больше не должен существовать в steady state.

## Две точки отбора трафика

Политическое намерение одно: managed-домены и static CIDR должны уйти в VPS.
Но runtime-точек отбора две, потому что Wi-Fi/LAN и mobile ingress попадают в
роутер по-разному.

Wi-Fi/LAN отбирается через `dnsmasq + ipset + iptables`:

```text
Wi-Fi/LAN device
  -> router DNS / dnsmasq
  -> dnsmasq резолвит managed-домен
  -> кладёт IP в STEALTH_DOMAINS
  -> iptables REDIRECT отправляет TCP в sing-box redirect-in
  -> reality-out -> VPS
```

Это нужно потому, что обычный LAN-трафик изначально ещё не внутри sing-box.
Сначала роутер ловит его по IP через dnsmasq-populated ipset.

Mobile/selected-client трафик отбирается уже внутри sing-box:

```text
iPhone LTE / selected endpoint
  -> Channel A/B/C ingress on router
  -> sing-box sniff: TLS SNI / HTTP Host
  -> match stealth-domains.json / stealth-static.json
  -> reality-out -> VPS
```

Это не ручное дублирование политики. Оператор ведёт один managed catalog, а
deploy/`update-singbox-rule-sets.sh` делают два runtime-представления:

```text
configs/dnsmasq-stealth.conf.add
  -> STEALTH_DOMAINS для Wi-Fi/LAN
  -> stealth-domains.json для mobile Channels A/B/C
```

## DNS

Supported-схема теперь policy-based, а не "весь DNS через VPS":

```text
managed/foreign domain
  -> dnsmasq server=/domain/127.0.0.1#<vps-dns-forward-port>
  -> sing-box vps-dns-in
  -> hijack-dns
  -> sing-box DNS server vps-dns-server
  -> detour reality-out
  -> VPS Unbound :15353

RU/direct/default domain
  -> dnsmasq default upstream
  -> home/RF/default resolver
```

For managed DNS transport, sing-box uses `hijack-dns` on `vps-dns-in` and an
internal TCP DNS server with `detour: reality-out`. This does not send
RU/default domains to the VPS; it only transports managed DNS across Reality.

Reality on the VPS is currently handled by the existing `3x-ui`/Xray Docker
container behind Caddy. The managed DNS target is therefore the configured
`vps_unbound_reality_target_host:15353`, not container-local `127.0.0.1`.
UFW allows `15353` only from the Xray Docker bridge, while public DNS
`53/tcp,udp` stays denied.

Wi-Fi/LAN plain DNS is captured back to router dnsmasq. Mobile Channel A/B/C
plain DNS `:53`, once it reaches sing-box ingress, is rewritten to the same
router-local dnsmasq path. From that point the split is identical for Wi-Fi and
mobile channels.

IPv6 выключен, поэтому dnsmasq фильтрует AAAA:

```text
filter-AAAA
```

Legacy per-domain upstreams через `@wgc1` отключены. Новые домены так не
добавляются.

## Static Networks

`configs/static-networks.txt` содержит CIDR ranges для direct-IP flows. Имя
ipset осталось историческим:

```text
br0 TCP     -> VPN_STATIC_NETS -> nat REDIRECT :<lan-redirect-port> -> sing-box -> Reality
br0 UDP/443 -> VPN_STATIC_NETS -> DROP, чтобы приложение ушло на TCP
```

## Проверка Live State

```bash
ROUTER=192.168.50.1 ./verify.sh
cd ansible && ansible-playbook playbooks/99-verify.yml --limit routers
```

На роутере:

```sh
nvram get wgs1_enable
nvram get wgc1_enable
wg show
ipset list VPN_DOMAINS
ipset list STEALTH_DOMAINS | head
ipset list VPN_STATIC_NETS | head
iptables -t nat -S PREROUTING | grep <lan-redirect-port>
iptables -S FORWARD | grep 'dport 443'
dig @192.168.50.1 youtube.com AAAA +short
```

Expected:

- `wgs1_enable=0`
- `wgc1_enable=0`
- `wg show` has no active WireGuard interfaces
- `VPN_DOMAINS` does not exist
- `STEALTH_DOMAINS` and `VPN_STATIC_NETS` exist
- TCP REDIRECT and UDP/443 DROP rules are present
- YouTube AAAA answer is empty while IPv6 is disabled
