# GhostRoute Ansible Control Plane

`ansible/` is the infrastructure control plane for GhostRoute. It owns the
repeatable deployment and verification workflow for the VPS, the ASUS Merlin
router stealth layer, generated client profiles and live end-to-end checks.

The module implementations live under `modules/`; Ansible installs and
configures those modules on the real targets while preserving the existing
router/VPS runtime paths.

## Purpose

- Deploy the VPS Reality entrypoint: Caddy layer4, Xray/3x-ui Reality inbound,
  firewall policy and the VPS health observer.
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
ansible-playbook playbooks/20-stealth-router.yml
ansible-playbook playbooks/30-generate-client-profiles.yml
ansible-playbook playbooks/99-verify.yml
```

Inventory values come from `inventory/stealth.yml`, non-secret defaults from
`group_vars/`, and real credentials from `secrets/stealth.yml` encrypted with
Ansible Vault.

Generated client profiles and QR files are written under `out/`. They are local
operator artifacts and must stay out of git.

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

## Playbooks

| Playbook | Target | Mode | Purpose |
|---|---|---|---|
| `00-bootstrap-vps.yml` | VPS | Mutating | Installs base packages and prepares the VPS stack directory. |
| `10-stealth-vps.yml` | VPS | Mutating | Deploys Caddy layer4, Xray Reality, UFW policy and VPS health observer. |
| `20-stealth-router.yml` | Router | Mutating | Deploys the router stealth layer and health monitor through Ansible roles. |
| `30-generate-client-profiles.yml` | Localhost | Local artifact generation | Generates QR/VLESS profiles into `out/`. |
| `99-verify.yml` | VPS + router | Read-only | Checks live invariants after deploy or incident recovery. |

## Roles

| Role | Owner Area |
|---|---|
| `caddy_l4` | VPS public TLS/Reality demux through Caddy layer4. |
| `xray_reality` | VPS Xray/3x-ui Reality inbound state. |
| `ufw_stealth` | VPS firewall exposure policy. |
| `vps_health_monitor` | VPS-side GhostRoute health observer. |
| `ipv6_kill` | Router IPv6 policy. |
| `singbox_client` | Router sing-box client config and service. |
| `stealth_routing` | Router dnsmasq/ipset/firewall integration. |
| `dnscrypt_proxy` | Router DNS resolver layer. |
| `dnsmasq_blocklists` | Router managed blocklist and catalog support. |
| `health_monitor` | Router-side GhostRoute health monitor. |

## Safety Contract

- Playbooks `00`, `10` and `20` are mutating and should be run intentionally.
- Playbook `30` writes local generated artifacts only.
- Playbook `99` is read-only and is safe as a post-change health gate.
- Secrets live in Vault or gitignored local files only.
- Generated QR payloads, UUIDs, keys, short IDs, public endpoints and real
  client configs must not be committed or pasted into public docs.

## Common Workflows

Bootstrap or refresh VPS:

```bash
cd ansible
ansible-playbook playbooks/00-bootstrap-vps.yml
ansible-playbook playbooks/10-stealth-vps.yml
```

Refresh router stealth layer:

```bash
cd ansible
ansible-playbook playbooks/20-stealth-router.yml
```

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

## Related Docs

- [Operational modules](/docs/operational-modules.md)
- [Secrets management](/modules/secrets-management/docs/secrets-management.md)
- [Client profile workflow](/modules/client-profile-factory/docs/client-profiles.md)
- [Routing core guide](/modules/routing-core/docs/stealth-channel-implementation-guide.md)
- [Health monitor guide](/modules/ghostroute-health-monitor/docs/stealth-monitoring-implementation-guide.md)
- [Recovery and verification](/modules/recovery-verification/docs/failure-modes.md)
