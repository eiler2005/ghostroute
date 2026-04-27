# Client Profiles And QR Codes

VLESS/Reality client profiles are generated locally from `ansible-vault`.

## Where These Clients Fit

QR/VLESS clients are the third traffic path in the project:

```text
iPhone/MacBook outside home
  -> QR/VLESS profile in a client app
  -> home ASUS public IP / :<home-reality-port>
  -> sing-box home Reality inbound
  -> managed split:
       STEALTH_DOMAINS/VPN_STATIC_NETS -> sing-box Reality outbound -> VPS host
       other destinations              -> sing-box direct-out -> home WAN
```

They connect to the ASUS router first. This is deliberate: a mobile carrier sees
the remote device connecting to the home Russian IP, not directly to VPS.
The final website/checker sees VPS only when its domain/IP is managed. A
non-managed destination sees the home Russian WAN IP.

This is the expected split:

| Observer | Sees |
|---|---|
| LTE/mobile carrier | Remote device -> home Russian IP `:<home-reality-port>` |
| Home ISP | ASUS router -> VPS Reality endpoint |
| Website/checker for managed domains | VPS exit IP / datacenter ASN |
| Website for non-managed domains | Home Russian WAN IP |

Do not use generic checker results alone to judge the LTE-facing path. A checker
reports the final website-facing exit IP, not the first hop that the mobile
carrier observes.

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

## Channel B XHTTP Future Manual Profiles

Channel B is a planned VLESS+XHTTP+TLS manual device-client lane. It is not a
production fallback today. It does not replace Home Reality/Channel A, does not
alter router REDIRECT/DNS/TUN state, and does not enable automatic failover.

```text
iPhone/Mac/PC -> Channel B XHTTP hostname :443 -> Caddy TLS -> local Xray XHTTP -> Internet
```

Future generated artifacts can be viewed with the same factory command when
the vault values are present:

```bash
./modules/client-profile-factory/bin/client-profiles generate
./modules/client-profile-factory/bin/client-profiles channel-b-list
./modules/client-profile-factory/bin/client-profiles channel-b-open
```

The intended Channel B output includes VLESS URI text files, QR PNG files and
raw Xray JSON profiles under `ansible/out/clients-channel-b/`. Future
production readiness requires a live client pass proving import, connection
and real egress on the target iOS/macOS/Android clients.

## Channel C NaiveProxy Future Experiment

Channel C is a future experimental NaiveProxy / HTTPS forward-proxy lane. It is
manual-only, not production-ready, and does not participate in router domain
routing or automatic failover.

```text
client app -> Channel C Naive/HTTPS hostname :443 -> Caddy forward_proxy / compatible backend -> Internet
```

Future generated artifacts can be viewed with:

```bash
./modules/client-profile-factory/bin/client-profiles generate
./modules/client-profile-factory/bin/client-profiles channel-c-list
./modules/client-profile-factory/bin/client-profiles channel-c-open
```

The intended Channel C output separates true NaiveProxy artifacts from plain
HTTPS forward-proxy compatibility artifacts:

- `<client>.txt` and QR PNG: `naive+https://...` URI for clients with native
  NaiveProxy import support.
- `<client>-https.txt`: plain `https://...` forward-proxy URI for clients that
  expose only an HTTPS proxy type.
- `<client>-shadowrocket-https.txt` and QR PNG: Shadowrocket-targeted HTTPS
  proxy URI with explicit `method=connect`, `tls=true` and `plugin=none`
  import hints.
- `<client>-shadowrocket-add.txt` and QR PNG: Shadowrocket URL-scheme wrapper
  around the same HTTPS proxy URI, used when the plain QR import drops
  credentials.
- `<client>-shadowrocket-fields-*.txt` and QR PNG variants: compact
  `host:port:user:pass` and `user:pass@host:port` field-import formats for
  Shadowrocket versions that ignore credentials in HTTPS URLs.
- `<client>-shadowrocket.conf`: Shadowrocket config-file import with the
  HTTPS proxy predeclared under `[Proxy]`, `method=connect`, TLS enabled and
  `FINAL,PROXY`.
- `<client>-shadowrocket-positional.conf`: alternate Shadowrocket config-file
  import using positional user/auth-secret fields for app versions that ignore
  named auth fields on HTTPS proxy nodes. It also pins `method=connect`.
- `<client>.json`: naiveproxy CLI JSON using the plain HTTPS proxy URL.
- `<client>-sing-box-outbound.json`: sing-box `type: naive` outbound JSON.

Keep Channel B/C profiles disabled/off. Treat them as experimental artifacts
until a future implementation pass chooses supported clients, confirms import
behavior and proves live egress. These profiles never change router behavior.

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
