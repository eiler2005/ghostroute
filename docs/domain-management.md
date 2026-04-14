# Управление доменами и сетями

## Как добавить новый домен

Для добавления нового домена нужно отредактировать **два файла** и запустить деплой.

### 1. Добавить ipset-правило

В `configs/dnsmasq.conf.add` добавьте строку:

```
ipset=/newdomain.com/VPN_DOMAINS
```

Это правило покроет `newdomain.com` и все его поддомены (`*.newdomain.com`).

### 2. Добавить DNS upstream

В `configs/dnsmasq-vpn-upstream.conf.add` добавьте две строки:

```
server=/newdomain.com/1.1.1.1@wgc1
server=/newdomain.com/9.9.9.9@wgc1
```

Это заставит dnsmasq резолвить домен через публичные DNS по VPN, а не через DNS провайдера.

### 3. Задеплоить

```bash
./deploy.sh
```

### 4. Проверить

На роутере (через SSH или `./verify.sh`):

```bash
# Резолвим домен через dnsmasq
nslookup newdomain.com 127.0.0.1

# Проверяем, что IP попал в ipset
ipset list VPN_DOMAINS | grep <resolved_ip>

# Проверяем маршрут
ip route get <resolved_ip>
# Должен показать: ... dev wgc1 ...

# Для split-routing логики проверяем путь c mark 0x1000
ip route get <resolved_ip> mark 0x1000
# Должен показать: ... dev wgc1 ...
```

## Как добавить статическую сеть

Статические сети нужны, когда сервис использует прямые IP-подключения, минуя DNS (как Telegram).

### 1. Добавить CIDR-блок

В `configs/static-networks.txt` добавьте строку:

```
203.0.113.0/24
```

Комментарии начинаются с `#`.

### 2. Задеплоить

```bash
./deploy.sh
```

### 3. Проверить

```bash
ipset list VPN_STATIC_NETS | grep 203.0.113
```

## Как удалить домен или сеть

1. Удалите соответствующие строки из конфигов (все упоминания домена во всех файлах).
2. Запустите `./deploy.sh`.
3. Домен перестанет попадать в ipset при следующем DNS-запросе.

Примечание: уже добавленные в `VPN_DOMAINS` IP-адреса сохранятся до перезагрузки роутера или до истечения записей. `VPN_STATIC_NETS` обновляется полностью при каждом запуске `firewall-start`.

## Когда использовать домены vs. статические сети

| Ситуация | Рекомендация |
|---|---|
| Обычный веб-сервис (YouTube, GitHub, ChatGPT) | Домен — IP-адреса резолвятся через DNS |
| Сервис с прямыми IP-подключениями (Telegram) | Домены + статические сети |
| Shared CDN (Cloudflare, Google) | Только домен — статический IP затронет чужой трафик |
| Конкретный IP, который надо отправить через VPN | Статическая сеть `/32` |

## Конвенции

### Группировка

Домены в обоих конфигах сгруппированы по сервисам. Telegram-секция выделена визуальным разделителем `# ===...===`. При добавлении нового домена размещайте его в соответствующей группе или создавайте новую.

### Порядок

Порядок доменов в `dnsmasq.conf.add` и `dnsmasq-vpn-upstream.conf.add` должен совпадать по группам. Это упрощает проверку соответствия.

### Три файла — одна правда

Каждый домен, который мы маршрутизируем через VPN, должен присутствовать и в `dnsmasq.conf.add` (ipset), и в `dnsmasq-vpn-upstream.conf.add` (DNS upstream). Если домен есть только в одном файле — это ошибка.

## Автоматическое обнаружение доменов

Скрипт `domain-auto-add.sh` запускается каждый час через cron и автоматически добавляет новые домены в VPN без участия пользователя.

### Алгоритм — как домен попадает в VPN

```
DNS-запрос с устройства (любой сайт)
          │
          ▼
[1] Есть точка? Не .local / .lan / .arpa?  ──нет──► SKIP
          │
          ▼
[2] В SKIP_PATTERNS?                        ──да───► SKIP
    cloudfront.net, akamaiedge.net,
    akadns.net, msftconnecttest.com …
          │
          ▼
[3] Российский TLD?                         ──да───► SKIP
    .ru .su .рф .москва .tatar .moscow
          │
          ▼
[4] В domains-no-vpn.txt?                   ──да───► SKIP
    (ручной список исключений)
          │
          ▼
[5] Уже есть ipset-правило                  ──да───► KNOWN
    для любого покрывающего suffix?
    (ancestor coverage check)
          │
          ▼
[6] В реестре РКН                           ──нет──► КАНДИДАТ
    (blocked-domains.lst)?                       │
    Если список не скачан → пропустить           │  обычный домен: count24h ≥3
    проверку (fallback = добавить всё)           │  короткий / www-вход: count24h ≥1
                                                 │  user-interest: count7d ≥10 и
                                                 │  active_days7d ≥2
          │                                      ▼
          │                              ISP-проба:
          │                              curl --interface wan0 (4 сек)
          │                              scheduler: 2 interest + 10 top-score + 4 fair
          │                              HTTP 000?
          │                                да ──► GEO-BLOCKED ──┐
          │                                нет ─► остаётся       │
          │                                       кандидатом     │
          ▼                                                       │
[7] Определить write_domain:               ◄─────────────────────┘
    Обычно:
      ≥3 меток (sub.example.com)
        → писать reg_domain (example.com)  ← все поддомены покрыты сразу
      2 метки (example.com) → как есть
    Исключение:
      dynamic DNS с IP-encoded family label
      (например openclaw.203-0-113-10.sslip.io
       или openclaw.203.0.113.10.nip.io)
        → писать семейство по IP-лейблу, а не весь публичный суффикс
          │
          ▼
    Перед записью:
      cleanup auto-файла удаляет избыточные child-записи,
      уже покрытые ручным или более широким auto-правилом
          │
          ▼
    Добавить в dnsmasq-autodiscovered.conf.add
    + перезапустить dnsmasq
```

**Итог по лог-секциям** (`domain-report --log`):
- `ДОБАВЛЕНО В VPN` — прошли через реестр РКН
- `GEO-BLOCKED` — прошли через ISP-пробу (HTTP 000)
- `CLEANUP AUTO-ФАЙЛА` — избыточные дочерние auto-записи, удалённые потому что их уже покрывает родитель
- `КАНДИДАТЫ` — не в РКН и либо ещё не дошли до ISP-пробы, либо сайт через ISP доступен; добавить вручную если нужно

### Сигнал интереса пользователя

Чтобы не терять “важные для пользователя” домены, которые не всегда попадают в top-score за один час, скрипт считает недельный интерес:

- `count7d` — суммарное число DNS-запросов домена за 7 дней
- `active_days7d` — в скольких разных днях в течение недели домен запрашивался
- порог интереса: `count7d >= 10` и `active_days7d >= 2`

Если домен проходит этот порог, он получает:

- отдельный слот в планировщике ISP-проб (`interest`-bucket)
- score-буст для ранжирования
- допуск к ISP-пробе даже при слабом текущем `count24h`

### Защита от избыточных дочерних записей

`domain-auto-add.sh` теперь делает общий `suffix coverage check`:

- если в ручном конфиге уже есть `fbcdn.net`, то `video.xx.fbcdn.net` и `static.xx.fbcdn.net` считаются уже покрытыми и не добавляются
- если в auto-файле уже сохранён `203-0-113-10.sslip.io`, то более глубокие хосты внутри этого семейства отдельно не пишутся
- перед обычным проходом скрипт нормализует `dnsmasq-autodiscovered.conf.add` и убирает старые child-записи, которые стали лишними после появления более широкого правила

### Авто-добавленные vs. ручные домены

Авто-добавленные домены хранятся **отдельно** от ручных:

| Домены | Файл | Git |
|---|---|---|
| Ручные (основные сервисы) | `configs/dnsmasq.conf.add` + `configs/dnsmasq-vpn-upstream.conf.add` | Да |
| Авто-добавленные | `/jffs/configs/dnsmasq-autodiscovered.conf.add` на роутере | Нет |

Для авто-добавленных доменов конвенция «Три файла» **не применяется** — ipset и server entries хранятся вместе в одном файле на роутере.

### Исключения: что не добавляется автоматически

- **Российские TLD** (`.ru`, `.su`, `.рф`, `.москва`, `.tatar`, `.moscow`) — пропускаются автоматически
- **Ручные исключения** — добавьте домен в `configs/domains-no-vpn.txt`:
  ```
  # Российские сервисы на зарубежных TLD
  championat.com
  meduza.io
  ```
  Поддомены учитываются: `example.com` покрывает `www.example.com`, `api.example.com` и т.д.

### Как оставить конкретный IP:порт вне VPN

Если домен в целом должен идти через VPN, но отдельный порт нужно пустить напрямую через WAN
(например `22/tcp` для SSH-администрирования), добавьте правило в `configs/no-vpn-ip-ports.txt`:

```text
tcp 203.0.113.10 22
```

Формат строки:
- протокол: `tcp` или `udp`
- IPv4-адрес назначения
- порт назначения

После `./deploy.sh` `firewall-start` добавит mangle-исключение до правил маркировки `VPN_DOMAINS`, и этот конкретный IP:порт не будет уходить в `wgc1`.

Если для production нужны реальные персональные bypass-правила, храните их в локальном файле:

```text
secrets/no-vpn-ip-ports.local.txt
```

Он игнорируется git и автоматически дописывается к tracked `configs/no-vpn-ip-ports.txt` во время `./deploy.sh`.

### Мониторинг и управление (с Mac)

```bash
# Сводка + последний запуск
./scripts/domain-report

# Подробный лог активности
./scripts/domain-report --log

# Все авто-добавленные домены
./scripts/domain-report --all

# Вычистить избыточные child auto-домены и перезапустить dnsmasq
./scripts/domain-report --cleanup

# Удалить все авто-добавленные домены
./scripts/domain-report --reset
```

### Как посмотреть, дал ли новый домен реальный трафик

После добавления домена полезно проверить не только `ipset`, но и фактическое потребление по каналам.

Текущий день:

```bash
./scripts/traffic-report
```

Исторический отчёт:

```bash
./scripts/traffic-daily-report today
./scripts/traffic-daily-report yesterday
```

Что смотреть:

- `VPN total` — вырос ли router-wide трафик через `wgc1`
- `WG server total` — если тестируете через raw `WireGuard server`
- `LAN DEVICES` — появились ли active conntrack entries у локального клиента
- `WIREGUARD SERVER PEERS` — появились ли active conntrack entries и transfer deltas у remote peer'а

По умолчанию отчёты редактируют peer names / hostnames / endpoints. Для доверенного локального просмотра без редактирования:

```bash
REPORT_REDACT_NAMES=0 ./scripts/traffic-report
```

### Как перенести авто-добавленный домен в ручные конфиги

Если домен важен и должен гарантированно быть в git:

1. Найдите домен: `./scripts/domain-report --all`
2. Добавьте в `configs/dnsmasq.conf.add`:
   ```
   ipset=/example.com/VPN_DOMAINS
   ```
3. Добавьте в `configs/dnsmasq-vpn-upstream.conf.add`:
   ```
   server=/example.com/1.1.1.1@wgc1
   server=/example.com/9.9.9.9@wgc1
   ```
4. Запустите `./deploy.sh` — при следующем запуске `domain-auto-add.sh` домен будет обнаружен как уже добавленный и пропущен

### Ручной поиск с помощью x3mRouting

Для целевого анализа конкретного сервиса (YouTube, TikTok, Instagram) можно использовать утилиты x3mRouting напрямую на роутере:

```sh
# Все уникальные домены из текущего лога
getdomainnames.sh
```

Результат нужно почистить вручную (убрать трекеры, analytics, нерелевантные домены) и перенести в `configs/dnsmasq.conf.add` и `configs/dnsmasq-vpn-upstream.conf.add` по обычной конвенции.

Подробности: [x3mrouting-roadmap.md](x3mrouting-roadmap.md).

## Связанные документы

- [architecture.md](architecture.md) — как работает маршрутизация
- [telegram-deep-dive.md](telegram-deep-dive.md) — почему для Telegram нужен особый подход
- [current-routing-explained.md](current-routing-explained.md) — полный список того, что сейчас роутится
- [x3mrouting-roadmap.md](x3mrouting-roadmap.md) — обнаружение доменов с помощью x3mRouting
