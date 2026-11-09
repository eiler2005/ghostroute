# Secrets Management

This repo keeps implementation logic in git and operational secrets outside git.

## What Is Secret

Treat these as secrets or sensitive operational data:

- VLESS client URIs and QR codes.
- Client UUIDs and Reality `short_id` values.
- Reality private/public key material.
- 3x-ui admin username, password, web path and admin port.
- Router/VPS runtime listener ports, including LAN REDIRECT, Home Reality
  ingress, local SOCKS/DNS, Xray localhost and admin ports.
- Real VPS IP/hostname and SSH username when they identify the production host.
- Router LAN IP, SSH user and SSH key path.
- Router remote SSH host/port/user and private key used by the GhostRoute
  Console read-only collector.
- Existing shared Caddy site hostnames, local upstream ports and certificate paths.
- Personal bypass rules such as one-off IP:port exceptions.

## Storage Layout

```text
secrets/router.env                  # local router deploy env; gitignored
secrets/router-operator-ssh/        # administrative router key on Mac; gitignored
secrets/router-console-ssh/         # dedicated restricted service key; gitignored
secrets/router-remote-ssh/          # legacy keys; never a Console fallback
secrets/no-vpn-ip-ports.local.txt   # personal bypass IP:port rules; gitignored
secrets/static-networks.local.txt   # local /32 managed-route tests; gitignored
secrets/device-metadata.local.tsv   # local device aliases; gitignored
configs/private/dnsmasq-stealth.local.conf.add
                                   # local provider/admin/private domain rules; gitignored

ansible/secrets/stealth.yml         # encrypted ansible-vault; gitignored
ansible/secrets/stealth.yml.example # placeholder template; safe for git
ansible/secrets/stealth.yml.backup-* # local Vault backups; gitignored
ansible/out/clients/                # generated QR/.conf files; gitignored
ansible/out/channel-amn/            # lab settings, keys, eight client imports
ansible/out/console-router-access/  # generated fixed report policy; gitignored
docs/private/                       # local-only operational notes; gitignored
reports/                            # local generated reports; gitignored
```

`secrets/device-metadata.local.tsv` is the shared local source for report device
labels. It is intentionally gitignored because it maps LAN IPs to people/devices.
Format:

```text
# ip-or-key|friendly alias|device type
<lan_client_ip_1>|owner laptop|laptop
<lan_client_ip_2>||tablet
<lan_client_ip_3>||tablet
<lan_client_ip_4>|office desktop|desktop
```

Reports use the shared parser in
`modules/shared/lib/device-labels.sh` through the module-native `modules/shared/lib` helper.
`traffic-report`, `traffic-daily-report` and `dns-forensics-report` all consume
that same map.

## First-Time Setup

```bash
mkdir -p secrets
cp .env.example secrets/router.env
$EDITOR secrets/router.env
```

Create the Ansible vault:

```bash
./modules/secrets-management/bin/init-stealth-vault.sh --vps-host <vps_ip_or_dns_name> --router-ip <router_lan_ip>
cd ansible
ansible-vault edit secrets/stealth.yml
```

Before deploy, replace placeholders in the vault:

```text
vps_ssh_host
vps_ssh_user
router_ssh_host
router_ssh_user
system_caddy_site_host
system_caddy_site_upstream
system_caddy_cert_file
system_caddy_key_file
system_caddy_client_ca_file
xui_admin_* values
clients[].uuid
clients[].short_id
Reality keys
```

## Router Credentials And Backups

Operator and Console router keys have separate roles. The administrative key
stays on the Mac; only the restricted Console identity is deployed to its VPS.
The router enforces its report allowlist, and verified host pins belong beside
the private service configuration. Keep `vault_console_router_private_key` and
`vault_console_router_known_hosts` in encrypted Vault. Retire an old shared key
only after proving the new operator paths and actual collector, then remove its
VPS copies. See the [migration and rollback runbook](../../../docs/console-router-ssh-access.md).

Store configuration/key backups encrypted under ignored
`reports/router-backups/`; verify a restore in memory and keep the Vault password
outside that archive. A local encrypted copy is not an offsite backup.

## Client Profiles And QR Codes

QR codes are access credentials. Do not commit them, paste them into docs or send them through untrusted channels.

Use the module command:

```bash
./modules/client-profile-factory/bin/client-profiles generate
./modules/client-profile-factory/bin/client-profiles home-list
./modules/client-profile-factory/bin/client-profiles home-open
./modules/client-profile-factory/bin/client-profiles home-clean
```

Generated artifacts stay local:

```text
ansible/out/clients/router.conf
ansible/out/clients-home/<client>.conf
ansible/out/clients-home/<client>.png
ansible/out/clients-home/qr-index.html
```

For Channel Amn, `Channel Amn 01–08` are independently keyed client slots on one
ingress. Slot 01 preserves the tested original identity. Its local QR index and
client ZIP stay in `ansible/out/channel-amn/`; the full recovery bundle also
contains server and diagnostic credentials, so back up the complete directory
privately. The client-only ZIP is not a complete server backup. See the
[Amn runbook](../../routing-core/docs/channel-amn-research.md).

## Pre-Push Checklist

Run:

```bash
./modules/secrets-management/bin/secret-scan
./modules/secrets-management/bin/cleanup-vault-backups --dry-run
git status --short
git diff --check
```

`secret-scan` is lightweight and repo-specific. It does not replace judgment, but it catches the common mistakes: real VLESS URIs, UUIDs in docs, private-key markers, embedded public IP hostnames and secret-looking assignments. It also rejects known production listener/IP literals that have been removed from public documentation and history.

Raster image formats and macOS ICNS icons are excluded from text scanning;
decoding compressed image bytes as text produces meaningless literal matches.
Review their source/provenance separately. The binary/text boundary regression
check is `python3 modules/secrets-management/tests/test-secret-scan.py`.

`cleanup-vault-backups` is local hygiene only. It defaults to dry-run and should
be used to review stale `ansible/secrets/stealth.yml.backup-*` files after a
fresh encrypted offsite backup exists.

## Rules For Documentation

- Use RFC 5737 example IPs only: `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`.
- Use fake UUIDs such as `00000000-0000-4000-8000-000000000000`.
- Use `example.invalid` or `<placeholder>` for hostnames.
- Never paste real QR payloads, vault contents or generated client files.
- Keep provider-specific/admin-only domains in
  `configs/private/dnsmasq-stealth.local.conf.add`, not in the public catalog.

## Offsite Backup

Vault loss is a critical operational risk. Keep an encrypted offsite copy and
test that it decrypts before you need it. See
[vault-offsite-backup.md](vault-offsite-backup.md).
