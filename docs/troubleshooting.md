# Диагностика проблем

Для скорости LTE/Home Reality, MTU/MSS, TCP buffer и `connlimit` диагностики см.
[modules/performance-diagnostics/docs/routing-performance-troubleshooting.md](/modules/performance-diagnostics/docs/routing-performance-troubleshooting.md).

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

## Channel B/C Future Manual Profiles Не Работают

Channel B и Channel C не являются production-ready fallback-каналами. Этот
раздел нужен только для будущих manual device-client экспериментов и не
участвует в health-check Channel A. B/C не должны менять router
REDIRECT/DNS/TUN и не дают automatic failover.

Для будущих Channel B проверок access logs пишутся в Caddy stdout/journal. Для
будущих Channel C вариантов фактический лог зависит от выбранного backend:
Caddy `forward_proxy` пишет в Caddy HTTP logger, а compatibility backend может
писать в Squid/stunnel logs.

```bash
ssh deploy@<vps-ip> '
  sudo journalctl -u caddy --since "15 minutes ago" -o cat |
    grep -E "channel_b_xhttp|channel_c_naive" | tail -80
'
```

Expected:

- Future Channel B requests show logger `channel_b_xhttp`, host matching the XHTTP
  hostname, and either the configured random path or `404` for wrong paths.
- Future Channel C `caddy_forward_proxy` requests show logger `channel_c_naive`.
- Future Channel C `stunnel_squid` requests show in
  `/var/log/squid/channel-c-access.log` and `/var/log/stunnel4/channel-c.log`.
- Historical Channel C Shadowrocket HTTPS-proxy profiles are kept import-safe: no
  custom UDP/QUIC rule is embedded in the generated `.conf`, and proxy line is
  generated in keyword form:
  `https, <host>, 443, username=<user>, password=<pass>, method=connect, tls=true, tfo=false`.
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
