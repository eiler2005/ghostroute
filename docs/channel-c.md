# Channel C Home-First Client Lane

Channel C is the selected-client home-first lane for clients that should enter
GhostRoute through the home public endpoint before any VPS hop.

## Current Shape

```text
iPhone LTE
  -> home DDNS / home public IP
  -> ASUS router
  -> sing-box managed split
       managed destinations     -> reality-out -> VPS -> internet
       non-managed destinations -> direct-out via home WAN
```

The mobile operator sees only the iPhone connecting to the home endpoint. The
VPS is not the first visible remote endpoint.

Old direct-to-VPS Channel C designs are removed from active code. Historical
Squid/stunnel/tinyproxy/Caddy forward-proxy notes may remain in `docs/archive/`
only as removed-design debugging records.

## C1-sing-box Naive

C1-sing-box is the intended stealth-primary Channel C design:

```text
iPhone SFI / sing-box client
  -> Naive over public TLS :443
  -> WAN REDIRECT to router internal :41955
  -> sing-box naive inbound `channel-c-naive-in`
  -> managed split
  -> reality-out -> VPS -> internet
```

This is the closest current implementation to a real NaiveProxy-style lane in
this repository. The router uses sing-box `type: naive` inbound with a real
Let's Encrypt certificate and per-client username/password. A compatible
SFI/sing-box client profile must use sing-box `type: naive` outbound.

Live iPhone finding from 2026-04-28:

- The generated SFI JSON imported into the tested iPhone app.
- The imported profile contained outbound `"type": "naive"`, which is the
  correct native Naive shape.
- The app failed before making traffic with
  `unknown outbound type: naive`.
- The tested iPhone app reported sing-box `1.11.4`.
- Official sing-box docs mark Naive outbound as `Since sing-box 1.13.0`.

That means the tested SFI packet-tunnel build does not support Naive outbound,
even though the router-side C1 Naive ingress is deployed. C1-sing-box therefore
remains server-ready and client-blocked on that iPhone build. Generated SFI
native profiles are disabled by default and should only be enabled for a
client build known to support sing-box Naive outbound.

This is not the original klzgrad NaiveProxy daemon behind Caddy
`forward_proxy`, and it is not Chromium itself. It is sing-box's implementation
of the NaiveProxy protocol family. For GhostRoute, C1-sing-box is the correct
candidate when the iPhone client is SFI/sing-box.

## C1-Shadowrocket Compatibility

C1-Shadowrocket is a separate compatibility path for Shadowrocket:

```text
iPhone Shadowrocket
  -> HTTPS CONNECT over public TLS :4443
  -> WAN REDIRECT to router internal :41956
  -> sing-box http inbound `channel-c-shadowrocket-http-in`
  -> managed split
  -> reality-out -> VPS -> internet
```

C1-Shadowrocket is not Naive. It is authenticated HTTPS CONNECT over TLS. It
proved that the home-first Channel C architecture works for Shadowrocket, but
it does not provide Naive padding or Naive client behavior.

Live finding from 2026-04-28:

- Shadowrocket imported several Naive-like QR formats.
- Those profiles timed out during connectivity tests.
- Router logs showed the attempts hitting `channel-c-naive-in` but failing with
  `not CONNECT request`.
- A sing-box `http` inbound on router internal `:41956`, public `:4443`,
  succeeded with Shadowrocket.
- Logs confirmed
  `inbound/http[channel-c-shadowrocket-http-in] -> outbound/vless[reality-out]`.

C1-Shadowrocket is persisted through the Channel C router playbook, firewall
hook, generated profiles and verify checks.

## What Shadowrocket Would Need To Be Native Naive

For Shadowrocket to count as C1-sing-box Naive, it would need to emit the same
wire behavior that sing-box `naive` inbound expects:

```text
Shadowrocket
  -> TLS with valid home DDNS certificate
  -> HTTP/2 CONNECT-style Naive session with the expected Naive behavior
  -> valid auth for the configured C1 user
  -> accepted by `channel-c-naive-in`
```

The proof signal would be router logs like:

```text
inbound/naive[channel-c-naive-in]: [c1_iphone_1] inbound connection to ...
outbound/vless[reality-out]: outbound connection to ...
```

That did not happen in the live Shadowrocket test. The observed signal was
`not CONNECT request`, which means the imported Shadowrocket profile did not
behave as a compatible Naive client for the current sing-box inbound.

## Production Interpretation

- C1-sing-box on `:443` remains the intended stealth-primary Channel C design,
  but it is not considered iPhone-proven until a client accepts outbound
  `"type": "naive"` and produces `channel-c-naive-in -> reality-out` logs.
- C1-Shadowrocket on `:4443` is a Shadowrocket compatibility lane, not a Naive lane.
- C1-Shadowrocket is a persisted compatibility lane with separate profile and
  verification artifacts.
- Neither C1-sing-box nor C1-Shadowrocket is automatic failover for Channel A/B.
