# ADR 0006: Channel Terminology And Manual Fallbacks

## Status

Updated by [ADR 0007](0007-channel-b-production-channel-c-planned.md). This
record preserves the original naming and no-automatic-failover decision. ADR
0007 supersedes the earlier Channel B maturity statement and Channel C target
shape.

## Context

The router has one production data-plane path. Two additional manual
device-client lanes are documented for future work, but they are not
production-ready fallback channels today. The previously used WireGuard path is
deprecated and must not reuse the Channel A name.

## Decision

Channel names are fixed as follows:

- Channel A is the primary fast path: router `sing-box` REDIRECT to
  `VLESS + Reality + Vision` through the VPS.
- Channel B is a planned manual `VLESS + XHTTP + TLS` lane on a separate
  standalone Xray service behind Caddy TLS.
- Channel C is a future experimental `NaiveProxy`/HTTPS-forward-proxy
  compatibility lane on a separate SNI hostname. Naive remains experimental
  until supported client import, connection and real app egress are proven.
- Previously used WireGuard is named deprecated WireGuard cold fallback.

Channel B and Channel C remain add-only future v1 lanes. They use separate
ordinary-looking public hostnames on the existing VPS public `:443` and share
that port by Caddy routing/SNI. They must not install binaries on the router,
add router local SOCKS/HTTP ports, change DNS, REDIRECT, TUN or automatic
failover, or reuse/rename the existing Reality SNI.

Caddy remains the intended single public `:443` owner. Its layer4 route must
preserve the existing Reality SNI path to the current 3x-ui/Xray inbound.
Channel B's target shape is reverse proxy on a configured random path to a
localhost-only Xray XHTTP listener. Channel C's target shape is NaiveProxy or an
HTTPS forward-proxy-compatible backend behind its own SNI hostname.

Any client artifacts for Channel B and Channel C are generated separately from
the existing router, home-client and emergency Reality profiles and remain
experimental until a future compatibility pass promotes them.

## Consequences

Channel A stays stable and remains the only router-managed production path.
Channel B and Channel C are imported and tested manually on selected devices
only during future implementation work. Operational verification for production
health must not require B/C. Any future B/C verification must prove import,
connection, real egress and that Channel A Reality, router REDIRECT, DNS and
deprecated WireGuard drift invariants remain unchanged.

Secrets for Channel B/C hostnames, paths, UUIDs and Naive credentials stay in
Ansible Vault. Generated QR/config artifacts stay under gitignored local output
directories.
