# Glossary

Concise definitions for terms used throughout the GhostRoute repository. Where
multiple docs use slightly different wording, the definition here is the
intended source of truth. For deeper context, follow the cross-references.

## Routing model

- **Channel A** — production router data plane. Endpoint or LAN traffic enters
  the home router; managed destinations egress through Reality/Vision to the
  VPS. Owns dnsmasq/ipset, REDIRECT, home Reality ingress, and the Reality
  outbound. See [`docs/channels.md`](channels.md) and
  [`docs/architecture.md`](architecture.md).
- **Channel B** — production selected-client home-first lane. Selected
  endpoints connect to a dedicated home XHTTP/TLS ingress; the router relays
  into local sing-box SOCKS and reuses the Channel A managed split. Isolated
  from Channel A REDIRECT/DNS/TUN ownership.
- **Channel C** — home-first selected-client compatibility lane. Two variants:
  *C1-Shadowrocket* (HTTPS CONNECT/TLS, live-proven on iPhone) and
  *C1-sing-box* (native Naive, server-ready, blocked on tested SFI 1.11.4).
- **Layer 0** — endpoint/client-side routing. The client app (e.g.
  Shadowrocket, sing-box) decides DIRECT vs MANAGED before traffic reaches
  GhostRoute. Optional but useful for country-aware policy.
- **Layer 1** — managed channels (A/B/C ingress + relay).
- **Layer 2** — home router. Terminates home-based channels and applies the
  managed split (`STEALTH_DOMAINS` / `VPN_STATIC_NETS`).
- **Layer 3** — VPS. Remote egress for selected managed traffic.
- **Home-first** — design principle: the first network sees `endpoint -> home
  endpoint`, not `endpoint -> VPS`. Applies to all production channels.
- **Managed split** — the router decision that sends `STEALTH_DOMAINS` /
  `VPN_STATIC_NETS` matches through Reality and everything else direct.
- **Managed domain** — a domain in `STEALTH_DOMAINS` (or via `VPN_STATIC_NETS`
  for direct-IP services); its TCP traffic egresses through the VPS.
- **Reality ingress** — sing-box `reality-in` listener on the home router,
  TCP/`<home-reality-port>`, accepting VLESS+Reality from remote QR clients.
- **Reality egress / `reality-out`** — sing-box outbound on the router that
  forwards managed traffic to VPS Caddy `:443`.
- **Direct out / `direct-out`** — non-managed traffic exits via the home WAN
  link without going through Reality.
- **WAN exit** — the home internet uplink as seen by the public internet for
  non-managed traffic. Distinct from VPS exit.
- **VPS exit** — the public IP the internet sees for managed traffic; a single
  Reality-fronted Ubuntu host.
- **Home Reality QR client** — a remote endpoint (iPhone/iPad/MacBook) that
  imports a generated `iphone-*.png` / `macbook.png` profile and connects to
  the home public IP on the Reality port.

## Catalogs and ipsets

- **`STEALTH_DOMAINS`** — active managed-domain catalog as a `hash:ip` ipset
  populated by dnsmasq DNS observation. The single source of truth for
  managed routing decisions on LAN/Wi-Fi.
- **`VPN_STATIC_NETS`** — shared `hash:net` ipset for direct-IP services that
  bypass DNS-driven matching.
- **`configs/domains-no-vpn.txt`** — exception list of domains that must stay
  direct even if they would otherwise match.
- **`VPN_DOMAINS` / `RC_VPN_ROUTE` / `0x1000`** — legacy WireGuard-era
  artifacts. Must be absent in steady state. Their presence indicates either
  emergency cold fallback or a regression.

## Components

- **dnsmasq** — Merlin's DNS server. Observes lookups, populates
  `STEALTH_DOMAINS`, and forwards managed foreign DNS to the dnscrypt
  forwarder.
- **dnscrypt-proxy** — local DoH forwarder on `127.0.0.1:<dnscrypt-port>`. Its
  upstream traffic exits via sing-box SOCKS / Reality so the protected DNS
  path remains Reality-backed.
- **sing-box** — router-side proxy/router with multiple inbounds (REDIRECT,
  Reality, SOCKS, Naive, HTTP) and the Reality outbound. Implements the
  managed split.
- **Caddy layer4** — VPS public TCP/443 fronting Reality/Vision; lets multiple
  protocols share one port.
- **3x-ui / Xray** — Reality backend running on the VPS in a Docker container,
  reached only via Caddy.
- **GhostRoute Console** — read-only Next.js operator console at
  `modules/ghostroute-console/`. Renders prepared route, traffic, client,
  health, live and catalog evidence.

## Operations

- **Cold fallback** — manual-only WireGuard recovery path
  (`/jffs/scripts/emergency-enable-wgc1.sh`). Never auto-promoted. See
  [`docs/architecture.md`](architecture.md) §Cold fallback.
- **Read-only check / safe check** — any verification that does not mutate
  router or VPS state: `verify.sh`, `router-health-report`, `traffic-report`,
  `secret-scan`, `ansible-playbook playbooks/99-verify.yml`,
  `ansible-playbook --syntax-check`.
- **Mutating playbook** — anything in `ansible/playbooks/` numbered
  `00-*`, `10-*`, `11-*`, `20-*`, `21-*`, `22-*` or
  `30-generate-client-profiles.yml`. Run only with explicit operator
  authorization.
- **Deploy gate** — pre-deploy canary
  (`./modules/ghostroute-health-monitor/bin/live-check --active-probe
  --deploy-gate`) that validates the existing managed path, VPS edge, DNS
  policy and channel runtime before mutations are allowed.
- **Operator** — the human running this single-tenant deployment. There is
  no concept of multi-tenancy.
- **Vault** — Ansible Vault data under `ansible/secrets/stealth.yml`. Holds
  real credentials, endpoints and secrets.

## Observability

- **Snapshot** — a JSON evidence document (traffic, DNS, health, leak,
  catalog, deploy-gate, domains) collected by the Console and stored in
  SQLite for read-only rendering.
- **Read model** — denormalized SQLite table populated by the Console
  collector for low-latency UI rendering (`flow_sessions`,
  `dns_query_log`, `device_inventory`, `console_page_summaries`).
- **traffic-evidence** — `modules/traffic-observatory/bin/traffic-evidence
  --json`. Raw machine evidence layer: per-flow `flow_samples`, `dns_queries`,
  `route_evidence`, rollups. Single canonical byte source for downstream
  consumers. See
  [`docs/traffic-facts-v3-and-pyramid-plan.md`](traffic-facts-v3-and-pyramid-plan.md).
- **traffic-facts v3** — `modules/traffic-observatory/bin/traffic-facts
  --json`, `schema_version: 3`. Stable machine contract consumed by the
  Console. One `traffic_fact` per `flow_sample`. Invariant:
  `bytes == via_vps_bytes + direct_bytes + unknown_bytes` by construction.
- **traffic-report** — operator-facing human report. **Deprecated as a
  machine source** in the v3 refactor; Console does not consume it.
- **flow_sample** — single per-flow byte sample produced by router
  `lan-flow-facts-snapshot` and surfaced through `traffic-evidence`.
- **dns_link** — correlation between a DNS query/answer and a flow
  destination, with `link_type` (`exact_client_ip` / `recent_answer` /
  `shared_answer` / `no_dns_match`) and `confidence`
  (`high` / `medium` / `low` / `none`).
- **Route verification** — how a flow's route label is grounded:
  `verified_vps` / `verified_direct` (outbound/egress evidence confirms),
  `intent_only` (only ipset/policy says route), `mismatch` (ipset conflicts
  with outbound evidence), `unknown`.
- **Pyramid** — Console SQLite roll-up cascade: `client_traffic_5min` →
  `client_traffic_hourly` → `client_traffic_daily`, with symmetric
  `dns_log_5min` → `dns_log_hourly` → `dns_log_daily`. Today / Week / Month
  filters read prepared aggregates rather than raw rows.
- **Confidence label** — per-flow attribution quality:
  `exact` / `estimated` / `dns-interest` / `mixed` / `unknown`. Copied from
  the upstream traffic-observatory output.
- **Traffic class** — per-flow categorization for prioritization:
  `client` (real user traffic), `service_background` (Apple, DNS,
  CDN heartbeats), `unclassified`. Stamped at ingest after the v3 refactor.
- **Attribution coverage** — ratio of `attributed_bytes / observed_bytes`
  reported by `traffic-observatory`; large gaps usually mean
  service/background traffic mixed into the observed total.

## Conventions

- **`<placeholder>` syntax** — angle-bracketed values (`<router_lan_ip>`,
  `<home-reality-port>`, `<home-channel-b-port>`, `<home-channel-c-public-port>`)
  are deliberately fake. Real values live in Vault or gitignored
  `secrets/router.env` and never in tracked docs or commits.
- **`example.invalid` / `198.51.100.10`** — RFC-style fake hostnames and IPs
  used in docs that need a concrete-looking example without leaking real
  state.
- **Safety tag** — git tag `pre-<event>-<YYYY-MM-DD>` created before any
  potentially breaking migration to preserve a recoverable point.
