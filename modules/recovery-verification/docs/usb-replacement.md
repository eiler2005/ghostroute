# Replacing the Entware USB volume

The main storage mode uses writable Linux ext4 USB for Entware programs,
`/opt/etc` and persistent service directories. The
[read-only recovery bridge](readonly-entware-boot-recovery.md) is temporary;
disable it only after a replacement is verified. Router management SSH runs
from firmware/JFFS and must remain accessible independently of USB applications.

## Preparation

- Obtain explicit approval to erase the identified replacement device. Verify
  its removable-device identity, capacity and a write/readback sample. macOS
  HFS/exFAT is not the final Entware filesystem.
- Verify the complete portable Entware backup checksum and archive paths. Keep
  an up-to-date JFFS + live `/opt/etc` + resolver-cache overlay, encrypted Vault,
  package/cron/mount inventory and the recovery seed on the control machine.
- A readable old USB may contain stale configuration under RAM bind mounts.
  The latest live overlay must supersede the base volume archive.
- Keep old media and backups intact until the replacement passes a real boot.
- Confirm independent internet, an operator at the router, and a fresh SSH
  management session. A router with one USB port needs a controlled interruption
  while the old device is removed and the new one inserted.

## Migration

1. Capture the final live overlay and inventory. Stop Entware applications and
   their owned watchdogs before unmounting. Keep firmware SSH running.
2. Unmount the temporary writable binds and the old USB only after services
   release them. Do not force-detach a busy filesystem.
3. Safely eject the new device from the Mac and insert it into the router.
   Re-identify it by capacity/device metadata; device names alone are not stable.
   Firmware may automount an HFS volume from the whole device rather than a
   numbered partition. Check both the identified disk and its child partitions
   in `/proc/mounts` before repartitioning. Stop a media scanner that holds that
   specific mount; never force-unmount it or ignore a failed partition reread.
4. Use the router's compatible partition/filesystem tools to create a Linux
   partition and ext4. Never copy a raw destructive command against an assumed
   device name. A compatible volume label can preserve existing mount paths;
   use a new filesystem UUID.
   Verify extents/journaling and avoid unsupported modern feature flags. Older
   firmware `blkid` output may omit the filesystem type; confirm ext4 and `rw`
   through `/proc/mounts`, and inspect the superblock when feature evidence is
   needed. An omitted `TYPE` field alone does not mean formatting failed.
5. Restore the verified portable archive into the USB root. Preserve Linux
   modes, ownership and symlinks. Stream through authenticated end-to-end SSH;
   do not place unencrypted credential-bearing backups on the bastion.
6. Overlay the latest live configuration and resolver cache at the Entware
   prefix. Do not extract a `jffs/` + `opt/` archive blindly into the USB root,
   and do not overwrite router JFFS for a normal USB-only replacement.
   A smaller verified restore archive may omit old logs, PID/lock state and
   temporary downloads while replacing the base configuration with the live
   overlay. Keep the complete original backup intact. Preserve installed
   programs, package metadata, persistent application data and symlinks.
7. Remove stale runtime PID/lock/temp state from the replacement before startup.
   Restore the normal `/opt` link, start existing Entware services and reconcile
   the existing runtime supervisor/watchdogs.
8. Verify that `/opt` resolves to the new writable device, selected `/opt`
   directories are no longer RAM binds, and a write/readback succeeds. Compare
   critical custom binaries/configurations with the verified archives.
9. Set `ENABLED=0` in the private read-only recovery config after writable
   startup is proven. Preserve its previous config and seed for rollback.
10. Check DNS, managed/sensitive egress, client ingress, collector and SSH source
    restriction. Perform the authorized controlled reboot with independent
    internet, then verify persistent config/marker and all required services.

The bastion is a TCP forwarder, not a backup store. Private keys and decrypted
archives are not copied to it. A pass-through SSH connection keeps backup data
encrypted between the Mac and the router.

Update `docs/private/current-router-backup.local.md` and the ignored restore
bundle after verification. Keep incident device identifiers and transcripts
private. Tests/syntax checks do not substitute for the actual new-media boot.
