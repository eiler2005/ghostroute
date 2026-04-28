# Vault Offsite Backup Runbook

This runbook protects against the highest-impact local failure mode: losing or
corrupting `ansible/secrets/stealth.yml` while the live router/VPS still depend
on the values inside it.

## Policy

- Keep exactly one current encrypted offsite copy outside the repo working tree.
- Store it on an encrypted USB drive, a trusted password manager attachment, or
  another encrypted personal backup location.
- Do not store the Vault password next to the backup file.
- Do not commit backup files, decrypted Vault files, generated client profiles
  or recovery notes with real endpoints.
- After meaningful credential rotation, refresh the offsite copy the same day.

## Create Or Refresh Backup

Run from the repo root on the control machine:

```bash
test -f ansible/secrets/stealth.yml
mkdir -p <encrypted-backup-dir>/ghostroute
cp ansible/secrets/stealth.yml <encrypted-backup-dir>/ghostroute/stealth.yml
shasum -a 256 ansible/secrets/stealth.yml
shasum -a 256 <encrypted-backup-dir>/ghostroute/stealth.yml
```

The two hashes must match. Record the date and hash in a private notes location,
not in tracked docs.

## Restore Drill Without Router Access

Use a temporary directory outside the repo:

```bash
mkdir -p <tmp-restore-dir>
cp <encrypted-backup-dir>/ghostroute/stealth.yml <tmp-restore-dir>/stealth.yml
ANSIBLE_CONFIG=ansible/ansible.cfg ansible-vault view <tmp-restore-dir>/stealth.yml >/dev/null
```

Success means the backup decrypts with the expected Vault password. Do not run
mutating playbooks from the temporary copy.

## Restore Into The Repo

Only restore into the repo when the local Vault is missing or known-bad:

```bash
cp <encrypted-backup-dir>/ghostroute/stealth.yml ansible/secrets/stealth.yml
ANSIBLE_CONFIG=ansible/ansible.cfg ansible-vault view ansible/secrets/stealth.yml >/dev/null
./modules/secrets-management/bin/secret-scan
```

Then run read-only live validation when the router/VPS are reachable:

```bash
./verify.sh --verbose
cd ansible && ansible-playbook playbooks/99-verify.yml
cd ..
./modules/ghostroute-health-monitor/bin/router-health-report
```

## When Back Home

After returning to the home network:

- confirm Channel A router invariants with `./verify.sh --verbose`;
- confirm Channel B selected-client import and real egress on one known client;
- keep Channel C outside production checks until its separate proof is complete;
- refresh the offsite backup if any recovery or rotation changed Vault values;
- remove stale local `ansible/secrets/stealth.yml.backup-*` files after keeping
  the desired recent copies.

Use
`./modules/secrets-management/bin/cleanup-vault-backups --dry-run`
before deleting local backup files.
