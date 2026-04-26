# Traffic Observability

Этот документ описывает, как читать traffic/health слой после финального ухода от Channel A и перехода на Reality-only routing.

## Current Routing Context

| Source | Egress | Accounting note |
|---|---|---|
| LAN/Wi-Fi (`br0`) | REDIRECT `:<lan-redirect-port>` -> sing-box -> Reality for matched TCP destinations | Device byte accounting is best-effort; `RC_LAN_REALITY_*` mangle counters provide the `Via Reality` view |
| Remote mobile QR clients | home IP `:<home-reality-port>` -> sing-box home Reality inbound -> managed split | LTE carrier sees the home IP; `RC_MOBILE_REALITY_*` counters show encrypted Home Reality ingress bytes by source IP/profile |
| Router `OUTPUT` | main routing unless an explicit proxy is used | Router-originated traffic is not transparently captured to avoid proxy loops |
| WAN/default | ISP WAN | Non-matched traffic remains direct |

Channel A (`wgs1` + `wgc1`) is retired in normal operation. `wgc1_*` NVRAM remains as cold fallback only; active reports should not depend on a live WireGuard interface.

## Observer Semantics

`ifconfig.me`, anti-fraud checkers, and "VPN suspicion" pages report the
website-facing exit. For managed domains that exit is intentionally the VPS
VPS, so these tools can report VPS datacenter/suspicious. That does not
contradict the mobile-ingress goal: LTE carriers see the iPhone connecting to
the home ASUS IP first.

For local Russian services that are not in `STEALTH_DOMAINS` or
`VPN_STATIC_NETS`, traffic remains direct through the home WAN. This applies to
both LAN clients and mobile clients that entered through Home Reality. Those
services should see the home Russian IP, not VPS. If a Russian service
unexpectedly sees VPS, check whether its domain or CDN CIDR was added to the
managed catalog.

For the full end-to-end workflow and observer table, see
[network-flow-and-observer-model.md](network-flow-and-observer-model.md).

---

## Tools

| Tool | Purpose |
|---|---|
| `./verify.sh` | compact live health summary |
| `./scripts/router-health-report` | sanitised Markdown state for humans/LLMs |
| `./scripts/router-health-report --save` | tracked snapshot + local journal + router-side copy |
| `./scripts/traffic-report [period]` | canonical scheme usage report: exits, paths, devices, mobile QR, destinations, routing checks |
| `./scripts/traffic-daily-report` | compatibility backend for saved day/week/month snapshot periods |
| `./scripts/catalog-review-report` | advisory review of domains/static networks |
| `./scripts/dns-forensics-report` | hourly DNS-interest snapshots |

---

## Device Labels

Traffic and DNS reports share one local device label source:

```text
secrets/device-metadata.local.tsv
```

Format:

```text
# ip-or-key|friendly alias|device type
192.168.50.21|Denis laptop|Windows laptop
192.168.50.150||iPad
192.168.50.195||iPad
```

The shared parser lives in `scripts/lib/device-labels.sh`. These reports consume
the same map:

- `./scripts/traffic-report`
- `./scripts/traffic-daily-report`
- `./scripts/dns-forensics-report`

Default output stays redacted (`lan-host-01`, `mobile-source-01`). For trusted
local inspection set `REPORT_REDACT_NAMES=0`; then LAN rows show aliases/types
such as `iPad`, `Windows laptop`, or `Office desktop (Windows PC)`.

---

## Health Invariants

`router-health-report` now expects:

```text
STEALTH_DOMAINS exists
VPN_DOMAINS absent
VPN_STATIC_NETS exists
sing-box REDIRECT listener :<lan-redirect-port> exists
sing-box home Reality listener :<home-reality-port> exists
LAN TCP REDIRECT rules exist for STEALTH_DOMAINS and VPN_STATIC_NETS
LAN UDP/443 DROP rules exist for STEALTH_DOMAINS and VPN_STATIC_NETS
legacy fwmark 0x2000/table 200/singbox0 are absent
fwmark 0x1000/0x1000 -> wgc1 is absent
RC_VPN_ROUTE is absent
wgs1/wgc1 runtime interfaces are absent or disabled
wgc1 cold-fallback NVRAM fields are preserved
```

This is intentional drift detection. If the report complains about `VPN_DOMAINS`, `RC_VPN_ROUTE`, `0x1000`, `wgs1`, or `wgc1` runtime hooks, the router has slipped back toward the legacy Channel A path.

---

## Snapshot Collection

### `cron-traffic-snapshot`

Runs on the router and stores:

- interface counters: `wan0`, `br0`, radios, and other active non-Channel-A interfaces
- LAN per-device mangle counters:
  `RC_LAN_REALITY_OUT/IN`, `RC_LAN_BYTES_OUT/IN`
- Mobile Home Reality mangle counters:
  `RC_MOBILE_REALITY_IN/OUT`
- `tailscale status --json`

Primary storage:

```text
/opt/var/log/router_configuration
```

Fallback:

```text
/jffs/addons/router_configuration/traffic
```

### `cron-traffic-daily-close`

Stores end-of-day conntrack snapshots for local LAN clients.

### DNS forensics

`domain-auto-add.sh` stores hourly DNS-interest snapshots before log rotation.

Primary:

```text
/opt/var/log/router_configuration/dns-forensics/
```

Fallback:

```text
/jffs/addons/router_configuration/dns-forensics/
```

DNS forensics show interest, not bytes.

---

## Reading Traffic Reports

`traffic-report` combines:

- interface deltas
- per-device mangle counter deltas
- mobile Home Reality encrypted tunnel byte deltas
- mobile Home Reality connection attribution from `sing-box.log`
- Tailscale peer deltas
- current conntrack snapshot

`traffic-report [period]` is the main human-facing report. Supported periods are
`today`, `yesterday`, `week`, `month`, and a specific `YYYY-MM-DD`.

Canonical sections:

- `EXIT SUMMARY` — WAN/Wi-Fi totals plus how much left via VPS vs home
  Russian direct exit.
- `PATH MATRIX` — source, first hop, router decision, exit and what the final
  site sees.
- `MANAGED CATALOG` — active `STEALTH_DOMAINS`/static route coverage and how
  much traffic used the managed path.
- `LAN/WI-FI DEVICES` — per-device bytes via VPS vs home Russian direct.
- `MOBILE QR CLIENTS` — QR/profile connection split plus LTE ingress bytes.
- `SITES / DESTINATIONS` — current-day top mobile destinations and whether they
  used VPS or home Russian direct.
- `ROUTING MISTAKES / CHECKS` — heuristic warnings for likely wrong routing,
  such as RU/direct-looking destinations via VPS, managed destinations going
  direct, direct DNS-like mobile destinations, unresolved mobile flows, or
  RU-looking domains in the managed catalog.

For current-day reports it combines:

- live interface deltas;
- LAN/Wi-Fi byte counters;
- Mobile Home Reality byte counters;
- mobile destination attribution from `sing-box.log`;
- routing mistake heuristics.

For closed day/week/month reports it uses the saved snapshot backend
(`traffic-daily-report`) and keeps the same high-level section names where the
data exists.

The saved snapshot backend builds period deltas from:

- `interface-counters.tsv` for WAN/LAN bridge/Wi-Fi totals
- `lan-device-counters.tsv` for LAN `Reality` / direct `WAN` / `Other`
- `mobile-reality-counters.tsv` for Mobile Home Reality upload/download bytes

The script takes a fresh snapshot first, then computes first-to-last deltas
inside the requested nominal window.

Important interpretation:

- REDIRECT `:<lan-redirect-port>` counters and sing-box logs are the primary matched LAN egress signal.
- `Via Reality` is counted by mangle rules before nat REDIRECT rewrites the destination.
- `Direct WAN` is counted by per-device `FORWARD ... -o/-i wan0` rules.
- Per-device LAN byte accounting is best-effort and based on router-side counters, not app telemetry.
- `MOBILE QR CLIENTS` combines two signals:
  - byte totals from router-side TCP/<home-reality-port> counters
    (`RC_MOBILE_REALITY_IN/OUT`)
  - connection attribution from `sing-box.log`: client profile names,
    `reality-out` vs `direct-out`, EOF/error count and top destinations
- Mobile byte counters are measured at the encrypted Home Reality ingress. They
  show how much traffic came through the QR tunnel, not how those bytes split
  after sing-box chose `reality-out` vs `direct-out`.
- Per-profile mobile bytes are attributed by remote source IP observed in
  `sing-box.log`. If several profiles share one carrier NAT IP during the same
  window, the report uses a combined source label.
- `router-health-report` includes the mobile Home Reality summary in the common
  `Traffic Snapshot` block.
- Mobile Home Reality clients are not LAN devices; use `MOBILE QR CLIENTS` for
  profile activity and `LAN/WI-FI DEVICES` for home Wi-Fi/LAN devices.
- `ROUTING MISTAKES / CHECKS` is heuristic. A warning means "review catalog or
  no-vpn rules", not automatic proof of breakage.

---

## Recommended Commands

```bash
./verify.sh
./scripts/router-health-report
./scripts/traffic-report today
./scripts/traffic-report yesterday
./scripts/traffic-report week
./scripts/traffic-report month
./scripts/catalog-review-report
```

Save operational state:

```bash
./scripts/router-health-report --save
./scripts/catalog-review-report --save
```

These commands do not mutate routing runtime except the `--save` variants writing documentation/report artifacts.

---

## Live Router Checks For Reports

```sh
iptables -t nat -vnL PREROUTING | grep 'redir ports <lan-redirect-port>'
iptables-save -t mangle -c | grep RC_LAN_REALITY
iptables-save -t mangle -c | grep RC_MOBILE_REALITY
tail -100 /opt/var/log/sing-box.log | grep redirect-in
tail -500 /opt/var/log/sing-box.log | grep 'inbound/vless\[reality-in\]'
iptables-save -t mangle -c | grep RC_LAN_BYTES
```

Use these when report totals look surprising.

---

## LLM-Safe Reporting

Reports redact sensitive identifiers by default. Keep it that way when sharing output.

Do not paste:

- raw VLESS URIs
- QR payloads
- vault secrets
- real endpoints if not needed
- unredacted peer names unless explicitly local/trusted

For trusted local inspection:

```bash
REPORT_REDACT_NAMES=0 ./scripts/traffic-report
REPORT_REDACT_NAMES=0 ./scripts/traffic-daily-report today
REPORT_REDACT_NAMES=0 ./scripts/traffic-daily-report yesterday
```

Do not commit unredacted output.
