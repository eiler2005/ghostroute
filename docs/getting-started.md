# Быстрый старт

## Требования

- Роутер ASUS RT-AX88U Pro (или совместимый) с прошивкой Asuswrt-Merlin `3006.x`
- WireGuard-клиент `WGC1` настроен и подключен на роутере
- SSH включен на роутере (Administration → System → Enable SSH)
- macOS или Linux с установленными `ssh`, `scp`, `nc`
- SSH-ключ на вашей машине (по умолчанию `~/.ssh/id_rsa`)

## Шаг 1. Подготовка роутера

### Включить WireGuard

В web-интерфейсе роутера:

1. VPN → VPN Client → WireGuard
2. Настроить профиль WGC1 с конфигурацией вашего VPN-провайдера
3. Подключить и убедиться, что статус — Connected

### Включить SSH

В web-интерфейсе роутера:

1. Administration → System → Service
2. Enable SSH: **LAN only**
3. SSH port: **22** (или другой по желанию)
4. Allow SSH password login: **Yes** (на время настройки)
5. Apply

## Шаг 2. Настройка SSH-ключа

Если SSH-ключ уже есть, пропустите этот шаг.

```bash
# Генерация ключа (если нет)
ssh-keygen -t rsa -b 4096

# Копирование публичного ключа на роутер
cat ~/.ssh/id_rsa.pub | ssh admin@<router_ip> \
  "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

Merlin использует dropbear, который может не поддерживать новые алгоритмы. Скрипты деплоя уже включают параметр `PubkeyAcceptedAlgorithms=+ssh-rsa` для совместимости.

### Проверка подключения

```bash
ssh -o PubkeyAcceptedAlgorithms=+ssh-rsa admin@<router_ip>
```

## Шаг 3. Клонирование репозитория

```bash
git clone <url_репозитория>
cd router_configuration
```

## Шаг 4. Entware + автоматическое обнаружение доменов (опционально)

Для автоматического обнаружения новых доменов нужен Entware на USB-накопителе.

### Требования

- USB-накопитель, отформатированный в **ext4** (не NTFS, не FAT32)
- Накопитель подключён и смонтирован в `/tmp/mnt/<метка>`

### Установка Entware через amtm

```bash
ssh admin@<router_ip>
amtm
# → выбрать установку Entware
```

После установки Entware:

```bash
which opkg   # должен вернуть /opt/bin/opkg
ls /opt/bin  # утилиты Entware
```

### Что это даёт

После установки Entware и деплоя с `ENABLE_DNSMASQ_LOGGING=1`:

- DNS-лог пишется в `/opt/var/log/dnsmasq.log`
- `domain-auto-add.sh` каждый час автоматически добавляет новые домены в VPN
- ipset-состояние хранится на USB (`/opt/tmp/VPN_DOMAINS.ipset`) — меньше износ JFFS

Подробности: [x3mrouting-roadmap.md](x3mrouting-roadmap.md)

---

## Шаг 5. Настройка локальных secrets (опционально, но рекомендуется)

Для удобства создайте файл `secrets/router.env` на основе шаблона и заполните своими значениями:

```bash
mkdir -p secrets
cp .env.example secrets/router.env
# Отредактируйте secrets/router.env и раскомментируйте нужные переменные
```

Директория `secrets/` добавлена в `.gitignore` и **никогда не попадёт в git**.
Для обратной совместимости скрипты всё ещё читают `.env`, если `secrets/router.env` отсутствует.

## Шаг 6. Деплой

```bash
./deploy.sh
```

Скрипт автоматически загружает `secrets/router.env` и определяет IP роутера из default gateway. Если нужно указать IP вручную без локального secrets-файла:

```bash
ROUTER=<router_lan_ip> ./deploy.sh
```

Все поддерживаемые переменные окружения:

| Переменная | По умолчанию | Описание |
|---|---|---|
| `ROUTER` | auto (default gateway) | IP роутера |
| `ROUTER_USER` | `admin` | SSH-пользователь |
| `ROUTER_PORT` | `22` | SSH-порт |
| `SSH_IDENTITY_FILE` | `~/.ssh/id_rsa` | Путь к SSH-ключу |
| `CONNECT_TIMEOUT` | `5` | Таймаут подключения (секунды) |
| `ENABLE_DNSMASQ_LOGGING` | `1` | DNS-логирование для auto-discovery (`0` — выключить) |

### Что делает deploy.sh

1. Определяет IP роутера
2. Проверяет доступность SSH
3. Загружает конфиги и скрипты на роутер по SCP
4. Создаёт бэкапы существующих файлов
5. Встраивает конфигурацию через managed-блоки (безопасно повторяемо)
6. Запускает скрипты и перезапускает dnsmasq
7. Предупреждает, если WGC1 не подключен

## Шаг 7. Проверка

```bash
./verify.sh
```

### Что означает вывод verify.sh

`verify.sh` теперь по умолчанию печатает компактный health-summary:

```txt
=== Router ===
Product: RT-AX88U_PRO
Build: 102.7_2

=== Routing Health ===
VPN_DOMAINS ipset OK
...

=== Catalog Capacity ===
VPN_DOMAINS current 7125
VPN_DOMAINS maxelem 65536
Usage 10.9%

=== Freshness ===
Blocked list OK (5h 59m)
...

=== Drift ===
No missing repo-managed invariants detected.

=== Result ===
OK
```

Ключевые проверки:

- `Routing Health`:
  - `VPN_DOMAINS ipset`, `VPN_STATIC_NETS ipset`, `RC_VPN_ROUTE chain`
  - `ip rule 1.1.1.1 -> wgc1`, `ip rule 9.9.9.9 -> wgc1`, `ip rule fwmark 0x1000`
  - hooks для `br0`, `wgs1`, `OUTPUT`
  - DNS redirect для `wgs1`
- `Catalog Capacity`:
  - текущий размер `VPN_DOMAINS`
  - `maxelem`
  - usage/headroom
  - число `VPN_STATIC_NETS`, manual rules, auto rules
- `Freshness`:
  - blocked list
  - ipset persistence
  - traffic snapshots
  - Tailscale / WGS1 / daily close artifacts

Если нужен старый развёрнутый dump:

```bash
./verify.sh --verbose
```

## Шаг 8. Проверка traffic observability

После первого деплоя полезно сразу проверить, что отчёты и snapshots работают.

### Текущий день

```bash
./scripts/traffic-report
```

Что должно быть в выводе:

- `WAN total`
- `VPN total`
- `WG server total`
- `Tailscale total`
- `LAN DEVICES`
- `WIREGUARD SERVER PEERS`
- `TAILSCALE PEERS`

По умолчанию имена peer'ов, hostnames, tunnel addresses и endpoints в отчёте **редактируются**.

Если нужен полный локальный просмотр без редактирования:

```bash
REPORT_REDACT_NAMES=0 ./scripts/traffic-report
```

Используйте этот режим только в доверенной локальной среде и не вставляйте сырой вывод в git / публичные заметки.

### Закрытый день / период

```bash
./scripts/traffic-daily-report today
./scripts/traffic-daily-report yesterday
./scripts/traffic-daily-report week
./scripts/traffic-daily-report month
```

Что важно:

- snapshots пишутся каждые 6 часов
- close-of-day conntrack snapshot сохраняется в `23:55`
- поэтому полноценный исторический отчёт по новому каналу `wgs1` появится после первых cron-снимков

## Шаг 9. Проверка health-report и USB-backed snapshot

После базовой проверки стоит снять sanitised health-report, который понятен и человеку, и любой LLM:

```bash
./scripts/router-health-report
./scripts/router-health-report --save
```

Что делает `--save`:

- обновляет tracked `docs/router-health-latest.md`
- добавляет local operational snapshot в `docs/vpn-domain-journal.md`
- записывает копию на USB-backed storage роутера:
  - `/opt/var/log/router_configuration/reports/router-health-latest.md`
  - fallback: `/jffs/addons/router_configuration/traffic/reports/router-health-latest.md`

Это полезно для сценария “1–2 кнопки”:

- `./verify.sh` — быстро понять, живы ли инварианты и нет ли drift/freshness problem
- `./scripts/router-health-report --save` — сохранить текущее состояние так, чтобы его могла читать любая LLM из репозитория

## Шаг 10. Локальные тесты observability-слоя

Эти проверки не меняют runtime-конфигурацию роутера:

```bash
bash -n verify.sh scripts/router-health-report scripts/traffic-report scripts/traffic-daily-report scripts/lib/router-health-common.sh tests/test-router-health.sh
./tests/test-router-health.sh
```

Они проверяют:

- shell-синтаксис
- parser/formatter-логику на fixture'ах
- что новые stable sections (`Window`, `Totals`, `Device Traffic Mix`, `Notes`) продолжают рендериться корректно

Подробное описание тестового каталога и того, что именно проверяет каждый fixture/smoke test:
[../tests/README.md](../tests/README.md)

### Если raw WireGuard server client подключается, но `VPN_DOMAINS` не повторяются

Проверьте, что в `firewall-start` есть hook:

```bash
iptables -t mangle -S | grep 'PREROUTING -i wgs1 -j RC_VPN_ROUTE'
```

Если его нет — заново запустите `./deploy.sh`.

Если hook на месте, а по `Wi-Fi/LAN` всё работает, но через raw `WireGuard server` у клиента:

- открывается обычный интернет,
- `claude.ai` / `chatgpt.com` / другие VPN-домены не идут через VPN,
- появляется `dns resolution failure`,

проверьте следующий слой:

```bash
wg show wgs1
wg show wgs1 dump
iptables -t nat -L PREROUTING -v -n | egrep 'wgs1|dpt:53|REDIRECT'
tail -n 100 /opt/var/log/dnsmasq.log | grep '10.6.0.'
```

Как читать результат:

- если у peer `endpoint=(none)` и `rx/tx=0`, проблема ещё до split-routing: клиентский туннель реально не несёт данные
- если `wgs1` жив, но нет DNS-запросов от `10.6.0.x`, клиент не использует DNS роутера внутри туннеля
- если счётчики `REDIRECT ... wgs1 ... dpt:53` растут, raw-клиентский DNS уже принудительно попадает в локальный `dnsmasq`

## Дальнейшие действия

- [Как добавить или удалить домен](domain-management.md)
- [Как устроена архитектура](architecture.md)
- [Как читать traffic-отчёты](traffic-observability.md)
- [LLM-инструкция по запуску traffic-скриптов и готовый prompt для отчётов за день / неделю / месяц](llm-traffic-runbook.md)
- [Что делать, если что-то не работает](troubleshooting.md)
- [Подробности про Telegram](telegram-deep-dive.md)
