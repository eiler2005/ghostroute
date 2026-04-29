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
- DNS ports from remote selected-client inbounds are forced through
  `reality-out` to avoid endpoint/LTE-side DNS leakage.
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

- DNS from selected mobile clients follows the active tunnel/channel.
- DNS ports `53` and `853` from A/B/C mobile inbounds are routed to
  `reality-out`.
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
