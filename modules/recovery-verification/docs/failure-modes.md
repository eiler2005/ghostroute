# Failure Modes Runbook

Operational recovery notes for the Reality-only steady state:

```text
LAN -> sing-box REDIRECT :<lan-redirect-port> -> Reality
Mobile QR -> home Reality ingress :<home-reality-port> -> Reality
```

Legacy WireGuard (`wgs1`/`wgc1`) is decommissioned. `wgc1_*` NVRAM remains only for
manual cold fallback through `/jffs/scripts/emergency-enable-wgc1.sh`.

Use [docs/runtime-inventory.md](/docs/runtime-inventory.md) before runtime
upgrades or port changes. It records the sanitized component inventory,
proven-good version policy, listener ownership and required upgrade gates.

## sing-box Down

Symptom: managed LAN destinations stall while unmanaged traffic still works.

Check:

```sh
netstat -nlp 2>/dev/null | grep ':<lan-redirect-port> '
netstat -nlp 2>/dev/null | grep ':<home-reality-port> '
netstat -nlp 2>/dev/null | grep '127.0.0.1:<router-socks-port> '
tail -80 /opt/var/log/sing-box.log
```

Recover:

```sh
/opt/etc/init.d/S99sing-box restart
/jffs/scripts/stealth-route-init.sh
```

The watchdog probes both the LAN REDIRECT listener and the home Reality ingress.

### Post-Reboot Zombie Process

Observed failure mode: after a router reboot, Entware can leave `sing-box` as a
zombie. A raw `pidof`/`kill -0` check can then print "already running" while the
LAN REDIRECT, Home Reality and router-local SOCKS listeners are absent. The
repo-managed `S99sing-box` init script treats zombie state as not live in
`start`, `stop` and `status`.

Check listeners, not only process ids:

```sh
netstat -nlp 2>/dev/null | grep ':<lan-redirect-port> '
netstat -nlp 2>/dev/null | grep ':<home-reality-port> '
netstat -nlp 2>/dev/null | grep '127.0.0.1:<router-socks-port> '
```

Recover without touching WAN or the VPS:

```sh
/jffs/scripts/ghostroute-runtime-supervisor.sh recover
```

The supervisor is launched by `services-start`, owns cron registration, applies
the dependency order, verifies LAN REDIRECT plus managed UDP/443 DROP after
applying routing, and performs targeted restarts only for missing listeners.
During boot it also runs a delayed firewall stabilization pass because Merlin
can rebuild chains after `services-start` has already fired.
Direct service restarts remain a fallback after `ghostroute-runtime-supervisor.sh
status` identifies the broken component.

If processes and listeners are healthy but `live-check` reports the Channel A
UDP/443 drop as missing after reboot, run the supervisor `recover` path and
check `live-check --deploy-gate` again. Do not reset WAN for this symptom unless
the WAN itself is down.

### Rule-set Hot Reload Crash

Observed failure mode: sing-box can die during local source rule-set hot reload,
with a `SIGSEGV` stack in the JSON rule-set reload path. After the process dies,
the local SOCKS, LAN REDIRECT, router DNS-forward and Home Reality listeners
disappear. GhostRoute Console then reports Router/Reality/Leaks as critical, and
router-side curl through `127.0.0.1:<router-socks-port>` fails because the SOCKS
listener is already gone.

Recovery:

```sh
/opt/etc/init.d/S99sing-box restart
/jffs/scripts/stealth-route-init.sh
/jffs/scripts/health-monitor/run-once
```

Guardrails:

- `update-singbox-rule-sets.sh` must replace generated JSON rule-sets
  atomically, then restart sing-box only after `sing-box check` passes.
- `/jffs/scripts/singbox-watchdog.sh` is part of the production guardrail. It
  checks redirect, SOCKS, router DNS-forward and Home Reality listeners every
  minute and restarts sing-box when they disappear.
- Do not treat an upstream generic sing-box binary as a drop-in replacement for
  the Entware package without testing LAN transparent REDIRECT from a real Wi-Fi
  client. Keep the previous `/opt/bin/sing-box.backup.*` binary until `live-check`,
  `leak-check` and a LAN managed-domain probe all pass.
- Record durable version and compatibility outcomes in
  `configs/runtime-inventory.yml`, not as one-off incident prose.

## dnscrypt-proxy Down

Symptom: managed DNS resolution fails, `STEALTH_DOMAINS` stops populating, and
home-first Reality clients may log `failed to dial dest: lookup
setup.icloud.com`. This can make LAN/Wi-Fi managed domains plus remote
Channels A/B/C/D look broken at the same time while listeners and iptables
still look healthy. Channel M is service-only direct-out and should not be used
as proof that managed DNS is healthy.

Check:

```sh
netstat -nlp 2>/dev/null | grep ':<dnscrypt-port> '
grep '^proxy = ' /opt/etc/dnscrypt-proxy.toml
grep '^server=/browserleaks.com/127.0.0.1#<dnscrypt-port>$' /jffs/configs/dnsmasq-vps-managed.conf.add
cat /proc/sys/vm/overcommit_memory
nslookup setup.icloud.com 127.0.0.1
```

Recover:

```sh
echo 1 > /proc/sys/vm/overcommit_memory
/opt/etc/init.d/S09dnscrypt-proxy2 restart
service restart_dnsmasq
```

Expected design: dnsmasq sends upstream DNS to `127.0.0.1#<dnscrypt-port>`;
dnscrypt-proxy sends DoH through sing-box SOCKS at `socks5://127.0.0.1:<router-socks-port>`.
`/jffs/scripts/dnscrypt-watchdog.sh` is the production guardrail: cron runs it
every minute and restarts only dnscrypt-proxy if the local listener disappears.
The dnscrypt init script also sets `vm.overcommit_memory=1` before starting the
Go binary; strict overcommit can make dnscrypt-proxy fail before it parses its
configuration.

## VPS 443 Broken

Symptom: local sing-box is healthy, but Reality handshakes fail.

Check from laptop:

```bash
curl -sk --resolve gateway.icloud.com:443:<vps-ip> -I https://gateway.icloud.com/
nc -vz <vps-ip> 443
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

## Home Router Down: Mobile Impact

Symptom: remote mobile clients lose the Home Reality path, often all app traffic
inside the mobile proxy profile stalls.

Check from outside home:

```bash
nc -vz <home-public-host-or-ip> <home-reality-port>
curl -I --max-time 10 https://ifconfig.me/
```

If the home relay/router/home ISP is down but the VPS is healthy:

1. In the mobile client app, switch from the normal `*-home` profile to the
   disabled/off `*-emergency-direct` profile.
2. Use it only for the outage window.
3. Switch back to `*-home` once the home relay is healthy.

If the VPS is also down, the emergency direct-VPS profile cannot help.
Disable the proxy profile and use direct LTE without bypass until the VPS or a
future multi-VPS fallback is restored.

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

## WireGuard Drift Appears

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
