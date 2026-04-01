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
- `domain-auto-add.sh` каждые 4 часа автоматически добавляет новые домены в VPN
- ipset-состояние хранится на USB (`/opt/tmp/VPN_DOMAINS.ipset`) — меньше износ JFFS

Подробности: [x3mrouting-roadmap.md](x3mrouting-roadmap.md)

---

## Шаг 5. Настройка .env (опционально, но рекомендуется)

Для удобства создайте файл `.env` на основе шаблона и заполните своими значениями:

```bash
cp .env.example .env
# Отредактируйте .env и раскомментируйте нужные переменные
```

Файл `.env` добавлен в `.gitignore` и **никогда не попадёт в git**.

## Шаг 6. Деплой

```bash
./deploy.sh
```

Скрипт автоматически загружает `.env` и определяет IP роутера из default gateway. Если нужно указать IP вручную без `.env`:

```bash
ROUTER=192.0.2.1 ./deploy.sh
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

```
== Router ==
RT-AX88U-Pro              ← модель роутера
388.7_0_AX-...            ← версия прошивки

== Capabilities ==
Entware: not detected     ← нормально, если USB не подключен
ipset: ok                 ← необходим для работы
iptables: ok              ← необходим для работы

== Routing ==
9901: from all to 1.1.1.1 lookup wgc1    ← DNS через VPN
9902: from all to 9.9.9.9 lookup wgc1    ← DNS через VPN
9910: from all fwmark 0x1000 lookup wgc1  ← помеченный трафик через VPN
default via 10.x.x.x dev wgc1            ← маршрут VPN (если подключен)

== IPSet ==
Name: VPN_DOMAINS
Type: hash:ip             ← набор для доменных IP
...
Members:                  ← список IP (наполняется по мере DNS-запросов)

Name: VPN_STATIC_NETS
Type: hash:net            ← набор для CIDR-подсетей
...
Members:                  ← подсети Telegram
```

Ключевые проверки:

- `ipset: ok` и `iptables: ok` — без них ничего не работает
- Три `ip rule` (9901, 9902, 9910) — если отсутствуют, трафик не уходит в VPN
- `VPN_STATIC_NETS` содержит подсети Telegram — если пуст, проверьте `static-networks.txt`
- Таблица `wgc1` не пуста — если пуста, WireGuard-клиент не подключен

## Дальнейшие действия

- [Как добавить или удалить домен](domain-management.md)
- [Как устроена архитектура](architecture.md)
- [Что делать, если что-то не работает](troubleshooting.md)
- [Подробности про Telegram](telegram-deep-dive.md)
