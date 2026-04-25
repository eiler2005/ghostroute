# Failure Modes Runbook

Operational recovery notes for the Reality-only steady state:

```text
LAN -> sing-box REDIRECT :<lan-redirect-port> -> Reality
Mobile QR -> home Reality ingress :<home-reality-port> -> Reality
```

Channel A (`wgs1`/`wgc1`) is decommissioned. `wgc1_*` NVRAM remains only for
manual cold fallback through `/jffs/scripts/emergency-enable-wgc1.sh`.

## sing-box Down

Symptom: managed LAN destinations stall while unmanaged traffic still works.

Check:

```sh
netstat -nlp 2>/dev/null | grep ':<lan-redirect-port> '
netstat -nlp 2>/dev/null | grep ':<home-reality-port> '
netstat -nlp 2>/dev/null | grep '127.0.0.1:1080 '
tail -80 /opt/var/log/sing-box.log
```

Recover:

```sh
/opt/etc/init.d/S99sing-box restart
/jffs/scripts/stealth-route-init.sh
```

The watchdog probes both the LAN REDIRECT listener and the home Reality ingress.

## dnscrypt-proxy Down

Symptom: DNS resolution fails or `STEALTH_DOMAINS` stops populating.

Check:

```sh
netstat -nlp 2>/dev/null | grep ':5354 '
grep '^proxy = ' /opt/etc/dnscrypt-proxy.toml
nslookup ifconfig.me 127.0.0.1
```

Recover:

```sh
/opt/etc/init.d/S09dnscrypt-proxy2 restart
service restart_dnsmasq
```

Expected design: dnsmasq sends upstream DNS to `127.0.0.1#5354`;
dnscrypt-proxy sends DoH through sing-box SOCKS at `socks5://127.0.0.1:1080`.

## VPS 443 Broken

Symptom: local sing-box is healthy, but Reality handshakes fail.

Check from laptop:

```bash
curl -sk --resolve gateway.icloud.com:443:198.51.100.10 -I https://gateway.icloud.com/
nc -vz 198.51.100.10 443
```

Recover on VPS:

```bash
sudo systemctl restart caddy
cd /opt/stealth && docker compose up -d
docker restart xray
```

Then re-run:

```bash
ANSIBLE_CONFIG=ansible/ansible.cfg ansible-playbook ansible/playbooks/10-stealth-vps.yml
```

## Mobile Home QR Broken

Symptom: LAN still works, but mobile clients using the home QR profile fail.

Check:

```sh
netstat -nlp 2>/dev/null | grep ':<home-reality-port> '
iptables -S INPUT | grep <home-reality-port>
tail -100 /opt/var/log/sing-box.log
```

Recover:

```sh
/opt/etc/init.d/S99sing-box restart
/jffs/scripts/stealth-route-init.sh
```

## Auto-Discovery Blocklist Missing

Symptom: new auto-discovered domains are skipped instead of being added.

Check:

```sh
test -s /opt/tmp/blocked-domains.lst
logread | grep domain-auto-add | tail -20
```

Recover:

```sh
/jffs/addons/x3mRouting/update-blocked-list.sh
/jffs/addons/x3mRouting/domain-auto-add.sh
```

The update script downloads through sing-box SOCKS, not WireGuard. Default-skip
behavior is intentional to prevent stealth-catalog pollution.

## Channel A Drift Appears

Symptom: `verify.sh` reports `VPN_DOMAINS`, `0x1000`, `wgs1`, `wgc1` or
`RC_VPN_ROUTE`.

Recover:

```sh
nvram set wgs1_enable=0
nvram set wgc1_enable=0
nvram commit
while ip rule del fwmark 0x1000/0x1000 table wgc1 2>/dev/null; do :; done
ipset destroy VPN_DOMAINS 2>/dev/null || true
rm -f /opt/tmp/VPN_DOMAINS.ipset /jffs/addons/router_configuration/VPN_DOMAINS.ipset
/jffs/scripts/firewall-start
service restart_dnsmasq
```

## Emergency Cold Fallback

Dry-run:

```sh
/jffs/scripts/emergency-enable-wgc1.sh --dry-run
```

Enable only during catastrophic Reality outage:

```sh
/jffs/scripts/emergency-enable-wgc1.sh --enable
```

Disable after incident:

```sh
/jffs/scripts/emergency-enable-wgc1.sh --disable
```
