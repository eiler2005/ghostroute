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

Router-side audit helper:

```bash
ssh admin@192.168.50.1 \
  'TODAY="$(date +%Y-%m-%d)"; grep " $TODAY " /opt/var/log/sing-box.log |
   grep "inbound/vless\\[reality-in\\]" -A3 |
   grep -E "direct\\[direct-out\\].*:(53|853)" || true'
```

This audit does not prove an LTE DNS leak. It only catches DNS traffic that
already entered the Home Reality tunnel and then tried to exit via `direct-out`.
The router `sing-box` config sends tunneled mobile DNS ports `53/853` through
`reality-out` as a server-side guard.

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

Channel C is C1: a planned selected-client home-first Naive /
HTTPS-H2-CONNECT-like lane. The device connects to the home router first; after
router ingress, sing-box applies the same managed split used by Home Reality and
Channel B. It does not provide automatic failover and should remain outside
production checks until SFI/sing-box import, connection and real app egress are
proven.

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

- `<client>-sfi-sing-box.json` and QR PNG: primary SFI/sing-box proof profile
  with a `naive` outbound to `channel_c_home_public_host`.
- `<client>.txt` and QR PNG: `naive+https://...` URI for clients with native
  NaiveProxy-style import support.
- `<client>-https.txt`: plain `https://...` compatibility URL.
- `<client>-shadowrocket.conf` and QR PNG: Shadowrocket HTTPS CONNECT
  compatibility config with `method=connect`, TLS enabled and `FINAL,PROXY`.
- `README.md`: local import checklist and acceptance notes.

Keep Channel C profiles disabled/off until its C1 compatibility proof is
complete. Treat Channel B profiles as selected-client production credentials and
Channel C profiles as planned C1 credentials. These profiles never change router
behavior by themselves; the router C1 ingress is deployed separately with
`ansible-playbook playbooks/22-channel-c-router.yml`.

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
