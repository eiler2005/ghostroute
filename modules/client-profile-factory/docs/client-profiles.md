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

Useful ideas from the expanded config, but only after proof mode is stable:

- `hijack-dns = :53` can help catch plain DNS in a richer production config.
- `dns-fallback-system = false` prevents system resolver fallback.
- `udp-policy-not-supported-behaviour = REJECT` makes unsupported UDP fail
  closed instead of silently going direct.

Do not add these to the proof config first. They change DNS/UDP behavior and
made diagnosis harder. Start with minimal `FINAL,PROXY`, prove that Channel
A/B/C reaches the router, then add stricter DNS controls deliberately.

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

Per-device checklist:

| Device | Profile | Mux | Fragment | TFO | Sniffing | Fake/System DNS | Domain strategy | Checked by | Date | Result / notes |
|---|---|---|---|---|---|---|---|---|---|---|
| `iphone-1` | Home Reality | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| `iphone-2` | Home Reality | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| `iphone-3` | Home Reality | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| `iphone-4` | Home Reality | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| `iphone-5` | Home Reality | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| `iphone-6` | Home Reality | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| `macbook` | Home Reality | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO |

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

Full flow map: [modules/routing-core/docs/network-flow-and-observer-model.md](/modules/routing-core/docs/network-flow-and-observer-model.md).

These profiles are for egress, not LAN management. They do not grant general
home LAN access unless a route is explicitly added later.

## Security Model

Generated files are secrets:

```text
ansible/out/clients/router.conf
ansible/out/clients-home/*.conf
ansible/out/clients-home/*.png
ansible/out/clients-home/qr-index.html
```

They contain client UUIDs, Reality parameters and server access information. They are gitignored and must not be copied into README/docs/issues/chat.

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
```

`home-open` opens the local home Reality `qr-index.html` when available.
`emergency-open` opens the disabled/off direct-VPS fallback profiles.

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
ssh admin@192.168.50.1 \
  'TODAY="$(date +%Y-%m-%d)"; grep " $TODAY " /opt/var/log/sing-box.log |
   grep "inbound/vless\\[reality-in\\]" -A3 |
   grep -E "direct\\[direct-out\\].*:(53|853)" || true'
```

This audit does not prove an LTE DNS leak. It only catches DNS traffic that
already entered the Home Reality tunnel and then tried to exit unexpectedly.
The router `sing-box` config sends tunneled mobile plain DNS `53` to
router-local dnsmasq. dnsmasq then sends managed/foreign names to VPS Unbound
and leaves RU/direct/default names on the home resolver path. DoH/DoT generated
inside an app remains a separate client-side proof item.

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

## Clean Local Artifacts

```bash
./modules/client-profile-factory/bin/client-profiles home-clean
./modules/client-profile-factory/bin/client-profiles emergency-clean
./modules/client-profile-factory/bin/client-profiles channel-b-clean
./modules/client-profile-factory/bin/client-profiles channel-c-clean
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
