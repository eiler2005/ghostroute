# Read-only Entware boot recovery

**Operating mode: temporary recovery.** The main mode stores Entware programs,
configuration and service directories on healthy writable USB; JFFS stores the
router-owned hooks/configuration, and RAM holds volatile runtime. The full
[storage ownership table](../../../docs/router-runtime-map.md#storage-ownership-and-operating-modes)
compares the two modes and what survives reboot.

This explicitly installed emergency bridge supports a USB volume that is still
readable but write-protected. It stores a private configuration archive in JFFS
and recreates writable RAM directories before Entware starts. USB binaries and
libraries must remain readable; it does not repair or replace the storage.

## Ownership and startup

The helper prepares storage only. Existing `rc.unslung` and the runtime
supervisor retain service, DNS and routing ownership. No client profiles or
egress selections change. It never changes block-device protection or replays
the USB journal.

- `services-start` runs `boot` before launching the supervisor.
- The existing `post-mount` runs `prepare` before its Entware startup.
- If firmware cannot mount dirty read-only ext4, `boot` identifies the configured
  UUID and mounts it with `ro,noload`. A post-mount hook alone cannot handle a
  filesystem that never mounted.
- Another UUID or a writable filesystem follows normal startup.
- `/opt/etc`, `/opt/var/run`, `/opt/var/log`, the dnscrypt resolver cache and
  `/opt/tmp` receive RAM bind mounts. PID/log/tmp directories start empty.
- Existing RAM mounts are adopted without replacing live config or restarting
  services. Repeated preparation does not stack binds.
- If `boot` mounted the USB itself, it starts the existing `rc.unslung` once;
  the normal supervisor then reconciles GhostRoute.

## Installation

Back up JFFS, live `/opt/etc`, mount/cron state and encrypted Vault to the control
machine. Confirm JFFS capacity. Use independent internet for any actual reboot
or USB interruption. After local checks and deployment authorization:

```sh
cd ansible
ansible-playbook playbooks/25-readonly-entware-recovery.yml
```

The playbook preserves original hooks once, installs the helper, records the
current volume identity, snapshots config, inserts marked hook blocks and runs
live idempotency checks. It does not reboot or restart services.

Private material lives in `/jffs/ghostroute-recovery` (directory `0700`, config
and archive `0600`). The archive includes credentials and TLS keys: keep copies
out of git and public reports. Runtime identity is local deployment data.

## Snapshot discipline

The archive contains `/opt/etc` and the dnscrypt cache. Snapshot validates the
live sing-box config and archive, then atomically replaces the previous archive.
Preparation validates gzip and archive paths before extraction.

Successful `20-stealth-router.yml` deployments refresh opted-in snapshots after
the normal post-deploy gate. After manual configuration/certificate changes:

```sh
/jffs/scripts/readonly-entware-recovery.sh snapshot
/jffs/scripts/readonly-entware-recovery.sh check
/jffs/scripts/readonly-entware-recovery.sh status
```

Other USB paths remain read-only. RAM logs vanish at reboot. Manual changes or
certificate renewals need a snapshot refresh to survive reboot.

## Verification and limits

```sh
bash tests/test-readonly-entware-recovery.sh
bash tests/test-runtime-supervisor-static.sh
cd ansible
ansible-playbook --syntax-check playbooks/25-readonly-entware-recovery.yml
ansible-playbook --syntax-check playbooks/20-stealth-router.yml
```

Fixtures cover disabled/healthy/unrelated volumes, cold and fallback startup,
preservation of live RAM mounts, one-time Entware start, corrupt archives and
unexpected paths, plus device discovery with Merlin's legacy `/sys/block` layout
when `/sys/class/block` is absent. They simulate mounts and do not prove cold boot.
The helper accepts both firmware `/opt` links (`tmp/opt` and `/tmp/opt`).
Installation also needs router BusyBox syntax checks, repeated live `prepare`,
stable service PIDs/config hashes/mounts and health checks.

A controlled reboot is a separate disruptive verification step: independent
internet, operator nearby, private backups and a recovery path are required.
After boot verify mounts, listeners, DNS, routing, sensitive/shared egress and
home-client access. Do not claim reboot is proven by live idempotency alone.

Unreadable USB binaries, a missing device, exhausted RAM/JFFS or an invalid seed
cannot be recovered by this bridge. Invalid preparation stops before normal
Entware startup rather than installing an invalid seed. Other applications'
state outside the listed RAM directories is not made writable.

## Replacement and rollback

Before replacing USB, keep a private control-machine bundle under an ignored
directory such as `reports/router-backups/`. Include a verified Entware volume
archive, fresh JFFS plus live `/opt/etc` and resolver cache, the reboot seed,
encrypted Vault, package/mount/cron inventory, recovery sources and checksums.
The newer live configuration must be overlaid after restoring the older USB
archive. Confirm the live and reboot-seed configuration hashes match.

Keep a `RESTORE.txt` describing archive prefixes and restore order with the
bundle. Do not extract the USB-root archive into the router root, and do not
overwrite JFFS for a normal USB-only replacement. Check every backup file is
ignored and untracked; archives contain credentials even when filenames do not.
A backup on the same Mac is useful for media replacement but is not offsite
protection against losing that Mac.

After normal writable storage is restored, verify its mount/start hooks and set
`ENABLED=0` in the private recovery config. An unrelated UUID is ignored. Keep
the archive until the replacement passes a controlled reboot.

Remove only `GhostRouteReadonlyEntware` marked blocks to roll back hooks;
preserve other changes. Original hooks are also saved in the private recovery
directory. Disabling hooks does not remove current RAM mounts: never unmount
them underneath running services. Using the read-only USB without this bridge
restores the original reboot risk.
