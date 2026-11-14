# GhostRoute Ansible Control Plane

`ansible/` is the infrastructure control plane for GhostRoute. It owns the
repeatable deployment and verification workflow for the VPS, the ASUS Merlin
router stealth layer, generated client profiles and live end-to-end checks.

The module implementations live under `modules/`; Ansible installs and
configures those modules on the real targets while preserving the existing
router/VPS runtime paths.

## Purpose

- Deploy the VPS Reality entrypoint: Caddy layer4, Xray/3x-ui Reality inbound,
  firewall policy, optional restricted DNS support and the VPS health observer.
- Deploy the router stealth layer: sing-box client, dnscrypt-proxy,
  dnsmasq/ipset integration, blocklists, IPv6 policy and router health monitor.
- Generate local QR/VLESS client artifacts from Vault data.
- Verify that the router, VPS and routing invariants still match the expected
  production model.

## How It Works

The control machine runs playbooks from this directory:

```bash
cd ansible
ansible-playbook playbooks/10-stealth-vps.yml
ansible-playbook playbooks/11-channel-b-vps.yml
ansible-playbook playbooks/20-stealth-router.yml
ansible-playbook playbooks/21-channel-b-router.yml
ansible-playbook playbooks/22-channel-c-router.yml
ansible-playbook playbooks/30-generate-client-profiles.yml
ansible-playbook playbooks/99-verify.yml
```

Inventory values come from `inventory/stealth.yml`, non-secret defaults from
`group_vars/`, and real credentials from `secrets/stealth.yml` encrypted with
Ansible Vault.

Generated client profiles and QR files are written under `out/`. They are local
operator artifacts and must stay out of git.

## Router Access Profiles

`playbooks/31-channel-anytls-lab.yml` manages **Channel anyT**, an additional
home-first AnyTLS service. It defaults to status; `channel_anytls_action=enable`
reinstalls/restarts the service and installs scoped boot/firewall/cron recovery;
`reconcile` repairs only an already enabled anyT, and
`disable` stops it persistently while retaining credentials. Eight private imports
stay under ignored `out/channel-anytls/`. Follow the [runbook](../modules/routing-core/docs/channel-anytls-lab.md)
and fixture/syntax checks. Deployment rejects existing-client rekeying or ingress
changes against existing router settings before stopping the service. The eight
issued imports are protected by the [production contract](../AGENTS.md#channel-anyt-protected-production-contract).
Do not use `enable` as a read-only health check. If installation fails after
mutation starts, rescue disables anyT; it does not automatically restore the
previous version. Complete the [maintenance/rollback checklist](../modules/routing-core/docs/channel-anytls-lab.md#maintenance-acceptance-checklist)
before declaring success. The playbook filename is retained.

Optional hardened management is installed by
`playbooks/26-router-management-access.yml` after local fixture/syntax checks and
operator authorization. It stages private Mac profiles from Vault, provisions a
forwarding-only account on `hermes_vps`, proves a fresh SSH session, and then
restricts router SSH to LAN and approved fixed VPS sources with rollback.
Client channels and managed routing stay unchanged. See
[the management runbook](../docs/router-management-access.md). The router
inventory uses Vault-backed bastion settings when this mode is enabled.

`playbooks/27-router-management-backup.yml` optionally installs an independent
forwarding-only management path through `primary_vps`. It requires explicit
backup enablement, an unused dedicated high port and verified private host-key
pins. A separate listener rejects administrative accounts; the existing admin
port/source policy is preserved. Provider-side ingress must allow only that new
TCP port on the intended server; cloud firewall objects are recorded privately
and are not managed by this playbook. The backup operator alias
is `ssh ghostroute-router-backup`; the default alias and managed traffic exits
remain unchanged. Test the published direct backup from an external network.

For an explicitly approved emergency bridge on a readable write-protected
Entware volume, `playbooks/25-readonly-entware-recovery.yml` installs JFFS-backed
configuration snapshots and boot preparation without restarting services. See
[the recovery runbook](../modules/recovery-verification/docs/readonly-entware-boot-recovery.md)
for prerequisites, snapshot refresh and controlled reboot verification.

`playbooks/28-channel-amn-lab.yml` is an optional, separately authorized
home-first AmneziaWG compatibility experiment. Its default action is read-only
status; `-e channel_amn_action=start` installs isolated Amn files/processes and
scoped rules, while `stop` removes only that lab runtime. It does not run the
production routing roles or install a boot hook. Private credentials and pinned
build output stay under ignored `out/channel-amn/`. Follow the
[lab runbook](../modules/routing-core/docs/channel-amn-research.md), run the narrow
fixture/syntax checks, and keep existing A/B/C/D/M imports unchanged.
The additive `-e channel_amn_action=sync-peers` action registers the named
Channel Amn client batch without restarting either Amn process. It verifies the
live identity and refuses removal/rekeying or transport changes; generated slots
01–08 remain private local artifacts, separate from the diagnostic peer.

Console service authentication is also separate from operator administration.
`29-console-router-access.yml` stages fixed router report restrictions and new
public keys, activates the dedicated VPS service credential, then supports
explicit old-key retirement with timed rollback after proof. It defaults to
read-only status. Follow the [migration runbook](../docs/console-router-ssh-access.md);
the Console deployment never falls back to an operator private key.

Router SSH access is intentionally split by where the control machine is:

- When operating from the home LAN/Wi-Fi, direct LAN access is acceptable with a
  local setting such as `ROUTER_LAN=<router_lan_ip>` and `ROUTER_LAN_PORT=22`.
- When operating remotely, including through Channel A/VPN, the primary router
  path is the dedicated remote-router SSH endpoint and port. Store that profile
  in gitignored `secrets/router.env`. The administrative key stays under private
  `secrets/router-operator-ssh/`; its path is
  `vault_router_management_operator_key_path`. Endpoint metadata uses
  `ghostroute_router_remote_host`, `ghostroute_router_remote_port` and
  `ghostroute_router_remote_user` in Vault. Legacy `router-remote-ssh/` material
  is not a Console fallback and must not restore a retired shared identity.

Remote `secrets/router.env` should contain only local secret values and must not
be committed:

```sh
ROUTER_ACCESS_MODE=auto
ROUTER_LAN=<router_lan_ip>
ROUTER_LAN_PORT=22
ROUTER=<remote-router-ssh-host>
ROUTER_WAN_PORT=<remote-router-ssh-port>
# ROUTER_PORT remains supported as a legacy fallback.
ROUTER_USER=<router-ssh-user>
SSH_IDENTITY_FILE=<absolute-path-to-gitignored-router-key>
CONNECT_TIMEOUT=15
```

`./verify.sh`, router health reports and traffic/catalog diagnostics load
`secrets/router.env` automatically through the shared router helper. In
`ROUTER_ACCESS_MODE=auto`, the helper uses `ROUTER_LAN:22` only when the route
to the LAN address is on a non-VPN interface; when the route goes through
`utun`, `tun`, `wg`, Tailscale or another VPN-like interface it keeps the
WAN/remote `ROUTER:ROUTER_WAN_PORT` profile, with `ROUTER_PORT` as a legacy
fallback.

## Deployment Component Map

Ansible is the repeatable control plane, not the data plane itself. It keeps
the router, VPS and local generated artifacts aligned with the architecture
described in the root README and `docs/architecture.md`.

| Zone | What Ansible manages | Why it exists |
|---|---|---|
| Control machine | Vault, inventory and gitignored client/service artifacts. | Keeps real credentials and generated client/service artifacts local while making deployment repeatable. |
| Router / Channel A | `sing-box`, `dnscrypt-proxy`, dnsmasq catalogs, `STEALTH_DOMAINS`, `VPN_STATIC_NETS`, optional selected full-VPS TPROXY/dnsmasq policy, `firewall-start`, `stealth-route-init.sh`, cron persistence, router health monitor scripts and the active managed egress backend behind `reality-out`. | Provides the active production path: non-selected home LAN/Wi-Fi traffic uses managed split, while selected home Wi-Fi/LAN devices or Home Reality profiles can send all internet-bound traffic through VLESS+Reality+Vision to the active managed egress. |
| Channel M | Isolated regional service policy. | Supports applications with approved country or regional egress requirements independently of client routing. |
| VPS / Reality edge | Caddy layer4 on public `:443`, the existing 3x-ui/Xray Docker Reality backend, optional restricted DNS resolver support, UFW exposure policy, stack directories and the VPS health observer. | Presents the public Reality edge without exposing internal services directly. Public DNS `:53` stays closed. |
| Device-client lanes | Selected-client B/C/D artifacts and explicit channel add-on playbooks when enabled. | Keeps B/C/D ownership isolated from the Channel A router data-plane baseline. |
| Router / Channel Amn lab | Optional isolated AmneziaWG engine, `sing-box-amn`, scoped rules, persistent USB settings and volatile RAM state. | Tests home-first transport diversity with the selected-client split; manual lifecycle and additive peer registration, no production boot ownership. |

Playbook ownership is intentionally narrow:

| Playbook | Target | Owns | Reason |
|---|---|---|---|
| `00-bootstrap-vps.yml` | VPS | Base packages and stack directory prerequisites. | Prepare a clean host for the stealth stack. |
| `10-stealth-vps.yml` | VPS | Caddy L4, Xray Reality, optional restricted DNS support, UFW and VPS health monitor. | Refresh the primary public Reality edge, firewall boundary and observer. |
| `10-caddy-l4.yml` | VPS | Host Caddy layer4 wrapper only. | Refresh public TLS demux or the Console `:443` alias without touching Xray, DNS or firewall roles. |
| `11-channel-b-vps.yml` | VPS | Optional direct-mode Channel B XHTTP backend and route validation. | Rotate or refresh direct-XHTTP testing without touching Reality/Channel A. |
| `12-hermes-egress-vps.yml` | Hermes VPS | Docker-sidecar Caddy L4, Xray Reality clone, restricted DNS support, UFW and VPS health monitor. | Deploy the owned Hermes managed-egress candidate without mutating the primary VPS or regenerating client QR artifacts. |
| `20-stealth-router.yml` | Router | Channel A router services, hooks, catalogs, optional selected full-VPS TPROXY/dnsmasq policy, optional Channel M service ingress, cron persistence and health monitor. | Deploy the router baseline with isolated ownership for optional service policies. |
| `21-channel-b-router.yml` | Router | Channel B home-first XHTTP ingress + local relay add-on. | Enable/refresh Channel B without widening to full router stack changes. |
| `22-channel-c-router.yml` | Router | Channel C1 home-first Naive ingress add-on. | Enable/refresh native Channel C without touching VPS Caddy backends or Channel A ownership. |
| `23-channel-m-reverse.yml` | Service infrastructure | Channel M service-path deployment and scoped verification. | Maintain the approved regional service policy without changing client-channel ownership. |
| `24-channel-d-router.yml` | Router | Experimental Channel D Caddy `forward_proxy@naive` + sing-box SOCKS relay. | Enable/rollback a router-native NaiveProxy lab without touching Channel A/B/C or VPS Caddy. |
| `28-channel-amn-lab.yml` | Router + local control machine | Isolated Amn install/start/stop/status and additive `sync-peers`; policy projection and credentials stay private. | Operate the home-first compatibility lab without changing A/B/C/D/M or existing client imports. |
| `29-console-router-access.yml` | Router + Console VPS | Staged operator/service key separation, fixed report gate, service activation and guarded legacy-key retirement. | Keep administrative credentials off the VPS while preserving monitoring and both management paths. |
| `30-generate-client-profiles.yml` | Localhost | Gitignored QR/VLESS and Channel M service artifacts under `out/`. | Generate importable profiles and private service env fragments without writing credentials to git. |
| `99-verify.yml` | VPS + router | Read-only invariant checks. | Confirm the live setup still matches the intended architecture. |

Module-local verification playbooks may live with their owning module when they
are not part of the platform deployment graph. For example, Console live
performance testing uses:

```bash
ansible-playbook -e @group_vars/all.yml -e @group_vars/vps_stealth.yml -e @secrets/stealth.yml ../modules/ghostroute-console/vps/performance-live.yml
```

That playbook is read-only for GhostRoute runtime state: it runs the existing
Console Playwright performance spec in an ephemeral sidecar against the local VPS
Console listener.

Channel B is production for selected device-client profiles, but it is not an
automatic failover path for Channel A. Channel B can run in direct-XHTTP VPS
mode (`11`) or in home-first mode (`21`) where router ingress is XHTTP and
upstream egress is reused via sing-box Reality. Channel C native is C1
home-first Naive (`22`): clients connect to the home endpoint first, then
router-side sing-box applies the same managed split. The live-proven
Shadowrocket path is C1-Shadowrocket HTTPS CONNECT compatibility and is
persisted by the Channel C router playbook when enabled. Channel D (`24`) is an
experimental home-first NaiveProxy lab: router Caddy `forward_proxy@naive`
relays into sing-box `channel-d-naiveproxy-socks-in` for the same managed split.
Its server build pins the `klzgrad/forwardproxy` naive ref, serves a neutral
cover page for ordinary unauthenticated HTTPS GET probes, and verifies that
unauthenticated CONNECT does not become an open proxy.
For a Karing trial, `vault_channel_d_naiveproxy_profiles_enabled=true` lets
`30-generate-client-profiles.yml --tags channel_d_clients_only` render Channel D
QR artifacts without enabling router runtime. For import-only UI testing without
real endpoints or secrets, run the same tag with
`-e channel_d_naiveproxy_karing_trial_enabled=true`. Live Channel D profile
generation requires a TLS hostname, not a numeric IP, because Karing has no
project-proven SNI override path.
None of these channels may mutate Channel A REDIRECT ownership or introduce
automatic failover.

Channel M is separate from Channel A/B/C. Channel M supports applications with
regional egress requirements through an isolated service policy. It does not
use `reality-out`, `STEALTH_DOMAINS`, `VPN_STATIC_NETS` or policy DNS.

Managed egress reserve mode is separate from Channel B/C. The router keeps the
same managed split and the same `reality-out` route target, while
`router_managed_egress_mode` chooses which backend is rendered behind that tag:
`primary_vps` for the owned VPS, `backup_reality` for a Vault-backed
router-only reserve profile, or `hermes_vps` for the owned clone role. See
[`docs/managed-egress-failover-roadmap.md`](../docs/managed-egress-failover-roadmap.md).
During an incident, the operator can treat `backup_reality` as the active
managed egress while the owned VPS remains an observed switchback candidate.
This changes only the router upstream behind `reality-out`; client profiles,
Channel A/B/C ingress, selected full-VPS sets and catalog policy stay unchanged.

Sensitive sites mode is a separate opt-in destination override. Set
`vault_router_sensitive_sites_enabled: true` while preserving the general
managed selector, and apply `20-stealth-router.yml` after local checks and
operator authorization. It routes `configs/sensitive-domains.txt` to the owned
`hermes_vps` via `sensitive-out`; other managed destinations retain their current
backend. It overrides D's pin only for those domains and excludes Channel M.
See [the contract, domain review and rollback](../modules/routing-core/docs/sensitive-sites-mode.md).

## Directory Map

```text
ansible.cfg                      # local Ansible defaults and inventory path
collections/requirements.yml     # external Ansible collections
inventory/stealth.yml            # router/VPS inventory groups
group_vars/all.yml               # shared non-secret defaults
group_vars/routers.yml           # router defaults and local env fallbacks
group_vars/vps_stealth.yml       # VPS defaults and local env fallbacks
secrets/stealth.yml.example      # safe Vault template
secrets/stealth.yml              # encrypted real Vault, gitignored
out/                             # generated QR/client/service artifacts, gitignored
playbooks/                       # deployment, profile generation and verify
roles/                           # reusable target-specific configuration
scripts/                         # Ansible-local helper scripts
```

Console can also consume a sanitized, gitignored
`modules/ghostroute-console/data/policy-snapshot.local.json` file for Settings.
It is operator/Ansible-derived display state for selected Home Wi-Fi/LAN
full-VPS clients and Channel A/B/C profiles; keep raw MAC/IP/DNS/Vault values
out of that file and use masked tokens instead.

## Playbooks

| Playbook | Target | Mode | Purpose |
|---|---|---|---|
| `00-bootstrap-vps.yml` | VPS | Mutating | Installs base packages and prepares the VPS stack directory. |
| `10-stealth-vps.yml` | VPS | Mutating | Deploys Caddy layer4, Xray Reality, optional restricted DNS support, UFW policy and VPS health observer. |
| `10-caddy-l4.yml` | VPS | Mutating | Deploys only the host Caddy layer4 wrapper and runs deploy gates before and after. |
| `11-channel-b-vps.yml` | VPS | Mutating | Deploys the optional direct-mode Channel B XHTTP backend and checks the existing Caddy route. |
| `20-stealth-router.yml` | Router | Mutating | Deploys the router stealth layer and health monitor through Ansible roles. |
| `21-channel-b-router.yml` | Router | Mutating | Deploys the Channel B home-first router add-on (XHTTP ingress + local relay). |
| `22-channel-c-router.yml` | Router | Mutating | Deploys the Channel C1 home-first Naive ingress. |
| `23-channel-m-reverse.yml` | Service infrastructure | Mutating | Deploys the isolated Channel M regional service policy. |
| `24-channel-d-router.yml` | Router | Mutating | Deploys or removes the experimental Channel D router-native NaiveProxy lab. |
| `30-generate-client-profiles.yml` | Localhost | Local artifact generation | Generates QR/VLESS profiles and private service artifacts into `out/`. |
| `99-verify.yml` | VPS + router | Read-only | Checks live invariants after deploy or incident recovery. |

Mutating playbooks run the shared GhostRoute deploy gate before and after the
change unless `ghostroute_skip_deploy_gate=true` is passed explicitly. The gate
uses `modules/ghostroute-health-monitor/bin/live-check --active-probe
--deploy-gate` from the control machine, so it blocks when the current
Wi-Fi managed-domain path, VPS edge or Channel A/B/C runtime chain is already
unhealthy. Router and VPS playbooks also capture a last-known-good bundle before
mutation so post-deploy recovery has a concrete restore point.

Router playbooks `20`, `21`, `22` and `24` start sing-box idempotently while
installing the shared role. Their final restart runs as an asynchronous job so
the management SSH session is not held across the routing interruption. Ansible
then resets SSH, waits for reconnection, checks the job result and requires a
running sing-box process before continuing to routing recovery and the post-
deploy gate. An unreachable router or failed restart still fails the playbook.
Playbook `20` uses the same reconnect pattern for rule-set refresh because it
may restart sing-box or dnsmasq when catalogs change. After its final service
recovery, it waits for the local dnsmasq listener before the active deploy gate.

For non-mutating local/CI decisions, use
`modules/ghostroute-health-monitor/bin/deploy-risk`. It classifies changed paths
and recommends whether the full live deploy gate is necessary. This does not
weaken the playbooks: any playbook that mutates router/VPS runtime still runs
the gate itself.

## Roles

| Role | Owner Area |
|---|---|
| `caddy_l4` | VPS public TLS/Reality demux through Caddy layer4. |
| `xray_reality` | VPS Xray/3x-ui Reality inbound state. |
| `vps_unbound` | VPS managed-domain resolver for policy-based DNS consistency; forwards through the local system resolver when recursive DNS is unavailable, and installs a narrow Docker unit override so the Docker bridge cannot form an Unbound/Docker boot-order cycle. |
| `ufw_stealth` | VPS firewall exposure policy. |
| `vps_health_monitor` | VPS-side GhostRoute health observer. |
| `ipv6_kill` | Router IPv6 policy. |
| `singbox_client` | Router sing-box client config and service. |
| `stealth_routing` | Router dnsmasq/ipset/firewall integration. |
| `dnscrypt_proxy` | Router DNS resolver layer. |
| `dnsmasq_blocklists` | Router managed blocklist and catalog support. |
| `channel_b_home_relay` | Router Channel B XHTTP ingress plus local relay into sing-box SOCKS/Reality upstream. |
| `health_monitor` | Router-side GhostRoute health monitor. |

## Safety Contract

- Playbooks `00`, `10` and `20` are mutating and should be run intentionally.
- Playbooks `10`, `11`, `20`, `21` and `22` are protected by the deploy gate.
  Use `-e ghostroute_skip_deploy_gate=true` only for emergency recovery.
- Playbook `30` writes local generated artifacts only.
- Playbook `99` is read-only and is safe as a post-change health gate.
- Secrets live in Vault or gitignored local files only.
- Generated QR payloads, UUIDs, keys, short IDs, public endpoints and real
  client configs must not be committed or pasted into public docs.
- `xui_admin_password`, `reality_server_private_key` and
  `home_reality_server_private_key` are deploy-critical secrets. If any of them
  is empty in Vault, do not run broad mutating playbooks (`10`/`20`) until
  recovery is complete.
- Keep `xui_admin_web_port` and `xui_admin_web_path` aligned with live 3x-ui
  settings. A credentials reset should preserve live port/path values.

Router sing-box restarts and rule-set refreshes that can interrupt the SSH
transport are launched asynchronously. The playbook waits for management
reconnection, polls task completion and runs its readiness/deploy gate. A lost
connection alone must not be interpreted as a successful restart. This orchestration
is implemented independently of client ingress/profile generation.

For client migration gates, independent archive restore proof and broader
maintenance drills, see the [routing assurance plan](../docs/routing-assurance-roadmap.md)
and [backup runbook](../modules/secrets-management/docs/vault-offsite-backup.md).

## Common Workflows

Bootstrap or refresh VPS:

```bash
cd ansible
ansible-playbook playbooks/00-bootstrap-vps.yml
ansible-playbook playbooks/10-stealth-vps.yml
```

Refresh Channel B direct VPS lane:

```bash
cd ansible
ansible-playbook playbooks/11-channel-b-vps.yml
```

Refresh Channel B home-first router add-on:

```bash
cd ansible
ansible-playbook playbooks/21-channel-b-router.yml
```

### Channel C/D TLS prerequisite

Before `22-channel-c-router.yml` or `24-channel-d-router.yml`, configure a
current certificate source for every enabled public C/D listener. Production
uses the router ASUS ACME source through
`vault_channel_c_home_tls_source: "asus_acme"`; Channel D inherits that source
unless configured separately. Its certificate must match the configured public
hostname. Do not use an expired Vault PEM as a fallback: the playbooks reject
expired source material and, after deployment, check the certificate actually
served by each listener rather than trusting the file alone.

The router supervisor performs a daily ACME renewal check and periodic TLS
sync. A check does not issue or renew while the certificate is sufficiently
fresh. Only a near-expiry HTTP-01 renewal creates a temporary, scoped WAN
exception; it is removed whether the renewal succeeds or fails. This
maintenance is confined to C/D TLS and does not modify Channel A, B or M
routing, DNS, firewall ownership, profiles, or managed-egress selection.

Refresh Channel C1 home-first router add-on:

```bash
cd ansible
ansible-playbook playbooks/22-channel-c-router.yml
```

C1 router-side Naive uses sing-box `naive` inbound support, so the router binary
must be `>= 1.13`. The playbook fails fast when C1 is enabled and `sing-box` is
older than the Naive-capable line. The tested iPhone SFI app used sing-box
`1.11.4` and rejected outbound `type: naive`; SFI native profile generation is
therefore disabled by default until the selected iPhone client supports Naive
outbound.

Shadowrocket compatibility is intentionally separate from C1-sing-box Naive. The
live C1-Shadowrocket proof uses sing-box HTTP inbound over TLS on a separate
public port and is persisted through the Channel C router playbook, firewall
hook and generated profiles.

Refresh router stealth layer:

```bash
cd ansible
ansible-playbook playbooks/20-stealth-router.yml
```

Switch managed egress backend during an incident or drill:

```bash
./modules/routing-core/bin/managed-egress-mode status
./modules/routing-core/bin/managed-egress-mode set backup_reality --deploy-router
./modules/ghostroute-health-monitor/bin/egress-backend-health
./modules/ghostroute-health-monitor/bin/live-check --active-probe channel-a
```

`primary_vps`, `backup_reality` and `hermes_vps` are router-side managed egress
backends behind the stable `reality-out` tag. The helper edits only
`vault_router_managed_egress_mode`; it does not change client profiles, QR/VLESS
artifacts, Channel A/B/C ingress ports, managed catalogs or direct traffic
policy. Channel D and Channel M are not switched by this helper.
Public docs and commit text must keep these as mnemonic roles only; real
provider, endpoint, ASN and role mappings stay in Vault or gitignored notes.

Generate local client profiles:

```bash
cd ansible
ansible-playbook playbooks/30-generate-client-profiles.yml
```

Verify the live setup:

```bash
cd ansible
ansible-playbook playbooks/99-verify.yml
```

## Incident Recovery Notes

### Deploy-only secret recovery (2026-04-27)

Recovery pattern used safely in production:

1. Recover VPS Reality key material read-only from `/etc/x-ui/x-ui.db` inside
   the `xray` container, then restore `reality_server_private_key` and
   `reality_short_ids` in Vault.
2. Recover router home Reality private key read-only from router sing-box
   config (`/opt/etc/sing-box/config.json`, inbound tag `reality-in`), then
   restore `home_reality_server_private_key` and
   `home_reality_server_short_ids` in Vault.
3. If current 3x-ui password is unknown, perform a controlled credentials reset
   on the VPS while preserving live `port`/`webBasePath`, then update
   `xui_admin_password`, `xui_admin_web_port` and `xui_admin_web_path` in Vault.
4. After recovery, run read-only checks first:
   `ansible-playbook playbooks/99-verify.yml --limit vps_stealth`.

### 99-verify OpenClaw note

OpenClaw checks in `99-verify.yml` are enabled by default via
`verify_openclaw_checks_enabled=true`, because OpenClaw and GhostRoute share
the VPS/Caddy surface. If you need an isolated GhostRoute-only run, disable
them explicitly with:
`ansible-playbook playbooks/99-verify.yml -e verify_openclaw_checks_enabled=false`.

### Managed-egress Docker/resolver boot order

When the VPS Unbound bridge guard is enabled, the `vps_unbound` role renders a
narrow Docker system-unit override and removes the legacy bridge drop-in. Its
only purpose is to keep Docker from waiting for `nss-lookup.target` supplied by
the resolver that itself waits for Docker's bridge; that dependency cycle can
leave edge containers down after boot. The role remains the source of truth—do
not repair this by editing `/etc/systemd/system/docker.service` by hand.

After a Docker/systemd package update, inspect the resulting unit graph before
the next reboot:

```bash
systemctl cat docker.service
systemctl show -p After docker.service
systemd-analyze verify docker.service <resolver-service>
```

The expected state has no Docker dependency on the lookup target supplied by
the guarded resolver and no current-boot ordering-cycle log.
For active-probe interpretation, firewall boundaries and safe recovery see
[managed-egress VPS boot recovery](../docs/managed-egress-vps-boot-recovery.md).

## Related Docs

- [Operational modules](../docs/operational-modules.md)
- [Secrets management](../modules/secrets-management/docs/secrets-management.md)
- [Client profile workflow](../modules/client-profile-factory/docs/client-profiles.md)
- [Routing core guide](../modules/routing-core/docs/stealth-channel-implementation-guide.md)
- [Channel A selected full-VPS](../docs/channel-a-selected-full-vps.md)
- [Managed egress reserve mode](../docs/managed-egress-failover-roadmap.md)
- [Managed egress VPS boot recovery](../docs/managed-egress-vps-boot-recovery.md)
- [Health monitor guide](../modules/ghostroute-health-monitor/docs/stealth-monitoring-implementation-guide.md)
- [Recovery and verification](../modules/recovery-verification/docs/failure-modes.md)
