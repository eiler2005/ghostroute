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

GhostRoute is designed to reduce accidental leaks and operational mistakes:

- public git history should contain implementation logic and placeholders only;
- selected managed traffic should use the intended Reality/Vision egress;
- health and reporting tools should be read-only unless explicitly documented;
- Channel B must stay isolated from Channel A REDIRECT, DNS, TUN and recovery
  ownership;
- Channel C must stay outside production health until it has its own live proof.

This does not claim immunity from provider outages, targeted endpoint compromise,
malware on client devices, future protocol fingerprinting or loss of the Vault
password.

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
