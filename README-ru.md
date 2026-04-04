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
    iptables: IP в VPN_DOMAINS?
    ├─ ДА → метка 0x1000 → WireGuard wgc1 → интернет
    └─ НЕТ → прямо через провайдера
```

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
       ├─ Пропустить: уже в VPN
       │
       └─ Проверить по blocked-domains.lst
             ├─ ЕСТЬ в списке → добавить в VPN (автоматически)
             └─ НЕТ → кандидат
                   ├─ короткий входной домен / IP-encoded family?
                   │    → ранняя ISP-проба
                   ├─ ISP-проба = HTTP 000 → добавить как geo-blocked
                   └─ иначе оставить кандидатом
```

Список заблокированных доменов (~500 ключевых сервисов) скачивается ежедневно через VPN-туннель скриптом `update-blocked-list.sh`.

Когда домен проходит auto-discovery, скрипт пишет **service-family domain**:
- обычные поддомены обычно сворачиваются в registrable domain (`api.example-provider.invalid` → `example-provider.invalid`)
- dynamic DNS с IP-encoded family label сохраняет более узкое семейство (`openclaw.203-0-113-10.sslip.io` → `203-0-113-10.sslip.io`)

---

## Ключевые возможности

- **Доменная маршрутизация** — правило `ipset=/youtube.com/VPN_DOMAINS` покрывает домен и все поддомены автоматически
- **DNS через VPN** — для VPN-доменов DNS-запросы идут через Cloudflare/Quad9 по VPN-туннелю (исключает подмену DNS провайдером)
- **Статические IP-диапазоны** — для Telegram, который блокируется на уровне IP, дополнительно добавлены диапазоны подсетей
- **Авто-обнаружение** — каждый час находит и добавляет новые заблокированные домены
- **Умная фильтрация** — добавляет только реально заблокированные домены, а не всё подряд из DNS-лога
- **Идемпотентный деплой** — можно запускать `deploy.sh` сколько угодно раз, конфигурация не задвоится
- **Персистентность** — список IP в ipset сохраняется на USB-накопителе и переживает перезагрузки роутера

---

## Охватываемые сервисы

| Категория | Сервисы |
|---|---|
| AI-инструменты | Claude / Anthropic, ChatGPT / OpenAI, Google AI Studio, NotebookLM, Smithery |
| Разработка | GitHub, GitLab, Bitbucket, Azure DevOps, Visual Studio |
| Видео | YouTube (все поддомены + CDN) |
| Мессенджеры | Telegram (домены + IP-подсети по ASN), WhatsApp |
| Соцсети | Instagram, Facebook / Messenger, Twitter / X, TikTok, LinkedIn |
| Прочее | Apple Podcasts, Atlassian |

Плюс домены, обнаруженные автоматически.

---

## Структура проекта

```
configs/
  dnsmasq.conf.add                # ipset-правила: какие домены → VPN
  dnsmasq-vpn-upstream.conf.add   # DNS upstream через VPN для каждого домена
  dnsmasq-logging.conf.add        # настройки логирования DNS
  static-networks.txt             # статические IP-подсети (Telegram)
  domains-no-vpn.txt              # домены-исключения (никогда не VPN)
  no-vpn-ip-ports.txt             # исключения по IP:порту (всегда через WAN)

scripts/
  firewall-start                  # создание ipset, загрузка статических сетей, iptables
  nat-start                       # ip rule для fwmark и DNS-маршрутизации
  services-start                  # установка cron-задач
  domain-auto-add.sh              # авто-обнаружение доменов (cron, каждый час)
  update-blocked-list.sh          # скачивание списка блокировок (cron, раз в сутки)
  domain-report                   # CLI: просмотр/управление авто-добавленными доменами
  cron-save-ipset                 # сохранение ipset на диск каждые 6ч

docs/
  architecture.md                 # детальная архитектура
  getting-started.md              # пошаговая настройка с нуля
  domain-management.md            # как добавлять/удалять домены
  telegram-deep-dive.md           # почему Telegram особенный
  troubleshooting.md              # диагностика проблем
  current-routing-explained.md    # полный каталог доменов с пояснениями

deploy.sh                         # деплой на роутер по SSH/SCP
verify.sh                         # проверка состояния роутера после деплоя
.env.example                      # шаблон настроек
```

---

## Быстрый старт

**Требования**: роутер ASUS с Asuswrt-Merlin, настроенный WireGuard-клиент `wgc1`, включённый SSH, Entware на USB.

```bash
# Клонируем
git clone https://github.com/eiler2005/router_configuration
cd router_configuration

# Настраиваем (IP роутера определяется автоматически из default gateway)
cp .env.example .env
# При необходимости отредактировать: ROUTER=, SSH_IDENTITY_FILE=

# Деплой
./deploy.sh

# Проверка
./verify.sh
```

Подробная инструкция: [docs/getting-started.md](docs/getting-started.md)

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

---

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
| Маршрутизация Telegram (домены + IP-подсети) | Активна |
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
| [telegram-deep-dive.md](docs/telegram-deep-dive.md) | Почему Telegram особенный: DPI, IP-блокировка, подсети |
| [troubleshooting.md](docs/troubleshooting.md) | Частые проблемы и команды диагностики |
| [current-routing-explained.md](docs/current-routing-explained.md) | Полный каталог маршрутизируемых доменов |

---

*English version: [README.md](README.md)*
