# GhostRoute Channels A / B / C

This document is the short handoff view of the current channel model. All
managed channels are home-first: the endpoint's first visible remote endpoint is
the home public IP/DDNS, not the VPS.

## Channel A - Production Router Data Plane

Channel A is the primary production path owned by the router.

```text
Home LAN/Wi-Fi device or home Reality endpoint client
  -> home router
  -> ASUS sing-box REDIRECT or Reality inbound
  -> managed split
       managed destinations     -> reality-out / Vision -> VPS -> internet
       non-managed destinations -> direct-out via home WAN -> internet
```

What the first network sees:

```text
LAN clients: ordinary home LAN traffic to the router
remote clients: endpoint -> home public IP/DDNS on the home Reality port
```

What target sites see for managed traffic:

```text
VPS exit IP
```

Main role:

- Production router data plane.
- Home LAN devices do not need VPN apps.
- Managed routing is driven by `STEALTH_DOMAINS` and `VPN_STATIC_NETS`.
- Channel A owns router REDIRECT/DNS/catalog behavior.

Isolation rule:

- Channel B and Channel C must not mutate Channel A REDIRECT ownership, DNS
  ownership, TUN state or automatic recovery behavior.

## Channel B - Production Selected-Client Lane

Channel B is production for selected device-client profiles. It gives those
clients a different first-hop protocol while reusing the same managed split and
Reality/Vision upstream as Channel A.

```text
iPhone / selected endpoint
  -> VLESS + XHTTP + TLS
  -> home public IP/DDNS :<home-channel-b-port>
  -> router local Xray ingress `channel-b-home-in`
  -> local sing-box SOCKS inbound `channel-b-relay-socks`
  -> managed split
       managed destinations     -> reality-out / Vision -> VPS -> internet
       non-managed destinations -> direct-out via home WAN -> internet
```

What the mobile operator sees:

```text
endpoint -> home public IP/DDNS
TLS / HTTP-like XHTTP traffic
```

It does not see the VPS as the first hop.

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
       managed destinations     -> reality-out / Vision -> VPS -> internet
       non-managed destinations -> direct-out via home WAN -> internet
```

What the mobile operator sees:

```text
iPhone -> home public IP/DDNS
TLS / HTTPS CONNECT traffic
```

C1-Shadowrocket is not native Naive. It is the compatibility path that actually
worked on the real iPhone through Shadowrocket.

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
       managed destinations     -> reality-out / Vision -> VPS -> internet
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

## No Automatic Failover

No channel automatically fails over to another channel.

```text
Channel A != automatic fallback to B or C
Channel B != automatic fallback for A
Channel C != automatic fallback for A/B
WireGuard = cold manual fallback only
```

Each channel is explicit, selected and independently verified.
