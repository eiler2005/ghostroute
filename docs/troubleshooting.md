# Диагностика проблем

## Сначала

```bash
ROUTER=192.168.50.1 ./verify.sh
./scripts/router-health-report
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

## VPS Emergency Clients Drift

VPS Reality inbound should contain the router identity plus
`emergency_clients[]`. Normal mobile `home_clients[]` must not be present on the
VPS; they belong to the router-side `:<home-reality-port>` inbound.

Count check on the VPS:

```bash
ssh deploy@198.51.100.10 '
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

## Legacy Channel A Снова Появился

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
- `wg show` has no active Channel A interface;
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

`update-blocked-list.sh` fetches through sing-box SOCKS:

```sh
ssh admin@192.168.50.1 '
  netstat -nlp 2>/dev/null | grep "127.0.0.1:1080"
  /jffs/addons/x3mRouting/update-blocked-list.sh
  ls -lh /opt/tmp/blocked-domains.lst
'
```

If SOCKS is missing, check sing-box first; do not re-enable WireGuard just to
download the blocklist.
