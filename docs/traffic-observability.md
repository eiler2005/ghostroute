# Traffic Observability

Этот документ описывает систему отчётности GhostRoute: как понять, сколько
трафика прошло через домашний интернет, сколько ушло через VPS, какие
устройства и приложения создают основную нагрузку, и не появились ли ошибки
маршрутизации.

Цель отчётов — дать один понятный operational view по всей схеме:

```text
Home Wi-Fi/LAN device
  -> ASUS router
  -> either VLESS+Reality -> VPS
  -> or home Russian WAN direct

Home Reality ingress client
  -> home IP :<home-reality-port>
  -> ASUS router
  -> either VLESS+Reality -> VPS
  -> or home Russian WAN direct
```

`Home Reality ingress client` — это не обязательно телефон и не обязательно
LTE. Это любой клиентский профиль, который вошёл на роутер через TCP/<home-reality-port>:
iPhone по LTE, MacBook по Wi-Fi, ноутбук в другой сети и т.д.

---

## What The Reports Answer

| Question | Where to look |
|---|---|
| Сколько всего прошло через физический WAN/ISP интерфейс роутера? | `EXIT SUMMARY -> WAN total` |
| Сколько пользовательского трафика видит GhostRoute accounting? | `EXIT SUMMARY -> Client observed total` |
| Сколько ушло через VPS? | `EXIT SUMMARY -> Via VPS` |
| Сколько осталось в российском direct-интернете? | `EXIT SUMMARY -> Via home RU direct` |
| Какие домашние Wi-Fi/LAN устройства больше всего используют VPS? | `LAN/WI-FI DEVICES` |
| Какие Home Reality ingress профили активны? | `HOME REALITY INGRESS CLIENTS` |
| Какие сайты/приложения популярны через ingress? | `SITES / DESTINATIONS` |
| Какие назначения вышли через VPS? | `Popular via VPS` |
| Какие назначения вышли через home Russian IP? | `Popular via home RU direct` |
| Мог ли российский сайт уйти через VPS? | `ROUTING MISTAKES / CHECKS` |
| Не ушёл ли managed-сайт напрямую? | `ROUTING MISTAKES / CHECKS` |
| Есть ли DNS-like direct-out внутри Home Reality? | `ROUTING MISTAKES / CHECKS` |

---

## Reporting Layers

GhostRoute intentionally separates three layers:

| Layer | What it measures | Byte quality |
|---|---|---|
| Interfaces | `wan0`, `br0`, Wi-Fi radios | exact kernel counters |
| LAN/Wi-Fi devices | traffic from home devices split into VPS vs RU direct | exact mangle byte counters, best-effort per device |
| Home Reality ingress | encrypted TCP/<home-reality-port> ingress plus sing-box split logs | ingress bytes exact; per-destination VPS/direct bytes estimated |

Why some numbers are estimated:

- The router knows exact bytes that entered through TCP/<home-reality-port>.
- sing-box logs show which destination used `reality-out` or `direct-out`.
- sing-box logs do not currently expose exact bytes per destination.
- Therefore destination-level traffic is marked `Est. traffic` and is allocated
  by connection share. This is good enough for popularity and routing review,
  but not billing-grade per-site accounting.

Important accounting rule:

- `WAN total` is the physical ISP-interface volume. It includes everything that
  crossed `wan0`.
- `LAN/Wi-Fi observed + Home Reality ingress + WAN remainder/unattributed`
  should add up to `WAN total` within rounding. This is the physical WAN view.
- `Client observed total` is the user-facing base for the report: LAN/Wi-Fi
  device traffic plus Home Reality ingress traffic.
- `Via VPS + Via home RU direct + Other/unresolved` should add up to
  `Client observed total` within rounding.
- `WAN total` is not expected to equal that split. For Home Reality ingress the
  same user flow crosses WAN twice: client -> home router, then router ->
  VPS/site. Router/background traffic can also be present.

## Current Routing Context

| Source | Egress | Accounting note |
|---|---|---|
| LAN/Wi-Fi (`br0`) | REDIRECT `:<lan-redirect-port>` -> sing-box -> Reality for matched TCP destinations | Device byte accounting is best-effort; `RC_LAN_REALITY_*` mangle counters provide the `Via Reality` view |
| Home Reality ingress clients | home IP `:<home-reality-port>` -> sing-box home Reality inbound -> managed split | First-hop network sees the home IP; `RC_MOBILE_REALITY_*` counters show encrypted Home Reality ingress bytes by source IP/profile |
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
| `./scripts/traffic-report [period]` | canonical scheme usage report: exits, paths, devices, Home Reality ingress clients, destinations, routing checks |
| `./scripts/traffic-daily-report` | compatibility backend for saved day/week/month snapshot periods |
| `./scripts/catalog-review-report` | advisory review of domains/static networks |
| `./scripts/dns-forensics-report` | hourly DNS-interest snapshots |

Use `traffic-report` as the main entrypoint:

```bash
./scripts/traffic-report today
./scripts/traffic-report yesterday
./scripts/traffic-report week
./scripts/traffic-report month
./scripts/traffic-report 2026-04-25
```

Use `router-health-report` when you need one compact state document for humans
or LLM handoff:

```bash
./scripts/router-health-report
./scripts/router-health-report --save
```

Use `dns-forensics-report` when the question is “who queried what around this
hour?”. DNS forensics show interest, not traffic volume:

```bash
./scripts/dns-forensics-report 2026-04-26T13
```

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
- Home Reality encrypted tunnel byte deltas
- Home Reality connection attribution from `sing-box.log`
- Tailscale peer deltas
- current conntrack snapshot

`traffic-report [period]` is the main human-facing report. Supported periods are
`today`, `yesterday`, `week`, `month`, and a specific `YYYY-MM-DD`.

Canonical sections:

- `EXIT SUMMARY` — physical WAN total, user-facing client observed total, and
  how that observed traffic splits into VPS vs home Russian direct.
- `PATH MATRIX` — source, first hop, router decision, exit and what the final
  site sees.
- `MANAGED CATALOG` — active `STEALTH_DOMAINS`/static route coverage and how
  much traffic used the managed path.
- `LAN/WI-FI DEVICES` — per-device bytes via VPS vs home Russian direct.
- `HOME REALITY INGRESS CLIENTS` — client/profile connection split plus Home
  Reality ingress bytes. The client can be on LTE or Wi-Fi; the common signal
  is TCP/<home-reality-port> into the home Reality inbound.
- `SITES / DESTINATIONS` — current-day top Home Reality destinations with
  estimated traffic, percentage of ingress usage, app/family labels, and
  separate popularity blocks for VPS vs home Russian direct.
- `ROUTING MISTAKES / CHECKS` — heuristic warnings for likely wrong routing,
  such as RU/direct-looking destinations via VPS, managed destinations going
  direct, direct DNS-like mobile destinations, unresolved mobile flows, or
  RU-looking domains in the managed catalog.

For current-day reports it combines:

- live interface deltas;
- LAN/Wi-Fi byte counters;
- Home Reality byte counters;
- Home Reality destination attribution from `sing-box.log`;
- routing mistake heuristics.

For closed day/week/month reports it uses the saved snapshot backend
(`traffic-daily-report`) and keeps the same high-level section names where the
data exists.

The saved snapshot backend builds period deltas from:

- `interface-counters.tsv` for WAN/LAN bridge/Wi-Fi totals
- `lan-device-counters.tsv` for LAN `Reality` / direct `WAN` / `Other`
- `mobile-reality-counters.tsv` for Home Reality upload/download bytes

The script takes a fresh snapshot first, then computes first-to-last deltas
inside the requested nominal window.

Important interpretation:

- REDIRECT `:<lan-redirect-port>` counters and sing-box logs are the primary matched LAN egress signal.
- `Via Reality` is counted by mangle rules before nat REDIRECT rewrites the destination.
- `Direct WAN` is counted by per-device `FORWARD ... -o/-i wan0` rules.
- Per-device LAN byte accounting is best-effort and based on router-side counters, not app telemetry.
- `HOME REALITY INGRESS CLIENTS` combines two signals:
  - byte totals from router-side TCP/<home-reality-port> counters
    (`RC_MOBILE_REALITY_IN/OUT`)
  - connection attribution from `sing-box.log`: client profile names,
    `reality-out` vs `direct-out`, EOF/error count and top destinations
- Home Reality byte counters are measured at the encrypted Home Reality
  ingress. They show how much traffic came through TCP/<home-reality-port>, whether the
  client was on LTE or Wi-Fi.
- Per-profile and per-destination VPS/direct byte splits are estimated from the
  `sing-box.log` connection split until sing-box exposes exact per-outbound
  byte attribution. The report marks these columns as `est.`.
- Per-profile ingress source bytes are attributed by remote source IP observed in
  `sing-box.log`. If several profiles share one carrier NAT IP during the same
  window, the report uses a combined source label.
- `SITES / DESTINATIONS` separates popularity into:
  - overall Home Reality ingress destinations;
  - destinations that exited through VPS, where final sites see the
    VPS VPS IP;
  - destinations that exited through home Russian direct, where final sites see
    the home Russian IP.
- `router-health-report` includes the Home Reality ingress summary in the common
  `Traffic Snapshot` block.
- Home Reality ingress clients are not LAN devices; use `HOME REALITY INGRESS CLIENTS` for
  profile activity and `LAN/WI-FI DEVICES` for home Wi-Fi/LAN devices.
- `ROUTING MISTAKES / CHECKS` is heuristic. A warning means "review catalog or
  no-vpn rules", not automatic proof of breakage.

---

## Example: Current-Day Report

Command:

```bash
REPORT_REDACT_NAMES=0 ./scripts/traffic-report today
```

Typical summary:

```text
=== 1. EXIT SUMMARY ===
WAN total:               13.78 GiB  (physical router/ISP base = 100%)
LAN/Wi-Fi observed:      4.22 GiB   (30.6% of WAN)
Home Reality ingress:    5.32 GiB   (38.6% of WAN)
WAN remainder/unattributed: 4.24 GiB (30.8% of WAN)
Client observed total:   9.54 GiB   (69.2% of WAN)
Via VPS:         8.07 GiB   (88.4%; LAN exact + ingress estimated)
Via home RU direct:      1.05 GiB   (11.5%; LAN exact + ingress estimated)
Other/unresolved:        0 B        (0.0%)
Interface counters:      Wi-Fi 4.88 GiB / LAN bridge 4.70 GiB
```

How to read this:

- `WAN total` is the physical ISP-facing counter. It is the correct answer to
  “how much crossed the router's WAN interface?”.
- `Client observed total` is the correct base for “how much user traffic did
  the GhostRoute accounting observe?”.
- `WAN remainder/unattributed` explains the gap between physical WAN and
  observed client ingress. It includes second WAN legs such as
  `router -> VPS/site`, router/background traffic, and any per-device counter
  coverage gaps in the selected window.
- `Via VPS` combines exact LAN/Wi-Fi managed bytes plus estimated Home
  Reality ingress bytes that went through `reality-out`.
- `Via home RU direct` combines exact LAN/Wi-Fi direct bytes plus estimated Home
  Reality ingress bytes that went through `direct-out`.
- `Via VPS + Via home RU direct + Other/unresolved` should equal
  `Client observed total` within rounding.
- `Home Reality ingress` is all encrypted TCP/<home-reality-port> traffic that entered the
  router. The client may be on LTE or Wi-Fi.
- `WAN total` can be larger than `Client observed total` because Home Reality
  ingress uses WAN for both the inbound leg and the outbound leg.

Path matrix:

```text
Source      First hop                 Router             Exit                      Site sees
Wi-Fi/LAN   device -> router          REDIRECT :<lan-redirect-port>    VLESS+Reality -> VPS   VPS VPS IP
Wi-Fi/LAN   device -> router          no redirect        Home WAN direct           Home Russian IP
HR client   LTE/Wi-Fi -> home :<home-reality-port>  reality-in         VLESS+Reality -> VPS   VPS VPS IP
HR client   LTE/Wi-Fi -> home :<home-reality-port>  reality-in         Home WAN direct           Home Russian IP
```

This is the core mental model:

- managed path -> final site sees VPS VPS IP;
- direct path -> final site sees home Russian IP;
- first-hop network for Home Reality ingress sees only the home IP on TCP/<home-reality-port>.

---

## Example: Devices

LAN/Wi-Fi devices:

```text
=== 4. LAN/WI-FI DEVICES ===
Device                     VPS       RU direct   VPS share
iPad                       1.80 GiB     10.9 MiB    99.4%
MacBook Air/private MAC    601.5 MiB    31.6 MiB    95.0%
Windows laptop             64.6 MiB     10.5 MiB    86.0%
```

Interpretation:

- `VPS` means this device matched `STEALTH_DOMAINS`/`VPN_STATIC_NETS` and was
  redirected into sing-box `:<lan-redirect-port>`.
- `RU direct` means traffic from that device left through normal home WAN.
- `VPS share` shows how much of the measured device traffic used the managed
  route.

Home Reality ingress clients:

```text
=== 5. HOME REALITY INGRESS CLIENTS ===
Ingress byte total:      5.22 GiB
Ingress via VPS est.:    4.27 GiB  (sites see VPS VPS IP)
Ingress RU direct est.:  972.5 MiB (sites see home Russian IP)

Client/profile       Conn    VPS    Direct   VPS est.    RU est.
iphone-2             3177    3055   122      2.67 GiB    109.1 MiB
iphone-4             1575    1138   437      1018.1 MiB  391.0 MiB
```

Interpretation:

- `Client/profile` is the VLESS/Reality client identity from sing-box logs.
- `VPS est.` and `RU est.` are estimated from ingress bytes and connection
  split.
- `Ingress source` rows may show profile names or remote source labels. If a
  carrier NAT hides many sessions behind the same remote IP, the report may
  group them.

---

## Example: Popular Sites And Apps

The current-day report includes destination-level popularity for Home Reality
ingress:

```text
=== 6. SITES / DESTINATIONS ===
Top Home Reality ingress destinations overall:
App/family      Destination             Est. traffic  % ingress  Path
Google/YouTube  www.google.com          1.03 GiB      19.8%      VPS
Telegram        203.0.113.35          550.2 MiB     10.3%      VPS
Apple/iCloud    gs-loc.apple.com        357.0 MiB      6.7%      VPS
AWS/CDN         ...amazonaws.com         190.6 MiB      3.6%      Home RU direct
DNS/CDN         1.1.1.1                  119.9 MiB      2.2%      mostly Home RU direct
```

Then it splits the same data into two practical views:

```text
Popular via VPS:
App/family      Destination        Est. traffic  % ingress
Google/YouTube  www.google.com     1.03 GiB      19.8%
Telegram        203.0.113.35     550.2 MiB     10.3%

Popular via home RU direct:
App/family      Destination        Est. traffic  % ingress
AWS/CDN         ...amazonaws.com   190.6 MiB      3.6%
DNS/CDN         1.1.1.1            119.9 MiB      2.2%
RU services     api.ozon.ru         17.0 MiB      0.3%
```

Use this section to answer:

- what is popular on Home Reality ingress;
- what actually used the VPS VPS;
- what stayed in the Russian direct internet;
- whether a service family is unexpectedly heavy.

For LAN/Wi-Fi destinations, exact per-site byte attribution is not currently
available; use DNS forensics to see interest and LAN/Wi-Fi device counters to
see volume.

---

## Routing Mistakes And Review Signals

`ROUTING MISTAKES / CHECKS` is the safety section. It catches likely catalog
mistakes, not just transport failures.

Example healthy output:

```text
=== 7. ROUTING MISTAKES / CHECKS ===
OK: no RU/direct-looking Home Reality destination via VPS found in today logs.
OK: no obvious managed Home Reality destination went direct.
REVIEW: Home Reality direct resolver-like destinations observed: 134 direct connections.
OK: Home Reality unresolved connections: 0.
OK: no obvious RU-looking domain in managed catalog.
```

Meaning:

- `RU/direct-looking ... via VPS`:
  a destination that looks Russian or normally direct went through VPS region.
  Review `STEALTH_DOMAINS`, `VPN_STATIC_NETS`, and auto-add history.
- `managed ... went direct`:
  something that looks like YouTube/Telegram/OpenAI/etc. escaped to home WAN.
  Review catalog coverage and sing-box rule-set sync.
- `resolver-like destinations observed`:
  traffic already inside Home Reality went to IPs such as `1.1.1.1` and then
  exited through home Russian direct. This is a review signal, not proof of
  LTE DNS leak.
- `unresolved connections`:
  sing-box saw inbound Home Reality connections but did not observe a final
  outbound decision in logs. Small transient values can be normal; persistent
  growth should be investigated.
- `RU-looking domain in managed catalog`:
  a Russian-looking domain is present in `STEALTH_DOMAINS`. This may be
  intentional, but it deserves review because final sites may see VPS VPS.

---

## Period Reports

Closed periods use saved snapshots:

```bash
./scripts/traffic-report yesterday
./scripts/traffic-report week
./scripts/traffic-report month
```

Example:

```text
Period:                    yesterday
Nominal window:            2026-04-25T00:00:00+0300 -> 2026-04-26T00:00:00+0300
Interface samples:         2026-04-25T00:00:00+0300 -> 2026-04-25T23:55:00+0300
LAN/Wi-Fi samples:         2026-04-25T00:00:00+0300 -> 2026-04-25T23:55:00+0300
Home Reality samples:      2026-04-25T14:56:58+0300 -> 2026-04-25T23:55:00+0300

WAN total:                 73.02 GiB
LAN/Wi-Fi observed:        11.73 GiB
Home Reality ingress:      1.93 GiB
WAN remainder/unattributed:59.36 GiB
Client observed total:     13.66 GiB
LAN/Wi-Fi via VPS:      11.38 GiB
LAN/Wi-Fi RU direct:       365.4 MiB
```

Important:

- day/week/month reports retain exact interface, LAN device and Home Reality
  ingress byte deltas;
- they do not retain destination-level sing-box logs;
- use `today` for current destination popularity and routing mistake checks;
- use DNS forensics for historical “who queried what” questions.

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
