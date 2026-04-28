# ADR 0008: Channel C Live Compatibility And Native Naive Blocker

## Context

ADR 0007 described Channel C as a planned home-first C1 lane. Channel C has now
been implemented on the router and tested with two iPhone client surfaces:
Shadowrocket HTTPS CONNECT compatibility and SFI/sing-box native Naive.

The old direct-to-VPS Squid/stunnel/tinyproxy/Caddy forward-proxy Channel C
design has been removed from active code. Channel C is home-first only.

## Decision

Current channel maturity is:

- Channel A remains the production router data plane.
- Channel B remains production for selected device-client profiles.
- Channel C1-Shadowrocket is the live-proven Channel C compatibility lane:
  Shadowrocket uses authenticated HTTPS CONNECT over TLS to the home endpoint
  on public `:4443`, the router terminates it with sing-box HTTP inbound, then
  applies the same managed split and Reality/Vision egress as other home-first
  channels.
- Channel C1-sing-box is the intended native Naive design: the router exposes a
  sing-box `naive` inbound on the home endpoint and then applies the same
  managed split. It is server-ready but not iPhone-proven with the tested SFI
  client.
- The tested iPhone SFI app used sing-box `1.11.4` and rejected the native
  profile with `unknown outbound type: naive`. Native SFI profile generation is
  therefore disabled by default until the selected iOS client supports outbound
  `type: naive`.
- No channel provides automatic failover for another channel.

## Consequences

Operational docs must present C1-Shadowrocket as the current working iPhone
Channel C path and must not describe it as native Naive.

C1-sing-box may stay deployed as the router-side native Naive candidate, but it
must be treated as client-blocked until a compatible iOS sing-box/SFI build is
tested end to end and router logs show `channel-c-naive-in -> reality-out`.

Generated client artifacts should expose only proven/default-safe profiles.
Native SFI artifacts require an explicit opt-in such as
`channel_c_sfi_native_profiles_enabled=true`.
