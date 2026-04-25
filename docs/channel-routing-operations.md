# Channel Routing Operations

Operational runbook for checking, switching and debugging GhostRoute channels.

## Current Policy

| Source | Match sets | Mechanism | Egress |
|---|---|---|---|
| LAN clients (`br0`) | `STEALTH_DOMAINS`, `VPN_STATIC_NETS` | TCP nat `REDIRECT :<lan-redirect-port>`; UDP/443 DROP | sing-box redirect -> VLESS+Reality |
| Remote mobile QR clients | generated VLESS/Reality profile | TCP/<home-reality-port> to home ASUS Reality inbound | sing-box home ingress -> VPS Reality |
| Router-originated traffic (`OUTPUT`) | not transparently captured | main routing by default | router default / explicit proxy only |
| Legacy WireGuard clients (`wgs1`) | `VPN_DOMAINS`, `VPN_STATIC_NETS` | mark `0x1000` -> table `wgc1` | legacy WGC1 |

DNS is shared:

```text
dnsmasq -> dnscrypt-proxy 127.0.0.1:5354
```

Per-domain `@wgc1` DNS upstreams are retired. `wgc1` is still active, but only as the reserve path for legacy `wgs1` clients. New mobile clients should use the QR profile that points at the home public IP.

---

## Fast Health Check

From the repo:

```bash
./verify.sh
./scripts/router-health-report
```

Router-side stealth verification:

```bash
cd ansible
ansible-playbook playbooks/99-verify.yml --limit routers
```

Expected high-level result:

```text
Result: OK
Drift items: 0
```

---

## Live Router Checks

### Channel B REDIRECT

```sh
netstat -nlp 2>/dev/null | grep ':<lan-redirect-port> '
iptables -t nat -S PREROUTING | grep <lan-redirect-port>
iptables -S FORWARD | grep 'dport 443'
```

Expected:

```text
0.0.0.0:<lan-redirect-port> ... LISTEN ... sing-box
-A PREROUTING -i br0 -p tcp -m set --match-set STEALTH_DOMAINS dst -j REDIRECT --to-ports <lan-redirect-port>
-A PREROUTING -i br0 -p tcp -m set --match-set VPN_STATIC_NETS dst -j REDIRECT --to-ports <lan-redirect-port>
-A FORWARD -i br0 -p udp --dport 443 -m set --match-set STEALTH_DOMAINS dst -j DROP
-A FORWARD -i br0 -p udp --dport 443 -m set --match-set VPN_STATIC_NETS dst -j DROP
```

Must not exist in current policy:

```text
fwmark 0x2000
table 200 default dev singbox0
live singbox0 interface
```

Check absence:

```sh
ip rule show | grep 0x2000 || true
ip route show table 200 || true
ip -br link show singbox0 2>&1 || true
```

### Home Reality Mobile Ingress

```sh
netstat -nlp 2>/dev/null | grep ':<home-reality-port> '
iptables -S INPUT | grep -- '--dport <home-reality-port>'
```

Expected:

```text
0.0.0.0:<home-reality-port> ... LISTEN ... sing-box
-A INPUT -p tcp -m tcp --dport <home-reality-port> -j ACCEPT
```

Generated mobile QR profiles (`iphone-*`, `macbook`) must point at the home public IP or home DNS name. The `router` profile is the exception: it points directly at the VPS because it is the router's outbound identity.

### Channel A Reserve For Remote Clients

```sh
iptables -t mangle -S PREROUTING | grep 'wgs1 -j RC_VPN_ROUTE'
iptables -t mangle -S RC_VPN_ROUTE
ip rule show | grep '0x1000'
ip route show table wgc1
```

Expected:

```text
-A PREROUTING -i wgs1 -j RC_VPN_ROUTE
-A RC_VPN_ROUTE -m set --match-set VPN_DOMAINS dst -j MARK --set-xmark 0x1000/0x1000
-A RC_VPN_ROUTE -m set --match-set VPN_STATIC_NETS dst -j MARK --set-xmark 0x1000/0x1000
fwmark 0x1000/0x1000 -> table wgc1
```

Must not exist:

```text
-A PREROUTING -i br0 -j RC_VPN_ROUTE
-A OUTPUT -j RC_VPN_ROUTE
-A PREROUTING -i wgs1 -m set --match-set STEALTH_DOMAINS dst ...
```

### DNS

```sh
grep '^server=127.0.0.1#5354$' /jffs/configs/dnsmasq.conf.add
grep '@wgc1' /jffs/configs/dnsmasq.conf.add
netstat -nlp 2>/dev/null | grep ':5354 '
```

Expected:

- `server=127.0.0.1#5354` exists.
- active `@wgc1` entries do not exist.
- `dnscrypt-proxy` listens on `127.0.0.1:5354`.

### ipsets

```sh
ipset list STEALTH_DOMAINS | awk '/^Number of entries:/ {print $4}'
ipset list VPN_DOMAINS | awk '/^Number of entries:/ {print $4}'
ipset list VPN_STATIC_NETS | awk '/^Number of entries:/ {print $4}'
```

`STEALTH_DOMAINS` and `VPN_DOMAINS` are populated dynamically after DNS resolution. A low value immediately after restart is not necessarily a failure.

---

## Deploy Sequence

Use this order after changing local repo files:

```bash
ROUTER=192.168.50.1 ./deploy.sh
cd ansible
ansible-playbook playbooks/20-stealth-router.yml
ansible-playbook playbooks/99-verify.yml --limit routers
cd ..
./verify.sh
./scripts/router-health-report
```

Why both deploy mechanisms exist:

- `deploy.sh` manages historical router scripts, dnsmasq managed blocks and catalogs.
- Ansible manages `sing-box`, `dnscrypt-proxy`, stealth redirect init and VPS/router Reality pieces.

---

## Switch LAN Back To WGC1 Temporarily

Use only as an emergency rollback if Channel B is unhealthy.

Implementation intent:

1. Hook `RC_VPN_ROUTE` back to `br0`.
2. Disable or remove Channel B REDIRECT rules in `stealth-route-init.sh`.
3. Optionally handle router `OUTPUT` explicitly only if needed.
4. Deploy and verify.

Concrete files:

```text
scripts/firewall-start
ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2
scripts/lib/router-health-common.sh
ansible/playbooks/99-verify.yml
```

Expected rollback matrix:

| Source | Egress after rollback |
|---|---|
| `br0` | `wgc1` |
| `OUTPUT` | main routing unless a separate explicit rule is added |
| `wgs1` | `wgc1` |

Do not leave both `RC_VPN_ROUTE` and REDIRECT rules active for the same LAN source unless you intentionally design precedence.

---

## Move Remote WGS1 Clients To Channel B

Not the current baseline.

Because this router supports `REDIRECT` but not `TPROXY`, moving `wgs1` to Channel B should be designed carefully. A naive mangle mark is not enough in the current REDIRECT model.

Implementation options:

- Keep `wgs1` on `wgc1` as today. This is the supported baseline.
- Add explicit client-side VLESS profiles for those remote devices.
- Design a separate router-side proxy path for `wgs1` if there is a strong reason to retire WGC1 later.

Acceptance for the current baseline:

```sh
iptables -t mangle -S PREROUTING | grep 'wgs1 -j RC_VPN_ROUTE'
iptables -t mangle -S PREROUTING | grep 'wgs1.*STEALTH_DOMAINS' && echo "unexpected"
```

---

## Add A Domain To Both Catalogs

Managed domains should be present in both active catalogs:

```text
configs/dnsmasq.conf.add
configs/dnsmasq-stealth.conf.add
```

Example:

```text
ipset=/example.com/VPN_DOMAINS
ipset=/example.com/STEALTH_DOMAINS
```

No new `server=/example.com/...@wgc1` lines are needed.

Deploy:

```bash
ROUTER=192.168.50.1 ./deploy.sh
cd ansible && ansible-playbook playbooks/20-stealth-router.yml
```

Warm and verify:

```sh
nslookup example.com 127.0.0.1
ipset list VPN_DOMAINS | grep <resolved-ip>
ipset list STEALTH_DOMAINS | grep <resolved-ip>
iptables -t nat -vnL PREROUTING | grep 'redir ports <lan-redirect-port>'
```

---

## Client QR Operations

Generate client profiles:

```bash
cd ansible
ansible-playbook playbooks/30-generate-client-profiles.yml
```

Local artifacts:

```text
ansible/out/clients/router.conf
ansible/out/clients-home/iphone-1.png
ansible/out/clients-home/iphone-1.conf
ansible/out/clients-home/macbook.png
ansible/out/clients-home/macbook.conf
ansible/out/clients-home/qr-index.html
```

Security rule:

- Real files under `ansible/out/clients/` and `ansible/out/clients-home/` are operational secrets.
- Do not paste real VLESS URI or QR payload in issues/docs/chat.
- Documentation may use fake placeholders only.

Fake example:

```text
vless://00000000-0000-4000-8000-000000000000@example.invalid:443?type=tcp&security=reality&pbk=FAKE_PUBLIC_KEY&sid=FAKE_SHORT_ID&sni=gateway.icloud.com&fp=chrome#example-client
```

---

## Troubleshooting Quick Map

| Symptom | First checks |
|---|---|
| LAN site does not use Reality exit | `STEALTH_DOMAINS`, REDIRECT `:<lan-redirect-port>`, UDP/443 DROP, sing-box log |
| Remote WG client does not use WGC1 | `wgs1 -> RC_VPN_ROUTE`, `VPN_DOMAINS`, `0x1000`, table `wgc1` |
| DNS looks wrong | `server=127.0.0.1#5354`, dnscrypt listener, no active `@wgc1` |
| Static service broken | `VPN_STATIC_NETS`, REDIRECT counters, source-specific route |
| Reality tunnel down | `sing-box` status/log, VPS Caddy/Xray, `99-verify.yml` |

Full guide: [troubleshooting.md](troubleshooting.md).
