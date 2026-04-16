# LLM Traffic Runbook

Короткая инструкция для агента/LLM, который должен посмотреть трафик роутера и ответить человеку без утечки приватных данных.

## Готовая инструкция для агента

Ниже блок, который можно почти без изменений вставлять в системный prompt / AGENTS / CLAUDE для агента, который должен уметь отвечать на запросы вида "дай отчёт за день / неделю / месяц".

```txt
When the user asks for a router traffic report in Russian or English:

1. Map the request to the correct command:
   - "сегодня", "текущий день", "today", "current day" -> ./scripts/traffic-report
   - "вчера", "yesterday" -> ./scripts/traffic-daily-report yesterday
   - specific date like 2026-04-14 -> ./scripts/traffic-daily-report 2026-04-14
   - "неделя", "за неделю", "week" -> ./scripts/traffic-daily-report week
   - "месяц", "за месяц", "month" -> ./scripts/traffic-daily-report month

2. Default to redacted mode. Use REPORT_REDACT_NAMES=0 only for trusted local inspection when the user explicitly wants device-level identification.

3. In the answer always include:
   - report window from the script output
   - WAN total
   - VPN total
   - WG server total
   - Tailscale total when relevant
   - VPN share/WAN

4. If the report contains "DEVICE TRAFFIC MIX (LAN SOURCES)", use that block first for per-device interpretation:
   - mention Per-device byte window
   - mention Device byte total
   - mention Via VPN
   - mention Direct WAN
   - mention top devices by VPN bytes
   - mention top devices by direct WAN bytes

5. If the report contains "LAN DEVICE BYTES", use it for exact per-device byte numbers.
   If the report contains only "LAN DEVICES", explain that these are active conntrack counts, not bytes.

6. If the report window is week/month, explicitly warn when "Per-device byte window" is narrower than the main report window.

7. Never expose private router IPs, client private IPs, MAC addresses, SSH keys, raw endpoints, or unredacted device names unless the user explicitly asks for trusted local inspection.
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

## Что запускать

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
- `Via VPN` = сумма per-device байтов, прошедших через `wgc1`
- `Direct WAN` = сумма per-device байтов, ушедших напрямую мимо VPN
- `Top devices by VPN bytes` = устройства с наибольшим объёмом VPN-трафика
- `Top devices by direct WAN bytes` = устройства, которые больше всего обходили VPN

Если человек спрашивает “где тут WAN по устройствам?” или “сколько устройств пошло через VPN?”, начинайте именно с этого блока, а не с сырых строк таблицы.

Строка `Per-device byte window` важна отдельно:

- она показывает реальный интервал, за который накопились per-device байты
- в `week/month` это окно может быть уже, чем общий `Window start .. Window end`
- если история per-device счётчиков начала собираться позже, обязательно проговаривайте это явно в ответе

`Other` означает трафик LAN-устройства, который не попал в `wgc1` или `wan0` по нашей грубой классификации. Обычно туда попадает локальная сеть, межLAN-трафик и прочие не-внешние направления.

Раздел `WIREGUARD SERVER PEERS (CURRENT|END-OF-DAY CONNECTION SNAPSHOT)`:

- `Total`
- `VPN`
- `WAN`
- `Local`

Это тоже количество `conntrack`-записей, а не объём трафика.

## Что нельзя утверждать

Для `Tailscale Exit Node` нельзя честно говорить:

- сколько именно у `iphone-11` прошло через `wgc1`
- а сколько именно у того же `iphone-11` прошло напрямую через `WAN`

Можно говорить только:

- сколько peer передал по `Tailscale` всего
- сколько роутер в целом передал через `wgc1`

Для raw `WireGuard server` говорить можно точнее:

- сколько peer передал по `wgs1`
- сколько у peer'а было active conntrack entries в `VPN` / `WAN` / `Local`

Но это всё равно не полноценный NetFlow/pcap учёт на каждый запрос.

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
