# Traffic Observability

Этот документ описывает, как читать traffic/health слой после перехода на двухканальную маршрутизацию.

## Current Routing Context

| Source | Egress | Accounting note |
|---|---|---|
| LAN/Wi-Fi (`br0`) | REDIRECT `:<lan-redirect-port>` -> sing-box -> Reality for matched TCP destinations | Device byte accounting is best-effort; REDIRECT counters are now the primary Channel B signal |
| Router `OUTPUT` | main routing unless an explicit proxy is used | Router-originated traffic is not transparently captured to avoid proxy loops |
| Remote WG clients (`wgs1`) | `wgc1` for matched destinations | Per-peer stats come from `wg show wgs1 dump` |
| WAN/default | ISP WAN | Non-matched traffic remains direct |

Historical labels such as `VPN total` may still refer to the old interface counter `wgc1`. Interpret them with the current routing matrix in mind.

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
VPN_DOMAINS exists
VPN_STATIC_NETS exists
sing-box REDIRECT listener :<lan-redirect-port> exists
LAN TCP REDIRECT rules exist for STEALTH_DOMAINS and VPN_STATIC_NETS
LAN UDP/443 reject rules exist for STEALTH_DOMAINS and VPN_STATIC_NETS
legacy fwmark 0x2000/table 200/singbox0 are absent
fwmark 0x1000/0x1000 -> wgc1
wgs1 -> RC_VPN_ROUTE enabled
br0 -> RC_VPN_ROUTE disabled
OUTPUT -> RC_VPN_ROUTE disabled
wgs1 -> STEALTH_DOMAINS disabled
```

This is intentional drift detection. If the report complains that `br0 -> RC_VPN_ROUTE` is still enabled, it means LAN has slipped back toward the legacy WGC1 path.

---

## Snapshot Collection

### `cron-traffic-snapshot`

Runs on the router and stores:

- interface counters: `wan0`, `wgc1`, `wgs1`, `br0`, radios
- LAN per-device mangle counters
- `tailscale status --json`
- `wg show wgs1 dump`

Primary storage:

```text
/opt/var/log/router_configuration
```

Fallback:

```text
/jffs/addons/router_configuration/traffic
```

### `cron-traffic-daily-close`

Stores end-of-day conntrack snapshots for local LAN clients and remote `wgs1` peers.

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
- WireGuard server peer deltas
- current conntrack snapshot

Important interpretation:

- `wgc1` bytes now mostly represent reserve/remote-client path plus any explicit legacy use.
- REDIRECT `:<lan-redirect-port>` counters and sing-box logs are the primary matched LAN egress signal.
- `wgs1` bytes mean remote WireGuard-server ingress/egress, not the upstream WGC1 tunnel.
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
ip -s link show wgc1
ip -s link show wgs1
wg show wgs1 dump
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
