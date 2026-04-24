# Диагностика проблем

## Сначала

```bash
./verify.sh
./scripts/router-health-report
cd ansible && ansible-playbook playbooks/99-verify.yml
```

Если эти проверки зеленые, почти всегда проблема локализуется в конкретном domain/static entry, клиентском DNS cache или внешнем сервисе.

---

## LAN-сайт не идет через Reality / REDIRECT

### Проверить rules

```sh
netstat -nlp 2>/dev/null | grep ':<lan-redirect-port> '
iptables -t nat -S PREROUTING | grep <lan-redirect-port>
iptables -S FORWARD | grep 'dport 443'
ip rule show | grep 0x2000 || true
ip route show table 200 || true
ip -br link show singbox0 2>&1 || true
```

Expected:

- sing-box слушает `0.0.0.0:<lan-redirect-port>`.
- `PREROUTING -i br0` redirects TCP for `STEALTH_DOMAINS` and `VPN_STATIC_NETS` to `:<lan-redirect-port>`.
- `FORWARD -i br0` rejects UDP/443 for the same sets, forcing QUIC fallback.
- legacy `0x2000`, table `200`, and `singbox0` are absent.

### Проверить DNS/ipset

```sh
nslookup example.com 127.0.0.1
ipset test STEALTH_DOMAINS <resolved-ip>
tail -100 /opt/var/log/sing-box.log | grep redirect-in
```

Если IP не попал в `STEALTH_DOMAINS`, проверьте `configs/dnsmasq-stealth.conf.add` и что dnsmasq был перезапущен после deploy.

---

## Remote WireGuard client не идет через WGC1 по VPN_DOMAINS

Это относится к клиентам встроенного WireGuard VPN Server на роутере (`wgs1`).

### Проверить handshakes

```sh
wg show wgs1 latest-handshakes
```

`0` означает, что peer еще не подключался или давно не активен.

### Проверить route hook

```sh
iptables -t mangle -S PREROUTING | grep 'wgs1 -j RC_VPN_ROUTE'
iptables -t mangle -S RC_VPN_ROUTE
ip rule show | grep 0x1000
ip route show table wgc1
```

Expected:

- `wgs1 -> RC_VPN_ROUTE` exists.
- `RC_VPN_ROUTE` marks `VPN_DOMAINS` and `VPN_STATIC_NETS`.
- `0x1000/0x1000` routes to table `wgc1`.

### Проверить DNS capture

```sh
iptables -t nat -S PREROUTING | grep -e 'wgs1'
```

Expected:

```text
-A PREROUTING -i wgs1 -p udp --dport 53 -j REDIRECT --to-ports 53
-A PREROUTING -i wgs1 -p tcp --dport 53 -j REDIRECT --to-ports 53
```

---

## На роутере снова появился `@wgc1` DNS upstream

Это legacy drift.

Проверка:

```sh
grep '@wgc1' /jffs/configs/dnsmasq.conf.add
```

Expected: пустой вывод.

Исправление:

```bash
ROUTER=192.168.50.1 ./deploy.sh
cd ansible && ansible-playbook playbooks/20-stealth-router.yml
ansible-playbook playbooks/99-verify.yml
```

Если строки вернулись, проверьте, что никто вручную не добавил `server=/domain/...@wgc1` в local configs или router-side custom blocks.

---

## sing-box REDIRECT не слушает `:<lan-redirect-port>`

```sh
/opt/etc/init.d/S99sing-box status
netstat -nlp 2>/dev/null | grep ':<lan-redirect-port> '
tail -100 /opt/var/log/sing-box.log
/opt/bin/sing-box check -C /opt/etc/sing-box
```

Re-apply:

```bash
cd ansible
ansible-playbook playbooks/20-stealth-router.yml
```

Если config check падает, проверьте vault client fields and Reality parameters.

---

## Reality/VLESS клиент не подключается

Проверить VPS:

```bash
cd ansible
ansible-playbook playbooks/99-verify.yml --limit vps_stealth
```

Проверить локальные профили:

```bash
ls -la ansible/out/clients
```

Fake URI example for shape only:

```text
vless://00000000-0000-4000-8000-000000000000@example.invalid:443?type=tcp&security=reality&pbk=FAKE_PUBLIC_KEY&sid=FAKE_SHORT_ID&sni=www.microsoft.com&fp=chrome#debug-placeholder
```

Do not paste real URI/QR payload into docs or chat.

Common causes:

- wrong client UUID
- wrong short_id
- stale Reality public key
- wrong SNI/server name
- Caddy layer4 not loaded
- Xray not listening on `127.0.0.1:8443`

---

## DNS не работает или домены не попадают в ipset

Проверить:

```sh
grep '^server=127.0.0.1#5354$' /jffs/configs/dnsmasq.conf.add
netstat -nlp 2>/dev/null | grep ':5354 '
nslookup example.com 127.0.0.1
```

Re-apply:

```bash
cd ansible
ansible-playbook playbooks/20-stealth-router.yml
```

Router-side restart:

```sh
service restart_dnsmasq
/opt/etc/init.d/S09dnscrypt-proxy2 restart
```

---

## Static service работает только частично

Пример: Telegram текст работает, media нет.

Проверить:

```sh
ipset list VPN_STATIC_NETS | awk '/^Number of entries:/ {print $4}'
ipset test VPN_STATIC_NETS <service-ip>
iptables -t nat -S PREROUTING | grep VPN_STATIC_NETS
ip route get <service-ip> mark 0x1000
```

Interpretation:

- LAN TCP должен попадать в `REDIRECT --to-ports <lan-redirect-port>`.
- `mark 0x1000` должен идти в `wgc1`.

Если IP не в `VPN_STATIC_NETS`, обновите `configs/static-networks.txt`.

---

## `verify.sh` показывает drift

Сначала прочитайте конкретную строку drift. Типовые варианты:

| Drift | Meaning |
|---|---|
| missing `STEALTH_DOMAINS` | stealth-route-init не применился |
| missing Channel B REDIRECT listener | sing-box не слушает `:<lan-redirect-port>` |
| missing LAN TCP REDIRECT | Channel B nat rules не применились |
| missing UDP/443 reject | QUIC может обходить Reality |
| legacy `br0 -> RC_VPN_ROUTE` still enabled | старая LAN->WGC1 политика вернулась |
| legacy `OUTPUT -> RC_VPN_ROUTE` still enabled | router-originated traffic снова идет в WGC1 |
| missing `wgs1 -> RC_VPN_ROUTE` | remote WG clients потеряли WGC1 split-routing |

Safe recovery:

```bash
ROUTER=192.168.50.1 ./deploy.sh
cd ansible
ansible-playbook playbooks/20-stealth-router.yml
ansible-playbook playbooks/99-verify.yml
```

---

## SSH/deploy проблемы

```bash
ping 192.168.50.1
nc -z -w 5 192.168.50.1 22
ssh -o PubkeyAcceptedAlgorithms=+ssh-rsa admin@192.168.50.1
```

Merlin/dropbear compatibility:

- `deploy.sh` uses `scp -O`.
- SSH public key algorithm compatibility is handled by script options.
- SSH should stay `LAN only`.

---

## IPv6

Current supported mode: IPv6 disabled.

Do not enable partial IPv6 and assume these IPv4 ipset/fwmark rules will cover it. Dual-stack routing requires a separate design.
