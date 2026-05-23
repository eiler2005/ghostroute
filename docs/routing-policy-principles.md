# Routing Policy Principles

This document is the compact source for GhostRoute routing principles. It
explains what must stay true across Channel A, Channel B and Channel C, plus
why Channel M is intentionally outside that managed split. The
runtime implementation still lives in Ansible templates, router scripts and
domain catalogs listed below.

## Core Contract

All managed channels are home-first. The default router policy is managed split;
selected home Wi-Fi/LAN devices and selected Channel A Home Reality profiles can
opt into Channel A selected full-VPS mode.

```text
endpoint / LAN device
  -> home router
  -> router-side ingress
  -> default shared managed split
       managed destinations     -> reality-out -> active managed egress -> internet
       non-managed destinations -> direct-out via home WAN -> internet

selected Channel A full-VPS set
  -> home router
  -> TPROXY or reality-in auth_user rule
  -> local/private destinations stay direct
  -> other internet destinations -> reality-out -> active managed egress -> internet
```

The endpoint client may choose the first-hop channel, but it must not become the
main policy engine. The router owns the managed-vs-direct decision after traffic
has reached home.

Channel M is a service exception for `maxtg_bridge` MAX egress, not part of the
managed client policy:

```text
home router -> outbound SSH remote-forward -> VPS docker bridge
maxtg_bridge container -> authenticated HTTP CONNECT to VPS-local listener
  -> reverse tunnel target on router loopback
  -> sing-box inbound `channel-m-maxtg-reverse-egress`
  -> direct-out via home WAN -> internet
```

It is authenticated and scoped to MAX API/CDN traffic by the bridge. The router
does not classify Channel M with `STEALTH_DOMAINS`, `VPN_STATIC_NETS`, policy
DNS or selected full-VPS rules.

The active reverse lane does not need a new inbound public port on the home
router and does not reuse Channel C. The optional direct public lane may use
separate source-allowlisted ingress material, but sharing Channel C `:443` for
MAX would require an explicit multiplexing/auth-user design and is intentionally
outside the default policy.

## Policy Layers

Layer 0 is endpoint/client policy.

- Shadowrocket, SFI, sing-box client profiles and QR artifacts choose how a
  selected endpoint reaches home.
- Proof profiles should be simple enough to prove that traffic reaches the
  intended channel. For Shadowrocket this means `FINAL,PROXY` proof config, not
  a Geo/RU direct split.
- Client-side GeoIP/RU/direct rules are a compatibility option only. They must
  not be treated as the production managed split, because they bypass the
  router's catalog semantics.

Layer 1 is channel ingress.

- Channel A home Reality lands in sing-box `reality-in`.
- Channel B selected clients land in the local relay and then
  `channel-b-relay-socks`.
- Channel C1 native Naive lands in `channel-c-naive-in`.
- C1-Shadowrocket compatibility lands in `channel-c-shadowrocket-http-in`.
- These inbounds are isolated from each other by port, credentials and deploy
  playbooks.
- Channel M service egress lands in `channel-m-maxtg-max-egress` and is
  isolated by port, TLS/auth credentials and source CIDR allowlist.

Layer 2 is the shared router managed split plus the selected full-VPS override.

- Managed domains and static CIDRs go to `reality-out`.
- Non-managed destinations go to `direct-out` through the home WAN.
- Selected home Wi-Fi/LAN source IPs and selected Channel A Home Reality
  `auth_user` values can bypass the catalog decision for internet-bound traffic
  and go straight to `reality-out`. Local/private destinations remain direct.
- Plain DNS port `53` from remote selected-client inbounds is sent to
  router-local dnsmasq. dnsmasq then applies the same policy-based DNS split as
  Wi-Fi/LAN: managed/foreign names use the dnscrypt-over-Reality path, while
  RU/direct/default names use the home/RF/default resolver.
- A small explicit direct exception set exists for known local/trusted
  destinations such as selected banking and telemetry domains.
- Channel M does not use the shared managed split. Its single service route is
  `channel-m-maxtg-reverse-egress -> direct-out`, so MAX API/CDN sees the home
  WAN IP without touching A/B/C routing or DNS ownership.

Layer 3 is the upstream exit.

- `reality-out` is the stable logical managed egress tag. In normal mode it
  uses Reality/Vision toward the owned VPS; in explicit reserve mode it can use
  a Vault-backed router-only backup Reality provider profile. Target sites see
  the active managed egress, not the home WAN.
- `direct-out` uses the home WAN; target sites see the home Russian IP.
- The VPS should not be visible to the mobile operator as the first hop for
  home-first mobile channels.
- For Channel M, the VPS hosts only the bridge-local reverse listener while the
  home router remains the egress lane. Target MAX sites see the home WAN IP;
  A/B/C managed egress state is irrelevant.

## Managed Catalog Contract

`STEALTH_DOMAINS` and `VPN_STATIC_NETS` define the managed set. Names are partly
historical, but the behavior is current:

```text
managed domain or static CIDR
  -> router managed split
  -> reality-out
  -> active managed egress
```

This is true for non-selected LAN/Wi-Fi and for mobile Channels A/B/C after the
endpoint has entered the router. `api.ipify.org` is only a canary for this
contract. The real requirement is that every managed catalog destination behaves
the same way unless a Channel A selected full-VPS override explicitly applies.

Manual, automatic and static policy sources must stay distinct:

- manual managed domains: `configs/dnsmasq-stealth.conf.add`
- local/private managed catalog hook on the router, if present
- auto-discovered managed domains: `/jffs/configs/dnsmasq-autodiscovered.conf.add`
- static managed CIDRs: `configs/static-networks.txt`
- explicit no-VPN/direct policy: `configs/domains-no-vpn.txt`

Direct/skip policy must not auto-promote into the managed route.

## Curated Foreign Policy

GhostRoute intentionally uses a curated managed catalog, not a blanket
foreign-TLD rule.

```text
known managed foreign service -> VPS traffic + dnscrypt-over-Reality DNS
known RU/direct service       -> home/RF traffic + home/RF DNS
unknown/default destination   -> home/RF path until classified
```

This is the trade-off that keeps Russian/direct sites from seeing the VPS
resolver while still giving selected foreign services a consistent VPS profile.
Do not add broad rules such as `.com`, `.net`, `.org`, `.io` or `.ai` to the
managed catalog by default. They make unknown foreign traffic easier, but they
also push too much unrelated traffic and DNS through the VPS.

Subdomains are already covered by a base-domain rule. For example:

```text
ipset=/claude.ai/STEALTH_DOMAINS
```

covers `claude.ai`, `api.claude.ai`, `random.claude.ai` and deeper names under
that same base domain. It does not cover sibling/base domains such as
`claudeusercontent.com`, `anthropic-cdn.net` or `browserleaks.net`. When a
managed service breaks, inspect DNS/logs, identify the new base domains, add
only those domains to `configs/dnsmasq-stealth.conf.add`, redeploy, and verify.

## Two Runtime Selection Points

GhostRoute has one policy intent but two runtime selection points.

The LAN/Wi-Fi selection point is `dnsmasq + ipset + iptables`:

```text
Wi-Fi/LAN device
  -> router DNS / dnsmasq
  -> dnsmasq resolves a managed domain
  -> dnsmasq adds the resolved IPv4 address to STEALTH_DOMAINS
  -> iptables REDIRECT sends matching TCP to sing-box redirect-in
  -> reality-out -> active managed egress
```

This is necessary because ordinary LAN clients are not inside sing-box when the
decision starts. The router first needs DNS-populated ipsets and packet rules to
catch the selected destination IPs.

The mobile/selected-client selection point is sing-box itself:

```text
iPhone / selected endpoint
  -> Channel A/B/C ingress on the router
  -> sing-box sniffs TLS SNI / HTTP Host where available
  -> matches stealth-domains.json / stealth-static.json
  -> reality-out -> active managed egress
```

This is necessary because selected-client traffic is already inside sing-box
after ingress. Routing it by domain rule-set is more reliable than waiting for a
LAN DNS lookup to populate `STEALTH_DOMAINS`.

The duplication is therefore intentional runtime representation, not duplicated
manual policy. Operators edit the managed catalogs once; deployment and
`update-singbox-rule-sets.sh` create the forms required by each datapath:

```text
configs/dnsmasq-stealth.conf.add
  -> dnsmasq/ipset runtime for Wi-Fi/LAN
  -> sing-box source rule-set runtime for mobile Channels A/B/C
  -> dnsmasq managed-VPS-DNS include for foreign managed names only
```

DNS selection is intentionally separate from traffic selection:

```text
managed foreign domain
  -> DNS via router dnscrypt-proxy -> sing-box SOCKS
  -> reality-out
  -> traffic via reality-out -> active managed egress

RU/direct/default domain
  -> DNS via home/RF/default resolver
  -> traffic via direct-out/home WAN unless separately classified as managed
```

RU TLDs and entries in `configs/domains-no-vpn.txt` must not be written into
the managed DNS include. This prevents Russian sites from seeing the managed
resolver path when their web traffic is intended to stay on the home/RF path.

The current managed DNS target is router-local dnscrypt-proxy. dnscrypt sends
DoH through sing-box SOCKS and `reality-out`, so managed lookups cross Reality
without depending on a separate VPS Unbound leg. `vps-dns-in` remains as a
DNS hijack compatibility listener for inbound/mobile paths. On the VPS, public
TCP/443 must be open for Reality/Caddy, while public `53/tcp,udp` stays denied
from the internet. Any optional VPS private DNS listener is restricted only.

In policy-split mode, generated managed DNS entries point dnsmasq to the
router-local dnscrypt listener. dnscrypt sends its DoH upstream traffic through
sing-box SOCKS/Reality. `vps-dns-in` still exists for inbound/mobile DNS hijack
compatibility, and its internal TCP DNS server also detours through
`reality-out`. This is a transport choice, not a classification change:
managed domains still take the protected path, and RU/direct/default domains
still use home/RF/default upstreams.

## Runtime Implementation Map

The routing principles above are implemented in these places:

- `ansible/roles/singbox_client/templates/config.json.j2`
  - sing-box inbounds for A/B/C and Channel M
  - `stealth-domains` and `stealth-static` rule-sets
  - shared post-ingress rules to `reality-out` or `direct-out`
  - Channel M direct-only rule for `channel-m-maxtg-max-egress`
- `ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2`
  - LAN/Wi-Fi TCP REDIRECT for `STEALTH_DOMAINS` / `VPN_STATIC_NETS`
  - UDP/443 DROP for managed destinations
  - INPUT, MSS and connlimit rules for mobile ingress ports
  - Channel M source allowlist and deny-by-default INPUT rules for its separate
    service port
- `modules/routing-core/router/update-singbox-rule-sets.sh`
  - mirrors dnsmasq/ipset/static policy into sing-box rule-set files for mobile
    Channels A/B/C
  - generates `/jffs/configs/dnsmasq-vps-managed.conf.add` for policy-based DNS
    consistency, pointing managed domains at the dnscrypt-backed local forwarder
- `configs/dnsmasq-stealth.conf.add`
  - manual managed domain catalog
- `configs/static-networks.txt`
  - managed static CIDR catalog
- `configs/domains-no-vpn.txt`
  - explicit direct/skip domain policy

## Channel-Specific Expectations

Channel A owns the router data plane.

- LAN/Wi-Fi managed TCP is transparently redirected to sing-box.
- Remote Home Reality clients land in `reality-in`.
- Non-selected devices/profiles keep the managed split: managed destinations go
  through `reality-out`; non-managed destinations go through `direct-out`.
- Optional selected full-VPS sets are still Channel A: selected home Wi-Fi/LAN
  source IPs use TPROXY into `channel-a-selected-lan-full-vps-in`, and selected
  Home Reality `auth_user` profiles route to `reality-out` before the normal
  managed/direct split. This does not change non-selected devices or Channel B/C
  ownership.

Channel B is selected-client production.

- It gives selected endpoints a different first-hop protocol.
- It must reuse the same router managed split as Channel A.
- It must not mutate Channel A REDIRECT ownership, DNS ownership or recovery
  behavior.

Channel C is selected-client home-first.

- C1-Shadowrocket is HTTPS CONNECT/TLS compatibility and is live-proven on the
  iPhone.
- C1-sing-box is the native Naive design, server-ready, but currently blocked on
  tested SFI/sing-box `1.11.4` because that client does not support outbound
  `type: naive`.
- Both C1 variants must enter the same router managed split after ingress.

Channel M is service-only MAX egress.

- It accepts only authenticated HTTP CONNECT inside the router-initiated SSH
  reverse tunnel.
- It routes `channel-m-maxtg-reverse-egress` directly to `direct-out`.
- It must not mutate Channel A/B/C ownership, DNS policy, managed catalogs or
  LAN/Wi-Fi routing.
- It is not a fallback channel for clients; if `maxtg_bridge` cannot reach it,
  the bridge should report MAX degraded instead of changing router policy.

## DNS And IPv6 Principles

The primary DNS goal is no leak to the endpoint's first network, especially the
mobile operator. Resolver geography shown by BrowserLeaks is a secondary
fingerprint-consistency signal, not the main security property.

Expected behavior:

- Plain DNS `53` from selected mobile clients follows the active channel to the
  router, then goes to router-local dnsmasq.
- dnsmasq sends only managed/foreign domains to dnscrypt-proxy, which sends DoH
  over sing-box SOCKS/Reality.
- RU/direct/default DNS stays on the home/RF/default resolver path.
- DoH/DoT created inside an app is not fully blocked in v1 and remains a proof
  checklist item.
- IPv6 remains disabled or filtered until there is a separate dual-stack routing
  design.
- UDP/443 to managed destinations is dropped on LAN/Wi-Fi to force TCP fallback
  into the inspected/managed path.

## Invariants

- A/B/C are explicit channels, not automatic failover for each other.
- The mobile operator should see endpoint -> home IP/DDNS, not endpoint -> VPS.
- The home ISP can see that the router connects outward, including to the VPS;
  it should not receive the endpoint's original direct browsing flow.
- Managed destinations must not silently fall through to home WAN direct.
- Non-managed destinations must not be forced to VPS just because they arrived
  through a mobile channel.
- Tests and traffic reports should treat `api.ipify.org` as a managed canary,
  while checking the broader managed catalog contract.
