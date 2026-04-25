# Управление доменами и IP-сетями

## Главное правило

Managed domain catalog теперь состоит из двух активных dnsmasq-каталогов:

| Файл | ipset | Для кого | Egress |
|---|---|---|---|
| `configs/dnsmasq.conf.add` | `VPN_DOMAINS` | legacy remote `wgs1` clients | `wgc1` |
| `configs/dnsmasq-stealth.conf.add` | `STEALTH_DOMAINS` | LAN `br0` clients | sing-box REDIRECT `:<lan-redirect-port>` → Reality |

`configs/dnsmasq-vpn-upstream.conf.add` больше не является местом, куда добавляют `server=/domain/1.1.1.1@wgc1`. Этот файл оставлен как retired compatibility block.

Remote QR/VLESS-клиенты (`iphone-*`, `macbook`) не зависят от этих ipset для первого hop: они подключаются к домашнему ASUS на `:443`, попадают в `sing-box` home Reality inbound и затем выходят через существующий Reality outbound на VPS.

---

## Добавить домен вручную

### 1. Добавить в `VPN_DOMAINS`

```text
# configs/dnsmasq.conf.add
ipset=/example.com/VPN_DOMAINS
```

Это нужно для remote WireGuard-server клиентов, которые приходят через `wgs1` и продолжают использовать `wgc1`.
Это legacy/fallback путь; новые мобильные клиенты должны использовать Reality QR до домашнего IP.

### 2. Добавить в `STEALTH_DOMAINS`

```text
# configs/dnsmasq-stealth.conf.add
ipset=/example.com/STEALTH_DOMAINS
```

Это нужно для домашней LAN. TCP-соединения к этим IP будут перехвачены локальным sing-box REDIRECT на `:<lan-redirect-port>`; UDP/443 будет отклонен, чтобы приложения ушли с QUIC на TCP.

### 3. Не добавлять legacy `@wgc1`

Не добавляйте:

```text
server=/example.com/1.1.1.1@wgc1
server=/example.com/9.9.9.9@wgc1
```

DNS upstream теперь общий:

```text
server=127.0.0.1#5354
```

### 4. Deploy

```bash
ROUTER=192.168.50.1 ./deploy.sh
cd ansible
ansible-playbook playbooks/20-stealth-router.yml
ansible-playbook playbooks/99-verify.yml
```

### 5. Проверить

На роутере:

```sh
nslookup example.com 127.0.0.1
ipset list VPN_DOMAINS | grep <resolved-ip>
ipset list STEALTH_DOMAINS | grep <resolved-ip>
ip route get <resolved-ip> mark 0x1000
iptables -t nat -S PREROUTING | grep <lan-redirect-port>
```

Expected:

- `mark 0x1000` routes via `wgc1`.
- LAN TCP REDIRECT rules for `STEALTH_DOMAINS` and `VPN_STATIC_NETS` exist.

---

## Добавить статическую сеть

Статические сети нужны, если сервис устанавливает direct-IP соединения без надежного DNS-события.

```text
# configs/static-networks.txt
203.0.113.0/24
```

После deploy один и тот же CIDR будет использовать разные egress paths:

```text
br0 TCP     -> VPN_STATIC_NETS -> nat REDIRECT :<lan-redirect-port> -> sing-box -> Reality
br0 UDP/443 -> VPN_STATIC_NETS -> DROP -> client fallback to TCP
wgs1        -> VPN_STATIC_NETS -> 0x1000 -> wgc1
```

Deploy:

```bash
ROUTER=192.168.50.1 ./deploy.sh
cd ansible && ansible-playbook playbooks/99-verify.yml
```

Проверка:

```sh
ipset test VPN_STATIC_NETS 203.0.113.1
iptables -t nat -S PREROUTING | grep VPN_STATIC_NETS
ip route get 203.0.113.1 mark 0x1000
```

---

## Удалить домен или сеть

1. Удалите домен из `configs/dnsmasq.conf.add`.
2. Удалите домен из `configs/dnsmasq-stealth.conf.add`.
3. Если удаляется CIDR, удалите его из `configs/static-networks.txt`.
4. Запустите deploy и verify.

```bash
ROUTER=192.168.50.1 ./deploy.sh
cd ansible && ansible-playbook playbooks/20-stealth-router.yml
ansible-playbook playbooks/99-verify.yml
```

Важно:

- Уже разрезолвленные IP могут оставаться в live `ipset` до перезапуска/очистки/истечения.
- `VPN_STATIC_NETS` пересобирается из файла при запуске `firewall-start`.
- `STEALTH_DOMAINS` и `VPN_DOMAINS` наполняются DNS-событиями.

---

## Auto-discovery

`domain-auto-add.sh` каждый час анализирует DNS-лог и пишет auto-домены в router-local файл:

```text
/jffs/configs/dnsmasq-autodiscovered.conf.add
```

Текущая запись для auto-domain выглядит так:

```text
ipset=/auto-example.com/VPN_DOMAINS
ipset=/auto-example.com/STEALTH_DOMAINS
```

То есть auto-discovery автоматически обслуживает оба канала:

- remote `wgs1` clients через `VPN_DOMAINS` -> `wgc1`
- LAN через `STEALTH_DOMAINS` -> REDIRECT `:<lan-redirect-port>` -> Reality

Auto-discovery больше не пишет `server=/domain/...@wgc1`.

---

## Когда домен, когда static network

| Ситуация | Что добавлять |
|---|---|
| Web/API сервис с нормальным DNS | Domain в оба каталога |
| Сервис с direct-IP flows | Domain в оба каталога + CIDR в `static-networks.txt` |
| Shared CDN | Сначала domain; CIDR только при доказанной необходимости |
| Один конкретный IP | `/32` в `static-networks.txt` |
| Российский сервис или то, что нельзя маршрутизировать | `configs/domains-no-vpn.txt` |

---

## Cleanup Review

Перед крупными изменениями каталога:

```bash
./scripts/catalog-review-report
```

Отчет ничего не меняет в runtime. Он показывает:

- широкие static CIDR, которые стоит держать под наблюдением
- child domains, уже покрытые parent-rule
- advisory-only рекомендации

Сохранить snapshot:

```bash
./scripts/catalog-review-report --save
```

---

## Конвенции

- Добавляйте managed-домен в `VPN_DOMAINS` и `STEALTH_DOMAINS` одновременно.
- Не добавляйте новые `@wgc1` DNS upstreams.
- Группируйте домены по сервисам.
- После правок запускайте `deploy -> 20-stealth-router -> 99-verify`.
- Не коммитьте real client profiles, VLESS URI, QR payloads или vault secrets.
