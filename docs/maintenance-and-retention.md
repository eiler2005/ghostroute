# Maintenance, safe cleanup and traffic retention

This guide covers storage owned by GhostRoute and Console. Use the module owner
and a concrete path before deleting data. Maintenance of Console storage does
not require changes to router routing, DNS, channels or issued client profiles.

## Console traffic policy: a rolling maximum of 90 days

The SQLite file can remain in place for years; its **traffic records**, rather
than the file's creation date, expire. Console keeps at most 90 days of traffic
history. Each successful full/light/live collector cycle applies the limit before
and after aggregate rebuilding. Cleanup resumes at the next successful collection
if collectors were stopped. It is not an independent router cron job.

| Data | Normal retention | Boundary |
|---|---|---|
| Raw traffic/DNS snapshots, normalized traffic and device counters | 7 days | File and SQLite cleanup; shorter than the 90-day ceiling. |
| Raw live snapshot files | 6 hours | Bounded live events also receive ordinary raw retention. |
| Service/background and unclassified raw facts | 24 hours | Separate short-lived diagnostic evidence. |
| Fine traffic / fine DNS aggregates | 8 days / 1 day | Higher aggregate layers preserve useful history. |
| Hourly traffic and DNS | 35 days; legacy `hourly_traffic` 30 days | Longer overrides are capped at 90 days. |
| Daily, weekly and monthly traffic/DNS and channel-lane aggregates | At most 90 days | Old coarse buckets are removed by bucket start time; a boundary bucket may be dropped as a whole. |
| Pending generated recommendations | 7 days | Reviewed/generated evidence also receives the 90-day ceiling. |
| Derived destination/device observations and prepared windows | At most 90 days since observation/window | Operator client registry and configuration remain separate. |

The implementation is
[`traffic-retention.mjs`](../modules/ghostroute-console/app/scripts/lib/traffic-retention.mjs)
and the collector's
[`pruneOperationalTables`](../modules/ghostroute-console/app/scripts/lib/normalize.mjs).
Legacy daily settings of 400/100 days no longer extend traffic retention beyond
90 days. The Compose/deploy defaults explicitly set daily traffic and DNS to 90.
Raw settings can shorten retention; the ceiling still applies.

This policy does not expire credentials, client imports, operator attribution,
settings, audit records, catalog reviews or static IP classification catalogs.
Other operational logs have their own module retention. It is not a blanket
90-day deletion rule for every table or file.

Deleting rows makes SQLite pages reusable; it does not necessarily reduce the
database file immediately. Do not delete a live `-wal` or `-shm` file to reclaim
space. Inspect file size and free pages first. Physical compaction requires a
separate maintenance window, adequate temporary disk space and a consistent
backup. There is no scheduled heavyweight `VACUUM` on page requests or collector
cycles.

## What can be cleaned

| Area | Safe scope | Preserve / prerequisites |
|---|---|---|
| Docker test images and build cache | Remove the task's unused browser image, dangling images (`docker image prune -f`) and unused build cache (`docker builder prune -f`). | Inspect `docker system df` and image ownership. Keep the running Console image and the reviewed rollback tag. |
| Temporary Console test workspaces | Completed task-owned directories such as `/tmp/console-public-browser`, `/tmp/console-channel-profiler`, `/tmp/ghostroute-console-perf-vps`. | Stop/finish their test processes first; retain useful failure results privately before removing them. Remove temporary test credentials. |
| Console raw JSON | Expired files in `/opt/ghostroute-console/data/snapshots/`. | Prefer collector retention. Coordinate manual deletion with Console and keep current health/policy evidence. Never clear all of `data/` as a shortcut. |
| Console traffic database/history | The explicit history-reset helper, after operator authorization and stopping only Console. | Preserve operator state and the schema. Always restart Console and check API/channel observations. See the reset procedure below. |
| Old traffic database copies | Explicitly identified obsolete `.db` backups/quarantines belonging to Console. | Decide whether historical recovery is still needed. Keep a clean data baseline plus image/source/configuration when code rollback is required. |
| Deployment rollback directories | Obsolete releases after reviewing their contents and confirming a working replacement. | Do not remove the currently reviewed rollback set, service credentials, attribution files or encrypted recovery bundles. |
| Local `reports/` and generated artifacts | Task-owned disposable diagnostics after retaining needed evidence privately. | Generated QR/URI/profile bundles and approved identity manifests are credential material, not cache. Preserve them and verified encrypted backups. |

Do not use `docker system prune --volumes` or indiscriminate volume/container
deletion as routine cleanup. Other applications can own persistent databases and
stopped recovery containers on the same VPS. Tagged application images also need
an ownership/recovery decision before removal.

Never clean router/VPS channel configuration, keys, certificates, persistent
firewall hooks, recovery cron entries or client bundles to solve Console disk
pressure. Channel anyT's issued identities and automatic recovery are protected
production assets. Router traffic evidence remains read-only relative to routing.

## Traffic reset and backup lifecycle

Routine 90-day aging is automatic and does **not** require resetting the database.
For an explicitly requested full history reset, use the
[Console runbook](../modules/ghostroute-console/docs/operator-runbook.md#explicit-traffic-history-reset)
and [`reset-traffic-history`](../modules/ghostroute-console/bin/reset-traffic-history).
The helper replaces the database atomically using the same schema, preserving
non-traffic operator state. Remove approved old traffic snapshots/backups in the
same stopped window so they cannot remain as hidden copies.

Router counters are not reset. A fresh collection may again display cumulative
current-day values; that does not mean the deleted Console history was restored.

Automatic full-database backups are disabled by default. When deliberately
enabled, the deployed policy normally keeps at most one backup for one day and
enforces size/free-space guards. Deployment rollback directories are independent
of that automatic backup retention: review them after successful releases and
retain traffic-bearing manual database archives for no more than 90 days unless
the operator explicitly establishes a different private archival policy. A clean
non-traffic rollback database does not retain old traffic history.

After intentionally deleting old traffic backups, code/configuration rollback can
still work against the compatible clean database, but deleted history is no longer
recoverable from those removed copies. Never imply that an image rollback alone
restores deleted data.

## Maintenance checks

Start with `df -h`, `docker system df`, and a bounded listing of known Console
database/backup paths. The Console `report:db-size` command can inspect table
storage, but a full SQLite page inventory can be expensive on a large database;
use it during quiet periods rather than as a frequent health probe.

After cleanup or retention changes, verify:

1. The existing Console image starts and `/api/health` and `/traffic` answer.
2. D, anyT and Snell Health cards distinguish fresh runtime observations from
   missing application probes; service-key collection still works.
3. Traffic totals maintain `Total = Via VPS + Direct + Unknown` for remaining data.
4. The working image and chosen rollback assets remain present; disk free space
   is adequate for the next build and any planned database backup.
5. Shared infrastructure work still passes the authenticated anyT production gate
   with all issued imports preserved.

Private maintenance evidence belongs in ignored operator reports. Public docs
record the policy and procedure, not real endpoints, credentials or traffic rows.
