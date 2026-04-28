# ADR 0007: Channel B Production And Channel C Planned

## Context

ADR 0006 fixed the channel names while Channel B and Channel C were still
future/manual lanes. Channel B has since become a working home-first path for
selected device-client profiles. Channel C is still a compatibility lane that
needs a separate live proof before promotion.

## Decision

Channel maturity is now:

- Channel A is the production router data plane for LAN/Home Reality managed
  traffic through the VPS Reality/Vision egress.
- Channel B is production for selected device-client profiles. It terminates a
  dedicated home XHTTP/TLS ingress on the router, relays into local sing-box
  SOCKS, and reuses the same managed split and Reality/Vision upstream as
  Channel A.
- Channel C is a planned C1 home-first compatibility lane for Naive/HTTPS-style
  clients. It terminates on the home router, then reuses router-side sing-box
  managed split and Reality/Vision egress. It remains outside production health
  until SFI/sing-box client import, connection and real app egress are proven.
- No channel provides automatic failover for another channel.

## Consequences

Channel B documentation, generated artifacts and runbooks should describe it as
selected-client production, not as abandoned research or future-only work.
Channel B still must not mutate Channel A REDIRECT ownership, router DNS, TUN
state or automatic recovery behavior.

Channel C documentation should describe an active planned home-first lane with
explicit acceptance criteria. The removed VPS-only Squid/stunnel/tinyproxy
design must stay out of active deployment docs. C1 must not be included in
required production checks until its own compatibility proof exists.

Live router validation is intentionally separate from repo-only CI: CI checks
syntax, fixtures and secret hygiene, while Channel A/B/C runtime proof remains a
router/VPS operator task.
