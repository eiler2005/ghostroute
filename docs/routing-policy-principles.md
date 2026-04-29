# Routing Policy Principles

This document is the compact source for GhostRoute routing principles. It
explains what must stay true across Channel A, Channel B and Channel C. The
runtime implementation still lives in Ansible templates, router scripts and
domain catalogs listed below.

## Core Contract

All managed channels are home-first.

```text
endpoint / LAN device
  -> home router
  -> router-side ingress
  -> shared managed split
       managed destinations     -> reality-out / Vision -> VPS -> internet
       non-managed destinations -> direct-out via home WAN -> internet
```

The endpoint client may choose the first-hop channel, but it must not become the
main policy engine. The router owns the managed-vs-direct decision after traffic
has reached home.

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

Layer 2 is the shared router managed split.

- Managed domains and static CIDRs go to `reality-out`.
- Non-managed destinations go to `direct-out` through the home WAN.
- Plain DNS port `53` from remote selected-client inbounds is sent to
  router-local dnsmasq. dnsmasq then applies the same policy-based DNS split as
  Wi-Fi/LAN: managed/foreign names use VPS DNS, while RU/direct/default names
  use the home/RF/default resolver.
- A small explicit direct exception set exists for known local/trusted
  destinations such as selected banking and telemetry domains.

Layer 3 is the upstream exit.

- `reality-out` uses Reality/Vision toward the VPS; target sites see the VPS
  exit IP.
- `direct-out` uses the home WAN; target sites see the home Russian IP.
- The VPS should not be visible to the mobile operator as the first hop for
  home-first mobile channels.

## Managed Catalog Contract

`STEALTH_DOMAINS` and `VPN_STATIC_NETS` define the managed set. Names are partly
historical, but the behavior is current:

```text
managed domain or static CIDR
  -> router managed split
  -> reality-out
  -> VPS exit
```

This is true for LAN/Wi-Fi and for mobile Channels A/B/C after the endpoint has
entered the router. `api.ipify.org` is only a canary for this contract. The real
requirement is that every managed catalog destination behaves the same way.

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
known managed foreign service -> VPS traffic + VPS DNS
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
  -> reality-out -> VPS
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
  -> reality-out -> VPS
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
  -> DNS via router vps-dns-in -> hijack-dns/vps-dns-server
  -> reality-out -> VPS Unbound
  -> traffic via reality-out -> VPS

RU/direct/default domain
  -> DNS via home/RF/default resolver
  -> traffic via direct-out/home WAN unless separately classified as managed
```

RU TLDs and entries in `configs/domains-no-vpn.txt` must not be written into
the VPS DNS include. This prevents Russian sites from seeing the VPS resolver
when their web traffic is intended to stay on the home/RF path.

The VPS resolver is not public. The current VPS Reality endpoint is served by
the existing `3x-ui`/Xray Docker container behind Caddy. Because
`127.0.0.1` inside that container is container-local, the managed DNS target is
the configured `vps_unbound_reality_target_host:15353`, not container-local
loopback. UFW allows `15353` only from the Xray Docker bridge, and public
`53/tcp,udp` stays denied from the internet.

In policy-split mode, router sing-box uses `hijack-dns` plus an internal TCP
DNS server with `detour: reality-out` for the managed DNS forwarder. This is a
transport choice, not a classification change: managed domains still use the
VPS DNS path, and RU/direct/default domains still use home/RF/default upstreams.

## Runtime Implementation Map

The routing principles above are implemented in these places:

- `ansible/roles/singbox_client/templates/config.json.j2`
  - sing-box inbounds for A/B/C
  - `stealth-domains` and `stealth-static` rule-sets
  - shared post-ingress rules to `reality-out` or `direct-out`
- `ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2`
  - LAN/Wi-Fi TCP REDIRECT for `STEALTH_DOMAINS` / `VPN_STATIC_NETS`
  - UDP/443 DROP for managed destinations
  - INPUT, MSS and connlimit rules for mobile ingress ports
- `modules/routing-core/router/update-singbox-rule-sets.sh`
  - mirrors dnsmasq/ipset/static policy into sing-box rule-set files for mobile
    Channels A/B/C
  - generates `/jffs/configs/dnsmasq-vps-managed.conf.add` for policy-based DNS
    consistency
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
- After ingress, managed destinations go through `reality-out`; non-managed
  destinations go through `direct-out`.

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

## DNS And IPv6 Principles

The primary DNS goal is no leak to the endpoint's first network, especially the
mobile operator. Resolver geography shown by BrowserLeaks is a secondary
fingerprint-consistency signal, not the main security property.

Expected behavior:

- Plain DNS `53` from selected mobile clients follows the active channel to the
  router, then goes to router-local dnsmasq.
- dnsmasq sends only managed/foreign domains to VPS Unbound over Reality.
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
