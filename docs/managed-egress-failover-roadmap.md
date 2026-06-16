# Managed Egress Failover And Reserve Egress

Status: implemented manual reserve mode, with semi-automatic failover still a
future phase.

## Summary

GhostRoute normally has one owned production managed foreign egress: router
`sing-box` sends managed destinations through the stable logical
`reality-out` tag to the primary VPS. If that VPS path becomes unavailable, the
router-managed path for foreign managed domains can fail even though the home
router, LAN and direct home-WAN traffic are still healthy.

The implemented v1 reserve mode keeps the router as policy owner and changes
only the backend rendered behind `reality-out`:

```text
Home LAN / Home Reality / Channel B / Channel C
  -> home router
  -> existing managed split
       managed destinations     -> reality-out -> active managed egress
       non-managed destinations -> direct-out via home WAN
```

The router remains the policy owner. `STEALTH_DOMAINS` and `VPN_STATIC_NETS`
continue to define what is managed; reserve mode only changes which foreign
egress is used for managed traffic.

## Public Mnemonic Contract

Tracked docs, commit messages and issue text must name managed egress backends
only by mnemonic role: `primary_vps`, `backup_reality`, `hermes_vps` or a future
role-style name. Do not publish the real provider, ASN, account, host family,
endpoint, SNI, IP, key material or the role-to-provider mapping. Those values
belong in Ansible Vault or gitignored operator notes.

## Implemented Manual Reserve Mode

Ansible now renders the router `sing-box` `reality-out` outbound from one of
three sources:

```text
router_managed_egress_mode=primary_vps
  -> owned VPS Reality/Vision backend

router_managed_egress_mode=backup_reality
  -> Vault-backed router-only VLESS/Reality backup profile

router_managed_egress_mode=hermes_vps
  -> owned clone VPS Reality/Vision backend
```

Current operating stance:

```text
active managed egress = backup_reality
primary VPS           = observed recovery candidate, not active switchback target
Hermes VPS            = owned clone candidate, selected manually when proven
```

This means the mnemonic reserve backend is the working managed egress for now.
The owned VPS remains the preferred long-term egress, but it should not be
restored as active until primary path checks prove that router -> primary
TLS/SNI/Reality traffic is no longer filtered or blackholed.

The first live reserve profile is a backup VLESS/Reality profile dedicated
to the router. This is an availability reserve, not a replacement for the owned
VPS architecture. The route contract is intentionally unchanged: LAN/Wi-Fi,
Home Reality, Channel B and Channel C still route managed destinations to
`reality-out`; client profiles do not change.

Backup mode uses `router_backup_dns_mode: cover_dns` by default so the router
does not depend on the primary VPS Unbound path while the primary VPS path is
suspect. This is availability-first emergency behavior; resolver geography may
be less tidy than normal primary mode.

Vault variables:

```yaml
vault_router_managed_egress_mode: "primary_vps"   # or "backup_reality", "hermes_vps"
vault_router_backup_dns_mode: "cover_dns"         # or "managed_vps_dns"
vault_router_backup_reality_server: "<backup_reality_host_or_ip>"
vault_router_backup_reality_server_port: 443
vault_router_backup_reality_uuid: "<router_only_uuid>"
vault_router_backup_reality_flow: "xtls-rprx-vision"
vault_router_backup_reality_packet_encoding: "xudp"
vault_router_backup_reality_server_name: "<backup_reality_sni>"
vault_router_backup_reality_utls_fingerprint: "chrome"
vault_router_backup_reality_public_key: "<backup_reality_public_key>"
vault_router_backup_reality_short_id: "<backup_reality_short_id>"
vault_router_hermes_dns_mode: "managed_vps_dns"   # or "cover_dns"
vault_router_hermes_vps_host: "<hermes_public_reality_host_or_ip>"
vault_router_hermes_vps_port: 443
vault_router_hermes_vps_server_name: "<hermes_reality_sni>"
vault_router_hermes_vps_utls_fingerprint: "chrome"
vault_router_hermes_vps_unbound_target_host: "172.22.0.1"
vault_router_hermes_vps_unbound_port: 15353
vault_router_hermes_vps_ssh_host: "<hermes_ssh_host_or_ip>"
vault_router_hermes_vps_ssh_user: "<hermes_ssh_user>"
vault_router_hermes_vps_ssh_port: 22
vault_router_hermes_vps_ssh_key: "<path_to_hermes_ssh_private_key>"
```

Do not store the original provider URI or role mapping in tracked files. Keep the
generated reserve profile in Vault or another gitignored secret store, and keep it
router-only.

Quick switch cheatsheet (one selector for the shared Channel A/B/C `reality-out`
upstream; Channel D and Channel M are never switched here):

| Goal | Backend | Command |
|---|---|---|
| Normal owned VPS | `primary_vps` | `managed-egress-mode set primary_vps --deploy-router` |
| Incident reserve | `backup_reality` | `managed-egress-mode set backup_reality --deploy-router` |
| Owned clone backend | `hermes_vps` | `managed-egress-mode set hermes_vps --deploy-router` |
| Canary Hermes on Channel D only | `hermes_vps` (D) | `managed-egress-mode set hermes_vps --channel d --deploy-router` |
| Return Channel D to shared backend | `follow` (D) | `managed-egress-mode set follow --channel d --deploy-router` |
| Show active backends (A/B/C + D) | — | `managed-egress-mode status` |
| Verify after a switch | — | `managed-egress-check` then `live-check --active-probe channel-a` |

The optional `--channel d` selector pins **Channel D** to its own backend behind
`reality-out-d`, independent of A/B/C (which stay on `reality-out`). Default is
`follow` (D = A/B/C). This is the canary path: validate a new owned backend on
isolated Channel D traffic before moving A/B/C. Channel D deploys via
`24-channel-d-router.yml`; Channel M is still never switched here.

`set` without `--deploy-router` only updates the Vault selector (with an encrypted
backup) so you can review before rendering the router config. The same one active
backend serves Channel A LAN/Wi-Fi/Home Reality, Channel B and Channel C; client
QR/VLESS artifacts, ingress ports and managed catalogs never change.

During a real incident the live-check deploy gate will normally be WARN (suspect
primary path, idle Channel B/C, Console collector against the down primary), and a
plain `--deploy-router` will refuse to apply. Add `--skip-deploy-gate` to force the
emergency switch, then re-check with `managed-egress-check` and
`live-check --active-probe channel-a`:

```bash
./modules/routing-core/bin/managed-egress-mode set backup_reality --deploy-router --skip-deploy-gate
```

Operator activation flow:

```bash
./modules/routing-core/bin/managed-egress-mode status
./modules/routing-core/bin/managed-egress-mode set backup_reality --deploy-router
./modules/ghostroute-health-monitor/bin/live-check --active-probe channel-a
```

Operator return to primary:

```bash
./modules/routing-core/bin/managed-egress-mode set primary_vps --deploy-router
./modules/ghostroute-health-monitor/bin/live-check --active-probe channel-a
```

During incident recovery, run the live check before and after a switch. If the
post-switch check fails, restore the previous mode with
`managed-egress-mode set <previous_mode> --deploy-router`. The helper edits only
`vault_router_managed_egress_mode`, saves an encrypted Vault backup and never
generates client QR/VLESS artifacts.

The current operator check for this layer is:

```bash
./modules/ghostroute-health-monitor/bin/managed-egress-check
./modules/ghostroute-health-monitor/bin/managed-egress-check --json
./modules/ghostroute-health-monitor/bin/egress-backend-health
./modules/ghostroute-health-monitor/bin/egress-backend-health --json
```

`managed-egress-check` compares primary and active managed egress reachability
without printing real hosts, IPs or provider names. `egress-backend-health`
prints the backend bank (`primary_vps`, `backup_reality`, `hermes_vps`) using
Vault references only, treats inactive TCP/TLS checks as advisory, and uses
active app canaries as the canonical live proof.

## Live Managed Egress Switching Model

`reality-out` is the stable router-side contract. The active backend can change
without changing endpoint profiles, QR artifacts, Channel A/B/C ingress ports,
dnsmasq catalogs, ipsets or route rules:

```text
STEALTH_DOMAINS / VPN_STATIC_NETS
  -> router managed split
  -> reality-out
  -> active backend selected by Vault + Ansible
```

This is intentionally a live operator switch, not automatic failover. The
procedure is:

```bash
./modules/routing-core/bin/managed-egress-mode set hermes_vps --deploy-router
./modules/ghostroute-health-monitor/bin/managed-egress-check
./modules/ghostroute-health-monitor/bin/live-check --active-probe channel-a
```

Future managed egress backends can use the same pattern if they can be rendered
behind the logical `reality-out` tag and prove application canaries. This should
not be confused with Channel B or Channel C failover: B/C are ingress lanes for
selected clients, while this switch changes only the upstream managed egress
after the router has already made the managed-vs-direct decision.

Channel D and Channel M stay outside this helper. Channel D has router-native
ingress/runtime pieces, and Channel M uses its own home-WAN reverse model.

## Owned Clone Egress Candidate

For a second owned VPS candidate, such as a freshly prepared host from the
operator's VPS-management inventory, do not copy the old server filesystem or
generate new global Reality material by accident. Deploy the GhostRoute VPS edge
with the existing `reality_server_private_key`, `reality_short_ids` and router
client UUIDs, and set:

```yaml
xray_reality_seed_existing_material: true
xray_reality_persist_generated_secrets: false
stealth_caddy_mode: docker_sidecar
```

Hermes uses a deterministic Docker bridge for restricted resolver access:
Unbound listens on loopback and `172.22.0.1:15353`, while router DNS queries to
Hermes travel through the selected VLESS/Reality egress and target that bridge
address. Do not bind Unbound to the public VPS address.

This seeds the new VPS with a compatible `stealth-reality` inbound without
rewriting `ansible/secrets/stealth.yml`. Do not regenerate QR or VLESS client
artifacts for this operation: endpoint clients keep their existing first-hop
profiles, while the router changes only the upstream backend behind
`reality-out`. After the candidate proves Telegram and general application
canaries, switch `vault_router_managed_egress_mode` to `hermes_vps` manually.
Keep this as an operator-selected backend; do not add automatic failover without
separate design and tests.

## Primary VPS Path Recovery Checks

While backup mode is active, keep checking whether the owned VPS path has
recovered before switching back:

```bash
# Control machine: SSH/API reachability to the VPS.
cd ansible
ansible vps_stealth -e @secrets/stealth.yml -m ping

# VPS: Caddy and Xray are alive.
ansible vps_stealth -e @secrets/stealth.yml -b -m shell -a \
  'systemctl is-active caddy && docker ps --format "{{.Names}}" | grep -E "^xray$"'

# VPS: recent layer4 matching timeouts from the home router should stop.
ansible vps_stealth -e @secrets/stealth.yml -b -m shell -a \
  'journalctl -u caddy --since "15 minutes ago" --no-pager | grep -E "layer4|aborted matching" | tail -40 || true'

# Router: direct TCP/TLS to the primary VPS cover endpoint should complete.
# Use placeholders; do not paste the real endpoint into docs or tickets.
source modules/shared/lib/router-health-common.sh
router_ssh 'curl -k --connect-timeout 5 --max-time 12 \
  --resolve <cover-sni>:443:<primary-vps-ip> https://<cover-sni>/ \
  -o /dev/null -sS -w "code=%{http_code} app=%{time_appconnect} total=%{time_total}\n"'
```

Switch back only after the primary path has repeated positive evidence and the
normal `live-check --active-probe channel-a` passes after a primary-mode deploy.

## Provider / Path Blocking Probe Matrix

When managed traffic is healthy on backup but primary remains suspect, compare
the paths instead of restarting services repeatedly.

Primary checks:

```text
VPS local TLS to Caddy cover endpoint        -> proves Caddy/layer4 is alive
control machine TLS to primary cover endpoint -> tests one non-home internet path
router plain HTTP to primary :443             -> proves TCP/payload can pass
router TLS to primary cover endpoint          -> tests the failing Reality-like layer
VPS Caddy layer4 timeout logs from home IP    -> confirms ClientHello/SNI is not matched
```

Interpretation:

```text
VPS local TLS OK
router plain HTTP :443 OK
router TLS cover probe timeout
recent Caddy layer4 matching timeouts from home
```

This pattern points away from an Xray/Caddy service outage and toward path/DPI
filtering of TLS/Reality-like traffic between the home router and the primary
VPS endpoint.

Backup checks:

```text
managed-egress-check
live-check --active-probe channel-a
curl through router SOCKS 127.0.0.1:<router-socks-port> to managed canaries
router sing-box config still has only the normal production inbounds
```

Optional router diagnostic packages:

```sh
/opt/bin/opkg install openssl-util ncat
```

After that, `/opt/bin/ncat -z -w 5 <host> <port>` is useful as a generic TCP
connect probe and `/opt/bin/openssl s_client -connect <host>:<port> -servername
<sni> -brief` can test an ordinary TLS/SNI handshake. Do not overinterpret a
raw TLS failure against a Reality provider endpoint: some endpoints close
non-client handshakes by design. Treat the real application path through router
`sing-box` as the canonical backup proof unless a dedicated backup probe tool is
added later.

## Future Target

- Add a second managed outbound on the router. The long-term owned target is a
  backup `VLESS + Reality/Vision` VPS, but the first practical v1 candidate is
  an external backup `VLESS/Reality` profile if the router's `sing-box` accepts it.
- Keep the current primary VPS as the normal default egress.
- Prefer a backup VPS with independent infrastructure from the primary owned
  backend for the long-term owned target; keep the provider/ASN mapping private.
- Use the existing router health-monitor model as the decision source, because
  the router is the system that actually experiences "primary VPS unavailable".
- Keep failover semi-automatic with a latch: once backup is selected, stay on
  backup until the operator explicitly returns to primary.

Recommended logical shape:

```text
reality-primary -> current primary VPS
reality-backup  -> backup managed egress, initially external backup VLESS/Reality
reality-out     -> stable logical managed-egress tag used by route rules
```

The exact sing-box implementation can use a selector, generated active tag or a
small controlled config switch, but the operator-facing contract should be the
same: one active managed egress at a time, with explicit state and rollback.

## Concrete V1 Direction: External Backup VLESS/Reality

The first implementation plan should evaluate an external backup `VLESS/Reality`
profile as the fastest backup egress candidate. This is not the final owned
architecture, but it can prove the router-side failover logic before
provisioning and operating a second owned VPS.

Protocol choice:

- Prefer external backup `VLESS/Reality` over AmneziaWG, WireGuard, OpenVPN,
  AmneziaWG legacy and PPTP for v1.
- Reason: VLESS-like client profiles map naturally to router `sing-box`
  outbounds, while WireGuard/OpenVPN-style options would reintroduce kernel VPN
  interfaces, policy-routing state and rollback risks that GhostRoute already
  retired from steady state.
- The backup profile must be dedicated to the router. Do not reuse the same
  reserve configuration on phones, laptops or other clients.

Router logic target:

- Keep the route contract stable: managed rules still point to `reality-out`.
- Add `reality-primary` for the current VPS and `reality-backup` for the backup
  reserve profile. If the backup transport is not Reality, the tag is still a
  compatibility name for the existing routing contract, not a claim about the
  transport protocol.
- Add local-only probe paths for both egresses so the router can test primary
  and backup without moving production traffic first.
- The controller may switch only after repeated primary failures and positive
  backup proof. First thresholds remain:

```text
primary_fail_count >= 3
backup_success_count >= 2
switch mode = latch
auto-return = disabled
```

- After switching to backup, the controller records a latch state. Return to
  primary is manual only.
- If both primary and backup are unhealthy, do not switch blindly; emit a
  critical alert and preserve the current state.

Operator surface:

- Future router command shape:
  `/jffs/scripts/managed-egress-failover status|dry-run|switch-backup|switch-primary|run-controller`.
- Future state directory:
  `/jffs/addons/router_configuration/managed-egress/state`.
- `dry-run` must explain the decision evidence without mutating `sing-box`,
  dnsmasq or firewall state.

Secrets and public docs:

- Store backup URI/profile material only in Ansible Vault or another
  gitignored secret store.
- Public docs must use placeholders and mnemonic roles only. Do not commit real
  hostnames, UUIDs, short IDs, keys, ports, subscription URLs, generated VLESS
  URIs, provider/ASN details, account identifiers or role mappings.
- Prefer an IP literal or cached last-known-good address for the backup server
  during probes so failover does not depend on DNS that may currently be routed
  through the failed primary path.

## Monitoring And Switch Criteria

Primary failure should require repeated evidence, not one transient timeout:

- primary active proxy/curl check fails repeatedly;
- router cannot open or use the primary Reality path;
- no recent successful primary `reality-out` traffic evidence exists;
- local router `sing-box` and home WAN are not the real fault.

Backup activation should require positive proof:

- backup VPS TCP/443 is reachable from the router;
- backup Reality exit probe succeeds;
- a managed canary such as `api.ipify.org` exits through the backup path.

Recommended first thresholds:

```text
primary_fail_count >= 3
backup_success_count >= 2
switch mode = latch
auto-return = disabled
```

If both primary and backup are unhealthy, the router must not switch blindly.
It should keep a clear critical alert and avoid hiding the incident behind a
partial recovery attempt.

## DNS Emergency Policy

Backup mode is an availability mode. Its first goal is that managed services
such as YouTube continue to work, not that BrowserLeaks fingerprinting remains
perfect.

For v1:

- do not expose public DNS on the backup VPS;
- do not open public `53/tcp`, `53/udp` or an unrestricted resolver port;
- use availability-first DNS in backup mode, so managed DNS does not depend on
  the primary VPS Unbound path while the primary VPS is the suspected fault;
- allow DNS consistency to be imperfect during an emergency if that keeps
  internet access working;
- treat private backup DNS over the backup Reality path as a later optional
  phase, not as a v1 requirement.

This deliberately differs from normal policy-split DNS, where managed foreign
domains try to use a consistent VPS-side DNS path. During backup incidents,
availability is allowed to win over resolver geography cleanliness.

Implementation implication for v1: switching to backup should temporarily
demote or empty the generated managed-VPS-DNS include and restart dnsmasq, then
restore the normal generated include during manual switchback to primary.

## Non-Goals

- Do not make Channel B or Channel C automatic fallbacks for Channel A.
- Do not resurrect legacy WireGuard as a normal runtime path.
- Do not implement full automatic return to primary; avoid flapping.
- Do not open a public DNS resolver on the backup VPS.
- Do not move managed-vs-direct policy from the router to endpoint profiles.
- Do not treat this as a replacement for the existing home-first channel model.
- Do not commit or paste real backup account, subscription or VLESS profile
  details into tracked docs, tests, commits or chat transcripts.

## Future Implementation Phases

1. Document and store backup profile material outside git. Done for
   manual reserve mode.
2. Validate that the router `sing-box` version accepts the backup
   `VLESS (XTLS)` profile shape. If not, stop and reassess Xray sidecar or an
   owned second VPS. Done for the first router-only profile.
3. Add router-side backup outbound rendering while keeping managed split rules
   unchanged. Done for manual `backup_reality` mode.
4. Extend health monitor probes for primary and backup egress evidence.
5. Add a dry-run switch report that explains whether failover would happen.
6. Add the latched semi-auto switch command and explicit manual switchback.
7. Add availability-first backup DNS handling.
8. Run a live drill by blocking the primary VPS path and confirming backup
   managed egress without changing direct/RU/default traffic.
9. Later, if desired, replace or supplement `backup_reality` with an owned
   second `VLESS + Reality/Vision` VPS on independent infrastructure.

## Acceptance Scenarios

- Primary healthy: managed traffic uses the primary VPS.
- Primary down and `backup_reality` healthy: managed traffic switches to
  backup.
- Primary and backup down: no unsafe switch; clear critical alert is emitted.
- Direct, RU and default traffic remain on home WAN unless explicitly managed.
- Backup mode remains active until a manual switchback.
- Verification confirms no Channel B/C automatic failover and no WireGuard
  resurrection.
- Backup DNS mode does not depend on primary VPS Unbound and is restored during
  manual switchback to primary.

## Future Test Plan

When implementation starts, add focused static and fixture tests for:

- `sing-box` outbound tags: `reality-primary`, `reality-backup` and stable
  logical `reality-out`;
- unchanged managed/direct split for LAN, Home Reality, Channel B and Channel C;
- no `wgs1`, `wgc1`, `RC_VPN_ROUTE`, `VPN_DOMAINS` or `0x1000` resurrection;
- backup DNS mode demoting only the generated managed-VPS-DNS include, not the
  source catalogs;
- failover latch behavior, dry-run verdicts, both-down behavior and manual
  switchback.

## Related Docs

- [architecture.md](architecture.md)
- [channels.md](channels.md)
- [dns-policy.md](dns-policy.md)
- [future-improvements-backlog.md](future-improvements-backlog.md)
- [routing-policy-principles.md](routing-policy-principles.md)
