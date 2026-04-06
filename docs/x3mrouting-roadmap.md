# Обнаружение доменов (Domain Discovery)

## Роль в проекте

Domain discovery — автоматический и ручной процесс нахождения новых доменов для маршрутизации через VPN.

Нативный pipeline `dnsmasq → ipset → iptables → ip rule → WGC1` остаётся **единственным механизмом маршрутизации**. Discovery только находит домены — routing делает основной pipeline.

## Два режима обнаружения

### Режим 1: Автоматический (основной)

Скрипт `domain-auto-add.sh` запускается каждый час через cron и автоматически добавляет новые домены в VPN:

```
dnsmasq.log → domain-auto-add.sh → dnsmasq-autodiscovered.conf.add → dnsmasq restart
```

Что он делает:

1. Парсит `/opt/var/log/dnsmasq.log` — извлекает все уникальные домены
2. Нормализует `dnsmasq-autodiscovered.conf.add` и вычищает child-записи, уже покрытые ручными или более широкими auto-правилами
3. Фильтрует по очереди (первый совпавший фильтр = SKIP):
   - Системные домены (`.local`, `.lan`, `.arpa`)
   - CDN/infrastructure паттерны (`cloudfront.net`, `akamaiedge.net`, `akadns.net`, `windowsupdate.com` и др.)
   - Российские TLD (`.ru`, `.su`, `.рф`, `.москва`, `.tatar`, `.moscow`)
   - Домены из `domains-no-vpn.txt` (ручные исключения)
   - Домены, уже покрытые правилом в `dnsmasq.conf.add` или `dnsmasq-autodiscovered.conf.add` по ancestor suffix
4. **Проверяет по реестру РКН** (`blocked-domains.lst`) — не найден → КАНДИДАТ. Если список не скачан → fallback (добавлять всё)
5. **ISP-проба кандидатов** — пороги считаются по окнам `24h` и `7d`: базово `count24h` (`>=3` для обычных, `>=1` для коротких/`www` и dynamic DNS IP-encoded family), плюс сигнал user-interest (`count7d >= 10` и `active_days7d >= 2`). Отбор: `2 interest + 10 top-score + 4 fair`. `curl --interface wan0`, 4 сек. HTTP 000 → добавляется как **geo-blocked** (сайт блокирует российские IP сам). Максимум 16 проб за запуск
6. **Определяет write_domain**: обычно поддомен (≥3 меток) → registrable domain (`example-provider.invalid` вместо `www.example-provider.invalid`), но для dynamic DNS с IP-encoded family label пишет семейство по IP-лейблу
7. Перед записью делает повторный suffix coverage check — если write-domain уже покрыт, новая child-запись не создаётся
8. Записывает в `/jffs/configs/dnsmasq-autodiscovered.conf.add`:
   - `ipset=/<domain>/VPN_DOMAINS`
   - `server=/<domain>/1.1.1.1@wgc1`
   - `server=/<domain>/9.9.9.9@wgc1`
9. Перезапускает dnsmasq, пишет лог в `/opt/var/log/domain-activity.log`, ротирует dnsmasq.log

Полная схема алгоритма: [domain-management.md](domain-management.md#алгоритм----как-домен-попадает-в-vpn).

Автоматически добавленные домены хранятся **отдельно** от ручных:

| Файл | Управляется | Хранится в git |
|---|---|---|
| `dnsmasq.conf.add` | `deploy.sh` (managed blocks) | Да |
| `dnsmasq-autodiscovered.conf.add` | `domain-auto-add.sh` (cron) | Нет |

### Режим 2: Ручной (для целевого анализа)

Утилиты x3mRouting для разовых сессий discovery:

```sh
# Все уникальные домены из текущего лога
getdomainnames.sh

# Поиск по ключевому слову
# x3mRouting ALL 1 YOUTUBE autoscan=youtube
```

Ручной режим полезен, когда нужно разобраться, какие домены использует конкретный сервис (YouTube, TikTok, Instagram). Результаты анализируются вручную и переносятся в `configs/dnsmasq.conf.add` и `configs/dnsmasq-vpn-upstream.conf.add`.

## Исключения

### Российские TLD (автоматические)

`domain-auto-add.sh` автоматически пропускает все домены с российскими TLD:

- `.ru` — основной
- `.su` — советский (всё ещё используется)
- `.рф` (`.xn--p1ai`) — кириллический
- `.москва` (`.xn--80adxhks`) — Москва
- `.tatar` — Татарстан
- `.moscow` — Москва (латиница)

Эти домены доступны из России без VPN.

### Ручные исключения (`domains-no-vpn.txt`)

Для российских сервисов на зарубежных TLD, которые не нужно маршрутизировать через VPN:

```
# configs/domains-no-vpn.txt
championat.com
meduza.io
```

Поддомены учитываются автоматически: `example.com` покрывает `www.example.com`.

### Список заблокированных доменов (blocked-domains.lst)

Скрипт `update-blocked-list.sh` ежедневно (cron, 5:00) скачивает кураторский список доменов, заблокированных в России, из [community.antifilter.download](https://community.antifilter.download).

- Список содержит ~500 ключевых заблокированных сервисов (Instagram, Twitter, LinkedIn, ChatGPT и др.)
- Скачивается **через VPN** (сам antifilter.download может быть заблокирован)
- Кэшируется в `/opt/tmp/blocked-domains.lst`
- Если скачивание не удалось — используется кэшированная версия
- Если списка нет совсем — `domain-auto-add.sh` работает в fallback-режиме (добавляет всё, как раньше)

**Важно:** YouTube, Telegram, GitHub и другие сервисы, заблокированные не через реестр РКН (а через DPI/IP), **не входят** в этот список. Они покрываются ручными правилами в `dnsmasq.conf.add`.

Мониторинг:
```bash
./scripts/domain-report --candidates   # домены, пропущенные из-за отсутствия в списке
```

### Системные паттерны (SKIP_PATTERNS)

CDN и infrastructure-домены, которые не имеет смысла маршрутизировать:

- `msftconnecttest.com`, `windowsupdate.com`, `update.microsoft.com`
- `apple-dns.net`, `captive.apple.com`
- `cloudfront.net`, `akamaized.net`, `akamaiedge.net`
- `akadns.net`, `connectivitycheck`

## Мониторинг

### Лог активности

Каждый запуск `domain-auto-add.sh` пишет запись в `/opt/var/log/domain-activity.log`:

```
┌─────────────────────────────────────────────────────────────
│ 2026-03-30 16:00   период 12:00–16:00   DNS-запросов: 4521
├─────────────────────────────────────────────────────────────
│ ДОБАВЛЕНО В VPN (3):
│  + api.example.com                            12 запр  [192.0.2.10]
│  + cdn.service.net                             8 запр  [192.0.2.10,198.51.100.20]
│  + app.newsite.org                             5 запр  [198.51.100.20]
│
│ Итог: +3 добавлено  |  145 уже в VPN  |  89 системных пропущено
└─────────────────────────────────────────────────────────────
```

Лог ротируется при достижении 5 МБ. Архивы сохраняются с датами: `domain-activity_2026-03-01_2026-03-30.log`.

### Утилита domain-report (запускается с Mac)

```bash
# Сводка: авто-добавленные домены + последний запуск
./scripts/domain-report

# Подробный лог (последние N строк)
./scripts/domain-report --log
./scripts/domain-report --log 500

# Все авто-добавленные домены (список)
./scripts/domain-report --all

# Cleanup: убрать child auto-домены, уже покрытые родителем
./scripts/domain-report --cleanup

# Сброс: удалить все авто-добавленные домены
./scripts/domain-report --reset
```

## Почему мы НЕ используем routing-функции x3mRouting

x3mRouting умеет строить полный routing pipeline (ipset → iptables → ip rule), но:

- Его routing исторически заточен под **OpenVPN**, а не WireGuard
- У нас уже есть рабочий нативный pipeline через WGC1, который полностью контролируем
- Использование x3mRouting как routing engine создаёт зависимость и потенциальные конфликты с нашими managed-блоками

Мы берём от x3mRouting **только** утилиты анализа DNS-логов: `getdomainnames.sh` и `autoscan`.

## Ограничения

- **Видит только DNS через dnsmasq.** Устройства должны использовать роутер как DNS-сервер. DoH на устройстве, DNS VPN-провайдера или хардкод DNS — невидимы.
- **DNS-based discovery.** Не видит HTTPS-трафик или содержимое соединений.
- **Не магия.** Показывает только то, что фактически запрашивалось в текущем периоде. Новые домены сервиса обнаружатся при следующем обращении к нему.
- **Сырой вывод ручного режима.** `getdomainnames.sh` выдаёт домены вперемешку с рекламными трекерами и analytics — нужна ручная фильтрация. Автоматический режим (`domain-auto-add.sh`) фильтрует автоматически.

## Инфраструктура

| Компонент | Путь на роутере |
|---|---|
| Скрипт auto-discovery | `/jffs/addons/x3mRouting/domain-auto-add.sh` |
| Обновление списка блокировок | `/jffs/addons/x3mRouting/update-blocked-list.sh` |
| Список заблокированных доменов | `/opt/tmp/blocked-domains.lst` |
| Авто-добавленные домены | `/jffs/configs/dnsmasq-autodiscovered.conf.add` |
| Список исключений | `/jffs/configs/domains-no-vpn.txt` |
| Лог DNS-запросов | `/opt/var/log/dnsmasq.log` |
| Лог активности | `/opt/var/log/domain-activity.log` |
| getdomainnames.sh | `/jffs/addons/x3mRouting/getdomainnames.sh` |
| autoscan.sh | `/jffs/addons/x3mRouting/prior_prior/prior/prior/prior/prior/prior/prior/prior/prior/autoscan.sh` |
| Cron: auto-discovery | `0 * * * *` (DomainAutoAdd) |
| Cron: обновление списка блокировок | `0 5 * * *` (UpdateBlockedList) |

## Источники

- x3mRouting: https://github.com/Xentrk/x3mRouting
- SNBForums: https://www.snbforums.com/threads/x3mrouting-selective-routing-for-asuswrt-merlin-firmware.57793/page-22

## Связанные документы

- [architecture.md](architecture.md) — как устроена маршрутизация и где место auto-discovery
- [domain-management.md](domain-management.md) — как добавлять домены вручную и работать с авто-добавленными
- [current-routing-explained.md](current-routing-explained.md) — полный список роутимых доменов
