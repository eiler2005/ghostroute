# Архитектура GhostRoute

## Коротко

Текущая architecture model — layered routing setup: endpoint/client routing,
managed channels, home router и VPS egress. Channel A остается основным
Reality-first router data plane без активного legacy WireGuard. Channel B
реализован как production home-first lane для selected device-client profiles.
Channel C — home-first selected-client lane with C1-sing-box Naive as the
stealth-primary design and C1-Shadowrocket HTTPS CONNECT as a proven
compatibility path. C1-Shadowrocket is live-proven and persisted. C1-sing-box is
router-side server-ready but client-blocked on the tested iPhone SFI `1.11.4`.
Channel M is a separate service lane for `maxtg_bridge` MAX API/CDN egress:
the router opens an outbound SSH remote-forward to the VPS docker bridge,
`maxtg_bridge` uses authenticated HTTP CONNECT against that VPS-local listener,
and the router sends the tunnel target to `direct-out` through the home WAN.

- Layer 0 — optional endpoint/client-side routing: device/client config может
  выбрать `DIRECT` или `MANAGED/PROXY` до входа в GhostRoute.
- Channel A — home-first router data plane: endpoint или LAN traffic попадает
  на home router. По умолчанию managed traffic уходит через Reality/Vision на
  VPS, а non-managed traffic идет через home WAN; выбранные домашние Wi-Fi/LAN
  устройства и выбранные Home Reality профили могут включать full-VPS override
  и отправлять весь internet-bound traffic через `reality-out`.
- Channel B — production selected-client lane в home-first форме:
  selected device подключается к отдельному домашнему XHTTP/TLS ingress, а
  роутер relays трафик дальше через local sing-box SOCKS c managed split: managed
  домены идут через Reality на VPS, non-managed домены уходят прямо в home WAN.
- Channel C — C1 home-first selected-client lane: selected device подключается
  к домашнему ingress, а router-side sing-box применяет тот же managed split,
  что и для других home-first каналов. C1-Shadowrocket uses HTTPS CONNECT for
  Shadowrocket compatibility and is not Naive. C1-sing-box uses sing-box Naive
  on the router, but requires an iOS client with outbound `"type": "naive"`.
- Channel M — service-only MAX egress lane: the home router keeps an outbound
  SSH remote-forward open to the VPS docker bridge, `maxtg_bridge` uses
  authenticated HTTP CONNECT inside that tunnel, and the router sends that
  inbound directly to `direct-out`. It is not a client failover channel and
  does not use the managed split.

```text
Layer 0 endpoint/client routing
  -> optional rules on the endpoint:
       local/private/captive/trusted domestic -> DIRECT
       foreign/non-local/unknown/selected     -> MANAGED/PROXY
       FINAL                                  -> MANAGED/PROXY

Layer 1 managed channels
  Channel A -> endpoint -> home endpoint -> router -> managed egress
  Channel B -> endpoint -> VLESS+XHTTP+TLS -> home endpoint -> router -> managed egress
  Channel C -> endpoint -> C1-sing-box Naive or C1-Shadowrocket HTTPS CONNECT -> home endpoint -> router -> managed egress
  Channel D -> Karing/Naive -> home endpoint -> router Caddy forward_proxy@naive -> sing-box D SOCKS -> managed egress
  Channel M -> maxtg_bridge VPS -> HTTP CONNECT -> VPS docker bridge -> router reverse SSH target -> router direct-out

Layer 2 home router
  LAN/Wi-Fi clients
    -> dnsmasq fills STEALTH_DOMAINS / VPN_STATIC_NETS
    -> br0 TCP nat REDIRECT :<lan-redirect-port>
    -> ASUS sing-box redirect inbound
    -> Channel A reality-out managed egress
    -> active managed egress
    -> Internet

  Selected LAN/Wi-Fi full-VPS clients
    -> reserved source IP match
    -> TPROXY to `channel-a-selected-lan-full-vps-in`
    -> local/private destinations stay local
    -> other internet destinations -> reality-out -> active managed egress
    -> Internet

  Remote QR clients
    -> home public IP :<home-reality-port>
    -> ASUS sing-box Reality inbound
    -> managed split:
         STEALTH_DOMAINS/VPN_STATIC_NETS -> Reality outbound to active managed egress
         other destinations              -> direct-out via home WAN

  Selected Home Reality full-VPS profiles
    -> home public IP :<home-reality-port>
    -> ASUS sing-box Reality inbound
    -> auth_user selected full-VPS rule before managed split
    -> local/private destinations stay direct
    -> other internet destinations -> reality-out -> active managed egress

  Channel B selected device-client traffic
    -> VLESS+XHTTP+TLS profile to home public IP :<home-channel-b-port>
    -> router local Xray Channel B ingress
    -> local sing-box SOCKS inbound
    -> managed split (same rule-sets as Channel A)
    -> Channel A Reality outbound to active managed egress
    -> Caddy :443 -> Xray Reality inbound
    -> Internet

  Channel C1-sing-box selected device-client traffic
    -> Naive/HTTPS-H2-CONNECT-like profile to home public IP :<home-channel-c-public-port>
    -> router sing-box Naive inbound `channel-c-naive-in`
    -> managed split (same rule-sets as Channel A)
    -> Channel A Reality outbound to active managed egress
    -> Caddy :443 -> Xray Reality inbound
    -> Internet

  Channel C1-Shadowrocket compatibility traffic
    -> HTTPS CONNECT/TLS profile to home public IP :<channel-c-shadowrocket-public-port>
    -> router sing-box HTTP inbound `channel-c-shadowrocket-http-in`
    -> managed split (same rule-sets as Channel A)
    -> Channel A Reality outbound to active managed egress
    -> Caddy :443 -> Xray Reality inbound
    -> Internet

  Channel M maxtg MAX service traffic
    -> HTTP CONNECT from bridge container to VPS docker bridge :<channel-m-reverse-listen-port>
    -> router-initiated SSH remote-forward to router loopback
    -> router sing-box HTTP inbound `channel-m-maxtg-reverse-egress`
    -> direct-out via home WAN
    -> Internet

Layer 3 VPS
  -> remote egress for selected managed traffic
  -> policy-split DNS egress for managed foreign names
  -> sites see VPS IP for managed traffic
```

## Layered Architecture

### Layer 0 — Endpoint / Client-Side Routing

Layer 0 is optional and lives on the endpoint device. Any client app or system
VPN profile that supports rule-based routing can decide whether a request goes
`DIRECT` or into a GhostRoute managed channel.

The production policy is country-neutral in the public docs:

```text
local/private/captive/trusted domestic -> DIRECT
foreign/non-local/unknown/selected     -> MANAGED/PROXY
FINAL                                  -> MANAGED/PROXY
```

Shadowrocket on iPhone/iPad/MacBook is the primary current example: its config
can use domain, IP, GEOIP and rule lists as the first routing layer. This is an
example implementation of Layer 0, not an Apple-only architecture constraint.
Country suffixes, GEOIP datasets and trusted service lists belong to deployment
profiles, not this general architecture document.

### Layer 1 — Managed Channels

Layer 1 is the set of managed paths selected by Layer 0 or by explicit local
choice. Channel A and B are production paths with different client scopes.
Channel C is split into C1-sing-box Naive and C1-Shadowrocket compatibility:

```text
Channel A: endpoint -> home endpoint -> router -> managed egress
Channel B: endpoint -> VLESS+XHTTP+TLS -> home endpoint -> router -> managed egress
Channel C1-Shadowrocket: endpoint -> HTTPS CONNECT/TLS -> home endpoint -> router -> managed egress
Channel C1-sing-box: endpoint -> Native Naive -> home endpoint -> router -> managed egress
```

Channel A/B/C are home-first for managed traffic: the first network sees
endpoint -> home endpoint, not endpoint -> VPS. The VPS provider sees the home
router as the source for managed traffic.

Channel M is home-egress rather than managed-egress: the bridge connects only to
the VPS-local reverse listener, while the router-originated SSH tunnel carries
the request back to the router, so target MAX sites see the home WAN IP. It is
authenticated and separate from A/B/C client routing.

### Layer 2 — Home Router

The home router terminates home-based channels and applies routing and DNS
policy. It owns dnsmasq/ipset classification, sing-box REDIRECT, optional
Channel A selected full-VPS TPROXY for home Wi-Fi/LAN devices, home Reality
ingress with optional selected `auth_user` full-VPS rules, Channel B home
ingress relay, Channel C1 Naive ingress, and the Reality/Vision outbound to VPS.
Router policy may either split managed/non-managed destinations or, for selected
Channel A full-VPS sets, send internet-bound traffic through `reality-out`.
For Channel M, the router owns only a narrow service rule:
`channel-m-maxtg-reverse-egress -> direct-out`; it does not classify this
traffic with `STEALTH_DOMAINS`, `VPN_STATIC_NETS` or policy DNS. The optional
direct public `channel-m-maxtg-max-egress` remains isolated and source
allowlisted, but it is not the active production path.

### Layer 3 — VPS

The VPS is remote egress for managed traffic and selected full-VPS traffic.
Sites and checkers see the VPS IP for managed catalog matches and for selected
Channel A full-VPS internet-bound traffic; non-selected non-managed traffic
selected as `DIRECT` or home-WAN direct does not use the VPS egress.

Policy-split managed DNS is generated on the router and normally uses the
router-local dnscrypt listener. dnscrypt sends upstream DoH through sing-box
SOCKS and `reality-out`, so the protected path remains Reality-backed without
depending on a separate VPS resolver leg. If the optional VPS Unbound resolver
is enabled for private diagnostics, it is intentionally not public: public
`53/tcp,udp` stays denied.

That router-local dnscrypt listener is a shared dependency for LAN/Wi-Fi
managed DNS and for home-first mobile Channels A/B/C/D after they reach the
router. If `127.0.0.1:<dnscrypt-port>` disappears, the failure can look like a
multi-channel routing outage even though sing-box/Xray/Caddy listeners and
iptables are still present. The production guardrail is
`/jffs/scripts/dnscrypt-watchdog.sh`: cron checks the listener every minute and
restarts only dnscrypt-proxy, leaving Channel A/B/C/D/M ownership untouched.
Channel M is service-only direct-out and does not use the managed DNS split.

### Observability, Console And Traffic Intelligence

GhostRoute Console is an observability/review surface, not part of the router
data plane. It reads module-owned JSON facts, stores snapshots and normalized
evidence in SQLite, and renders route/traffic/client/live/intelligence views
over that factual data. Console must not become a second source of truth for
routing state.

The current traffic accounting architecture is:

```text
router read-only evidence
  lan-flow-facts-snapshot / dns-query-snapshot / traffic-rollup-snapshot
        ↓
traffic-evidence --json
  raw machine evidence: flow_samples, home_reality_samples, dns_queries,
  route_evidence, warnings
        ↓
traffic-facts --json
  stable contract v3; one fact per LAN/Wi-Fi flow_sample or Home Reality
  profile-counter delta;
  bytes == via_vps + direct + unknown invariant
        ↓
Console SQLite factual read models
  traffic_facts, traffic_dns_links, normalized_flows, flow_sessions,
  eligible client_traffic_5min -> hourly -> daily, DNS rollups
        ↓
Traffic Intelligence read model
  destination_enrichment + dry-run decision_candidates
        ↓
UI / reports / review surfaces
```

`traffic-report` is a debug/operator wrapper and is not a Console machine
source. Channel A/B/C routing and managed-domain logic are unchanged by the
observability pipeline; router-side evidence collectors remain read-only and
never mutate dnsmasq, ipset, sing-box, iptables or route rules.

Home Reality profile accounting is intentionally narrow: read-only
`mobile-reality-counters.tsv` deltas become `home_reality_samples`, and
`traffic_facts` represents them as `Home Reality ingress` with all bytes in
`unknown_bytes`, `route_status=unknown` and `dns_status=no_match`. The pipeline
does not recreate legacy per-destination estimates such as Apple/iCloud from
encrypted ingress counters unless real DNS/flow evidence exists.

LAN/Wi-Fi route accounting may additionally use read-only
`lan-device-counters.tsv` deltas. When destination flow samples are present but
per-destination egress proof is missing, `traffic_facts` can allocate that
client's bytes by the observed VPN/WAN/other counter split and mark the row
`route_status=counter_allocated`. This is route-split evidence for the
client/window, not exact per-destination byte proof.

Ingress route accounting uses the same allocation model. `sing-box` outbound
log evidence records the inbound tag (`reality-in`, Channel B relay SOCKS,
Channel C Shadowrocket HTTP, Channel C Naive) when it can correlate the same
connection id. When an ingress byte counter exists for that channel/profile,
`traffic_facts` may allocate the ingress bytes by the observed VPS/direct
outbound mix and mark detailed verification as `ingress_route_allocated`.

Console may store old or legacy traffic rows for history/debug, but operational
traffic windows must pass a read-model eligibility gate before they reach
Dashboard, Clients or Live. Eligible rows must be Traffic Observatory facts with
a non-negative byte split satisfying
`bytes = via_vps_bytes + direct_bytes + unknown_bytes`; legacy
`traffic-report`-derived allocation rows such as connection-share/domain-or-SNI
estimates are excluded from current GUI totals.
Prepared Dashboard, Clients and LLM-safe report windows are materialized per
coarse traffic class (`all`, `client`, `personal_cloud`,
`service_background`, `unclassified`). The GUI must select the prepared window
matching the active `trafficClass` filter so personal-cloud or service-heavy
devices remain visible in `All traffic` while strict `Client` views stay clean.

Facts and interpretation are intentionally separate:

- `traffic_facts` owns accounting facts: client, destination/IP, protocol,
  bytes, route intent, route verification, DNS link confidence and evidence
  status.
- `accounting_status` is limited to accounting correctness; route and DNS
  status are separate fields.
- `destination_enrichment` and `decision_candidates` are local Traffic
  Intelligence outputs. They can explain traffic and suggest review actions,
  but they must not rewrite bytes, route split, route verification, DNS
  confidence, managed domains, filters or routing policy.
- Traffic Intelligence exposes additional GUI axes (`traffic_lane`,
  `dns_category`, `decision_hint`) for Client, Service/system,
  Analytics/trackers, CDN/shared infra and Unknown/review workbench views. These
  axes are interpretation only and do not replace `traffic_class` or
  accounting.
- `client_traffic_by_lane` and `client_destination_by_lane` materialize those
  axes into a client-centric GUI/test layer. They are rebuildable views over the
  aggregate pyramid, not a duplicate ledger.
- `client_route_evidence_defects` materializes route proof gaps by client and
  destination, so high `Unknown` route accounting can be investigated separately
  from content/category unknowns.
- Optional IP/provider enrichment is local-first through `ip_prefix_catalog` and
  `ip_enrichment_cache`. External providers are advisory inputs only, disabled
  by default and never automatic blocking/routing authority.
- Unknown/weak destination classification is file-first: Console exports
  gitignored JSON/Markdown review queues for offline/LLM analysis, and stable
  results are promoted into deterministic local rules.

The VPS deployment keeps the Console app on `127.0.0.1:<console-local-port>`. Public operator
access uses a dedicated non-443 HTTPS listener with Basic Auth, nginx and a
small local buffering proxy. This keeps larger Console pages away from the
shared Reality/layer4 `:443` listener used by Channel A/B/C egress. Large
operator views such as Traffic Explorer use paging and explicit detail/export
requests instead of rendering full evidence sets in one response.

## Channel A / Channel B / Channel C (текущая схема)

For the compact handoff version of A/B/C, see
[docs/channels.md](/docs/channels.md).

### Channel A

Для Channel A применяем home-first production-схему:

```text
Endpoint QR-клиент
  -> home public IP :<home-reality-port>
  -> ASUS sing-box Reality inbound
  -> managed split:
       STEALTH_DOMAINS / VPN_STATIC_NETS -> Reality outbound to active managed egress
       other destinations                 -> direct home WAN
  -> Интернет
```

Что видит сеть перед home endpoint:

```text
LAN clients: обычный домашний LAN/Wi-Fi трафик к роутеру
remote clients: endpoint -> home public IP/DDNS на home Reality port
```

Статус: основной production router data plane. Channel A владеет router
REDIRECT/DNS/catalog behavior и не должен зависеть от B/C.

### Channel B

В текущей схеме Channel B работает как отдельная production selected-client
home-first lane:

```text
Endpoint client
  -> VLESS + XHTTP + TLS to home ingress :<home-channel-b-port>
  -> router local Xray ingress `channel-b-home-in`
  -> local sing-box SOCKS (inbound `channel-b-relay-socks`)
  -> managed split по `stealth-domains` / `stealth-static`
       - managed    -> reality-out -> active managed egress
       - non-managed -> direct-out -> home WAN
  -> Интернет
```

Что видит мобильный оператор:

```text
endpoint -> home public IP/DDNS
TLS / HTTP-like XHTTP traffic
```

Статус: production selected-client lane. Он изолирован от Channel A ownership,
но использует тот же managed split и `reality-out` после локального relay.

Как это понимать в проде:

- A/B/C дают первичный hop в home-network для managed endpoint traffic.
- У A managed split делается прямо на home Reality inbound.
- У B managed split делается после локального relay в sing-box.
- У C1-sing-box managed split делается прямо после sing-box Naive inbound.
- У C1-Shadowrocket managed split делается после sing-box HTTP inbound; это Shadowrocket
  compatibility, а не Naive.
- Власть над инкапсуляцией и правилами изолирована: `20-stealth-router.yml` для A и
  `21-channel-b-router.yml` / `22-channel-c-router.yml` для B/C.

### Channel C

Channel C has two current shapes.

C1-Shadowrocket is the Shadowrocket compatibility lane proven live on 2026-04-28:

```text
Endpoint Shadowrocket client
  -> HTTPS CONNECT over TLS to home public IP :<channel-c-shadowrocket-public-port>
  -> WAN REDIRECT to router internal :<channel-c-shadowrocket-ingress-port>
  -> ASUS sing-box HTTP inbound `channel-c-shadowrocket-http-in`
  -> managed split по `stealth-domains` / `stealth-static`
       - managed     -> reality-out -> active managed egress
       - non-managed -> direct-out -> home WAN
  -> Интернет
```

C1-Shadowrocket is not Naive. It exists because Shadowrocket imported Naive-like QR
profiles but the router-side sing-box Naive inbound rejected the live attempts
with `not CONNECT request`. The compatibility path proved that Shadowrocket can
work through the home-first architecture when the router exposes authenticated
HTTPS CONNECT over TLS.

C1-sing-box is the intended native Naive lane:

```text
Endpoint SFI/sing-box client with outbound "type": "naive"
  -> Naive / HTTPS-H2-CONNECT-like to home public IP :<home-channel-c-public-port>
  -> optional WAN REDIRECT to router internal :<home-channel-c-ingress-port>
  -> ASUS sing-box Naive inbound `channel-c-naive-in`
  -> managed split по `stealth-domains` / `stealth-static`
       - managed     -> reality-out -> active managed egress
       - non-managed -> direct-out -> home WAN
  -> Интернет
```

C1-sing-box is server-ready on the router, but the tested iPhone SFI app used
sing-box `1.11.4` and failed with `unknown outbound type: naive`. Native SFI
profile generation is disabled by default until an iOS client with Naive
outbound support is selected.

C1-Shadowrocket is persisted by `22-channel-c-router.yml`, the router firewall
hook, client generation and verify checks.

C1 не имеет VPS-only Squid/stunnel/tinyproxy backend. Старый direct-to-VPS
Channel C дизайн удалён из активного кода.
C1 requires a Naive-capable sing-box build (`>= 1.13`) on the router; when C1 is
enabled the router config uses route `action: sniff` rules instead of legacy
inbound sniff fields so the same generated config can pass modern `sing-box
check`.

During a WAN incident where `wan0` reports `carrier=0`, the router has no
physical/provider link. That condition is below GhostRoute and does not change
the architectural status of Channel A.

### Cold fallback: manual WireGuard recovery only

WireGuard (`wgs1` + `wgc1`) is **not** active in steady state. The runtime
invariants in [`SECURITY.md`](/SECURITY.md) and `AGENTS.md` require
`wgs1_enable=0`, `wgc1_enable=0`, no `RC_VPN_ROUTE` and no `0x1000` outside the
fallback script. The preserved `wgc1_*` NVRAM exists for one purpose only:
manual recovery during a catastrophic Reality outage.

Activation rules:

- Manual only — there is **no automatic failover** from Channel A/B/C to
  WireGuard. Auto-promotion is intentionally not implemented (see
  [ADR-0004](/docs/adr/0004-deprecated-wireguard-cold-fallback.md) and
  [ADR-0006](/docs/adr/0006-channel-terminology-and-manual-fallbacks.md)).
- Single entry point:

  ```bash
  ssh admin@<router_lan_ip> '/jffs/scripts/emergency-enable-wgc1.sh --dry-run'
  ```

  Run with `--dry-run` first to inspect the planned changes; drop `--dry-run`
  only after confirming Channel A/B/C cannot recover via the documented
  runbooks. The script is the only sanctioned path that touches `wgc1_*`,
  `RC_VPN_ROUTE` or the legacy `0x1000` mark.
- Exit criterion: after Reality is restored, run `./verify.sh --verbose` and
  confirm the invariants above are green again before considering the incident
  closed.

Anything that automatically toggles `wgc1_*` NVRAM, reintroduces `VPN_DOMAINS`
or routes managed traffic through `wgc1` violates the architecture and must be
removed.

### Legacy

Legacy `wgs1`/`wgc1` are decommissioned in normal operation. `wgc1_*` NVRAM is
preserved only as the cold fallback documented above.

## Components

| Component | Role |
|---|---|
| ASUS RT-AX88U Pro + Merlin | dnsmasq/ipset/iptables, sing-box, dnscrypt-proxy |
| `dnsmasq` | fills `STEALTH_DOMAINS`, includes static/auto catalogs, filters AAAA while IPv6 is off, and sends managed foreign DNS to the dnscrypt-backed local forwarder |
| `dnscrypt-proxy` | upstream DNS on `127.0.0.1:<dnscrypt-port>`; its DoH traffic goes through sing-box SOCKS/Reality |
| `dnscrypt-watchdog.sh` | router cron guardrail for the dnscrypt listener; restarts only dnscrypt-proxy when `127.0.0.1:<dnscrypt-port>` disappears |
| `sing-box` on router | `redirect-in :<lan-redirect-port>`, home Reality inbound `:<home-reality-port>`, local SOCKS inbound for dnscrypt/Channel B relay, Channel C1 Naive inbound, C1-Shadowrocket HTTP inbound when enabled, `vps-dns-in` for DNS hijack compatibility, managed split, Reality outbound to active managed egress |
| VPS host | Caddy :443, existing 3x-ui/Xray Docker container, optional restricted/private DNS resolver support |
| Channel A | active production `sing-box -> VLESS+Reality+Vision` path |
| Channel B | production selected-client home-first lane: router XHTTP ingress + local relay -> sing-box Reality upstream |
| Channel C | home-first selected-client lane: C1-Shadowrocket HTTPS CONNECT compatibility is live-proven; C1-sing-box Naive is server-ready but blocked by tested SFI `1.11.4` |
| Channel D | experimental Karing-only router-native NaiveProxy lab: pinned Caddy `forward_proxy@naive` on the home router serves a neutral cover site and relays into sing-box managed split |
| `VPN_STATIC_NETS` | historical ipset name for static CIDR routes used by Channel A |
| `wgc1` NVRAM | cold fallback only, disabled in steady state |

## Port And Listener Map

| Scope | Listener | Owner | Purpose |
|---|---|---|---|
| Router LAN | `:<lan-redirect-port>` | sing-box `redirect-in` | Transparent Wi-Fi/LAN managed TCP capture |
| Router WAN | `:<home-reality-port>` | sing-box `reality-in` | Channel A home Reality for remote clients |
| Router WAN | `:<home-channel-b-port>` | local Xray `channel-b-home-in` | Channel B selected-client XHTTP/TLS first hop |
| Router local | `127.0.0.1:<router-socks-port>` | sing-box `channel-b-relay-socks` | Channel B relay into shared managed split |
| Router WAN | `:<home-channel-c-public-port>` | DNAT/REDIRECT to C1 native | C1-sing-box public Naive endpoint, usually public `443` when enabled |
| Router internal | `:<home-channel-c-ingress-port>` | sing-box `channel-c-naive-in` | C1 native Naive inbound |
| Router WAN | `:<channel-c-shadowrocket-public-port>` | DNAT/REDIRECT to C1-SR | C1-Shadowrocket compatibility public endpoint |
| Router internal | `:<channel-c-shadowrocket-ingress-port>` | sing-box `channel-c-shadowrocket-http-in` | C1-SR HTTPS CONNECT inbound |
| Router WAN | `:<channel-d-public-port>` | DNAT/REDIRECT to Channel D Caddy | Experimental NaiveProxy-style public endpoint |
| Router internal | `:<channel-d-naiveproxy-ingress-port>` | Caddy `forward_proxy@naive` | Channel D first-hop termination |
| Router local | `127.0.0.1:<channel-d-socks-port>` | sing-box `channel-d-naiveproxy-socks-in` | Channel D relay into managed split |
| Router local | `127.0.0.1:<dnscrypt-port>` | dnscrypt-proxy | Primary managed DNS forwarder from dnsmasq |
| Router local | `127.0.0.1:<vps-dns-forward-port>` | sing-box `vps-dns-in` | DNS hijack compatibility listener, not the primary generated managed DNS target |
| VPS public | `:443` | system Caddy layer4 | Reality/Vision entrypoint |
| VPS local | `127.0.0.1:<xray-local-port>` | 3x-ui/Xray Docker publish | Reality backend behind Caddy |
| VPS restricted | `:<restricted-dns-port>` | Unbound, when enabled | Optional private resolver; never exposed as public DNS |
| VPS local | `127.0.0.1:<xui-admin-port>` | 3x-ui | Admin UI, localhost-only |

## Ansible Deployment Boundaries

Разделение playbooks по каналам:

| Playbook | Scope | Ownership boundary |
|---|---|---|
| `10-stealth-vps.yml` | VPS base | Shared Caddy listener, Channel A/Reality backend, UFW, VPS health. |
| `11-channel-b-vps.yml` | VPS Channel B | Optional direct-XHTTP backend + Caddy route validation for direct Channel B mode. |
| `20-stealth-router.yml` | Router | Channel A router data plane and router runtime hooks. |
| `21-channel-b-router.yml` | Router Channel B | Channel B home XHTTP ingress + local relay add-on, isolated from Channel A REDIRECT ownership. |
| `22-channel-c-router.yml` | Router Channel C | Channel C1 home Naive ingress add-on, isolated from Channel A REDIRECT ownership. |

`21` включает home-first вариант Channel B на роутере. `11` нужен только для
direct-XHTTP варианта Channel B.
`22` включает home-first Channel C1 на роутере.
Эти playbooks не должны мутировать Channel A/Reality state.

## Routing Matrix

| Source | Selector | Mechanism | Egress |
|---|---|---|---|
| LAN/Wi-Fi TCP (`br0`) | `STEALTH_DOMAINS`, `VPN_STATIC_NETS` | nat REDIRECT `:<lan-redirect-port>` | Channel A sing-box -> Reality |
| LAN/Wi-Fi UDP/443 (`br0`) | same sets | DROP | client fallback to TCP |
| LAN/Wi-Fi selected full-VPS set | reserved source IP set | TPROXY TCP/UDP to `channel-a-selected-lan-full-vps-in` | `reality-out` for internet-bound traffic |
| Endpoint QR/VLESS | generated Reality profile plus managed rule-sets | TCP/<home-reality-port> to home router | managed -> Reality; non-managed -> home WAN |
| Channel A Home Reality selected full-VPS set | Home Reality `auth_user` set | `reality-in` selected-user rule before managed split | `reality-out` for internet-bound traffic |
| Channel B selected-client profile | selected device only | TCP/<home-channel-b-port> to home router, then local relay into sing-box SOCKS with managed split | production home-first egress |
| Channel C1-sing-box selected-client profile | selected device only | TCP/<home-channel-c-public-port> to home router, then sing-box Naive inbound with managed split | stealth-primary home-first egress |
| Channel C1-Shadowrocket profile | selected device only | TCP/<channel-c-shadowrocket-public-port> to home router, then sing-box HTTP inbound with managed split | compatibility home-first egress |
| Router `OUTPUT` | none | no transparent capture | default WAN or explicit proxy |
| Emergency fallback | `STEALTH_DOMAINS`, `VPN_STATIC_NETS` | explicit `0x1000` mark from fallback script | `wgc1` |

## Domain Catalog

Single repo source:

```text
configs/dnsmasq-stealth.conf.add
```

Live include:

```text
/jffs/configs/dnsmasq.conf.add
  conf-file=/jffs/configs/dnsmasq-stealth.conf.add
```

Auto-discovery writes only:

```text
ipset=/example.com/STEALTH_DOMAINS
```

`VPN_DOMAINS` should be absent in the new steady state.

## Packet Flow

### LAN Client

```text
client DNS query
  -> dnsmasq
  -> matching IPv4 added to STEALTH_DOMAINS

client TCP connection
  -> PREROUTING -i br0
  -> match STEALTH_DOMAINS or VPN_STATIC_NETS
  -> REDIRECT :<lan-redirect-port>
  -> sing-box redirect inbound
  -> Reality outbound
  -> active managed egress exit
```

### Endpoint Home QR

```text
client app
  -> VLESS+Reality to home public IP :<home-reality-port>
  -> router Reality inbound validates router-side UUID/key/short_id
  -> if destination matches STEALTH_DOMAINS or VPN_STATIC_NETS:
       sing-box Reality outbound -> active managed egress exit
  -> otherwise:
       sing-box direct-out -> home WAN exit
```

The first network sees endpoint -> home endpoint traffic for Channel A/B managed
sessions. Websites still see the active managed egress exit for managed traffic; non-managed
destinations see the home WAN IP. See [modules/routing-core/docs/network-flow-and-observer-model.md](/modules/routing-core/docs/network-flow-and-observer-model.md)
for the full workflow and observer table.

### Router-Originated Traffic

Router `OUTPUT` is not transparently captured. Capturing router-originated
traffic globally can loop sing-box outbound connections. Diagnostics that need
Reality should use an explicit proxy or client profile.

### Channel B/C Device Clients

Channel B is production for selected device-client profiles and is documented
separately from normal Home Reality and emergency Reality profiles. Channel C is
C1 home-first with two explicit variants: C1-Shadowrocket compatibility is
live-proven, while C1-sing-box native Naive is server-ready and waits for an
iOS client with outbound `type: naive` support.

Current Channel B shape is home-first:

```text
client app
  -> VLESS+XHTTP+TLS to home public IP :<home-channel-b-port>
  -> router local Xray Channel B ingress
  -> router local relay -> sing-box SOCKS inbound
  -> managed split (same rule-sets as Channel A)
  -> sing-box Reality outbound -> active managed egress
  -> Internet
```

This keeps Channel B home-first while giving it a different first-hop
fingerprint from Channel A.

Current Channel C1-Shadowrocket shape is home-first compatibility:

```text
client app
  -> HTTPS CONNECT/TLS to home public IP :<channel-c-shadowrocket-public-port>
  -> router sing-box HTTP inbound channel-c-shadowrocket-http-in
  -> managed split (same rule-sets as Channel A)
  -> sing-box Reality outbound -> active managed egress
  -> Internet
```

Current Channel C1-sing-box target shape is native Naive:

```text
client app
  -> Naive/HTTPS-H2-CONNECT-like to home public IP :<home-channel-c-public-port>
  -> router sing-box Naive inbound
  -> managed split (same rule-sets as Channel A)
  -> sing-box Reality outbound -> active managed egress
  -> Internet
```

## Boot Hooks

| Hook | Responsibility |
|---|---|
| `firewall-start` | create `STEALTH_DOMAINS` as `hash:ip`, replay persisted `add STEALTH_DOMAINS ...` entries, load `VPN_STATIC_NETS`, enforce LAN-only SSH, call stealth-route-init |
| `stealth-route-init.sh` | apply REDIRECT, QUIC DROP and mobile Reality INPUT rules |
| `cron-save-ipset` | persist `STEALTH_DOMAINS.ipset` |
| `cron-traffic-snapshot` | collect WAN/LAN/Tailscale/device counters |
| `rotate-singbox-log` | cap `/opt/var/log/sing-box.log` growth and retain short compressed archives |
| `nat-start` | intentionally no Channel A work |

`STEALTH_DOMAINS` is a dnsmasq-populated set of resolved IPv4 addresses, so it
must stay `hash:ip`. `VPN_STATIC_NETS` is the static CIDR set and remains
`hash:net`. Replaying only saved `add STEALTH_DOMAINS ...` lines avoids Merlin
`ipset restore` aborting on the saved `create` line after a reboot or firewall
rebuild.

## Verification

```bash
ROUTER=<router_lan_ip> ./verify.sh
cd ansible && ansible-playbook playbooks/99-verify.yml --limit routers
```

Critical invariants:

- `wgs1_enable=0`
- `wgc1_enable=0`
- `VPN_DOMAINS` absent
- `STEALTH_DOMAINS` present
- `VPN_STATIC_NETS` present
- no `RC_VPN_ROUTE`
- no `0x1000` rule outside emergency fallback
- `filter-AAAA` present while IPv6 is disabled
- Channel B is not required for Channel A health, and Channel C is not required
  for production health until promoted; any channel enablement must keep Channel
  A REDIRECT/TUN/DNS ownership unchanged and remain explicit (`11` + `21` for B,
  `22` for C)
