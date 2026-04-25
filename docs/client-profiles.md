# Client Profiles And QR Codes

VLESS/Reality client profiles are generated locally from `ansible-vault`.

## Where These Clients Fit

QR/VLESS clients are the third traffic path in the project:

```text
iPhone/MacBook outside home
  -> QR/VLESS profile in a client app
  -> home ASUS public IP / :<home-reality-port>
  -> sing-box home Reality inbound
  -> sing-box Reality outbound
  -> VPS VPS / shared Caddy :443
  -> Xray Reality inbound on VPS
  -> Internet
```

They connect to the ASUS router first. This is deliberate: a mobile carrier sees
the remote device connecting to the home Russian IP, not directly to VPS.
The final website/checker still sees the VPS exit IP because the router's
outbound remains Reality-to-VPS.

This is the expected split:

| Observer | Sees |
|---|---|
| LTE/mobile carrier | Remote device -> home Russian IP `:<home-reality-port>` |
| Home ISP | ASUS router -> VPS Reality endpoint |
| Website/checker for managed domains | VPS exit IP / datacenter ASN |
| Website for non-managed domains | Home Russian WAN IP |

Do not use generic checker results alone to judge the LTE-facing path. A checker
reports the final website-facing exit IP, not the first hop that the mobile
carrier observes.

These profiles are for egress, not LAN management. They do not grant general
home LAN access unless a route is explicitly added later.

## Security Model

Generated files are secrets:

```text
ansible/out/clients/router.conf
ansible/out/clients-home/*.conf
ansible/out/clients-home/*.png
ansible/out/clients-home/qr-index.html
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
./scripts/client-profiles home-list
./scripts/client-profiles home-open
```

`home-open` opens the local home Reality `qr-index.html` when available.

## Clean Local Artifacts

```bash
./scripts/client-profiles home-clean
```

This removes generated home mobile files under `ansible/out/clients-home/` and keeps only `.gitkeep`. `ansible/out/clients/router.conf` is the router's VPS identity, not a mobile QR.

## Add Or Rotate A Client

1. Edit `ansible/secrets/stealth.yml` with `ansible-vault edit`.
2. Add or rotate the client's `uuid` and `short_id` in `home_clients[]`.
3. Deploy router changes if the home Reality inbound needs updating.
4. Regenerate local profiles with `./scripts/client-profiles generate`.
5. Scan the new QR from the device.

Fake URI shape:

```text
vless://00000000-0000-4000-8000-000000000000@home.example.invalid:<home-reality-port>?type=tcp&security=reality&pbk=FAKE_HOME_PUBLIC_KEY&sid=FAKE_SHORT_ID&sni=gateway.icloud.com&fp=safari#example-client
```

Never replace this fake example with a real URI in documentation.
