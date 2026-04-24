# Client Profiles And QR Codes

VLESS/Reality client profiles are generated locally from `ansible-vault`.

## Where These Clients Fit

QR/VLESS clients are the third traffic path in the project:

```text
iPhone/MacBook outside home
  -> QR/VLESS profile in a client app
  -> VPS VPS / shared Caddy :443
  -> Xray Reality inbound
  -> Internet
```

They do not connect to the ASUS router and do not use `wgs1`, `wgc1`, `VPN_DOMAINS` or `STEALTH_DOMAINS` on the router. They are direct external-device egress profiles.

If a phone/laptop needs access back into the home LAN, use the router WireGuard Server path (`wgs1`) or design a separate remote-access overlay. Do not assume the QR/VLESS profile gives LAN access.

## Security Model

Generated files are secrets:

```text
ansible/out/clients/*.conf
ansible/out/clients/*.png
ansible/out/clients/qr-index.html
```

They contain client UUIDs, Reality parameters and server access information. They are gitignored and must not be copied into README/docs/issues/chat.

## Generate

```bash
./scripts/client-profiles generate
```

This runs:

```bash
cd ansible
ansible-playbook playbooks/30-generate-client-profiles.yml
```

## View Locally

```bash
./scripts/client-profiles list
./scripts/client-profiles open
```

`open` opens the local `qr-index.html` when available.

## Clean Local Artifacts

```bash
./scripts/client-profiles clean
```

This removes generated files under `ansible/out/clients/` and keeps only `.gitkeep`.

## Add Or Rotate A Client

1. Edit `ansible/secrets/stealth.yml` with `ansible-vault edit`.
2. Add or rotate the client's `uuid` and `short_id`.
3. Deploy VPS/router changes if the server-side inbound needs updating.
4. Regenerate local profiles with `./scripts/client-profiles generate`.
5. Scan the new QR from the device.

Fake URI shape:

```text
vless://00000000-0000-4000-8000-000000000000@example.invalid:443?type=tcp&security=reality&pbk=FAKE_PUBLIC_KEY&sid=FAKE_SHORT_ID&sni=gateway.icloud.com&fp=chrome#example-client
```

Never replace this fake example with a real URI in documentation.
