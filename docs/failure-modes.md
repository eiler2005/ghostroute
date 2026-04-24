# Failure Modes Runbook

Operational recovery notes for Channel B (LAN -> sing-box REDIRECT -> Reality) and reserve Channel A (`wgs1` -> `wgc1`).

## sing-box Down

Symptom: managed LAN destinations stall while unmanaged traffic still works.

Check:
```sh
netstat -nlp 2>/dev/null | grep ':<lan-redirect-port> '
netstat -nlp 2>/dev/null | grep '127.0.0.1:1080 '
tail -80 /opt/var/log/sing-box.log
```

Recover:
```sh
/opt/etc/init.d/S99sing-box restart
/jffs/scripts/stealth-route-init.sh
```

The watchdog `/jffs/scripts/singbox-watchdog.sh` probes `127.0.0.1:<lan-redirect-port>` every minute and restarts sing-box after repeated failures.

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

Expected design: dnsmasq sends upstream DNS to `127.0.0.1#5354`; dnscrypt-proxy sends DoH through sing-box SOCKS at `socks5://127.0.0.1:1080`.

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

## VPS SSH Broken But 443 Works

Symptom: Ansible cannot run `10-stealth-vps.yml`, but clients may still work.

Check:
```bash
nc -vz 198.51.100.10 22
nc -vz 198.51.100.10 443
curl -sk --resolve gateway.icloud.com:443:198.51.100.10 -I https://gateway.icloud.com/
```

Recover through VPS console/rescue: inspect `sshd`, host firewall, and load. Do not rotate Reality keys unless the VPS is lost or compromised.

## OpenClaw DNS Exposes Reality IP

Symptom: no user-visible outage, but active scanners can link the OpenClaw hostname to the Reality VPS IP.

Check:
```bash
dig +short <openclaw-host> @1.1.1.1
```

If it returns `198.51.100.10`, remediate using `docs/stealth-security-review-and-fixes.md` §1.3. Current chosen remediation is SSH-only access: remove the old public `sslip.io` hostname from Caddy and reach OpenClaw through `ssh -L 18789:127.0.0.1:18789`.

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

The default-skip behavior is intentional to prevent stealth-catalog pollution.
