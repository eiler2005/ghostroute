# ADR 0009: Managed DNS Uses The Dnscrypt-Backed Local Forwarder

## Context

GhostRoute policy-split DNS must keep managed foreign lookups away from client
and ISP resolvers while still letting dnsmasq classify domains and populate
`STEALTH_DOMAINS`. The previous generated include
`/jffs/configs/dnsmasq-vps-managed.conf.add` pointed managed domains at the
router `vps-dns-in` listener, which then hijacked DNS to a sing-box internal TCP
DNS server over `reality-out`.

That design depended on a separate VPS managed-DNS leg. If that leg returned
`SERVFAIL`, `EOF` or timed out, LAN/Wi-Fi clients could fail before routing even
started: managed domains did not resolve, ipsets did not populate reliably, and
applications reported no internet despite Reality/SOCKS egress being healthy.

The same incident showed a separate but related port boundary: public VPS
TCP/443 must be reachable from the router for Reality/Caddy, while public DNS
TCP/UDP 53 must stay closed.

## Decision

Generated managed DNS entries now point to the router-local dnscrypt listener:

```text
managed domain
  -> dnsmasq
  -> /jffs/configs/dnsmasq-vps-managed.conf.add
  -> 127.0.0.1#<dnscrypt-port>
  -> dnscrypt-proxy
  -> sing-box SOCKS
  -> reality-out
```

`dnscrypt-proxy` remains configured to use local sing-box SOCKS, so managed DNS
still leaves the home network through Reality. The filename
`dnsmasq-vps-managed.conf.add` is retained for compatibility, but its generated
target is dnscrypt-backed by default.

Router `vps-dns-in` remains present for inbound/mobile DNS hijack compatibility.
Its sing-box internal DNS server uses a bounded resolver over `reality-out`; it
is not the primary generated managed-domain dnsmasq target.

VPS port policy is:

- public TCP/443 is owned by Caddy/layer4 for Reality and must be allowed by
  both the provider firewall and the VPS host firewall for the router source;
- public TCP/UDP 53 remains denied;
- restricted/private DNS ports, when enabled, are not public and must be
  reachable only from the intended local/container/private source;
- SSH/admin ports are a control-plane concern and must not be confused with the
  data-plane Reality port.

## Consequences

Managed DNS no longer depends on the separate VPS Unbound leg for normal
LAN/Wi-Fi and A/B/C operation. The active check must test both managed DNS
resolution through router dnsmasq and managed egress through Reality, because
one can be healthy while the other is broken.

BrowserLeaks-style DNS output may show the dnscrypt upstream identity rather
than a private VPS Unbound resolver. That is acceptable when the DNS traffic
itself travelled through Reality and the mobile/home ISP did not see the
managed lookup.

Operational docs should describe `dnsmasq-vps-managed.conf.add` as the managed
DNS include, not as proof that managed DNS must terminate on VPS Unbound.
