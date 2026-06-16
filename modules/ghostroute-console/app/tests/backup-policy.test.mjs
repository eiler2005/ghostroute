import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runSqliteBackupRetention, sqliteBackupInventory } from "../scripts/lib/sqlite-backups.mjs";

function writeSizedFile(file, size, mtime = new Date()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(size, "x"));
  fs.utimesSync(file, mtime, mtime);
}

function tmpDataDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("SQLite backups are disabled by default and legacy root backups are pruned", () => {
  const dataDir = tmpDataDir("ghostroute-backups-disabled-");
  const dbFile = path.join(dataDir, "ghostroute.db");
  const legacyRootBackup = path.join(dataDir, "ghostroute.db.backup-2026-05-18T00-00-00-000Z");
  writeSizedFile(dbFile, 128);
  writeSizedFile(legacyRootBackup, 64);

  const result = runSqliteBackupRetention({
    dataDir,
    dbFile,
    env: {
      GHOSTROUTE_DB_BACKUP_MODE: "none",
      GHOSTROUTE_DB_BACKUP_MAX_FILES: "1",
      GHOSTROUTE_DB_BACKUP_MAX_TOTAL_BYTES: "1024",
    },
  });

  assert.equal(result.backupPath, "");
  assert.equal(result.skippedReason, "disabled");
  assert.equal(result.legacyMoved, 1);
  assert.equal(result.backupsDeleted, 1);
  assert.equal(fs.existsSync(legacyRootBackup), false);
  assert.equal(fs.readdirSync(path.join(dataDir, "backups")).some((name) => name.startsWith("ghostroute-")), false);
  assert.equal(sqliteBackupInventory(dataDir).count, 0);
});

test("local_daily mode creates at most one SQLite backup per day", () => {
  const dataDir = tmpDataDir("ghostroute-backups-daily-");
  const dbFile = path.join(dataDir, "ghostroute.db");
  const now = new Date("2026-05-19T10:00:00.000Z");
  writeSizedFile(dbFile, 256);

  const options = {
    dataDir,
    dbFile,
    env: {
      GHOSTROUTE_DB_BACKUP_MODE: "local_daily",
      GHOSTROUTE_DB_BACKUP_MAX_FILES: "2",
      GHOSTROUTE_DB_BACKUP_MAX_TOTAL_BYTES: "2048",
      GHOSTROUTE_DB_BACKUP_MIN_FREE_BYTES: "0",
      GHOSTROUTE_DB_BACKUP_MAX_USED_PCT: "100",
    },
    now,
    diskStats: { totalBytes: 4096, freeBytes: 3072, usedPct: 25 },
  };

  const first = runSqliteBackupRetention(options);
  const second = runSqliteBackupRetention(options);
  const managedBackups = fs.readdirSync(path.join(dataDir, "backups")).filter((name) => name.startsWith("ghostroute-") && name.endsWith(".db"));

  assert.match(first.backupPath, /ghostroute-2026-05-19T10-00-00-000Z\.db$/);
  assert.equal(second.backupPath, "");
  assert.equal(second.skippedReason, "already-backed-up-today");
  assert.equal(managedBackups.length, 1);
});

test("SQLite backup retention enforces both max count and max total bytes", () => {
  const dataDir = tmpDataDir("ghostroute-backups-retention-");
  const backupsDir = path.join(dataDir, "backups");
  writeSizedFile(path.join(dataDir, "ghostroute.db"), 32);
  writeSizedFile(path.join(backupsDir, "ghostroute-2026-05-17T00-00-00-000Z.db"), 90, new Date("2026-05-17T00:00:00Z"));
  writeSizedFile(path.join(backupsDir, "ghostroute-2026-05-18T00-00-00-000Z.db"), 90, new Date("2026-05-18T00:00:00Z"));
  writeSizedFile(path.join(backupsDir, "ghostroute-2026-05-19T00-00-00-000Z.db"), 90, new Date("2026-05-19T00:00:00Z"));

  const result = runSqliteBackupRetention({
    dataDir,
    now: new Date("2026-05-19T10:00:00.000Z"),
    env: {
      GHOSTROUTE_DB_BACKUP_MODE: "local_daily",
      GHOSTROUTE_BACKUP_RETENTION_DAYS: "3650",
      GHOSTROUTE_DB_BACKUP_MAX_FILES: "2",
      GHOSTROUTE_DB_BACKUP_MAX_TOTAL_BYTES: "150",
    },
  });

  const inventory = sqliteBackupInventory(dataDir);
  assert.equal(result.backupsDeleted, 2);
  assert.equal(inventory.count, 1);
  assert.equal(inventory.totalBytes, 90);
  assert.match(inventory.latestPath, /ghostroute-2026-05-19T00-00-00-000Z\.db$/);
});

test("SQLite backup creation skips when projected disk guard would be violated", () => {
  const dataDir = tmpDataDir("ghostroute-backups-low-disk-");
  const dbFile = path.join(dataDir, "ghostroute.db");
  writeSizedFile(dbFile, 100);

  const result = runSqliteBackupRetention({
    dataDir,
    dbFile,
    env: {
      GHOSTROUTE_DB_BACKUP_MODE: "local_daily",
      GHOSTROUTE_DB_BACKUP_MAX_FILES: "1",
      GHOSTROUTE_DB_BACKUP_MAX_TOTAL_BYTES: "1000",
      GHOSTROUTE_DB_BACKUP_MIN_FREE_BYTES: "1000",
      GHOSTROUTE_DB_BACKUP_MAX_USED_PCT: "75",
    },
    now: new Date("2026-05-19T10:00:00.000Z"),
    diskStats: { totalBytes: 4000, freeBytes: 1050, usedPct: 73.75 },
  });

  assert.equal(result.backupPath, "");
  assert.match(result.skippedReason, /free disk/);
  assert.equal(sqliteBackupInventory(dataDir).count, 0);
});
