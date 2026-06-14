# Runtime Inventory and Port Registry

`configs/runtime-inventory.yml` is the tracked, sanitized runtime inventory for
GhostRoute. It is a lightweight OBOM-style registry for operational components,
version policy, compatibility claims, port/listener ownership and upgrade gates.
It is not a full release SBOM and does not replace Ansible inventory or Vault.

The registry follows the useful parts of SBOM/OBOM practice: component identity,
supplier/origin, package names, version policy, relationships, machine-readable
port ownership and validation. It deliberately stores symbolic references such
as `singbox_redirect_port`, not real endpoints or deployment-specific port
values.

## What Belongs Here

- Router and VPS runtime components that affect compatibility or recovery.
- Proven-good, minimum-required, candidate and known-problematic version notes.
- Port/listener ownership and conflict groups.
- Upgrade gates that must pass before a candidate becomes proven-good.

Live snapshots do not belong here. Put live command output, real endpoints,
actual listener values, public IPs and generated client material in gitignored
`reports/`, router health output or `secrets/`.

## Version Policy Classes

- `proven_good`: the currently trusted runtime baseline.
- `minimum_required`: the oldest feature-capable line for a specific feature.
- `candidate`: a version or package source that may work but still needs gates.
- `known_problematic`: a version, package source or platform combination that
  failed or has a known compatibility risk.
- `rollback_available`: where the operator can restore a previous runtime state.

For router `sing-box`, the current proven-good policy is the Entware package
line. Upstream generic or musl builds are candidates only. They are not adopted
until `sing-box check`, listener checks, `live-check`, `leak-check`, and a real
LAN/Wi-Fi managed-domain probe all pass.

The stable Channel A DNS contract keeps sing-box DNS resolution on the private
VPS Unbound path over `reality-out`; direct public-resolver DNS from sing-box is
a candidate change, not the proven-good baseline. The Reality cover contract is
also strict: client `server_name` remains the configured cover SNI, while the
router-side handshake target is an approved DNS hostname that can differ when a
cover edge stops accepting TCP/443. A dedicated sing-box DNS rule resolves both
names through router-local dnsmasq. IP-literal handshake targets are incident
workarounds only and must fail `live-check` until deliberately promoted through
the upgrade gates.

The managed-DNS router dependency is the local dnscrypt listener on
`127.0.0.1:<dnscrypt-port>`. dnsmasq managed includes point at that listener,
and dnscrypt-proxy sends upstream DoH through sing-box SOCKS/Reality. The
`router_dnscrypt_watchdog` component is the production guardrail: cron runs
`/jffs/scripts/dnscrypt-watchdog.sh` every minute and restarts only
dnscrypt-proxy if the listener disappears. A missing dnscrypt listener can make
LAN/Wi-Fi plus home-first Channels A/B/C/D look broken while channel listeners
remain up; Channel M direct-out traffic is not proof that managed DNS is
healthy. The dnscrypt init script and boot bootstrap set
`vm.overcommit_memory=1` before startup so Entware's Go `dnscrypt-proxy2` can
reserve its runtime heap after reboot.

The captive/connectivity compatibility contract has one explicit direct
exception: plain HTTP `www.google.com:80` may bypass managed Reality so
`generate_204` health checks can complete. HTTPS Google traffic and normal
managed destinations remain governed by the managed split.

Channel M is represented as separate service egress listeners for
`maxtg_bridge`. The active reverse lane uses a router-originated SSH
remote-forward to a VPS docker bridge listener and a router loopback sing-box
inbound, while the optional direct public lane stays isolated. Channel M is not
Channel A/B/C routing and must route only to `direct-out`.

The human-readable Channel M environment inventory is
[channel-m-environment.md](channel-m-environment.md).

Channel D is represented as an experimental router-native Caddy
`forward_proxy@naive` service plus a router-local sing-box SOCKS inbound. It is
disabled by default, has separate public/internal/SOCKS port ownership, and is
not counted as Channel C native Naive proof. Its Caddy binary is built from a
pinned `klzgrad/forwardproxy` naive ref, serves a neutral cover page for
ordinary unauthenticated HTTPS GET probes, and must reject unauthenticated
CONNECT as an open-proxy attempt. Current client proof is Karing-only.

Router SSH has two supported operator paths: direct LAN/Wi-Fi and the approved
WAN SSH profile stored outside git. A LAN-only firewall DROP in `firewall-start`
is considered configuration drift because it can shadow Merlin's own SSH ACCEPT
rule and make the WAN profile fail from an external host.

## Port Registry Rules

Each port entry names an owner component, protocol, bind scope, exposure class,
symbolic source variable and conflict group. The static inventory test validates
that IDs are unique, owners exist, source variables are known, and conflict
groups do not accidentally reuse the same symbolic port source.

Use `fixed_port_sources` in the inventory metadata only for standards-owned
ports that are intentionally not Ansible variables, such as DNS `53` or public
TLS `443`.

## Validation

Run the inventory check before committing runtime or port changes:

```sh
./tests/test-runtime-inventory.sh
```

The fast test suite also runs it:

```sh
./tests/run-fast.sh
```

Future work may add a read-only live comparison report that checks the tracked
symbolic inventory against router/VPS runtime snapshots. That report should
write only to gitignored reports or runtime health output.
