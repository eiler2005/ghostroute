# GhostRoute

### Reality-маршрутизация на ASUS Merlin: домашний ingress для мобильных клиентов, Reality egress на VPS

> Домашние устройства работают как обычно. Роутер сам решает, какой канал нужен каждому направлению.

**[English version ->](README.md)**

---

## Обзор

GhostRoute управляет маршрутизацией на ASUS RT-AX88U Pro с Asuswrt-Merlin: выбранные домены и IP-сети отправляются через нужный egress-канал без VPN-приложений на домашних устройствах.

В текущей production-схеме есть два активных пути:

- Домашний Wi-Fi/LAN использует Channel B: `sing-box REDIRECT :<lan-redirect-port> -> VLESS+Reality -> VPS/Xray`.
- Удаленные мобильные QR/VLESS-клиенты сначала подключаются к домашнему ASUS: `iPhone/Mac -> домашний белый IP :<home-reality-port> -> sing-box home Reality inbound -> Reality outbound -> VPS/Xray`.

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
+-- sing-box Reality outbound
      |
      v
VPS VPS / Caddy / Xray
      |
      v
Internet
```

Мобильный оператор видит подключение телефона к домашнему российскому IP. Сайты/checker всё равно видят VPS exit IP, потому что outbound с роутера остается Reality-to-VPS.

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

Ожидаемые инварианты:

- LAN TCP для `STEALTH_DOMAINS` и `VPN_STATIC_NETS` редиректится на `:<lan-redirect-port>`.
- LAN UDP/443 для этих наборов отклоняется, чтобы форсировать TCP fallback.
- Remote QR/VLESS-клиенты подключаются к домашнему белому IP на `:443`, не напрямую к VPS.
- Router-side `sing-box` принимает `home-reality-in` на `0.0.0.0:443` и отправляет его в существующий Reality outbound.
- `wgs1` входит в `RC_VPN_ROUTE`.
- `RC_VPN_ROUTE` маркирует `VPN_DOMAINS` и `VPN_STATIC_NETS` как `0x1000`.
- Legacy `0x2000`, table `200` и `singbox0` отсутствуют.
- `0x1000` использует table `wgc1`.

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
- [docs/channel-routing-operations.md](docs/channel-routing-operations.md) - day-2 operations и переключение каналов
- [docs/stealth-channel-implementation-guide.md](docs/stealth-channel-implementation-guide.md) - реализованный VLESS+Reality guide
- [docs/domain-management.md](docs/domain-management.md) - управление domain/static-network каталогами
- [docs/secrets-management.md](docs/secrets-management.md) - vault, local secrets и pre-push scan
- [docs/client-profiles.md](docs/client-profiles.md) - VLESS/Reality QR workflow
- [docs/troubleshooting.md](docs/troubleshooting.md) - диагностика инцидентов

---

## License

[MIT](LICENSE) - Copyright (c) 2025 Denis Ermilov
