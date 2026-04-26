# SNI Rotation Guide For Reality

**Audience:** future operator or LLM agent rotating Reality cover domains.
**Status:** critical rewrite of the original candidate note, 2026-04-25.
**Current default:** `gateway.icloud.com` is used for both visible Reality
surfaces unless explicitly changed.

This guide is deliberately conservative. The domain list below is a seed pool,
not an allow-list. A hostname is acceptable only after it passes the validation
gates in this document from the right vantage points.

---

## 0. Critical Context

### 0.1 SNI Is Not IP Camouflage

Reality can make the TLS handshake and active-probe behavior look like ordinary
HTTPS for the selected cover hostname. It does **not** make the remote IP or ASN
look like Apple, Cloudflare, or Microsoft.

Current user-facing consequences:

| Observer | What they can see |
|---|---|
| LTE operator for `iphone-*` QR clients | iPhone connects to the home Russian IP on TCP/<home-reality-port> |
| Home ISP | ASUS connects to the VPS IP on TCP/443, with the chosen cover SNI |
| Websites/checkers for managed domains | VPS exit IP, datacenter ASN |
| Websites for non-managed domains | Home Russian WAN IP |

Do not use a website checker result alone to judge the LTE-facing privacy story.
Checkers report the final exit, not the first hop seen by the mobile carrier.

### 0.2 There Are Two Reality SNI Surfaces Now

The old design had one external Reality endpoint. The current architecture has
two visible Reality layers:

```text
iPhone LTE
  -> home ASUS public IP :<home-reality-port>
  -> sing-box home Reality inbound
  -> managed split:
       managed destinations -> sing-box Reality outbound -> VPS host / Caddy / Xray
       other destinations   -> sing-box direct-out -> home WAN
```

| Surface | Path | Config owner | Client artifact impact |
|---|---|---|---|
| **Home ingress SNI** | iPhone/Mac -> ASUS `:<home-reality-port>` | `ansible/group_vars/routers.yml`: `home_reality_dest`, `home_reality_server_names` | Regenerate and redistribute `iphone-*` / `macbook` QR |
| **VPS outbound SNI** | ASUS -> VPS `:443` | `ansible/secrets/stealth.yml`: `reality_dest`, `reality_server_names` | Re-render router config; regenerate profiles so artifacts stay current |

Default operational rule: rotate both surfaces to the same accepted candidate
unless there is a deliberate reason to keep them different. If only the VPS
surface is rotated, LTE clients still present the old home-ingress SNI to the
mobile operator.

### 0.3 When To Rotate

Do **not** rotate randomly or on a short calendar cadence. Each rotation changes
behavior and creates redistribution work. Rotate on one of these triggers:

- current SNI shows throttling, RSTs, packet loss, or unusual latency from a RU
  vantage;
- the Xray/sing-box community reports that the hostname became adversarial;
- active-probe logs spike after a known burn event;
- annual review says the current candidate no longer matches device behavior.

---

## 1. Hard Rejection Rules

Reject a hostname immediately if any item below is true:

- It is owned by us, by a personal project, or publicly resolves to our VPS.
- It is a Russian local domain or a domain whose normal traffic is mostly
  Russia-only. The cover story becomes too inspectable and low-noise.
- It is already blocked or heavily throttled in the relevant RU networks.
- It is a VPN/proxy/checker/speedtest domain or community-popular Reality SNI.
- It is a niche hostname with little residential background traffic.
- It serves only HTTP/3/QUIC and has no reliable TCP HTTPS path.
- It requires client certificates, unusual auth at TLS level, or mTLS.
- The certificate SAN does not cover the hostname.
- The certificate or ALPN behavior changes per request in a way active probes
  could observe.
- The fallback HTTPS response from the VPS would be broken, reset, or obviously
  synthetic.

Never use:

```text
*.youtube.com, *.googlevideo.com      # target traffic itself; often throttled
*.facebook.com, *.instagram.com, *.fbcdn.net
*.twitter.com, *.x.com
*.ru, *.рф, yandex.*, vk.com, mail.ru
speedtest.net and similar checker/test domains
self-owned domains, sslip.io/nip.io domains pointing at our VPS
domains from old public Reality "best SNI" lists unless freshly revalidated
```

---

## 2. Acceptance Gates

A candidate must pass every hard gate before it can be considered.

| Gate | Required result | Why |
|---|---|---|
| DNS | Stable A/AAAA answers; no dependency on our VPS | Avoid self-linkage |
| TLS version | TLS 1.3 works over TCP/443 | Reality depends on TLS 1.3 shape |
| Key exchange | X25519 available | Matches Reality requirements |
| ALPN | `h2` or `http/1.1` available | Fallback probe must look normal over TCP |
| Certificate | SAN covers the exact hostname or valid wildcard | Active probing must not see mismatch |
| HTTP response | Any plausible 2xx/3xx/400/401/403 from fallback | RST/timeout is suspicious |
| VPS reachability | Works from VPS host | Xray fallback path depends on this |
| RU reachability | Works from the relevant RU ISP/mobile vantage | Avoid inheriting SNI throttling |
| Stability | Same broad cert/SAN/ALPN behavior over 24h | Avoid probe-vs-client mismatch |

Soft-score only after all hard gates pass:

| Axis | Good | Bad |
|---|---|---|
| Residential plausibility | Apple/iCloud, OS update, major CDN | obscure SaaS admin panel |
| Flow shape | long-lived sync or streaming-like HTTPS | one-shot marketing page |
| Background volume | common on phones/laptops in RU | rare in home traffic |
| ASN mismatch tolerance | hostname plausibly fronted/CDN-like | hostname strongly tied to one ASN |
| Operational blast radius | easy rollback, no client key rotation | requires key/UUID churn |

---

## 3. Candidate Pool

This pool is intentionally smaller and more skeptical than the original note.
Each row is a starting point for validation, not a pre-approved choice.

### 3.1 Primary Candidates

| Candidate | Why consider it | Caveats |
|---|---|---|
| `gateway.icloud.com` | Best current fit for Apple-device long-lived sync behavior; active default | Revalidate from RU and VPS before every rotation; do not assume Apple behavior is permanent |
| `www.icloud.com` | Apple background and user plausibility | More web-login/bursty than sync |
| `swdist.apple.com` | Apple software distribution; plausible bulk HTTPS | Burst-heavy, not always long-lived |
| `www.cloudflare.com` | Very common CDN/security brand, stable public TLS | Corporate-site traffic is bursty; ASN mismatch with VPS remains visible |
| `dash.cloudflare.com` | Long-lived dashboard pattern can be plausible | Requires care: logged-in dashboard traffic profile is not universal |
| `learn.microsoft.com` | Common docs portal, stable TLS shape historically | More bursty/static than long-lived |
| `www.microsoft.com` | Known rollback baseline | Not preferred as primary because generic corporate homepage does not match long-lived flows well |

### 3.2 Secondary / Research Candidates

Use these only if primary candidates fail validation or the flow profile is a
better match for a specific deployment.

| Candidate | Why consider it | Caveats |
|---|---|---|
| `appleid.apple.com` | Apple auth traffic is common on devices | Short auth bursts; less natural for persistent tunnels |
| `www.apple.com` | Universal Apple hostname | Marketing-site flow shape, not sync |
| `dl.google.com` | Common download/update traffic | Validate RU networks carefully; avoid all YouTube/Googlevideo hosts |
| `fonts.googleapis.com` | Extremely common indirect web dependency | Small bursty objects, not long-lived |
| `www.google.com` | High background volume | Search/SNI policies vary by region; validate RU vantage |
| `www.fastly.com` | CDN brand with stable TLS | Corporate hostname, lower personal-device background |
| `player.vimeo.com` | Video/player traffic can be long-flow | Lower ambient traffic than Apple/Google; validate reachability |
| `www.amazon.com` | Major consumer brand | Region redirects and bot defenses may change fallback behavior |
| `www.intel.com` | Inconspicuous corporate TLS | Low traffic volume |
| `www.nvidia.com` | Inconspicuous corporate TLS | Low traffic volume, bursty |

### 3.3 Deprecated From The Original Pool

- `docs.microsoft.com`: legacy hostname; prefer `learn.microsoft.com`.
- `blog.cloudflare.com`: acceptable for testing, but blog/static traffic is a
  weaker flow-shape match than `www.cloudflare.com` or `dash.cloudflare.com`.
- Any candidate justified only by "popular in Reality community": popularity is
  a negative signal after it becomes visible to DPI vendors.

---

## 4. Validator

Run this from the **VPS** and from at least one **RU vantage** before switching.
The VPS check verifies Reality fallback. The RU check verifies the SNI is not
already throttled or blocked where the traffic is observed.

Save temporarily as `/tmp/validate-sni-candidate.sh`:

```bash
#!/usr/bin/env bash
set -u

host="${1:?usage: $0 <hostname>}"
port="${2:-443}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail_count=0
ok() { printf '[ok] %s\n' "$*"; }
bad() { printf '[fail] %s\n' "$*"; fail_count=$((fail_count + 1)); }
info() { printf '[info] %s\n' "$*"; }

echo "== $host:$port =="

if dig +short A "$host" >/dev/null 2>&1 || dig +short AAAA "$host" >/dev/null 2>&1; then
  addrs="$({ dig +short A "$host"; dig +short AAAA "$host"; } 2>/dev/null | tr '\n' ' ')"
  [ -n "$addrs" ] && ok "DNS answers: $addrs" || bad "DNS returned no address"
else
  bad "DNS lookup failed"
fi

curl_code="$(
  curl -sS -I --connect-timeout 5 --max-time 12 \
    -o "$tmp/headers" -w '%{http_code} %{ssl_verify_result} %{time_connect}' \
    "https://$host/" 2>"$tmp/curl.err" || true
)"

if [ -n "$curl_code" ]; then
  set -- $curl_code
  http_code="${1:-000}"
  verify_result="${2:-999}"
  connect_time="${3:-999}"
  [ "$verify_result" = "0" ] && ok "curl cert verification OK" || bad "curl cert verify_result=$verify_result"
  case "$http_code" in
    2*|3*|400|401|403) ok "HTTP fallback response plausible: $http_code" ;;
    *) bad "HTTP fallback response suspicious: $http_code" ;;
  esac
  info "TCP connect time: ${connect_time}s"
else
  bad "curl failed: $(cat "$tmp/curl.err" 2>/dev/null)"
fi

openssl_out="$(
  echo | openssl s_client \
    -connect "$host:$port" \
    -servername "$host" \
    -tls1_3 \
    -groups X25519 \
    -alpn h2,http/1.1 \
    -showcerts 2>/dev/null || true
)"

printf '%s\n' "$openssl_out" | grep -q 'Protocol.*TLSv1.3' \
  && ok "TLS 1.3 confirmed" || bad "TLS 1.3 not confirmed"

printf '%s\n' "$openssl_out" | grep -qE 'Server Temp Key: X25519|X25519' \
  && ok "X25519 confirmed" || bad "X25519 not confirmed"

printf '%s\n' "$openssl_out" | grep -qE 'ALPN protocol: (h2|http/1.1)' \
  && ok "$(printf '%s\n' "$openssl_out" | grep 'ALPN protocol:' | tail -1)" \
  || bad "ALPN h2/http1.1 not confirmed"

cert_pem="$(printf '%s\n' "$openssl_out" | awk '/BEGIN CERTIFICATE/{p=1} p{print} /END CERTIFICATE/{exit}')"
cert_text="$(printf '%s\n' "$cert_pem" | openssl x509 -noout -text 2>/dev/null || true)"
san="$(printf '%s\n' "$cert_text" | sed -n '/Subject Alternative Name/,+2p')"
printf '%s\n' "$san" | grep -qiE "DNS:${host//./\\.}(,|$)|DNS:\\*\\.${host#*.}(,|$)" \
  && ok "SAN covers hostname" \
  || { bad "SAN does not obviously cover hostname"; printf '%s\n' "$san" | sed 's/^/  /'; }

issuer="$(printf '%s\n' "$cert_text" | awk -F'Issuer: ' '/Issuer:/ {print $2; exit}')"
subject="$(printf '%s\n' "$cert_text" | awk -F'Subject: ' '/Subject:/ {print $2; exit}')"
info "issuer: ${issuer:-unknown}"
info "subject: ${subject:-unknown}"

if [ "$fail_count" -eq 0 ]; then
  echo "== PASS $host =="
else
  echo "== FAIL $host ($fail_count failure(s)) =="
fi
exit "$fail_count"
```

Batch usage:

```bash
for h in \
  gateway.icloud.com \
  www.icloud.com \
  www.cloudflare.com \
  dash.cloudflare.com \
  learn.microsoft.com \
  www.microsoft.com \
  player.vimeo.com
do
  /tmp/validate-sni-candidate.sh "$h" || true
  echo
done
```

Stability check:

```bash
for i in 1 2 3 4; do
  date
  /tmp/validate-sni-candidate.sh gateway.icloud.com || true
  sleep 21600   # 6h
done
```

---

## 5. Rotation Modes

### 5.1 Rotate Both Surfaces

Use this when the current SNI is considered weak or burnt for the whole setup.
This is the default human procedure.

1. Validate the new hostname from VPS and RU vantage.
2. Edit VPS Reality settings:

   ```bash
   cd ansible
   ansible-vault edit secrets/stealth.yml
   # reality_dest: "<new-host>:443"
   # reality_server_names:
   #   - "<new-host>"
   ```

3. Edit home ingress settings:

   ```yaml
   # ansible/group_vars/routers.yml
   home_reality_dest: "<new-host>:443"
   home_reality_server_names:
     - "<new-host>"
   ```

4. Apply:

   ```bash
   ansible-playbook playbooks/10-stealth-vps.yml
   ansible-playbook playbooks/30-generate-client-profiles.yml
   ansible-playbook playbooks/20-stealth-router.yml
   ansible-playbook playbooks/99-verify.yml
   ```

5. Redistribute regenerated `iphone-*` / `macbook` QR PNGs.

### 5.2 Rotate Only VPS Outbound SNI

Use this when the home mobile ingress is healthy, but the home ISP path from
ASUS to VPS needs a different cover SNI.

Change only:

```yaml
# ansible/secrets/stealth.yml
reality_dest: "<new-host>:443"
reality_server_names:
  - "<new-host>"
```

Then:

```bash
ansible-playbook playbooks/10-stealth-vps.yml
ansible-playbook playbooks/30-generate-client-profiles.yml
ansible-playbook playbooks/20-stealth-router.yml
ansible-playbook playbooks/99-verify.yml
```

Mobile QR files do not need a first-hop address change, but regenerate them so
local artifacts reflect the exact deployed state.

### 5.3 Rotate Only Home Ingress SNI

Use this when LTE/mobile operator behavior is the concern, but ASUS -> VPS is
healthy.

Change only:

```yaml
# ansible/group_vars/routers.yml
home_reality_dest: "<new-host>:443"
home_reality_server_names:
  - "<new-host>"
```

Then:

```bash
ansible-playbook playbooks/30-generate-client-profiles.yml
ansible-playbook playbooks/20-stealth-router.yml
ansible-playbook playbooks/99-verify.yml --limit routers
```

Regenerate and redistribute mobile QR PNGs. The first hop remains the home IP,
but `sni=` in the mobile profiles changes.

---

## 6. Verification After Rotation

Repository checks:

```bash
./verify.sh
./scripts/router-health-report
cd ansible
ansible-playbook playbooks/99-verify.yml
```

Router live checks:

```sh
netstat -nlp 2>/dev/null | grep -E ':(<home-reality-port>|<lan-redirect-port>|<router-socks-port>) '
iptables -S INPUT | grep -- '--dport <home-reality-port>'
tail -100 /opt/var/log/sing-box.log
```

Expected:

- `0.0.0.0:<home-reality-port>` is `sing-box` home Reality ingress.
- `0.0.0.0:<lan-redirect-port>` is `sing-box` REDIRECT inbound.
- no `UDP/443 REJECT` rules for managed destinations.
- `iphone-*` logs show `inbound/vless[home-reality-in]` when mobile clients connect.

Observer sanity:

| Test | Expected |
|---|---|
| iPhone OneXray profile endpoint | home IP or home DNS name, not VPS IP |
| LTE operator-visible peer | home IP `:<home-reality-port>` |
| Website checker for managed domain | VPS exit IP |
| Local Russian site outside managed lists | home Russian WAN IP |

---

## 7. Rollback

Before switching, archive current QR artifacts outside git:

```bash
mkdir -p ansible/out/clients-backup-$(date +%Y%m%d-%H%M)
cp ansible/out/clients/*.png ansible/out/clients-backup-$(date +%Y%m%d-%H%M)/ 2>/dev/null || true
cp ansible/out/clients/*.conf ansible/out/clients-backup-$(date +%Y%m%d-%H%M)/ 2>/dev/null || true
```

Rollback is the inverse of the chosen rotation mode:

1. Restore previous `reality_dest` / `reality_server_names` in vault if VPS
   outbound changed.
2. Restore previous `home_reality_dest` / `home_reality_server_names` if home
   ingress changed.
3. Re-run the same playbooks from §5.
4. Redistribute previous or regenerated QR if home ingress changed.

No UUID or Reality key rotation is required for SNI-only rollback.

---

## 8. Decision Log Template

Append every production rotation here or in `docs/sni-rotation-log.md`.

```markdown
## YYYY-MM-DD — <new-host> (previous: <old-host>)

**Mode:** both surfaces / VPS only / home ingress only
**Trigger:** throttle / block / annual review / community burn notice / test
**Validator evidence:** VPS pass/fail, RU vantage pass/fail, 24h stability
**Candidates rejected:** host + reason
**Files changed:** vault, group_vars, generated QR, docs
**Rollout:** playbooks run, downtime, user impact
**Observer checks:** LTE endpoint, home ISP path, website checker exit
**Rollback point:** previous host and QR backup path
**Next review:** date
```

### 2026-04-24/25 — `gateway.icloud.com` (previous VPS SNI: `www.microsoft.com`)

**Mode:** both surfaces after home Reality ingress was introduced.
**Trigger:** hardening pass: Apple/iCloud has a better long-flow cover profile
than the previous generic Microsoft homepage baseline.
**Evidence:** local validation and live router checks passed; RU-vantage review
still recommended after any future rotation.
**Operational note:** mobile QR clients now connect first to home ASUS `:<home-reality-port>`;
website checkers report the VPS exit only for managed domains.
**Next review:** annual review or earlier if throttling/probing appears.

---

## 9. Quick Reference

Current intended defaults:

```yaml
# VPS outbound Reality surface
reality_dest: "gateway.icloud.com:443"
reality_server_names:
  - "gateway.icloud.com"

# Home ingress Reality surface
home_reality_dest: "gateway.icloud.com:443"
home_reality_server_names:
  - "gateway.icloud.com"
```

Most likely future candidates, in review order:

```text
gateway.icloud.com
www.icloud.com
swdist.apple.com
www.cloudflare.com
dash.cloudflare.com
learn.microsoft.com
www.microsoft.com
player.vimeo.com
dl.google.com
fonts.googleapis.com
```

One-line full redeploy after edits:

```bash
cd ansible &&
ansible-playbook playbooks/10-stealth-vps.yml &&
ansible-playbook playbooks/30-generate-client-profiles.yml &&
ansible-playbook playbooks/20-stealth-router.yml &&
ansible-playbook playbooks/99-verify.yml
```
