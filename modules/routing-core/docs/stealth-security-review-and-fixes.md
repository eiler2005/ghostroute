# Stealth Channel — Security Review & Hardening Implementation Guide

**Audience:** LLM agent or engineer implementing hardening fixes on the deployed `router_configuration` stealth channel.
**Scope:** Channel A (VLESS+Reality+Vision on VPS CX23 `<vps-ip>`, system Caddy + Xray, sing-box REDIRECT mode on Merlin router) plus the applied home Reality ingress for remote QR clients. Legacy WireGuard (`wgc1`/`wgs1` via commercial VPN) is out of scope for fixes but referenced where it affects posture.
**Status:** Implementation guide plus applied local baseline for P0 §1.1, P0 §1.2, P0 §1.3, P1 §2.1, P1 §2.2, P1 §2.3, P1 §2.4, P1 §2.5, P1 §2.6, LTE performance hardening, and P2 §3.1 as of 2026-04-25. Remaining P2 items stay backlog.
**Primary goal (unchanged):** RKN/ISP DPI cannot classify our home traffic as VPN. Everything else is secondary.

This document is self-contained. Read [docs/architecture.md], [modules/routing-core/docs/channel-routing-operations.md], and [modules/routing-core/docs/stealth-channel-implementation-guide.md] for context if needed, but every fix below has its own self-sufficient problem statement, scope, patch, and verification.

---

## 0. Threat model refresher

We defend against:

1. **Passive DPI by RU ISP/RKN** — classifying our flows as VPN (WG fingerprint, Reality fingerprint, protocol heuristics, statistical duration/volume anomalies).
2. **Active probing by RKN** — they send test HTTPS/UDP to our VPS, try to identify what service runs there.
3. **SNI enumeration / certificate fingerprinting** — probing `443` on our VPS with various SNI values to discover Reality vs. other services.
4. **Correlation between home IP and known-blocked destinations** — any traffic that bypasses the stealth tunnel and reveals we reach blocked resources.

We do NOT defend (explicitly out of scope in this pass) against:
- Traffic analysis by well-resourced adversary (NetFlow-level multi-vantage).
- Physical seizure / legal compulsion of VPS or RU-side operator.
- Social engineering / endpoint compromise.
- Browser-level fingerprinting (Canvas, WebRTC unless noted).

---

## 1. Priority ladder

| Priority | # of items | Deploy effect | Deadline |
|---|---|---|---|
| **P0** — Critical. These are actively-exploitable holes that defeat the stealth goal. | 3 | Minor (config changes, no service redeploy of Reality) | ASAP, same session |
| **P1** — Important. Each lowers detection risk meaningfully but is not trivially exploitable right now. | 6 | Some require re-run of Ansible playbooks | Within 1–2 weeks |
| **P2** — Hardening. Incremental defense-in-depth, documentation, future-proofing. | 7 | Varies | Backlog |

Execute in numerical order: 1.1 → 1.2 → 1.3 → 2.1 → … Each fix includes a verification step; **do not proceed to the next item if verification fails**.

### 1.0 Implementation status (2026-04-25)

| Item | Status | Evidence |
|---|---|---|
| §1.1 IPv6 kill-switch | Applied | `20-stealth-router.yml`, `ipv6_kill`, `verify.sh`: IPv6 disabled / no LAN GUA; dnsmasq `filter-AAAA` blocks dead dual-stack answers |
| §1.2 UDP/443 REJECT → DROP | Applied | `stealth-route-init.sh`, `99-verify.yml`, `verify.sh`: DROP present, REJECT absent |
| §1.3 OpenClaw off shared IP | Done via SSH-only access | Old public `sslip.io` hostname removed from public Caddy surface; OpenClaw is reached through an SSH tunnel to VPS loopback `127.0.0.1:<private-forward-port>`. |
| §2.1 SNI switch | Applied | Vault/client profiles, Caddy L4 route, and Xray/3x-ui Reality inbound use `gateway.icloud.com`; `modules/reality-sni-rotation/docs/sni-rotation-candidates.md` contains decision log |
| §2.2 DoH through stealth | Applied | sing-box SOCKS `127.0.0.1:<router-socks-port>`; dnscrypt `proxy = 'socks5://127.0.0.1:<router-socks-port>'` |
| §2.3 TCP keepalive / flow tuning | Applied | sing-box VLESS outbound has keepalive interval, connect timeout, no multiplex, no TFO |
| §2.4 sing-box watchdog | Applied | `/jffs/scripts/singbox-watchdog.sh` cron installed |
| §2.5 domain-auto-add default-skip | Applied | missing/empty `blocked-domains.lst` now skips and logs instead of adding all |
| §2.6 docs/checklists | Applied | `architecture.md`, `modules/routing-core/docs/stealth-channel-implementation-guide.md`, `modules/recovery-verification/docs/failure-modes.md` updated |
| Home Reality ingress for remote QR clients | Applied follow-up | iPhone/MacBook QR profiles connect to the home ASUS public IP on TCP/<home-reality-port>; mobile operators see the home Russian IP, not VPS. Router forwards those sessions through the VPS Reality outbound. |
| LTE performance hardening | Applied follow-up | MSS clamp on both mobile ingress handshake directions, TCP high-BDP sysctl tuning, connlimit raised to 300, and `modules/performance-diagnostics/docs/routing-performance-troubleshooting.md` added. |

---

# P0 — Critical

## 1.1 Close IPv6 bypass

### Problem
`modules/routing-core/router/firewall-start` and `ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2` contain only IPv4 (`iptables`) rules. No `ip6tables` / `ipset` IPv6 equivalents. If Merlin has IPv6 enabled (UI → IPv6 → Connection type), LAN devices receive RA/DHCPv6 and their IPv6 traffic **bypasses** the entire stealth pipeline: REDIRECT on :<lan-redirect-port>, UDP/443 DROP, and dnsmasq's own `STEALTH_DOMAINS` resolution.

### Why it matters
When LAN device resolves a dual-stack destination (e.g. YouTube AAAA), the IPv6 connection goes directly from home WAN to the real target. ISP sees destination IPv6, real SNI, and real hostname — the whole stealth channel is irrelevant to that flow. RKN/ISP learns both: (a) we reach blocked resources, (b) we have persistent cover traffic on TCP/443 IPv4. Correlation gives them evidence.

### Scope
- **Router Ansible role:** `ansible/roles/stealth_routing/`
- **Router script:** `modules/routing-core/router/firewall-start` (may contain commented IPv6 block per review findings)
- **Verification:** `verify.sh`
- **Documentation:** `modules/routing-core/docs/stealth-channel-implementation-guide.md` §6 acceptance checklist

### Fix

**Chosen approach: IPv6 kill-switch via Merlin NVRAM plus dnsmasq `filter-AAAA`.** Simpler and more robust than mirroring ip6tables rules. `filter-AAAA` matters even when Merlin reports IPv6 disabled: LAN clients should not receive dual-stack AAAA answers that can make browsers/apps prefer a dead IPv6 path. If user later needs IPv6 for some specific LAN use case, that becomes a separate design task that must mirror the full IPv4 stealth plane in v6 before re-enabling.

1. Create a new role `ansible/roles/ipv6_kill/` with a single task:

   **`ansible/roles/ipv6_kill/tasks/main.yml`:**
   ```yaml
   - name: Check current IPv6 service state
     ansible.builtin.raw: "nvram get ipv6_service"
     register: ipv6_state
     changed_when: false

   - name: Disable IPv6 in Merlin NVRAM (if enabled)
     ansible.builtin.raw: |
       nvram set ipv6_service=disabled
       nvram commit
     when: ipv6_state.stdout | trim not in ['disabled', '']
     notify: restart network

   - name: Fail-safe assert — IPv6 must be disabled
     ansible.builtin.raw: "nvram get ipv6_service"
     register: ipv6_recheck
     changed_when: false
     failed_when: ipv6_recheck.stdout | trim not in ['disabled', '']

   - name: Filter AAAA answers while IPv6 policy is disabled
     ansible.builtin.raw: |
       CONF=/jffs/configs/dnsmasq.conf.add
       touch "$CONF"
       sed -i '/^filter-AAAA$/d' "$CONF"
       echo 'filter-AAAA' >> "$CONF"
       service restart_dnsmasq
     changed_when: false

   - name: Verify no LAN IPv6 GUA addresses
     ansible.builtin.raw: |
       ip -6 addr show dev br0 2>/dev/null | grep -E 'inet6 (2|3)[0-9a-f]{1,3}:' || echo "OK_NO_GUA"
     register: v6_gua
     changed_when: false
     failed_when: "'OK_NO_GUA' not in v6_gua.stdout"
   ```

   **`ansible/roles/ipv6_kill/handlers/main.yml`:**
   ```yaml
   - name: restart network
     ansible.builtin.raw: "service restart_net_and_phy"
   ```

2. Prepend the new role to the router playbook, **before** `stealth_routing`:

   **Edit `ansible/playbooks/20-stealth-router.yml`:**
   ```yaml
   roles:
     - ipv6_kill          # NEW — must be first
     - singbox_client
     - stealth_routing
     - dnscrypt_proxy
     - dnsmasq_blocklists
   ```

3. Add verification to `verify.sh` (router SSH block):
   ```bash
   # IPv6 kill-switch
   ssh "$ROUTER_SSH" '
     [ "$(nvram get ipv6_service)" = "disabled" ] || { echo "FAIL: IPv6 not disabled"; exit 1; }
     ip -6 addr show dev br0 2>/dev/null | grep -qE "inet6 (2|3)" && { echo "FAIL: LAN GUA v6 present"; exit 1; } || true
     dig @192.168.50.1 youtube.com AAAA +short | grep . && { echo "FAIL: AAAA answers are not filtered"; exit 1; }
     echo "OK: IPv6 disabled, no LAN GUA v6"
   '
   ```

4. Add to the acceptance checklist in `modules/routing-core/docs/stealth-channel-implementation-guide.md` §6:
   ```
   - [ ] `nvram get ipv6_service` == `disabled`
   - [ ] `ip -6 addr show dev br0` shows no global unicast IPv6 addresses
   - [ ] `dig @192.168.50.1 youtube.com AAAA +short` is empty
   ```

### Verification

Run after applying:
```
cd ansible
ansible-playbook playbooks/20-stealth-router.yml --tags ipv6_kill
ansible-playbook playbooks/99-verify.yml --limit routers
../verify.sh
```

All three must be green. Additionally, from a LAN client, verify no IPv6 connectivity:
```
curl -6 --max-time 5 https://ipv6.google.com  # expect: timeout / Network unreachable
```

### Rollback

If IPv6 is needed for some service that breaks:
```
ssh "$ROUTER_SSH" 'nvram set ipv6_service=<previous-value>; nvram commit; service restart_net_and_phy'
```
But do **not** re-enable IPv6 permanently without first mirroring all stealth rules in v6 (`ip6tables` for NAT REDIRECT, UDP DROP, `ipset -family inet6` for STEALTH_DOMAINS). That is a separate, larger task.

### Estimated effort
30 min.

---

## 1.2 Replace UDP/443 REJECT with DROP

### Problem
`ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2` uses:
```
iptables -I FORWARD 1 -i br0 -p udp --dport 443 -m set --match-set "$IPSET" dst \
  -j REJECT --reject-with icmp-port-unreachable
```
`REJECT --reject-with icmp-port-unreachable` sends an ICMP type 3 code 3 back to the client. Fast QUIC fallback to TCP, but creates a distinctive behavioral signature.

### Why it matters
Typical internet path blocking QUIC is either:
- **Silent drop** → client times out (200–1000 ms) and falls back to TCP.
- **Server-side VERSION_NEGOTIATION** → sent by real server.

`ICMP port-unreachable from the local router` for UDP/443 is rare in the wild. DPI analyzer can correlate:
1. LAN client sends UDP/443 to hostname X.
2. Within ~1 ms, router emits ICMP type 3 code 3.
3. Within ~20 ms, same LAN client sends TCP SYN to same X, TLS SNI=`<cover SNI>`.

This sequence is textbook "QUIC blocked locally to force TCP into stealth tunnel". Swapping to DROP costs ~300 ms once per QUIC-capable session — imperceptible — and erases the signature.

### Scope
- `ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2`

### Fix

Change the two REJECT lines (one for each ipset) to DROP. Edit:
```
iptables -I FORWARD 1 -i br0 -p udp --dport 443 -m set --match-set "$IPSET" dst \
  -j DROP
iptables -I FORWARD 1 -i br0 -p udp --dport 443 -m set --match-set "$STATIC_IPSET" dst \
  -j DROP
```

Also, review any similar `--reject-with` patterns in the same script or sibling scripts — convert all that target STEALTH traffic to DROP. Do **not** touch rules outside the stealth scope.

### Verification

1. Re-deploy:
   ```
   cd ansible
   ansible-playbook playbooks/20-stealth-router.yml --tags stealth_routing
   ```

2. On router, confirm rules changed:
   ```
   ssh "$ROUTER_SSH" 'iptables -t filter -S FORWARD | grep -E "udp dpt:443|dport 443"'
   ```
   Expect: `-j DROP`, no `-j REJECT`.

3. Behavioral test — from LAN:
   ```
   # Before fix: UDP/443 to stealth domain triggers instant ICMP
   # After fix: same UDP/443 times out silently
   dig +short <any STEALTH_DOMAINS member> | head -1   # get an IP
   nc -u -w 3 -v <that-ip> 443                          # expect: just hangs for 3s, no immediate error
   ```

4. Functional test — QUIC-capable client (Chrome/Safari) to a STEALTH domain:
   - Should still work within ~300 ms of extra latency at first connection.
   - Subsequent connections reuse TCP (no QUIC retry cycle).

### Rollback

Revert both lines to `REJECT --reject-with icmp-port-unreachable` and redeploy. No state damage.

### Estimated effort
10 min.

---

## 1.3 Eliminate SNI-enumeration risk from shared-Caddy co-host (OpenClaw)

### Problem
Historically, system Caddy on `<vps-ip>:443` served two logical endpoints:
- Reality cover (`sni=gateway.icloud.com`; previous baseline was `www.microsoft.com`, see §2.1).
- A personal/project site behind mTLS (referenced as OpenClaw in the review; config in `ansible/roles/caddy_l4/templates/SystemCaddyfile.j2`).

An active SNI scanner probing `443` with the OpenClaw hostname receives a certificate whose SAN lists that hostname. If that hostname is **publicly resolvable to `<vps-ip>`** (A/AAAA record), an attacker can:
1. Enumerate your VPS IP via regular DNS.
2. Scan `443` with every plausible SNI; discover Reality cover behavior because it is the only SNI that successfully proxies to the configured cover certificate.
3. Link the VPS IP to you personally via the OpenClaw domain's WHOIS / DNS ownership.

This collapses the "VPS exit IP is just cover-like public TLS" story into "VPS exit IP belongs to [user], serves both private project X and suspiciously-stable cover TLS". One Google query dismantles the cover.

### Why it matters
Highest-impact attack for a well-resourced RKN DPI: they see VPS exit IP handles persistent TCP 24/7 from this user's home IP with a cover SNI. They scan IP for other services → find OpenClaw cert → confirmed VPN setup by this specific user. All cover-story benefits lost.

### Scope

Three possible remediation paths, in order of preference:

**Path A (best): move OpenClaw to a different IP/host.**
- Provision a VPS Floating IP (~€1/mo) and bind OpenClaw's Caddy site to it.
- OR host OpenClaw on a different VPS entirely.

**Path B (next best): front OpenClaw with Cloudflare.**
- DNS A record of OpenClaw domain → Cloudflare (orange-cloud proxy).
- Cloudflare terminates TLS for that domain; origin-pulls from VPS via a non-443 port (e.g. <xray-local-port> via Cloudflare Tunnel / `cloudflared`).
- SNI probing `<vps-ip>:443` with OpenClaw hostname no longer returns OpenClaw cert.

**Path C (minimum, last resort): hide OpenClaw hostname from public DNS.**
- Remove A record pointing OpenClaw hostname to VPS IP.
- Access OpenClaw only through an authenticated private path. Current implementation uses an SSH local-forward to the VPS loopback upstream, so OpenClaw has no public DNS record and no public Caddy certificate.
- Limitation: this is operator-only access, not a shared LAN URL. That is intentional for the current risk posture.

**Do NOT attempt to fix by changing mTLS client-cert behavior** — the mere presence of a different cert on the same IP is the giveaway, regardless of auth.

### Fix (Path A — recommended)

1. In VPS console: create a Floating IP, assign to the current CX23 server.
2. Note the new IP, call it `OPENCLAW_IP`.
3. Update OpenClaw DNS A record to `OPENCLAW_IP` (remove the record pointing to `<vps-ip>`).
4. Bind OpenClaw's Caddy block to `OPENCLAW_IP` only. Edit `ansible/roles/caddy_l4/templates/SystemCaddyfile.j2`:
   - Replace `<openclaw-host> {` with `<openclaw-host>:443 {` and add `bind OPENCLAW_IP` inside the block.
   - Keep the Reality L4 block listening on `:443` (all interfaces) or explicitly bind to `<vps-ip>`.
5. Re-deploy:
   ```
   cd ansible
   ansible-playbook playbooks/10-stealth-vps.yml --tags caddy_l4
   ```

### Verification

1. DNS probe:
   ```
   dig +short <openclaw-host>          # expect: OPENCLAW_IP
   dig -x <vps-ip> +short       # expect: generic VPS reverse, no openclaw
   ```

2. SNI probe against `<vps-ip>` with OpenClaw SNI:
   ```
   curl -sk --resolve <openclaw-host>:443:<vps-ip> --max-time 5 \
        -I https://<openclaw-host>/  -o /dev/null -w "%{ssl_verify_result} %{http_code}\n"
   ```
   Expect: TLS handshake fails OR returns a default/Reality-fallback cert (NOT OpenClaw cert). Inspect cert:
   ```
   echo | openssl s_client -connect <vps-ip>:443 -servername <openclaw-host> 2>/dev/null \
     | openssl x509 -noout -subject -issuer -ext subjectAltName
   ```
   Expect: cert SAN does NOT include `<openclaw-host>`.

3. Reality side still works:
   ```
   curl -sk --resolve gateway.icloud.com:443:<vps-ip> --max-time 5 \
        -I https://gateway.icloud.com/ -o /dev/null -w "%{http_code}\n"
   ```
   Expect: 200/301/400/403 (real iCloud-fallback response; Apple gateway commonly returns 400 to a bare request).

4. OpenClaw still works via its new IP:
   ```
   curl --resolve <openclaw-host>:443:OPENCLAW_IP -I https://<openclaw-host>/
   ```

### Rollback

Revert SystemCaddyfile.j2 `bind` directive removal, re-deploy. Release floating IP in VPS (it stops billing).

### Estimated effort
1–2 hours (depends on whether VPS floating IP can be applied without downtime; usually instant).

### If Path A is refused (paths B or C)

**Path B (Cloudflare front):**
1. Sign up for Cloudflare, add the OpenClaw domain, enable orange-cloud on its A record.
2. On VPS, install `cloudflared`: `sudo apt install cloudflared` + tunnel auth + `cloudflared tunnel create openclaw`.
3. Bind OpenClaw's Caddy block to `127.0.0.1:<xray-local-port>` (not public `:443`).
4. Point cloudflared tunnel at `http://127.0.0.1:<xray-local-port>` for the OpenClaw hostname.
5. Same verification as Path A, except dig of OpenClaw domain returns Cloudflare IP.

**Path C (DNS hiding):**
1. Stop using the public `sslip.io` hostname.
2. Use private hostname `openclaw.home.arpa`.
3. Do not publish OpenClaw through Caddy on public `:443`.
4. Access OpenClaw via SSH local-forward to the loopback upstream:
   ```bash
   ssh -N -L <private-forward-port>:127.0.0.1:<private-forward-port> \
     -o ProxyCommand='ssh admin@192.168.50.1 nc -w 120 %h %p' \
     deploy@<vps-ip>
   ```
5. Open `http://127.0.0.1:<private-forward-port>/` locally.

Verification: `dig +short openclaw.home.arpa @1.1.1.1` returns nothing; old public `sslip.io` SNI no longer returns the OpenClaw certificate; `curl -I http://127.0.0.1:<private-forward-port>/` returns `HTTP/1.1 200 OK` while the SSH tunnel is open.

Current production implementation uses Path C with SSH-only access. Caddy public `:443` keeps only a generic fallback site so the listener exists; OpenClaw is not published through public Caddy and is reached only through `ssh -L <private-forward-port>:127.0.0.1:<private-forward-port>`.

---

# P1 — High priority (within 1–2 weeks)

## 2.1 Switch SNI from `www.microsoft.com` to `gateway.icloud.com`

### Problem
`www.microsoft.com` is acceptable but not optimal for RU DPI profile in 2025-2026. Microsoft O365/Teams sees selective throttling in RU, making persistent 24/7 traffic to `microsoft.com` a statistical anomaly for a home user. Additionally, 24/7 TCP persistence matches iCloud sync's native traffic profile but does NOT match Microsoft's native (bursty web/O365) profile — this is a duration-fingerprint signal.

### Why it matters
Dual benefit: (a) RU DPI throttling exposure drops; (b) long-lived TCP to `gateway.icloud.com` is indistinguishable from every iPhone's normal iCloud background sync behavior. Blending is better per-packet AND per-statistics.

Recommendation: use `gateway.icloud.com` as the primary replacement for Microsoft. It is the only candidate in the documented pool whose cover-traffic pattern, persistent long-lived iCloud sync, directly matches Reality's persistent TCP profile, so it addresses both SNI selection and duration fingerprinting. If validation fails, use `www.cloudflare.com` as the conservative fallback (safe but burstier), then `player.vimeo.com` as the long-flow fallback with less Apple-like ambient noise.

### Scope
- `ansible/secrets/stealth.yml` (vault): `reality_dest`, `reality_server_names`.
- `ansible/roles/caddy_l4/templates/Caddyfile.j2` (via vault variable).
- `ansible/roles/caddy_l4/templates/SystemCaddyfile.j2`: L4 SNI matcher and fallback site on `:443`.
- `ansible/roles/xray_reality/tasks/main.yml`: synchronizes existing 3x-ui Reality inbound `realitySettings.dest` and `serverNames`.
- All 8 client profiles regenerated.

### Fix

Exact procedure is already documented in [modules/reality-sni-rotation/docs/sni-rotation-candidates.md §4](/modules/reality-sni-rotation/docs/sni-rotation-candidates.md). Summary of the switch:

1. Pre-flight validate the candidate:
   ```
   ssh deploy@<vps-ip> '/tmp/validate-sni-candidate.sh gateway.icloud.com'
   ```
   Abort if any `[FAIL]` line. Follow the script in §3 of modules/reality-sni-rotation/docs/sni-rotation-candidates.md — copy it to the VPS first if not already there.

2. Backup current client QR bundle:
   ```
   cd ansible
   mkdir -p out/clients-backup-$(date +%Y%m%d-%H%M)
   cp out/clients/*.png out/clients-backup-$(date +%Y%m%d-%H%M)/
   ```

3. Edit vault:
   ```
   ansible-vault edit secrets/stealth.yml
   # change:
   #   reality_dest: "gateway.icloud.com:443"
   #   reality_server_names:
   #     - "gateway.icloud.com"
   ```

4. Apply VPS and router:
   ```
   ansible-playbook playbooks/10-stealth-vps.yml
   ansible-playbook playbooks/30-generate-client-profiles.yml
   ansible-playbook playbooks/20-stealth-router.yml
   ansible-playbook playbooks/99-verify.yml
   ```

5. Confirm the existing Xray/3x-ui inbound was updated too. Vault and QR changes alone are insufficient:
   ```bash
   sqlite3 /opt/stealth/xray/db/x-ui.db \
     "select stream_settings from inbounds where remark='stealth-reality';"
   ```
   Expect `gateway.icloud.com:443` and `["gateway.icloud.com"]` in `realitySettings`. If it still shows `www.microsoft.com`, run `ansible/roles/xray_reality/tasks/main.yml` sync logic or update the DB and restart `xray`.

6. Ensure Caddy has an HTTP fallback site on `:443`. The layer4 `listener_wrappers` block configures routing, but Caddy still needs a site to create the public listener. Current fallback:
   ```caddyfile
   :443 {
       tls internal
       respond 404
   }
   ```
   Reality SNI is intercepted before the HTTP app handles this fallback.

7. Redistribute 7 new QRs to external clients (router profile auto-applied in step 4).

8. Append entry to decision log (see modules/reality-sni-rotation/docs/sni-rotation-candidates.md §8).

### Verification

Included in `playbooks/99-verify.yml` and the post-switch §7 of modules/reality-sni-rotation/docs/sni-rotation-candidates.md. Specifically:
- VPS: `curl -k --resolve gateway.icloud.com:443:<vps-ip> https://gateway.icloud.com/` returns iCloud-fallback cert and a plausible Apple response, commonly HTTP 400 for a bare request.
- Router: `echo | nc -w 3 <vps-ip> 443` returns `rc=0`.
- Router: `tail -F /opt/var/log/sing-box.log` shows handshake success.
- Router: logs do not contain `connection refused` to `<vps-ip>:443`.
- Router: logs do not contain `x509: certificate is valid for ... microsoft.com, not gateway.icloud.com`.
- LAN: test domain in STEALTH_DOMAINS still exits via VPS IP.

### Rollback

Follow modules/reality-sni-rotation/docs/sni-rotation-candidates.md §5. Restore vault to `www.microsoft.com`, re-deploy, redistribute the backup QR bundle. ~5 min.

### Estimated effort
45 min including client redistribution.

---

## 2.2 Route dnscrypt-proxy DoH traffic **through** the stealth tunnel

### Problem
dnscrypt-proxy on the router (`127.0.0.1:<dnscrypt-port>`) sends DoH queries to `cloudflare-dns.com`, `quad9-dns.com`, etc. over port `443/TCP` from the router WAN interface directly — outside the stealth channel. The ISP sees:

- Constant outbound TCP/443 to 1.1.1.1 / 9.9.9.9 / dns.nextdns.io → "this home is using DoH".

Average Russian household does NOT use DoH. This alone is a classifier flag: "this customer has privacy tooling, likely VPN too". Combined with the P0/P1 signals, it accelerates detection.

### Why it matters
Removes one of the cheapest classification signals available to ISP (no DPI needed — just destination IP of DNS).

### Scope
- `ansible/roles/singbox_client/templates/config.json.j2` — add a SOCKS5 inbound.
- `ansible/roles/dnscrypt_proxy/templates/dnscrypt-proxy.toml.j2` — add a proxy directive.

### Fix

1. **Add a SOCKS5 inbound to sing-box** (localhost only, separate from the existing redirect inbound):

   Edit `ansible/roles/singbox_client/templates/config.json.j2`. Inside `"inbounds": [ ... ]`:
   ```json
   ,
   {
     "type": "socks",
     "tag": "socks-in",
     "listen": "127.0.0.1",
     "listen_port": <router-socks-port>,
     "sniff": true,
     "domain_strategy": "prefer_ipv4"
   }
   ```
   And ensure the existing `route.rules` still directs `reality-out` for everything (or explicitly for `inbound: socks-in`). Add rule:
   ```json
   { "inbound": "socks-in", "outbound": "reality-out" }
   ```

2. **Tell dnscrypt-proxy to use that SOCKS5**:

   Edit `ansible/roles/dnscrypt_proxy/templates/dnscrypt-proxy.toml.j2`, add near the top:
   ```toml
   proxy = "socks5://127.0.0.1:<router-socks-port>"
   ```

3. Re-apply:
   ```
   cd ansible
   ansible-playbook playbooks/20-stealth-router.yml
   ```

### Verification

1. On router:
   ```
   # sing-box SOCKS5 listening
   ss -tln state listening '( sport = :<router-socks-port> )' | grep -q 127.0.0.1 && echo OK

   # dnscrypt-proxy has proxy config active
   grep '^proxy' /opt/etc/dnscrypt-proxy/dnscrypt-proxy.toml
   ```

2. On router, packet-capture DoH query:
   ```
   tcpdump -nn -i wan0 'host 1.1.1.1 or host 9.9.9.9' &
   dig @127.0.0.1 -p <dnscrypt-port> example.com
   # expect: NOTHING captured on wan0 to 1.1.1.1/9.9.9.9
   ```

3. Capture stealth tunnel traffic instead:
   ```
   tcpdump -nn -i wan0 'host <vps-ip> and port 443'
   dig @127.0.0.1 -p <dnscrypt-port> example.com
   # expect: packets to VPS during the query
   ```

4. Functional:
   ```
   dig @127.0.0.1 -p <dnscrypt-port> example.com +short    # expect: valid IP answer
   dig example.com +short                        # also valid via dnsmasq → dnscrypt
   ```

### Rollback

Remove SOCKS5 inbound from sing-box config, remove `proxy = ` from dnscrypt-proxy.toml, re-apply. DNS reverts to direct DoH within seconds.

### Estimated effort
45 min (including packet-capture verification).

---

## 2.3 TCP keepalive and flow-duration tuning on sing-box outbound

### Problem
Default sing-box VLESS+Reality outbound maintains one long-lived TCP session per active client device. With `xtls-rprx-vision`, no mux. The resulting traffic pattern to VPS IP is: 1 persistent TCP connection per LAN device, never-idle. Over NetFlow, this is distinguishable from natural user traffic which is bursty and short-lived.

Note: switching SNI to `gateway.icloud.com` (§2.1) largely mitigates the statistical side of this because iCloud sync has the same long-flow profile. But tuning keepalive still reduces variance and helps.

### Why it matters
Reduce the statistical "one massive long connection to single foreign IP" signal. Add artificial connection turnover so flows look more bursty.

### Scope
- `ansible/roles/singbox_client/templates/config.json.j2`

### Fix

Add TCP keepalive and `multiplex: { enabled: false }` explicit to the VLESS outbound. If `xtls-rprx-vision` is used, also set `tcp_fast_open: false` and shorter idle timeout (at transport/dialer level):

```json
{
  "type": "vless",
  "tag": "reality-out",
  "server": "{{ vps_ssh_host }}",
  "server_port": 443,
  "uuid": "...",
  "flow": "xtls-rprx-vision",
  "packet_encoding": "xudp",
  "tcp_fast_open": false,
  "tls": { ... },
  "multiplex": {
    "enabled": false
  }
}
```

Additionally, add a global transport-idle clean-up via `route.default_interface_monitor` or `experimental.idle_timeout` if sing-box version supports (≥1.9). Check `sing-box version` and adapt.

Practical minimum (portable): set `tcp_fast_open: false` — prevents TFO fingerprint differences (TFO cookies are themselves a fingerprint vector).

### Verification

1. Restart sing-box, verify config accepted: `tail -50 /opt/var/log/sing-box.log` has no error.
2. On router, over 10 minutes, observe connection count to VPS:
   ```
   for i in 1 2 3 4 5; do
     echo "=== $(date +%H:%M:%S) ==="
     ss -tn state established '( dport = :443 )' dst <vps-ip>
     sleep 120
   done
   ```
   Expect: modest fluctuation in connection count, not a single frozen session over 10 min (assuming active LAN traffic).

### Rollback

Remove the added directives, restart sing-box.

### Estimated effort
30 min.

---

## 2.4 sing-box liveness watchdog

### Problem
`/opt/etc/init.d/S99singbox` restarts a crashed process, but a hung process (not crashed, not responding) will silently break Channel A for LAN clients until a human notices. Fail-closed behavior means connections time out, but there is no alert.

### Why it matters
Operational reliability. Not a stealth issue per se, but a long outage degrades trust; users may switch back to plain WAN or disable VPN on their iPhones to "fix" slow internet, exposing themselves.

### Scope
- New script: `/jffs/scripts/singbox-watchdog.sh` (deployed by `singbox_client` role).
- `ansible/roles/singbox_client/tasks/main.yml` — add cron entry.

### Fix

1. Create `ansible/roles/singbox_client/templates/singbox-watchdog.sh.j2`:
   ```sh
   #!/bin/sh
   # Liveness check for sing-box: TCP-probe the redirect inbound port.
   # If not reachable for 3 consecutive checks, restart.

   PORT=<lan-redirect-port>
   STATE_FILE=/opt/tmp/singbox-watchdog.state
   mkdir -p "$(dirname $STATE_FILE)"

   if timeout 3 /opt/bin/nc -z 127.0.0.1 $PORT 2>/dev/null; then
     echo 0 > "$STATE_FILE"
     exit 0
   fi

   FAIL=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
   FAIL=$((FAIL + 1))
   echo $FAIL > "$STATE_FILE"

   if [ "$FAIL" -ge 3 ]; then
     logger -t singbox-watchdog "sing-box :$PORT unresponsive ($FAIL checks); restarting"
     /opt/etc/init.d/S99singbox restart
     echo 0 > "$STATE_FILE"
   fi
   ```

2. In `ansible/roles/singbox_client/tasks/main.yml`, add:
   ```yaml
   - name: Install sing-box watchdog
     ansible.builtin.template:
       src: singbox-watchdog.sh.j2
       dest: /jffs/scripts/singbox-watchdog.sh
       mode: "0755"

   - name: Add cron entry for watchdog (every 60s)
     ansible.builtin.raw: |
       CRON=/opt/etc/crontabs/root
       touch $CRON
       grep -q singbox-watchdog $CRON || \
         echo '* * * * * /jffs/scripts/singbox-watchdog.sh' >> $CRON
       /opt/etc/init.d/S10cron restart || true
   ```

3. Ensure `nc` (netcat) available: Entware `opkg install netcat`. If router already has `nc` from busybox, use `/bin/nc` instead of `/opt/bin/nc`.

### Verification

1. Deploy and confirm cron entry:
   ```
   ssh "$ROUTER_SSH" 'crontab -l | grep singbox-watchdog'
   ```

2. Simulate hang: `kill -STOP <singbox-pid>`. Wait 3 minutes. Watchdog should `SIGCONT` → actually no, it calls `restart`, which will try to stop+start. Confirm new PID:
   ```
   ssh "$ROUTER_SSH" 'ps | grep sing-box'
   ```

3. Check log:
   ```
   ssh "$ROUTER_SSH" 'logread | grep singbox-watchdog | tail -10'
   ```

### Rollback

Remove cron entry and the watchdog script. No other state.

### Estimated effort
45 min.

---

## 2.5 `domain-auto-add.sh` — default-skip when blocklist missing

### Problem
Per the review, `modules/dns-catalog-intelligence/router/domain-auto-add.sh` falls back to "add every observed domain to both VPN_DOMAINS and STEALTH_DOMAINS" when `blocked-domains.lst` is missing or outdated. This pollutes STEALTH_DOMAINS with non-sensitive domains, inflating traffic through the stealth channel and degrading the duration-fingerprint story.

### Why it matters
Smaller, curated STEALTH_DOMAINS = less bandwidth through VPS = closer to legitimate iCloud cover profile. Larger, polluted set = more bandwidth anomaly + more domains for the ISP to potentially correlate against their own block lists.

### Scope
- `modules/dns-catalog-intelligence/router/domain-auto-add.sh`
- Possibly `modules/dns-catalog-intelligence/docs/domain-management.md` if it describes behavior.

### Fix

Find the branch in `modules/dns-catalog-intelligence/router/domain-auto-add.sh` that adds to ipsets when `blocked-domains.lst` does not exist or is empty. Change the logic:

```sh
# BEFORE (simplified): if blocklist missing, add all observed domains
# AFTER: if blocklist missing, skip adding and log a warning

BLOCKLIST="/jffs/addons/router_configuration/blocked-domains.lst"

if [ ! -s "$BLOCKLIST" ]; then
  logger -t domain-auto-add "blocked-domains.lst missing or empty; SKIPPING auto-add of '$domain'"
  continue    # or: exit 0, depending on context in the script
fi

# Only add if domain is explicitly confirmed in blocklist
if ! grep -Fxq "$domain" "$BLOCKLIST"; then
  logger -t domain-auto-add "domain '$domain' not in blocklist; skipping"
  continue
fi
```

Adjust to the exact control flow of the existing script.

Also add a separate operator-facing command `modules/dns-catalog-intelligence/router/domain-force-add.sh <domain> <set>` that explicitly adds one domain, bypassing the blocklist check, for manual intervention — so there is a safe escape hatch.

### Verification

1. Back up current `configs/dnsmasq-stealth.conf.add`.
2. Move/rename `blocked-domains.lst` → `blocked-domains.lst.bak`.
3. Trigger `domain-auto-add.sh` manually or wait for its cron.
4. Confirm no new entries appeared in `configs/dnsmasq-stealth.conf.add`.
5. Check `logread | grep domain-auto-add` for the warning.
6. Restore `blocked-domains.lst`.

### Rollback

Revert the patch. Restore previous behavior.

### Estimated effort
45 min.

---

## 2.6 Document explicit design rationale + known residual risks

### Problem
Per the review of docs, the following decisions lack written rationale: UDP/443 REJECT→DROP (after fix §1.2, explain why DROP), SNI choice, REDIRECT vs TPROXY, no IPv6, exit IP is personal VPS, wgs1 still has WAN ingress. An operator/future-self reading the repo in 6 months cannot distinguish "deliberate trade-off" from "oversight" without this.

### Why it matters
Maintenance correctness. Prevents well-meaning "improvements" that regress stealth properties (e.g. someone re-enabling IPv6 "because it seems off" without understanding the bypass risk).

### Scope
- `docs/architecture.md` — add a "Design decisions" or "Trade-offs" section.
- `modules/routing-core/docs/stealth-channel-implementation-guide.md` §6 — extend acceptance checklist.
- `modules/routing-core/docs/stealth-channel-implementation-guide.md` §10 — extend non-goals list.

### Fix

Add to `docs/architecture.md`, a new section `## Design decisions` (or appended to existing "Known limitations"):

```markdown
## Design decisions and known residual risks

### Why UDP/443 dropped silently (not REJECTed)
REJECT emits ICMP port-unreachable; this is itself a behavioral fingerprint
(rare for home networks). DROP causes a ~300ms QUIC fallback delay on
the first connection, imperceptible in UX, but leaves no ICMP trace.

### Why SNI=gateway.icloud.com
See modules/reality-sni-rotation/docs/sni-rotation-candidates.md. Summary: iCloud sync's native traffic
is persistent long-lived TCP, matching Reality's flow profile exactly.
iPhone/Mac users in RU constantly hold such connections.

### Why REDIRECT (not TUN+fwmark)
Merlin routers historically have poor TUN interface persistence under
reconnect/reconfig events. REDIRECT via nat table is stable, idempotent,
and survives firewall-start re-entry.

### Why no IPv6
IPv4 stealth plane does not have an IPv6 twin (would require ip6tables
NAT + ip6tables filter + ipset inet6 + sing-box v6 inbound). Enabling
IPv6 without mirroring would leak all LAN v6 flows to ISP. The kill-switch
nails `ipv6_service=disabled` in NVRAM.

### Why exit IP is personal VPS (not shared pool)
Double-hop cascade was evaluated and deferred. A single VPS exit IP is
slightly identity-linkable to the VPS owner, but (a) it's not the home
IP, (b) the site-level identity story is already protected per-browser.
Upgrade path: add a second WG peer on VPS to cascade exit through a
commercial VPN. Not currently implemented.

### Why wgs1 keeps WAN ingress (still)
wgs1 provides inbound for remote family devices. Moving it off WAN ingress
requires either an overlay (Tailscale/Netbird-like) or a third VPS relay
inbound endpoint. Design in docs/remote-access-overlay-migration.md;
not yet executed.

### Residual risks
- Single VPS = single point of failure for Channel A. If VPS exit IP
  is RKN-blocked, stealth channel is down until failover (manual).
- Router OUTPUT chain not stealth-captured. NTP, firmware updates,
  dnscrypt-proxy upstream DoH would flow directly over WAN if §2.2 regresses.
- Reality active-probing fallback has a measurable latency sidechannel
  (~100-500ms additional handshake to real fallback target); detectable
  by sophisticated DPI only.
```

Add to `modules/routing-core/docs/stealth-channel-implementation-guide.md` §6 acceptance checklist:
```
- [ ] `nvram get ipv6_service` == `disabled` (channel-B IPv6 kill-switch)
- [ ] dig <openclaw-host> +short does NOT return <vps-ip> publicly
- [ ] `iptables -t filter -S FORWARD | grep dpt:443 | grep -q DROP` on router (no REJECT)
- [x] `netstat -nlp | grep 127.0.0.1:<router-socks-port>` on router shows sing-box SOCKS5 bound (DoH routing)
- [x] singbox-watchdog cron present: `cru l | grep singbox-watchdog`
- [x] `domain-auto-add.sh` default-skips when `blocked-domains.lst` is missing or empty
```

Add to `modules/routing-core/docs/stealth-channel-implementation-guide.md` §10 non-goals:
```
- IPv6 connectivity (killed by NVRAM)
- Shared-pool exit IP (requires cascade through commercial VPN on VPS)
- wgs1 WAN ingress removal (requires overlay migration)
- OpenClaw cohost on public `:443` (removed; access is SSH-only to loopback)
- Multi-VPS failover (single VPS host is SPOF)
```

### Verification
Linter-like check: every P0/P1 item above has its rationale captured somewhere in architecture.md, the acceptance checklist has the verification step, non-goals list matches reality.

### Rollback
Docs-only; rollback is git revert of the edits.

### Estimated effort
1–2 hours.

---

# P2 — Backlog / hardening

These items are valuable but not time-critical. Leave as tickets for future work.

## 3.1 Failure-modes runbook
New doc `modules/recovery-verification/docs/failure-modes.md`: what user sees when sing-box dies / Caddy L4 unloads / dnscrypt-proxy crashes / VPS unreachable; symptom → quick diagnosis → recovery. Populate from watchdog logic in §2.4 and existing `docs/troubleshooting.md`.

## 3.2 Disaster-recovery runbook
New doc `docs/disaster-recovery.md`: procedure for VPS-lost (restore from backup → rebuild stack → regenerate keys → redistribute), VPS-IP blocked (floating IP swap, DNS update), vault password lost (re-encrypt from memory or regenerate ALL secrets).

## 3.3 Key rotation procedure
New section or doc on Reality keypair rotation (every ~6 months, or after suspected compromise). Steps: regenerate server keypair in Xray, re-seed 3x-ui inbound, regenerate ALL 8 clients' pubkey reference, redistribute QRs. Downtime: ~10 min.

## 3.4 Client revocation workflow
`modules/client-profile-factory/docs/client-profiles.md` extension: remove one UUID from `clients[]` in vault, re-run `10-stealth-vps.yml` (which syncs Xray inbound). Add a helper `modules/client-profile-factory/bin/revoke-client.sh <name>`.

## 3.5 Monitoring/alerting hooks
Send `modules/ghostroute-health-monitor/bin/router-health-report` output hourly to a Telegram bot or similar. Alert thresholds: REDIRECT counter == 0 for > 1 hour -> warn; UDP DROP count > 10x redirect count -> warn; sing-box restart count > 3/day -> warn.

## 3.6 3x-ui admin binding hardening
Remove the `127.0.0.1:<xui-admin-port>:<xui-admin-port>` port mapping from `docker-compose.yml.j2`. Access panel via `docker exec -it xray wget -qO- http://127.0.0.1:<xui-admin-port>/...` or a Unix socket. Reduces attack surface on the VPS host.

## 3.7 WebRTC leak policy at endpoint
For iPhones with Amnezia/V2Box, iOS 16+ respects on-demand WebRTC handling inside the VPN tunnel. Validate: set up a STUN-echo server or use a public WebRTC IP-leak test (`https://browserleaks.com/webrtc`) while connected. If it leaks, document as a known client-side limitation and recommend disabling WebRTC in user browsers where possible.

---

# 4. Execution order (recommended sequence)

Estimated total effort for P0 + P1: ~6 hours across 2 sessions.

**Session 1 (P0 — same day):**
1. §1.1 IPv6 kill-switch — 30 min.
2. §1.2 UDP REJECT → DROP — 10 min.
3. §1.3 OpenClaw DNS audit + remediation (Path A/B/C per capability) — 1–2 h.
4. Run full `verify.sh` + `99-verify.yml`. Smoke-test from LAN and one external iPhone.

**Session 2 (P1 — within 1–2 weeks):**
5. §2.1 SNI switch to `gateway.icloud.com` — 45 min. Recommended primary SNI because iCloud's long-lived sync flow best matches Reality's persistent TCP profile; fallback order is `www.cloudflare.com`, then `player.vimeo.com`.
6. §2.2 DoH via stealth (SOCKS5) — 45 min.
7. §2.3 TCP keepalive tuning — 30 min.
8. §2.4 sing-box watchdog — 45 min.
9. §2.5 `domain-auto-add.sh` default-skip — 45 min.
10. §2.6 Docs updates — 1–2 h.
11. Full verify + LAN regression.

**P2 backlog:** schedule when convenient.

---

# 5. Cross-cutting verification after all P0 + P1 are applied

Run the full suite after the sequence:

```bash
cd router_configuration/ansible
ansible-playbook playbooks/99-verify.yml
cd ..
./verify.sh
./modules/ghostroute-health-monitor/bin/router-health-report
```

Then functional tests:

```bash
# Channel A sanity — LAN device
curl https://ifconfig.me     # expect: <vps-ip> (if ifconfig.me in STEALTH)
curl -6 https://ipv6.google.com  # expect: Network unreachable

# Channel A regression — wgs1 peer (from phone via wgs1)
# run through wgs1, visit a youtube URL; expect: works via wgc1 commercial VPN

# Remote mobile client via home QR
# from iPhone: import the regenerated home QR, toggle VPN, visit ifconfig.me.
# Expected client profile endpoint: home public IP or home DNS name on TCP/<home-reality-port>.
# Expected checker result: <vps-ip>, because the website sees the VPS exit.
# Expected mobile-carrier-visible endpoint: home Russian IP, not <vps-ip>.

# DPI sanity (if RU vantage available)
# tcpdump | tshark SNI extraction → gateway.icloud.com
# netstat on VPS → caddy on :443, xray on 127.0.0.1:<xray-local-port>

# Active probing defense
curl -k --resolve gateway.icloud.com:443:<vps-ip> -I https://gateway.icloud.com/
# expect: 200/301/400/403 (Apple's real fallback response)
```

If any of the above fails, pause before moving to the next P-level; pick up the failing item.

---

# 6. Universal rollback

All fixes are individually reversible (each fix has its own rollback). If the entire stealth channel breaks badly:

1. Disable Channel A entirely at the router (fail-open is NOT wanted here; we want fail-closed):
   ```
   ssh "$ROUTER_SSH" '
     ipset flush STEALTH_DOMAINS
     /opt/etc/init.d/S99singbox stop
     # Channel A traffic now fails-closed for STEALTH_DOMAINS
   '
   ```
   LAN devices: domains in STEALTH_DOMAINS go dark. Rest of internet (plain routes) still works. wgs1 + wgc1 unaffected.

2. On the VPS, keep Caddy + Xray running but stop seeding new inbounds:
   ```
   ssh deploy@<vps-ip> 'cd /opt/stealth && docker compose stop xray'
   ```
   Caddy keeps `:443` bound through the generic fallback site; Reality handshakes fail closed while non-Reality SNI gets the fallback behavior.

3. Revert individual config changes from git history, then selective re-apply:
   ```
   cd router_configuration
   git log -- ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2
   # find the pre-fix commit
   git checkout <commit>^ -- ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2
   ```

4. Nuclear: `git checkout <pre-review-branch>` and redeploy from scratch.

---

# 7. What this document does NOT cover

- **Implementation of specific Ansible module versions.** Assume current `community.docker`, `community.general.ufw`, `ansible.builtin` at latest. Pin if reproducibility matters.
- **The actual SNI rotation decision logic.** That lives in `modules/reality-sni-rotation/docs/sni-rotation-candidates.md`; this file only references §2.1.
- **How the review was conducted.** If you need the underlying findings log, see chat history in session where this document was produced.
- **Migration off wgc1 or wgs1.** Channel A is out of scope for this hardening pass.

---

# 8. Audit trail

| Date/time | Milestone | Evidence |
|---|---|---|
| 2026-04-25 14:00 | WireGuard runtime decommissioned | `wgs1_enable=0`, `wgc1_enable=0`, `wg show` empty, no `0x1000`/`RC_VPN_ROUTE` steady-state hooks |
| 2026-04-25 16:00 | Mobile Home Reality relay deployed | Router `sing-box` has `reality-in` on TCP/<home-reality-port> and normal mobile QR clients dial the home IP first |
| 2026-04-25 18:00 | Old mobile UUIDs removed from normal VPS path | VPS `clients[]` source of truth reduced to router identity; router-side `home_clients[]` kept separate |
| 2026-04-25 20:00 | WireGuard repo cleanup completed | Legacy `VPN_DOMAINS`, `wgs1/wgc1` hooks and stale docs/checks removed or marked historical |
| 2026-04-25 21:00 | Mobile traffic observability added | Mobile Home Reality byte counters and period reports added for TCP/<home-reality-port> ingress |
| 2026-04-25 22:00 | Emergency direct-VPS fallback made explicit | `emergency_clients[]` documented as disabled/off fallback for rare home relay outages |
| 2026-04-25 23:00 | LTE performance hardening applied | Commits `afaa912`, `0bec8c5`, `feb8fd2`, `3a71207`: MSS 1360 clamp, TCP sysctl tuning, connlimit 300, and performance runbook |

---

# Appendix A: file/line references for reviewer context

Primary files touched (or should be touched) by the fixes:

| Fix | File | Notes |
|---|---|---|
| §1.1 | `ansible/roles/ipv6_kill/**` (new), `ansible/playbooks/20-stealth-router.yml`, `verify.sh`, `modules/routing-core/docs/stealth-channel-implementation-guide.md` | Kill-switch via NVRAM |
| §1.2 | `ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2` | REJECT → DROP |
| §1.3 | `ansible/roles/caddy_l4/templates/SystemCaddyfile.j2`, `modules/routing-core/docs/stealth-channel-implementation-guide.md` | Remove OpenClaw from public Caddy; SSH-only loopback access |
| §2.1 | `ansible/secrets/stealth.yml`, `ansible/roles/xray_reality/tasks/main.yml`, `ansible/roles/caddy_l4/templates/SystemCaddyfile.j2`, `modules/reality-sni-rotation/docs/sni-rotation-candidates.md` | SNI switch and existing Xray inbound sync |
| §2.2 | `ansible/roles/singbox_client/templates/config.json.j2`, `ansible/roles/dnscrypt_proxy/templates/dnscrypt-proxy.toml.j2` | DoH over stealth |
| §2.3 | `ansible/roles/singbox_client/templates/config.json.j2` | TCP keepalive |
| §2.4 | `ansible/roles/singbox_client/templates/singbox-watchdog.sh.j2` (new), `ansible/roles/singbox_client/tasks/main.yml` | Watchdog |
| §2.5 | `modules/dns-catalog-intelligence/router/domain-auto-add.sh`, optional new `modules/dns-catalog-intelligence/router/domain-force-add.sh` | Default-skip |
| §2.6 | `docs/architecture.md`, `modules/routing-core/docs/stealth-channel-implementation-guide.md` | Design rationale |

---

# Appendix B: summary table

| # | Title | Prio | Est | Files | Requires redeploy |
|---|---|---|---|---|---|
| 1.1 | IPv6 kill-switch | P0 | 30 min | router | Router playbook |
| 1.2 | UDP REJECT → DROP | P0 | 10 min | router | Router playbook |
| 1.3 | OpenClaw off public Caddy | P0 | 1–2 h | VPS + docs | VPS playbook / SSH-only access |
| 2.1 | SNI switch to gateway.icloud.com | P1 | 45 min | VPS + router | Both playbooks + QR redistribute |
| 2.2 | DoH routed via stealth | P1 | 45 min | router | Router playbook |
| 2.3 | TCP keepalive tuning | P1 | 30 min | router | Router playbook |
| 2.4 | sing-box watchdog | P1 | 45 min | router | Router playbook |
| 2.5 | domain-auto-add default-skip | P1 | 45 min | router | Direct edit, no playbook |
| 2.6 | Docs — design rationale | P1 | 1–2 h | docs | None |
| 3.1–3.7 | Backlog items | P2 | varies | various | varies |
