# Client Profiles And QR Codes

VLESS/Reality client profiles are generated locally from `ansible-vault`.

## Where These Clients Fit

QR/VLESS clients are one endpoint-managed path in the layered routing model:

```text
Endpoint outside home
  -> QR/VLESS profile in a client app
  -> home ASUS public IP / :<home-reality-port>
  -> sing-box home Reality inbound
  -> managed split:
       STEALTH_DOMAINS/VPN_STATIC_NETS -> sing-box Reality outbound -> VPS host
       other destinations              -> sing-box direct-out -> home WAN
```

They connect to the ASUS router first. This is deliberate: the first network sees
the remote device connecting to the home endpoint, not directly to VPS.
The final website/checker sees VPS only when its domain/IP is managed. A
non-managed destination sees the home WAN IP.

This is the expected split:

| Observer | Sees |
|---|---|
| First network | Remote device -> home endpoint `:<home-reality-port>` |
| Home ISP | ASUS router -> VPS Reality endpoint |
| Website/checker for managed domains | VPS exit IP / datacenter ASN |
| Website for non-managed domains | Home WAN IP |

Do not use generic checker results alone to judge the LTE-facing path. A checker
reports the final website-facing exit IP, not the first hop that the mobile
network observes.

## Endpoint / Client-Side Routing Layer

Generated profiles are only one part of the endpoint behavior. Some endpoint
clients can also load a config file that acts as Layer 0 routing policy before
traffic reaches Channel A/B/C.

Generic production policy:

```text
local/private/captive/trusted domestic -> DIRECT
foreign/non-local/unknown/selected     -> MANAGED/PROXY
FINAL                                  -> MANAGED/PROXY
```

Shadowrocket on iPhone/iPad/MacBook is the main current example. A
Shadowrocket config can use domain, IP, GEOIP and rule lists to choose
`DIRECT` or `PROXY/MANAGED`; that config is an endpoint routing layer, not just
a VPN on/off switch. Other endpoint clients may implement the same idea with
different UI labels or rule syntax.

### Shadowrocket Proof Config For Channels A/B/C

For GhostRoute channel proof tests, use one shared Shadowrocket Config for all
three Shadowrocket-imported lanes:

```ini
[General]
bypass-system = false
ipv6 = false
prefer-ipv6 = false
dns-server = https://1.1.1.1/dns-query, https://cloudflare-dns.com/dns-query
fallback-dns-server = https://1.1.1.1/dns-query, https://cloudflare-dns.com/dns-query
dns-fallback-system = false
dns-direct = false
hijack-dns = :53
udp-policy-not-supported-behaviour = REJECT

[Rule]
FINAL,PROXY
```

Generated location:

```text
ansible/out/shadowrocket-proof/ghostroute-shadowrocket-proof.conf
```

This file is imported as a Shadowrocket **Config file**, not as a server
subscription QR. Shadowrocket subscription/QR import expects server URLs; when
given a full `[General]`/`[Rule]` config it may fail with `cannot fetch subs
servers` or import with warnings. Use the Config import UI or the Files share
sheet.

The generator also writes a daily-use template:

```text
ansible/out/shadowrocket-proof/ghostroute-shadowrocket-daily-template.conf
```

Use the strict proof config for BrowserLeaks and channel proof. Use the daily
template for normal phone use where banking apps or corporate services need
local/system DNS and narrow direct exceptions. Gmail SMTP/IMAP is intentionally
not managed in the router catalog, and the daily Shadowrocket template also
forces `smtp.gmail.com` and `imap.gmail.com` to `DIRECT` because iOS Mail
SMTP/IMAP ports can time out through the VPS/Reality egress.

The proof config is shared because the Shadowrocket layer should only own the
first hop:

```text
Shadowrocket proof config = endpoint Layer 0 policy
Channel A/B/C server      = selected transport/server profile
Router managed split      = direct-vs-Reality decision
```

During a proof, select the same config and switch only the active server:

```text
Channel A Reality server       -> PROXY
Channel B XHTTP server         -> PROXY
Channel C1-Shadowrocket server -> PROXY
```

The proof config is deliberately universal. Do not add special BrowserLeaks or
ipify rules for the proof itself. `FINAL,PROXY` sends arbitrary checker domains
to the selected GhostRoute server, while explicit DoH, DNS fallback/hijack,
`dns-direct = false`, and UDP/IPv6 fail-closed settings keep resolver and QUIC
behavior from silently falling back to the hotel, LTE, or system network.

Expected canaries:

```text
https://api.ipify.org   -> VPS IP
http://api.ipify.org    -> VPS IP
https://api64.ipify.org -> VPS IP or blocked/timeout, but not LTE provider IP
```

Router proof should show:

```text
inbound/vless[reality-in]: [iphone-N] inbound connection to api.ipify.org:443
outbound/vless[reality-out]: outbound connection to api.ipify.org:443
```

For Channel C1-Shadowrocket, the inbound changes to
`channel-c-shadowrocket-http-in`, but the post-ingress rule is the same:
managed canaries continue to `reality-out`.

#### Why The Geo/RU Shadowrocket Config Is Wrong For Proofs

Generic Shadowrocket geo configs are designed for client-side split routing:
Russian sites/direct IPs go `DIRECT`, and everything else goes `PROXY`. That is
not the GhostRoute proof model. In GhostRoute, the iPhone should first reach the
home router; then the router decides whether a destination is managed or direct.

Avoid these settings in proof configs:

```ini
bypass-system = true
skip-proxy = *.ru,*.su,*.рф
GEOIP,RU,DIRECT
RULE-SET,...,DIRECT
fallback-dns-server = ...,system
always-real-ip = *
```

Problems they caused or can cause:

- `bypass-system = true` lets some iOS/system traffic bypass the proxy.
- `GEOIP,RU,DIRECT`, `*.ru DIRECT` and broad `skip-proxy` move the
  direct-vs-managed decision back to the phone instead of the router.
- `fallback-dns-server = system` can fall back to the LTE/system resolver.
- `always-real-ip = *` reduces fake-IP/tunnel ownership and can make the
  client resolve real IPs before the router sees the flow.
- `private-ip-answer = true` can be useful on ordinary LAN configs, but for
  proof mode it can also encourage local/private answers to be treated as
  direct/local. Leave it out unless a specific local-LAN workflow needs it.

Strict DNS/UDP settings that must stay in proof configs:

- `dns-server = ...` and `fallback-dns-server = ...` avoid implicit system DNS.
- `dns-direct = false` asks Shadowrocket to avoid sending DNS outside the
  selected proxy path when the client build supports the key.
- `hijack-dns = :53` catches plain DNS before it reaches the system network.
- `dns-fallback-system = false` prevents system resolver fallback.
- `udp-policy-not-supported-behaviour = REJECT` makes unsupported UDP fail
  closed instead of silently going direct.

These are part of the shared strict proof config because DNS leak tests use
arbitrary hostnames, not only the page domain already present in
`STEALTH_DOMAINS`. If an older minimal config is needed for transport-only
debugging, generate or edit it as a one-off and label the result clearly so it
is not reused for leak proof.

### Shadowrocket Daily Template

The daily template intentionally trades BrowserLeaks purity for application
compatibility:

```ini
[General]
bypass-system = false
ipv6 = false
prefer-ipv6 = false
dns-server = system
fallback-dns-server = system
dns-fallback-system = false
hijack-dns = :53
udp-policy-not-supported-behaviour = REJECT

[Rule]
DOMAIN-SUFFIX,vtb.ru,DIRECT
DOMAIN,ip-check-perf.radar.cloudflare.com,DIRECT
DOMAIN-SUFFIX,radar.cloudflare.com,DIRECT
DOMAIN-SUFFIX,app-analytics-services-att.com,DIRECT
DOMAIN-SUFFIX,app-measurement.com,DIRECT
DOMAIN-SUFFIX,firebaseinstallations.googleapis.com,DIRECT
DOMAIN-SUFFIX,sentry.io,DIRECT
DOMAIN-SUFFIX,app-site-association.cdn-apple.com,DIRECT
DOMAIN-SUFFIX,mzstorekit.itunes.apple.com,DIRECT
DOMAIN-SUFFIX,iosapps.itunes.apple.com,DIRECT

DOMAIN,smtp.gmail.com,DIRECT
DOMAIN,imap.gmail.com,DIRECT

# Keep real corporate/private direct exceptions local.
# DOMAIN-SUFFIX,corp.example.invalid,DIRECT
# DOMAIN-KEYWORD,corp-keyword,DIRECT

FINAL,PROXY
```

Do not commit real corporate domains or private hostnames to this repository.
Add those direct exceptions only in the locally imported Shadowrocket Config.

## Mobile App Configuration (Critical) — OneXray

Every Home Reality mobile profile must be checked in OneXray before judging LTE
speed or reliability. Server-side tuning cannot compensate for a client profile
that enables incompatible transport features.

Open the imported Home Reality profile in OneXray, then inspect the profile's
outbound, transport, routing and DNS settings. OneXray UI labels can vary by
version, so use the exact setting names below as the source of truth.

| Setting | Required value | Why it matters |
|---|---:|---|
| `Mux` / `Multiplex` | `OFF` | `xtls-rprx-vision` is exclusive with mux in practice. If mux is enabled, expect handshake failures, stalls, or a severe performance penalty. |
| `TLS Fragment` / `Fragment` | `OFF` | Reality already provides the TLS-like transport. Fragment obfuscation adds per-record overhead without improving this design. |
| `TCP Fast Open` / `TFO` | `OFF` | The server-side profile is tuned for ordinary TCP handshakes. Keep client and server behavior aligned. |
| `Sniffing` | `ON` | The router-side mobile split needs host inference so managed destinations can match `STEALTH_DOMAINS` / `VPN_STATIC_NETS`. |
| `Fake DNS` | `ON` | Prevents iOS from resolving managed names through the LTE carrier resolver before the proxy sees them. |
| `Override system DNS` | `ON` | Keeps profile DNS under the tunnel/client control instead of the carrier path. |
| `Bypass system DNS` | `ON` | Avoids accidental fallback to iOS/LTE DNS for proxy-owned lookups. |
| `Domain Strategy` | `AsIs` | Do not force local/mobile DNS resolution. Let the tunnel/server-side path infer domains and route them. |

If a setting is absent in the installed OneXray version, record `not exposed` in
the checklist and verify the equivalent behavior with the LTE DNS leak test and
router logs below. Do not guess by enabling nearby experimental toggles.

Per-device checklist (operator-local — keep filled-in copies outside git):

The completed device matrix lives in the operator's local notes, not in the
public repo. Use this template (in a gitignored or vault-stored copy) and fill
each row after applying the values above on the real device:

| Device | Profile | Mux | Fragment | TFO | Sniffing | Fake/System DNS | Domain strategy | Checked by | Date | Result / notes |
|---|---|---|---|---|---|---|---|---|---|---|
| `<device-id>` | `<profile-name>` | OFF | OFF | OFF | ON | ON / ON | AsIs | `<operator>` | `<YYYY-MM-DD>` | OK / followups |

Real device labels, owners and per-device dates are operator-local data and
must not be committed to public docs.

## iOS OneXray Direct Exceptions For Mercury/VTB

The VTB Mercury iOS app is sensitive to VPN-like network traces. The router has
`vtb.ru` in `configs/domains-no-vpn.txt`, and the mobile `reality-in` route has
a small router-side `direct-out` bypass for VTB/Firebase/analytics domains.

Important distinction: for a remote mobile client, router-side `direct-out` exits
through the home WAN. It is not LTE-direct. If an iOS app checks the public IP
from inside the OneXray tunnel, it may still see the home WAN rather than the
mobile carrier IP.

For OneXray on iOS, add a client-side routing rule with `outboundTag = direct`
for these domains so the checks leave the phone outside the tunnel:

```text
domain:vtb.ru,full:ip-check-perf.radar.cloudflare.com,domain:radar.cloudflare.com,domain:app-analytics-services-att.com,domain:app-measurement.com,domain:firebaseinstallations.googleapis.com,domain:sentry.io,domain:ingest.us.sentry.io,domain:dns.nextdns.io,domain:app-site-association.cdn-apple.com,domain:mzstorekit.itunes.apple.com,domain:iosapps.itunes.apple.com
```

Place this rule above generic proxy rules if OneXray allows reordering, then
fully stop and restart the VPN. The app may still show a VPN warning because iOS
has an active VPN/TUN interface, but the login can work once the preflight
checks go LTE-direct.

Full flow map: [modules/routing-core/docs/network-flow-and-observer-model.md](../../routing-core/docs/network-flow-and-observer-model.md).

These profiles are for egress, not LAN management. They do not grant general
home LAN access unless a route is explicitly added later.

## Security Model

Generated files are secrets:

```text
ansible/out/clients/router.conf
ansible/out/clients-home/*.conf
ansible/out/clients-home/*.png
ansible/out/clients-home/qr-index.html
ansible/out/channel-m-maxtg/*.env
```

They contain client UUIDs, Reality parameters, proxy credentials or server
access information. They are gitignored and must not be copied into
README/docs/issues/chat.

## Generate

```bash
./modules/client-profile-factory/bin/client-profiles generate
```

This runs:

```bash
cd ansible
ansible-playbook playbooks/30-generate-client-profiles.yml
```

## View Locally

```bash
./modules/client-profile-factory/bin/client-profiles home-list
./modules/client-profile-factory/bin/client-profiles home-open
./modules/client-profile-factory/bin/client-profiles emergency-list
./modules/client-profile-factory/bin/client-profiles emergency-open
./modules/client-profile-factory/bin/client-profiles channel-m-list
```

`home-open` opens the local home Reality `qr-index.html` when available.
`emergency-open` opens the disabled/off direct-VPS fallback profiles.
`channel-m-list` lists the generated maxtg service env fragments; `channel-m-open`
opens the local Channel M checklist when present.

## Mobile App DNS Settings Critical

The Home Reality QR only hides the first TCP hop if the mobile app owns DNS. If
iOS resolves `youtube.com` through the LTE carrier before the proxy sees the
connection, the carrier can still observe DNS interest even though traffic bytes
go to the home IP.

For each V2Box / FoXray / OneXray device profile:

- DNS mode: Fake-IP, fake DNS, or the app's equivalent tunnel-DNS mode.
- Override system DNS: ON.
- Bypass system DNS: ON, when the app exposes this toggle.
- Do not use the LTE carrier resolver as the active DNS path for the proxy
  profile.

Manual LTE check:

```text
1. Disconnect from home Wi-Fi.
2. Enable the Home Reality profile on LTE.
3. Open a DNS leak test page.
4. Expected: resolver is not the LTE carrier resolver.
5. Optional router log check: no fresh mobile direct-out entries to :53/:853.
```

Managed-split canary check:

```text
http://api.ipify.org      -> expected managed egress, normally VPS
https://api.ipify.org     -> expected managed egress, normally VPS
https://api64.ipify.org   -> must not show the LTE/mobile-provider IP
```

If plain HTTP shows the VPS but `https://api64.ipify.org` shows the LTE carrier
or mobile provider, treat it as a client-side Layer-0/IPv6 ownership failure
first. Router-side `direct-out` for a remote Home Reality client exits through
the home WAN; it cannot produce the cellular provider IP. In that situation,
check the iOS client profile/app settings before changing router managed split
rules or regenerating the VLESS URI.

Router-side audit helper:

```bash
ssh admin@<router_lan_ip> \
  'TODAY="$(date +%Y-%m-%d)"; grep " $TODAY " /opt/var/log/sing-box.log |
   grep "inbound/vless\\[reality-in\\]" -A3 |
   grep -E "direct\\[direct-out\\].*:(53|853)" || true'
```

This audit does not prove an LTE DNS leak. It only catches DNS traffic that
already entered the Home Reality tunnel and then tried to exit unexpectedly.
The router `sing-box` config sends tunneled mobile plain DNS `53` to
router-local dnsmasq. dnsmasq then sends managed/foreign names to the
router-local dnscrypt listener, which uses sing-box SOCKS/Reality, and leaves
RU/direct/default names on the home resolver path. DoH/DoT generated inside an
app remains a separate client-side proof item.

## Emergency Direct-VPS Profiles

Emergency profiles are separate from normal Home Reality profiles:

```text
normal:    iPhone -> home ASUS :<home-reality-port> -> split route
emergency: iPhone -> VPS :443 directly
```

Use them only when the home relay, home router or home ISP is down and the VPS
is healthy. Keep them imported but disabled/off in the mobile app.

Trade-off: during emergency use, the LTE carrier sees the device connecting
directly to the VPS host, so the domestic-first-hop billing/privacy property
does not apply for that period.

## Channel B XHTTP Selected-Client Production Profiles

Channel B is a selected-client production home-first lane. The device profile is
VLESS+XHTTP+TLS to the home router, and the router relays upstream via local
sing-box SOCKS using the same managed split as Home Reality: managed
destinations go through Reality/VPS, non-managed destinations go direct via
home WAN. It is production for explicitly selected clients, but it is not
automatic failover for Channel A.

```text
Endpoint client -> home public IP :<home-channel-b-port> -> router XHTTP+TLS ingress
                -> local router Xray relay (to local sing-box SOCKS)
                -> managed split -> sing-box Reality outbound -> VPS Caddy L4 -> Xray Reality -> Internet
```

Generated artifacts can be viewed with the same factory command when the vault
values are present:

```bash
./modules/client-profile-factory/bin/client-profiles generate
./modules/client-profile-factory/bin/client-profiles channel-b-list
./modules/client-profile-factory/bin/client-profiles channel-b-open
```

The intended Channel B output includes home-first VLESS URI text files and QR
PNG files under `ansible/out/clients-channel-b/`, plus a local `README.md`
operator checklist for Layer 0 and Shadowrocket import settings. In direct-XHTTP
mode (when home relay is disabled) the generator also emits compatibility URI
variants and raw Xray JSON artifacts. Channel B is production for selected
device-client profiles; new client apps still need manual import and egress
checks before they are added to that selected-client set.

For Shadowrocket Channel B profiles, keep `UDP Relay` disabled by default.
Channel B's first hop is XHTTP/TLS over TCP; enabling UDP relay can change
QUIC/DNS behavior and make first-hop fingerprint diagnostics harder to read.
Enable it only when explicitly testing UDP behavior.

For BrowserLeaks and other arbitrary checker tests, use the shared strict
Shadowrocket proof Config. A Geo/RU template, `sslip.io DIRECT` helper rule, or
system DNS fallback is not valid proof-mode evidence because it can move
resolver ownership back to the endpoint before Channel B reaches the router.
The Console's `sslip.io` hostname is handled separately as router-side
control-plane/direct traffic; do not use a client-side `sslip.io DIRECT` rule to
prove Channel A/B/C egress.

## Channel C1 Home-First Naive

Channel C is C1 home-first with two explicit selected-client variants:
C1-Shadowrocket HTTPS CONNECT compatibility and C1-sing-box native Naive. The
device connects to the home router first; after router ingress, sing-box applies
the same managed split used by Home Reality and Channel B. It does not provide
automatic failover.

```text
client app -> home public IP :<home-channel-c-public-port>
           -> router sing-box Naive inbound `channel-c-naive-in`
           -> managed split
           -> managed destinations: Reality/Vision -> VPS -> Internet
           -> non-managed destinations: home WAN -> Internet
```

Generated artifacts can be viewed with:

```bash
./modules/client-profile-factory/bin/client-profiles generate
./modules/client-profile-factory/bin/client-profiles channel-c-list
./modules/client-profile-factory/bin/client-profiles channel-c-open
```

The intended Channel C output is home-first only:

- `<client>-sfi-sing-box.json` and QR PNG: intended SFI/sing-box native Naive
  profile with a `naive` outbound to `channel_c_home_public_host`; currently
  blocked on tested iPhone SFI `1.11.4`, which rejects outbound `type: naive`.
- `<client>.txt` and QR PNG: `naive+https://...` URI for clients with native
  NaiveProxy-style import support.
- `<client>-https.txt`: plain `https://...` compatibility URL.
- `<client>-shadowrocket.conf` and QR PNG: Shadowrocket HTTPS CONNECT
  compatibility config with `method=connect`, TLS enabled and `FINAL,PROXY`.
- `README.md`: local import checklist and acceptance notes.

Treat Channel B profiles as selected-client production credentials and Channel C
profiles as explicit selected-client C1 credentials. C1-Shadowrocket is
live-proven on iPhone; C1-sing-box remains a native Naive target until an iOS
client with outbound `type: naive` support is selected. These profiles never
change router behavior by themselves; the router C1 ingress is deployed
separately with `ansible-playbook playbooks/22-channel-c-router.yml`.

## Channel D Router-Native NaiveProxy Lab

Channel D artifacts are experimental Karing/NaiveProxy-style credentials for a
router-native Caddy `forward_proxy@naive` lane. The client connects to the home
endpoint first, Caddy relays to local sing-box SOCKS, and sing-box applies the
same managed split as Channel A/B/C. Current live proof is Karing-only: the
server side is pinned `klzgrad/forwardproxy`, but client-side fingerprinting is
still Karing-like rather than official Chromium NaiveProxy.

For an import-only Karing trial without real endpoints or credentials:

```bash
cd ansible
ansible-playbook playbooks/30-generate-client-profiles.yml \
  --tags channel_d_clients_only \
  -e channel_d_naiveproxy_karing_trial_enabled=true
```

This generates a fake `example.invalid` `karing-trial` QR so the Karing import
path can be tested. For a real test profile, keep credentials in Vault and enable
only artifact rendering:

```yaml
vault_channel_d_naiveproxy_profiles_enabled: true
vault_channel_d_naiveproxy_clients:
  - name: karing-trial
    username: <channel-d-karing-user>
    password: <channel-d-karing-password>
```

```bash
./modules/client-profile-factory/bin/client-profiles generate
./modules/client-profile-factory/bin/client-profiles channel-d-list
./modules/client-profile-factory/bin/client-profiles channel-d-open
```

Generated artifacts live in `ansible/out/clients-channel-d/`:

- `<client>-channel-d-naiveproxy.txt`: `naive+https://...` URI for Karing or
  another NaiveProxy-style client.
- `<client>-channel-d-naiveproxy.png`: QR for the same URI.
- `README.md`: local import checklist and acceptance notes.

Channel D is not Channel C proof. Its proof signal is
`channel-d-naiveproxy-socks-in -> reality-out` for managed destinations and
`direct-out` for non-managed destinations. A QR generated while only
`vault_channel_d_naiveproxy_profiles_enabled=true` is importable by Karing, but
it becomes usable only after Channel D runtime is enabled with matching Vault
credentials.

For live artifacts, `channel_d_profile_public_host` must be a TLS hostname, not
a numeric IP. Karing reports `cert common name invalid` when a raw IP is used
with the existing hostname certificate and no proven SNI override.

## Channel M maxtg Service Egress Artifact

Channel M artifacts are not client QR profiles. They are local service fragments
for wiring `maxtg_bridge` on the VPS bridge to the home-router MAX egress lane:

```text
maxtg_bridge container -> HTTP CONNECT -> VPS docker bridge :<channel-m-reverse-listen-port>
home router -> outbound SSH remote-forward -> VPS docker bridge :<channel-m-reverse-listen-port>
tunnel target -> router loopback `channel-m-maxtg-reverse-egress`
              -> direct-out -> home WAN -> MAX API/CDN
```

When Channel M is enabled in Vault, profile generation writes:

```text
ansible/out/channel-m-maxtg/<client>.env
ansible/out/channel-m-maxtg/README.md
```

The `.env` file contains `MAX_EGRESS_PROXY_URL` and must be copied only into the
private `maxtg_bridge` `.env.secrets` on the VPS. It also contains
`MAX_EGRESS_PROXY_HOST` for `.env.host`; `MAX_EGRESS_PROXY_GATEWAY` is resolved
on the bridge VPS from the compose docker network. Optional
`MAX_EGRESS_RECOVERY_*` values name the router supervisor commands for scoped
Channel M status/recovery; the VPS-side SSH target and key remain runtime
secrets. Do not commit generated env fragments, paste them into docs, or print
them in logs.

View local artifacts:

```bash
./modules/client-profile-factory/bin/client-profiles generate
./modules/client-profile-factory/bin/client-profiles channel-m-list
./modules/client-profile-factory/bin/client-profiles channel-m-open
```

Router invariants after deploy:

- `channel-m-maxtg-max-egress` and `channel-m-maxtg-reverse-egress` route only
  to `direct-out`.
- Reverse Channel M uses router-initiated SSH remote-forwarding; it does not
  require a home inbound public port and does not reuse Channel C.
- Source allowlist permits only the Vault-configured VPS bridge CIDR for the
  optional direct public lane.
- Channel M is not Channel A/B/C failover and does not touch LAN/Wi-Fi routing.
- VPS/app on-demand recovery may call only
  `ghostroute-runtime-supervisor.sh channel-m-status` and
  `ghostroute-runtime-supervisor.sh channel-m-recover` through a restricted SSH
  profile; it must not call generic router `recover`.
- `maxtg_bridge` should show `MAX egress: home_ru_proxy`; if Channel M fails,
  MAX should degrade instead of auto-switching to `hetzner_direct`.

## Clean Local Artifacts

```bash
./modules/client-profile-factory/bin/client-profiles home-clean
./modules/client-profile-factory/bin/client-profiles emergency-clean
./modules/client-profile-factory/bin/client-profiles channel-b-clean
./modules/client-profile-factory/bin/client-profiles channel-c-clean
./modules/client-profile-factory/bin/client-profiles channel-m-clean
```

This removes generated home mobile files under `ansible/out/clients-home/` and keeps only `.gitkeep`. `ansible/out/clients/router.conf` is the router's VPS identity, not a mobile QR.

## Add Or Rotate A Client

1. Edit `ansible/secrets/stealth.yml` with `ansible-vault edit`.
2. Add or rotate the client's `uuid` and `short_id` in `home_clients[]`.
3. Deploy router changes if the home Reality inbound needs updating.
4. Regenerate local profiles with `./modules/client-profile-factory/bin/client-profiles generate`.
5. Scan the new QR from the device.

For emergency direct-VPS fallback, add or rotate the matching entry in
`emergency_clients[]` instead. Its `short_id` must also exist in
`reality_short_ids`, and the VPS playbook must be applied so the VPS inbound
keeps `router + emergency_clients[]`.

Fake URI shape:

```text
vless://00000000-0000-4000-8000-000000000000@home.example.invalid:<home-reality-port>?type=tcp&security=reality&pbk=FAKE_HOME_PUBLIC_KEY&sid=FAKE_SHORT_ID&sni=gateway.icloud.com&fp=safari#example-client
```

Never replace this fake example with a real URI in documentation.
