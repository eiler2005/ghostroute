# Channel D Router-Native NaiveProxy Lab

Channel D is a selected-client home-first lane for Karing /
NaiveProxy-style clients against a router-native Caddy `forward_proxy@naive`
runtime. The current router runtime is operator live-proven with Karing over
LTE, but Channel D remains isolated from Channel C proof and ownership.

```text
Karing / NaiveProxy-style client
  -> home public host :<channel-d-public-port>
  -> ASUS router Caddy forward_proxy@naive
  -> local sing-box SOCKS inbound `channel-d-naiveproxy-socks-in`
  -> managed split
       managed destinations     -> reality-out -> active managed egress
       non-managed destinations -> direct-out via home WAN
```

Channel D is not Channel C proof. Channel C native proof still requires traffic
to enter `channel-c-naive-in`. Channel D has its own port, credentials, Caddy
runtime, client artifacts and deploy playbook.

## Runtime

- Default public endpoint: same home host as Channel C on TCP/<channel-d-public-port>, or another
  Channel D-only hostname in `vault_channel_d_naiveproxy_public_host`.
- The profile host must match the router TLS certificate SAN/CN. Do not put a
  raw public IPv4 in the Naive URL while reusing a hostname certificate unless
  the selected client also supports a separate TLS SNI/server-name override;
  Karing reports this as `cert common name invalid`.
- Router runtime: `/opt/bin/caddy-channel-d-naiveproxy` with
  `forward_proxy@naive`.
- The build pins `klzgrad/forwardproxy` to
  `d62c80d3dd2c706b6b87579844d2397bddd18317` by default; override
  `CHANNEL_D_FORWARDPROXY_MODULE` only for an explicit rebuild/update.
- Caddy upstream: `socks5://127.0.0.1:<channel-d-socks-port>`.
- The unauthenticated web root is a neutral static cover page. It must not
  mention GhostRoute, NaiveProxy, Karing or proxying.
- Managed split owner: sing-box inbound `channel-d-naiveproxy-socks-in`.
- Generated client artifacts: `ansible/out/clients-channel-d/`.
- Trial Karing QR artifacts can be generated locally with
  `vault_channel_d_naiveproxy_profiles_enabled=true` even while router runtime
  `vault_channel_d_naiveproxy_enabled=false`.

The Caddy binary is built locally with:

```bash
./modules/routing-core/bin/build-channel-d-caddy
```

The router only receives the finished `linux/arm64` binary. Do not run generic
NaiveProxy install scripts on the router.

## Naive Compatibility And DPI Reality

Channel D is real on the router-server side in the practical sense that the
public listener is Caddy built with `forward_proxy@naive`, authenticated with
Naive-style Basic Auth, and upstreamed into local sing-box through SOCKS. It is
not the standalone `klzgrad/naiveproxy` server binary, and its observed network
fingerprint also depends on the client. The current proven client is Karing, not
the official NaiveProxy client embedded in a Chromium network stack.

For passive observers on LTE or another first-hop network, Channel D looks like
a TLS connection to the home hostname and Channel D public port. They do not see
the post-router managed split directly: managed destinations are selected only
after the router receives the proxy stream. That means Channel D hides final
managed destinations from the mobile carrier better than direct browsing, but it
does not make the home endpoint itself invisible.

DPI difficulty should be treated as probabilistic, not binary:

- Basic hostname/IP/port filtering can still block the home endpoint or the
  Channel D public port.
- A non-standard public port is easier to single out than ordinary web traffic.
- TLS/HTTP fingerprinting may classify Caddy/Karing differently from a normal
  Chrome session.
- Traffic shape, long-lived proxy sessions, repeated CONNECT-like behavior and
  active probing can provide additional signals.
- `probe_resistance`, `hide_ip` and `hide_via` reduce obvious proxy disclosure
  to unauthenticated probes, but they are not a proof against a capable DPI
  system.
- The cover site makes ordinary HTTPS GET probes look like a small static site,
  while unauthenticated CONNECT probes must not receive a successful tunnel.

So the correct project wording is: Channel D is a router-native
Naive-compatible lane, live-proven with Karing/LTE, with a better HTTPS-looking
first hop than a plain custom proxy. It is not guaranteed to be
indistinguishable from normal browser traffic under advanced DPI.

## Karing Artifacts

For an import-only Karing trial that does not use real endpoints or secrets:

```bash
cd ansible
ansible-playbook playbooks/30-generate-client-profiles.yml \
  --tags channel_d_clients_only \
  -e channel_d_naiveproxy_karing_trial_enabled=true
```

This writes a fake `example.invalid` profile named `karing-trial` so Karing QR
import can be tested without enabling Channel D or storing trial credentials.
Outside this trial mode, the generator rejects numeric IPv4/IPv6 public hosts
for Channel D because Karing has no project-proven SNI override path.

For a real test profile, keep the Karing client in Vault:


```yaml
vault_channel_d_naiveproxy_profiles_enabled: true
vault_channel_d_naiveproxy_clients:
  - name: karing-trial
    username: <channel-d-karing-user>
    password: <channel-d-karing-password>
```

Then generate only Channel D artifacts:

```bash
cd ansible
ansible-playbook playbooks/30-generate-client-profiles.yml --tags channel_d_clients_only
```

The generator writes raw `naive+https://...` text files, Karing
`install-config` text files, and PNG QR files under
`ansible/out/clients-channel-d/`. The QR is for Karing import and is separate
from the router deployment; it becomes usable only after Channel D runtime is
enabled with matching Vault credentials.

Raw Channel D import URLs include a fragment remark:

```text
naive+https://<user>:<pass>@<host>:<channel-d-public-port>#<client-name>-channel-d
```

Keep the fragment when copying a text URI manually; clients that preserve
single-node share names can use it as the node label.

For Karing's separate profile `Remark` field, the QR encodes a Karing deep link
instead of the raw node URL:

```text
karing://install-config?url=<encoded-naive-url>&name=<client-name>-channel-d
```

Use the iOS Camera/Safari deep-link flow for the QR. Karing's in-app QR scanner
passes scanned text directly into `Add Profile Link`; when using that flow,
copy the raw Naive URL and set `Remark` to `<client-name>-channel-d` manually.

## Known Console Gap

GhostRoute Console was not updated for Channel D in this rollout. Channel D has
router runtime, Ansible verification, CLI status, generated client artifacts and
docs, but the Console does not yet expose Channel D as a first-class lane with
D-specific Caddy state, client/QR inventory, proof labels or traffic
attribution. Until that follow-up is implemented, use `99-verify.yml`,
`verify.sh --verbose`, `router-health-report` and router logs for Channel D
proof.

## Managed Egress Selection (Independent Backend)

Channel D managed traffic exits behind a sing-box outbound, exactly like
Channel A/B/C. By default Channel D **follows** the shared `reality-out` backend
selected by `vault_router_managed_egress_mode`, so switching A/B/C also switches
Channel D.

Channel D can instead be **pinned** to its own backend through a second outbound
`reality-out-d`, selected by `vault_channel_d_managed_egress_mode`:

```text
channel_d_managed_egress_mode = follow          -> reality-out   (= A/B/C backend)
channel_d_managed_egress_mode = primary_vps      -> reality-out-d -> owned VPS
channel_d_managed_egress_mode = backup_reality   -> reality-out-d -> backup Reality
channel_d_managed_egress_mode = hermes_vps       -> reality-out-d -> owned Hermes clone
```

The primary use is a **canary lane**: pin only Channel D to a new owned backend
(for example `hermes_vps`) on isolated experimental traffic while Channel A/B/C
stay on the proven backend, validate it, then move A/B/C with confidence. Pins
reuse the existing `router_hermes_vps_*` / `router_backup_reality_*` endpoints;
no new endpoints or client artifacts are introduced.

Switch with the shared operator helper:

```bash
./modules/routing-core/bin/managed-egress-mode status
./modules/routing-core/bin/managed-egress-mode set hermes_vps --channel d --deploy-router
./modules/ghostroute-health-monitor/bin/managed-egress-check          # active_mode_d shows the D pin
./modules/ghostroute-health-monitor/bin/live-check --active-probe channel-d
# verified the canary, then return D to the shared backend:
./modules/routing-core/bin/managed-egress-mode set follow --channel d --deploy-router
```

The verify commands mirror Channel A/B/C: `managed-egress-check` reports both the
shared mode and the `active_mode_d` selector, and `live-check channel-d` checks the
Channel D SOCKS inbound and managed split (accepting either `reality-out` or
`reality-out-d`).

DNS note (v1 simplification): the Channel D managed split is `rule_set`-based
(`stealth-domains`/`stealth-static`), so it is DNS-independent. When Channel D is
pinned, its data exits via `reality-out-d`, while managed-domain DNS resolution
still uses the shared `vps-dns-server` over `reality-out`. This is acceptable
because managed classification keys on domain/IP, not on which resolver answered.

## Deploy And Rollback

Channel D is disabled by default. Enable it only with explicit Vault values and
the dedicated playbook:

```bash
cd ansible
ansible-playbook playbooks/24-channel-d-router.yml
```

Rollback is setting `vault_channel_d_naiveproxy_enabled=false` and rerunning the
same playbook. The role stops the Caddy service, removes the services-start
bootstrap block, and `stealth-route-init.sh` removes stale Channel D firewall
rules.

## Proof Signals

- Managed domains produce `channel-d-naiveproxy-socks-in -> reality-out` when
  Channel D follows A/B/C, or `-> reality-out-d` when Channel D is pinned to its
  own backend.
- Non-managed destinations produce `channel-d-naiveproxy-socks-in -> direct-out`.
- The mobile carrier sees the home endpoint first, not the VPS.
