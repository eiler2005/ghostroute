# Архитектура GhostRoute

## Коротко

Текущая архитектура — двухканальная:

```text
Statement: GhostRoute делает domain-based routing на роутере, а не на каждом
клиентском устройстве.

Setup:
- Router: ASUS RT-AX88U Pro + Merlin, dnsmasq/ipset/iptables, Entware.
- VPS: VPS, общий Caddy на :443, Xray/Reality backend в /opt/stealth.
- Channel B, primary for home:
  br0 LAN TCP -> STEALTH_DOMAINS/VPN_STATIC_NETS
  -> nat REDIRECT :<lan-redirect-port> -> sing-box -> VLESS+Reality -> VPS.
- Channel A, reserve for remote WireGuard clients:
  wgs1 -> VPN_DOMAINS/VPN_STATIC_NETS -> mark 0x1000 -> table wgc1.
- Direct QR/VLESS clients:
  client app -> generated QR/VLESS profile -> VPS Caddy :443
  -> Xray Reality inbound -> Internet.
  This path bypasses the home router and does not expose home LAN access by itself.
- DNS:
  dnsmasq fills both ipsets and sends upstream queries to dnscrypt-proxy
  on 127.0.0.1:5354; dnscrypt-proxy sends DoH through sing-box SOCKS
  on 127.0.0.1:1080, so resolver traffic follows the same Reality cover.
- Automation:
  deploy.sh manages router base scripts/catalogs; Ansible manages VPS,
  sing-box, dnscrypt-proxy, REDIRECT rules, verification and QR generation.

Non-goal: router OUTPUT is not transparently captured, because that can loop
sing-box's own outbound connections.
```

| Источник | Каталог назначения | Механизм | Egress |
|---|---|---|---|
| LAN/Wi-Fi (`br0`) | `STEALTH_DOMAINS`, `VPN_STATIC_NETS` | TCP nat `REDIRECT :<lan-redirect-port>`, UDP/443 reject | sing-box redirect → Reality |
| Router `OUTPUT` | не прозрачно перехватывается | main routing / explicit proxy only | router default |
| Remote WireGuard server clients (`wgs1`) | `VPN_DOMAINS`, `VPN_STATIC_NETS` | mark `0x1000` → table `wgc1` | `wgc1` |
| Direct QR/VLESS clients | generated profile | client-side VLESS+Reality to VPS | Xray Reality inbound |

`wgc1` больше не является основным egress для домашней LAN. Он сохранен как резервный/legacy канал для клиентов, которые подключаются к встроенному WireGuard server на роутере.

---

## Компоненты

```text
dnsmasq
  -> fills VPN_DOMAINS from configs/dnsmasq.conf.add
  -> fills STEALTH_DOMAINS from configs/dnsmasq-stealth.conf.add
  -> includes auto-discovered domains from /jffs/configs/dnsmasq-autodiscovered.conf.add
  -> upstream DNS via dnscrypt-proxy 127.0.0.1:5354
  -> dnscrypt-proxy DoH egress via sing-box SOCKS 127.0.0.1:1080

firewall-start
  -> creates/restores VPN_DOMAINS
  -> creates VPN_STATIC_NETS from configs/static-networks.txt
  -> hooks only wgs1 into RC_VPN_ROUTE

stealth-route-init.sh
  -> creates STEALTH_DOMAINS
  -> redirects matching br0 TCP flows to local sing-box :<lan-redirect-port>
  -> rejects matching br0 UDP/443 so clients fall back from QUIC to TCP
  -> removes legacy 0x2000/table 200/singbox0 state

nat-start
  -> fwmark 0x1000/0x1000 -> table wgc1
  -> redirects plain DNS from wgs1 clients to local dnsmasq

sing-box
  -> redirect inbound on 0.0.0.0:<lan-redirect-port>
  -> VLESS+Reality outbound to VPS :443

VPS
  -> shared system Caddy with layer4 plugin on :443
  -> Xray/3x-ui Reality inbound on 127.0.0.1:8443
```

---

## Packet Flow

### LAN client

```text
client DNS query
  -> dnsmasq
  -> matching domain IP added to STEALTH_DOMAINS

client connection to resolved IP
  -> PREROUTING -i br0
  -> match STEALTH_DOMAINS or VPN_STATIC_NETS
  -> TCP nat REDIRECT to local :<lan-redirect-port>
  -> sing-box redirect inbound
  -> VLESS+Reality
  -> VPS exit
```

### Router-originated traffic

```text
router process / local proxy / service
  -> OUTPUT
  -> main routing by default
  -> explicit proxy only when a diagnostic command intentionally opts in
```

Router `OUTPUT` намеренно не перехватывается прозрачным REDIRECT-правилом: иначе sing-box outbound, который сам создается на роутере, легко поймать в loop. Для диагностики router-originated traffic используйте явный proxy/клиентский профиль, а не глобальный `OUTPUT` hook.

### Remote WireGuard server client

```text
iPhone/MacBook on mobile network
  -> WireGuard VPN Server on router
  -> decrypted packet enters as wgs1
  -> PREROUTING -i wgs1
  -> RC_VPN_ROUTE
  -> match VPN_DOMAINS or VPN_STATIC_NETS
  -> MARK 0x1000/0x1000
  -> ip rule fwmark 0x1000/0x1000 lookup wgc1
  -> old WGC1 egress
```

Plain DNS from `wgs1` is captured:

```sh
iptables -t nat -A PREROUTING -i wgs1 -p udp --dport 53 -j REDIRECT --to-ports 53
iptables -t nat -A PREROUTING -i wgs1 -p tcp --dport 53 -j REDIRECT --to-ports 53
```

Это сохраняет `VPN_DOMAINS` для мобильных клиентов даже после reconnect со stale DNS-настройками.

### Direct QR/VLESS client

```text
iPhone/MacBook outside home
  -> client app imports generated QR/VLESS profile
  -> VLESS+Reality over TCP/443
  -> VPS shared Caddy L4
  -> Xray Reality inbound
  -> Internet
```

This is not the same as connecting to the home router. It is a direct egress profile for external devices. It does not provide access to home LAN resources unless a separate remote-access overlay is designed and deployed.

---

## Domain Catalogs

### `VPN_DOMAINS`

Источник:

```text
configs/dnsmasq.conf.add
/jffs/configs/dnsmasq-autodiscovered.conf.add
```

Назначение:

```text
remote wgs1 clients -> RC_VPN_ROUTE -> mark 0x1000 -> wgc1
```

Пример:

```text
ipset=/youtube.com/VPN_DOMAINS
```

### `STEALTH_DOMAINS`

Источник:

```text
configs/dnsmasq-stealth.conf.add
/jffs/configs/dnsmasq-autodiscovered.conf.add
```

Назначение:

```text
LAN TCP -> nat REDIRECT :<lan-redirect-port> -> sing-box redirect -> Reality
```

Пример:

```text
ipset=/youtube.com/STEALTH_DOMAINS
```

### `VPN_STATIC_NETS`

Источник:

```text
configs/static-networks.txt
```

Назначение зависит от источника пакета:

```text
br0 TCP     -> nat REDIRECT :<lan-redirect-port> -> sing-box redirect -> Reality
br0 UDP/443 -> DROP -> client fallback to TCP
wgs1        -> mark 0x1000 -> wgc1
```

Такой shared catalog нужен для Telegram, imo, Apple и других direct-IP flows, где DNS-доменов недостаточно.

---

## DNS Architecture

Текущая supported-схема:

```text
clients
  -> router dnsmasq :53
  -> dnscrypt-proxy 127.0.0.1:5354
  -> upstream encrypted resolvers
```

Legacy per-domain upstreams вида:

```text
server=/example.com/1.1.1.1@wgc1
server=/example.com/9.9.9.9@wgc1
```

больше не используются как active configuration. Они намеренно удалены из managed DNS policy, потому что LAN теперь должна использовать Channel B, а DNS не должен скрыто привязывать географию к `wgc1`.

Файл `configs/dnsmasq-vpn-upstream.conf.add` сохранен только как lightweight compatibility block, потому что `deploy.sh` все еще умеет мержить его managed section.

---

## VPS Stealth Channel

На VPS используется компромиссная production-схема:

```text
system Caddy :443 with layer4 plugin and generic fallback site
  -> routes Reality traffic to Xray on 127.0.0.1:8443

/opt/stealth
  -> Docker Compose for xray / 3x-ui side
```

Общий Caddy остается системным. Public `:443` держит только Reality L4 routing и generic fallback; OpenClaw не публикуется через Caddy и доступен только через SSH tunnel. Xray/3x-ui живут отдельно в `/opt/stealth`, чтобы не смешивать app stacks.

Reality profiles:

```text
vless://<FAKE-UUID>@<FAKE-HOST>:443?type=tcp&security=reality&pbk=<FAKE-PUBLIC-KEY>&sid=<FAKE-SHORT-ID>&sni=gateway.icloud.com&fp=chrome#iphone-placeholder
```

Это пример формата, не реальный профиль.

---

## Deployment Model

### Router base layer

```bash
ROUTER=192.168.50.1 ./deploy.sh
```

Доставляет:

- `configs/dnsmasq.conf.add`
- `configs/dnsmasq-stealth.conf.add`
- `configs/dnsmasq-vpn-upstream.conf.add`
- `configs/static-networks.txt`
- `scripts/firewall-start`
- `scripts/nat-start`
- `scripts/domain-auto-add.sh`
- cron/reporting scripts

### Stealth router layer

```bash
cd ansible
ansible-playbook playbooks/20-stealth-router.yml
```

Управляет:

- `sing-box`
- `dnscrypt-proxy`
- `/jffs/scripts/stealth-route-init.sh`
- route table `200`
- `STEALTH_DOMAINS`
- dnsmasq include for stealth catalog

### Verify

```bash
cd ansible
ansible-playbook playbooks/99-verify.yml
cd ..
./verify.sh
./scripts/router-health-report
```

---

## Operational Artifacts

| Artifact | Purpose |
|---|---|
| `/jffs/configs/dnsmasq.conf.add` | live dnsmasq managed blocks |
| `/jffs/configs/dnsmasq-stealth.conf.add` | live stealth catalog |
| `/jffs/configs/dnsmasq-autodiscovered.conf.add` | router-local auto-discovered domains |
| `/opt/etc/sing-box/config.json` | sing-box client config |
| `/opt/var/log/sing-box.log` | sing-box log |
| `/opt/etc/dnscrypt-proxy.toml` | dnscrypt config |
| `/opt/var/log/router_configuration` | traffic/report snapshots when Entware is available |
| `/jffs/addons/router_configuration` | fallback state when Entware is unavailable |

---

## Verification Commands

```sh
iptables -t nat -S PREROUTING | grep <lan-redirect-port>
iptables -S FORWARD | grep 'dport 443'
netstat -nlp | grep <lan-redirect-port>
iptables -t mangle -S PREROUTING | grep RC_VPN_ROUTE
iptables -t mangle -S RC_VPN_ROUTE
ip rule show
ip route show table 200 || true
ip route show table wgc1
ipset list STEALTH_DOMAINS | sed -n '1,10p'
ipset list VPN_DOMAINS | sed -n '1,10p'
ipset list VPN_STATIC_NETS | sed -n '1,20p'
grep '@wgc1' /jffs/configs/dnsmasq.conf.add
```

Expected:

- `PREROUTING -i br0` has TCP REDIRECT rules for `STEALTH_DOMAINS` and `VPN_STATIC_NETS`.
- `FORWARD -i br0` has UDP/443 reject rules for `STEALTH_DOMAINS` and `VPN_STATIC_NETS`.
- sing-box listens on `0.0.0.0:<lan-redirect-port>`.
- `PREROUTING -i wgs1 -j RC_VPN_ROUTE` exists.
- `RC_VPN_ROUTE` marks `VPN_DOMAINS` and `VPN_STATIC_NETS` as `0x1000`.
- No `PREROUTING -i br0 -j RC_VPN_ROUTE`.
- No `OUTPUT -j RC_VPN_ROUTE`.
- No legacy `fwmark 0x2000`, table `200 -> singbox0`, or live `singbox0`.
- No active `@wgc1` dnsmasq upstream entries.

---

## Security Notes

- Do not paste real `ansible/secrets/stealth.yml`.
- Do not paste real VLESS URIs or QR payloads.
- Keep `~/.vault_pass.txt` local and mode `600`.
- Generated client files under `ansible/out/clients/` are local operational artifacts.
- IPv6 remains out of scope until a separate dual-stack design exists.

---

## Related Docs

- [channel-routing-operations.md](channel-routing-operations.md)
- [stealth-channel-implementation-guide.md](stealth-channel-implementation-guide.md)
- [domain-management.md](domain-management.md)
- [troubleshooting.md](troubleshooting.md)
- [traffic-observability.md](traffic-observability.md)
