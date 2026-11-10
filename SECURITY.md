# Security

GhostRoute is a single-operator routing project, not a public VPN service. The
security model is built around keeping production secrets out of git, limiting
router/VPS mutation paths and making recovery explicit.

## Protected Assets

- Ansible Vault data under `ansible/secrets/stealth.yml`.
- Generated client profiles, QR codes and URI payloads under `ansible/out/`.
- Reality private keys, public keys, short IDs, client UUIDs and admin paths.
- Real router/VPS hostnames, listener ports, SSH users and private bypass rules.
- Managed egress provider identity, ASN, account details, host family, endpoint
  metadata and any mapping from public backend roles to real infrastructure.
- Local reports that may reveal device names, traffic patterns or private
  network layout.

## Threat Model

GhostRoute is designed to reduce accidental leaks and operational mistakes
within a single-operator threat envelope. The threat model below names the
specific scenarios it does and does not address.

### Threat scenarios in scope

1. **ISP DPI / SNI fingerprinting on the home WAN.** Mobile / domestic ISP
   DPI inspecting plaintext SNI on managed traffic from home devices.
2. **Mobile-operator DNS observation.** LTE / Wi-Fi calling provider seeing
   managed DNS lookups from a remote endpoint.
3. **Regulatory blocking (e.g. RKN-class).** State-level blocklists targeting
   public protocols, common Western SNIs, or specific ranges.
4. **Endpoint policy mistake / leak.** Client app configured to route
   managed traffic outside the intended channel (DIRECT instead of MANAGED,
   or wrong channel selected).
5. **Operator mistake during deploy.** Misapplied playbook, accidental
   commit of secrets, or a runtime change that re-enables legacy
   `VPN_DOMAINS` / `RC_VPN_ROUTE` / `wgs1` / `wgc1` paths.
6. **VPS provider takeover / tampering.** VPS host seized, console-level
   reset, or replaced by a different operator.
7. **Vault loss.** Lost or rotated Ansible Vault password preventing access
   to deploy credentials and Reality keys.
8. **Console exposure.** GhostRoute Console accidentally exposed to the
   public internet without Basic Auth, or with weak / leaked credentials.
9. **Channel B/C isolation breach.** A change to a B or C playbook silently
   mutating Channel A REDIRECT, DNS, TUN, or recovery ownership.
10. **Home ingress impersonation.** An active network intermediary substitutes
    a TLS server for a selected client that does not authenticate its peer.

### Mitigations

| Scenario | Primary mitigation | Secondary / verification |
|---|---|---|
| ISP DPI / SNI fingerprinting | VLESS+Reality+Vision egress; cover SNI rotation guide; managed UDP/443 dropped to force TCP fallback | `traffic-report check`; `live-check --active-probe`; SNI rotation runbook |
| Managed LAN direct fallthrough | First `FORWARD` guard drops direct IPv4 TCP and UDP/443 to already classified managed destinations; dynamic ipset snapshots are saved atomically | [Privacy assurance checks](docs/privacy-assurance.md); guard fixtures; real-client exit proof |
| Mobile DNS observation | Home-first ingress + managed split → managed DNS over dnscrypt + Reality; `domains-no-vpn.txt` exceptions for apps that must stay direct | `dns-policy.md`; BrowserLeaks consistency review |
| Regulatory blocking | Reality cover SNI choice + L4 sharing on `:443`; Channel A/B/C protocol diversity | Reality SNI rotation guide; manual SNI cover override |
| Endpoint policy mistake | Layer 0 + Layer 2 redundancy for destinations the router can classify; selected full-VPS profiles cover a wider device scope | Per-device profile review and [real-client checks](docs/privacy-assurance.md) |
| Accidental sensitive browsing on Mac | [GhostRoute Guard](modules/mac-privacy-guard/docs/strict-mode.md): qualified mandatory proxy for ordinary Chrome's sensitive catalog, DNR deny and per-agent gate, plus optional dedicated browser | Requires Chrome proxy/privacy ownership and reviewed catalog coverage. Unknown third-party/RTC endpoints outside the catalog can use the ordinary network; external settings override and disabled extensions are outside an atomic OS guarantee. Scoped HTTP previews remain sensitive volatile data |
| Operator deploy mistake | Read-only safe checks before any mutating playbook; `secret-scan` pre-commit; safety tags before risky migrations | `verify.sh`, `secret-scan`, AGENTS.md safety rules, deploy gate |
| VPS provider takeover | Role-scoped credentials, operator router key kept off the VPS, application HTTPS and a trusted rebuild/revocation path | A compromised VPS can observe egress metadata and access its own runtime secrets; health checks do not prove a host is trustworthy |
| Vault loss | Independent encrypted backup plus separately recoverable decryption credentials and periodic restore drill | [`modules/secrets-management/docs/vault-offsite-backup.md`](modules/secrets-management/docs/vault-offsite-backup.md) |
| Console exposure | Loopback app listener; dedicated authenticated HTTPS proxy, with the optional shared HTTPS alias subject to the same HTML/API authentication boundary | Console delivery runbook and public-path auth checks; immutable assets and browser metadata are public |
| Channel B/C isolation breach | Strict playbook ownership: `20-*` for A, `21-*` for B, `22-*` for C; `99-verify.yml` checks invariants; AGENTS.md hard rule | `verify.sh` channel invariant checks; `traffic-report check` |

### Known assurance boundaries

The home-first Channel B URI generator currently emits `allowInsecure=1`.
On clients honoring this option, the tunnel lacks normal TLS server-certificate
authentication. An active intermediary can impersonate the ingress; passive
observation alone does not decrypt it. Application HTTPS has its own independent
certificate checks. A pinned Mac diagnostic is not proof that imported phone
profiles validate the server. Track the client-compatible migration and negative
certificate test in [RA-02](docs/routing-assurance-roadmap.md#ra-02--аутентификация-сервера-channel-b);
do not remove the option or regenerate imports without the profile migration
approval required by AGENTS.md.

Local archive checks, cloud upload and full downloaded restore proof are distinct
evidence levels. Keep exact status in private reports and use the
[engineering register](docs/routing-assurance-roadmap.md) for remaining work.
No current diagram or health result implies universal leak protection, anonymity
or a tested full-device restore.

### Out-of-scope risks

This project does **not** attempt to address:

- Endpoint compromise (malware, supply-chain, OS-level keylogging).
- Browser fingerprinting / behavioral correlation regardless of network path.
- Classification of unknown or hidden destinations before they enter the managed
  ipsets; app-owned encrypted DNS and non-443 UDP need separate client evidence.
- Quantum-resistant cryptography or future cryptanalytic breaks of Reality.
- Active state-level traffic correlation with side-channels (timing, volume).
- Multi-operator authorization and role separation.
- Automatic high-availability VPS failover. Alternate egress roles are selected
  manually; semi-automatic failover remains deferred.
- Defending against a hostile control machine (the operator's laptop is
  trusted root).
- DDoS / volumetric attack mitigation on the home WAN or VPS.

### Acceptable risks

The operator explicitly accepts:

- Single-operator design with no automated egress failover.
- Local-only health alerts — there is no external paging (per
  [ADR-0003](docs/adr/0003-local-only-health-alerts.md)). One missed
  notification window is tolerable for this use case.
- Slow movement on protocol-fingerprinting advances — the SNI rotation
  guide is manual.
- Console DB drift up to 30 minutes (matches the data-pipeline lag budget;
  see [`docs/repo-review-2026-05-10.md`](docs/repo-review-2026-05-10.md)).

## Secrets Policy

- Keep real values in Ansible Vault or gitignored local files only.
- Keep operator and Console router credentials distinct. The operator key stays
  on the control Mac; the VPS service key is constrained by the router's fixed
  report gate, with forwarding disabled. Retire an earlier shared key only
  after proving replacement access and collector freshness. See
  [the migration runbook](docs/console-router-ssh-access.md).
- Public managed-egress references must use mnemonic backend roles only:
  `primary_vps`, `backup_reality`, `hermes_vps` and future role-style names.
  Do not publish the real provider, ASN, host family, account, endpoint, SNI or
  role-to-provider mapping.
- Use placeholders such as `<router_lan_ip>`, `<home-reality-port>` and
  `example.invalid` in tracked docs.
- Never commit generated QR images, VLESS URIs, client config files, real UUIDs,
  private keys, admin paths or production listener values.
- Run `./modules/secrets-management/bin/secret-scan` before pushing.
- Treat Channel B artifacts as production credentials for selected clients.
- Treat enabled C1-Shadowrocket artifacts as live compatibility credentials;
  native C artifacts still require compatible-client acceptance.
- Treat Channel D artifacts and local Caddy binaries as experimental local
  credentials/artifacts; keep them gitignored.
- Treat Channel Amn settings, QR imports and build output as private lab
  material under ignored `ansible/out/channel-amn/`. Each of its eight client
  slots has separate credentials; preserve slot 01 during additive export and
  keep the full bundle in an encrypted local backup.

Channel Amn is a manual home-first compatibility lab, not a replacement for the
production supervisors. It blocks raw peer forwarding outside its policy TUN,
keeps router/LAN management closed to the peer and retains a terminal unreachable
guard when the TUN disappears. Reboot or firewall rebuild requires manual
recovery. Its AWG2 client proof, eight configured slots and bounded resource gate
do not establish AWG 3.1 compatibility, concurrent capacity or immunity to UDP
blocking. See the [lab runbook](modules/routing-core/docs/channel-amn-research.md).

## Recovery Boundaries

Repo-only CI checks syntax, fixture behavior and secret hygiene. It intentionally
does not require Vault access, router access, VPS access or generated client
profiles.

Live recovery and validation are operator tasks:

```bash
./verify.sh --verbose
cd ansible && ansible-playbook playbooks/99-verify.yml
cd ..
./modules/ghostroute-health-monitor/bin/router-health-report
./modules/traffic-observatory/bin/traffic-report today
```

Before any broad mutating playbook, confirm that deploy-critical Vault values
are present and that read-only verification is green enough for the intended
change.
The [privacy assurance contract](docs/privacy-assurance.md) separates router
configuration checks from real-client exit and DNS evidence, and describes the
narrow firewall recovery drill.

### Recovery scenarios and target times

These are planning targets, not measured guarantees for every deployment. A lost
Vault password cannot be recovered from the encrypted Vault archive alone.

| Scenario | Recovery path | Target time | Reference |
|---|---|---|---|
| Reality outage / VPS unreachable | Cold fallback via `emergency-enable-wgc1.sh` (manual only) | 5–15 min after operator decision | [`docs/architecture.md`](docs/architecture.md) §Cold fallback; [ADR-0004](docs/adr/0004-deprecated-wireguard-cold-fallback.md) |
| Vault loss | Restore from encrypted independent backup with separately recovered password; rotate affected credentials if compromised | 30 min restore + 1–2 h regenerate | [`modules/secrets-management/docs/vault-offsite-backup.md`](modules/secrets-management/docs/vault-offsite-backup.md) |
| Console DB corruption | Quarantine `data/ghostroute.db*`; restart with empty DB; collector re-populates within minutes; use external host-level backups for durable restore | <30 min to baseline data; full 7-day backfill on next normal cycle | `vps/deploy-readonly.yml`; `GHOSTROUTE_DB_BACKUP_MODE=local_daily` only when same-disk copies are explicitly accepted |
| Channel B/C ingress regression | Revert with `git revert`; rerun `21-*` or `22-*` playbook; verify with `99-verify.yml` | <15 min for revert; A/B/C invariants checked by verify | `AGENTS.md` §Architecture Invariants |
| Routing drift (`VPN_DOMAINS` / `RC_VPN_ROUTE` reappear) | Investigate root cause; re-run `20-stealth-router.yml`; never silently mask with cold fallback | Same change-window as the regression | `verify.sh`; `tests/run-fast.sh` |
| Lost SSH key to router | Recover via remote SSH endpoint (`secrets/router.env`) or LAN console; rotate `secrets/router-remote-ssh/` | <30 min if remote endpoint reachable | README §Operator Router Access |

Anything that automatically toggles legacy WireGuard, VPN_DOMAINS or
`RC_VPN_ROUTE` violates these boundaries and must be removed, not just
worked around.

## Vault Backup

Vault loss is a critical operational risk. Keep an encrypted offsite backup and
periodically test restore without touching production runtime. The runbook lives
at
[modules/secrets-management/docs/vault-offsite-backup.md](modules/secrets-management/docs/vault-offsite-backup.md).

## Reporting Issues

This is a personal operations repository. For private findings, do not open a
public issue containing endpoints, credentials, QR payloads, UUIDs, screenshots
of generated profiles or live traffic reports. Share only sanitized evidence
with placeholders.
