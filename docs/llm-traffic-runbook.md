# LLM Traffic Runbook

Короткая инструкция для агента/LLM, который должен посмотреть трафик роутера и ответить человеку без утечки приватных данных.

## Готовая инструкция для агента

Ниже блок, который можно почти без изменений вставлять в системный prompt / AGENTS / CLAUDE для агента, который должен уметь отвечать на запросы вида "дай отчёт за день / неделю / месяц".

```txt
When the user asks for a router traffic report or router health/capacity report in Russian or English:

1. Map the request to the correct command:
   - "проверка роутера", "health", "router health", "состояние роутера", "дрейф", "freshness" -> ./verify.sh
   - "сохрани health snapshot", "router health report", "здоровье роутера для llm" -> ./scripts/router-health-report
   - "сохрани health snapshot и обнови журнал", "health report save" -> ./scripts/router-health-report --save
   - "review manual/static coverage", "catalog review", "review static cidr", "review manual domains", "cleanup candidates" -> ./scripts/catalog-review-report
   - "save catalog review", "сохрани review каталога", "сохрани catalog review" -> ./scripts/catalog-review-report --save
   - "оптимизируй домены", "оптимизируй каталог", "review vpn domains", "cleanup catalog", "backlog review" -> first read docs/future-improvements-backlog.md, docs/domain-management.md, docs/current-routing-explained.md, docs/traffic-observability.md and answer with a review/plan by default
   - "сегодня", "текущий день", "today", "current day" -> ./scripts/traffic-report
   - "вчера", "yesterday" -> ./scripts/traffic-daily-report yesterday
   - specific date like 2026-04-14 -> ./scripts/traffic-daily-report 2026-04-14
   - "неделя", "за неделю", "week" -> ./scripts/traffic-daily-report week
   - "месяц", "за месяц", "month" -> ./scripts/traffic-daily-report month
   - "что было в 5 утра", "кто шумел ночью", "what happened around 5am", "dns forensics", "who queried what", "что скачивали" -> ./scripts/dns-forensics-report <hour-prefix> and correlate with ./scripts/traffic-report or ./scripts/traffic-daily-report

2. Default to redacted mode. Use REPORT_REDACT_NAMES=0 only for trusted local inspection when the user explicitly wants device-level identification.

3. If the command is ./verify.sh, answer from these sections first:
   - Router
   - Routing Health
   - Catalog Capacity
   - Growth Trends
   - Freshness
   - Drift
   - Result

4. If the command is ./scripts/router-health-report or --save, answer from these sections first:
   - Summary
   - Routing Health
   - Catalog Capacity
   - Growth vs latest saved snapshot
   - Freshness
   - Traffic Snapshot
   - Drift

5. If the command is ./scripts/catalog-review-report or --save, answer from these sections first:
   - Summary
   - Static Coverage Review
   - Domain Coverage Review
   - Recommendation Mode
   Explicitly say this is advisory-only and that no runtime changes were applied.

6. For health/capacity answers explicitly mention:
   - VPN_DOMAINS current / maxelem / usage / headroom
   - VPN_STATIC_NETS current
   - manual rule count
   - auto rule count
   - latest growth delta if present
   - growth level / growth note if present
   - any warning/critical freshness item

7. In traffic answers always include:
   - report window from the script output
   - WAN total
   - VPN total
   - WG server total
   - Tailscale total when relevant
   - VPN share/WAN

8. If the report contains "DEVICE TRAFFIC MIX", use that block first for per-device interpretation:
   - mention Per-device byte window
   - mention Device byte total
   - mention Via VPN
   - mention Direct WAN
   - mention top devices by VPN bytes
   - mention top devices by direct WAN bytes

9. If the report contains "TOP BY WG SERVER PEERS" or "TOP BY TAILSCALE PEERS", mention the busiest remote peers before the full peer tables.

10. If the report contains "LAN DEVICE BYTES", use it for exact per-device byte numbers.
   If the report contains only "LAN DEVICES", explain that these are active conntrack counts, not bytes.

11. If the report window is week/month, explicitly warn when "Per-device byte window" is narrower than the main report window.

12. Never expose private router IPs, client private IPs, MAC addresses, SSH keys, raw endpoints, or unredacted device names unless the user explicitly asks for trusted local inspection.

13. If the user asks about future optimization of domains/catalog/routing coverage:
   - start from docs/future-improvements-backlog.md
   - verify what is already implemented vs still future
   - prefer review/plan first, not runtime changes
   - do not change live router config unless the user explicitly asks for implementation
```

## Готовые пользовательские формулировки

Если хочется стабильный UX для будущих запросов, агенту полезно понимать такие формулировки как эквивалентные:

- `дай отчёт за сегодня`
- `дай отчёт за день`
- `дай отчёт за вчера`
- `дай отчёт за неделю`
- `дай отчёт за месяц`
- `покажи трафик за неделю с устройствами`
- `покажи сколько прошло через VPN и сколько мимо`
- `дай разрез по устройствам: VPN / WAN / total`
- `проверь состояние роутера`
- `дай health report`
- `сохрани sanitised snapshot для llm`
- `посмотри как оптимизировать каталог доменов`
- `сделай review vpn domains backlog`
- `проверь не разросся ли auto-catalog и что с этим делать`

## Что запускать

### Future: оптимизация доменов и каталога

Если пользователь спрашивает не про текущий traffic/health, а про будущую оптимизацию доменов, coverage или каталога:

1. Сначала читать:
   - `docs/future-improvements-backlog.md`
   - `docs/domain-management.md`
   - `docs/current-routing-explained.md`
   - `docs/traffic-observability.md`
2. Затем проверить, что уже реализовано, а что всё ещё остаётся future:
   - сначала по самим документам и backlog
   - при необходимости дополнительно через `./verify.sh`, `./scripts/router-health-report`, `./scripts/catalog-review-report`
3. По умолчанию отдавать:
   - review
   - backlog-status
   - безопасный пошаговый план
4. Не менять runtime по умолчанию, если пользователь явно не попросил implementation.

Что особенно важно проговаривать:

- `VPN_DOMAINS current / maxelem / usage / headroom`
- `VPN_STATIC_NETS current`
- manual / auto rule counts
- latest growth delta
- `growth level` / `growth note`
- есть ли warning/critical item в `Freshness`
- нет ли признаков, что auto-catalog стал источником разрастания
- какие broad static CIDR сейчас крупнейшие
- какие child domains уже покрыты parent-rule и выглядят как cleanup-candidates
- что уже закрыто в backlog, а что остаётся future

### Health / capacity / drift

```bash
./verify.sh
./verify.sh --verbose
./scripts/router-health-report
./scripts/router-health-report --save
./scripts/catalog-review-report
./scripts/catalog-review-report --save
./scripts/dns-forensics-report
./scripts/dns-forensics-report 2026-04-21T05
./scripts/dns-forensics-report 2026-04-21T05 --ip 192.168.50.34
```

Минимальный рекомендуемый набор команд для типового workflow:

```bash
# Быстрый health
./verify.sh

# Сохранить sanitised snapshot для человека, LLM и USB-backed storage
./scripts/router-health-report --save

# Сегодняшний трафик
./scripts/traffic-report

# Недельный / месячный трафик
./scripts/traffic-daily-report week
./scripts/traffic-daily-report month
```

Когда использовать:

- `./verify.sh`
  когда нужен быстрый live health-summary по routing-инвариантам, freshness и drift
- `./verify.sh --verbose`
  когда нужен подробный низкоуровневый dump для ручной диагностики
- `./scripts/router-health-report`
  когда нужен sanitised Markdown-отчёт, который можно сразу читать человеку или LLM
- `./scripts/router-health-report --save`
  когда нужно одновременно:
  - обновить tracked `docs/router-health-latest.md`
  - записать local snapshot в `docs/vpn-domain-journal.md`
  - сохранить копию на USB-backed storage роутера

USB-backed destination:

- primary: `/opt/var/log/router_configuration/reports/`
- fallback: `/jffs/addons/router_configuration/traffic/reports/`

Для ответов по health/capacity придерживайтесь порядка секций самого отчёта:

1. Для `./verify.sh`:
   - `Router`
   - `Routing Health`
   - `Catalog Capacity`
   - `Growth Trends`
   - `Freshness`
   - `Drift`
   - `Result`
2. Для `./scripts/router-health-report` и `--save`:
   - `Summary`
   - `Routing Health`
   - `Catalog Capacity`
   - `Growth vs latest saved snapshot`
   - `Freshness`
   - `Traffic Snapshot`
   - `Drift`
3. Для `./scripts/catalog-review-report` и `--save`:
   - `Summary`
   - `Static Coverage Review`
   - `Domain Coverage Review`
   - `Recommendation Mode`
   - явно говорить, что это advisory-only review и runtime changes не применялись

### Текущий день

```bash
./scripts/traffic-report
```

Безопасный дефолт:

- скрипт уже редактирует peer names, LAN hostnames, tunnel addresses и endpoints
- это режим по умолчанию

Никогда не снимайте редактирование без прямой необходимости. Если trusted local inspection всё же нужен:

```bash
REPORT_REDACT_NAMES=0 ./scripts/traffic-report
```

Использовать, когда нужен ответ:

- что происходит сегодня
- сколько уже прошло через `WAN` / `VPN` / `WG server` / `Wi-Fi` / `Tailscale`
- какие LAN-устройства уже дали заметный объём трафика и в какой канал он ушёл
- какие локальные устройства активны прямо сейчас
- какие raw `WireGuard server` peer'ы сейчас активны

### Почасовой forensic DNS-срез

```bash
./scripts/dns-forensics-report
./scripts/dns-forensics-report 2026-04-21T05
./scripts/dns-forensics-report 2026-04-21T05 --ip 192.168.50.34
```

Использовать, когда нужен ответ:

- что происходило около конкретного часа, например `05:00`
- какие клиенты были самыми активными по DNS в этот час
- какие raw domains и service families чаще всего запрашивал конкретный клиент

Что важно проговаривать:

- это hourly DNS-interest snapshot, а не byte accounting
- такие данные хорошо объясняют вероятный сервис/тип активности
- но для утверждения про объём трафика их нужно сверять с `traffic-report` / `traffic-daily-report`

### Закрытый дневной отчёт

```bash
./scripts/traffic-daily-report yesterday
./scripts/traffic-daily-report 2026-04-14
./scripts/traffic-daily-report week
./scripts/traffic-daily-report month
```

При необходимости trusted local inspection:

```bash
REPORT_REDACT_NAMES=0 ./scripts/traffic-daily-report today
```

Использовать, когда нужен ответ:

- сколько было за конкретный день
- сколько уже накопилось за текущую неделю
- сколько уже накопилось за текущий месяц
- какие LAN-устройства дали основной объём трафика за день/неделю/месяц
- какие `Tailscale` peer'ы дали трафик за этот день
- какие raw `WireGuard server` peer'ы дали трафик за этот день
- какой был end-of-day снимок локальных устройств
- какой был end-of-day снимок raw `WireGuard server` peer'ов

### Когда данные закрытого дня появляются

Роутер:

- каждые 6 часов пишет raw snapshots
- в `23:55` делает closing snapshot дня

Поэтому закрытый отчёт за день лучше смотреть:

- после `23:55` того же дня
- или в любой момент на следующий день

Для `week/month`:

- если история начала собираться недавно, окно начнётся с самого раннего доступного snapshot внутри периода
- это нормально и должно отражаться в строке `Window start`

## Как интерпретировать вывод

### Точные накопленные счётчики

- `WAN total`
- `VPN total`
- `WG server total`
- `Wi-Fi total`
- `LAN bridge`
- `Tailscale total`
- строки `LAN DEVICE BYTES`
- строки `WIREGUARD SERVER PEERS` (`RX` / `TX`)
- строки `TAILSCALE PEERS` (`RX` / `TX`)

Все эти выводы по умолчанию уже в redacted-виде.

Это байты/гигабайты.

### Не байты, а снимок соединений

Раздел `LAN DEVICES`:

- `Total`
- `VPN`
- `WAN`
- `Local`

Это количество `conntrack`-записей, а не объём трафика.

Раздел `LAN DEVICE BYTES`:

- `Total`
- `VPN`
- `WAN`
- `Other`
- `Upload`
- `Download`

Это уже байты, накопленные по iptables mangle counters на роутере.

Раздел `DEVICE TRAFFIC MIX (LAN SOURCES)`:

- это короткая interpretive summary над теми же `LAN DEVICE BYTES`
- `Via VPN` = historical label для per-device байтов, прошедших через repo-managed routed path; в текущей схеме для LAN это прежде всего Channel B через REDIRECT `:<lan-redirect-port>`, а не обязательно `wgc1`
- `Direct WAN` = сумма per-device байтов, ушедших напрямую мимо VPN
- `Top devices by VPN bytes` = устройства с наибольшим объёмом VPN-трафика
- `Top devices by direct WAN bytes` = устройства, которые больше всего обходили VPN

Если человек спрашивает “где тут WAN по устройствам?” или “сколько устройств пошло через VPN?”, начинайте именно с этого блока, а не с сырых строк таблицы.

`TOP BY WG SERVER PEERS` и `TOP BY TAILSCALE PEERS`:

- это короткие peer-level summaries
- их нужно использовать первыми, если человек спрашивает "какие удалённые клиенты были самыми активными"
- полные таблицы `WIREGUARD SERVER PEERS` и `TAILSCALE PEERS` нужны уже для точных значений, handshake и last seen

## Как интерпретировать health-report

### `Catalog Capacity`

Это каталог и его текущая ёмкость, а не “трафик за период”.

Нужно проговаривать:

- `VPN_DOMAINS current`
- `VPN_DOMAINS maxelem`
- usage %
- headroom
- `VPN_STATIC_NETS current`
- manual rule count
- auto-discovered rule count

Если в health-report есть блок роста относительно сохранённого snapshot:

- это delta к последнему local journal snapshot
- это не “за день” и не “за неделю” автоматически
- `VPN_DOMAINS` — накопительное live-state ipset, которое сохраняется на USB и переживает рестарты
- `Growth level` — компактная оценка риска по usage/headroom и скорости роста
- `Growth note` — короткая интерпретация, похоже ли, что именно auto-catalog сейчас даёт основной вклад в рост

### `Freshness`

`Freshness` показывает, насколько свежие operational artifacts видит скрипт:

- blocked list
- ipset persistence file
- interface counters snapshot
- tailscale snapshot
- wgs1 snapshot
- daily close snapshot

Если статус не `OK`, это надо явно сказать человеку, потому что:

- `Warning` / `Critical` означают risk для актуальности observability
- `Missing` означает, что соответствующий слой snapshots ещё не накопился или отсутствует

### `Drift`

`Drift` — это не “всё подряд отличается”, а только repo-managed инварианты:

- ipset'ы
- routing hooks
- `ip rule`
- DNS redirect для `wgs1`

Если drift пустой, можно честно говорить:

- repo-managed routing layer сейчас на месте
- проблема, если она есть, вероятнее в данных, freshness или внешнем клиенте, а не в missing hook

Строка `Per-device byte window` важна отдельно:

- она показывает реальный интервал, за который накопились per-device байты
- в `week/month` это окно может быть уже, чем общий `Window start .. Window end`
- если история per-device счётчиков начала собираться позже, обязательно проговаривайте это явно в ответе

`Other` означает трафик LAN-устройства, который не попал в распознанный routed path или `wan0` по нашей грубой классификации. Обычно туда попадает локальная сеть, межLAN-трафик и прочие не-внешние направления.

Раздел `WIREGUARD SERVER PEERS (CURRENT|END-OF-DAY CONNECTION SNAPSHOT)`:

- `Total`
- `VPN`
- `WAN`
- `Local`

Это тоже количество `conntrack`-записей, а не объём трафика.

## Что нельзя утверждать

Для `Tailscale Exit Node` нельзя честно говорить:

- сколько именно у `iphone-11` прошло через конкретный upstream (`wgc1` или REDIRECT/Reality), если этот peer пришёл через userspace proxy и нет отдельной per-peer разбивки по egress
- а сколько именно у того же `iphone-11` прошло напрямую через `WAN`

Можно говорить только:

- сколько peer передал по `Tailscale` всего
- сколько роутер в целом передал через наблюдаемые интерфейсы/counters (`wgc1`, REDIRECT/sing-box, WAN), если соответствующие counters есть в отчёте

Для raw `WireGuard server` говорить можно точнее:

- сколько peer передал по `wgs1`
- сколько у peer'а было active conntrack entries в `VPN` / `WAN` / `Local`

Но это всё равно не полноценный NetFlow/pcap учёт на каждый запрос.

Для hourly DNS forensics тоже нельзя честно говорить:

- что топ-DNS домен автоматически означает такой же top по байтам
- что один CDN hostname сам по себе доказывает конкретный файл или приложение

Можно говорить только:

- какой клиент в этот час чаще всего делал DNS-запросы
- какие домены и доменные семейства у него преобладали
- какие это даёт правдоподобные гипотезы о типе активности

## Как отвечать пользователю

Предпочтительный формат:

1. Коротко назвать окно отчёта (`today` или конкретная дата).
   Для `week/month` указывать диапазон дат из заголовка скрипта.
2. Дать totals:
   - `WAN`
   - `VPN`
   - `WG server`
   - `Wi-Fi`
   - `Tailscale`
3. Если есть раздел `LAN DEVICE BYTES`, назвать 1-3 самых активных LAN-устройства и объём `VPN` / `WAN`.
4. Отдельно перечислить `WIREGUARD SERVER PEERS`, у которых не ноль.
5. Отдельно перечислить `Tailscale peers`, у которых не ноль.
6. Отдельно пояснить, что `LAN DEVICES` и `WIREGUARD SERVER PEERS (... CONNECTION SNAPSHOT)` — это снимки соединений, не байты.

## Чего не выводить в ответ

Не публиковать без необходимости:

- private IP роутера
- private IP локальных клиентов
- MAC-адреса
- SSH-команды с чувствительными путями или ключами
- сырые конфиги с ключами / токенами / endpoint'ами
- живые имена peer'ов и hostnames, если отчёт запускался с `REPORT_REDACT_NAMES=0`
