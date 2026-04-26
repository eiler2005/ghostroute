# Управление доменами и IP-сетями

## Главное правило

Активный managed domain catalog теперь один:

| Файл | ipset | Для кого | Egress |
|---|---|---|---|
| `configs/dnsmasq-stealth.conf.add` | `STEALTH_DOMAINS` | домашняя LAN/Wi-Fi и mobile Home Reality split | managed -> Reality; non-managed -> direct |

Advisory-only идеи по сужению каталога лежат в
[stealth-domains-curation-audit.md](stealth-domains-curation-audit.md). Этот
документ ничего не удаляет из runtime catalog; он фиксирует evidence и будущие
предложения.

`VPN_DOMAINS` удалён из нормальной схемы. `VPN_STATIC_NETS` остаётся, потому что
Channel B использует этот исторически названный ipset для direct-IP/static CIDR.

Remote mobile QR/VLESS-клиенты не зависят от ipset на первом hop: они идут на
домашний ASUS `:<home-reality-port>` и попадают в router-side Reality inbound. После этого
sing-box использует rule-set, собранный из `STEALTH_DOMAINS` и
`VPN_STATIC_NETS`: managed-направления уходят в Reality outbound до VPS,
non-managed-направления уходят через `direct-out` и домашний WAN.

Полная схема: [network-flow-and-observer-model.md](network-flow-and-observer-model.md).

## Добавить домен вручную

Добавьте только `STEALTH_DOMAINS`:

```text
# configs/dnsmasq-stealth.conf.add
ipset=/example.com/STEALTH_DOMAINS
```

Не добавляйте:

```text
ipset=/example.com/VPN_DOMAINS
server=/example.com/1.1.1.1@wgc1
server=/example.com/9.9.9.9@wgc1
```

DNS upstream общий:

```text
server=127.0.0.1#<dnscrypt-port>
```

## Deploy

```bash
ROUTER=192.168.50.1 ./deploy.sh
cd ansible
ansible-playbook playbooks/20-stealth-router.yml
ansible-playbook playbooks/99-verify.yml
```

`deploy.sh` installs `/jffs/configs/dnsmasq-stealth.conf.add` and keeps only this
include in the aggregate dnsmasq config:

```text
conf-file=/jffs/configs/dnsmasq-stealth.conf.add
```

The same repo catalogs feed mobile Home Reality split routing. During deploy,
`modules/routing-core/router/update-singbox-rule-sets.sh` regenerates sing-box source rule-sets from:

- `configs/dnsmasq-stealth.conf.add` -> `stealth-domains.json`
- `configs/static-networks.txt` -> `stealth-static.json`

Do not edit `/opt/etc/sing-box/rule-sets/*.json` manually; they are generated
artifacts and will be overwritten.

## Проверить домен

На роутере:

```sh
nslookup example.com 127.0.0.1
ipset test STEALTH_DOMAINS <resolved-ip>
iptables -t nat -S PREROUTING | grep <lan-redirect-port>
```

Expected:

- resolved IPv4 is in `STEALTH_DOMAINS`;
- LAN TCP REDIRECT rules for `STEALTH_DOMAINS` and `VPN_STATIC_NETS` exist;
- `VPN_DOMAINS` does not exist.

## Добавить статическую сеть

Статические сети нужны, если сервис устанавливает direct-IP соединения без
надёжного DNS-события.

```text
# configs/static-networks.txt
203.0.113.0/24
```

После deploy:

```text
br0 TCP     -> VPN_STATIC_NETS -> nat REDIRECT :<lan-redirect-port> -> sing-box -> Reality
br0 UDP/443 -> VPN_STATIC_NETS -> DROP -> client fallback to TCP
```

Проверка:

```sh
ipset test VPN_STATIC_NETS 203.0.113.1
iptables -t nat -S PREROUTING | grep VPN_STATIC_NETS
```

## Удалить домен или сеть

1. Удалите домен из `configs/dnsmasq-stealth.conf.add`.
2. Если удаляется CIDR, удалите его из `configs/static-networks.txt`.
3. Запустите deploy и verify.

Уже разрезолвленные IP могут оставаться в live `STEALTH_DOMAINS` до очистки
ipset, перезапуска или истечения.

## Auto-Discovery

`domain-auto-add.sh` каждый час анализирует DNS-лог и пишет auto-домены в:

```text
/jffs/configs/dnsmasq-autodiscovered.conf.add
```

Новая запись выглядит так:

```text
ipset=/auto-example.com/STEALTH_DOMAINS
```

Скрипт больше не пишет `VPN_DOMAINS` и не генерирует `server=...@wgc1`.
Geo-probe по-прежнему может добавить домен, но только в `STEALTH_DOMAINS`.

Команды:

```bash
./modules/dns-catalog-intelligence/bin/domain-report
./modules/dns-catalog-intelligence/bin/domain-report --log
./modules/dns-catalog-intelligence/bin/domain-report --cleanup
./modules/dns-catalog-intelligence/bin/domain-report --candidates
```

## Cold Fallback

`wgc1_*` NVRAM сохранён, но нормальная эксплуатация держит `wgc1_enable=0`.
Аварийный возврат делается только вручную:

```sh
/jffs/scripts/emergency-enable-wgc1.sh --dry-run
/jffs/scripts/emergency-enable-wgc1.sh --enable
/jffs/scripts/emergency-enable-wgc1.sh --disable
```

`--enable` создаёт WireGuard traffic, поэтому не запускайте его для обычной
проверки.
