# ADR 0006: Channel Terminology And Manual Fallbacks

## Context

The router now has one production data-plane path and two manual device-client
fallback lanes. The previously used WireGuard path is deprecated and must not
reuse the Channel A name.

## Decision

Channel names are fixed as follows:

- Channel A is the primary fast path: router `sing-box` REDIRECT to
  `VLESS + Reality + Vision` through the VPS.
- Channel B is manual `VLESS + XHTTP + TLS` on a separate standalone Xray
  service behind Caddy TLS.
- Channel C is manual `NaiveProxy`/HTTPS-forward-proxy compatibility on a
  separate SNI hostname. The active iOS-compatible backend is Caddy layer4 to a
  TLS wrapper and localhost-only Squid; Caddy `forward_proxy` remains an
  opt-in backend for native Naive-oriented experiments.
- Previously used WireGuard is named deprecated WireGuard cold fallback.

Channel B and Channel C are add-only in v1. They use separate ordinary-looking
public hostnames on the existing VPS public `:443` and share that port by
Caddy routing/SNI. They do not install binaries on the router, do not add
router local SOCKS/HTTP ports, do not change DNS, REDIRECT, TUN or automatic
failover, and do not reuse or rename the existing Reality SNI.

Caddy remains the single public `:443` owner. Its layer4 route preserves the
existing Reality SNI path to the current 3x-ui/Xray inbound. Channel B is
reverse-proxied only on its configured random path to a localhost-only Xray
XHTTP listener. Channel C uses an SNI route to a local TLS wrapper and Squid
forward proxy for Shadowrocket compatibility; the old Caddy `forward_proxy`
mode is retained only as an explicit backend option.

Client artifacts for Channel B and Channel C are generated separately from the
existing router, home-client and emergency Reality profiles.

## Consequences

Channel A stays stable and remains the only router-managed production path.
Channel B and Channel C are imported and tested manually on selected devices.
Channel B client artifacts pin XHTTP `packet-up` because the v1 backend sits
behind a conservative Caddy reverse proxy. Channel C emits both native
`naive+https://...` artifacts and plain `https://...` forward-proxy compatibility
artifacts; only the former should be described as NaiveProxy client config.
Operational verification must prove that Channel B/C are present when enabled
and that Channel A Reality, router REDIRECT, DNS and deprecated WireGuard drift
invariants remain unchanged.

Secrets for Channel B/C hostnames, paths, UUIDs and Naive credentials stay in
Ansible Vault. Generated QR/config artifacts stay under gitignored local output
directories.
