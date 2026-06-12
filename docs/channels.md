# GhostRoute Channels A / B / C / D / M

This document is the short handoff view of the current channel model. All
managed channels are home-first: the endpoint's first visible remote endpoint is
the home public IP/DDNS, not the VPS.

DNS policy is documented separately in [dns-policy.md](/docs/dns-policy.md).
The primary DNS goal is no DNS leak to the mobile operator; BrowserLeaks
resolver geography is a secondary fingerprint-consistency signal.

The shared routing principles for all channels are documented in
[routing-policy-principles.md](/docs/routing-policy-principles.md). In short:
the endpoint selects the first-hop channel, then the router owns the route
decision. The default decision is managed-vs-direct split; Channel A also has an
explicit selected full-VPS override for home Wi-Fi/LAN devices and Home Reality
profiles.

Channel M is intentionally different: it is a service egress lane for
`maxtg_bridge`, not a managed client channel.

Full Channel M environment ownership, ports and redeploy invariants are in
[channel-m-environment.md](channel-m-environment.md).

## Channel A - Production Router Data Plane

Channel A is the primary production path owned by the router.

```text
Home LAN/Wi-Fi device or home Reality endpoint client
  -> home router
  -> ASUS sing-box REDIRECT, TPROXY or Reality inbound
  -> managed split or selected full-VPS override
       managed destinations     -> reality-out -> active managed egress -> internet
       non-managed destinations -> direct-out via home WAN -> internet
       selected full-VPS internet traffic -> reality-out -> active managed egress -> internet
```

What the first network sees:

```text
LAN clients: ordinary home LAN traffic to the router
remote clients: endpoint -> home public IP/DDNS on the home Reality port
```

DNS proof target:

```text
remote mobile DNS must not use the LTE carrier resolver
```

What target sites see for managed traffic and selected full-VPS internet traffic:

```text
active managed egress exit IP
```

Main role:

- Production router data plane.
- Home LAN devices do not need VPN apps.
- Managed routing is driven by `STEALTH_DOMAINS` and `VPN_STATIC_NETS`.
- Selected full-VPS routing is driven by two explicit sets:
  reserved home Wi-Fi/LAN source IPs and Home Reality `auth_user` profile names.
- Channel A owns router REDIRECT/DNS/catalog behavior.

Selected full-VPS is not a separate channel:

```text
Home Wi-Fi/LAN full-VPS set
  reserved source IP -> TPROXY -> channel-a-selected-lan-full-vps-in
  -> local/private direct
  -> other internet traffic -> reality-out

Home Reality full-VPS set
  reality-in auth_user -> local/private direct
  -> other internet traffic -> reality-out
```

Non-selected home devices and non-selected Home Reality profiles keep the normal
managed-domain split.

Isolation rule:

- Channel B and Channel C must not mutate Channel A REDIRECT ownership, DNS
  ownership, TUN state or automatic recovery behavior.

## Channel B - Production Selected-Client Lane

Channel B is production for selected device-client profiles. It gives those
clients a different first-hop protocol while reusing the same managed split and
managed egress upstream as Channel A.

```text
iPhone / selected endpoint
  -> VLESS + XHTTP + TLS
  -> home public IP/DDNS :<home-channel-b-port>
  -> router local Xray ingress `channel-b-home-in`
  -> local sing-box SOCKS inbound `channel-b-relay-socks`
  -> managed split
       managed destinations     -> reality-out -> active managed egress -> internet
       non-managed destinations -> direct-out via home WAN -> internet
```

What the mobile operator sees:

```text
endpoint -> home public IP/DDNS
TLS / HTTP-like XHTTP traffic
```

It does not see the VPS as the first hop.

DNS proof target:

```text
selected-client DNS follows the active Channel B tunnel, not LTE carrier DNS
```

Main role:

- Production selected-client profile lane.
- Protocol-diverse home-first path compared with Channel A.
- Isolated from Channel A router data-plane ownership.
- Deployed/refreshed by `ansible/playbooks/21-channel-b-router.yml`.

Generated artifacts:

```text
ansible/out/clients-channel-b/
```

## Channel C - Home-First Experimental / Compatibility Lane

Channel C is split into two explicitly different variants.

### C1-Shadowrocket / 1-SR

C1-Shadowrocket is the live-proven iPhone compatibility lane.

```text
iPhone Shadowrocket
  -> HTTPS CONNECT over TLS
  -> home public IP/DDNS :4443
  -> router sing-box HTTP inbound `channel-c-shadowrocket-http-in` :41956
  -> managed split
       managed destinations     -> reality-out -> active managed egress -> internet
       non-managed destinations -> direct-out via home WAN -> internet
```

What the mobile operator sees:

```text
iPhone -> home public IP/DDNS
TLS / HTTPS CONNECT traffic
```

C1-Shadowrocket is not native Naive. It is the compatibility path that actually
worked on the real iPhone through Shadowrocket.

DNS proof target:

```text
Shadowrocket DNS follows the active proxy/profile, not LTE carrier DNS
```

Generated artifacts:

```text
ansible/out/clients-channel-c/1-SR/
```

Working artifact shape:

```text
iphone-N-c1-shadowrocket-https.png
iphone-N-c1-shadowrocket-https.txt
```

### C1-sing-box / Native Naive

C1-sing-box is the intended stealth-primary Channel C design, but it is
currently client-blocked on the tested iPhone SFI app.

Target shape:

```text
iPhone SFI / sing-box client with outbound type `naive`
  -> Naive over public TLS :443
  -> home public IP/DDNS
  -> router sing-box naive inbound `channel-c-naive-in` :41955
  -> managed split
       managed destinations     -> reality-out -> active managed egress -> internet
       non-managed destinations -> direct-out via home WAN -> internet
```

Router-side status:

- Deployed as a native sing-box `naive` inbound with a real public TLS
  certificate and per-client username/password.
- Server-ready.

iPhone client status from 2026-04-28:

- SFI imported the JSON profile.
- The JSON contained the correct native shape: outbound `"type": "naive"`.
- The tested SFI app used sing-box `1.11.4`.
- It failed before traffic with `unknown outbound type: naive`.
- Official sing-box docs mark Naive outbound as `Since sing-box 1.13.0`.

Current production interpretation:

- C1-sing-box is not iPhone-proven with SFI `1.11.4`.
- SFI native profile generation is disabled by default with
  `channel_c_sfi_native_profiles_enabled: false`.
- Re-test only with an iOS sing-box/SFI build that supports outbound
  `"type": "naive"`.

## Channel D - Router-Native NaiveProxy Lab

Channel D is a router-native NaiveProxy selected-client home-first lane for
Karing / NaiveProxy-style clients. It remains separately owned from Channel C:
successful Channel D Karing/LTE traffic proves Channel D only, not Channel C
native Naive.

```text
Karing / NaiveProxy-style client
  -> home public IP/DDNS :4444
  -> router Caddy forward_proxy@naive
  -> local sing-box SOCKS inbound `channel-d-naiveproxy-socks-in`
  -> managed split
       managed destinations     -> reality-out -> active managed egress -> internet
       non-managed destinations -> direct-out via home WAN -> internet
```

Current production interpretation:

- Channel D is operator live-proven with Karing over LTE, but still isolated
  from Channel A/B/C ownership.
- The server side is Caddy `forward_proxy@naive` built with a pinned
  `klzgrad/forwardproxy` ref; the current client fingerprint is still Karing,
  not the official Chromium NaiveProxy client.
- A neutral cover site handles ordinary unauthenticated HTTPS GET probes, while
  unauthenticated CONNECT must not become an open proxy.
- Channel D has separate credentials, Karing artifacts and deploy playbook.
- Proof logs must show `channel-d-naiveproxy-socks-in -> reality-out` for
  managed destinations and `direct-out` for non-managed destinations.
- It does not prove Channel C native Naive; Channel C proof still lands in
  `channel-c-naive-in`.

## Channel M - Service MAX Egress Lane

Channel M exists only for MAX traffic from `maxtg_bridge`.

```text
home router
  -> outbound SSH remote-forward
  -> VPS docker bridge :<channel-m-reverse-listen-port>

maxtg_bridge container on Hetzner/VPS
  -> authenticated HTTP CONNECT to the VPS-local reverse listener
  -> SSH remote-forward target on router loopback
  -> router sing-box HTTP inbound `channel-m-maxtg-reverse-egress`
  -> direct-out via home WAN -> internet
```

What the remote exposure model allows:

```text
no new inbound home public port is required for the active reverse lane
the VPS listener is bound to the docker bridge, not the public internet
```

What target MAX API/CDN sites see:

```text
home WAN Russian IP
```

Main role:

- MAX API socket and MAX CDN downloads for `maxtg_bridge`.
- Authenticated HTTP CONNECT with per-service username/password inside the SSH
  reverse tunnel.
- Route rule is only `inbound=channel-m-maxtg-reverse-egress -> direct-out`.
- The optional direct public `channel-m-maxtg-max-egress` lane remains isolated
  and source-allowlisted for controlled experiments, but it is not required for
  the active reverse design.
- Reusing Channel C `:443` or adding MAX auth users to a Channel C inbound is a
  separate design change and is not part of Channel M.

Isolation rule:

- Channel M is not Channel A/B/C failover.
- Channel M does not use `reality-out`.
- Channel M does not participate in `STEALTH_DOMAINS`, `VPN_STATIC_NETS`, DNS
  policy, Channel A REDIRECT ownership, Channel B/C client routing, or LAN/Wi-Fi
  routing.

## No Automatic Failover

No channel automatically fails over to another channel.

```text
Channel A != automatic fallback to B or C
Channel B != automatic fallback for A
Channel C != automatic fallback for A/B
Channel M != automatic fallback for A/B/C
WireGuard = cold manual fallback only
```

Each channel is explicit, selected and independently verified.
