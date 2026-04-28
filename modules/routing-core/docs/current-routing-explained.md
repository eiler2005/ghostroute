# Current Routing Explained

## Что сейчас сделано

GhostRoute больше не использует active Legacy WireGuard. Текущая модель:

```text
LAN/Wi-Fi TCP             -> STEALTH_DOMAINS/VPN_STATIC_NETS
                           -> sing-box REDIRECT :<lan-redirect-port> -> VLESS+Reality -> VPS

LAN/Wi-Fi UDP/443         -> DROP for managed destinations -> client TCP fallback

Remote QR mobile clients  -> home IP :<home-reality-port>
                           -> router Reality inbound
                           -> managed split:
                                STEALTH_DOMAINS/VPN_STATIC_NETS -> Reality outbound -> VPS
                                other destinations -> direct-out -> home WAN

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

`VPN_DOMAINS` больше не должен существовать в steady state.

## DNS

Supported-схема:

```text
dnsmasq -> dnscrypt-proxy 127.0.0.1:<dnscrypt-port>
dnscrypt-proxy -> sing-box SOCKS 127.0.0.1:<router-socks-port>
```

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
