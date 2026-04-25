# Traffic Observability

Этот документ описывает, как читать traffic/health слой после финального ухода от Channel A и перехода на Reality-only routing.

## Current Routing Context

| Source | Egress | Accounting note |
|---|---|---|
| LAN/Wi-Fi (`br0`) | REDIRECT `:<lan-redirect-port>` -> sing-box -> Reality for matched TCP destinations | Device byte accounting is best-effort; REDIRECT counters are now the primary Channel B signal |
| Remote mobile QR clients | home IP `:<home-reality-port>` -> sing-box home Reality inbound -> VPS Reality outbound | LTE carrier sees the home IP; router/VPS counters show the forwarded traffic |
| Router `OUTPUT` | main routing unless an explicit proxy is used | Router-originated traffic is not transparently captured to avoid proxy loops |
| WAN/default | ISP WAN | Non-matched traffic remains direct |

Channel A (`wgs1` + `wgc1`) is retired in normal operation. `wgc1_*` NVRAM remains as cold fallback only; active reports should not depend on a live WireGuard interface.

## Observer Semantics

`ifconfig.me`, anti-fraud checkers, and "VPN suspicion" pages report the
website-facing exit. For managed domains that exit is intentionally the VPS
VPS, so these tools will flag `198.51.100.10` as a datacenter IP. That does
not contradict the mobile-ingress goal: LTE carriers see the iPhone connecting
to the home ASUS IP first.

For local Russian services that are not in `STEALTH_DOMAINS` or
`VPN_STATIC_NETS`, traffic remains direct through the home WAN. Those services
should see the home Russian IP, not VPS. If a Russian service unexpectedly
sees VPS, check whether its domain or CDN CIDR was added to the managed
catalog.

---

## Tools

| Tool | Purpose |
|---|---|
| `./verify.sh` | compact live health summary |
| `./scripts/router-health-report` | sanitised Markdown state for humans/LLMs |
| `./scripts/router-health-report --save` | tracked snapshot + local journal + router-side copy |
| `./scripts/traffic-report` | current-day traffic summary |
| `./scripts/traffic-daily-report` | closed day/week/month traffic summary |
| `./scripts/catalog-review-report` | advisory review of domains/static networks |
| `./scripts/dns-forensics-report` | hourly DNS-interest snapshots |

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
- LAN per-device mangle counters
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
- Tailscale peer deltas
- current conntrack snapshot

Important interpretation:

- REDIRECT `:<lan-redirect-port>` counters and sing-box logs are the primary matched LAN egress signal.
- Per-device LAN byte accounting is best-effort and based on router-side counters, not app telemetry.

---

## Recommended Commands

```bash
./verify.sh
./scripts/router-health-report
./scripts/traffic-report
./scripts/traffic-daily-report yesterday
./scripts/traffic-daily-report week
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
tail -100 /opt/var/log/sing-box.log | grep redirect-in
iptables-save -t mangle -c | grep rcacct
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
```

Do not commit unredacted output.
