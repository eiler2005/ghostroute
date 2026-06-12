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

The current default is policy-based DNS consistency, not "all DNS through VPS":

```text
managed/foreign domains -> DNS through dnscrypt-over-Reality -> traffic through VPS
RU/direct/default domains -> DNS through home/RF/default resolver -> traffic direct/home WAN
```

This keeps Russian/direct sites on the home/default resolver while ensuring
managed DNS does not leak to the client, LTE carrier or home ISP in plaintext.
The visible resolver identity can be a dnscrypt upstream; the privacy invariant
is that the lookup reached that upstream through Reality.

Implementation:

```text
Wi-Fi/LAN client
  -> router dnsmasq
  -> managed domain? dnsmasq server=/domain/127.0.0.1#<dnscrypt-port>
  -> dnscrypt-proxy
  -> sing-box SOCKS
  -> reality-out
  -> dnscrypt upstream

Wi-Fi/LAN client
  -> router dnsmasq
  -> RU/direct/default domain?
  -> normal home/RF/default resolver
```

Home-first mobile Channels A/B/C/D use the same DNS selection after reaching the
router when they carry DNS or domain-routed managed traffic:

```text
iPhone LTE -> Channel A/B/C/D ingress -> sing-box
plain DNS :53 -> router-local dnsmasq
dnsmasq managed domain -> dnscrypt-over-Reality
dnsmasq RU/direct/default -> home/RF/default resolver
```

`dnscrypt-proxy` is therefore a shared managed-DNS dependency, not an optional
background service. If the local listener on `127.0.0.1:<dnscrypt-port>` is
down, managed lookups can fail for LAN/Wi-Fi and for home-first mobile Channels
A/B/C/D at the same time. Channel M is service-only direct-out and does not use
the managed DNS split. The router-side guardrail is
`/jffs/scripts/dnscrypt-watchdog.sh`, installed by the dnscrypt role and run by
cron every minute; it restarts only dnscrypt-proxy when that listener disappears.

DoH/DoT generated inside an app is not force-blocked in v1. It remains a
residual risk and should be checked during BrowserLeaks/app proof testing.
For Shadowrocket proof tests, the endpoint Config must therefore be strict and
universal: `FINAL,PROXY`, `bypass-system = false`,
explicit foreign DoH `dns-server` / `fallback-dns-server`,
`dns-fallback-system = false`, `dns-direct = false`, `hijack-dns = :53`, IPv6
disabled, and unsupported UDP rejected. A Geo/RU client config, missing
explicit DNS server, or helper rule such as `DOMAIN-SUFFIX,sslip.io,DIRECT` is
not proof-mode evidence because arbitrary DNS test names can fall back before
the router sees them.
The Console `sslip.io` hostname is a separate control-plane exception: it stays
out of the managed catalog and mobile rule-set so Channels A/B/C can still reach
the operator Console without turning a proof config into a client-side bypass.

For everyday Shadowrocket use, a separate daily template may intentionally use
`dns-server = system` and narrow `DIRECT` rules for domestic banking or
corporate services. Gmail SMTP/IMAP is intentionally direct for normal use:
`gmail.com` / `googlemail.com` must stay out of the router managed catalog, and
the daily Shadowrocket template sends `smtp.gmail.com` and `imap.gmail.com`
`DIRECT` for iOS Mail compatibility because Gmail SMTP/IMAP ports can time out
through the VPS/Reality egress. That daily profile is not a BrowserLeaks proof
profile. Keep real corporate domains and private hostnames in local imported
configs, not in tracked docs.

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

Expected default:

```text
managed Public IP: VPS
managed DNS: dnscrypt-over-Reality resolver path
direct/RU Public IP: home/RF
direct/RU DNS: home/RF/default resolver path
```

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

With the policy-split resolver, explicitly managed domains should resolve
through router dnsmasq and then dnscrypt-over-Reality, not through the LTE or
home ISP resolver directly.

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
DNS = dnscrypt upstream  -> expected for managed foreign domains if reached through Reality
DNS = home/RF resolver   -> expected for RU/direct/default domains
DNS = LTE/mobile carrier -> bad for managed domains
many DNS servers shown   -> noisy resolver anycast/load-balancing, not a leak by itself
```

Channel A managed-split canaries:

```text
http://api.ipify.org      -> managed egress, normally VPS
https://api.ipify.org     -> managed egress, normally VPS
https://api64.ipify.org   -> must not show LTE/mobile-provider IP
```

If HTTP `api.ipify.org` shows the VPS but `api64.ipify.org` shows the mobile
provider, the managed split after the router is probably working for IPv4/TCP,
while the iPhone app/profile is not owning every Layer-0 or IPv6 path. This is
different from router `direct-out`: router `direct-out` for remote clients exits
through the home WAN, not through LTE.

On router:

```bash
./verify.sh
./modules/ghostroute-health-monitor/bin/router-health-report
```

Relevant expected signals:

```text
IPv6 policy OK
Mobile plain DNS :53 goes to router-local dnsmasq OK
Managed DNS include has browserleaks.com/.net/.org -> 127.0.0.1#<dnscrypt-port> OK
dnscrypt-proxy listener OK
dnscrypt-proxy routes DoH through sing-box SOCKS OK
DNS/IPv6 leak probe OK
```

On the current VPS, Reality is served by the existing `3x-ui`/`xray` Docker
container. Because `127.0.0.1` inside that container is container-local,
managed DNS is delivered to the router-local dnscrypt listener. dnscrypt sends
its upstream DoH traffic through the local sing-box SOCKS inbound, so managed
lookups still cross Reality without depending on the separate VPS Unbound leg.

Router `sing-box` still exposes `vps-dns-in` for inbound/mobile DNS hijack
compatibility, but its internal TCP DNS server uses a bounded public resolver
over `reality-out`. That keeps dnsmasq's domain selection intact:
RU/direct/default names still go to the home/RF/default resolver, while managed
names use dnscrypt-over-Reality.

## BrowserLeaks Mixed DNS Troubleshooting

If BrowserLeaks for a managed domain shows public IP = VPS but DNS includes
home/RF, Google/Cloudflare or many resolver pools, check in this order:

```text
1. Is the active endpoint Config the generated strict Shadowrocket proof config?
2. Is the tested site in configs/dnsmasq-stealth.conf.add?
3. Is it absent from configs/domains-no-vpn.txt?
4. Is it not a RU/SU/RF TLD? RU-like domains are intentionally kept out of managed DNS.
5. Does /jffs/configs/dnsmasq-vps-managed.conf.add contain server=/domain/127.0.0.1#<dnscrypt-port>?
6. Did dnsmasq restart after the include changed?
7. Did Safari/iOS cache old DNS? Toggle airplane mode or restart the profile.
8. Is the app/browser using its own DoH/DoT? v1 does not block every app-level encrypted DNS path.
```

Expected live proofs:

```text
browserleaks.com DNS test -> Public IP VPS, DNS from the dnscrypt-over-Reality path
vtb.ru / championat.com / .ru control -> Public IP home/RF, DNS not VPS
```

BrowserLeaks is a good example of why proof services need all their base zones
in the managed catalog. The page is `browserleaks.com`, but the DNS leak test
creates random probe names under `browserleaks.net` and `browserleaks.org`.
`ipset=/browserleaks.com/STEALTH_DOMAINS` already covers every subdomain of
`browserleaks.com`; it does not cover sibling base domains such as
`browserleaks.net` or `browserleaks.org`.

The same rule applies to real services such as Claude, OpenAI, YouTube or
Telegram. Subdomains under a managed base domain are already covered, but new
sibling/base domains must be added deliberately. The intended operating model is
semi-manual catalog curation:

```text
unknown/default -> home/RF DNS and traffic
known managed foreign -> dnscrypt-over-Reality DNS + VPS traffic
known RU/direct -> home/RF DNS and traffic
```

Avoid broad `.com`/`.net`/`.org` style DNS-to-VPS rules unless the whole policy
is consciously changed to a foreign-default mode.

## What Not To Change By Default

- Do not switch all DNS to VPS; that leaks VPS resolver identity to Russian and
  direct/default sites.
- Do not switch all DNS to the home ISP resolver; that breaks the VPS/Hetzner
  consistency proof for managed foreign services.
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
