# Runtime Inventory and Port Registry

`configs/runtime-inventory.yml` is the tracked, sanitized runtime inventory for
GhostRoute. It is a lightweight OBOM-style registry for operational components,
version policy, compatibility claims, port/listener ownership and upgrade gates.
It is not a full release SBOM and does not replace Ansible inventory or Vault.

The companion [software version registry](../configs/software-versions.json)
records exact repository dependencies, build targets, qualified router packages,
review dates and upstream sources. Validate it without contacting or changing any
host:

```sh
./modules/ghostroute-health-monitor/bin/software-inventory --check
./modules/ghostroute-health-monitor/bin/software-inventory --json
```

The [per-role VPS software inventory](../configs/vps-software-versions.json)
records the deployed host/runtime baseline separately from source targets.
Its maintenance owner is the companion `vps_management` project; routing image
selection and application qualification remain owned here. Unrelated application
images and persistent build workers are listed as ownership exclusions, not
silently advertised as updated.

The fast suite rejects source-pin/lockfile drift. This is a consistency gate,
not an automatic upstream updater: recheck official release channels at each
maintenance window and update the review date only after reviewing them.

## Stable software review — 2026-11-14

Repository-tested control targets are Node LTS 26.13.1, Python 3.15.2 and
Ansible Core 2.22.0. Python dependencies and Galaxy collections are pinned in
`ansible/requirements.txt` and `ansible/collections/requirements.yml`.
Console uses Next 16.4.6, React 19.3.1, TypeScript 7.0.2 and Playwright 1.65.1;
the lockfile and registry carry the complete direct dependency list.

New build/deployment targets are Caddy 2.11.9, xcaddy 0.4.7, caddy-l4 0.1.3,
Go 1.27.4, Xray 26.11.9 and 3x-ui v3.11.0. These source pins do **not** mean
the VPS was upgraded. Inspect effective Vault overrides, back up the panel
database and qualify each candidate before a separate deployment. The panel
image bundles its own Xray; its version is not the standalone Xray target.

The reviewed runtime image recipe now combines independently pinned panel and
core images: `ghostroute/xui:3.11.0-xray26.11.9`. Its build context contains only
the recipe, never panel databases or certificates. The Caddy layer4 image also
uses a versioned tag, so an old `caddy-l4:local` cache cannot silently defeat a
source-version update. Existing Vault overrides must be reviewed at promotion.

Qualify panel migrations against a consistent database copy. Compare the full
client ingress contract and the stored Xray routing template. If a migration
replaces outbound defaults, preserve the reviewed template before acceptance;
in particular, the explicitly allowed private resolver must remain reachable.
Restore the pre-migration database together with the old image on rollback.

### REALITY compatibility hold

The sensitive egress keeps a separately qualified panel image digest in
`vault_hermes_qualified_panel_image`; its deploy playbook rejects an absent or
mutable image reference. Do not inherit the primary build target for this role.
The reviewed newer panel/core combination failed authenticated application HTTPS
through existing sing-box clients despite an identical generated configuration.
The previous panel/core and consistent database restored the working path.
Changing only the edge Caddy did not restore it.

This is consistent with the reported
[REALITY ClientHello compatibility issue](https://github.com/SagerNet/sing-box/issues/4520),
but matching symptoms do not establish packet-level causality. Keep the working
digest until an isolated candidate passes the existing router client engine,
ordinary/managed/sensitive HTTPS, native application probes and identity checks.
A configuration syntax check or unchanged database alone is insufficient.
Never weaken certificate validation or change issued client imports to pass.

Router packages remain on the authenticated, qualified Entware baseline:
sing-box 1.14.4, Xray 26.10.29, Python 3.14.7, OpenSSL 3.5.9 and dnscrypt 2.1.20.
An upstream release newer than a distribution package is not permission to
replace that package with an unqualified binary. Preserve init scripts,
package metadata and all issued imports, including anyT 01–08.

The Naive forwardproxy fork has no stable tagged release channel; retain the
reviewed commit rather than following its tip. The disabled AmneziaWG lab also
retains its reviewed build and identities. Firmware/kernel components follow
Merlin releases; VPS OS packages follow their distribution security repositories.
Neither firmware flashing nor VPS OS upgrades are implied by this registry.
Swift 6.4.2 is recorded as upstream SDK availability; local validation uses
Apple Swift 6.3.1. Swift tools-version declares a minimum, not an SDK install.

Console keeps the explicit Webpack build/dev path supported by Next 16;
Turbopack is not qualified for the shared collector imports. The existing
middleware convention remains compatible but deprecated. Tailwind 4 uses the
dedicated PostCSS plugin without replacing the existing custom stylesheet.
Seeded desktop, Android and iPhone/WebKit checks validate the upgrade. A local
pass does not replace the public performance and iPhone CSS gate after deploy.

## VPS compatibility maintenance

A router engine upgrade does not require the server to use the same engine or
version. Qualify the active transports, credentials, certificate trust and
application transfers before deciding to change a VPS. A working authenticated
chain is stronger compatibility evidence than matching version numbers.

Check both owned VPS roles independently: edge listeners, managed DNS, container
and host services, effective engine versions and pending distribution updates.
From the router, exercise ordinary/managed/sensitive requests through each active
client lane; include anyT's eight approved imports, native application probes,
DNS and negative-path containment. Check the isolated regional-service path
separately. In the reverse direction, verify a permitted report through the
dedicated Console service key with pinned host trust, plus rejection of an
arbitrary command. Never substitute the operator key on the VPS.

Do not upgrade a panel, rebuild a healthy edge or reboot a host merely to match
repository targets. Conversely, a green compatibility gate does not clear
pending OS security maintenance. Review package origins and applicable release
advisories separately, preserve panel data and binaries, qualify candidates and
plan restart/rollback boundaries that preserve protected client contracts.
Record host observations, transient probe failures and final acceptance in
ignored operator reports; public docs retain the procedure rather than snapshots.

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

The optional [Mac Privacy Guard](../modules/mac-privacy-guard/README.md) is a
control-machine application, outside the router/VPS listener registry. Its
loopback gate/dashboard ports are allocated locally and its private profile,
browser data and app bundle are described in the
[module inventory](../modules/mac-privacy-guard/docs/operations.md#локальные-компоненты).
It adds no channel listener or router supervisor ownership.

## Version Policy Classes

The additional [Channel anyT](../modules/routing-core/docs/channel-anytls-lab.md)
is recorded under the retained ID `router_anytls_lab`. Its listener comes from private
`settings.json`, outside the production Ansible port-variable registry. Its
isolated process and containment watcher have scoped boot/firewall/cron recovery.

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

Package maintenance must preserve the repository-managed init scripts. In
particular, upgrading the Entware sing-box package can replace `S99sing-box`
with a script that does not implement our `status` and zombie-PID contract.
Restore the rendered repository template and verify recovery after installation.
Keep package database/configuration backups alongside the previous executable;
an executable-only restore is not a complete package downgrade.

TLS listener expiry probes must send the configured shared C/D certificate
hostname as SNI. A Caddy endpoint can reject a loopback connection without SNI
while correctly serving authenticated clients; this must not be diagnosed as
an expired or missing certificate. The live gate checks expiry; separate
authenticated client probes establish application behavior and hostname trust.

The optional [Snell/ShadowTLS experiment](../modules/routing-core/docs/channel-snell-lab.md)
uses a separate binary and three private listener slots. It is manually started
after reboot and is not covered by the production anyT approval manifest.

Current Entware Xray packages install `/opt/sbin/xray`. Existing Channel B
deployment/init paths retain `/opt/bin/xray`; the role creates a compatibility
symlink only if that legacy path is completely absent and the package binary
exists. It never replaces an existing binary or symlink. Verify the running
relay after package maintenance, not only the installed version string.

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
healthy. The dnscrypt init script and runtime supervisor set
`vm.overcommit_memory=1` before startup so Entware's Go `dnscrypt-proxy2` can
reserve its runtime heap after reboot.

Router boot recovery is represented by `router_runtime_supervisor`. Merlin
`services-start` delegates to `/jffs/scripts/ghostroute-runtime-supervisor.sh`;
the supervisor registers cron jobs and performs targeted component recovery in
dependency order instead of keeping per-channel start blocks in `services-start`.
It also validates router-owned firewall invariants after applying routing:
LAN managed TCP must have REDIRECT rules and managed UDP/443 must be dropped for
both `STEALTH_DOMAINS` and `VPN_STATIC_NETS`. A delayed post-boot stabilization
pass handles Merlin chain rebuilds that can happen after `services-start`.

The captive/connectivity compatibility contract has one explicit direct
exception: plain HTTP `www.google.com:80` may bypass managed Reality so
`generate_204` health checks can complete. HTTPS Google traffic and normal
managed destinations remain governed by the managed split.

Channel M supports applications with regional egress requirements through an
isolated service policy. Because it carries the messenger service lane, the
supervisor owns `ChannelMReverse` cron registration and reruns the tunnel
recovery after reboot or stale remote-forward conditions. It also exposes
scoped `channel-m-status` and `channel-m-recover` commands so a VPS/app
watchdog can request only Channel M repair without triggering general A/B/C/D
router recovery.

The human-readable Channel M environment inventory is
[channel-m-environment.md](channel-m-environment.md).

Channel D is represented as an experimental router-native Caddy
`forward_proxy@naive` service plus a router-local sing-box SOCKS inbound. It is
disabled by default, has separate public/internal/SOCKS port ownership, and is
not counted as Channel C native Naive proof. Its Caddy binary is built from a
pinned `klzgrad/forwardproxy` naive ref, serves a neutral cover page for
ordinary unauthenticated HTTPS GET probes, and must reject unauthenticated
CONNECT as an open-proxy attempt. Current client proof is Karing-only.

Channel Amn is represented by `router_channel_amn_lab`, outside production
supervisor ownership. It uses a pinned userspace AmneziaWG build and a separate
`sing-box-amn` frontend. Its AWG2 client proof, eight named identities and manual
recovery contract are described in the
[lab runbook](../modules/routing-core/docs/channel-amn-research.md).
The UDP port comes from the ignored lab `settings.json` field `port`, not a
production Ansible port variable; its private value and conflict checks remain
in the controller. Reboot/firewall reconciliation is a promotion gate, not an
existing capability.

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
