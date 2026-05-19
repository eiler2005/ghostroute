import fs from "node:fs";
import path from "node:path";

export const DEFAULT_BACKUP_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_BACKUP_MIN_FREE_BYTES = 10 * 1024 * 1024 * 1024;
export const DEFAULT_BACKUP_MAX_USED_PCT = 75;

function numberFromEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function integerFromEnv(value, fallback) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function sqliteBackupPolicyFromEnv(env = process.env) {
  return {
    mode: String(env.GHOSTROUTE_DB_BACKUP_MODE || "none").trim().toLowerCase(),
    retentionDays: numberFromEnv(env.GHOSTROUTE_BACKUP_RETENTION_DAYS, 2),
    maxFiles: integerFromEnv(env.GHOSTROUTE_DB_BACKUP_MAX_FILES, 1),
    maxTotalBytes: integerFromEnv(env.GHOSTROUTE_DB_BACKUP_MAX_TOTAL_BYTES, DEFAULT_BACKUP_MAX_TOTAL_BYTES),
    minFreeBytes: integerFromEnv(env.GHOSTROUTE_DB_BACKUP_MIN_FREE_BYTES, DEFAULT_BACKUP_MIN_FREE_BYTES),
    maxUsedPct: numberFromEnv(env.GHOSTROUTE_DB_BACKUP_MAX_USED_PCT, DEFAULT_BACKUP_MAX_USED_PCT),
  };
}

function isManagedBackupName(name) {
  return name.startsWith("ghostroute-") && name.endsWith(".db");
}

function isLegacyBackupName(name) {
  return name.startsWith("ghostroute.db.backup-");
}

function isRetentionManagedBackupName(name) {
  return isManagedBackupName(name) || isLegacyBackupName(name);
}

function uniqueTarget(dir, name) {
  let candidate = path.join(dir, name);
  if (!fs.existsSync(candidate)) return candidate;
  const suffix = new Date().toISOString().replace(/[:.]/g, "-");
  candidate = path.join(dir, `${name}.migrated-${suffix}`);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${name}.migrated-${suffix}-${counter}`);
    counter += 1;
  }
  return candidate;
}

function listBackupFiles(dataDir, backupsDir) {
  const files = [];
  for (const [dir, include] of [
    [backupsDir, isRetentionManagedBackupName],
    [dataDir, isLegacyBackupName],
  ]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!include(name)) continue;
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      if (stat.isFile()) files.push({ name, file, stat });
    }
  }
  return files;
}

function migrateLegacyRootBackups(dataDir, backupsDir) {
  if (!fs.existsSync(dataDir)) return 0;
  fs.mkdirSync(backupsDir, { recursive: true });
  let moved = 0;
  for (const name of fs.readdirSync(dataDir)) {
    if (!isLegacyBackupName(name)) continue;
    const file = path.join(dataDir, name);
    const stat = fs.statSync(file);
    if (!stat.isFile()) continue;
    fs.renameSync(file, uniqueTarget(backupsDir, name));
    moved += 1;
  }
  return moved;
}

function pruneByAge(dataDir, backupsDir, retentionDays) {
  const cutoff = Date.now() - retentionDays * 86400000;
  let deleted = 0;
  for (const entry of listBackupFiles(dataDir, backupsDir)) {
    if (entry.stat.mtimeMs >= cutoff) continue;
    fs.unlinkSync(entry.file);
    deleted += 1;
  }
  return deleted;
}

function pruneByCountAndBytes(dataDir, backupsDir, maxFiles, maxTotalBytes) {
  const files = listBackupFiles(dataDir, backupsDir).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  let keptFiles = 0;
  let keptBytes = 0;
  let deleted = 0;
  for (const entry of files) {
    const nextFiles = keptFiles + 1;
    const nextBytes = keptBytes + entry.stat.size;
    if (nextFiles <= maxFiles && nextBytes <= maxTotalBytes) {
      keptFiles = nextFiles;
      keptBytes = nextBytes;
      continue;
    }
    fs.unlinkSync(entry.file);
    deleted += 1;
  }
  return deleted;
}

function backupModeEnabled(mode) {
  return mode === "local_daily" || mode === "daily";
}

function retentionLimits(policy) {
  if (backupModeEnabled(policy.mode)) {
    return { maxFiles: policy.maxFiles, maxTotalBytes: policy.maxTotalBytes };
  }
  return { maxFiles: 0, maxTotalBytes: 0 };
}

function readDiskStats(dir) {
  if (typeof fs.statfsSync !== "function") return null;
  try {
    const stat = fs.statfsSync(dir);
    const totalBytes = Number(stat.blocks) * Number(stat.bsize);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    return {
      totalBytes,
      freeBytes,
      usedPct: totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0,
    };
  } catch {
    return null;
  }
}

function backupSkipReason(dbSize, policy, diskStats) {
  if (policy.maxTotalBytes >= 0 && dbSize > policy.maxTotalBytes) {
    return `db size ${dbSize} exceeds backup max total bytes ${policy.maxTotalBytes}`;
  }
  if (!diskStats || !diskStats.totalBytes) return "";
  const projectedFree = diskStats.freeBytes - dbSize;
  const projectedUsedPct = ((diskStats.totalBytes - projectedFree) / diskStats.totalBytes) * 100;
  if (diskStats.freeBytes < policy.minFreeBytes || projectedFree < policy.minFreeBytes) {
    return `free disk would fall below ${policy.minFreeBytes} bytes`;
  }
  if (diskStats.usedPct > policy.maxUsedPct || projectedUsedPct > policy.maxUsedPct) {
    return `disk usage would exceed ${policy.maxUsedPct}%`;
  }
  return "";
}

function createSqliteBackup(dbFile, backupsDir, policy, options = {}) {
  if (!fs.existsSync(dbFile)) return { backupPath: "", skippedReason: "missing-db" };
  if (!backupModeEnabled(policy.mode)) return { backupPath: "", skippedReason: "disabled" };
  const now = options.now || new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const day = stamp.slice(0, 10);
  const existing = fs.existsSync(backupsDir)
    ? fs.readdirSync(backupsDir).some((name) => name.startsWith(`ghostroute-${day}`) && name.endsWith(".db"))
    : false;
  if (existing) return { backupPath: "", skippedReason: "already-backed-up-today" };
  const dbStat = fs.statSync(dbFile);
  const diskStats = options.diskStats === undefined ? readDiskStats(backupsDir) : options.diskStats;
  const skippedReason = backupSkipReason(dbStat.size, policy, diskStats);
  if (skippedReason) return { backupPath: "", skippedReason };

  fs.mkdirSync(backupsDir, { recursive: true });
  const backupPath = path.join(backupsDir, `ghostroute-${stamp}.db`);
  fs.copyFileSync(dbFile, backupPath);
  return { backupPath, skippedReason: "" };
}

export function sqliteBackupInventory(dataDir, backupsDir = path.join(dataDir, "backups")) {
  const files = listBackupFiles(dataDir, backupsDir).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  const totalBytes = files.reduce((sum, entry) => sum + entry.stat.size, 0);
  const latest = files[0];
  return {
    count: files.length,
    totalBytes,
    latestPath: latest?.file || "",
    latestAt: latest ? latest.stat.mtime.toISOString() : "",
  };
}

export function runSqliteBackupRetention(options) {
  const dataDir = options.dataDir;
  const backupsDir = options.backupsDir || path.join(dataDir, "backups");
  const dbFile = options.dbFile || path.join(dataDir, "ghostroute.db");
  const policy = options.policy || sqliteBackupPolicyFromEnv(options.env || process.env);
  fs.mkdirSync(backupsDir, { recursive: true });

  const legacyMoved = migrateLegacyRootBackups(dataDir, backupsDir);
  const backup = createSqliteBackup(dbFile, backupsDir, policy, options);
  const limits = retentionLimits(policy);
  let backupsDeleted = pruneByAge(dataDir, backupsDir, policy.retentionDays);
  backupsDeleted += pruneByCountAndBytes(dataDir, backupsDir, limits.maxFiles, limits.maxTotalBytes);
  const inventory = sqliteBackupInventory(dataDir, backupsDir);
  return {
    backupPath: backup.backupPath,
    skippedReason: backup.skippedReason,
    backupsDeleted,
    legacyMoved,
    retainedCount: inventory.count,
    retainedBytes: inventory.totalBytes,
    latestBackupPath: inventory.latestPath,
    latestBackupAt: inventory.latestAt,
    policy,
  };
}
