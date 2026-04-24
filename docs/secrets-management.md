# Secrets Management

This repo keeps implementation logic in git and operational secrets outside git.

## What Is Secret

Treat these as secrets or sensitive operational data:

- VLESS client URIs and QR codes.
- Client UUIDs and Reality `short_id` values.
- Reality private/public key material.
- 3x-ui admin username, password, web path and admin port.
- Real VPS IP/hostname and SSH username when they identify the production host.
- Router LAN IP, SSH user and SSH key path.
- Existing shared Caddy site hostnames, local upstream ports and certificate paths.
- Personal bypass rules such as one-off IP:port exceptions.

## Storage Layout

```text
secrets/router.env                  # local router deploy env; gitignored
secrets/no-vpn-ip-ports.local.txt   # personal bypass IP:port rules; gitignored
secrets/device-metadata.local.tsv   # local device aliases; gitignored

ansible/secrets/stealth.yml         # encrypted ansible-vault; gitignored
ansible/secrets/stealth.yml.example # placeholder template; safe for git
ansible/out/clients/                # generated QR/.conf files; gitignored
```

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
./scripts/client-profiles list
./scripts/client-profiles open
./scripts/client-profiles clean
```

Generated artifacts stay local:

```text
ansible/out/clients/<client>.conf
ansible/out/clients/<client>.png
ansible/out/clients/qr-index.html
```

## Pre-Push Checklist

Run:

```bash
./scripts/secret-scan
git status --short
git diff --check
```

`secret-scan` is lightweight and repo-specific. It does not replace judgment, but it catches the common mistakes: real VLESS URIs, UUIDs in docs, private-key markers, embedded public IP hostnames and secret-looking assignments.

## Rules For Documentation

- Use RFC 5737 example IPs only: `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`.
- Use fake UUIDs such as `00000000-0000-4000-8000-000000000000`.
- Use `example.invalid` or `<placeholder>` for hostnames.
- Never paste real QR payloads, vault contents or generated client files.
