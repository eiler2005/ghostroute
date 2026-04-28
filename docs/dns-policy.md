# DNS Policy And Leak/Fingerprint Checklist

This document captures the current DNS decision for GhostRoute channels.

## Core Principle

Primary goal:

```text
The mobile operator must not see endpoint DNS interest or final managed sites.
```

For LTE/iPhone use this means the operator should see only:

```text
iPhone -> home public IP/DDNS
encrypted tunnel/proxy traffic
```

It should not see:

```text
iPhone -> VPS
iPhone -> foreign websites
iPhone -> LTE-carrier DNS lookups for managed domains
```

Secondary goal:

```text
Browser fingerprint consistency, such as public IP country matching resolver
country, is useful but lower priority than avoiding DNS leaks to the mobile
operator.
```

Therefore a BrowserLeaks result like:

```text
Public IP: home/Russia
DNS: Google/Cloudflare/Finland
```

is not automatically a mobile DNS leak. It is a mixed fingerprint. It becomes a
problem only if the DNS resolver is the LTE carrier, the request bypasses the
active tunnel, or the channel is explicitly trying to present a fully
RF-consistent profile.

## Current Default Strategy

The current default is privacy-first:

```text
Endpoint DNS -> active tunnel/channel -> router/sing-box policy -> encrypted or
tunneled resolver path
```

This is intentionally different from a purely local ISP resolver profile. A
local/home ISP resolver may look more country-consistent, but it also gives the
home ISP or its DNS provider more domain-interest visibility.

## Channel A

Channel A should prevent LTE DNS leakage for home Reality mobile clients and
keep managed DNS traffic inside the tunnel.

Desired proof:

```text
mobile operator sees: iPhone -> home IP
BrowserLeaks DNS: not LTE carrier
IPv6: no direct IPv6 leak
managed sites: use expected managed egress
```

Acceptable default:

```text
Public IP: home/RF or selected egress
DNS: encrypted/global resolver through tunnel
```

Optional future mode:

```text
RF-consistent DNS:
iPhone -> home router DNS -> selected RF/home resolver
```

Trade-off: RF-consistent DNS may reduce BrowserLeaks mismatch, but it can
increase DNS visibility to the home ISP/resolver. Do not switch to this mode
without an explicit reason.

## Channel B

Channel B is a selected-client home-first lane, but managed egress reuses the
Reality/Vision upstream.

Desired proof:

```text
mobile operator sees: endpoint -> home IP
DNS: not LTE carrier
managed traffic: through tunnel/managed split
```

If the test goal is a VPS-like profile, DNS resolvers near the VPS or global
DoH/DoT resolvers are acceptable as long as they are reached through the active
channel and do not bypass to the mobile carrier.

## Channel C

For C1-Shadowrocket:

```text
iPhone Shadowrocket -> home IP :4443 -> router HTTP inbound -> managed split
DNS must follow the active Shadowrocket/tunnel policy, not LTE carrier DNS.
```

For C1-sing-box/native Naive:

```text
server-side lane exists, but tested SFI 1.11.4 cannot run outbound type naive.
DNS proof waits until a compatible iOS client exists.
```

## What To Check Manually

On iPhone/LTE:

```text
1. Disable iCloud Private Relay / Limit IP Address Tracking during proof tests.
2. Enable exactly one GhostRoute profile.
3. Open BrowserLeaks DNS or equivalent.
4. Confirm DNS does not show the mobile carrier.
5. Confirm public IP matches the intended channel result.
6. Confirm IPv6 is absent or routed through the active tunnel.
7. Repeat after toggling airplane mode to clear stale DNS/cache state.
```

Interpretation:

```text
DNS = LTE carrier        -> bad leak
DNS = Google/Cloudflare  -> not automatically bad; check whether it went through the tunnel
DNS = home/RF resolver   -> country-consistent but possibly less private
many DNS servers shown   -> noisy resolver anycast/load-balancing, not a leak by itself
```

On router:

```bash
./verify.sh
./modules/ghostroute-health-monitor/bin/router-health-report
```

Relevant expected signals:

```text
IPv6 policy OK
Home Reality DNS guard :53/:853 OK
dnscrypt-proxy uses sing-box SOCKS OK
DNS/IPv6 leak probe OK
```

## What Not To Change By Default

- Do not switch Channel A DNS to the home ISP resolver only to make BrowserLeaks
  look more Russian.
- Do not weaken encrypted/tunneled DNS just to reduce the number of resolver IPs
  in BrowserLeaks.
- Do not enable IPv6 until there is a separate dual-stack routing design.
- Do not treat Google/Cloudflare resolver geography as proof of mobile-carrier
  DNS leakage.

## Future Improvement

Add a per-channel DNS proof checklist to the profile generation output:

```text
Channel A: no LTE DNS, IPv6 absent, managed egress expected
Channel B: no LTE DNS, selected-client tunnel active, managed split expected
Channel C-SR: no LTE DNS, Shadowrocket DNS follows active proxy
```

This should remain a verification/reporting improvement first, not an automatic
runtime DNS change.
