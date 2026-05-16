# Operational SLOs

GhostRoute is a single-operator routing platform, not a paying-customer
service. There is intentionally no external alerting and no on-call rotation
(see [ADR-0003](adr/0003-local-only-health-alerts.md)). What this document
defines is **what "working correctly" means** so the operator can decide
quickly whether the system needs intervention.

The SLOs below are aspirational targets, not contractual commitments. Each
target is paired with the specific local check that measures it.

## Availability

### A1. Channel A Reality listener is reachable

- **Target**: home Reality listener accepts TLS handshakes for ≥99% of
  attempts during any 24h window.
- **Measure**:

  ```bash
  ./modules/ghostroute-health-monitor/bin/router-health-report
  ./verify.sh
  ```
- **Evidence**: `Home Reality listener: OK` in router-health-report; no
  drift on `home_reality` invariants in `verify.sh`.
- **Action threshold**: a single failed run is normal noise; two consecutive
  failures or any failure during deploy gate triggers investigation.

### A2. VPS Caddy `:443` answers Reality handshakes

- **Target**: VPS edge accepts handshakes from the home router for ≥99% of
  attempts during any 24h window.
- **Measure**:

  ```bash
  ./modules/ghostroute-health-monitor/bin/live-check --active-probe
  cd ansible && ansible-playbook playbooks/99-verify.yml
  ```
- **Evidence**: `stealth-vps: ok=N failed=0` in `99-verify.yml`; deploy gate
  passes.
- **Action threshold**: failed deploy gate or `failed > 0` in
  `99-verify.yml` blocks deploys until resolved.

### A3. Channel B / Channel C ingress responds when enabled

- **Target**: when promoted, B/C ingress accepts client connections for
  ≥99% of attempts.
- **Measure**: `99-verify.yml` plus `traffic-report check`.
- **Evidence**: `Channel B home relay config: OK`,
  `sing-box Channel B relay SOCKS inbound: OK`; equivalent C blocks when
  C is enabled.
- **Action threshold**: never let a B/C regression land production-Channel-A
  changes — fix isolation first.

## Latency

### L1. Managed-domain time to first byte (TTFB) from a remote endpoint

- **Target**: ≤500 ms median, ≤1.5 s p99 for a managed HTTPS GET on a
  reasonable LTE link.
- **Measure**: per-device probe from the operator's known-good test client.
  Recorded informally; baseline expectations live in
  [`modules/performance-diagnostics/docs/routing-performance-troubleshooting.md`](../modules/performance-diagnostics/docs/routing-performance-troubleshooting.md).
- **Action threshold**: p99 above 3 s for two days running → run the
  performance-diagnostics checks (MSS clamp, retransmits, RTT to VPS).

### L2. LAN/Wi-Fi managed match adds ≤30 ms over direct

- **Target**: median LAN HTTPS GET to a managed domain is at most 30 ms
  slower than the same GET to a direct domain on the same client.
- **Measure**: ad-hoc, comparing two domains the operator knows are in /
  out of `STEALTH_DOMAINS`.
- **Action threshold**: ≥100 ms overhead on managed paths → suspect dnsmasq
  upstream, dnscrypt, or Reality outbound back-pressure.

### L3. Console page load TTFB

- **Target**: read-only Console pages return ≤500 ms p95 on the operator's
  network when the cache is warm.
- **Measure**: in-Console "Operator overview" footer plus manual sampling
  via DevTools.
- **Action threshold**: regular >2 s page loads → see the data-architecture
  refactor plan; not a routing problem.

## Correctness

### C1. No managed DNS leaks to the mobile carrier

- **Target**: zero managed-domain lookups visible to the LTE carrier
  resolver.
- **Measure**: `traffic-report check`; periodic external probe (BrowserLeaks
  on a remote test client).
- **Evidence**: no `mobile-resolver` rows in `traffic-report check`; LTE
  test shows the configured private/dnscrypt resolver, not the carrier
  default.
- **Action threshold**: any leak observation → see
  [`docs/dns-policy.md`](dns-policy.md) recovery section.

### C2. Managed websites see the active managed exit, not the home WAN IP

- **Target**: external IP-checker returns the active managed egress public IP
  for any managed-domain request from any production endpoint. In normal mode
  this is the configured VPS public IP; in explicit reserve mode it is the
  selected backup provider exit.
- **Measure**: `traffic-report today` shows VPS-vs-direct ratios; manual
  spot-check via the test client.
- **Action threshold**: any "managed→direct" mistake in `traffic-report
  check` → investigate routing-mistake check evidence; do not deploy on top
  of an unresolved mistake.

### C3. Non-selected non-managed websites see the home WAN IP

- **Target**: managed split correctly sends non-managed traffic from
  non-selected devices/profiles out the home WAN. Selected Channel A full-VPS
  devices/profiles are the explicit exception and intentionally tunnel
  internet-bound traffic through `reality-out`.
- **Measure**: `traffic-report today` direct-bytes share matches the
  expected fraction for the operator's usage; manual spot-check shows the
  home ISP IP for a non-managed domain.
- **Action threshold**: ratio drifts toward unexpected "100% via VPS" for
  non-selected traffic → suspect a catalog miscurate or a `RC_VPN_ROUTE`-style
  regression; the latter is a hard architecture invariant violation.

### C4. Channel B/C never silently mutates Channel A

- **Target**: zero changes to `STEALTH_DOMAINS`, REDIRECT, router DNS or
  TUN ownership when only `21-*` or `22-*` playbooks ran.
- **Measure**: `99-verify.yml` runs after every B/C change; `verify.sh`
  before and after.
- **Action threshold**: any drift attributed to a B/C playbook → revert the
  playbook change, file in `reports/`, do not retry without an isolation
  fix.

## Privacy / observer model

### P1. Mobile clients see home IP ingress, not VPS

- **Target**: every production remote-client session enters the home public
  IP first; no profile points an endpoint at the VPS as the first hop
  (except `router.conf`, which is the router's outbound identity, not a
  client profile).
- **Measure**: `client-profiles generate` output; profile review on each
  rotation.
- **Action threshold**: any client profile observed targeting the VPS
  directly → regenerate profiles and rotate Reality keys if leaked.

### P2. Public docs contain no real production state

- **Target**: zero real endpoints, ports, UUIDs, Reality keys, short IDs,
  admin paths, QR payloads, VLESS URIs in tracked files.
- **Measure**: `./modules/secrets-management/bin/secret-scan` clean on
  every commit.
- **Action threshold**: any finding → block the commit; rotate any value
  that may have leaked.

## Recovery time targets

These mirror [`SECURITY.md`](../SECURITY.md) §Recovery Boundaries; restated
here as SLO-style targets:

- **MTTR for Reality outage** (manual cold fallback): ≤15 min after
  operator decision.
- **MTTR for Vault loss** (offsite restore + key reissue): ≤2 h.
- **MTTR for Console DB corruption**: ≤30 min to baseline data; full
  7-day backfill on next normal collector cycle.
- **MTTR for Channel B/C ingress regression** (revert path): ≤15 min.

## Out of scope

- 99.9%+ availability anywhere — the home WAN, ISP and VPS provider all
  exceed our control.
- Active anti-blocking guarantees (no claim of working under any specific
  state-level filter).
- Throughput SLOs — speed is diagnosed separately via
  performance-diagnostics; not a correctness criterion.
- Multi-operator audit / role-based access SLOs.

## Review cadence

- Re-read this document after any incident that hits a recovery target.
- Re-read it on every channel promotion (B → production, C-Shadowrocket →
  production, C-sing-box → production).
- The SLO targets are intentionally informal; tighten them only when there
  is a concrete reason and a way to measure.
