# Mobile LTE Billing Mitigation — Home Router as Reality Ingress Relay

**Audience:** LLM agent or engineer implementing the home-router-as-relay architecture (Variant B from the security review of 2026-04-25).
**Goal:** mobile (LTE) clients enter the stealth tunnel via home router's public RU IP instead of connecting directly to VPS. This makes LTE traffic appear domestic to the carrier (avoiding international-traffic billing) while preserving Reality stealth and VPS exit-IP for site privacy.
**Status:** implemented on 2026-04-25, then refined so Home Reality ingress uses
the same managed split as LAN routing. This guide remains the implementation
history for Variant B; the current canonical flow is
`docs/network-flow-and-observer-model.md`.
**Hard precondition:** Channel A decommission per `docs/channel-a-decommission-implementation-guide.md` is **scheduled to complete today (2026-04-25)**. This plan starts AFTER that decommission lands. The new Reality ingress on the home router replaces the security niche that wgs1 used to occupy, but on a completely different protocol/port and with stealth properties wgs1 lacked.

This document is self-contained.

---

## §0. Context

### 0.1 Why this plan exists

After the security review of 2026-04-25, mobile clients (6 iPhones + 1 MacBook with Reality QR profiles pointed directly at VPS) were identified as exposed to a new RU regulatory surface: **LTE carrier billing of international traffic**. Carriers classify by destination IP (GeoIP / AS / routing path); Reality cover SNI does not influence this classification because billing engines look at L3/L4 metadata, not L7 TLS contents.

Variant B was chosen: the home router becomes a Reality ingress relay. Mobile clients connect to `home_public_IP:<port>`, which from the carrier's perspective is RU domestic traffic. The home router decrypts the inbound Reality TLS and re-encrypts the inner traffic onto the existing Reality outbound to VPS.

### 0.2 What changes vs. current state

```
BEFORE (current):
  iPhone (LTE) ──Reality─► 198.51.100.10 (VPS) ─► Internet
                          ↑
                          LTE carrier sees DE destination → international billing

AFTER (this plan):
  iPhone (LTE) ──Reality─► home_public_IP:<home-reality-port> (RU) 
                          ↑
                          LTE carrier sees RU destination → domestic billing
                          │
                  [Home router RT-AX88U Pro, sing-box]
                  ├─ Reality INBOUND (decrypts mobile traffic)
                  ├─ managed route: reality-in → reality-out ─► VPS
                  └─ non-managed route: reality-in → direct-out ─► home WAN
```

### 0.3 What this plan does NOT solve

- **AS-mismatch** (Apple SNI + VPS AS) — same residual risk as before. Both legs (mobile → home, home → VPS) carry that mismatch within their respective TLS streams. Out of scope.
- **Single-VPS SPOF** — still one VPS. Out of scope.
- **Home IP exposure** — adding inbound Reality on home router IS a new attack surface. See §1.4 risks.
- **CGNAT** — assumed not present (user confirmed public IP at home).

### 0.4 Coexistence with Channel A decommission (today)

Channel A decommission removes wgs1 (inbound WG on WAN). This plan adds Reality inbound on a **different protocol, different port**. They do not overlap technically; do not start this plan until decommission is complete. Specifically:

- This plan starts **after** wgs1 NVRAM is `wgs1_enable=0` and firewall hooks are gone.
- Choose an inbound port that is NOT the old wgs1 port (avoid reusing a port that was previously WG-fingerprinted by RKN scans).
- After this plan: home IP exposes **one** TLS-on-non-standard-port service. Less suspicious than WG, but still a distinct fingerprint vs. typical residential IP.

---

## §1. Architecture

### 1.1 Two-tier Reality

Reality1 (mobile ↔ home router):
- TLS 1.3 + Reality auth using **router-local** keypair and per-client UUIDs.
- SNI = `gateway.icloud.com` (consistent with outbound for traffic-volume blending).
- Listening on `home_public_IP:<INGRESS_PORT>` (default suggestion: `<home-reality-port>`).
- Reality fallback target: `gateway.icloud.com:443` so that active probing of the home IP returns real Apple cert and response (router proxies the probe via its own outbound HTTPS).

Reality2 (home router ↔ VPS) — already exists:
- Existing sing-box outbound, unchanged. Single router-identity UUID at VPS Xray.

### 1.2 Sing-box single-process configuration

Both inbounds and the existing outbound live in one sing-box process on the
router. The original draft sent Reality-inbound traffic directly to
Reality-outbound. The implemented production refinement uses sing-box rule-sets:
`reality-in` managed destinations use `reality-out`, while non-managed
destinations use `direct-out`. LAN traffic continues using the existing redirect
inbound (`:<lan-redirect-port>`) -> REDIRECT -> reality-out path unchanged.

Outline of the merged config (excerpt — full template in §3):

```jsonc
{
  "inbounds": [
    {
      "type": "redirect",
      "tag": "redirect-in",
      "listen": "0.0.0.0:{{ singbox_redirect_port }}"
    },
    {
      "type": "vless",
      "tag": "reality-in",
      "listen": "0.0.0.0:{{ home_reality_ingress_port }}",
      "users": [
        { "name": "iphone-1", "uuid": "{{ home_clients[0].uuid }}", "flow": "xtls-rprx-vision" },
        // ... iphone-2..6, macbook
      ],
      "tls": {
        "enabled": true,
        "server_name": "{{ home_reality_server_names[0] }}",
        "reality": {
          "enabled": true,
          "handshake": {
            "server": "{{ home_reality_dest_host }}",
            "server_port": 443
          },
          "private_key": "{{ home_reality_server_private_key }}",
          "short_id": "{{ home_reality_server_short_ids }}"
        }
      }
    }
  ],
  "outbounds": [
    {
      "type": "vless",
      "tag": "reality-out",
      // ... existing VPS Reality client config (unchanged)
    },
    { "type": "direct", "tag": "direct-out" }
  ],
  "route": {
    "rule_set": [
      { "tag": "stealth-domains", "type": "local", "format": "source", "path": "/opt/etc/sing-box/rulesets/stealth-domains.json" },
      { "tag": "stealth-static", "type": "local", "format": "source", "path": "/opt/etc/sing-box/rulesets/stealth-static.json" }
    ],
    "rules": [
      { "inbound": "redirect-in", "outbound": "reality-out" },
      { "inbound": "reality-in", "rule_set": ["stealth-domains", "stealth-static"], "outbound": "reality-out" },
      { "inbound": "reality-in", "outbound": "direct-out" }
    ],
    "final": "direct-out"
  }
}
```

### 1.3 Identity model

Two separate Reality identity domains:

| Identity | Used at | Created in this plan? |
|----------|---------|------------------------|
| VPS-side keypair + 1 UUID (router) | Router → VPS outbound | No, exists today |
| VPS-side UUIDs for 6 iPhone + 1 MacBook | Direct mobile-to-VPS Reality | No — they exist today, will be **revoked** in Phase 6 |
| Router-side keypair (NEW) | Mobile → router inbound | **Yes (Phase 1)** |
| Router-side per-client UUIDs (7 NEW: 6 iPhone + 1 MacBook) | Mobile → router inbound auth | **Yes (Phase 1)** |

After this plan: VPS Xray inbound has exactly one allowed client (the router). Mobile devices have their per-client identity at the router level.

### 1.4 Risks introduced by Variant B

| Risk | Severity | Mitigation in this plan |
|------|----------|-------------------------|
| Inbound TLS service on residential IP — atypical | Medium | Non-standard port (<home-reality-port>), Reality active-probing fallback to real Apple |
| CPU overhead on RT-AX88U Pro from second Reality cycle | Medium | sing-box single-process, kernel route directly inbound→outbound, no iptables REDIRECT for mobile traffic; benchmark in Phase 7 |
| Old wgs1-port-scan history on home IP | Low | Use <home-reality-port> (different from old wgs1 port) |
| Home IP becomes single-point-of-failure for mobile clients | Medium | Document rollback profile; mobile QR could include backup `next_endpoint` if app supports |
| Mobile traffic exits via VPS — sites still see VPS IP | Same as today | n/a |

### 1.5 What ISP / RKN / LTE carrier sees after this plan

| Observer | Sees | Conclusion |
|----------|------|------------|
| LTE mobile carrier | mobile_IP → home_public_IP:<home-reality-port> (TLS, SNI=gateway.icloud.com) | RU domestic. Domestic billing. |
| Home ISP (inbound side) | mobile_IP → home_public_IP:<home-reality-port> (TLS) | Residential IP serves a TLS service on non-standard port. Slightly unusual but not VPN-fingerprintable. |
| Home ISP (outbound side, unchanged) | home_router → 198.51.100.10:443 (TLS, SNI=gateway.icloud.com) | Same as today; passes Channel B stealth. |
| RKN passive DPI (national scale) | All of above | No WG signatures (Channel A decommissioned). Detection profile = ~10% (residual AS-mismatch + duration fingerprint, unchanged). |

---

## §2. Preconditions

Before Phase 1, all of the following MUST be true:

1. **Channel A fully decommissioned today (2026-04-25):**
   - `nvram get wgs1_enable` returns `0`
   - `nvram get wgc1_enable` returns `0`
   - `iptables -t mangle -S` shows no `0x1000` marks
   - `wg show wgs1 wgc1` returns "No such device" or empty
   - Phase 6 cleanup is OK to be incomplete at the time of starting this plan (the script work and doc updates can run in parallel), but runtime decommission MUST be complete.

2. **Home public IP is real, static-ish, not behind CGNAT:**
   ```bash
   ssh admin@<router> 'WAN_IF=$(nvram get wan0_ifname); ip -4 addr show $WAN_IF | grep inet'
   # Cross-check with external view:
   curl ifconfig.me  # from any LAN client; should match the WAN address above
   ```
   If they differ → CGNAT. This plan does not work; abort and use Variant A (RU TCP-forwarder VPS) instead.

3. **All P0/P1 hardening fixes already applied** (verified in prior review):
   - IPv6 kill-switch active
   - UDP/443 DROP rule
   - sing-box watchdog cron
   - DoH via SOCKS5
   - SNI = `gateway.icloud.com`

4. **Reality channel B uptime ≥ 7 days** without sing-box restarts/errors.

5. **Git baseline tagged:**
   ```bash
   cd router_configuration
   git tag pre-mobile-relay-$(date +%F)
   ```

6. **Backup of existing mobile QRs:**
   ```bash
   mkdir -p ansible/out/clients-backup-pre-mobile-relay-$(date +%F)
   cp ansible/out/clients/{iphone-*,macbook}.png \
      ansible/out/clients-backup-pre-mobile-relay-$(date +%F)/
   ```

---

## §3. Implementation phases

### Phase 1 — Generate router-side Reality keypair and per-client UUIDs

**Goal:** create the cryptographic identity for the home-router Reality inbound. Distinct from VPS identity.

#### Step 1.1 — Generate keypair

On the VPS VPS (it has Xray binary; alternatively, install `xray-core` locally on control machine):
```bash
ssh deploy@198.51.100.10 'docker exec xray /app/bin/xray-linux-amd64 x25519'
# Output:
#   Private key: <BASE64-32B>
#   Public key:  <BASE64-32B>
```

Save **both** values for the next step.

#### Step 1.2 — Generate 8 short_ids and 7 client UUIDs

```bash
# 8 short_ids (8 hex chars each)
for i in $(seq 1 8); do openssl rand -hex 8; done

# 7 UUIDs (one per mobile client)
for i in $(seq 1 7); do python3 -c "import uuid; print(uuid.uuid4())"; done
```

Save:
- 8 short_id strings → `home_reality_server_short_ids` (vault).
- 7 UUIDs → `home_clients[].uuid` for: `iphone-1`, `iphone-2`, ..., `iphone-6`, `macbook`.

#### Step 1.3 — Choose ingress port

Default recommendation: `<home-reality-port>`. Avoid:
- old wgs1 port (whatever was in NVRAM before today)
- 22, 80, 443, 8080, 8443
- common scan-targeted ports (1194, 51820, 1080, etc.)

Save `home_reality_ingress_port: <home-reality-port>` in vault.

#### Step 1.4 — Update vault

```bash
cd router_configuration/ansible
ansible-vault edit secrets/stealth.yml
```

Add to vault:
```yaml
# Mobile relay — home router Reality ingress
home_reality_ingress_port: <home-reality-port>
home_reality_dest_host: "gateway.icloud.com"
home_reality_dest_port: 443
home_reality_server_names:
  - "gateway.icloud.com"
home_reality_server_private_key: "<BASE64 from Step 1.1>"
home_reality_server_public_key: "<BASE64 from Step 1.1>"
home_reality_server_short_ids:
  - "<sid-1>"
  - "<sid-2>"
  - "<sid-3>"
  - "<sid-4>"
  - "<sid-5>"
  - "<sid-6>"
  - "<sid-7>"
  - "<sid-8>"

# Per-client identities for home Reality inbound (DIFFERENT from VPS clients[])
home_clients:
  - name: "iphone-1"
    uuid: "<uuid-1>"
    short_id: "<sid-1>"
  - name: "iphone-2"
    uuid: "<uuid-2>"
    short_id: "<sid-2>"
  - name: "iphone-3"
    uuid: "<uuid-3>"
    short_id: "<sid-3>"
  - name: "iphone-4"
    uuid: "<uuid-4>"
    short_id: "<sid-4>"
  - name: "iphone-5"
    uuid: "<uuid-5>"
    short_id: "<sid-5>"
  - name: "iphone-6"
    uuid: "<uuid-6>"
    short_id: "<sid-6>"
  - name: "macbook"
    uuid: "<uuid-7>"
    short_id: "<sid-7>"
# sid-8 reserved for emergency rotation
```

Important: previously the vault had a single `clients[]` list mixing router + 6 iphone + 1 macbook for VPS identity. Keep that list as-is; this is a NEW separate list for the router-side identity. The router-side `clients[]` for VPS inbound becomes effectively single-tenant (the router itself); the 6 iPhone + 1 MacBook entries in VPS-side `clients[]` will be REVOKED in Phase 6.

#### Step 1.5 — Update group_vars to expose new variables

In `ansible/group_vars/routers.yml`, add references for the new vars (so Ansible `home_*` are visible in templates):
```yaml
home_reality_ingress_port: "{{ home_reality_ingress_port }}"
home_reality_dest_host: "{{ home_reality_dest_host }}"
home_reality_server_names: "{{ home_reality_server_names }}"
home_reality_server_private_key: "{{ home_reality_server_private_key }}"
home_reality_server_short_ids: "{{ home_reality_server_short_ids }}"
home_clients: "{{ home_clients }}"
```

Or just leave them in vault and reference directly in templates (vault is included in playbook vars_files).

---

### Phase 2 — Update sing-box config to add Reality inbound

**Goal:** sing-box runs both the existing redirect inbound AND a new Reality inbound on the chosen port, both routed to the existing VPS outbound.

#### Step 2.1 — Edit sing-box config template

File: `ansible/roles/singbox_client/templates/config.json.j2`

Add a second inbound after the existing `redirect` inbound:

```jinja
{
  "log": {
    "level": "{{ singbox_log_level | default('info') }}",
    "output": "{{ singbox_log_path }}",
    "timestamp": true
  },
  "inbounds": [
    {
      "type": "redirect",
      "tag": "redirect-in",
      "listen": "0.0.0.0",
      "listen_port": {{ singbox_redirect_port }},
      "sniff": true
    },
    {
      "type": "socks",
      "tag": "dnscrypt-socks-in",
      "listen": "127.0.0.1",
      "listen_port": {{ singbox_dnscrypt_socks_port }},
      "sniff": true,
      "domain_strategy": "prefer_ipv4"
    },
    {
      "type": "vless",
      "tag": "reality-in",
      "listen": "0.0.0.0",
      "listen_port": {{ home_reality_ingress_port }},
      "users": [
{% for c in home_clients %}
        { "name": "{{ c.name }}", "uuid": "{{ c.uuid }}", "flow": "xtls-rprx-vision" }{{ "," if not loop.last else "" }}
{% endfor %}
      ],
      "tls": {
        "enabled": true,
        "server_name": "{{ home_reality_server_names[0] }}",
        "reality": {
          "enabled": true,
          "handshake": {
            "server": "{{ home_reality_dest_host }}",
            "server_port": {{ home_reality_dest_port }}
          },
          "private_key": "{{ home_reality_server_private_key }}",
          "short_id": {{ home_reality_server_short_ids | to_json }}
        }
      },
      "sniff": true
    }
  ],
  "outbounds": [
    {
      "type": "vless",
      "tag": "reality-out",
      "server": "{{ vps_ssh_host }}",
      "server_port": 443,
      "uuid": "{{ (clients | selectattr('name','equalto','router') | list | first).uuid }}",
      "flow": "xtls-rprx-vision",
      "packet_encoding": "xudp",
      "tcp_fast_open": false,
      "multiplex": { "enabled": false },
      "tls": {
        "enabled": true,
        "server_name": "{{ reality_server_names[0] }}",
        "utls": { "enabled": true, "fingerprint": "chrome" },
        "reality": {
          "enabled": true,
          "public_key": "{{ reality_server_public_key }}",
          "short_id": "{{ (clients | selectattr('name','equalto','router') | list | first).short_id }}"
        }
      }
    },
    { "type": "direct", "tag": "direct-out" }
  ],
  "route": {
    "rule_set": [
      { "tag": "stealth-domains", "type": "local", "format": "source", "path": "/opt/etc/sing-box/rulesets/stealth-domains.json" },
      { "tag": "stealth-static", "type": "local", "format": "source", "path": "/opt/etc/sing-box/rulesets/stealth-static.json" }
    ],
    "rules": [
      { "inbound": "redirect-in", "outbound": "reality-out" },
      { "inbound": "dnscrypt-socks-in", "outbound": "reality-out" },
      { "inbound": "reality-in", "rule_set": ["stealth-domains", "stealth-static"], "outbound": "reality-out" },
      { "inbound": "reality-in", "outbound": "direct-out" }
    ],
    "final": "direct-out"
  }
}
```

Note: `reality-in` traffic, after decryption inside sing-box, has destination
addresses learned from the inner VLESS request. Managed destinations match the
same rule-sets generated from `STEALTH_DOMAINS` and `VPN_STATIC_NETS`, then use
`reality-out`. Non-managed destinations use `direct-out`. End-to-end managed
flow:
```
mobile  ─► Reality(home key)  ─► sing-box decrypts  ─► Reality(VPS key)  ─► VPS Xray decrypts  ─► destination
```

#### Step 2.2 — Validate template syntax

```bash
cd router_configuration/ansible
ansible-playbook playbooks/20-stealth-router.yml --check --diff --tags singbox_client
```

Expect: rendered config diff shows new inbound block; no Jinja/JSON syntax errors.

---

### Phase 3 — Open inbound port in router firewall

**Goal:** allow inbound TCP `home_reality_ingress_port` from WAN. NAT not needed (sing-box listens directly on the router itself).

#### Step 3.1 — Update `ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2`

Add a new firewall block specifically for the Reality inbound port. Place it AFTER existing rules, idempotent:

```sh
# === Mobile Reality ingress (home router as relay, port {{ home_reality_ingress_port }}) ===
INGRESS_PORT={{ home_reality_ingress_port }}

# Allow inbound TCP from WAN to the ingress port (sing-box listens here)
iptables -C INPUT -p tcp --dport "$INGRESS_PORT" -j ACCEPT 2>/dev/null \
  || iptables -I INPUT 1 -p tcp --dport "$INGRESS_PORT" -j ACCEPT

# Optional: rate-limit to avoid amplification by SYN flood; don't make it too tight
# (Reality clients might have keepalive bursts):
iptables -C INPUT -p tcp --dport "$INGRESS_PORT" --syn -m connlimit --connlimit-above 30 -j DROP 2>/dev/null \
  || iptables -I INPUT 2 -p tcp --dport "$INGRESS_PORT" --syn -m connlimit --connlimit-above 30 -j DROP

# Logging counter for monitoring (optional)
iptables -C INPUT -p tcp --dport "$INGRESS_PORT" -m comment --comment "mobile-reality-ingress" -j ACCEPT 2>/dev/null \
  || iptables -A INPUT -p tcp --dport "$INGRESS_PORT" -m comment --comment "mobile-reality-ingress" -j ACCEPT
```

(Do NOT use `--reject-with` — silent DROP for unauthorized rate-limit. Match the rest of the project's style.)

Note: Asuswrt-Merlin already has a default-policy on INPUT chain; depending on existing rules, the explicit ACCEPT in INPUT may be sufficient. Test in Phase 7.

#### Step 3.2 — Confirm IPv6 kill-switch is still active

This plan adds an IPv4-only inbound. If IPv6 is somehow re-enabled in the future, the inbound would also need ip6tables ACCEPT and sing-box would need IPv6 listen. Keeping IPv6 disabled (per stealth-security-review §1.1) is mandatory.

```bash
ssh admin@<router> '[ "$(nvram get ipv6_service)" = "disabled" ] && echo OK || echo FAIL'
```

---

### Phase 4 — Update playbook and deploy

#### Step 4.1 — Verify role order

`ansible/playbooks/20-stealth-router.yml` should remain:
```yaml
roles:
  - ipv6_kill
  - singbox_client      # gets new inbound
  - stealth_routing     # gets new INPUT ACCEPT
  - dnscrypt_proxy
  - dnsmasq_blocklists
```

#### Step 4.2 — Apply

```bash
cd ansible
ansible-playbook playbooks/20-stealth-router.yml
```

Watch for errors. If sing-box fails to start with the new inbound (e.g., due to bind error if port is occupied), Ansible task will fail. Check:
```bash
ssh admin@<router> '
  /opt/etc/init.d/S99singbox status
  ss -tln "( sport = :<home-reality-port> )"
  tail -50 /opt/var/log/sing-box.log
'
```

Expected: sing-box running, listening on `0.0.0.0:<home-reality-port>`, log shows "started inbound/reality-in".

---

### Phase 5 — Generate new mobile client profiles

**Goal:** 7 new VLESS URIs and QR PNGs pointing to the home router endpoint.

#### Step 5.1 — Add a new playbook task or extend existing

Edit or duplicate `ansible/playbooks/30-generate-client-profiles.yml`. Add a new section:

```yaml
- name: Generate HOME Reality client profiles (mobile via home relay)
  hosts: localhost
  connection: local
  gather_facts: false
  vars_files:
    - ../secrets/stealth.yml
  vars:
    home_out_dir: "{{ playbook_dir }}/../out/clients-home"
    home_sni: "{{ home_reality_server_names[0] }}"
    home_pbk: "{{ home_reality_server_public_key }}"
    home_endpoint: "{{ home_public_ip }}"   # add to vault if not present
    home_port: "{{ home_reality_ingress_port }}"
  tasks:
    - name: Ensure output dir exists
      ansible.builtin.file:
        path: "{{ home_out_dir }}"
        state: directory
        mode: "0700"

    - name: Render VLESS URI for each home client
      ansible.builtin.copy:
        dest: "{{ home_out_dir }}/{{ item.name }}.conf"
        mode: "0600"
        content: |
          vless://{{ item.uuid }}@{{ home_endpoint }}:{{ home_port }}?encryption=none&flow=xtls-rprx-vision&security=reality&sni={{ home_sni }}&fp=chrome&pbk={{ home_pbk }}&sid={{ item.short_id }}&type=tcp&headerType=none#{{ item.name }}-home
      loop: "{{ home_clients }}"

    - name: Render QR PNG
      ansible.builtin.shell: |
        qrencode -t PNG -o "{{ home_out_dir }}/{{ item.name }}.png" -r "{{ home_out_dir }}/{{ item.name }}.conf"
      loop: "{{ home_clients }}"

    - name: Inform
      ansible.builtin.debug:
        msg: |
          HOME Reality profiles in {{ home_out_dir }}.
          Distribute over Signal / AirDrop only.
          Old direct-VPS profiles in ansible/out/clients/ can be retained as fallback.
```

#### Step 5.2 — Add `home_public_ip` to vault if not present

```bash
ansible-vault edit secrets/stealth.yml
# add:
#   home_public_ip: "<your home WAN IPv4>"
```

If your home IP is dynamic, prefer a dynamic-DNS hostname (e.g., No-IP, DuckDNS) and use that here. Then `home_endpoint` becomes a hostname. Reality clients accept hostname.

#### Step 5.3 — Generate

```bash
ansible-playbook playbooks/30-generate-client-profiles.yml --tags home_clients_only \
  || ansible-playbook playbooks/30-generate-client-profiles.yml
ls -la ansible/out/clients-home/
# expect: iphone-1.{conf,png} … iphone-6.{conf,png} macbook.{conf,png}
```

#### Step 5.4 — `.gitignore`

Confirm `ansible/out/clients-home/*` is gitignored (extend existing rule):
```
ansible/out/clients-home/*
```

---

### Phase 6 — Migrate clients and revoke old direct-VPS profiles

#### Step 6.1 — Distribute new QRs

For each of the 6 iPhones and 1 MacBook:
1. Send the corresponding `.png` QR via Signal / AirDrop.
2. User opens V2Box / FoXray on device, removes the OLD profile (the one ending in `#iphone-X` pointing to VPS), imports the NEW QR (ending in `#iphone-X-home`).
3. Verify connectivity test from each device:
   - On WiFi at home: `curl https://ifconfig.me` → expect VPS IP.
   - On LTE outside home: `curl https://ifconfig.me` → expect VPS IP.
4. After device confirms ok on LTE, mark client migrated.

#### Step 6.2 — Wait 24h with both profiles available

Keep old direct-VPS profiles deployed (their UUIDs are still active in VPS inbound). Allow users to fall back if home-relay path has issues. Do NOT revoke old profiles yet.

#### Step 6.3 — Revoke old mobile UUIDs from VPS inbound

After 24h of clean operation on home-relay path:

Edit `ansible/secrets/stealth.yml` VPS `clients[]` array — keep ONLY the router entry, remove iphone-1..6 and macbook entries:

```yaml
clients:
  - name: "router"
    uuid: "<existing-router-uuid>"
    short_id: "<existing-router-short_id>"
    email: "router@home.lan"
# iphone-1..6 and macbook entries REMOVED 2026-04-25 — migrated to home Reality relay (mobile-lte-home-relay-implementation-guide.md Phase 6)
```

Re-run VPS playbook to sync 3x-ui inbound:
```bash
cd ansible
ansible-playbook playbooks/10-stealth-vps.yml
```

The `xray_reality` role's seed task is idempotent; it should detect the new clients[] and update the inbound (or you may need to manually delete revoked clients via 3x-ui API or web UI in the panel — depends on role implementation).

Verification:
```bash
# From outside the home network, with one of the OLD UUIDs:
# Try connecting via V2Box with the OLD QR (pre-migration backup).
# Expect: handshake fails / timeouts. Reality denies, fallback returns real iCloud cert.
```

#### Step 6.4 — Optionally remove `ansible/out/clients/{iphone-*,macbook}.png`

After all clients migrated and 24h+ stable, delete the now-obsolete direct-VPS client files:
```bash
git rm ansible/out/clients/.gitkeep   # if any
# (clients/*.png are gitignored anyway, but remove from local working tree)
rm ansible/out/clients/iphone-*.{conf,png}
rm ansible/out/clients/macbook.{conf,png}
# Keep router.conf — it's the active VPS client (router itself)
```

---

### Phase 7 — Verification

#### Step 7.1 — Local listening

```bash
ssh admin@<router> '
  ss -tln "( sport = :{{ home_reality_ingress_port }} )" | grep -q 0.0.0.0
  ss -tln "( sport = :{{ singbox_redirect_port }} )" | grep -q 0.0.0.0
  ss -tln "( sport = :1080 )" | grep -q 127.0.0.1
'
```

All three checks should pass:
- redirect inbound (existing) on 0.0.0.0:<lan-redirect-port>
- DoH SOCKS5 (existing) on 127.0.0.1:1080
- Reality inbound (NEW) on 0.0.0.0:<home-reality-port>

#### Step 7.2 — External TLS handshake

From mobile carrier network or any external internet vantage:
```bash
curl -sk --resolve gateway.icloud.com:{{ home_reality_ingress_port }}:<home_public_IP> \
     --max-time 10 \
     -I "https://gateway.icloud.com:{{ home_reality_ingress_port }}/"
```
Expect: TLS handshake succeeds, valid Apple cert (Reality fallback proxies probe → real iCloud → returns real cert + response).

#### Step 7.3 — Mobile client end-to-end

From an iPhone on LTE (NOT home WiFi):
1. Connect via the new home QR.
2. `curl https://ifconfig.me` → should return VPS IP `198.51.100.10`.
3. From iOS shortcut or browser: visit a STEALTH-listed site (e.g., `youtube.com`) → should load.

#### Step 7.4 — LTE billing classification

Best-effort verification. If your carrier provides per-flow billing data:
- Check destination IP for that mobile's data session.
- Should be home_public_IP (RU), not 198.51.100.10 (DE).

If carrier UI doesn't expose this — assume domestic billing applies (the L3 destination is RU IP; standard GeoIP-based billing classifies as domestic).

#### Step 7.5 — Active probing protection

From any external machine:
```bash
# Probe with WRONG (random) Reality public key
curl -sk --resolve gateway.icloud.com:{{ home_reality_ingress_port }}:<home_public_IP> \
     -I "https://gateway.icloud.com:{{ home_reality_ingress_port }}/"
# Expect: real Apple HTTP response (200/301/etc.). Reality fallback works.

# nmap scan
nmap -sV -p {{ home_reality_ingress_port }} <home_public_IP>
# Expect: ssl/http; cert subject contains gateway.icloud.com
```

#### Step 7.6 — CPU baseline

Run for 5 minutes with one mobile client active streaming video (e.g., YouTube on iPhone via LTE):
```bash
ssh admin@<router> '
  for i in 1 2 3 4 5; do
    top -n 1 -b | grep -E "sing-box|^Cpu" | head -2
    sleep 60
  done
'
```
Expect: sing-box CPU usage < 60% of one core during active streaming. RT-AX88U Pro has 4 cores; should sustain 1–2 concurrent users without saturation. If saturating > 80% with one user — investigate.

#### Step 7.7 — Channel B (LAN side) regression

LAN device (any home Wi-Fi computer):
```bash
curl https://ifconfig.me  # expect: VPS IP (unchanged)
curl https://youtube.com -I  # expect: 200/301
```

Existing LAN behavior must be unchanged.

#### Step 7.8 — Fresh `verify.sh` and ansible verify

```bash
cd router_configuration
./verify.sh
cd ansible && ansible-playbook playbooks/99-verify.yml
```

Both green.

---

### Phase 8 — Watchdog and monitoring

#### Step 8.1 — Verify watchdog probe target (security review item 3.3)

Per the prior review, sing-box watchdog should probe a port that proves the sing-box process is alive AND responsive. Ideally probe one of:
- `127.0.0.1:{{ singbox_redirect_port }}` (existing)
- OR add a new probe for `127.0.0.1:{{ home_reality_ingress_port }}` (NEW)

Edit `ansible/roles/singbox_client/templates/singbox-watchdog.sh.j2` to verify the right port. Suggested update:

```sh
#!/bin/sh
# Probe both inbounds; if either is dead, the process is broken.
PORTS="{{ singbox_redirect_port }} {{ home_reality_ingress_port }}"
STATE_FILE=/opt/tmp/singbox-watchdog.state
mkdir -p "$(dirname $STATE_FILE)"

ALL_OK=1
for P in $PORTS; do
    if ! timeout 3 /opt/bin/nc -z 127.0.0.1 "$P" 2>/dev/null; then
        ALL_OK=0
    fi
done

if [ "$ALL_OK" = "1" ]; then
    echo 0 > "$STATE_FILE"
    exit 0
fi

FAIL=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
FAIL=$((FAIL + 1))
echo $FAIL > "$STATE_FILE"

if [ "$FAIL" -ge 3 ]; then
    logger -t singbox-watchdog "sing-box unresponsive ($FAIL checks); restarting"
    /opt/etc/init.d/S99singbox restart
    echo 0 > "$STATE_FILE"
fi
```

#### Step 8.2 — Add log alerting (optional, low priority)

If you have a Telegram/email pipeline:
- New cron entry: hourly check that `iptables -t filter -nvxL INPUT | grep mobile-reality-ingress` packet count increased (i.e., mobile clients are using it).
- Alert if zero for >24h (mobile clients all detached or service silently broken).

This is in the upgrade-roadmap backlog; not required for MVP.

---

## §4. Other improvements integrated

### 4.1 Dead REJECT-rule cleanup (review item 3.2)

In `ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2`, the cleanup of legacy REJECT rules (lines ~41–44 per review) is now obsolete. Phase 4 deployment is a good moment to clean it up:

```diff
- # Clean up old REJECT rules (legacy)
- iptables -D FORWARD -i br0 -p udp --dport 443 -m set --match-set "$IPSET" dst \
-   -j REJECT --reject-with icmp-port-unreachable 2>/dev/null || true
- iptables -D FORWARD -i br0 -p udp --dport 443 -m set --match-set "$STATIC_IPSET" dst \
-   -j REJECT --reject-with icmp-port-unreachable 2>/dev/null || true
+ # Legacy REJECT rules cleanup removed 2026-04-25 — fully migrated to DROP.
```

Apply when running Phase 4 deploy; commit message: `chore: remove obsolete REJECT cleanup from stealth-route-init`.

### 4.2 Audit STEALTH_DOMAINS curation (review item 3.6)

Out of scope for this plan, but recommended next operational task:

```bash
# Identify domains with low/no traffic in last 30 days
ssh admin@<router> '/jffs/scripts/router-health-report --traffic-only' | \
  grep -A1000 STEALTH_DOMAINS | head -200
```

Review and potentially trim `configs/dnsmasq-stealth.conf.add` to only domains that:
- are RKN-blocked AND
- the household actively uses

Reduces traffic volume to VPS, reduces duration-fingerprint, reduces VPS bandwidth bill. Schedule as a separate op after this plan is stable.

### 4.3 Audit trail document (review item 4.2)

Out of scope for this plan as a code change, but during Phase 7 verification, append entries to `docs/stealth-security-review-and-fixes.md` §8 (or create that section if missing):

```markdown
## §8 Verification audit trail

| Date | Action | Verification |
|------|--------|---------------|
| 2026-04-24 | SNI switched to gateway.icloud.com | sni-rotation-candidates.md §8 entry |
| 2026-04-25 | IPv6 kill-switch deployed | nvram get ipv6_service = disabled |
| 2026-04-25 | UDP DROP rule active | iptables -L FORWARD shows DROP not REJECT |
| 2026-04-25 | Channel A decommissioned | wgs1_enable=0, wgc1_enable=0, WAN pcap = 0 WG bytes |
| 2026-04-25 | Mobile relay deployed | external probe via home_public_IP:<home-reality-port> returns Apple cert |
| ... | (continue per fix) | |
```

---

## §5. Rollback plan

Three levels of rollback:

### Level 1 — Backout new Reality inbound only

If something is broken with the home Reality ingress (e.g., sing-box crashes, port conflict, mobile clients can't connect):

```bash
cd router_configuration
git revert <phase-2-commit>  # the singbox config addition
./deploy.sh
ssh admin@<router> '/opt/etc/init.d/S99singbox restart'
```

Mobile clients will fall back to their **old direct-VPS profiles** (kept in `ansible/out/clients-backup-pre-mobile-relay-<date>/`). Re-distribute as needed.

### Level 2 — Re-enable old direct-VPS UUIDs

If old UUIDs were already revoked in Phase 6.3 and you need them back urgently:

```bash
cd ansible
ansible-vault edit secrets/stealth.yml
# Restore the iphone-1..6, macbook entries in clients[] from the git history baseline
ansible-playbook playbooks/10-stealth-vps.yml
```

5 minutes. VPS inbound now accepts old mobile profiles again.

### Level 3 — Full git tag revert

```bash
git reset --hard pre-mobile-relay-<date>
./deploy.sh
ssh admin@<router> '/opt/etc/init.d/S99singbox restart'
```

Returns to immediate-before-mobile-relay state. Mobile clients use direct-VPS profiles. International billing returns. ~5 min.

---

## §6. Monitoring after deployment

For at least 7 days post-deployment:

1. **CPU on router** — `ssh admin@<router> 'top -b -n 1 | head -10'` daily. Sing-box CPU should not consistently exceed 50% of one core.
2. **Mobile client connectivity** — ad-hoc reports from family. If iPhone-N reports issues, debug per Phase 7 steps for that profile.
3. **`router-health-report`** — same daily cadence as before.
4. **External port-scan reputation** — periodically (monthly) scan home_public_IP from external vantage. If new SHODAN/Censys entries reveal "your home IP runs TLS on port X" — accept (this is now true) but be aware.
5. **VPS traffic budget** — should drop slightly (mobile traffic now goes via two Reality hops, but volume same; unrelated to budget). Monitor `provider-cli server list` for bandwidth used vs included.

---

## §7. Files created / modified by this plan

**New:**
- `ansible/out/clients-home/{iphone-1..6,macbook}.{conf,png}` — generated by Phase 5, gitignored.

**Modified:**
- `ansible/secrets/stealth.yml` (vault) — Phase 1 adds `home_*` vars, Phase 6 trims `clients[]`.
- `ansible/group_vars/routers.yml` — Phase 1 exposes new vars (if not via vault).
- `ansible/roles/singbox_client/templates/config.json.j2` — Phase 2 adds Reality inbound.
- `ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2` — Phase 3 adds firewall ACCEPT; Phase 4 removes dead REJECT cleanup.
- `ansible/roles/singbox_client/templates/singbox-watchdog.sh.j2` — Phase 8.1 probes both ports.
- `ansible/playbooks/30-generate-client-profiles.yml` — Phase 5 adds `home_clients` generation block.
- `.gitignore` — Phase 5.4 includes `ansible/out/clients-home/*`.

**Documentation:**
- `docs/stealth-security-review-and-fixes.md` §8 — append audit trail entries (Phase 7/8).
- `docs/architecture.md` — add a section "Mobile relay" describing the new ingress; update diagrams.
- `docs/client-profiles.md` — document the two profile types (direct-VPS deprecated; home-relay primary).
- `docs/failure-modes.md` — add: "Home Reality ingress down → mobile clients fall back to direct-VPS profiles (LTE international billing applies temporarily)".

**NOT touched:**
- `ansible/roles/xray_reality/` — VPS side unchanged except for vault `clients[]` reduction in Phase 6.3.
- `ansible/roles/caddy_l4/` — VPS Caddy unchanged.
- `ansible/roles/dnscrypt_proxy/` — DNS path unchanged.
- `ansible/roles/dnsmasq_blocklists/` — unchanged.
- `ansible/roles/ipv6_kill/` — unchanged (still required).
- `configs/dnsmasq-stealth.conf.add` — unchanged.
- `scripts/firewall-start`, `scripts/nat-start` — unchanged.

---

## §8. Critical invariants for implementing LLM

1. **Channel A decommission must complete first.** Do not start Phase 1 if `nvram get wgs1_enable` ≠ `0` or `nvram get wgc1_enable` ≠ `0`.
2. **Different keypair from VPS.** Router-side Reality identity is NEW and INDEPENDENT. Do not reuse VPS private key.
3. **Different per-client UUIDs.** Phase 1 generates 7 fresh UUIDs for `home_clients[]`. Do not reuse VPS-side iphone/macbook UUIDs.
4. **Port choice ≠ old wgs1 port.** Don't reuse the WG port that may be on RKN scan history.
5. **24h dual-availability before Phase 6.3.** Do not revoke VPS-side mobile UUIDs until home-relay confirmed working for all 7 clients.
6. **maxtg_bridge unaffected.** Sanity check after Phase 4: `docker ps | grep deploy-bridge-1` shows Up.
7. **IPv6 stays disabled.** Phase 3 checks; do not silently re-enable.
8. **Reality fallback to real `gateway.icloud.com:443`** — required for active probing protection. If router cannot reach Apple outbound (rare), fallback fails and probes return TCP RST → detection signal. Verify in Phase 7.
9. **Use sing-box single-process for both inbounds** — not two separate sing-box processes. One config, two inbound blocks.
10. **Decision log entry required.** Append to `docs/stealth-security-review-and-fixes.md` §8 audit trail or `docs/sni-rotation-candidates.md` §8 (whichever is being used as central log).

---

## §9. Non-goals (explicit)

This plan does NOT do:

- AS-mismatch (Apple SNI + VPS AS) mitigation. Residual risk; out of scope.
- Multi-VPS failover. Single VPS remains SPOF for the outbound Reality leg.
- CDN front (Cloudflare Tunnel) for ingress or egress. Out of scope.
- IPv6 enablement. Stays disabled.
- ZeroTier overlay for LAN access. Tracked separately in `docs/remote-access-overlay-migration.md` (already superseded by Channel A decommission for the home-LAN-access use case).
- Cascade exit through commercial VPN. Out of scope.
- Periodic key rotation. Manual on demand or every 6–12 months.

---

## Appendix A — Quick reference

### A.1 Verification one-liners post-deployment

```bash
# Router
ssh admin@<router> '
  echo "=== sing-box listening ==="
  ss -tln | grep -E ":({{ singbox_redirect_port }}|{{ home_reality_ingress_port }}|1080)"
  echo "=== INPUT ACCEPT for mobile reality ==="
  iptables -t filter -nL INPUT | grep mobile-reality-ingress
  echo "=== sing-box uptime ==="
  /opt/etc/init.d/S99singbox status
'

# External TLS probe to home
curl -sk --resolve gateway.icloud.com:{{ home_reality_ingress_port }}:<home_public_IP> \
     -I "https://gateway.icloud.com:{{ home_reality_ingress_port }}/"

# VPS side
ssh deploy@198.51.100.10 'docker logs --tail 50 xray | grep -i error'
```

### A.2 Decision log entry template

When deployment completes, append:

```
## YYYY-MM-DD — Mobile LTE relay deployed
Initiator: <name>
Pre-deployment baseline: pre-mobile-relay-<date> tag
Phases 1–8 completed: YYYY-MM-DD ... YYYY-MM-DD
Reality-in port chosen: <home-reality-port>
Reality-in keypair generated: <date>
7 mobile profiles regenerated: iphone-1..6, macbook
Home-side UUIDs revoked from VPS inbound: 7 (after 24h dual-availability)
External probe verified: real Apple cert returned
LTE billing classification: <verified RU domestic / pending billing-cycle>
CPU baseline (1 active streamer): <%>
Issues: <none / list>
```
