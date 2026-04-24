# Current Routing Explained

## Что сейчас сделано

GhostRoute больше не является схемой “все выбранные домены через `wgc1`”. Текущая модель:

```text
LAN/Wi-Fi TCP           -> Channel B -> sing-box REDIRECT :<lan-redirect-port> -> VLESS+Reality -> VPS
LAN/Wi-Fi UDP/443       -> silently dropped for managed destinations, forcing TCP fallback
router OUTPUT           -> main routing unless explicitly proxied for diagnostics
Remote WireGuard clients  -> Channel A reserve -> wgc1
```

| Источник | Домены | Static CIDR | Egress |
|---|---|---|---|
| `br0` | `STEALTH_DOMAINS` | `VPN_STATIC_NETS` | sing-box REDIRECT `:<lan-redirect-port>` |
| `OUTPUT` | не прозрачно перехватывается | не прозрачно перехватывается | main routing / explicit proxy only |
| `wgs1` | `VPN_DOMAINS` | `VPN_STATIC_NETS` | `wgc1` |

## Почему два доменных набора

`dnsmasq` умеет добавлять результат DNS-резолва в `ipset`. Поэтому один и тот же managed domain catalog представлен двумя наборами:

```text
ipset=/youtube.com/VPN_DOMAINS
ipset=/youtube.com/STEALTH_DOMAINS
```

Первый нужен для remote-клиентов на `wgs1`, второй — для домашней сети и самого роутера.

`ipset=/youtube.com/STEALTH_DOMAINS` покрывает:

- `youtube.com`
- `www.youtube.com`
- `music.youtube.com`
- любые будущие `*.youtube.com`

## DNS

Текущая supported-схема:

```text
dnsmasq -> dnscrypt-proxy 127.0.0.1:5354
```

Legacy per-domain upstreams через `@wgc1` отключены. Если в старых заметках встречается пример:

```text
server=/example.com/1.1.1.1@wgc1
```

считайте его историческим. Новые домены так не добавляются.

## Текущие managed domain families

Источник правды:

```text
configs/dnsmasq.conf.add
configs/dnsmasq-stealth.conf.add
```

Основные категории:

| Категория | Примеры |
|---|---|
| AI tools | Anthropic/Claude, OpenAI/ChatGPT, Google AI Studio, NotebookLM, Smithery, Wispr Flow |
| Dev tools | GitHub, GitLab, Bitbucket, Azure DevOps, Visual Studio |
| Video/media | YouTube, Googlevideo, TikTok/ByteDance families, LiveTV |
| Messengers | Telegram, WhatsApp, imo |
| Social | Instagram, Facebook/Messenger, X/Twitter, LinkedIn |
| Apple | Podcasts, iCloud, App Store/media families |
| Other | Atlassian, VPS, cobalt.tools, RedShield |

Не копируйте список вручную из этого документа для изменения runtime. Меняйте config files и затем запускайте deploy/verify.

## Static networks

`configs/static-networks.txt` содержит CIDR ranges для direct-IP flows.

Важно: набор называется `VPN_STATIC_NETS` исторически, но egress зависит от источника:

```text
br0  TCP     -> VPN_STATIC_NETS -> nat REDIRECT :<lan-redirect-port> -> sing-box -> Reality
br0  UDP/443 -> VPN_STATIC_NETS -> DROP, чтобы приложение ушло на TCP
wgs1         -> VPN_STATIC_NETS -> 0x1000 -> wgc1
```

## Как проверить live state

```bash
./verify.sh
./scripts/router-health-report
```

На роутере:

```sh
iptables -t nat -S PREROUTING | grep <lan-redirect-port>
iptables -S FORWARD | grep 'dport 443'
netstat -nlp | grep <lan-redirect-port>
iptables -t mangle -S PREROUTING | grep RC_VPN_ROUTE
iptables -t mangle -S RC_VPN_ROUTE
ip rule show | grep -E '0x1000|0x2000'
ip route show table 200 || true
ip route show table wgc1
ipset list STEALTH_DOMAINS | awk '/^Number of entries:/ {print $4}'
ipset list VPN_DOMAINS | awk '/^Number of entries:/ {print $4}'
```

Expected:

- `br0` TCP REDIRECT rules mention `STEALTH_DOMAINS` and `VPN_STATIC_NETS`.
- `br0` UDP/443 reject rules exist for the same sets.
- `wgs1` rule enters `RC_VPN_ROUTE`.
- no legacy `0x2000`, table `200 -> singbox0`, or live `singbox0`.
- table `wgc1` exists for old reserve path.

## Как добавить домен

```text
# configs/dnsmasq.conf.add
ipset=/example.com/VPN_DOMAINS

# configs/dnsmasq-stealth.conf.add
ipset=/example.com/STEALTH_DOMAINS
```

Deploy:

```bash
ROUTER=192.168.50.1 ./deploy.sh
cd ansible && ansible-playbook playbooks/20-stealth-router.yml
ansible-playbook playbooks/99-verify.yml
```

## Как читать health-report

`router-health-report` проверяет новую норму:

- `STEALTH_DOMAINS` exists.
- sing-box REDIRECT listener `:<lan-redirect-port>` exists.
- `br0` TCP REDIRECT rules exist for `STEALTH_DOMAINS` and `VPN_STATIC_NETS`.
- `br0` UDP/443 reject rules exist for `STEALTH_DOMAINS` and `VPN_STATIC_NETS`.
- legacy `0x2000 -> table 200 -> singbox0` is absent.
- `br0 -> RC_VPN_ROUTE` disabled.
- `OUTPUT -> RC_VPN_ROUTE` disabled.
- `wgs1 -> RC_VPN_ROUTE` enabled.
- `wgs1 -> STEALTH_DOMAINS` disabled.

Это намеренно: если LAN снова окажется на `wgc1`, health-report должен показать drift.
