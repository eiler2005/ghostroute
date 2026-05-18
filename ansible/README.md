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

Router SSH access is intentionally split by where the control machine is:

- When operating from the home LAN/Wi-Fi, direct LAN access is acceptable with a
  local setting such as `ROUTER_LAN=<router_lan_ip>` and `ROUTER_LAN_PORT=22`.
- When operating remotely, including through Channel A/VPN, the primary router
  path is the dedicated remote-router SSH endpoint and port. Store that profile
  in gitignored `secrets/router.env` and use the gitignored operator key under
  `secrets/router-remote-ssh/`, or store the equivalent
  `ghostroute_router_remote_host`, `ghostroute_router_remote_port`,
  `ghostroute_router_remote_user` and `ghostroute_router_remote_private_key` in
  Vault.

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
| Control machine | Inventory, non-secret defaults, Vault-backed secrets, syntax/health checks and local QR/profile output under `out/`. | Keeps real credentials and generated client artifacts local while making deployment repeatable. |
| Router / Channel A | `sing-box`, `dnscrypt-proxy`, dnsmasq catalogs, `STEALTH_DOMAINS`, `VPN_STATIC_NETS`, optional selected full-VPS TPROXY/dnsmasq policy, `firewall-start`, `stealth-route-init.sh`, cron persistence, router health monitor scripts and the active managed egress backend behind `reality-out`. | Provides the active production path: non-selected home LAN/Wi-Fi traffic uses managed split, while selected home Wi-Fi/LAN devices or Home Reality profiles can send all internet-bound traffic through VLESS+Reality+Vision to the active managed egress. |
| VPS / Reality edge | Caddy layer4 on public `:443`, the existing 3x-ui/Xray Docker Reality backend, optional restricted DNS resolver support, UFW exposure policy, stack directories and the VPS health observer. | Presents the public Reality edge without exposing internal services directly. Public DNS `:53` stays closed. |
| Device-client lanes | Selected-client B/C artifacts and explicit channel add-on playbooks when enabled. | Keeps B/C ownership isolated from the Channel A router data-plane baseline. |

Playbook ownership is intentionally narrow:

| Playbook | Target | Owns | Reason |
|---|---|---|---|
| `00-bootstrap-vps.yml` | VPS | Base packages and stack directory prerequisites. | Prepare a clean host for the stealth stack. |
| `10-stealth-vps.yml` | VPS | Caddy L4, Xray Reality, optional restricted DNS support, UFW and VPS health monitor. | Refresh the public Reality edge, firewall boundary and observer. |
| `11-channel-b-vps.yml` | VPS | Optional direct-mode Channel B XHTTP backend and route validation. | Rotate or refresh direct-XHTTP testing without touching Reality/Channel A. |
| `20-stealth-router.yml` | Router | Channel A router services, hooks, catalogs, optional selected full-VPS TPROXY/dnsmasq policy, cron persistence and health monitor. | Restore or refresh the production router-managed data plane. |
| `21-channel-b-router.yml` | Router | Channel B home-first XHTTP ingress + local relay add-on. | Enable/refresh Channel B without widening to full router stack changes. |
| `22-channel-c-router.yml` | Router | Channel C1 home-first Naive ingress add-on. | Enable/refresh native Channel C without touching VPS Caddy backends or Channel A ownership. |
| `30-generate-client-profiles.yml` | Localhost | Gitignored QR/VLESS artifacts under `out/`. | Generate importable profiles without writing credentials to git. |
| `99-verify.yml` | VPS + router | Read-only invariant checks. | Confirm the live setup still matches the intended architecture. |

Channel B is production for selected device-client profiles, but it is not an
automatic failover path for Channel A. Channel B can run in direct-XHTTP VPS
mode (`11`) or in home-first mode (`21`) where router ingress is XHTTP and
upstream egress is reused via sing-box Reality. Channel C native is C1
home-first Naive (`22`): clients connect to the home endpoint first, then
router-side sing-box applies the same managed split. The live-proven
Shadowrocket path is C1-Shadowrocket HTTPS CONNECT compatibility and is
persisted by the Channel C router playbook when enabled. Neither channel may
mutate Channel A REDIRECT ownership or introduce automatic failover.

Managed egress reserve mode is separate from Channel B/C. The router keeps the
same managed split and the same `reality-out` route target, while
`router_managed_egress_mode` chooses which backend is rendered behind that tag:
`primary_vps` for the owned VPS, or `backup_reality` for a Vault-backed
router-only provider profile. See
[`docs/managed-egress-failover-roadmap.md`](/docs/managed-egress-failover-roadmap.md).
During an incident, the operator can treat `backup_reality` as the active
managed egress while the owned VPS remains an observed switchback candidate.
This changes only the router upstream behind `reality-out`; client profiles,
Channel A/B/C ingress, selected full-VPS sets and catalog policy stay unchanged.

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
out/                             # generated QR/client artifacts, gitignored
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
| `11-channel-b-vps.yml` | VPS | Mutating | Deploys the optional direct-mode Channel B XHTTP backend and checks the existing Caddy route. |
| `20-stealth-router.yml` | Router | Mutating | Deploys the router stealth layer and health monitor through Ansible roles. |
| `21-channel-b-router.yml` | Router | Mutating | Deploys the Channel B home-first router add-on (XHTTP ingress + local relay). |
| `22-channel-c-router.yml` | Router | Mutating | Deploys the Channel C1 home-first Naive ingress. |
| `30-generate-client-profiles.yml` | Localhost | Local artifact generation | Generates QR/VLESS profiles into `out/`. |
| `99-verify.yml` | VPS + router | Read-only | Checks live invariants after deploy or incident recovery. |

Mutating playbooks run the shared GhostRoute deploy gate before and after the
change unless `ghostroute_skip_deploy_gate=true` is passed explicitly. The gate
uses `modules/ghostroute-health-monitor/bin/live-check --active-probe
--deploy-gate` from the control machine, so it blocks when the current
Wi-Fi managed-domain path, VPS edge or Channel A/B/C runtime chain is already
unhealthy. Router and VPS playbooks also capture a last-known-good bundle before
mutation so post-deploy recovery has a concrete restore point.

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
| `vps_unbound` | VPS managed-domain resolver for policy-based DNS consistency; forwards through the local system resolver when recursive DNS is unavailable. |
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
cd ansible
ansible-vault edit secrets/stealth.yml
# Set vault_router_managed_egress_mode to primary_vps or backup_reality.
ansible-playbook --syntax-check playbooks/20-stealth-router.yml
ansible-playbook playbooks/20-stealth-router.yml
../modules/ghostroute-health-monitor/bin/live-check --active-probe channel-a
```

`backup_reality` must use a dedicated router-only profile stored in Vault. It
does not change client profiles, Channel A/B/C ingress ports, managed catalogs
or direct traffic policy.

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

## Related Docs

- [Operational modules](/docs/operational-modules.md)
- [Secrets management](/modules/secrets-management/docs/secrets-management.md)
- [Client profile workflow](/modules/client-profile-factory/docs/client-profiles.md)
- [Routing core guide](/modules/routing-core/docs/stealth-channel-implementation-guide.md)
- [Channel A selected full-VPS](/docs/channel-a-selected-full-vps.md)
- [Managed egress reserve mode](/docs/managed-egress-failover-roadmap.md)
- [Health monitor guide](/modules/ghostroute-health-monitor/docs/stealth-monitoring-implementation-guide.md)
- [Recovery and verification](/modules/recovery-verification/docs/failure-modes.md)
