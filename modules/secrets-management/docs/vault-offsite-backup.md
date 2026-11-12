# Vault Offsite Backup Runbook

This runbook protects against the highest-impact local failure mode: losing or
corrupting `ansible/secrets/stealth.yml` while the live router/VPS still depend
on the values inside it.

The full recovery model is shown in the
[recovery-assets diagram](../../../docs/assets/diagrams/ghostroute-recovery-en.png).
Exact inventory and acceptance live in ignored local notes; remaining work is
tracked in [RA-01 and RA-08](../../../docs/routing-assurance-roadmap.md).

## Policy

- Keep at least one current encrypted offsite copy outside the repo working tree.
- Store it on an encrypted USB drive, a trusted password manager attachment, or
  another encrypted personal backup location.
- A second folder or a local Time Machine snapshot on the same Mac is still a
  local copy; it does not protect against loss of that machine.
- Do not store the Vault password next to the backup file.
- Keep a separate, tested way to recover the password after loss of the control
  machine. An encrypted archive cannot recover its own missing decryption key.
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

For a complete router backup in object storage, encrypt archives and private
restore notes on the control machine before upload. Use a private bucket and
upload a SHA-256 manifest for the encrypted files. Download the files to a
separate temporary location, verify the hashes and decrypt/read the archives
there before counting the copy as recoverable. Keep the decryption password
outside the bucket. Do not upload plaintext layout inventories, profiles or
diagnostic logs.

## Full Recovery Bundle And Local Infrastructure

| Material | Location / ownership | What it restores |
|---|---|---|
| Public source and templates | Git repository and recorded commit | Reviewed implementation and deployment logic; no real credentials |
| Private control-machine workspace | Vault, secrets, generated profiles and local operator notes | Deployment identities, imports and operator configuration |
| Router persistent state | USB/Entware, JFFS, NVRAM export and consistent database snapshots | Files and settings needed for controlled router recovery |
| Local encrypted archives | Ignored `reports/router-backups/` with a private latest pointer | A verified recovery copy outside the router, still on the control machine |
| Independent encrypted copy | Private object storage or a separate encrypted medium | Recovery after loss of the control machine; requires full downloaded restore proof |
| Diagnostic tools | Ignored `reports/client-probes/` | Isolated client/proxy checks; not a running replica of the router or VPS |
| Optional Mac Guard profile | Private user Application Support `GhostRoute Guard/profile.json` | Authenticated Mac proxy routes and approved exits; include explicitly in an encrypted control-material backup after creation/change |

The complete bundle uses `router-usb-jffs-nvram.tar.gz.gpg` for router files,
`mac-recovery-material.tar.gz.gpg` for private control material and local probe
tools, and `cloud-restore-metadata.tar.gz.gpg` for private restore instructions,
inventory and verification records. `CLOUD-SHA256SUMS` covers the three encrypted
archives. Review the private manifest for the exact included paths; do not assume
that arbitrary home directories, every SSH private key, browser credentials or
all VPS application databases are present. Independently owned VPS apps need
their own backup contract.

Existing archives do not automatically include a later-installed Mac Guard
profile or its private `ordinary-direct-domains.txt` policy. Include both when
present; rebuild the generated extension policy with the installer. Refresh the
encrypted control-material inventory explicitly; verify the
restored member before claiming coverage. Guard browser cookies/history are
excluded by default. Rebuild its app/extension from the recorded source commit;
do not restore stale loopback ports, process IDs or locks. See the
[Mac recovery procedure](../../mac-privacy-guard/docs/operations.md#обновление-копия-и-rollback).

This is a file recovery bundle, not a firmware image, ASUS CFG import or a live
standby. Probe tools use isolated local listeners and do not replace actual
phone-client acceptance. Keep raw traffic logs out of the cloud bundle.

## Verify An Object-Storage Copy

1. Download all three encrypted archives and `CLOUD-SHA256SUMS` into a separate
   private temporary directory. Restore their original basenames if the web
   downloader prepended an object prefix.
2. Compare the downloaded manifest with a trusted retained manifest/hash, then
   run `shasum -a 256 -c CLOUD-SHA256SUMS` inside that directory. Every archive
   must pass. A matching manifest alone does not verify the archive bytes.
3. Authenticate and read each downloaded archive completely. For the GPG tar
   bundle, run in Bash with the normal secure GPG password prompt:

   ```bash
   set -euo pipefail
   for archive in router-usb-jffs-nvram.tar.gz.gpg mac-recovery-material.tar.gz.gpg cloud-restore-metadata.tar.gz.gpg; do
     gpg --decrypt "$archive" | tar -tzf - >/dev/null
   done
   ```

4. Inspect the restore instructions and required members in a private temporary
   workspace; verify that the recovered Vault can be opened. Do not print secret
   contents, overwrite the working checkout or deploy from this drill.
5. Record object identity/version, byte sizes, SHA-256 results, authenticated
   read results and password recovery method privately. Remove only the temporary
   plaintext created for the drill after retaining the encrypted copies.

An object listing and matching size prove upload visibility; provider SHA-1 is
useful transfer evidence. Neither replaces the full downloaded SHA-256 and
decryption checks above. File verification does not prove a spare router has
been rebuilt successfully: record that separate hardware drill only when done.

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
- confirm each enabled selected-client channel from an actual client, including
  direct and managed egress; check sensitive routing where enabled;
- refresh the offsite backup if any recovery or rotation changed Vault values;
- remove stale local `ansible/secrets/stealth.yml.backup-*` files after keeping
  the desired recent copies.

Use
`./modules/secrets-management/bin/cleanup-vault-backups --dry-run`
before deleting local backup files.
