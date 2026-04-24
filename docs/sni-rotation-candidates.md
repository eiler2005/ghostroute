# SNI Rotation Candidates & Procedure for Reality

**Audience:** operator or LLM agent switching the Reality cover SNI when the current one gets throttled/blocked/burnt.
**Status:** procedure documented; active SNI switched to `gateway.icloud.com` on 2026-04-24.
**Primary goal:** keep Reality indistinguishable from legitimate high-volume HTTPS traffic on the RU-facing DPI profile.

---

## 0. Context

### 0.1 What Reality SNI does

Reality cover SNI is the TLS ServerName value sent by client on the ClientHello. It is what ISP/RKN DPI sees as "destination hostname". The real destination (anything the client actually wants to reach) is hidden inside the Reality-encrypted tunnel.

### 0.2 Why rotate

One SNI value = one point of behavioral fingerprint:
- If RKN starts throttling/blocking the selected SNI (e.g. Microsoft O365 broad throttling), Reality gets dragged into that throttle even though its content is different.
- If volume from one home IP to one SNI gets statistically odd (24/7 persistent flow to `www.microsoft.com` is atypical for a home user), DPI metadata analysis can flag.
- Community-popular Reality SNIs (e.g. `www.lovelive-anime.jp` in 2023–2024) drift into DPI-vendor block-lists over time.

Rotation schedule: **only on trigger**, not periodic. Triggers:
- Observed throttling of the current SNI in RU (high latency / packet loss / RST on specific flows).
- Public notice (Xray/V2ray community) that the SNI became DPI-adversarial.
- Yearly sanity review.

### 0.3 Current state

```yaml
# ansible/secrets/stealth.yml (vault)
reality_dest: "gateway.icloud.com:443"
reality_server_names:
  - "gateway.icloud.com"
```

`gateway.icloud.com` is the active choice as of 2026-04-24. `www.microsoft.com` remains acceptable as a rollback baseline despite selective MS-targeted throttling in RU, but it is no longer the preferred long-flow cover.

### 0.4 Impact of a rotation

- All 8 client profiles (router + 6 iPhone + 1 MacBook) must be **regenerated and redistributed** (new `sni=` and `pbk=` parameters; public key does not change, only SNI does — but short_id and utls params stay the same; still, the full VLESS URI differs, so QR is new).
- Router `sing-box` config is re-rendered by Ansible; ~5 sec service restart.
- Any existing sessions drop; users reconnect automatically if app is configured to reconnect.
- Downtime on router-side stealth channel: ~10 sec.
- External clients (iPhone, MacBook): require manual re-import of new QR.

---

## 1. Hard requirements for any Reality SNI

Any candidate **must** satisfy ALL of these. Validation commands in §3.

| Requirement | Why |
|---|---|
| Serves real TLS 1.3 | Reality requires TLS 1.3 ClientHello shape. |
| Supports X25519 key exchange | Required by Xray Reality. |
| Cert CN / SAN matches the hostname | Active probing from RKN would expose a mismatch. |
| Reachable from VPS VPS (outbound HTTPS) | Reality fallback proxies to `dest` for non-matching handshakes; if unreachable, active probe gets TCP RST → detectable. |
| Does **not** require mTLS / client certificate | Xray fallback cannot present a client cert. |
| Advertises HTTP/1.1 or HTTP/2 ALPN (not HTTP/3-only) | Reality runs over TCP; must have a valid HTTP over TCP path. |
| Stable: same cert served consistently, no geographical cert rotation per-request | Avoid probe-vs-client cert mismatch. |
| Not itself throttled/blocked in RU | Otherwise Reality inherits the throttle. |
| Not on known VPN/Reality-adversary SNI-blocklists | See §6 for signal sources. |

---

## 2. Candidate pool (20 domains)

Grouped by "cover traffic profile" — pick candidates whose normal-user traffic pattern matches yours (lots of persistent HTTPS vs. short bursts).

### 2.1 Tier A — Apple ecosystem (5)

Rationale: iPhone/iPad/Mac are ubiquitous in RU. Every device constantly hits these. Very high background noise volume per residential line. Apple infrastructure in RU works stably in 2025.

| # | Domain | Cover traffic profile | Notes |
|---|--------|-----------------------|-------|
| 1 | `gateway.icloud.com` | iCloud sync (persistent, long-lived) | **Top pick** — iPhone holds persistent connection, matches Reality's long TCP flow perfectly. |
| 2 | `www.icloud.com` | Web iCloud | Bursty on login. |
| 3 | `appleid.apple.com` | Auth endpoint | Short bursts; less ideal for long flows. |
| 4 | `swdist.apple.com` | Software distribution | Heavy downloads; good for bulk traffic. |
| 5 | `www.apple.com` | Corporate site | Generic but universal. |

### 2.2 Tier B — Microsoft ecosystem (4)

Rationale: Office 365 / OneDrive / Teams still widely used in RU enterprise. Current selection.

| # | Domain | Cover traffic profile | Notes |
|---|--------|-----------------------|-------|
| 6 | `www.microsoft.com` | Corporate site | Previous baseline / rollback candidate. |
| 7 | `learn.microsoft.com` | Docs portal | Static-heavy, steady traffic profile. |
| 8 | `update.microsoft.com` | Windows Update | Burst downloads; check it actually responds to GET / (WU endpoints sometimes return 403 at root — still works for Reality probe-fallback, but check). |
| 9 | `docs.microsoft.com` | Legacy docs redirect | Redirects to learn.microsoft.com but TLS itself is valid. |

### 2.3 Tier C — Cloudflare (3)

Rationale: Cloudflare fronts 20%+ of RU internet traffic. Excellent ambient noise. Cloudflare itself is not systematically blocked in RU as of 2026-01.

| # | Domain | Cover traffic profile | Notes |
|---|--------|-----------------------|-------|
| 10 | `www.cloudflare.com` | Corporate site | Strong candidate. |
| 11 | `dash.cloudflare.com` | User dashboard | Logged-in traffic pattern. |
| 12 | `blog.cloudflare.com` | Blog / static | Very stable, high TLS 1.3 compliance. |

### 2.4 Tier D — Google (3)

Rationale: When available (region/ISP-dependent), Google edges carry enormous generic HTTPS volume. **WARNING:** some RU regions see selective Google throttling; validate from RU vantage before switching.

| # | Domain | Cover traffic profile | Notes |
|---|--------|-----------------------|-------|
| 13 | `dl.google.com` | Download CDN | Heavy bursts; works well. |
| 14 | `www.google.com` | Search | Ubiquitous; check for regional throttling. |
| 15 | `fonts.googleapis.com` | Font CDN | Called from millions of sites → indirect use. |

### 2.5 Tier E — Major tech corporate (3)

| # | Domain | Cover traffic profile | Notes |
|---|--------|-----------------------|-------|
| 16 | `www.amazon.com` | Retail | Very high user volume; AWS-hosted, stable TLS 1.3. |
| 17 | `www.intel.com` | Corporate | Low-volume but inconspicuous. |
| 18 | `www.nvidia.com` | Corporate | Low-volume, low attention. |

### 2.6 Tier F — Alternative CDNs (2)

| # | Domain | Cover traffic profile | Notes |
|---|--------|-----------------------|-------|
| 19 | `www.fastly.com` | CDN corporate | Stable; backs Reddit, NYT, etc. |
| 20 | `player.vimeo.com` | Video player endpoint (Fastly-hosted) | Persistent streaming flows; matches Reality's long-flow pattern well. |

### 2.7 Explicit NO-candidates (do not use)

- **Any `*.youtube.com`, `*.googlevideo.com`** — heavily throttled in RU.
- **Any `*.facebook.com`, `*.instagram.com`, `*.fbcdn.net`** — blocked in RU.
- **Any `*.twitter.com`, `*.x.com`** — blocked.
- **Any Russian domain (`*.ru`, `*.рф`, Yandex, VK, Mail.ru)** — under RKN direct inspection cooperation, avoid.
- **`www.lovelive-anime.jp`** — burnt since ~2023, in most DPI Reality-SNI blocklists.
- **`www.tesla.com`, `www.speedtest.net`** — historically community-popular, now moderately adversarial (speedtest in particular: some ISPs run DPI on speedtest to suppress ban-evidence).
- **Netflix, Disney+, Hulu endpoints** — blocked / geo-unreachable from RU, fallback probes would fail.
- **Self-owned domains or anything pointing to VPS VPS IP publicly** — see security review §1.3.

---

## 3. Per-candidate validation (run before switching)

All commands run **on the VPS VPS** (reachability from VPS is what matters for Reality fallback). Additionally, run **a subset** from a Russian vantage (someone's mobile or a Russia-hosted VM) to validate RU-accessibility.

### 3.1 One-shot validator script

Save as `ansible/scripts/validate-sni-candidate.sh`. Run: `./validate-sni-candidate.sh <hostname>`.

```bash
#!/usr/bin/env bash
# Validate a single SNI candidate for Reality use.
# Exit 0 = suitable; non-zero = fails some criterion.

set -u
HOST="${1:?usage: $0 <hostname>}"
PORT=443
TMP=$(mktemp -d); trap "rm -rf $TMP" EXIT

pass() { printf "  [ok]  %s\n" "$*"; }
fail() { printf "  [FAIL] %s\n" "$*"; EXIT_CODE=1; }

EXIT_CODE=0
echo "== Validating $HOST:$PORT =="

# 3.1.1 HTTPS reachability + certificate verification via curl.
# TLS 1.3 + X25519 are checked below with openssl because macOS curl may list
# TLS flags that its linked libcurl cannot actually execute.
if curl -sI --max-time 10 "https://$HOST/" \
     -o "$TMP/headers" -w "%{http_code} %{ssl_verify_result}\n" > "$TMP/curl" 2>"$TMP/err"; then
  read -r CODE VERIFY < "$TMP/curl"
  if [[ "$VERIFY" == "0" ]]; then
    pass "HTTPS reachability OK, cert verified, HTTP $CODE"
  else
    fail "TLS cert verify failed (verify_result=$VERIFY)"
  fi
  # Accept any 2xx/3xx/400/401/403 — just need the server to respond
  if [[ "$CODE" =~ ^(2|3|400|401|403) ]]; then
    pass "HTTP response acceptable ($CODE)"
  else
    fail "HTTP response unacceptable ($CODE)"
  fi
else
  fail "curl failed: $(cat "$TMP/err")"
fi

# 3.1.2 Detailed TLS inspection via openssl
OPENSSL_OUT=$(echo | openssl s_client -connect "$HOST:$PORT" -servername "$HOST" \
  -tls1_3 -groups X25519 -alpn h2,http/1.1 -showcerts 2>/dev/null)

if echo "$OPENSSL_OUT" | grep -q "Protocol.*TLSv1.3"; then
  pass "Confirmed TLSv1.3 protocol"
else
  fail "TLSv1.3 not confirmed"
fi

if echo "$OPENSSL_OUT" | grep -qE "Server Temp Key.*X25519|X25519"; then
  pass "X25519 key exchange confirmed"
else
  fail "X25519 not confirmed"
fi

# ALPN: must be http/1.1 or h2
if echo "$OPENSSL_OUT" | grep -qE "ALPN protocol:.*(h2|http/1.1)"; then
  pass "ALPN OK: $(echo "$OPENSSL_OUT" | grep 'ALPN protocol')"
else
  fail "ALPN not h2 or http/1.1 (probably HTTP/3-only)"
fi

# Cert subject check: CN or SAN must match hostname
CERT_PEM=$(echo "$OPENSSL_OUT" | awk '/BEGIN CERTIFICATE/{flag=1} flag{print} /END CERTIFICATE/{exit}')
CERT_SUBJECTS=$(echo "$CERT_PEM" | openssl x509 -noout -text 2>/dev/null | sed -n '/Subject Alternative Name/,+2p' || true)
if echo "$CERT_SUBJECTS" | grep -qiE "(^|[^.])$HOST([^a-z]|$)|\*\.$(echo "$HOST" | cut -d. -f2-)"; then
  pass "Cert SAN covers $HOST"
else
  fail "Cert SAN does not obviously cover $HOST — inspect manually"
  echo "$CERT_SUBJECTS" | sed 's/^/      /'
fi

# No session ticket (reduces probe replay) — optional
if echo "$OPENSSL_OUT" | grep -q "TLS session ticket:"; then
  echo "  [info] server issues TLS session tickets (acceptable for Reality, not optimal)"
fi

# 3.1.3 Latency sample (for fallback-timing concerns)
LATENCY_MS=$(curl -s -o /dev/null -w "%{time_connect}\n" --max-time 10 "https://$HOST/" \
             | awk '{print int($1*1000)}')
if [[ -n "$LATENCY_MS" && "$LATENCY_MS" -lt 500 ]]; then
  pass "TCP connect latency ${LATENCY_MS}ms (reasonable)"
else
  fail "TCP connect latency ${LATENCY_MS}ms (too high or unreachable)"
fi

echo "== $HOST: $([ $EXIT_CODE -eq 0 ] && echo PASS || echo FAIL) =="
exit $EXIT_CODE
```

Usage:
```
chmod +x ansible/scripts/validate-sni-candidate.sh
scp ansible/scripts/validate-sni-candidate.sh deploy@<vps>:/tmp/
ssh deploy@<vps> 'for h in gateway.icloud.com www.cloudflare.com www.apple.com; do
  /tmp/validate-sni-candidate.sh "$h" || true; echo
done'
```

### 3.2 RU-vantage check (optional but recommended)

If rotation is triggered by RU-specific throttling, also run the validator from a Russian mobile network or RU-located VM:
```
ssh russian-vm 'bash -s' < ansible/scripts/validate-sni-candidate.sh www.microsoft.com
```
Look for:
- Latency spikes > 500ms or packet loss — indicates ISP-level throttling of that SNI.
- HTTP status != 2xx/3xx — indicates blocking.

### 3.3 Cert-rotation stability check

Over 24 hours, re-run validator a few times. The cert issuer + SAN should stay the same. If SAN changes per-request (some enterprise LBs rotate certs dynamically), skip the candidate.

---

## 4. Switch procedure (Ansible-driven)

### 4.1 Prerequisites

- New SNI candidate has passed §3 validation from both VPS and (ideally) RU vantage.
- Communication channel ready to push new QR to 7 external clients (Signal / AirDrop).
- Maintenance window — ~10 min of stealth-channel downtime acceptable.

### 4.2 Step-by-step

```bash
cd router_configuration/ansible

# 4.2.1 Edit the vault — change both fields consistently
ansible-vault edit secrets/stealth.yml
#   reality_dest: "<new-host>:443"
#   reality_server_names:
#     - "<new-host>"

# 4.2.2 Preview — dry-run the VPS playbook to see diff
ansible-playbook playbooks/10-stealth-vps.yml --check --diff

# 4.2.3 Apply to VPS (updates Xray Reality inbound + Caddy L4 matcher)
ansible-playbook playbooks/10-stealth-vps.yml

# 4.2.4 Sanity check from the VPS itself
ssh deploy@<vps> "/tmp/validate-sni-candidate.sh <new-host>"

# 4.2.5 External handshake check (from your laptop)
curl -sk --resolve <new-host>:443:<vps-ip> --max-time 10 -I "https://<new-host>/"
#    Expect: HTTP response with cert CN/SAN matching <new-host>

# 4.2.6 Regenerate router + client profiles (pulls new SNI from vault)
ansible-playbook playbooks/30-generate-client-profiles.yml

# 4.2.7 Push new router config via regular router playbook
ansible-playbook playbooks/20-stealth-router.yml

# 4.2.8 Router-side verify
ansible-playbook playbooks/99-verify.yml --limit routers

# 4.2.9 Test from LAN
#   From LAN client: curl https://ifconfig.me   (or whatever test domain is in STEALTH_DOMAINS)
#   Expect: VPS VPS IP

# 4.2.10 Redistribute QR codes to 7 external clients
ls ansible/out/clients/*.png
#   Distribute over Signal / AirDrop only. Do not commit.
```

### 4.3 What changes and what does not

| Changes | Stays the same |
|--------|---------------|
| `reality_dest` in vault | `reality_server_private_key` (the Reality keypair) |
| `reality_server_names[0]` in vault | `reality_server_public_key` |
| Every client's `sni=` in VLESS URI | Every client's UUID |
| Every client's QR PNG | `reality_short_ids` (each client's short_id stays) |
| Router `/opt/etc/sing-box/config.json` | Xray inbound ID, 3x-ui panel |

This means: **no key rotation, no UUID churn, clients keep their identity**. Only the cover SNI changes.

### 4.4 Parallel rollout (safer variant)

If downtime concerns matter: keep old inbound running temporarily and add new inbound on a different port (e.g., 127.0.0.1:8444) with the new SNI, route via Caddy L4 with a new `@matcher`:

```
# /etc/caddy/Caddyfile (L4 block, add)
@reality_new tls sni <new-host>
route @reality_new { proxy 127.0.0.1:8444 }
```

Then migrate clients gradually. **Not needed for MVP**; stick with the atomic cutover in §4.2 unless scale justifies.

---

## 5. Rollback

If after switch (§4.2) something is broken (handshakes failing, Reality fallback 502s, etc.):

```bash
cd router_configuration/ansible

# 5.1 Revert vault to previous SNI
ansible-vault edit secrets/stealth.yml
#   reality_dest: "www.microsoft.com:443"     # or previous known-good
#   reality_server_names:
#     - "www.microsoft.com"

# 5.2 Re-apply VPS
ansible-playbook playbooks/10-stealth-vps.yml

# 5.3 Re-generate profiles and push router
ansible-playbook playbooks/30-generate-client-profiles.yml
ansible-playbook playbooks/20-stealth-router.yml

# 5.4 Redistribute QR for reverted SNI to clients
```

Total rollback time: ~5 min. Clients need new QR again.

**Tip:** right before a switch, archive `ansible/out/clients/*.png` → `ansible/out/clients-backup-<date>/` so rollback does not require regenerating QR for the previous SNI.

```bash
mkdir -p ansible/out/clients-backup-$(date +%Y%m%d-%H%M)
cp ansible/out/clients/*.png ansible/out/clients-backup-$(date +%Y%m%d-%H%M)/
```

---

## 6. Decision framework — evaluating NEW candidates

When the pool in §2 is exhausted or a new candidate appears, evaluate against:

### 6.1 Signal sources (check before adopting)

- [Xray / sing-box community discussions](https://github.com/XTLS/Xray-core/discussions) — search for `SNI` and the candidate hostname.
- V2Ray / Xray Russian Telegram channels (`@projectxray_ru`, `@v2rayN_official`) for current DPI reports.
- [Censored Planet](https://censoredplanet.org/) + [OONI Explorer](https://explorer.ooni.org/) — check if the hostname shows anomalies in RU measurements.

### 6.2 Evaluation matrix

For each candidate, score 0–5 on each axis; accept if total ≥ 24/30:

| Axis | Max | How to score |
|------|-----|--------------|
| Passes §3 validator | 5 | 5 if clean pass, 0 if any fail |
| RU-accessible without throttling | 5 | 5 if RU-vantage §3.2 shows normal, 0 if blocked |
| Background traffic volume in RU | 5 | 5 for Apple/MS/Cloudflare-level; 2 for niche; 0 for self-owned |
| Cert/TLS stability over 24h | 5 | 5 same cert always; 2 if rotates geo-region; 0 if per-request rotation |
| Not on DPI adversary lists (§6.1) | 5 | 5 if no mentions; 0 if burnt |
| Cover-traffic profile matches Reality (long-lived TCP) | 5 | 5 for persistent services (iCloud sync, dash panels); 2 for bursty; 0 for one-shot |

### 6.3 Reject if ANY of:

- Hostname owned by user personally (SNI enumeration risk, see security review §1.3).
- Hostname shares an IP range already known to host VPN endpoints.
- Hostname returns HTTP 3xx to a different hostname (redirect target could leak via `Server` header differences under probing).
- Hostname has mandatory HTTP/3 (TCP/HTTP1.1-HTTP2 unavailable).
- Hostname serves an Extended Validation cert with distinctive OID (less "generic" looking).

---

## 7. Post-switch monitoring (first 72 hours)

After a switch, watch for:

### 7.1 VPS side

```bash
ssh deploy@<vps> 'docker exec xray tail -f /var/log/xray/access.log' | \
  grep -iE 'rejected|fallback|error'
```

Expected: zero errors after warm-up. Many `rejected: fallback to ...` = active probing hitting wrong key (normal, Reality is doing its job). Spike of probing = someone scanning your IP; investigate.

### 7.2 Router side

- `ss -Htn state established '( dport = :443 )' | wc -l` — should show at least 1 long-lived connection to VPS IP.
- `cat /proc/net/nf_conntrack | grep -c '<vps-ip>'` — count active conntrack entries.
- `tail -F /opt/var/log/sing-box.log` — zero handshake failures.

### 7.3 LAN clients

- Spot-check 3–4 stealth domains from different devices.
- Measure latency: `curl -w '%{time_total}\n' -so /dev/null https://<stealth-test-domain>/` before and after — should be within ±50ms.

### 7.4 RU vantage check

Re-run §3.2 from RU vantage 24h after switch. Confirm no throttling appeared.

---

## 8. Decision log (append-only)

Whoever performs a rotation must append an entry here (or in a sibling `docs/sni-rotation-log.md`). Format:

```
## YYYY-MM-DD  —  <new SNI>  (previous: <old SNI>)

**Trigger:** <why rotated — throttle observed / community burn notice / yearly review>
**Validator results:** <pass/fail per §3; attach RU-vantage evidence if any>
**Candidates considered:** <list with scores from §6.2>
**Rollout:** <downtime observed; any issues>
**Clients redistributed:** <date; method: Signal / AirDrop / in-person>
**Monitoring window (72h):** <observations>
**Next review:** <date>
```

Keep the log. It is itself a signal of "which SNIs have been used from this setup" — useful for future threat-model updates.

### 2026-04-24 — `gateway.icloud.com` (previous: `www.microsoft.com`)

**Trigger:** Hardening pass from `docs/stealth-security-review-and-fixes.md` §2.1. No evidence that `www.microsoft.com` was burnt, but Apple iCloud is a better long-flow cover for Reality.
**Validator results:** Local validator PASS for `gateway.icloud.com`: HTTPS reachable, cert verified, TLS 1.3, X25519, ALPN `h2`, SAN covers hostname, connect latency < 500 ms. RU-vantage validation still recommended for 24h follow-up.
**Candidates considered:** `gateway.icloud.com` primary; `www.cloudflare.com` fallback if Apple validation fails; `player.vimeo.com` fallback for long-flow behavior with less ambient Apple traffic.
**Rollout:** Vault SNI updated; local client profiles regenerated; router playbook applied; VPS Caddy active probe returns real Apple fallback for `gateway.icloud.com`.
**Clients redistributed:** Pending operator distribution of regenerated QR PNGs from `ansible/out/clients/`.
**Monitoring window (72h):** Started 2026-04-24; watch VPS/Xray logs, router conntrack, and LAN smoke tests.
**Next review:** 2026-04-25 for RU-vantage and 72h stability check.

---

## 9. Appendix — Quick reference

### 9.1 Current SNI as of last edit

```
reality_dest:         gateway.icloud.com:443
reality_server_names: [gateway.icloud.com]
```

### 9.2 Quick-swap one-liner (after vault edit)

```bash
cd ansible && ansible-playbook playbooks/10-stealth-vps.yml \
  && ansible-playbook playbooks/30-generate-client-profiles.yml \
  && ansible-playbook playbooks/20-stealth-router.yml \
  && ansible-playbook playbooks/99-verify.yml
```

### 9.3 Candidate pool (compact)

```
# Tier A — Apple
gateway.icloud.com      # TOP: matches long-flow profile
www.icloud.com
appleid.apple.com
swdist.apple.com
www.apple.com

# Tier B — Microsoft
www.microsoft.com       # previous baseline / rollback
learn.microsoft.com
update.microsoft.com
docs.microsoft.com

# Tier C — Cloudflare
www.cloudflare.com
dash.cloudflare.com
blog.cloudflare.com

# Tier D — Google (validate RU access first)
dl.google.com
www.google.com
fonts.googleapis.com

# Tier E — Tech brands
www.amazon.com
www.intel.com
www.nvidia.com

# Tier F — CDN alternatives
www.fastly.com
player.vimeo.com        # persistent-flow profile
```

### 9.4 Forbidden (do NOT use — §2.7)

```
*.youtube.com, *.googlevideo.com     # RU throttled
*.facebook.com, *.instagram.com      # RU blocked
*.twitter.com, *.x.com               # RU blocked
*.ru, *.рф, yandex.*, vk.com, mail.ru  # under RKN cooperation
www.lovelive-anime.jp                # burnt ~2023
www.tesla.com, www.speedtest.net     # community-known, adversarial
Netflix/Disney+/Hulu endpoints       # geo-unreachable from RU
Any domain resolvable to VPS VPS IP publicly  # SNI-enum leak
```
