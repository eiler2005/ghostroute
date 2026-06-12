# Channel D Router-Native NaiveProxy Lab

Channel D is a selected-client home-first lane for Karing /
NaiveProxy-style clients against a router-native Caddy `forward_proxy@naive`
runtime. The current router runtime is operator live-proven with Karing over
LTE, but Channel D remains isolated from Channel C proof and ownership.

```text
Karing / NaiveProxy-style client
  -> home public host :4444
  -> ASUS router Caddy forward_proxy@naive
  -> local sing-box SOCKS inbound `channel-d-naiveproxy-socks-in`
  -> managed split
       managed destinations     -> reality-out -> active managed egress
       non-managed destinations -> direct-out via home WAN
```

Channel D is not Channel C proof. Channel C native proof still requires traffic
to enter `channel-c-naive-in`. Channel D has its own port, credentials, Caddy
runtime, client artifacts and deploy playbook.

## Runtime

- Default public endpoint: same home host as Channel C on TCP/4444, or another
  Channel D-only hostname in `vault_channel_d_naiveproxy_public_host`.
- The profile host must match the router TLS certificate SAN/CN. Do not put a
  raw public IPv4 in the Naive URL while reusing a hostname certificate unless
  the selected client also supports a separate TLS SNI/server-name override;
  Karing reports this as `cert common name invalid`.
- Router runtime: `/opt/bin/caddy-channel-d-naiveproxy` with
  `forward_proxy@naive`.
- Caddy upstream: `socks5://127.0.0.1:<channel-d-socks-port>`.
- Managed split owner: sing-box inbound `channel-d-naiveproxy-socks-in`.
- Generated client artifacts: `ansible/out/clients-channel-d/`.
- Trial Karing QR artifacts can be generated locally with
  `vault_channel_d_naiveproxy_profiles_enabled=true` even while router runtime
  `vault_channel_d_naiveproxy_enabled=false`.

The Caddy binary is built locally with:

```bash
./modules/routing-core/bin/build-channel-d-caddy
```

The router only receives the finished `linux/arm64` binary. Do not run generic
NaiveProxy install scripts on the router.

## Karing Artifacts

For an import-only Karing trial that does not use real endpoints or secrets:

```bash
cd ansible
ansible-playbook playbooks/30-generate-client-profiles.yml \
  --tags channel_d_clients_only \
  -e channel_d_naiveproxy_karing_trial_enabled=true
```

This writes a fake `example.invalid` profile named `karing-trial` so Karing QR
import can be tested without enabling Channel D or storing trial credentials.

For a real test profile, keep the Karing client in Vault:


```yaml
vault_channel_d_naiveproxy_profiles_enabled: true
vault_channel_d_naiveproxy_clients:
  - name: karing-trial
    username: <channel-d-karing-user>
    password: <channel-d-karing-password>
```

Then generate only Channel D artifacts:

```bash
cd ansible
ansible-playbook playbooks/30-generate-client-profiles.yml --tags channel_d_clients_only
```

The generator writes raw `naive+https://...` text files, Karing
`install-config` text files, and PNG QR files under
`ansible/out/clients-channel-d/`. The QR is for Karing import and is separate
from the router deployment; it becomes usable only after Channel D runtime is
enabled with matching Vault credentials.

Raw Channel D import URLs include a fragment remark:

```text
naive+https://<user>:<pass>@<host>:4444#<client-name>-channel-d
```

Keep the fragment when copying a text URI manually; clients that preserve
single-node share names can use it as the node label.

For Karing's separate profile `Remark` field, the QR encodes a Karing deep link
instead of the raw node URL:

```text
karing://install-config?url=<encoded-naive-url>&name=<client-name>-channel-d
```

Use the iOS Camera/Safari deep-link flow for the QR. Karing's in-app QR scanner
passes scanned text directly into `Add Profile Link`; when using that flow,
copy the raw Naive URL and set `Remark` to `<client-name>-channel-d` manually.

## Known Console Gap

GhostRoute Console was not updated for Channel D in this rollout. Channel D has
router runtime, Ansible verification, CLI status, generated client artifacts and
docs, but the Console does not yet expose Channel D as a first-class lane with
D-specific Caddy state, client/QR inventory, proof labels or traffic
attribution. Until that follow-up is implemented, use `99-verify.yml`,
`verify.sh --verbose`, `router-health-report` and router logs for Channel D
proof.

## Deploy And Rollback

Channel D is disabled by default. Enable it only with explicit Vault values and
the dedicated playbook:

```bash
cd ansible
ansible-playbook playbooks/24-channel-d-router.yml
```

Rollback is setting `vault_channel_d_naiveproxy_enabled=false` and rerunning the
same playbook. The role stops the Caddy service, removes the services-start
bootstrap block, and `stealth-route-init.sh` removes stale Channel D firewall
rules.

## Proof Signals

- Managed domains produce `channel-d-naiveproxy-socks-in -> reality-out`.
- Non-managed destinations produce `channel-d-naiveproxy-socks-in -> direct-out`.
- The mobile carrier sees the home endpoint first, not the VPS.
