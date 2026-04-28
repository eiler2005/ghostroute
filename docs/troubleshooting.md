# Диагностика проблем

Для скорости LTE/Home Reality, MTU/MSS, TCP buffer и `connlimit` диагностики см.
[modules/performance-diagnostics/docs/routing-performance-troubleshooting.md](/modules/performance-diagnostics/docs/routing-performance-troubleshooting.md).
Для DNS leak / BrowserLeaks интерпретации по Channel A/B/C см.
[dns-policy.md](/docs/dns-policy.md).

## Сначала

```bash
ROUTER=192.168.50.1 ./verify.sh
./modules/ghostroute-health-monitor/bin/router-health-report
cd ansible && ansible-playbook playbooks/99-verify.yml --limit routers
```

Если проверки зелёные, проблема обычно в конкретном domain/static entry,
клиентском DNS cache или внешнем сервисе.

## LAN-Сайт Не Идёт Через Reality

### Rules

```sh
netstat -nlp 2>/dev/null | grep ':<lan-redirect-port> '
iptables -t nat -S PREROUTING | grep <lan-redirect-port>
iptables -S FORWARD | grep 'dport 443'
ipset list STEALTH_DOMAINS | head
ipset list VPN_STATIC_NETS | head
```

Expected:

- sing-box listens on `0.0.0.0:<lan-redirect-port>`;
- `PREROUTING -i br0` redirects TCP for `STEALTH_DOMAINS` and `VPN_STATIC_NETS`;
- `FORWARD -i br0` drops UDP/443 for the same sets;
- `VPN_DOMAINS` is absent.

### DNS/ipset

```sh
nslookup example.com 127.0.0.1
ipset test STEALTH_DOMAINS <resolved-ip>
tail -100 /opt/var/log/sing-box.log | grep redirect-in
```

Если IP не попал в `STEALTH_DOMAINS`, проверьте
`configs/dnsmasq-stealth.conf.add`, `/jffs/configs/dnsmasq-stealth.conf.add` и
перезапуск dnsmasq после deploy.

## После Reboot Нет REDIRECT

Симптом: обычный интернет в Wi-Fi есть, `sing-box` запущен, но managed-домены
не уходят через VPS. `./verify.sh` обычно показывает missing LAN TCP REDIRECT
или UDP/443 DROP.

Проверка:

```sh
ssh admin@192.168.50.1 '
  pidof sing-box
  ipset list STEALTH_DOMAINS | awk "/^Type:|^Number of entries:/ {print}"
  iptables -t nat -S PREROUTING | grep REDIRECT
  iptables -S FORWARD | grep "dport 443"
  sh -n /jffs/scripts/firewall-start /jffs/scripts/stealth-route-init.sh
'
```

Expected:

- `STEALTH_DOMAINS` type is `hash:ip`;
- `VPN_STATIC_NETS` type is `hash:net`;
- `PREROUTING -i br0` has REDIRECT rules for both sets;
- `FORWARD -i br0` has UDP/443 DROP for both sets.

Fast recovery:

```sh
ssh admin@192.168.50.1 '
  chmod +x /jffs/scripts/firewall-start /jffs/scripts/stealth-route-init.sh
  /jffs/scripts/firewall-start
  /jffs/scripts/cron-save-ipset 2>/dev/null || true
'
```

The managed files are reboot-safe: `firewall-start` recreates the ipsets,
restores persisted `STEALTH_DOMAINS` entries without replaying the saved
`create` line, loads `VPN_STATIC_NETS`, and calls `stealth-route-init.sh`.
`stealth-route-init.sh` must create `STEALTH_DOMAINS` as `hash:ip`; creating it
as `hash:net` breaks restored dnsmasq/ipset state and prevents REDIRECT rules
from being installed.

## YouTube Или Другой Dual-Stack Сайт Не Открывается

Проверьте AAAA leakage:

```sh
dig @192.168.50.1 youtube.com AAAA +short
dig @192.168.50.1 youtube.com A +short
ssh admin@192.168.50.1 'grep "^filter-AAAA$" /jffs/configs/dnsmasq.conf.add'
```

Expected:

- `AAAA` пустой;
- `A` возвращает IPv4;
- `filter-AAAA` присутствует.

Исправление:

```sh
ssh admin@192.168.50.1 '
  CONF=/jffs/configs/dnsmasq.conf.add
  touch "$CONF"
  sed -i "/^filter-AAAA$/d" "$CONF"
  echo filter-AAAA >> "$CONF"
  service restart_dnsmasq
'
```

После этого выключите/включите Wi-Fi на клиенте или очистите DNS cache.

## BrowserLeaks DNS Показывает Google/Cloudflare

Это не обязательно DNS leak к мобильному оператору.

Плохой сигнал:

```text
DNS resolver = LTE/mobile carrier
IPv6 address = прямой LTE/mobile address
```

Шумный, но не обязательно плохой сигнал:

```text
Public IP = home/RF
DNS = Google/Cloudflare/Quad9, иногда другая страна
Found many DNS servers
```

Такой результат означает mixed fingerprint, но не доказывает, что мобильный
оператор увидел DNS-запросы. Текущий default — privacy-first: DNS должен идти
через активный канал/tunnel и не должен уходить напрямую к LTE resolver.

Для proof-тестов на iPhone:

```text
1. LTE only, Wi-Fi off.
2. iCloud Private Relay / Limit IP Address Tracking off.
3. Включён ровно один GhostRoute profile.
4. BrowserLeaks DNS не показывает mobile carrier.
5. IPv6 absent или явно routed through tunnel.
```

### Channel A api64 показывает LTE IP

Симптом:

```text
http://api.ipify.org      -> VPS IP
https://api.ipify.org     -> timeout или нестабильно
https://api64.ipify.org   -> LTE/mobile-provider IP
```

Первичная трактовка: Channel A IPv4/TCP path уже доходит до роутера и дальше в
managed split, но iOS client app не владеет всем Layer-0/IPv6 трафиком. Если бы
это был router-side `direct-out`, внешний сайт увидел бы home WAN/RF IP, а не
LTE provider IP.

Что проверить до изменения профилей:

```text
1. На iPhone остался ровно один активный VPN/profile.
2. В приложении профиля включены tunnel/Fake DNS, Override system DNS и sniffing.
3. В приложении нет direct IPv6 bypass; IPv6 либо отключён, либо routed через tunnel.
4. Domain Strategy не заставляет локальный/LTE DNS резолв до входа в туннель.
5. После изменения настроек: airplane mode on/off и полный restart VPN profile.
```

Router-side sanity check:

```bash
ssh admin@192.168.50.1 '
  tail -2500 /opt/var/log/sing-box.log |
    grep -E "api(64)?\\.ipify|reality-in|redirect-in|reality-out|direct-out" |
    tail -160
'
```

Expected: если `api64` не появляется рядом с `inbound/vless[reality-in]`, запрос
не дошёл до Channel A ingress. Сначала чините iPhone client ownership, не
router managed split.

## Mobile Home QR Не Работает

```sh
ssh admin@192.168.50.1 '
  netstat -nlp 2>/dev/null | grep ":<home-reality-port> "
  iptables -S INPUT | grep <home-reality-port>
  tail -100 /opt/var/log/sing-box.log
'
```

Expected:

- router-side Reality inbound listens on `0.0.0.0:<home-reality-port>`;
- INPUT firewall allows TCP/<home-reality-port>;
- sing-box has no fresh fatal errors.

## Channel B/C Device Profiles Не Работают

Channel B is production для selected device-client profiles, но не является
automatic failover для Channel A и не участвует в health-check Channel A.
Channel C has a live-proven C1-Shadowrocket compatibility path using HTTPS
CONNECT/TLS and a C1-sing-box native Naive design that is server-ready but
blocked by the tested SFI `1.11.4` client (`unknown outbound type: naive`).
C1-Shadowrocket is not Naive and must not be treated as proof that
Shadowrocket speaks native Naive. B/C не должны менять router REDIRECT/DNS/TUN
и не дают automatic failover.

Для Channel B direct-mode проверок access logs пишутся в Caddy stdout/journal.
Для Channel C1 основной runtime signal находится на роутере в sing-box log и
iptables counters.

```bash
ssh admin@<router-ip> '
  tail -200 /opt/var/log/sing-box.log |
    grep -E "channel-b-relay-socks|channel-c-naive-in|channel-c-shadowrocket-http-in|reality-out|direct-out" |
    tail -80
'
```

Expected:

- Channel B requests show logger `channel_b_xhttp`, host matching the XHTTP
  hostname, and either the configured random path or `404` for wrong paths.
- C1-sing-box requests enter `channel-c-naive-in`; with SFI `1.11.4` this is
  not expected because that client cannot decode outbound `type: naive`.
- C1-Shadowrocket compatibility requests enter
  `channel-c-shadowrocket-http-in`.
- Managed Channel C destinations continue to `reality-out`.
- Non-managed Channel C1 destinations use `direct-out`.
- Shadowrocket Channel C1 compatibility config uses keyword auth form:
  `https, <home-host>, <public-port>, username=<user>, password=<pass>, method=connect, tls=true, tfo=false`.
- If Shadowrocket hits `channel-c-naive-in` and the log says `not CONNECT
  request`, Shadowrocket imported the profile but did not speak the expected
  native Naive protocol. Use C1-Shadowrocket for current iPhone proof; re-test
  C1-sing-box only with an iOS sing-box/SFI build that supports Naive outbound.
- No Caddy restart loop: `sudo systemctl is-active caddy` returns `active`.

## VPS Emergency Clients Drift

VPS Reality inbound should contain the router identity plus
`emergency_clients[]`. Normal mobile `home_clients[]` must not be present on the
VPS; they belong to the router-side `:<home-reality-port>` inbound.

Count check on the VPS:

```bash
ssh deploy@<vps-ip> '
  docker exec xray python3 - <<'"'"'PY'"'"'
import json, sqlite3
con = sqlite3.connect("/etc/x-ui/x-ui.db")
row = con.execute("select settings from inbounds where remark = ?", ("stealth-reality",)).fetchone()
settings = json.loads(row[0] or "{}")
print(len(settings.get("clients", [])))
PY
'
```

Expected count is `1 + len(emergency_clients)` from
`ansible/secrets/stealth.yml`: one router identity plus emergency direct-VPS
fallback identities.

## Потеряны Deploy-Only Secrets В Vault

Симптом: Channel B продолжает работать через `11-channel-b-vps.yml`, но
широкие `10-stealth-vps.yml`/`20-stealth-router.yml` опасно запускать, потому
что в Vault пустые:

- `xui_admin_password`
- `reality_server_private_key`
- `home_reality_server_private_key`

Без этих полей mutating deploy может сбить Reality/3x-ui state или упасть в
непредсказуемом месте.

Безопасный recovery-порядок:

1. С VPS read-only извлечь текущий Reality private key и short_ids из
   `/etc/x-ui/x-ui.db` (контейнер `xray`) и вернуть их в Vault.
2. С роутера read-only извлечь `home` Reality private key из
   `/opt/etc/sing-box/config.json` (inbound `reality-in`) и вернуть в Vault.
3. Если пароль 3x-ui неизвестен: сделать controlled reset credentials на VPS с
   сохранением live `port` и `webBasePath`, затем записать новые
   `xui_admin_password`, `xui_admin_web_port`, `xui_admin_web_path` в Vault.
4. Сначала запускать только read-only post-check:
   `cd ansible && ansible-playbook playbooks/99-verify.yml --limit vps_stealth`.
5. Только после этого возвращаться к широким mutating playbooks.

Факт 2026-04-27: recovery выполнен именно по этому порядку без router deploy и
без broad VPS redeploy; Channel A/Channel B runtime остались рабочими.

## 99-verify Падает На OpenClaw Upstream

Проверка OpenClaw в `99-verify.yml` включена по умолчанию
(`verify_openclaw_checks_enabled=true`), потому что OpenClaw и GhostRoute
используют общий VPS/Caddy контур. Это осознанно ловит side-effect regressions.
Для изолированного GhostRoute-only прогона можно временно отключить:
`-e verify_openclaw_checks_enabled=false`.

Симптом при `--limit vps_stealth`:

```text
OpenClaw upstream remains localhost-only for SSH tunnel access
... urlopen error [Errno 111] Connection refused ...
```

Это проверка side-service, не dataplane Channel A/B. Если
`system_caddy_site_enabled=false` и локальный upstream OpenClaw на
`system_caddy_site_upstream` не должен слушать в этот момент, возможен
единичный fail именно в этой задаче при зелёных Reality/XHTTP проверках.

## Legacy WireGuard Снова Появился

Проверка:

```sh
nvram get wgs1_enable
nvram get wgc1_enable
wg show
ip rule show | grep -E '0x1000|wgc1' || true
ipset list VPN_DOMAINS 2>&1 | head -1
iptables -t nat -S | grep -E 'wgs1|wgc1|0x1000|VPN_DOMAINS' || true
iptables -t mangle -S | grep -E 'wgs1|wgc1|0x1000|RC_VPN_ROUTE|VPN_DOMAINS' || true
```

Expected:

- both NVRAM enable flags are `0`;
- `wg show` has no active WireGuard interface;
- no `0x1000`, `wgs1`, `wgc1`, `RC_VPN_ROUTE` hooks;
- `VPN_DOMAINS` does not exist.

Если drift появился, сначала пере-примените cleanup:

```sh
ssh admin@192.168.50.1 '
  nvram set wgs1_enable=0
  nvram set wgc1_enable=0
  nvram commit
  while ip rule del fwmark 0x1000/0x1000 table wgc1 2>/dev/null; do :; done
  ipset destroy VPN_DOMAINS 2>/dev/null || true
  rm -f /opt/tmp/VPN_DOMAINS.ipset /jffs/addons/router_configuration/VPN_DOMAINS.ipset
  /jffs/scripts/firewall-start
  service restart_dnsmasq
'
```

## Emergency Fallback

Dry-run only:

```sh
ssh admin@192.168.50.1 '/jffs/scripts/emergency-enable-wgc1.sh --dry-run'
```

Live fallback creates WireGuard traffic and should be used only for catastrophic
Reality outage:

```sh
ssh admin@192.168.50.1 '/jffs/scripts/emergency-enable-wgc1.sh --enable'
ssh admin@192.168.50.1 '/jffs/scripts/emergency-enable-wgc1.sh --disable'
```

## Blocked-List Update Fails

`update-blocked-list.sh` first tries sing-box SOCKS, then falls back to direct
download if the router curl build has no SOCKS proxy support:

```sh
ssh admin@192.168.50.1 '
  netstat -nlp 2>/dev/null | grep "127.0.0.1:<router-socks-port>"
  /jffs/addons/x3mRouting/update-blocked-list.sh
  ls -lh /opt/tmp/blocked-domains.lst
'
```

If both paths fail, refresh `/opt/tmp/blocked-domains.lst` from the control
machine and then rerun `./verify.sh`. Do not re-enable WireGuard just to
download the blocklist.
