# Stealth Channel Implementation Guide

VLESS+Reality + shared Caddy L4 + sing-box REDIRECT + Ansible.

**Audience:** future engineer, LLM agent, or operator maintaining the deployed stack.
**Status:** implemented and verified; WireGuard cleanup and Home Reality split-routing refinements have landed after the original draft.
**Primary goal:** Channel A for LAN/router egress plus home Reality ingress for mobile clients. Managed destinations exit through the VPS host; non-managed destinations stay on the home WAN. WGC1 remains cold fallback only.

For the current end-to-end flow and observer model, see
[modules/routing-core/docs/network-flow-and-observer-model.md](/modules/routing-core/docs/network-flow-and-observer-model.md).

---

## 0. Current Implementation

### Routing matrix

| Source | Match sets | Mechanism | Egress |
|---|---|---|---|
| LAN clients (`br0`) | `STEALTH_DOMAINS`, `VPN_STATIC_NETS` | TCP nat `REDIRECT :<lan-redirect-port>`; UDP/443 silent DROP | Channel A sing-box redirect -> Reality/Vision |
| Remote mobile QR clients | generated VLESS/Reality profile plus sing-box rule-sets | TCP/<home-reality-port> to home ASUS Reality inbound | managed -> VPS Reality; non-managed -> home WAN |
| Channel B manual clients | separate generated home-first profiles | device app -> home Channel B XHTTP ingress -> local relay -> managed sing-box split (Reality for managed domains, direct home WAN for others) | manual fallback only |
| Channel C manual clients | separate generated NaiveProxy profile | direct client app to separate VPS hostname on `:443` | manual fallback only |
| Router-originated traffic (`OUTPUT`) | not transparently captured | main routing by default | router default / explicit proxy only |
| Legacy Legacy WireGuard | n/a | inactive in steady state | cold fallback only |

### Server side

```text
VPS host
  -> system Caddy v2 with layer4 plugin on :443
  -> generic :443 fallback site exists only to bind the public listener
  -> Reality traffic routed to Xray/3x-ui on 127.0.0.1:<xray-local-port>
  -> Xray/3x-ui stack lives under /opt/stealth
  -> existing services keep using shared system Caddy
  -> optional direct-mode Channel B XHTTP hostname routes through Caddy TLS to local-only xray-xhttp
  -> optional Channel C Naive hostname uses Caddy layer4 to a localhost-only Squid compatibility proxy
```

This is intentionally not a fully isolated Docker-only ingress. The compromise is:

- Xray/3x-ui are isolated in `/opt/stealth` Docker Compose.
- Port `443` remains owned by the shared system Caddy.
- Caddy L4 routes Reality traffic without exposing OpenClaw on public `:443`.
- The `:443` fallback site must remain present; the layer4 listener wrapper alone does not create a public listener.

### Router side

```text
Merlin router
  -> dnsmasq fills STEALTH_DOMAINS
  -> dnscrypt-proxy listens on 127.0.0.1:<dnscrypt-port>
  -> dnscrypt-proxy sends DoH through sing-box SOCKS on 127.0.0.1:<router-socks-port>
  -> sing-box listens on 0.0.0.0:<lan-redirect-port> redirect inbound
  -> sing-box listens on 0.0.0.0:<home-reality-port> home Reality inbound for remote mobile clients
  -> optional local Xray Channel B ingress on 0.0.0.0:<home-channel-b-port>
  -> local Xray relay forwards to sing-box SOCKS on 127.0.0.1:<router-socks-port>
  -> stealth-route-init.sh redirects matching br0 TCP to :<lan-redirect-port>
  -> stealth-route-init.sh drops matching br0 UDP/443 to force TCP fallback
  -> mobile reality-in uses STEALTH_DOMAINS/VPN_STATIC_NETS rule-sets for split routing
  -> legacy 0x1000/0x2000/table 200/singbox0/RC_VPN_ROUTE state is removed
```

---

## 1. Architecture

```text
LAN/Wi-Fi device
  -> br0
  -> dnsmasq
  -> STEALTH_DOMAINS
  -> TCP nat REDIRECT :<lan-redirect-port>
  -> sing-box redirect inbound
  -> VLESS+Reality over TCP/443
  -> VPS shared Caddy L4
  -> Xray Reality inbound
  -> Internet

Remote iPhone/MacBook using the current QR profile
  -> home public IP :<home-reality-port>
  -> sing-box home Reality inbound on ASUS
  -> if destination is managed:
       sing-box Reality outbound -> VPS shared Caddy L4 -> Xray Reality inbound -> Internet
  -> otherwise:
       sing-box direct-out -> home WAN -> Internet
```

Key invariant: active Channel A WireGuard is absent in the current production
policy. `wgc1_*` NVRAM is preserved only for cold fallback via
`modules/recovery-verification/router/emergency-enable-wgc1.sh`.

Preferred mobile-client invariant: use the QR profile that points at the home
public IP, not the VPS IP. This keeps the LTE carrier-facing endpoint domestic.
The final website-facing exit is VPS only for managed destinations.

---

## 2. Repository Layout

```text
ansible/
  ansible.cfg
  inventory/stealth.yml
  group_vars/
    all.yml
    routers.yml
    vps_stealth.yml
  secrets/
    stealth.yml
    stealth.yml.example
  playbooks/
    00-bootstrap-vps.yml
    10-stealth-vps.yml
    11-channel-b-vps.yml
    12-channel-c-vps.yml
    20-stealth-router.yml
    30-generate-client-profiles.yml
    99-verify.yml
  roles/
    caddy_l4/
    xray_reality/
    ufw_stealth/
    singbox_client/
    stealth_routing/
    dnscrypt_proxy/
    dnsmasq_blocklists/
  out/clients/

configs/
  dnsmasq-stealth.conf.add
  sing-box-client.json.template
  static-networks.txt

modules/
  routing-core/router/firewall-start
  routing-core/router/nat-start
  dns-catalog-intelligence/router/domain-auto-add.sh
  secrets-management/bin/init-stealth-vault.sh
  dns-catalog-intelligence/bin/domain-migrate.sh.template

docs/
  architecture.md
  modules/routing-core/docs/channel-routing-operations.md
  modules/routing-core/docs/stealth-channel-implementation-guide.md
```

---

## 3. Secrets Model

All real secrets live in:

```text
ansible/secrets/stealth.yml
```

The file is encrypted with Ansible Vault. Do not paste real content into docs or chat.

Fake schema example:

```yaml
vps_ssh_host: "203.0.113.10"
vps_ssh_user: "deploy"

router_ssh_host: "192.168.50.1"
router_ssh_user: "admin"

xui_admin_username: "admin"
xui_admin_password: "FAKE_PASSWORD"
xui_admin_web_path: "/FAKE_ADMIN_PATH"
xui_admin_web_port: <xui-admin-port>

reality_dest: "gateway.icloud.com:443"
reality_server_names:
  - "gateway.icloud.com"
reality_server_private_key: "FAKE_PRIVATE_KEY"
reality_server_public_key: "FAKE_PUBLIC_KEY"
reality_short_ids:
  - "FAKE_SHORT_ID_01"

clients:
  - name: "router"
    uuid: "00000000-0000-4000-8000-000000000000"
    short_id: "FAKE_SHORT_ID_01"
    email: "router@example.invalid"
  - name: "iphone-1"
    uuid: "00000000-0000-4000-8000-000000000001"
    short_id: "FAKE_SHORT_ID_02"
    email: "iphone-1@example.invalid"
```

Real values that must never be documented:

- client UUIDs
- Reality private/public keys
- short IDs
- 3x-ui admin password/path
- generated VLESS URIs
- QR payloads

---

## 4. Deploy Order

### 4.1 VPS bootstrap and Reality stack

```bash
cd ansible
ansible-playbook playbooks/00-bootstrap-vps.yml
ansible-playbook playbooks/10-stealth-vps.yml
```

`10-stealth-vps.yml` manages:

- Caddy L4 integration
- Xray/3x-ui Docker Compose under `/opt/stealth`
- Reality inbound on `127.0.0.1:<xray-local-port>`
- clients from vault
- UFW rules needed for the stealth stack

Manual device-client lanes are refreshed separately:

```bash
ansible-playbook playbooks/11-channel-b-vps.yml
ansible-playbook playbooks/12-channel-c-vps.yml
```

`11-channel-b-vps.yml` updates only the optional direct Channel B XHTTP backend
and validates that the Caddy route is present. `12-channel-c-vps.yml` owns the Channel C
compatibility backend/Caddy path. Neither playbook targets the router.

Channel B home-first router add-on is managed separately:

```bash
ansible-playbook playbooks/21-channel-b-router.yml
```

### 4.2 Router base layer

```bash
cd ..
ROUTER=192.168.50.1 ./deploy.sh
```

This manages historical Merlin scripts and dnsmasq managed blocks.

### 4.3 Router Channel A layer

```bash
cd ansible
ansible-playbook playbooks/20-stealth-router.yml
```

This manages:

- sing-box package/config/init
- home Reality inbound on `0.0.0.0:<home-reality-port>` for remote mobile QR clients
- dnscrypt-proxy package/config/init
- `/jffs/scripts/stealth-route-init.sh`
- `STEALTH_DOMAINS`
- table `200`
- dnsmasq include for stealth catalog

### 4.4 Client profiles

```bash
ansible-playbook playbooks/30-generate-client-profiles.yml
```

Generated local artifacts:

```text
ansible/out/clients/router.conf
ansible/out/clients-home/iphone-1.conf
ansible/out/clients-home/iphone-1.png
...
ansible/out/clients-home/macbook.conf
ansible/out/clients-home/macbook.png
ansible/out/clients-home/qr-index.html
ansible/out/clients-channel-b/qr-index.html
ansible/out/clients-channel-c/qr-index.html
```

`router.conf` is for router/service use and points directly at the VPS. Phone/Mac QR files live under `clients-home/`, point at the home public IP first, and use router-side `home_clients[]` identities.

Channel B and C artifacts live under `clients-channel-b/` and
`clients-channel-c/` and are manual fallback profiles only. Channel B artifacts
use home-first import when `channel_b_home_relay_enabled=true`, while Channel C
stays direct-to-VPS. They should not replace normal Home Reality profiles.

### 4.5 Verify

```bash
ansible-playbook playbooks/99-verify.yml
cd ..
./verify.sh
./modules/ghostroute-health-monitor/bin/router-health-report
```

Operational note (2026-04-27): during Vault secret recovery, run VPS-only verify
first:

```bash
cd ansible
ansible-playbook playbooks/99-verify.yml --limit vps_stealth
```

OpenClaw checks are enabled by default via
`verify_openclaw_checks_enabled=true`, because GhostRoute and OpenClaw share
the VPS/Caddy surface. For isolated GhostRoute-only troubleshooting, run verify
with `-e verify_openclaw_checks_enabled=false`.

---

## 5. Current Config Contracts

### `configs/dnsmasq-stealth.conf.add`

Populates `STEALTH_DOMAINS` for LAN Channel A and mobile Home Reality split:

```text
ipset=/example.com/STEALTH_DOMAINS
```

### `configs/static-networks.txt`

Shared CIDR catalog:

```text
br0 TCP     -> REDIRECT :<lan-redirect-port> -> sing-box -> Reality
br0 UDP/443 -> DROP -> TCP fallback
mobile      -> rule-set match -> Reality
```

### `modules/dns-catalog-intelligence/router/domain-auto-add.sh`

Auto-discovered domains are written only into `STEALTH_DOMAINS`:

```text
ipset=/auto-example.com/STEALTH_DOMAINS
```

---

## 6. Acceptance Checklist

### VPS

```bash
cd ansible
ansible-playbook playbooks/99-verify.yml --limit vps_stealth
```

Expected:

- Caddy has layer4 module.
- Caddy listens on `:443`.
- Xray listens on `127.0.0.1:<xray-local-port>`.
- Generic non-Reality fallback on `:443` exists, but OpenClaw is not exposed there.
- Old OpenClaw SNI does not return the OpenClaw certificate.
- `gateway.icloud.com` SNI returns the real Apple certificate through Reality fallback.
- 3x-ui admin is only reachable through localhost-bound admin port.

### Router

```bash
cd ansible
ansible-playbook playbooks/99-verify.yml --limit routers
```

Expected:

- sing-box REDIRECT listener exists on `0.0.0.0:<lan-redirect-port>`.
- sing-box home Reality listener exists on `0.0.0.0:<home-reality-port>`.
- sing-box SOCKS listener exists on `127.0.0.1:<router-socks-port>` for dnscrypt-proxy.
- `dnscrypt-proxy.toml` has `proxy = 'socks5://127.0.0.1:<router-socks-port>'`.
- sing-box config has explicit keepalive / no-multiplex tuning.
- `cru l` contains `/jffs/scripts/singbox-watchdog.sh`.
- `nvram get ipv6_service` returns `disabled`.
- `ip -6 addr show dev br0` shows no global unicast IPv6 addresses.
- `STEALTH_DOMAINS` exists and can be populated.
- `br0` TCP to `STEALTH_DOMAINS` and `VPN_STATIC_NETS` redirects to `:<lan-redirect-port>`.
- `br0` UDP/443 to those sets is silently dropped to force TCP fallback.
- mobile Home Reality has a managed split rule and direct fallback rule.
- mobile Home Reality has no catch-all `reality-in -> reality-out` rule.
- legacy `0x1000`, `0x2000`, `RC_VPN_ROUTE`, table `200`, and `singbox0` are absent.
- dnscrypt-proxy listens on configured port.
- dnsmasq upstream points to `127.0.0.1#<dnscrypt-port>`.
- OpenClaw has no router DNS override in SSH-only mode.
- Router can connect to the VPS cover port: `echo | nc -w 3 <vps-ip> 443` exits `0`.
- sing-box logs have no fresh `connection refused` to `<vps-ip>:443`.
- sing-box logs have no fresh `x509: certificate is valid for ... microsoft.com, not gateway.icloud.com`.
- Channel A WireGuard runtime hooks are absent; `wgc1_*` NVRAM is preserved only for cold fallback.
- `domain-auto-add.sh` default-skips when `/opt/tmp/blocked-domains.lst` is missing or empty.

---

## 7. Troubleshooting

### LAN traffic does not use Reality

Check:

```sh
netstat -nlp 2>/dev/null | grep ':<lan-redirect-port> '
iptables -t nat -S PREROUTING | grep <lan-redirect-port>
iptables -S FORWARD | grep 'dport 443'
tail -100 /opt/var/log/sing-box.log | grep redirect-in
```

### SNI rotation partially applied

Symptoms:

```text
dial tcp <vps-ip>:443: connect: connection refused
x509: certificate is valid for ... microsoft.com, not gateway.icloud.com
```

Checks:

```sh
echo | nc -w 3 <vps-ip> 443
tail -100 /opt/var/log/sing-box.log | grep -E 'connection refused|x509'
```

Fix:

- If `nc` fails, verify Caddy has a fallback site on `:443` and is running.
- If logs mention Microsoft certificates, sync the existing 3x-ui/Xray Reality inbound to `gateway.icloud.com:443` and restart `xray`.
- Regenerate and redistribute client QR codes after the SNI change.

### WireGuard runtime unexpectedly reappears

Check:

```sh
iptables -t mangle -S PREROUTING | grep 'wgs1 -j RC_VPN_ROUTE'
iptables -t mangle -S RC_VPN_ROUTE
ip rule show | grep 0x1000
ip route show table wgc1
```

Expected steady state: no matches. Use `modules/recovery-verification/router/emergency-enable-wgc1.sh
--disable` if an emergency fallback test left runtime rules behind.

### DNS is suspicious

Check:

```sh
grep '^server=127.0.0.1#<dnscrypt-port>$' /jffs/configs/dnsmasq.conf.add
grep '@wgc1' /jffs/configs/dnsmasq.conf.add
netstat -nlp 2>/dev/null | grep ':<dnscrypt-port> '
```

There should be no active `@wgc1` DNS upstream entries.

### OpenClaw private access

OpenClaw is intentionally hidden from public DNS and is not served by public Caddy. Open an SSH tunnel first:

```bash
ssh -N -L <private-forward-port>:127.0.0.1:<private-forward-port> \
  -o ProxyCommand='ssh admin@192.168.50.1 nc -w 120 %h %p' \
  deploy@<vps-ip>
```

Then open:

```text
http://127.0.0.1:<private-forward-port>/
```

This keeps OpenClaw off public DNS and off the shared public `:443` Caddy surface.

---

## 8. Upgrade Paths

Possible future changes:

- Move remote `wgs1` clients to Channel A.
- Add cascade: Reality VPS -> commercial VPN exit.
- Add domain migration tooling that mirrors `VPN_DOMAINS` into `STEALTH_DOMAINS` automatically.
- Add AdGuard Home instead of the lightweight dnsmasq blocklist layer.
- Add dual-stack IPv6 only after a separate design.

These are not part of the current production baseline.
