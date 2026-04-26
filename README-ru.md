# GhostRoute

### Reality-маршрутизация на ASUS Merlin: домашний ingress для мобильных клиентов, Reality egress на VPS

> Домашние устройства работают как обычно. Роутер сам решает, какой канал нужен каждому направлению.

**[English version ->](README.md)**

---

## Обзор

GhostRoute управляет маршрутизацией на ASUS RT-AX88U Pro с Asuswrt-Merlin: выбранные домены и IP-сети отправляются через нужный egress-канал без VPN-приложений на домашних устройствах.

В текущей production-схеме есть два активных пути:

- Домашний Wi-Fi/LAN использует Channel B: `sing-box REDIRECT :<lan-redirect-port> -> VLESS+Reality -> VPS/Xray`.
- Удаленные мобильные QR/VLESS-клиенты сначала подключаются к домашнему ASUS:
  `iPhone/Mac -> домашний белый IP :<home-reality-port> -> sing-box home Reality inbound`.
  Дальше роутер применяет тот же managed split: `STEALTH_DOMAINS`/`VPN_STATIC_NETS`
  уходят через VPS Reality, остальные направления идут напрямую через домашний WAN.

Channel A (`wgs1` + `wgc1`) выключен в нормальной эксплуатации. `wgc1_*` NVRAM сохранён только как cold fallback.

---

## Возможности

- Domain-based routing через `dnsmasq` + `ipset`.
- Единый активный каталог для домашней LAN (`STEALTH_DOMAINS`).
- Общий static CIDR каталог для direct-IP сервисов через `VPN_STATIC_NETS`.
- VLESS+Reality egress через VPS VPS за общим Caddy L4 на TCP/443.
- Router-side VLESS+Reality ingress на TCP/<home-reality-port> для удаленных мобильных клиентов: LTE-оператор видит домашний российский IP, а не VPS.
- Стабильный router-side `sing-box` TCP REDIRECT вместо нестабильного Merlin TUN routing.
- Auto-discovery доменов, который пишет только `STEALTH_DOMAINS`.
- Локальная генерация QR/VLESS-профилей из Ansible Vault.
- Health, traffic и catalog reports для человека и LLM handoff.
- Локальный модуль мониторинга работоспособности с `STATUS_OK` /
  `STATUS_FAIL`, `summary-latest.md` и внутренними alert-журналами на диске
  роутера.

---

## Как это работает

### 1. Домашние Wi-Fi / LAN устройства

```text
Home Wi-Fi / LAN devices
      |
      +-- DNS query
      |     |
      |     v
      |  dnsmasq
      |  +-- managed domain -> STEALTH_DOMAINS
      |  +-- static network -> VPN_STATIC_NETS
      |  +-- other domain   -> normal DNS path
      |
      +-- TCP connection to matched IP
            |
            v
      ASUS Router / Merlin
      +-- nat REDIRECT :<lan-redirect-port>
      +-- sing-box redirect inbound
      +-- VLESS+Reality TCP/443
            |
            v
      VPS VPS
      +-- shared Caddy :443
      +-- Xray Reality inbound
            |
            v
      Internet
```

Домашним устройствам не нужны VPN-приложения. Роутер видит DNS-ответы, наполняет `STEALTH_DOMAINS`, перехватывает совпавший TCP-трафик в sing-box и отправляет его через Reality. UDP/443 для managed-направлений отклоняется, чтобы приложения fallback'ились с QUIC на TCP.

### 2. Remote mobile QR / VLESS-клиенты

```text
Remote iPhone/MacBook outside home
      |
      v
Client app imports generated QR profile
      |
      v
Home public IP :<home-reality-port>
      |
      v
ASUS Router / Merlin
+-- sing-box home Reality inbound
+-- managed destination
|     +-- STEALTH_DOMAINS / VPN_STATIC_NETS
|     +-- sing-box Reality outbound
|     +-- VPS VPS / Caddy / Xray
|     +-- Internet
+-- non-managed destination
      +-- sing-box direct outbound
      +-- home ISP WAN
      +-- Internet
```

Мобильный оператор видит подключение телефона к домашнему российскому IP.
Managed-сайты/checker видят VPS exit IP. Non-managed сайты видят домашний
российский WAN IP.

Подробная схема с полным workflow, портами, компонентами и таблицей "кто что
видит": [docs/network-flow-and-observer-model.md](docs/network-flow-and-observer-model.md).

### 3. Cold fallback

WireGuard не активен в steady state. Сохранённый `wgc1_*` NVRAM используется только через `scripts/emergency-enable-wgc1.sh` при катастрофическом отказе Reality.

---

## Технический стек

```text
Router:
  ASUS RT-AX88U Pro + Asuswrt-Merlin
  dnsmasq + ipset + iptables
  sing-box REDIRECT inbound on :<lan-redirect-port>
  sing-box home Reality inbound on :<home-reality-port>
  dnscrypt-proxy on 127.0.0.1:5354
  WireGuard Channel A disabled; wgc1 NVRAM preserved for cold fallback

VPS:
  VPS Ubuntu host
  shared system Caddy with layer4 plugin on :443
  Xray/3x-ui Reality inbound on 127.0.0.1:8443
  stealth stack under /opt/stealth

Control:
  deploy.sh for router base scripts/catalogs
  Ansible for VPS, router stealth layer, verification and QR generation
  ansible-vault for real credentials and client parameters
```

---

## Структура проекта

```text
configs/
  dnsmasq-stealth.conf.add        # STEALTH_DOMAINS for home LAN Channel B
  static-networks.txt             # shared CIDR catalog

ansible/
  playbooks/10-stealth-vps.yml
  playbooks/20-stealth-router.yml
  playbooks/30-generate-client-profiles.yml
  playbooks/99-verify.yml
  secrets/stealth.yml             # ansible-vault, gitignored
  out/clients/                    # generated QR/profile artifacts, gitignored

scripts/
  firewall-start
  nat-start
  domain-auto-add.sh
  client-profiles
  secret-scan
  router-health-report
  traffic-report

docs/
  architecture.md
  network-flow-and-observer-model.md
  channel-routing-operations.md
  stealth-channel-implementation-guide.md
  domain-management.md
  secrets-management.md
  client-profiles.md
  troubleshooting.md
```

---

## Быстрый старт

```bash
# Base router deploy: dnsmasq, firewall-start, nat-start, cron scripts
ROUTER=192.168.50.1 ./deploy.sh

# Channel B router layer: sing-box, dnscrypt-proxy, REDIRECT routing
cd ansible
ansible-playbook playbooks/20-stealth-router.yml

# End-to-end verification: VPS + router
ansible-playbook playbooks/99-verify.yml
cd ..

# Local health snapshot
./verify.sh
./scripts/router-health-report
```

Traffic и observability:

```bash
# Главный usage-отчёт: exits, устройства, Home Reality ingress clients,
# популярные назначения и проверки ошибок маршрутизации.
./scripts/traffic-report today
./scripts/traffic-report yesterday
./scripts/traffic-report week
./scripts/traffic-report month

# Безопасный operational snapshot для человека/LLM.
./scripts/router-health-report
```

Traffic report показывает, сколько ушло через VPS, сколько осталось
на домашнем российском WAN, какие устройства и Home Reality ingress clients
были активны, какие сайты/приложения популярны и не появились ли ошибки
маршрутизации. Подробно: [docs/traffic-observability.md](docs/traffic-observability.md).

Модуль мониторинга работоспособности:

```bash
# После deploy.sh или Ansible можно вручную собрать локальный health sample.
ssh admin@192.168.50.1 '/jffs/scripts/health-monitor/run-once'

# Primary storage на роутере:
ssh admin@192.168.50.1 'cat /opt/var/log/router_configuration/health-monitor/summary-latest.md'
ssh admin@192.168.50.1 'cat /opt/var/log/router_configuration/health-monitor/alerts/$(date +%F).md'
ssh admin@192.168.50.1 'cat /opt/var/log/router_configuration/health-monitor/status.json'

# Единый router+VPS отчет с control machine.
./scripts/ghostroute-health-report
./scripts/ghostroute-health-report --save
```

Модуль read-only относительно production routing state. Он пишет только
локальные отчеты и внутренние алерты на диск роутера. Primary path:
`/opt/var/log/router_configuration/health-monitor`; fallback:
`/jffs/addons/router_configuration/health-monitor`.
Плановый сбор идет раз в час; для свежего среза вручную используется
`/jffs/scripts/health-monitor/run-once`.
VPS observer хранит свой local-only статус на VPS в
`/var/log/ghostroute/health-monitor`. Единый `ghostroute-health-report --save`
сохраняет latest/history на роутере в `health-monitor/global/` и чистит history
старше 31 дня.

Как читать алерт на диске роутера:

1. Сначала проверить `STATUS_OK` / `STATUS_FAIL`.
2. Потом открыть `summary-latest.md`.
3. Потом открыть `alerts/<today>.md`.
4. В `raw/<today>.jsonl` идти только за точными evidence.
5. После ручного восстановления запустить `run-once` или дождаться следующего
   часового цикла и убедиться, что вернулся `STATUS_OK`; историю алертов не удалять.

Ожидаемые инварианты:

- LAN TCP для `STEALTH_DOMAINS` и `VPN_STATIC_NETS` редиректится на `:<lan-redirect-port>`.
- LAN UDP/443 для этих наборов отклоняется, чтобы форсировать TCP fallback.
- Remote QR/VLESS-клиенты подключаются к домашнему белому IP на `:<home-reality-port>`, не напрямую к VPS.
- Router-side `sing-box` принимает `reality-in` на `0.0.0.0:<home-reality-port>`.
- Mobile managed destinations route to `reality-out`; mobile non-managed destinations route to `direct-out`.
- `STEALTH_DOMAINS` и `VPN_STATIC_NETS` существуют.
- `VPN_DOMAINS`, `RC_VPN_ROUTE`, `0x1000`, active `wgs1` и active `wgc1` отсутствуют.

---

## Клиентские QR и VLESS-профили

Профили генерируются локально из Ansible Vault:

```bash
./scripts/client-profiles generate
./scripts/client-profiles open
```

Артефакты лежат в `ansible/out/clients/`: `iphone-*.png`, `macbook.png`, соответствующие `.conf` файлы и локальная галерея `qr-index.html`.

`router.conf` по-прежнему смотрит напрямую на VPS, потому что это identity самого роутера для outbound. `iphone-*` и `macbook` профили сначала смотрят на домашний белый IP.

Нельзя коммитить или вставлять в чат реальные VLESS URI, UUID, Reality keys, short IDs, admin paths или QR payloads. В документации допустимы только fake placeholders.

Подробно: [docs/client-profiles.md](docs/client-profiles.md) и [docs/secrets-management.md](docs/secrets-management.md).

---

## Документация

- [README.md](README.md) - English overview
- [docs/architecture.md](docs/architecture.md) - текущая routing architecture
- [docs/network-flow-and-observer-model.md](docs/network-flow-and-observer-model.md) - подробная схема потоков и кто что видит
- [docs/traffic-observability.md](docs/traffic-observability.md) - traffic reports, популярность устройств/приложений и проверки ошибок маршрутизации
- [docs/stealth-monitoring-implementation-guide.md](docs/stealth-monitoring-implementation-guide.md) - реализация модуля мониторинга работоспособности
- [docs/stealth-monitor-runbook.md](docs/stealth-monitor-runbook.md) - алерты на диске роутера и recovery runbook
- [docs/routing-performance-troubleshooting.md](docs/routing-performance-troubleshooting.md) - диагностика и фиксы производительности LTE/Home Reality
- [docs/channel-routing-operations.md](docs/channel-routing-operations.md) - day-2 operations и переключение каналов
- [docs/stealth-channel-implementation-guide.md](docs/stealth-channel-implementation-guide.md) - реализованный VLESS+Reality guide
- [docs/domain-management.md](docs/domain-management.md) - управление domain/static-network каталогами
- [docs/stealth-domains-curation-audit.md](docs/stealth-domains-curation-audit.md) - advisory-аудит curation для STEALTH_DOMAINS
- [docs/secrets-management.md](docs/secrets-management.md) - vault, local secrets и pre-push scan
- [docs/client-profiles.md](docs/client-profiles.md) - VLESS/Reality QR workflow
- [docs/troubleshooting.md](docs/troubleshooting.md) - диагностика инцидентов

---

## License

[MIT](LICENSE) - Copyright (c) 2025 Denis Ermilov
