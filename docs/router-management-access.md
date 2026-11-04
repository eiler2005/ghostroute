# Restricted router management through a bastion

Optional management hardening keeps SSH separate from the A/B/C/D client data
plane. The operator connects from any network through the owned `hermes_vps`
bastion; router SSH accepts only the management LAN, loopback and explicitly
approved fixed VPS sources. The Console collector's source must be included.
No client ingress endpoint, QR/profile, managed egress, DNS or Channel M policy
changes as part of this migration.

```text
Operator Mac -> restricted SSH forwarding account on hermes_vps -> router SSH
Operator Mac -> dedicated forwarding-only listener on primary_vps -> router SSH
Console VPS -------------------------------------------------> router SSH
Management LAN ----------------------------------------------> router SSH
Other internet sources --------------------------------------> DROP
```

The bastion account has no shell, agent forwarding, TTY or reverse forwarding.
`PermitOpen` and authorized-key restrictions permit only the router SSH
destination. The existing bastion-host administration key and router key must
be distinct. The bastion receives a public key only; router and workstation
private keys are not copied to the bastion. Bastion-host SSH requires public
keys, with password and keyboard-interactive authentication disabled.

This provisioning rule does not remove credentials previously installed for
the Console collector or another service. Separate them with the
[Console router credential migration](console-router-ssh-access.md): the Mac
operator key remains administrative, while the dedicated Console key is forced
through the router report allowlist. A source allow list does not make a
privileged collector key read-only. Revoke the legacy shared key and remove its
server copies only after proving both new identities and all required callers.

## Sources and private artifacts

Tracked templates, tests and playbooks contain no real endpoints or accounts.
The `vault_router_management_*` inputs and verified host-key pins are stored in
the existing gitignored encrypted Vault. The decryption credential and private
key files remain local and must not enter Git.

`26-router-management-access.yml` renders a private `ssh_config`, pinned
`known_hosts`, and `secrets/router-management.env`. The local SSH configuration
includes a generic `~/.ssh/ghostroute-management.conf` link. Operator commands:

```sh
ssh ghostroute-router
```

An optional independent management path uses `primary_vps`. After its host key
and fixed source are verified, set `vault_router_management_backup_enabled` in
the private Vault, choose a separate unused high port in
`vault_router_management_backup_ssh_port`, and run
`27-router-management-backup.yml`. It installs a dedicated SSH listener with
only the forwarding account allowed, leaving the host's administrative SSH port
and its source firewall rules intact. The existing trusted host identity is
pinned for the new port; no new unverified identity is accepted. It proves a
fresh end-to-end session before
retiring that server's SSH rollback timer. Its explicit operator command is:

```sh
ssh ghostroute-router-backup
```

The first alias continues to use `hermes_vps`. The backup connects directly
through `primary_vps` and does not depend on the first bastion. There is no
automatic SSH fallback or change to managed/sensitive traffic exits. Both paths
use the workstation's router key; only its bastion public key is installed on
the forwarding accounts. Store both server host-key pins privately. A backup
must be tested from the intended external network: carrier filtering can make
one VPS unreachable even when its SSH service and router path are healthy.
An explicitly supplied `router_management_proof_config` may use a trusted
temporary transport during setup; this does not prove direct independence.
Record that limitation privately and separately test the published direct alias.
The dedicated service and its single IPv4 firewall rule have their own timed
rollback. That rollback closes the new listener if setup proof fails; it does
not open or replace administrative SSH rules. Passwords, root login and session
channels are disabled on the dedicated listener; only forwarding to router SSH
is accepted.

The host firewall and the provider's cloud firewall are separate gates. A
running listener plus an OS allow rule is insufficient when the cloud firewall
still drops that port. Review a provider-side rule for the dedicated TCP port,
scope it to the intended server, and preserve existing administrative SSH
source restrictions. Do not inherit a provider wizard's default unrestricted
administrative SSH or additional protocol rules. Keep cloud resource identifiers
and console links in ignored operator records. The playbook manages the host
listener/firewall, not provider-specific cloud objects.

Test the published backup alias without an intermediate primary bastion and
verify that ordinary administrative accounts are rejected on the dedicated
listener. A successful test through a temporary transit host proves server
configuration, but not an independent recovery path. Retire both host rollback
timers only after fresh-session proof. Site egress does not switch when the
operator chooses another management alias.

Project health/deploy helpers load the private environment automatically. They
use the bastion only for the remote endpoint; home LAN selection stays direct.
SCP inherits the same SSH options. Router Ansible inventory resolves the remote
endpoint and bastion arguments from Vault when management mode is enabled.
With management mode disabled, supply the LAN host in Vault or `ROUTER_LAN`.

Strict host-key checking uses pins obtained through an existing verified access
path. Do not replace it with `StrictHostKeyChecking=no` or trust a fresh network
key scan as independent identity verification. Do not enable agent forwarding.

## Safe migration

The operator must authorize deployment. Before applying the migration:

1. Back up encrypted Vault, existing SSH configuration and router hooks.
2. Check that separate bastion/router keys already authenticate and that server
   host-key pins are trusted. Inventory all required management callers.
3. Record approved `/32` source addresses in Vault. Do not allow a dynamic
   workstation network or a broad public subnet merely for convenience.
4. Run the local checks below and retain a local/out-of-band recovery path.

```sh
bash tests/test-router-management-access.sh
bash tests/test-router-access-selection.sh
cd ansible
ansible-playbook --syntax-check playbooks/26-router-management-access.yml
ansible-playbook playbooks/26-router-management-access.yml
```

The playbook stages local files, arms a bastion SSH rollback, creates the
forwarding-only account and proves a fresh Mac -> bastion -> router session
before restricting the router. A separate router management-only rollback is
armed before applying the source guard. Fresh-session proof confirms the guard,
then the private workstation environment and SSH alias are published. Routers
use the existing firmware SSH daemon; this path does not require Entware to run.

`router-management-ssh` builds an unreferenced chain before switching the INPUT
jump, alternates its two owned chains on refresh, and never flushes other
firewall chains. The guard is reapplied by `firewall-start`; manual late rules
would not provide the same persistence. IPv6 must remain disabled for this
IPv4-only management policy. A healthy default mode remains unchanged when
management is not enabled.

After deployment, check fresh bastion and collector sessions, the intended LAN
path, and a rejected connection from an independent unapproved internet source.
Compare proxy listeners, routing config and DNS before/after. Confirm local
Ansible inventory, `verify.sh` and health reports use the new path. Refresh
private backups and any opted-in JFFS recovery snapshot. A true reboot check is
separate and needs independent internet and an operator nearby.

## Recovery and residual risk

Router emergency rollback, from an approved existing session:

```sh
/jffs/scripts/router-management-ssh disable
```

This restores the prior Merlin-controlled SSH exposure and disables the private
guard configuration. Correct the Vault setting before another deployment. Keep
the timed rollback armed until a fresh session has succeeded. The bastion also
keeps a private SSH configuration backup and validates `sshd` before reload.

Source restrictions reduce exposure; they do not eliminate private-key theft,
compromise of an approved VPS, firmware vulnerabilities or attacks on the
separate public proxy services. Update both systems and review authorized keys.
An inaccessible bastion does not silently widen the router allow list.
Existing bastion `AllowUsers` entries are preserved. Where such a list exists,
the restricted account is appended; a host without a list is not converted to
one that accidentally excludes its administrators.

For USB migration, see the
[normal-storage replacement procedure](../modules/recovery-verification/docs/usb-replacement.md).
