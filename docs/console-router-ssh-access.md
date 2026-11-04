# Separate operator and Console router credentials

Operator administration and Console report collection use different SSH keys.
The operator private key stays on the control Mac. The Console private key is a
runtime secret on its VPS and in the encrypted local Vault; the router restricts
its public key with a forced report command and disables PTY, agent/X11 and port
forwarding for that key. The main and backup bastions retain their separate
forwarding credentials and verified host pins.

The read-only Console container-to-VPS account and this VPS-to-router service
credential are separate boundaries. A read-only GUI or VPS wrapper alone does
not constrain a privileged router key. Source allowlisting complements the
per-key router restrictions; it does not replace them.

## Report boundary

`modules/ghostroute-console/router/console-router-readonly.py` accepts only the
existing reviewed report requests. Literal commands match exactly. Parameterized
log/file reads have fixed paths and bounded arguments. Inline report scripts
must match a SHA-256 entry in the router's fixed policy, with a per-report
allowlist of parameter names and values. The gate executes the approved body
from its server-side policy with a clean environment, never an unchecked incoming
script. Arbitrary shells, altered scripts, SCP/SFTP, configuration writes and
service restarts are rejected. Active canaries and existing observability
temporary files/logs remain part of report generation; this is not a promise of
zero filesystem writes or zero router resource use.

Console alarm acknowledgement/snooze metadata stays on the VPS under private
`operator-state/`, selected by `GHOSTROUTE_ALARM_STATE_FILE`. Those UI actions
do not need router write permission. Preserve any prior operator metadata during
migration; router health facts remain a separate read-only source.

The policy is built only from the trusted control checkout using
`modules/ghostroute-console/bin/build-router-readonly-policy`. A changed report
body requires review, tests and an explicit policy refresh; a modified VPS
checkout cannot authorize new router commands itself. Production report scripts
and router configuration remain trusted inputs. This boundary reduces the powers
of a stolen service key; it does not sandbox bugs in approved reporting code or
protect against compromise of the control Mac/router firmware.

Persistent gate, allowlist and public-key migration metadata live under
`/jffs/addons/ghostroute-console-readonly/`. The gate uses Entware Python in
isolated mode; unavailable USB/Python causes service access to fail closed.
Operator SSH continues to use firmware Dropbear. No SSH daemon restart, channel
restart, DNS change or client-profile migration is required.

## Private inputs

Keep these in encrypted Vault or ignored local secret storage:

- `vault_router_management_operator_key_path` and
  `vault_router_management_operator_public_key`: the new Mac-only operator key.
- `vault_console_router_private_key`, `vault_console_router_public_key` and
  `vault_console_router_known_hosts`: dedicated service identity and preverified
  router host pins.
- `vault_router_retired_shared_public_key`: identifies exactly the legacy key
  to revoke; unrelated authorized keys are preserved.
- `vault_console_router_migration_proven`: set only after fresh operator sessions
  and the actual VPS collector succeed with their respective new credentials.

The Console deployment has no fallback to the operator key. Its runtime
`router.env` selects only the service key and requires strict host-key checking.
Private keys, public-key fingerprints, live endpoints and proof output stay out
of Git. Keep encrypted local backups before replacing Vault or access profiles.

## Staged migration

Run narrow checks first:

```sh
python3 tests/test-console-router-readonly.py
cd ansible
ansible-playbook --syntax-check playbooks/29-console-router-access.yml
ansible-playbook --syntax-check ../modules/ghostroute-console/vps/deploy-readonly.yml
```

After operator authorization, use `29-console-router-access.yml` with an explicit
`console_ssh_action`; its default is read-only status:

Prepare two new key pairs under private `secrets/router-operator-ssh/` and
`secrets/router-console-ssh/`. Never regenerate a pair over an existing file.
Populate the public identities, service private-key content and verified host
pins listed above in Vault before staging. Keep the active operator key path
unchanged until its replacement passes fresh-session proof. The bastion keys
remain separate from both new router identities.

1. Generate separate identities on the Mac and back up existing access privately.
   `stage` installs the reviewed gate and adds both new public keys while keeping
   legacy access. It updates live `authorized_keys` and Merlin's persistent
   `sshd_authkeys`; it checks the firmware startup size limit before writing.
2. Prove the new operator key through both primary and backup bastions using fresh
   sessions with no old-key or agent fallback. Prove the service key accepts a
   report and rejects a harmless arbitrary command and forwarding request.
3. `activate` installs only the dedicated Console key, pinned known-hosts and
   service environment on the VPS. Validate all full/light/live collector sources
   and Console database freshness without rebuilding or restarting the app.
   It also aligns the three reviewed report transport/compatibility helpers with
   the control checkout so their script hashes match the installed allowlist;
   routing services and the frontend bundle are not redeployed.
4. Publish the new operator path to local SSH profiles, helper environments and
   Vault. Audit other consumers of the old credential before retiring it.
5. `retire` requires recorded migration proof, revokes only the legacy public key
   in live/persistent router settings and arms a management-only 180-second
   rollback. Confirm fresh primary/backup sessions, then run `confirm` before the
   timer expires. Verify old-key authentication fails and remove its private
   copies/backups from the VPS. Keep an encrypted local recovery backup.

Actions are separate so losing a collector connection cannot prematurely revoke
operator access. Do not claim retirement complete until the old key is rejected
and required collectors are fresh.

Run one phase at a time from `ansible/`, completing its proof before advancing:

```sh
ansible-playbook playbooks/29-console-router-access.yml
ansible-playbook playbooks/29-console-router-access.yml -e console_ssh_action=stage
# Prove the replacement identities, then activate only the service credential.
ansible-playbook playbooks/29-console-router-access.yml -e console_ssh_action=activate
# Publish the proven operator key path in Vault and local management profiles.
# Record collector/operator proof in Vault before retiring the old key.
ansible-playbook playbooks/29-console-router-access.yml -e console_ssh_action=retire
# Prove fresh sessions immediately; confirm within the rollback window.
ansible-playbook playbooks/29-console-router-access.yml -e console_ssh_action=confirm
```

Publish the proven path in `vault_router_management_operator_key_path`, the
router entries in the private management `ssh_config`, and `SSH_IDENTITY_FILE`
in the local `secrets/router.env` / `secrets/router-management.env` profiles where
present. Keep bastion identity files, both host pins and the backup path intact.
The existing `router_management` local/publish tasks render these profiles for
subsequent management deployments. Service activation does not publish the Mac
profile automatically.

Use a candidate private profile containing only the replacement identity for
each router alias when proving operator access; leave the bastion entries
unchanged. Explicitly disable agent fallback and connection sharing:

```sh
ssh -F <candidate_private_profile> -o IdentitiesOnly=yes -o IdentityAgent=none \
  -o ControlMaster=no -o ControlPath=none ghostroute-router 'printf operator_ok'
ssh -F <candidate_private_profile> -o IdentitiesOnly=yes -o IdentityAgent=none \
  -o ControlMaster=no -o ControlPath=none ghostroute-router-backup 'printf operator_ok'
```

A service-key candidate must accept `true` or an approved report while rejecting
`id`, shell and upload requests with gate exit code `126`. Test forwarding
rejection separately. After retirement, use the retained old-key candidate with
the same no-fallback options: authentication must fail, rather than silently
trying the new key. Keep all candidate files and proof output private.

## Rollback and ongoing checks

`rollback` restores the pre-retirement router key configuration. It never widens
the router source firewall or changes channel routing. Before retirement, the
old operator path remains available; revert the private Console environment if
its service proof fails. After retirement, use the new operator key to repair
or refresh the report allowlist rather than restoring a privileged shared key
as the steady state.

An explicitly approved rollback uses:

```sh
cd ansible
ansible-playbook playbooks/29-console-router-access.yml -e console_ssh_action=rollback
```

Re-run service denial checks after firmware/SSH changes. Re-run report fixtures
and explicitly refresh the policy after changes to approved report scripts.
Audit both runtime and persistent keys so reboot cannot reintroduce the retired
credential.

VPS-edge checks that require operator Ansible/Vault access are separate from
router report authentication. A collector can read router facts successfully
while those checks remain unverified. Run their privileged verification through
the operator path; never restore the administrative router key on the VPS to
make an unrelated monitoring check pass.

The existing health formatter still invokes legacy `traffic-report` for its
summary input. This is compatibility debt, not a new machine accounting
contract. Canonical traffic collection remains `traffic-facts --json` v3 over
raw evidence; do not add machine consumers of the legacy report.

The restriction syntax follows the
[Dropbear manual](https://github.com/mkj/dropbear/blob/DROPBEAR_2025.89/manpages/dropbear.8).
Merlin reconstructs runtime authorized keys from NVRAM at SSH startup; see its
[SSH startup implementation](https://github.com/RMerl/asuswrt-merlin.ng/blob/main/release/src/router/rc/ssh.c).
