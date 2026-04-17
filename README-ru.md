# GhostRoute

### Умная VPN-маршрутизация для роутера ASUS

> Трафик маршрутизирует себя сам. Незаметно.

Прозрачная доменная маршрутизация через WireGuard на роутере ASUS с Asuswrt-Merlin. Заблокированные сервисы автоматически идут через VPN — без настройки на каждом устройстве, без прокси, с автоматическим обнаружением новых блокировок.

**[English version →](README.md)**

---

## Что это и зачем

Роскомнадзор блокирует сервисы разными методами: через DNS (провайдер подменяет адрес), через DPI (анализ трафика), через блокировку IP-диапазонов. VPN на каждом устройстве — неудобно: надо ставить на телефон, компьютер, телевизор, консоль. И периодически включать руками.

Этот проект решает проблему **один раз на уровне роутера**: все устройства в домашней сети подключаются как обычно, а роутер сам решает, какой трафик пустить через VPN, а какой — напрямую.

Заблокированный YouTube? Идёт через VPN. Российский банк? Идёт напрямую. Ничего настраивать на устройствах не нужно.

---

## Как это работает (простыми словами)

Когда ваш телефон открывает YouTube, он сначала спрашивает роутер: «а какой IP у youtube.com?». Роутер в этот момент:

1. Видит, что youtube.com — заблокированный домен
2. Запрашивает IP через VPN (чтобы получить «правильный» адрес, а не адрес страницы-заглушки провайдера)
3. Запоминает этот IP в специальном списке (ipset)
4. Отвечает телефону

Дальше, когда телефон пытается соединиться с этим IP — роутер видит IP в списке и автоматически отправляет трафик через WireGuard. Телефон об этом ничего не знает.

```
Телефон запрашивает youtube.com
         │
         ▼
    Роутер (dnsmasq)
    ├─ youtube.com в VPN-списке?
    │  ДА → резолвит через 1.1.1.1 по VPN-туннелю
    │       → IP добавляется в ipset VPN_DOMAINS
    │       → IP возвращается телефону
    └─ НЕТ → резолвит через DNS провайдера как обычно
         │
         ▼
    Телефон соединяется с IP
         │
         ▼
    iptables: PREROUTING / OUTPUT
    IP в VPN_DOMAINS?
    ├─ ДА → метка 0x1000 → WireGuard wgc1 → интернет
    └─ НЕТ → прямо через провайдера
```

`PREROUTING` работает для обычных клиентов в `LAN/Wi-Fi` и для raw-клиентов `WireGuard server`, которые приходят на `wgs1`. `OUTPUT` нужен для локально сгенерированного трафика роутера, в том числе для `Tailscale Exit Node`, потому что такой трафик проксируется самим роутером и не приходит как обычный пакет с `br0`.

Для raw-клиентов `WireGuard server` plain DNS (`tcp/udp 53`) дополнительно перенаправляется в локальный `dnsmasq` роутера. Это сохраняет работу `VPN_DOMAINS`, даже если мобильный клиент после реконнекта пришёл со stale/пустыми DNS-настройками и иначе обошёл бы путь `dnsmasq -> ipset`.

---

## Умное обнаружение новых блокировок

Роутер каждый час анализирует все DNS-запросы от устройств в сети и автоматически добавляет в VPN новые заблокированные домены.

Но не все подряд — сначала домен проверяется по [кураторскому списку заблокированных доменов](https://community.antifilter.download). Это защищает от случайного добавления в VPN всего подряд. Если домена в списке нет, он остаётся кандидатом и может быть добавлен позже через ISP-пробу как geo-blocked.

```
dnsmasq.log (все DNS-запросы)
       │
       │  domain-auto-add.sh (каждый час)
       ▼
 Извлечь уникальные домены
       │
       ├─ Пропустить: системные, CDN, инфраструктура
       ├─ Пропустить: российские TLD (.ru, .su, .рф, ...)
       ├─ Пропустить: домены из списка исключений
       ├─ Пропустить: уже покрыты более общим VPN-правилом
       ├─ Нормализовать auto-файл: убрать дочерние записи, которые уже покрыты родителем
       │
       └─ Проверить по blocked-domains.lst
             ├─ ЕСТЬ в списке → добавить в VPN (автоматически)
             └─ НЕТ → кандидат
                   ├─ пороги count24h / приоритетный входной домен
                   ├─ сигнал "интерес пользователя"
                   │    (count7d + active_days7d)
                   ├─ scheduler:
                   │    2 interest + 10 top-score + 4 fair
                   ├─ ISP-проба = HTTP 000 → добавить как geo-blocked
                   └─ иначе оставить кандидатом
```

Список заблокированных доменов (~500 ключевых сервисов) скачивается ежедневно через VPN-туннель скриптом `update-blocked-list.sh`.

Когда домен проходит auto-discovery, скрипт пишет **service-family domain**:
- обычные поддомены обычно сворачиваются в registrable domain (`api.example-provider.invalid` → `example-provider.invalid`)
- dynamic DNS с IP-encoded family label сохраняет более узкое семейство (`openclaw.203-0-113-10.sslip.io` → `203-0-113-10.sslip.io`)

Перед записью скрипт делает полный **suffix coverage check** по ручным и уже сохранённым auto-правилам:
- если `fbcdn.net` уже есть, `static.xx.fbcdn.net` считается избыточным и не пишется
- если такие дочерние записи накопились в `dnsmasq-autodiscovered.conf.add` исторически, cleanup переписывает auto-файл без них

---

## Ключевые возможности

- **Доменная маршрутизация** — правило `ipset=/youtube.com/VPN_DOMAINS` покрывает домен и все поддомены автоматически
- **DNS через VPN** — для VPN-доменов DNS-запросы идут через Cloudflare/Quad9 по VPN-туннелю (исключает подмену DNS провайдером)
- **Статические IP-диапазоны** — для сервисов, которые частично ходят прямыми IP-соединениями вне обычного DNS-пути (Telegram, imo, часть Apple-потоков), дополнительно добавлены диапазоны подсетей
- **Авто-обнаружение** — каждый час находит и добавляет новые заблокированные домены
- **Умная фильтрация** — добавляет только реально заблокированные домены, а не всё подряд из DNS-лога
- **Сигнал интереса пользователя** — повторяющиеся запросы кандидата за неделю повышают шанс ISP-пробы даже при низком текущем трафике
- **Дедупликация по родительскому суффиксу** — если `fbcdn.net` уже маршрутизируется, дочерние хосты вроде `video.xx.fbcdn.net` не попадают в auto-файл отдельно; старые избыточные записи cleanup вычищает
- **Идемпотентный деплой** — можно запускать `deploy.sh` сколько угодно раз, конфигурация не задвоится
- **Персистентность** — список IP в ipset сохраняется на USB-накопителе и переживает перезагрузки роутера

---

## Охватываемые сервисы

| Категория | Сервисы |
|---|---|
| AI-инструменты | Claude / Anthropic, ChatGPT / OpenAI, Google AI Studio, NotebookLM, Smithery, Wispr Flow |
| Разработка | GitHub, GitLab, Bitbucket, Azure DevOps, Visual Studio |
| Видео | YouTube (все поддомены + CDN) |
| Мессенджеры | Telegram (домены + IP-подсети по ASN), imo (imo.im + PageBites IP-подсети), WhatsApp |
| Соцсети | Instagram, Facebook / Messenger, Twitter / X, TikTok, LinkedIn |
| Прочее | Apple Podcasts, Atlassian, cobalt.tools |

Плюс домены, обнаруженные автоматически.

---

## Структура проекта

```
configs/
  dnsmasq.conf.add                # ipset-правила: какие домены → VPN
  dnsmasq-vpn-upstream.conf.add   # DNS upstream через VPN для каждого домена
  dnsmasq-logging.conf.add        # настройки логирования DNS
  static-networks.txt             # статические IP-подсети (Telegram / imo / Apple и похожие direct-IP случаи)
  domains-no-vpn.txt              # домены-исключения (никогда не VPN)
  no-vpn-ip-ports.txt             # исключения по IP:порту (всегда через WAN)

scripts/
  firewall-start                  # создание ipset, загрузка статических сетей, iptables
  nat-start                       # ip rule для fwmark и DNS-маршрутизации
  services-start                  # установка cron-задач
  domain-auto-add.sh              # авто-обнаружение доменов (cron, каждый час)
  update-blocked-list.sh          # скачивание списка блокировок (cron, раз в сутки)
  domain-report                   # CLI: просмотр/управление авто-добавленными доменами
  traffic-report                  # CLI: итоги за сегодня по WAN/Wi-Fi/VPN/WG-server/Tailscale + LAN/WGS snapshots
  traffic-daily-report            # CLI: закрытый дневной отчёт из сохранённых snapshots, incl. WGS peers
  router-health-report            # CLI: sanitised health/capacity/traffic summary для человека и LLM
  cron-save-ipset                 # сохранение ipset на диск каждые 6ч
  cron-traffic-snapshot           # сохранение traffic / Tailscale / WGS snapshots каждые 6ч
  cron-traffic-daily-close        # сохранение end-of-day LAN/WGS conntrack snapshot в 23:55

docs/
  architecture.md                 # детальная архитектура
  getting-started.md              # пошаговая настройка с нуля
  domain-management.md            # как добавлять/удалять домены
  telegram-deep-dive.md           # почему Telegram особенный
  troubleshooting.md              # диагностика проблем
  current-routing-explained.md    # полный каталог доменов с пояснениями
  traffic-observability.md        # архитектура traffic-report и сетевых счётчиков
  llm-traffic-runbook.md          # короткая инструкция для LLM / агента
  router-health-latest.md         # tracked sanitised snapshot последнего сохранённого health-report

deploy.sh                         # деплой на роутер по SSH/SCP
verify.sh                         # compact health-summary + drift/freshness checks
.env.example                      # шаблон настроек
```

---

## Быстрый старт

**Требования**: роутер ASUS с Asuswrt-Merlin, настроенный WireGuard-клиент `wgc1`, включённый SSH, Entware на USB.

```bash
# Клонируем
git clone https://github.com/eiler2005/router_configuration
cd router_configuration

# Настраиваем локальные secrets
mkdir -p secrets
cp .env.example secrets/router.env
# При необходимости отредактировать: ROUTER=, SSH_IDENTITY_FILE=

# Деплой
./deploy.sh

# Проверка
./verify.sh
```

Подробная инструкция: [docs/getting-started.md](docs/getting-started.md)

---

## Дополнительно: Tailscale Exit Node

Если провайдер даёт только `CGNAT/private WAN`, прямой входящий VPN (`Instant Guard`, обычный WireGuard/OpenVPN-сервер) извне не заработает без белого IPv4. В таком случае на Merlin можно поставить `Tailscale` через `Entware` и использовать роутер как `Exit Node`.

Что важно:

- трафик `Tailscale Exit Node` обрабатывается как локально сгенерированный, поэтому для совпадения с LAN-логикой нужен хук `OUTPUT -> RC_VPN_ROUTE`
- домены из `VPN_DOMAINS` и сети из `VPN_STATIC_NETS` по-прежнему идут через `wgc1`
- всё, что не совпало со списками, остаётся на обычном `WAN`
- скорость может быть ниже, чем у локального клиента в LAN: `Tailscale` на роутере работает в `userspace`, а на мобильной сети соединение иногда уходит в `DERP/relay`

## Наблюдаемость трафика

`traffic-report` использует snapshots, которые роутер сохраняет каждые 6 часов на USB/Entware, и показывает итоги с первого сэмпла текущего дня:

- `WAN total` — весь внешний трафик через интерфейс провайдера
- `VPN total` — весь трафик через `wgc1`
- `WG server total` — весь трафик через raw WireGuard server-интерфейс `wgs1`
- `Wi-Fi total` — суммарный трафик радиоинтерфейсов роутера
- `Tailscale total` — сумма per-peer `RxBytes` / `TxBytes` из `tailscaled`
- `LAN device bytes` — накопленные per-device дельты из router-side mangle accounting (`VPN` / `WAN` / `Other` / upload / download)
- `Device traffic mix` — явная сводка per-device: сколько прошло `через VPN`, сколько ушло `напрямую в WAN`, плюс топ устройств по обоим направлениям
- `WireGuard server peers` — per-peer дельты из `wg show wgs1 dump` плюс current/end-of-day conntrack-срез по remote peer'ам на `wgs1`
- `Top by WG server peers` / `Top by Tailscale peers` — короткие peer-level summary, чтобы сразу видеть самых активных удалённых клиентов без ручного разбора полной таблицы
- `LAN devices` — текущий срез `conntrack`; столбцы `Total` / `VPN` / `WAN` / `Local` здесь означают число активных соединений, а не байты

По умолчанию отчёты редактируют peer names, hostnames, tunnel addresses и endpoints. `REPORT_REDACT_NAMES=0` используйте только для доверенного локального просмотра.

Если хотите, чтобы в доверенном локальном отчёте вместо сырых IP/hostnames показывались ваши локальные алиасы и типы устройств, создайте `secrets/device-metadata.local.tsv`. Формат:

```txt
# ip|alias|type|notes
192.168.50.42||iPhone|метка из UI роутера
192.168.50.34|Living-room-speaker|IoT|локальная подсказка
```

Папка `secrets/` уже в `.gitignore`, поэтому эти overrides не попадут в публичный git. При включённом redaction отчёты всё равно будут показывать `lan-host-*`.

Подробная архитектура сбора, расчёта дельт и ограничения для `Tailscale Exit Node`: [docs/traffic-observability.md](docs/traffic-observability.md)
Короткий runbook для LLM/агента, включая готовый prompt для запросов `за день / за неделю / за месяц`: [docs/llm-traffic-runbook.md](docs/llm-traffic-runbook.md)

Быстрые команды:

```bash
./scripts/traffic-report
./scripts/traffic-daily-report yesterday
./scripts/traffic-daily-report week
./scripts/traffic-daily-report month
```

`LAN device bytes` и `Device traffic mix` появятся только после того, как роутер успеет собрать минимум два byte-snapshot внутри дня или периода. До этого в отчёте будет пояснение, что byte baseline ещё не накопился.

Для `week/month` router-wide totals могут покрывать более широкое окно, чем `LAN device bytes`. Поэтому в отчёте теперь есть отдельная строка `Per-device byte window`, которая явно показывает, за какой интервал считается per-device разбивка.

## Health summary и LLM-friendly snapshot

Теперь поверх traffic-отчётов есть ещё два безопасных operational-инструмента:

- `./verify.sh`
  compact summary по секциям `Router`, `Routing Health`, `Catalog Capacity`, `Growth Trends`, `Freshness`, `Drift`, `Result`
- `./verify.sh --verbose`
  глубокий live-dump для ручной диагностики
- `./scripts/router-health-report`
  sanitised Markdown-отчёт, понятный человеку и любой LLM
- `./scripts/router-health-report --save`
  одновременно:
  - обновляет tracked [docs/router-health-latest.md](docs/router-health-latest.md)
  - аппендит локальную operational-запись в `docs/vpn-domain-journal.md`
  - сохраняет копию на USB-backed storage роутера в `/opt/var/log/router_configuration/reports/`
    или fallback-путь `/jffs/addons/router_configuration/traffic/reports/`, если Entware недоступен

Быстрые команды:

```bash
./verify.sh
./verify.sh --verbose
./scripts/router-health-report
./scripts/router-health-report --save
```

Если нужен совсем короткий operational набор “в 1–2 кнопки”:

```bash
# health
./verify.sh
./scripts/router-health-report --save

# traffic
./scripts/traffic-report
./scripts/traffic-daily-report week
./scripts/traffic-daily-report month
```

Что показывает `router-health-report`:

- текущий health-result
- живое состояние repo-managed routing-инвариантов
- ёмкость каталога (`VPN_DOMAINS`, `VPN_STATIC_NETS`, usage/headroom)
- growth trends относительно последнего сохранённого snapshot и week-old snapshot, если для него уже накопилась история
- свежесть blocked-list, ipset persistence и traffic snapshots
- базовые traffic totals и `Device Traffic Mix`
- явный `growth level` / `growth note`, чтобы быстро понимать, становится ли рост каталога отдельной operational-темой

Это удобно и для человека, и для LLM:

- tracked `docs/router-health-latest.md` можно безопасно читать из git
- локальный `docs/vpn-domain-journal.md` остаётся operational-журналом
- USB-копия на роутере даёт быстрый live-reference даже без локального git-репозитория

LLM/runbook: [docs/llm-traffic-runbook.md](docs/llm-traffic-runbook.md)
Последний sanitised snapshot: [docs/router-health-latest.md](docs/router-health-latest.md)

## Тесты и smoke-checks

После изменений в observability удобно прогонять:

```bash
bash -n verify.sh scripts/router-health-report scripts/traffic-report scripts/traffic-daily-report scripts/lib/router-health-common.sh tests/test-router-health.sh
./tests/test-router-health.sh
./verify.sh
./scripts/traffic-report
./scripts/traffic-daily-report week
./scripts/router-health-report
./scripts/router-health-report --save
```

Эти команды не меняют runtime-конфигурацию роутера. Они только:

- валидируют shell-скрипты
- проверяют parser/formatter-логику на fixture'ах
- снимают live state по SSH

Что именно тестируется и почему этот слой разделён на `fixture` и `live smoke`:
[tests/README.md](tests/README.md)

---

## Управление доменами

```bash
# Сводка: авто-добавленные домены + последний запуск
./scripts/domain-report

# Полный лог активности
./scripts/domain-report --log

# Домены, которые видели в DNS, но не добавили (не в списке блокировок)
./scripts/domain-report --candidates

# Все авто-добавленные домены
./scripts/domain-report --all

# Вычистить избыточные дочерние auto-домены на роутере
./scripts/domain-report --cleanup

# Удалить все авто-добавленные домены и перезапустить dnsmasq
./scripts/domain-report --reset
```

### Добавить домен вручную

В `configs/dnsmasq.conf.add`:
```
ipset=/example.com/VPN_DOMAINS
```

В `configs/dnsmasq-vpn-upstream.conf.add`:
```
server=/example.com/1.1.1.1@wgc1
server=/example.com/9.9.9.9@wgc1
```

Затем `./deploy.sh`.

## Диагностика на роутере

```bash
# ip rule — проверка что метка 0x1000 уходит в таблицу wgc1
ip rule show | grep -E "0x1000|wgc1"

# Таблица маршрутизации VPN
ip route show table wgc1

# Содержимое ipset
ipset list VPN_DOMAINS | head -20
ipset list VPN_STATIC_NETS

# Тест DNS через dnsmasq (должен залогировать "ipset add VPN_DOMAINS")
nslookup youtube.com 127.0.0.1

# Маршрут для конкретного IP с учётом fwmark
ip route get <IP> mark 0x1000

# Статус WireGuard
wg show wgc1
```

---

## Текущий статус

**Активно** — развёрнуто на рабочем роутере (ASUS RT-AX88U Pro).

| Компонент | Статус |
|---|---|
| Цепочка dnsmasq + ipset + iptables + ip rule | Работает |
| WireGuard клиент wgc1 | Подключён (handshake каждые 20с) |
| Маршрутизация Telegram / imo (домены + IP-подсети) | Активна |
| Авто-обнаружение доменов (каждый час) | Активно |
| Фильтрация по antifilter.download (~500 доменов) | Активна |
| Персистентность ipset на USB | Активна (сохранение каждые 6ч) |
| Идемпотентный деплой | Протестирован |

---

## Документация

| Документ | Описание |
|---|---|
| [architecture.md](docs/architecture.md) | Детальная архитектура: поток пакетов, DNS upstream, механизм деплоя |
| [getting-started.md](docs/getting-started.md) | Требования, SSH-настройка, первый деплой, проверка |
| [domain-management.md](docs/domain-management.md) | Как добавить/удалить домен, конвенции |
| [future-improvements-backlog.md](docs/future-improvements-backlog.md) | Отложенные улучшения и готовый backlog-контекст для будущего LLM |
| [telegram-deep-dive.md](docs/telegram-deep-dive.md) | Почему Telegram особенный: DPI, IP-блокировка, подсети |
| [troubleshooting.md](docs/troubleshooting.md) | Частые проблемы и команды диагностики |
| [current-routing-explained.md](docs/current-routing-explained.md) | Полный каталог маршрутизируемых доменов |

---

*English version: [README.md](README.md)*
