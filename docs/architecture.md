# Архитектура маршрутизации

## Общий принцип

На роутере работает цепочка из четырёх компонентов, которая прозрачно отправляет трафик выбранных сервисов через WireGuard VPN:

```
                            dnsmasq
Устройство ──DNS-запрос──▶ (резолвит домен, добавляет IP в ipset)
                              │
                              ▼
                       ipset VPN_DOMAINS
                       ipset VPN_STATIC_NETS
                              │
                              ▼
                     iptables -t mangle
                  (помечает пакеты fwmark 0x1000)
                              │
                              ▼
                     ip rule fwmark 0x1000
                  (отправляет в таблицу wgc1)
                              │
                              ▼
                      WireGuard WGC1
                    (трафик уходит в VPN)
```

## Три точки входа в routing engine

Одна и та же destination-based split-routing логика теперь обслуживает три разных источника трафика:

1. `LAN/Wi-Fi` клиенты на `br0`
2. raw `WireGuard server` клиенты на `wgs1`
3. локально сгенерированный трафик роутера в `OUTPUT` (в том числе `Tailscale Exit Node`)

Упрощённая схема:

```text
LAN client
  -> br0
  -> PREROUTING
  -> RC_VPN_ROUTE
  -> wgc1 | wan0

Raw WireGuard server client
  -> wgs1
  -> PREROUTING
  -> RC_VPN_ROUTE
  -> wgc1 | wan0

Tailscale Exit Node
  -> tailscaled / local socket
  -> OUTPUT
  -> RC_VPN_ROUTE
  -> wgc1 | wan0
```

Из-за этого в `firewall-start` нужны три hooks:

```sh
iptables -t mangle -A PREROUTING -i br0 -j RC_VPN_ROUTE
iptables -t mangle -A PREROUTING -i wgs1 -j RC_VPN_ROUTE
iptables -t mangle -A OUTPUT -j RC_VPN_ROUTE
```

## Два пути попадания в VPN

### Путь 1: Доменный (dnsmasq + ipset)

1. Устройство в сети запрашивает DNS (например, `youtube.com`).
2. `dnsmasq` на роутере видит запрос и резолвит домен.
3. Если домен подходит под правило `ipset=/youtube.com/VPN_DOMAINS`, результирующий IP добавляется в набор `VPN_DOMAINS`.
4. `iptables` в цепочке `RC_VPN_ROUTE` помечает пакеты к этому IP меткой `0x1000`.
5. `ip rule` отправляет помеченные пакеты в таблицу маршрутизации `wgc1`.
6. Трафик уходит через WireGuard.

Правило `ipset=/youtube.com/VPN_DOMAINS` покрывает сам домен **и все его поддомены** (`*.youtube.com`). Новые поддомены ловятся автоматически.

### Путь 2: Статический (static-networks.txt)

Для сервисов, которые используют прямые IP-подключения (Telegram, imo, Apple Podcasts), одних доменов недостаточно. Для них используется отдельный ipset `VPN_STATIC_NETS` типа `hash:net`.

Примеры:
- **Telegram** — клиент подключается напрямую к IP-диапазонам, минуя DNS
- **imo** — web/auth часть живёт на `imo.im`, но часть пользовательского трафика и tunnel/auth entrypoints использует выделенные сети `AS36131 / PageBites`
- **Apple (17.0.0.0/8)** — iPhone устанавливает соединение с Apple-серверами (`bag.itunes.apple.com`, `amp-api`, `entitlements`) раньше, чем DNS-запрос успевает заполнить ipset. Весь блок 17.0.0.0/8 принадлежит исключительно Apple Inc. (ARIN whois).

1. При запуске `firewall-start` загружает CIDR-блоки из файла `static-networks.txt`.
2. Блоки добавляются в `VPN_STATIC_NETS`.
3. Дальше тот же путь: `iptables` → `fwmark` → `ip rule` → `wgc1`.

## Что изменилось для raw WireGuard server

Когда remote клиент подключается к роутеру по raw `WireGuard server`, после расшифровки его трафик входит в стек через `wgs1`.

Раньше split-routing применялась только к:

- `PREROUTING -i br0`
- `OUTPUT`

Из-за этого remote full-tunnel WireGuard client мог получать домашний внешний IP, но не повторять доменную split-routing логику `VPN_DOMAINS`.

Теперь `firewall-start` добавляет и третий путь:

```sh
iptables -t mangle -A PREROUTING -i wgs1 -j RC_VPN_ROUTE
```

Это выравнивает поведение:

- локальный клиент в Wi-Fi
- remote raw `WireGuard server` клиент
- `Tailscale Exit Node`

Все трое используют один и тот же routing catalog:

- `VPN_DOMAINS`
- `VPN_STATIC_NETS`

Отдельно `nat-start` принудительно отправляет обычный DNS raw-клиентов `WireGuard server` в локальный `dnsmasq` роутера:

```sh
iptables -t nat -A PREROUTING -i wgs1 -p udp --dport 53 -j REDIRECT --to-ports 53
iptables -t nat -A PREROUTING -i wgs1 -p tcp --dport 53 -j REDIRECT --to-ports 53
```

Это защищает от частого сбоя после рестарта VPN-сервера: мобильный клиент может переподключиться с некорректным/stale DNS-состоянием, интернет у него формально есть, но `VPN_DOMAINS` перестают срабатывать, потому что запросы не проходят путь `dnsmasq -> ipset`.

## DNS upstream через VPN

Простого добавления домена в ipset недостаточно. Если DNS-запрос уходит к провайдерскому DNS, провайдер может отдать локализованный (российский) IP, и даже через VPN трафик попадёт на ограниченный сервер.

Решение: для каждого VPN-домена настроен отдельный DNS upstream через WireGuard:

```
server=/youtube.com/1.1.1.1@wgc1
server=/youtube.com/9.9.9.9@wgc1
```

Это заставляет `dnsmasq` резолвить эти домены через публичные DNS `1.1.1.1` (Cloudflare) и `9.9.9.9` (Quad9), причём сами DNS-запросы тоже идут через интерфейс `wgc1`.

Чтобы DNS-трафик к этим резолверам не ушёл через WAN, в `nat-start` добавлены отдельные `ip rule`:

```
ip rule add to 1.1.1.1/32 table wgc1 prio 9901
ip rule add to 9.9.9.9/32 table wgc1 prio 9902
```

## Механизм деплоя

Скрипт `deploy.sh` доставляет конфигурацию на роутер по SSH/SCP.

### Автоопределение роутера

Если переменная `ROUTER` не задана, скрипт определяет IP роутера из default gateway (`route` на macOS, `ip route` на Linux).

### Слияние блоков (merge)

Скрипт не перезаписывает файлы на роутере целиком. Он использует механизм управляемых блоков:

```
# BEGIN router_configuration <имя>
... содержимое из проекта ...
# END router_configuration <имя>
```

При каждом деплое старый блок с этим именем удаляется, новый вставляется в конец файла. Остальное содержимое файла сохраняется. Это позволяет:

- безопасно повторять деплой (идемпотентность)
- не ломать чужие правила, если кто-то добавил свои строки в тот же файл

### Маппинг файлов

| Локальный файл | Путь на роутере | Метод |
|---|---|---|
| `configs/dnsmasq.conf.add` | `/jffs/configs/dnsmasq.conf.add` | merge block |
| `configs/dnsmasq-vpn-upstream.conf.add` | `/jffs/configs/dnsmasq.conf.add` | merge block (другой маркер) |
| `configs/static-networks.txt` | `/jffs/configs/router_configuration.static_nets` | полная копия |
| `configs/no-vpn-ip-ports.txt` | `/jffs/configs/router_configuration.no_vpn_ip_ports` | полная копия |
| `scripts/firewall-start` | `/jffs/scripts/firewall-start` | merge block |
| `scripts/nat-start` | `/jffs/scripts/nat-start` | merge block |
| `scripts/cron-save-ipset` | `/jffs/scripts/cron-save-ipset` | merge block |
| `scripts/cron-traffic-snapshot` | `/jffs/scripts/cron-traffic-snapshot` | merge block |
| `scripts/cron-traffic-daily-close` | `/jffs/scripts/cron-traffic-daily-close` | merge block |
| `scripts/services-start` | `/jffs/scripts/services-start` | merge block |
| `scripts/domain-auto-add.sh` | `/jffs/addons/x3mRouting/domain-auto-add.sh` | полная копия |
| `scripts/update-blocked-list.sh` | `/jffs/addons/x3mRouting/update-blocked-list.sh` | полная копия |
| `configs/domains-no-vpn.txt` | `/jffs/configs/domains-no-vpn.txt` | полная копия |
| `configs/dnsmasq-logging.conf.add` | `/jffs/configs/dnsmasq.conf.add` | merge block (опционально) |

Обратите внимание: `dnsmasq.conf.add` и `dnsmasq-vpn-upstream.conf.add` оба попадают в один и тот же файл на роутере (`/jffs/configs/dnsmasq.conf.add`), но в разные managed-блоки. Merlin подключает именно этот файл к dnsmasq.

### Что происходит после загрузки файлов

1. Запускается `nat-start` — добавляет `ip rule` для DNS и fwmark.
2. Запускается `firewall-start` — создаёт ipset'ы, загружает статические сети и per-IP:port WAN-исключения, настраивает iptables.
3. Запускается `services-start` — добавляет cron-задачи: сохранение ipset, traffic snapshots, close-of-day conntrack snapshot и domain auto-add.
4. Перезапускается `dnsmasq` — подхватывает новые правила из `/jffs/configs/dnsmasq.conf.add`.

## Наблюдаемость трафика

Traffic observability тоже теперь строится вокруг трёх ingress-путей.

Что сохраняется каждые 6 часов:

- интерфейсные счётчики `wan0`, `wgc1`, `wgs1`, `br0`, `eth6`, `eth7`
- LAN byte snapshots из `iptables mangle` по IP-адресам клиентов
- `tailscale status --json`
- `wg show wgs1 dump`

Что показывают отчёты:

- `traffic-report` — текущий день
- `traffic-daily-report` — закрытый день / неделя / месяц
- `verify.sh` — compact live health-summary по routing-инвариантам, ёмкости каталога, freshness и drift
- `router-health-report` — sanitised Markdown snapshot для человека и LLM
- `router-health-report --save` — tracked summary + local journal + USB-backed copy на роутере

Ключевые новые метрики:

- `LAN device bytes` — per-device byte deltas по обычным LAN-клиентам (`VPN` / `WAN` / `Other`)
- `WG server total` — router-wide bytes по `wgs1`
- `WireGuard server peers` — per-peer transfer deltas из `wg show wgs1 dump`
- `WIREGUARD SERVER PEERS (... CONNECTION SNAPSHOT)` — current/end-of-day conntrack snapshot для remote peer'ов
- `Catalog Capacity` — live размер `VPN_DOMAINS`, `VPN_STATIC_NETS`, usage/headroom, manual/auto rule counts
- `Freshness` — age blocked-list, ipset persistence, traffic snapshots, tailscale/wgs1 artifacts
- `Drift` — только repo-managed routing-инварианты, а не полный diff живого роутера

Подробности: [traffic-observability.md](traffic-observability.md)

### Где хранятся operational artifacts

Проект теперь осознанно использует USB/Entware storage на роутере не только для ipset persistence и traffic snapshots, но и для health-report артефактов.

Основные пути:

- traffic snapshots:
  - primary: `/opt/var/log/router_configuration`
  - fallback: `/jffs/addons/router_configuration/traffic`
- ipset persistence:
  - primary: `/opt/tmp/VPN_DOMAINS.ipset`
  - fallback: `/jffs/addons/router_configuration/VPN_DOMAINS.ipset`
- saved health reports:
  - primary: `/opt/var/log/router_configuration/reports/router-health-latest.md`
  - timestamped copies: `/opt/var/log/router_configuration/reports/router-health-<timestamp>.md`
  - fallback: `/jffs/addons/router_configuration/traffic/reports/...`

Это даёт три уровня observability:

1. live state по SSH (`verify.sh`, `traffic-report`, `router-health-report`)
2. tracked sanitised snapshot в git: `docs/router-health-latest.md`
3. router-side USB-backed operational history

## Персистентность ipset

`VPN_DOMAINS` наполняется динамически: IP попадают туда по мере DNS-резолва. Чтобы набор пережил перезагрузку, используется cron-задача:

- Каждые 6 часов `cron-save-ipset` сохраняет состояние ipset в файл.
- При следующем запуске `firewall-start` восстанавливает набор из этого файла.
- Путь хранения: `/jffs/addons/router_configuration/VPN_DOMAINS.ipset` (без Entware) или `/opt/tmp/VPN_DOMAINS.ipset` (с Entware).

`VPN_STATIC_NETS` не требует персистентности — он полностью загружается из `static-networks.txt` при каждом запуске `firewall-start`.

## Ёмкость и ограничения `VPN_DOMAINS`

Набор `VPN_DOMAINS` создаётся в `firewall-start` как `ipset hash:ip` с лимитом:

```sh
ipset create VPN_DOMAINS hash:ip family inet hashsize 1024 maxelem 65536
```

Что это значит на практике:

- В `VPN_DOMAINS` лежат **не домены**, а уже разрезолвленные IPv4-адреса.
- Один домен может дать десятки IP, поэтому число записей в `ipset` всегда заметно выше числа доменных правил.
- Лимит `65536` — это верхняя граница по IP-адресам, после которой новые адреса перестанут добавляться.
- Рост набора в основном определяется CDN, Anycast и сервисами с широкими пулами адресов.

Операционные ориентиры:

- До `~10%` лимита (`< 6500` IP) — очень комфортный режим.
- `10–30%` — нормальный рост, но уже стоит смотреть динамику в журнале.
- `>30%` — полезно проверить, нет ли слишком широких семей (`com.br`, CDN-агрегаты, ошибочно схлопнутые suffix'ы).
- `>50%` — уже стоит планово чистить лишние семейства и пересматривать auto-discovery.

Как смотреть состояние на роутере:

```sh
ipset list VPN_DOMAINS | sed -n '1,10p'
ipset list VPN_DOMAINS | awk '/^Number of entries:/ {print $4}'
ipset list VPN_STATIC_NETS | awk '/^Number of entries:/ {print $4}'
```

В локальном `docs/vpn-domain-journal.md` мы дополнительно ведём эксплуатационную сводку:
- текущее число IP в `VPN_DOMAINS`
- процент от лимита `65536`
- объём памяти набора
- число статических CIDR в `VPN_STATIC_NETS`

`router-health-report --save` теперь умеет обновлять этот local journal автоматически, чтобы следующая LLM или человек могли сравнить live-состояние с последним сохранённым snapshot без повторного ручного анализа.

## Автоматическое обнаружение доменов

Помимо ручных доменов в `dnsmasq.conf.add`, в архитектуре есть автоматический слой обнаружения:

```
  dnsmasq.log (DNS-запросы)
         │
         │ domain-auto-add.sh (cron, каждый час)
         ▼
  dnsmasq-autodiscovered.conf.add   ← автоматически найденные домены
         │                            (загружается через conf-file= в dnsmasq.conf.add)
         │ dnsmasq restart
         ▼
      dnsmasq → ipset → iptables → ip rule → WGC1  (routing engine)
```

### Как работает auto-discovery

Скрипт `domain-auto-add.sh` запускается каждый час через cron (`services-start` → `cru a DomainAutoAdd`):

1. Парсит `/opt/var/log/dnsmasq.log` — извлекает уникальные домены
2. Нормализует `dnsmasq-autodiscovered.conf.add`: убирает избыточные child-записи, которые уже покрыты ручным или более широким auto-правилом
3. Фильтрует: системные домены, CDN-инфраструктуру, российские TLD, домены из `domains-no-vpn.txt`, уже покрытые ancestor-правилом
4. **Проверяет по списку заблокированных** (`/opt/tmp/blocked-domains.lst`) — добавляет только домены из реестра РКН. Если список не скачан — fallback (добавлять всё). Домены, не попавшие в список, становятся «кандидатами».
5. **Пишет service-family domain** — обычно registrable domain (e.g. `example-provider.invalid`) вместо конкретного поддомена (`www.example-provider.invalid`), но для dynamic DNS с IP-encoded family label использует семейство по IP-лейблу, а не весь публичный суффикс.
6. **Проверяет suffix coverage перед записью** — если write-domain уже покрыт более общим правилом (`fbcdn.net`, `facebook.com`, `203-0-113-10.sslip.io` и т.п.), новая child-запись не создаётся.
7. **ISP-проба кандидатов** — пороги считаются по накопленным окнам: базовый `count24h` (`>=3` для обычных, `>=1` для коротких/входных и IP-encoded family), плюс сигнал **user interest** (`count7d >= 10` и `active_days7d >= 2`). Планировщик проб — `2 interest + 10 top-score + 4 fair-queue` (давно/никогда не проверялись), максимум `16` проб за запуск.
8. Добавляет прошедшие проверку в `/jffs/configs/dnsmasq-autodiscovered.conf.add` (ipset + server entries)
9. Перезапускает dnsmasq
10. Пишет лог в `/opt/var/log/domain-activity.log` (секции: ДОБАВЛЕНО В VPN, GEO-BLOCKED, CLEANUP AUTO-ФАЙЛА, КАНДИДАТЫ)
11. Ротирует dnsmasq.log

### Список заблокированных доменов

Скрипт `update-blocked-list.sh` ежедневно скачивает кураторский список доменов, заблокированных в России, из [community.antifilter.download](https://community.antifilter.download). Список содержит ~500 ключевых заблокированных сервисов (Instagram, Twitter, LinkedIn, ChatGPT и др.).

Домены, заблокированные не через реестр РКН, а иными методами (YouTube — DPI, Telegram — IP-блокировка), покрываются ручными правилами в `dnsmasq.conf.add`.

### Разделение ручных и автоматических доменов

| Источник | Файл на роутере | Управление |
|---|---|---|
| Ручные домены | `/jffs/configs/dnsmasq.conf.add` | `deploy.sh` (managed blocks) |
| Авто-добавленные | `/jffs/configs/dnsmasq-autodiscovered.conf.add` | `domain-auto-add.sh` (cron) |

**Важно:** Merlin автоматически подключает к dnsmasq только `dnsmasq.conf.add`. Файл `dnsmasq-autodiscovered.conf.add` загружается явной директивой `conf-file=` в конце `dnsmasq.conf.add`.

### Утилиты x3mRouting

Для ручного разового анализа доступны `getdomainnames.sh` и `autoscan` из x3mRouting. Они парсят тот же `dnsmasq.log` и группируют домены по семействам — полезно для целевого исследования конкретного сервиса.

Routing-функции x3mRouting не используются (заточены под OpenVPN, а не WireGuard).

Подробности: [x3mrouting-roadmap.md](x3mrouting-roadmap.md).

## Переменные окружения deploy.sh

| Переменная | По умолчанию | Описание |
|---|---|---|
| `ROUTER` | автоопределение через default gateway | IP-адрес роутера |
| `ROUTER_USER` | `admin` | SSH-пользователь |
| `ROUTER_PORT` | `22` | SSH-порт |
| `SSH_IDENTITY_FILE` | `~/.ssh/id_rsa` | SSH-ключ |
| `CONNECT_TIMEOUT` | `5` | Таймаут подключения (секунды) |
| `ENABLE_DNSMASQ_LOGGING` | `1` | Логирование DNS для auto-discovery (`0` — выключить) |

## Связанные документы

- [getting-started.md](getting-started.md) — пошаговая настройка с нуля
- [domain-management.md](domain-management.md) — как добавлять и удалять домены
- [telegram-deep-dive.md](telegram-deep-dive.md) — почему Telegram требует особого подхода
- [x3mrouting-roadmap.md](x3mrouting-roadmap.md) — обнаружение доменов с помощью x3mRouting
