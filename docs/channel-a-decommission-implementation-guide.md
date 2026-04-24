# Channel A Decommission — wgs1 + wgc1 Teardown Implementation Guide

**Audience:** LLM agent or engineer executing the Channel A (WireGuard) decommission on `router_configuration`.
**Goal:** remove all plain-WG signals from home IP (inbound `wgs1` server + outbound `wgc1` client) while preserving cold-fallback restoration capability.
**Status:** planning complete; implementation not started.
**Expected detection reduction:** from ~90% VPN-classification probability (current dual-channel) to <10% (Reality-only + AS-mismatch residual).

This document is self-contained. No other file must be read to execute it. Cross-references point at artifacts this guide will create or modify.

---

## §0. Context and threat model

### Why

After applying `docs/stealth-security-review-and-fixes.md` P0/P1 fixes, the dominant residual VPN-classification signal from the home IP is **Channel A itself**:
- `wgc1` emits classic WireGuard handshake packets (148 byte, `01 00 00 00` prefix) to a commercial VPN server — direct DPI fingerprint, no further analysis needed.
- `wgs1` accepts inbound WireGuard on WAN — any UDP port scan from RKN or ISP reveals a listening WG server.

As long as either exists, RKN/ISP DPI classifies the home IP as "VPN user" regardless of how clean Channel B (Reality) is. This guide removes both.

### Threat model

Same as security review §0:
1. Passive RU DPI (TSPU) via packet fingerprinting.
2. Active RKN probing of home IP ports.
3. Correlation between home IP and known-blocked destinations.
4. SNI/AS enumeration (residual after this plan — not fixed here).

Out of scope:
- Multi-VPS failover.
- Cascade exit (shared-pool IP).
- Deep browser fingerprinting.

### Preconditions — must all be true before Phase 1

1. **All wgs1 peers migrated off.** Remote iPhone/MacBook family members use Reality QR profiles now; `wgs1` has no active peers. Verification: `wg show wgs1 latest-handshakes` shows all peers with handshake timestamps older than 24 hours.
2. **P0/P1 stealth-review fixes applied.** Specifically:
   - IPv6 kill-switch (`nvram get ipv6_service` returns `disabled`).
   - UDP/443 DROP (not REJECT) on STEALTH/STATIC ipsets.
   - OpenClaw moved off shared 443 IP.
   - SNI switched to `gateway.icloud.com`.
   - DoH via stealth socks5 (sing-box on 127.0.0.1:1080; `proxy = socks5://…` in dnscrypt-proxy.toml).
   - sing-box watchdog cron installed.
3. **Reality stable ≥ 7 days** without sing-box crashes, no handshake errors in last 72 hours.
4. **Baseline NVRAM snapshot taken** (see §2).

### Cold-fallback policy (user-mandated)

**wgc1 NVRAM configuration must never be deleted.** Fields that must remain intact in NVRAM throughout all phases:
- `wgc1_priv` (private key)
- `wgc1_addr` (tunnel address)
- `wgc1_ep_addr` (endpoint)
- `wgc1_peer_pub` (server public key)
- `wgc1_psk` (pre-shared key, if any)
- `wgc1_dns`, `wgc1_mtu`, `wgc1_keepalive`, etc. — all wgc1_* except `wgc1_enable`.

Only `wgc1_enable=0` changes to deactivate. `scripts/emergency-enable-wgc1.sh` (created in Phase 6) flips it back on.

---

## §1. Before/after risk matrix

| Phase | wgs1 state | wgc1 state | VPN_DOMAINS state | RKN/ISP sees | Est. classification risk |
|---|---|---|---|---|---|
| Current (pre-migration) | listening WAN, 0 peers | active client, carries LAN + wgs1 | duplicate of STEALTH | WG handshakes out + WG port open in | ~90% |
| After Phase 1 | listening, 0 peers | active | auto-add stops writing to it | same | ~90% (no change — prep only) |
| After Phase 2 (LAN off wgc1) | listening, 0 peers | active but idle | unused | WG handshakes fall to ~0 | ~60% |
| After Phase 3 (wgs1 off) | disabled, port closed | active but idle | unused | Only wgc1 keepalive out (if any) | ~50% |
| After Phase 4 (wgc1 off) | disabled | disabled, NVRAM preserved | unused | Only Reality TCP/443 to VPS | ~10% |
| After Phase 6 (cleanup) | n/a | n/a | deleted | Only Reality TCP/443 to VPS | ~10% (same — cleanup is cosmetic) |

Residual 10%: AS-mismatch (Apple SNI + VPS AS), duration fingerprint, multi-vantage correlation. Mitigations deferred to separate plans.

---

## §2. Pre-flight checklist

Run all before starting Phase 1. If anything fails, resolve it first.

```bash
# On control machine, in router_configuration/
cd ansible

# 1. Verify wgs1 has no active peers
ssh admin@<router> 'wg show wgs1 latest-handshakes' | \
  awk '$2 != 0 && $2 > (systime() - 86400) {print "FAIL: active peer", $1; exit 1}' && \
  echo "OK: no active wgs1 peers in last 24h"

# 2. Verify stealth-review fixes
ssh admin@<router> '
  [ "$(nvram get ipv6_service)" = "disabled" ] || { echo "FAIL: IPv6 not disabled"; exit 1; }
  iptables -t filter -S FORWARD | grep -qE "udp dpt:443 .*DROP" || { echo "FAIL: UDP/443 not DROP"; exit 1; }
  ss -tln "( sport = :1080 )" | grep -q 127.0.0.1 || { echo "FAIL: singbox SOCKS5 missing"; exit 1; }
  crontab -l | grep -q singbox-watchdog || { echo "FAIL: watchdog cron missing"; exit 1; }
  echo "OK: stealth review fixes present"
'

# 3. Verify Reality stability (last 7 days clean)
ssh deploy@198.51.100.10 '
  docker logs --since 168h xray 2>&1 | grep -iE "error|fatal|fail" | \
    grep -v "rejected: fallback" | head -5
'
# expect: empty output (no real errors, only Reality fallback which is expected)

# 4. Verify current 99-verify passes
ansible-playbook playbooks/99-verify.yml

# 5. Take NVRAM snapshot (baseline for rollback and audit)
ssh admin@<router> 'nvram show 2>&1 | grep -vE "nvram_space|^size:"' \
  > ~/nvram-pre-decommission-$(date +%F).txt
ls -la ~/nvram-pre-decommission-*.txt

# 6. Git snapshot of repo
cd ..
git status      # should be clean, or stage any pending work first
git tag pre-channel-a-decommission-$(date +%F)
git log --oneline -5
```

Record the git tag hash somewhere retrievable — it's the canonical rollback point.

---

## §3. Phase 0 — ZeroTier overlay for home-LAN access (OPTIONAL)

**Skip this phase entirely if you do not need remote access to home LAN services (NAS, home automation, etc.).** Reality QR profiles already provide remote internet-VPN; they do NOT provide LAN access. If skipping, proceed directly to §4.

If doing: this is a condensed wrapper over `docs/remote-access-overlay-migration.md` Phase 1–2. Detailed decision-making there; minimum viable path here.

### Phase 0 steps

```bash
# On router
ssh admin@<router>
opkg update
opkg install zerotier

# Start service
/opt/etc/init.d/S10zerotier start

# Create a ZeroTier network via https://my.zerotier.com (free account, up to 25 devices)
# Copy the 16-hex network ID

# Join the network
zerotier-cli join <NETWORK_ID>

# In ZeroTier Central UI: authorize this router as a member; note its IP in the ZeroTier subnet

# On one test iPhone: install ZeroTier app from App Store, join same network, authorize in UI
# Test from the iPhone (on mobile network, not home WiFi):
ping <router-ZT-IP>     # expect: reply
ssh admin@<router-ZT-IP>  # expect: SSH login works (via ZeroTier, not WAN SSH)

# CPU baseline on router during test
top -n 5 -b | head -20   # zerotier-one should use <5% CPU idle

# If test passes, document the ZT network ID and migrate other family members similarly.
```

### Phase 0 verification

- One iPhone via ZeroTier can reach home-LAN router IP.
- Router `zerotier-cli listnetworks` shows `OK PRIVATE` status.
- CPU/RAM stable on router (no memory leak over 24h).

### Phase 0 rollback

```
/opt/etc/init.d/S10zerotier stop
opkg remove zerotier
rm -rf /opt/etc/zerotier-one
```

No repo changes in Phase 0 (all runtime-only on router). Safe to leave running in parallel during all later phases.

---

## §4. Phase 1 — Unify VPN_DOMAINS → STEALTH_DOMAINS (preparation)

**Goal:** ensure auto-add and scripts no longer write to VPN_DOMAINS. Does NOT delete VPN_DOMAINS yet; that happens in Phase 6.

### Step 1.1 — Verify domain parity

```bash
cd router_configuration

comm -3 \
  <(grep -Eo '^ipset=/[^/]+/' configs/dnsmasq.conf.add | sort -u) \
  <(grep -Eo '^ipset=/[^/]+/' configs/dnsmasq-stealth.conf.add | sort -u)
```

Expected output: empty (100% overlap per review). If any lines appear:
- Lines in left column only → add them to `dnsmasq-stealth.conf.add` (change `VPN_DOMAINS` → `STEALTH_DOMAINS`).
- Lines in right column only → these are stealth-only; leave as-is.

Commit reconciliation:
```
git add configs/dnsmasq-stealth.conf.add
git commit -m "channel-a-decommission phase 1: reconcile stealth domain list"
```

### Step 1.2 — Edit `scripts/domain-auto-add.sh`

Key changes:
1. Remove `VPN_IPSET=VPN_DOMAINS` variable.
2. Replace all `ipset=/%s/VPN_DOMAINS` emit lines with single `ipset=/%s/STEALTH_DOMAINS` (or remove the VPN line if STEALTH one already exists).
3. Geo-blocked probe logic (lines ~788 per review): currently emits `server=/%domain%/1.1.1.1@$VPN_IFACE` — change to either (a) a plain `server=/%domain%/127.0.0.1#5354` routing through dnscrypt-proxy, or (b) just remove the `server=` emit since dnsmasq will resolve via its configured upstream which is already dnscrypt-proxy after P1.2.2.

Safe diff pattern:
```diff
-VPN_IPSET=VPN_DOMAINS
-VPN_IFACE=${VPN_IFACE:-wgc1}
+# VPN_DOMAINS / wgc1 removed 2026-04-25 — channel A decommission
+# Old fallback VPN_IPSET / VPN_IFACE wiring intentionally deleted; see docs/channel-a-decommission-implementation-guide.md

...

-  printf 'ipset=/%s/%s\n' "$write_domain" "$VPN_IPSET" >> "$OUT"
   printf 'ipset=/%s/%s\n' "$write_domain" "$STEALTH_IPSET" >> "$OUT"
```

For geo-probe section (approximately lines 604–790):
```diff
-  printf 'server=/%s/1.1.1.1@%s\n' "$probe_domain" "$VPN_IFACE" >> "$OUT"
+  # Resolution via dnscrypt-proxy + standard dnsmasq catchall; no per-domain server= needed
+  # (stealth REDIRECT on br0 captures the connection regardless of DNS path)
```

Test the script in dry-run mode:
```bash
./deploy.sh    # ship the updated script
ssh admin@<router> '/jffs/scripts/domain-auto-add.sh --dry-run 2>&1 | head -20'
```

Expected: no errors, no references to VPN_IFACE, ipset writes go to STEALTH_DOMAINS only.

### Step 1.3 — Commit + deploy

```bash
git add scripts/domain-auto-add.sh
git commit -m "channel-a-decommission phase 1: domain-auto-add writes only STEALTH_DOMAINS"
./deploy.sh
ssh admin@<router> 'service restart_dnsmasq'
```

### Step 1.4 — 24h observation

After 24 hours:
```bash
ssh admin@<router> '
  grep -c VPN_DOMAINS /jffs/configs/dnsmasq-autodiscovered.conf.add || echo 0
  grep -c STEALTH_DOMAINS /jffs/configs/dnsmasq-autodiscovered.conf.add || echo 0
'
```

Expected: VPN_DOMAINS count unchanged since before step 1.2; STEALTH_DOMAINS count growing (or at least unchanged).

### Phase 1 rollback

```
git revert <phase-1-commit>
./deploy.sh
ssh admin@<router> 'service restart_dnsmasq'
```

No runtime damage; auto-add resumes writing to both ipsets.

---

## §5. Phase 2 — Cut LAN off wgc1 (Reality becomes primary carrier)

**Goal:** LAN (br0) traffic no longer gets fwmark 0x1000 and therefore no longer routes to table wgc1. Channel B (Reality via REDIRECT :<lan-redirect-port>) carries everything STEALTH_DOMAINS matches.

### Step 2.1 — Edit `scripts/firewall-start`

Locate the block (per review: lines 31–32) that marks LAN traffic:
```
iptables -t mangle -A PREROUTING -i br0 -m set --match-set VPN_DOMAINS dst -j MARK --set-mark 0x1000/0x1000
iptables -t mangle -A PREROUTING -i br0 -m set --match-set VPN_STATIC_NETS dst -j MARK --set-mark 0x1000/0x1000
```

Comment out (do not delete yet — Phase 6 deletes physically):
```diff
+# REMOVED 2026-04-25 — channel A decommission phase 2: LAN → Reality only
+# See docs/channel-a-decommission-implementation-guide.md
-iptables -t mangle -A PREROUTING -i br0 -m set --match-set VPN_DOMAINS dst -j MARK --set-mark 0x1000/0x1000
-iptables -t mangle -A PREROUTING -i br0 -m set --match-set VPN_STATIC_NETS dst -j MARK --set-mark 0x1000/0x1000
+# iptables -t mangle -A PREROUTING -i br0 -m set --match-set VPN_DOMAINS dst -j MARK --set-mark 0x1000/0x1000
+# iptables -t mangle -A PREROUTING -i br0 -m set --match-set VPN_STATIC_NETS dst -j MARK --set-mark 0x1000/0x1000
```

**Do NOT comment out the `-i wgs1 -j RC_VPN_ROUTE` hook yet** — that's Phase 3. It's inactive without peers but harmless.

### Step 2.2 — Deploy and restart firewall

```bash
git add scripts/firewall-start
git commit -m "channel-a-decommission phase 2: unmark LAN traffic (no longer fwmark 0x1000)"
./deploy.sh
ssh admin@<router> 'service restart_firewall'
```

### Step 2.3 — Observe for 24 hours

Check wgc1 traffic counters hourly. They should almost stop growing:
```bash
ssh admin@<router> '
  cat /sys/class/net/wgc1/statistics/tx_packets
  cat /sys/class/net/wgc1/statistics/rx_packets
'
# Run once now, then again in 1h, 6h, 24h. Delta should be near zero after cutover.
```

Baseline comparison — before Phase 2 these would grow by hundreds per minute. After: only keepalive packets (every 25s, small).

Check sing-box:
```bash
ssh admin@<router> '
  tail -100 /opt/var/log/sing-box.log | grep -iE "error|fail" | head -5
  ss -tn state established | grep -c 198.51.100.10
'
# expect: no errors; connection count to VPS grows slightly
```

LAN smoke test from a desktop in the LAN:
```bash
curl -s --max-time 5 https://ifconfig.me     # expect: 198.51.100.10 (VPS)
curl -s --max-time 5 https://www.youtube.com -I | head -1   # expect: 200 or 301
```

### Phase 2 rollback

If anything looks broken in 24h:
```bash
git revert <phase-2-commit>
./deploy.sh
ssh admin@<router> 'service restart_firewall'
```

LAN reverts to fwmark 0x1000 → wgc1 carrying the traffic as before. No data loss.

---

## §6. Phase 3 — Disable wgs1 (close WAN ingress)

**Precondition:** Phase 2 green for 24h.
**Goal:** home IP no longer listens for WireGuard server connections.

### Step 3.1 — NVRAM disable wgs1

```bash
ssh admin@<router> '
  nvram set wgs1_enable=0
  nvram commit
  service restart_wgs
  sleep 3
  wg show wgs1 2>&1 | head -3
'
# expect: wgs1 interface absent, or "Unable to access interface"
```

### Step 3.2 — Remove firewall hooks for wgs1

Edit `scripts/firewall-start`:
- Remove the `RC_VPN_ROUTE` chain definition block (per review: ~line 56) and the `iptables -t mangle -A PREROUTING -i wgs1 -j RC_VPN_ROUTE` hook (~line 27).
- Keep as commented-out block with date header for Phase 6 cleanup.

Edit `scripts/nat-start`:
- Remove DNS REDIRECT rules on `-i wgs1` (per review: lines 16–19).

### Step 3.3 — Deploy

```bash
git add scripts/firewall-start scripts/nat-start
git commit -m "channel-a-decommission phase 3: disable wgs1 WAN ingress + firewall hooks"
./deploy.sh
ssh admin@<router> 'service restart_firewall'
```

### Step 3.4 — External verification

**From a machine NOT on your home network** (mobile data, VPS, friend's house):

```bash
# Get the home WAN IP first (from router)
ssh admin@<router> 'nvram get wan0_ipaddr'
# then on external machine:
HOME_IP=<that IP>
WG_PORT=<what was wgs1 listening on — check old nvram snapshot>

nmap -sU -p $WG_PORT $HOME_IP
# expect: "open|filtered" (no reply — not "open" with response)

# Broader scan (rate-limited):
sudo nmap -sU -p 1-65535 --min-rate 100 $HOME_IP 2>&1 | grep -v "closed|filtered"
# expect: no "open" UDP ports (WG or otherwise, other than STUN/game consoles if you have any)
```

### Step 3.5 — Local verification

```bash
ssh admin@<router> '
  wg show wgs1 2>&1 | head -3
  iptables -t mangle -S | grep -c wgs1     # expect: 0
  iptables -t nat -S | grep -c wgs1        # expect: 0
  iptables -S INPUT | grep -c 51820        # or whatever port — expect: 0
'
```

### Phase 3 rollback

```bash
ssh admin@<router> '
  nvram set wgs1_enable=1
  nvram commit
  service restart_wgs
'
git revert <phase-3-commit>
./deploy.sh
ssh admin@<router> 'service restart_firewall'
```

wgs1 comes back up with original peer list.

---

## §7. Phase 4 — Disable wgc1 (final VPN signal removal)

**Precondition:** Phase 3 green, no new issues for 48h.
**Goal:** no more outbound WireGuard handshake packets from home IP.

### Step 4.1 — Runtime disable (preserve NVRAM)

```bash
ssh admin@<router> '
  # Backup current values for audit trail
  nvram get wgc1_enable > /tmp/wgc1_enable.before
  nvram get wgc1_ep_addr > /tmp/wgc1_endpoint.preserved

  # Disable
  nvram set wgc1_enable=0
  nvram commit
  service restart_wgc
  sleep 3
  wg show wgc1 2>&1 | head -3
'
# expect: wgc1 interface absent
```

Explicitly verify NVRAM fields preserved:
```bash
ssh admin@<router> '
  echo "== wgc1 config fields (all must be nonempty EXCEPT wgc1_enable=0) =="
  for f in wgc1_enable wgc1_priv wgc1_addr wgc1_ep_addr wgc1_peer_pub wgc1_psk wgc1_dns wgc1_mtu wgc1_keepalive; do
    VAL=$(nvram get $f 2>&1)
    case "$f" in
      wgc1_enable) [ "$VAL" = "0" ] && echo "OK: $f=0" || echo "FAIL: $f=$VAL" ;;
      *) [ -n "$VAL" ] && echo "OK: $f present" || echo "WARN: $f empty (may or may not be expected)" ;;
    esac
  done
'
```

### Step 4.2 — Remove fwmark 0x1000 routing

Edit `scripts/nat-start`:
```diff
-ip rule del fwmark 0x1000/0x1000 2>/dev/null
-ip rule add fwmark 0x1000/0x1000 table wgc1 prio 9910
+# REMOVED 2026-04-25 — channel A decommission phase 4
+# ip rule del fwmark 0x1000/0x1000 2>/dev/null
+# ip rule add fwmark 0x1000/0x1000 table wgc1 prio 9910
```

Edit `scripts/firewall-start` — remove any remaining fwmark 0x1000 mangle rules (the wgs1 branch was already removed in Phase 3; double-check):
```bash
grep -n "0x1000" scripts/firewall-start
# comment out or delete any remaining
```

### Step 4.3 — Deploy

```bash
git add scripts/nat-start scripts/firewall-start
git commit -m "channel-a-decommission phase 4: disable wgc1 runtime + remove fwmark 0x1000 routing"
./deploy.sh
ssh admin@<router> 'service restart_firewall'
```

### Step 4.4 — WAN pcap verification (CRITICAL)

This is the single most important verification of this whole plan. Capture 5 minutes of WAN UDP traffic and confirm no WireGuard handshake bytes.

```bash
ssh admin@<router> '
  WAN_IF=$(nvram get wan0_ifname)
  echo "Capturing on $WAN_IF for 300 seconds..."
  timeout 300 /opt/bin/tcpdump -i $WAN_IF -w /tmp/post-decomm.pcap -nn udp 2>/dev/null
  wait
  
  # Check for WireGuard handshake bytes: first 4 bytes of UDP payload = 01 00 00 00 (init) or 02 00 00 00 (response)
  /opt/bin/tcpdump -r /tmp/post-decomm.pcap -nn -X 2>/dev/null | \
    grep -B1 -E "^\s+0x0000:.*(0100 0000|0200 0000)" | \
    grep -c "^\s*[0-9]"
'
# expect: 0
# If > 0: some WG traffic still leaking. DO NOT PROCEED. Investigate.
```

If the tcpdump binary is not installed via Entware: `opkg install tcpdump`. Alternatively, capture via `timeout 300 tshark -i $WAN_IF -Y "udp.payload[0:4] == 01:00:00:00"` on a machine that has tshark.

### Step 4.5 — Functional LAN smoke test

Full category coverage:
```bash
# From a LAN client:
curl -s --max-time 5 https://ifconfig.me
# expect: 198.51.100.10

# Streaming
curl -sI --max-time 5 https://www.youtube.com | head -1
# expect: 200 or 301

# Messaging
curl -sI --max-time 5 https://web.telegram.org | head -1
curl -sI --max-time 5 https://api.whatsapp.com | head -1

# IT services
curl -sI --max-time 5 https://github.com | head -1
curl -sI --max-time 5 https://anthropic.com | head -1

# Podcasts
curl -sI --max-time 5 https://podcasts.apple.com | head -1
```

All should return 2xx/3xx. If any fails — the domain is in STEALTH_DOMAINS but Reality path is broken for it. Debug via sing-box log.

### Step 4.6 — maxtg_bridge regression check

```bash
ssh deploy@198.51.100.10 'docker ps | grep deploy-bridge-1 && docker logs --tail 20 deploy-bridge-1 2>&1 | tail -10'
# expect: container Up, normal long-polling logs
```

### Phase 4 rollback (emergency)

Use the cold-fallback script if the reality channel fails catastrophically:
```bash
ssh admin@<router> '/jffs/scripts/emergency-enable-wgc1.sh'
```
(Script is installed in Phase 6 Step 6.2 below. During Phase 4 rollback window — if it's not installed yet, run inline equivalent commands.)

Inline equivalent for Phase 4 rollback BEFORE Phase 6:
```bash
ssh admin@<router> '
  nvram set wgc1_enable=1
  nvram commit
  service restart_wgc
  sleep 5
  ip rule add fwmark 0x1000/0x1000 table wgc1 prio 9910 2>/dev/null || true
  iptables -t mangle -A PREROUTING -i br0 -m set --match-set STEALTH_DOMAINS dst \
    -j MARK --set-mark 0x1000/0x1000
'
# Note: uses STEALTH_DOMAINS instead of VPN_DOMAINS (which we preserved but didn't populate in Phase 1).
# If you need full Phase 0 restore: git reset --hard pre-channel-a-decommission-<date> && ./deploy.sh.
```

---

## §8. Phase 5 — 7-day rollback window (passive observation)

**Do nothing new.** Monitor for 7 calendar days:

### Daily check (06:00 + 18:00)

```bash
# From control machine:
ssh admin@<router> '/jffs/scripts/router-health-report'
# Look for: any warnings, any unexpected state, LAN client complaints.

# Traffic report
ssh admin@<router> '/jffs/scripts/traffic-report --since yesterday'
```

### What to watch

- LAN client complaints ("can't reach X").
- Reality handshake failures in sing-box log.
- VPS VPS outages (VPS status page).
- Any unexpected WG activity (shouldn't happen).

### If all quiet for 7 days

Proceed to Phase 6 cleanup.

### If issues appear

- Mild (single domain fails) → add to STEALTH_DOMAINS if not present; no rollback.
- Moderate (Reality flaky) → investigate Reality; no rollback unless sustained > 6h.
- Severe (Reality down > 6h, no recovery in sight) → run emergency-enable-wgc1.sh; resume monitoring; re-evaluate.

### Optional — test emergency script in the window (recommended)

Once during Phase 5, schedule a maintenance window and test that `emergency-enable-wgc1.sh` works:
1. Run `emergency-enable-wgc1.sh`.
2. Verify `wg show wgc1` shows peer with handshake.
3. Verify LAN still works (now via wgc1).
4. Disable wgc1 again: `nvram set wgc1_enable=0; nvram commit; service restart_wgc`.
5. Remove the fwmark rule: `ip rule del fwmark 0x1000/0x1000 table wgc1 2>/dev/null` + remove the mangle rule added by script.
6. Verify LAN still works (now via Reality again).

This confirms the cold-fallback is truly ready when needed.

---

## §9. Phase 6 — Cleanup artifacts

**Precondition:** Phase 5 complete, 7 days quiet.
**Goal:** remove stale code and documentation referring to Channel A.

### Step 6.1 — Delete configs

```bash
cd router_configuration
git rm configs/dnsmasq.conf.add
git rm configs/dnsmasq-vpn-upstream.conf.add
```

### Step 6.2 — Create emergency-enable-wgc1.sh

Create `scripts/emergency-enable-wgc1.sh`:

```sh
#!/bin/sh
# Emergency re-enable of wgc1 cold-fallback.
#
# Use ONLY if Reality / VPS VPS is unavailable for a sustained period
# and stealth channel cannot recover. This re-activates the WireGuard client
# using preserved NVRAM config.
#
# What this does:
#   1. Flips wgc1_enable back to 1 in NVRAM and restarts WG client.
#   2. Restores routing table wgc1 ip rule.
#   3. Adds mangle rule so that LAN traffic to STEALTH_DOMAINS gets marked
#      with 0x1000 (which routes via wgc1).
#
# What this does NOT do:
#   - Does not touch Reality stack on VPS or sing-box on router.
#   - Does not disable Channel B. After this script, Channel B is bypassed
#     for STEALTH_DOMAINS only if the ip rule for 0x1000 takes precedence
#     over the REDIRECT :<lan-redirect-port> — review priorities carefully.
#
# To roll back this emergency re-enable:
#   nvram set wgc1_enable=0; nvram commit; service restart_wgc
#   ip rule del fwmark 0x1000/0x1000 table wgc1 2>/dev/null
#   iptables -t mangle -D PREROUTING -i br0 -m set --match-set STEALTH_DOMAINS dst \
#       -j MARK --set-mark 0x1000/0x1000 2>/dev/null

set -e

echo "=== Emergency wgc1 re-enable ==="
echo "Timestamp: $(date)"

# Step 1: NVRAM flip
if [ "$(nvram get wgc1_enable)" = "1" ]; then
    echo "wgc1 already enabled; skipping NVRAM step"
else
    echo "Enabling wgc1 in NVRAM..."
    nvram set wgc1_enable=1
    nvram commit
    service restart_wgc
    sleep 5
fi

# Step 2: Routing
if ip rule show | grep -q "fwmark 0x1000/0x1000 lookup wgc1"; then
    echo "ip rule already present"
else
    echo "Adding ip rule fwmark 0x1000 -> table wgc1"
    ip rule add fwmark 0x1000/0x1000 table wgc1 prio 9910
fi

# Step 3: mangle rule to mark LAN traffic to STEALTH_DOMAINS
if iptables -t mangle -C PREROUTING -i br0 -m set --match-set STEALTH_DOMAINS dst \
       -j MARK --set-mark 0x1000/0x1000 2>/dev/null; then
    echo "mangle rule already present"
else
    echo "Adding mangle rule (STEALTH_DOMAINS -> 0x1000)"
    iptables -t mangle -I PREROUTING 1 -i br0 -m set --match-set STEALTH_DOMAINS dst \
        -j MARK --set-mark 0x1000/0x1000
fi

# Status
echo
echo "=== Status ==="
wg show wgc1 2>&1 | head -5
echo
ip route show table wgc1 | head -3
echo
echo "=== Emergency re-enable COMPLETE ==="
echo "LAN traffic to STEALTH_DOMAINS is now routed via wgc1 commercial VPN."
echo "Reality/VPS stack is untouched — fix it and then roll back this emergency mode."
```

Add to git, deploy:
```bash
chmod +x scripts/emergency-enable-wgc1.sh
git add scripts/emergency-enable-wgc1.sh
```

The `deploy.sh` script must ship this to `/jffs/scripts/` — update deploy.sh file list if needed.

### Step 6.3 — Edit scripts

#### `scripts/firewall-start`

Remove (replace commented blocks from Phase 2/3/4 with outright deletion):
- `ipset create VPN_DOMAINS …`
- `ipset restore … VPN_DOMAINS`
- All `RC_VPN_ROUTE` chain definition and references.
- All `-i wgs1` hooks.
- All remaining `fwmark 0x1000` references.

**Keep**:
- `ipset create STEALTH_DOMAINS …`
- `ipset create VPN_STATIC_NETS …` (still used by Channel B's REDIRECT).
- Any non-WG firewall rules (SSH, HTTP, etc.).

#### `scripts/nat-start`

Remove:
- `ip rule del/add fwmark 0x1000 … table wgc1`.
- All `-i wgs1` DNS REDIRECT lines.

**Keep**: anything related to dnscrypt-proxy, STEALTH redirect, LAN DNS.

#### `scripts/domain-auto-add.sh`

Final pass — remove any residual references (error handlers, log lines mentioning wgc1, etc.):
```bash
grep -n -iE 'wgc1|VPN_DOMAINS|VPN_IFACE' scripts/domain-auto-add.sh
```
Any remaining hit: review context, likely remove or refactor.

#### `scripts/lib/router-health-common.sh`

This is ~1100 lines per review and has 50+ references to VPN_DOMAINS/wgc1/wgs1. Key blocks to remove:
- `VPN_DOMAINS_CURRENT`, `VPN_DOMAINS_MAXELEM`, `VPN_DOMAINS_MEM` collectors (lines ~819–821 per review).
- `wgc1` route table health checks.
- `wgs1` peer handshake collectors.
- Any alias map entries for α1 (VPN_DOMAINS).

**Test after each edit**: `bash scripts/lib/router-health-common.sh --dry-run` or run `router-health-report` and verify output still valid.

#### `scripts/update-blocked-list.sh`

Check for VPN_DOMAINS references and remove.

#### `verify.sh`

Remove:
- α1 alias line.
- Any `iptables ... 0x1000 ... wgc1` asserts.
- Any `wg show wgs1` peer checks.

#### `deploy.sh`

Remove `ip route show table wgc1` check.

#### `tests/test-router-health.sh`

Audit and remove wgc1/wgs1 test cases.

### Step 6.4 — Update Ansible

#### `ansible/playbooks/99-verify.yml`

Remove (per review, lines ~130-131):
```yaml
- name: wgs1 peers still healthy (regression)
  ansible.builtin.shell: "wg show wgs1 latest-handshakes | awk '{print $2}' | sort -n | tail -1"
```

### Step 6.5 — Update docs (12 files)

This is verbose but mechanical. Go through each file and remove/update:

| File | Change |
|---|---|
| `docs/architecture.md` | Remove wgs1/wgc1 packet-flow diagrams. Add new section "Historical / cold-fallback: wgc1" explaining it's preserved in NVRAM; link to `emergency-enable-wgc1.sh`. Update any ASCII art to single-channel. |
| `docs/channel-routing-operations.md` | Remove VPN_DOMAINS operations. Update all "Add A Domain" to refer to STEALTH_DOMAINS only. |
| `docs/domain-management.md` | Rewrite to single-channel: all domain adds go to dnsmasq-stealth.conf.add. |
| `docs/client-profiles.md` | Remove wgs1 peer section. Keep Reality QR profile management. |
| `docs/remote-access-overlay-migration.md` | Add header "SUPERSEDED by channel-a-decommission-implementation-guide.md"; keep content for reference but flag it. |
| `docs/current-routing-explained.md` | Rewrite single-channel schematic. |
| `docs/failure-modes.md` | Remove wgs1/wgc1 failure modes. Add "Reality down → emergency wgc1 re-enable" as a documented recovery procedure. |
| `docs/llm-traffic-runbook.md` | Strip VPN_DOMAINS content. STEALTH_DOMAINS only. |
| `docs/troubleshooting.md` | Remove wgc1 sections. |
| `docs/stealth-channel-implementation-guide.md` | §6 acceptance: update "wgs1 peers active" → "wgs1 disabled"; add "no WG handshake in WAN pcap". |
| `docs/stealth-security-review-and-fixes.md` | Flag §2.6 Router OUTPUT and other items that referenced wgs1/wgc1 as "SUPERSEDED — Channel A decommissioned YYYY-MM-DD". |
| `docs/vpn-domain-journal.md` | Rename to `stealth-domain-journal.md` (or merge content into existing stealth docs); add redirect stub at old path. |

`docs/router-health-latest.md` auto-regenerates — no manual edit needed.

### Step 6.6 — Update top-level docs

#### `CLAUDE.md`

Update the Pipeline section to reflect single-channel (Reality only). Example new content:

```
## Project Context

**Router:** ASUS RT-AX88U Pro, Asuswrt-Merlin, BusyBox ash, aarch64
**Stealth transport:** VLESS+Reality to VPS VPS (198.51.100.10:443, SNI=gateway.icloud.com)
**Legacy (cold-fallback):** wgc1 WireGuard client to commercial VPN — NVRAM preserved,
  runtime disabled. Restore via scripts/emergency-enable-wgc1.sh.
**Pipeline:** LAN → dnsmasq ipset STEALTH_DOMAINS → iptables nat REDIRECT :<lan-redirect-port>
  → sing-box Reality client → VPS Caddy L4 → Xray → Internet (exit VPS IP).
```

Update "Key Files" and "Domain Addition Workflow" sections accordingly.

#### `README.md` / `README-ru.md`

Remove mentions of wgs1 as active; mention cold-fallback wgc1 if appropriate.

### Step 6.7 — Commit cleanup

```bash
git add -A
git commit -m "channel-a-decommission phase 6: cleanup artifacts, emergency script, docs"
./deploy.sh
ssh admin@<router> '
  service restart_firewall
  service restart_dnsmasq
  /jffs/scripts/router-health-report > /tmp/post-cleanup-health.txt
'
scp admin@<router>:/tmp/post-cleanup-health.txt .
# Review for any residual VPN_DOMAINS/wgc1/wgs1 references in output — should be zero.
```

---

## §10. Final verification (after Phase 6)

Complete acceptance — all must pass:

### 10.1 External port scan (from machine outside home network)

```bash
HOME_IP=<home WAN IP>
sudo nmap -sU -p 1-65535 --min-rate 100 $HOME_IP 2>&1 | \
  grep -E "^[0-9]+/udp.*open($|[^|])"
# expect: no output (no UDP open)

sudo nmap -sT -p 1-65535 --min-rate 500 $HOME_IP 2>&1 | \
  grep -E "^[0-9]+/tcp.*open"
# expect: only expected ports (none WG-related)
```

### 10.2 WAN 1-hour pcap

```bash
ssh admin@<router> '
  WAN_IF=$(nvram get wan0_ifname)
  timeout 3600 /opt/bin/tcpdump -i $WAN_IF -w /tmp/wan-1h.pcap -nn \
    "(udp and (udp[8:4] == 0x01000000 or udp[8:4] == 0x02000000 or udp[8:4] == 0x03000000 or udp[8:4] == 0x04000000))" 2>/dev/null &
  sleep 3610
  ls -la /tmp/wan-1h.pcap
  /opt/bin/tcpdump -r /tmp/wan-1h.pcap -nn | wc -l
'
# expect: 0 or near-0 (absolute minimum — tcpdump header overhead only)
```

### 10.3 LAN smoke test

See §7 Step 4.5 — all categories.

### 10.4 External Reality client

iPhone on mobile data, V2Box with the QR profile active:
```
curl https://ifconfig.me        # expect: 198.51.100.10
```

### 10.5 Local verification

```bash
./verify.sh                                              # all green
cd ansible && ansible-playbook playbooks/99-verify.yml   # all green
```

### 10.6 router-health-report

```bash
ssh admin@<router> '/jffs/scripts/router-health-report' | \
  grep -iE 'wgc1|wgs1|VPN_DOMAINS'
# expect: no hits (or only historical/cold-fallback references)
```

### 10.7 git diff vs baseline

```bash
git diff --stat pre-channel-a-decommission-<date>..HEAD
# sanity-check: count of changed files and lines should match expectations
# (deleted 2 configs, modified ~10 scripts and 12 docs, new 1 emergency script)
```

If all seven passes: **migration complete**. Record in decision log (§12).

---

## §11. Emergency rollback procedures

Three levels, in order of escalation:

### Level 1 — Phase-specific revert (during migration)

If a specific phase breaks something during the 24h observation window:
```bash
git revert <phase-N-commit>
./deploy.sh
ssh admin@<router> 'service restart_firewall; service restart_dnsmasq'
```

### Level 2 — Emergency wgc1 re-enable (after Phase 4)

If Reality/VPS fails and stays down:
```bash
ssh admin@<router> '/jffs/scripts/emergency-enable-wgc1.sh'
```

~30 seconds. Channel A resumes for STEALTH_DOMAINS traffic via cold-fallback NVRAM config. Reality stack remains configured but bypassed for marked traffic. No repo rollback needed.

### Level 3 — Full repo rollback

Nuclear option. Restore pre-decommission state entirely:
```bash
git reset --hard pre-channel-a-decommission-<date>
./deploy.sh
ssh admin@<router> '
  nvram set wgc1_enable=1
  nvram set wgs1_enable=1
  nvram commit
  service restart_wgc
  service restart_wgs
  service restart_firewall
  service restart_dnsmasq
'
```

~2 minutes. Back to dual-channel A+B as before.

---

## §12. Decision log (append during execution)

Append an entry to `docs/channel-a-decommission-implementation-guide.md` bottom when each phase completes:

```markdown
## Execution Log

### YYYY-MM-DD — Channel A decommission
- Initiator: <name>
- Baseline git tag: pre-channel-a-decommission-<date>
- Baseline NVRAM snapshot: ~/nvram-pre-decommission-<date>.txt
- Phase 0 (ZeroTier overlay): SKIPPED / COMPLETED on YYYY-MM-DD
- Phase 1 (domain unify): YYYY-MM-DD
- Phase 2 (LAN off wgc1): YYYY-MM-DD
- Phase 3 (wgs1 off): YYYY-MM-DD
- Phase 4 (wgc1 off): YYYY-MM-DD
- Rollback window end: YYYY-MM-DD (7 days after Phase 4)
- Emergency script tested in window: YYYY-MM-DD — result: <pass/fail>
- Phase 6 (cleanup): YYYY-MM-DD
- Final verification: YYYY-MM-DD
- Issues encountered: <none / list>
- Residual WG references removed: <count>
```

---

## §13. Non-goals (explicit)

Not done in this guide:

- **AS-mismatch (Apple SNI + VPS AS) mitigation** — requires Cloudflare Tunnel or SNI hosted in VPS's own AS. Separate plan.
- **Multi-VPS failover** — single VPS IP remains SPOF. Separate plan for warm second VPS.
- **Cascade exit (shared-pool commercial VPN on VPS)** — persona link via VPS exit IP persists. Separate plan.
- **Full removal of wgc1 NVRAM config** — explicitly refused; cold-fallback is forever.
- **Per-client granular revocation for Reality QRs** — uses the pattern in `docs/stealth-channel-implementation-guide.md`, not changed here.
- **Migration of maxtg_bridge Docker container** — coexists, unaffected.
- **Re-architecting STEALTH_DOMAINS granularity** — stays flat single-set for now.

---

## Appendix A — critical invariants for implementing LLM

1. **Phase order is non-negotiable.** Do not skip or reorder. Phase 2 must prove stable for 24h before Phase 3. Phase 4 must prove stable for 24h before Phase 5.
2. **7-day rollback window is part of the plan.** Skipping it is a procedural violation; migration is not complete without it.
3. **wgc1 NVRAM fields preserved forever.** Never run `nvram unset wgc1_*`. Only `wgc1_enable=0`.
4. **static-networks.txt / VPN_STATIC_NETS stay.** They're Channel B infrastructure, not Channel A.
5. **Every phase has a commit.** No phase-merging commits. Makes per-phase revert clean.
6. **WAN pcap verification after Phase 4 is mandatory.** Only reliable confirmation of "no WG handshake from home IP". Skipping it invalidates the security claim of this migration.
7. **External port scan must be from outside the home network.** Scanning from inside (e.g., from LAN) doesn't tell you what ISP/RKN sees.
8. **Do not proceed to Phase 6 until Phase 5's 7-day window is complete.** Cleanup before observation window risks losing debuggability.
9. **Emergency script tested in Phase 5** — the one chance to validate it before needing it in anger.
10. **maxtg_bridge container verified Up after each phase.** Its default-route and DNS path may interact with firewall changes.

---

## Appendix B — quick reference

### Commit labels (for git log traceability)

```
channel-a-decommission phase 1: reconcile stealth domain list
channel-a-decommission phase 1: domain-auto-add writes only STEALTH_DOMAINS
channel-a-decommission phase 2: unmark LAN traffic (no longer fwmark 0x1000)
channel-a-decommission phase 3: disable wgs1 WAN ingress + firewall hooks
channel-a-decommission phase 4: disable wgc1 runtime + remove fwmark 0x1000 routing
channel-a-decommission phase 6: cleanup artifacts, emergency script, docs
```

### One-liner status check after completion

```bash
ssh admin@<router> '
  echo "wgc1 enabled? $(nvram get wgc1_enable)"
  echo "wgs1 enabled? $(nvram get wgs1_enable)"
  echo "IPv6 service: $(nvram get ipv6_service)"
  echo "singbox SOCKS5: $(ss -tln "( sport = :1080 )" | grep -c 127.0.0.1)"
  echo "VPN_DOMAINS ipset: $(ipset list VPN_DOMAINS 2>&1 | head -1)"
  echo "STEALTH_DOMAINS ipset: $(ipset list STEALTH_DOMAINS 2>&1 | head -1)"
  echo "wgc1 interface: $(wg show wgc1 2>&1 | head -1)"
'
```

Expected steady state after migration:
```
wgc1 enabled? 0
wgs1 enabled? 0
IPv6 service: disabled
singbox SOCKS5: 1
VPN_DOMAINS ipset: ipset v7.x: The set with the given name does not exist
STEALTH_DOMAINS ipset: Name: STEALTH_DOMAINS
wgc1 interface: Unable to access interface: No such device
```
