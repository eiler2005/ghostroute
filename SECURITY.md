# Security

GhostRoute is a single-operator routing project, not a public VPN service. The
security model is built around keeping production secrets out of git, limiting
router/VPS mutation paths and making recovery explicit.

## Protected Assets

- Ansible Vault data under `ansible/secrets/stealth.yml`.
- Generated client profiles, QR codes and URI payloads under `ansible/out/`.
- Reality private keys, public keys, short IDs, client UUIDs and admin paths.
- Real router/VPS hostnames, listener ports, SSH users and private bypass rules.
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

### Mitigations

| Scenario | Primary mitigation | Secondary / verification |
|---|---|---|
| ISP DPI / SNI fingerprinting | VLESS+Reality+Vision egress; cover SNI rotation guide; managed UDP/443 dropped to force TCP fallback | `traffic-report check`; `live-check --active-probe`; SNI rotation runbook |
| Mobile DNS observation | Home-first ingress + managed split → managed DNS over dnscrypt + Reality; `domains-no-vpn.txt` exceptions for apps that must stay direct | `dns-policy.md`; BrowserLeaks consistency review |
| Regulatory blocking | Reality cover SNI choice + L4 sharing on `:443`; Channel A/B/C protocol diversity | Reality SNI rotation guide; manual SNI cover override |
| Endpoint policy mistake | Layer 0 + Layer 2 redundancy: even without endpoint rules, router-side managed split applies | Per-device profile generation with explicit MANAGED/PROXY routing; OneXray/Shadowrocket settings checklist |
| Operator deploy mistake | Read-only safe checks before any mutating playbook; `secret-scan` pre-commit; safety tags before risky migrations | `verify.sh`, `secret-scan`, AGENTS.md safety rules, deploy gate |
| VPS provider takeover | Secrets in Vault; nothing operationally critical lives on the VPS that cannot be recreated; `GHOSTROUTE_DB_BACKUP_MODE` for Console state | Deploy gate detects edge mismatch; `traffic-report` shows VPS-vs-direct ratios |
| Vault loss | Encrypted offsite Vault backup runbook with periodic restore drill | [`modules/secrets-management/docs/vault-offsite-backup.md`](modules/secrets-management/docs/vault-offsite-backup.md) |
| Console exposure | Console listener on `127.0.0.1:3000`; non-443 HTTPS listener with Basic Auth + nginx + buffering proxy | `modules/ghostroute-console/vps/expose-caddy-readonly.yml`; do not co-host with Reality `:443` |
| Channel B/C isolation breach | Strict playbook ownership: `20-*` for A, `21-*` for B, `22-*` for C; `99-verify.yml` checks invariants; AGENTS.md hard rule | `verify.sh` channel invariant checks; `traffic-report check` |

### Out-of-scope risks

This project does **not** attempt to address:

- Endpoint compromise (malware, supply-chain, OS-level keylogging).
- Browser fingerprinting / behavioral correlation regardless of network path.
- Quantum-resistant cryptography or future cryptanalytic breaks of Reality.
- Active state-level traffic correlation with side-channels (timing, volume).
- Multi-operator authorization and role separation.
- High-availability VPS failover (the design is single-VPS by intent;
  semi-auto failover is on the backlog as `○ deferred`).
- Defending against a hostile control machine (the operator's laptop is
  trusted root).
- DDoS / volumetric attack mitigation on the home WAN or VPS.

### Acceptable risks

The operator explicitly accepts:

- Single-VPS, single-operator design — there is no automated failover.
- Local-only health alerts — there is no external paging (per
  [ADR-0003](docs/adr/0003-local-only-health-alerts.md)). One missed
  notification window is tolerable for this use case.
- Slow movement on protocol-fingerprinting advances — the SNI rotation
  guide is manual.
- Console DB drift up to 30 minutes (matches the data-pipeline lag budget;
  see [`docs/repo-review-2026-05-10.md`](docs/repo-review-2026-05-10.md)).

## Secrets Policy

- Keep real values in Ansible Vault or gitignored local files only.
- Use placeholders such as `<router_lan_ip>`, `<home-reality-port>` and
  `example.invalid` in tracked docs.
- Never commit generated QR images, VLESS URIs, client config files, real UUIDs,
  private keys, admin paths or production listener values.
- Run `./modules/secrets-management/bin/secret-scan` before pushing.
- Treat Channel B artifacts as production credentials for selected clients.
- Treat Channel C artifacts as planned compatibility credentials until promoted.

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

### Recovery scenarios and target times

| Scenario | Recovery path | Target time | Reference |
|---|---|---|---|
| Reality outage / VPS unreachable | Cold fallback via `emergency-enable-wgc1.sh` (manual only) | 5–15 min after operator decision | [`docs/architecture.md`](docs/architecture.md) §Cold fallback; [ADR-0004](docs/adr/0004-deprecated-wireguard-cold-fallback.md) |
| Vault loss | Restore from encrypted offsite backup; reissue Reality keys if backup compromised | 30 min restore + 1–2 h regenerate | [`modules/secrets-management/docs/vault-offsite-backup.md`](modules/secrets-management/docs/vault-offsite-backup.md) |
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
[modules/secrets-management/docs/vault-offsite-backup.md](/modules/secrets-management/docs/vault-offsite-backup.md).

## Reporting Issues

This is a personal operations repository. For private findings, do not open a
public issue containing endpoints, credentials, QR payloads, UUIDs, screenshots
of generated profiles or live traffic reports. Share only sanitized evidence
with placeholders.
