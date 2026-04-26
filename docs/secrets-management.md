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
- Existing shared Caddy site hostnames, local upstream ports and certificate paths.
- Personal bypass rules such as one-off IP:port exceptions.

## Storage Layout

```text
secrets/router.env                  # local router deploy env; gitignored
secrets/no-vpn-ip-ports.local.txt   # personal bypass IP:port rules; gitignored
secrets/device-metadata.local.tsv   # local device aliases; gitignored
configs/private/dnsmasq-stealth.local.conf.add
                                   # local provider/admin/private domain rules; gitignored

ansible/secrets/stealth.yml         # encrypted ansible-vault; gitignored
ansible/secrets/stealth.yml.example # placeholder template; safe for git
ansible/out/clients/                # generated QR/.conf files; gitignored
docs/private/                       # local-only operational notes; gitignored
reports/                            # local generated reports; gitignored
```

`secrets/device-metadata.local.tsv` is the shared local source for report device
labels. It is intentionally gitignored because it maps LAN IPs to people/devices.
Format:

```text
# ip-or-key|friendly alias|device type
192.168.50.21|Denis laptop|Windows laptop
192.168.50.150||iPad
192.168.50.195||iPad
192.168.50.228|Office desktop|Windows PC
```

Reports use the shared parser in
`modules/shared/lib/device-labels.sh` through the stable `scripts/lib` wrapper.
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
./scripts/init-stealth-vault.sh --vps-host <vps_ip_or_dns_name> --router-ip <router_lan_ip>
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

## Client Profiles And QR Codes

QR codes are access credentials. Do not commit them, paste them into docs or send them through untrusted channels.

Use the wrapper:

```bash
./scripts/client-profiles generate
./scripts/client-profiles home-list
./scripts/client-profiles home-open
./scripts/client-profiles home-clean
```

Generated artifacts stay local:

```text
ansible/out/clients/router.conf
ansible/out/clients-home/<client>.conf
ansible/out/clients-home/<client>.png
ansible/out/clients-home/qr-index.html
```

## Pre-Push Checklist

Run:

```bash
./scripts/secret-scan
git status --short
git diff --check
```

`secret-scan` is lightweight and repo-specific. It does not replace judgment, but it catches the common mistakes: real VLESS URIs, UUIDs in docs, private-key markers, embedded public IP hostnames and secret-looking assignments. It also rejects known production listener/IP literals that have been removed from public documentation and history.

## Rules For Documentation

- Use RFC 5737 example IPs only: `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`.
- Use fake UUIDs such as `00000000-0000-4000-8000-000000000000`.
- Use `example.invalid` or `<placeholder>` for hostnames.
- Never paste real QR payloads, vault contents or generated client files.
- Keep provider-specific/admin-only domains in
  `configs/private/dnsmasq-stealth.local.conf.add`, not in the public catalog.
