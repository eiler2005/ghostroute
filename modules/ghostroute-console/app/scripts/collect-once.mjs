#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ensureConsoleSchema, normalizeSnapshot, rebuildHourlyAggregates, rebuildObservabilityReadModels } from "./lib/normalize.mjs";

const appDir = path.resolve(new URL("..", import.meta.url).pathname);
const moduleDir = path.resolve(appDir, "..");
const repoRoot = process.env.GHOSTROUTE_CONSOLE_REPO_ROOT || path.resolve(moduleDir, "../..");
const dataDir = process.env.GHOSTROUTE_CONSOLE_DATA_DIR || path.resolve(moduleDir, "data");
const snapshotDir = path.join(dataDir, "snapshots");
const backupsDir = path.join(dataDir, "backups");
const collectMaxBuffer = Math.max(1024 * 1024, Number(process.env.GHOSTROUTE_COLLECT_MAX_BUFFER_BYTES || 128 * 1024 * 1024));
fs.mkdirSync(snapshotDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(backupsDir, { recursive: true });

const lockFile = path.join(dataDir, "collector.lock");
let lockFd = null;
try {
  const stat = fs.statSync(lockFile);
  const maxAgeMs = Math.max(30000, Number(process.env.GHOSTROUTE_COLLECT_TIMEOUT_SECONDS || 180) * 1000 * 2);
  if (Date.now() - stat.mtimeMs > maxAgeMs) fs.unlinkSync(lockFile);
} catch {
  // No existing lock.
}
try {
  lockFd = fs.openSync(lockFile, "wx");
  fs.writeFileSync(lockFd, `${process.pid} ${new Date().toISOString()}\n`);
} catch {
  console.log("collector skipped: another collect-once run is active");
  process.exit(0);
}
process.on("exit", () => {
  try {
    if (lockFd !== null) fs.closeSync(lockFd);
    fs.unlinkSync(lockFile);
  } catch {
    // Best-effort lock cleanup.
  }
});

const db = new Database(path.join(dataDir, "ghostroute.db"));
db.pragma("journal_mode = WAL");
ensureConsoleSchema(db);

const commands = [
  ["traffic_summary", "modules/traffic-observatory/bin/traffic-summary", ["--json", "today"]],
  ["traffic", "modules/traffic-observatory/bin/traffic-report", ["--json", process.env.GHOSTROUTE_CONSOLE_PERIOD || "today"]],
  ["health", "modules/ghostroute-health-monitor/bin/router-health-report", ["--json"]],
  ["leaks", "modules/ghostroute-health-monitor/bin/leak-check", ["--json"]],
  ["domains", "modules/dns-catalog-intelligence/bin/domain-report", ["--json", "--all"]],
  ["dns", "modules/dns-catalog-intelligence/bin/dns-forensics-report", ["--json"]],
];

const allowedCommands = new Set(commands.map(([, command]) => command));

function runReadOnlyCommand(command, args) {
  if (!allowedCommands.has(command)) {
    throw new Error(`collector command is not whitelisted: ${command}`);
  }

  if ((process.env.GHOSTROUTE_COLLECTOR_MODE || "local") === "ssh") {
    const host = process.env.GHOSTROUTE_READONLY_SSH_HOST;
    const user = process.env.GHOSTROUTE_READONLY_SSH_USER || "ghostroute_readonly";
    const key = process.env.GHOSTROUTE_READONLY_SSH_KEY_PATH || process.env.SSH_KEY_PATH || "/ssh/id_ed25519";
    const remoteRoot = process.env.GHOSTROUTE_READONLY_REMOTE_ROOT || "/opt/router_configuration";
    if (!host) throw new Error("GHOSTROUTE_READONLY_SSH_HOST is required in ssh collector mode");
    const remoteCommand = [path.posix.join(remoteRoot, command), ...args].join(" ");
    return execFileSync("ssh", [
      "-i",
      key,
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "UserKnownHostsFile=/tmp/ghostroute-known-hosts",
      `${user}@${host}`,
      remoteCommand,
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      timeout: 120000,
      maxBuffer: collectMaxBuffer,
    });
  }

  return execFileSync(path.join(repoRoot, command), args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    timeout: 120000,
    maxBuffer: collectMaxBuffer,
  });
}

function days(name, fallback) {
  const parsed = Number(process.env[name] || fallback);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function cutoffIso(retentionDays) {
  return new Date(Date.now() - retentionDays * 86400000).toISOString();
}

function pruneFiles(dir, retentionDays, predicate = () => true) {
  if (!fs.existsSync(dir)) return 0;
  const cutoff = Date.now() - retentionDays * 86400000;
  let deleted = 0;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (!predicate(name, file)) continue;
    const stat = fs.statSync(file);
    if (stat.isFile() && stat.mtimeMs < cutoff) {
      fs.unlinkSync(file);
      deleted += 1;
    }
  }
  return deleted;
}

function pruneFilesByCount(dir, maxFiles, predicate = () => true) {
  if (!fs.existsSync(dir) || maxFiles <= 0) return 0;
  const files = fs
    .readdirSync(dir)
    .map((name) => {
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      return { name, file, stat };
    })
    .filter(({ name, stat }) => stat.isFile() && predicate(name))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  let deleted = 0;
  for (const entry of files.slice(maxFiles)) {
    fs.unlinkSync(entry.file);
    deleted += 1;
  }
  return deleted;
}

function backupSqlite(dbFile) {
  if (!fs.existsSync(dbFile)) return "";
  const mode = process.env.GHOSTROUTE_DB_BACKUP_MODE || "daily";
  if (mode === "none" || mode === "disabled" || mode === "0") return "";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (mode === "daily") {
    const day = stamp.slice(0, 10);
    const existing = fs.readdirSync(backupsDir).some((name) => name.startsWith(`ghostroute-${day}`) && name.endsWith(".db"));
    if (existing) return "";
  }
  const backupPath = path.join(backupsDir, `ghostroute-${stamp}.db`);
  fs.copyFileSync(dbFile, backupPath);
  return backupPath;
}

function applyRetention() {
  const rawDays = days("GHOSTROUTE_RAW_RETENTION_DAYS", 7);
  const hourlyDays = days("GHOSTROUTE_HOURLY_RETENTION_DAYS", 30);
  const backupDays = days("GHOSTROUTE_BACKUP_RETENTION_DAYS", 2);
  const backupMaxFiles = Number(process.env.GHOSTROUTE_DB_BACKUP_MAX_FILES || 2);
  const backupPath = backupSqlite(path.join(dataDir, "ghostroute.db"));
  const rawDeleted = pruneFiles(snapshotDir, rawDays, (name) => name.endsWith(".json"));
  let backupsDeleted = pruneFiles(backupsDir, backupDays, (name) => name.endsWith(".db"));
  backupsDeleted += pruneFilesByCount(backupsDir, backupMaxFiles, (name) => name.endsWith(".db"));
  const snapshotRows = db
    .prepare("delete from snapshots where collected_at < ?")
    .run(cutoffIso(rawDays)).changes;
  db.prepare("delete from hourly_traffic where hour_key < ?").run(cutoffIso(hourlyDays));
  db.prepare(
    `insert into retention_runs(ran_at, raw_deleted, snapshot_rows_deleted, backups_deleted, backup_path)
     values (?, ?, ?, ?, ?)`
  ).run(new Date().toISOString(), rawDeleted, snapshotRows, backupsDeleted, backupPath);
}

const insert = db.prepare("insert into snapshots(type, collected_at, source, path, payload_json) values (?, ?, ?, ?, ?)");
const insertError = db.prepare(
  "insert into collector_errors(run_id, type, collected_at, command, message, output_sample) values (?, ?, ?, ?, ?, ?)"
);
const run = db
  .prepare("insert into collector_runs(started_at, ok_count, error_count) values (?, 0, 0)")
  .run(new Date().toISOString());
const runId = Number(run.lastInsertRowid);
let ok = 0;
let errors = 0;
for (const [type, command, args] of commands) {
  try {
    const stdout = runReadOnlyCommand(command, args);
    const payload = JSON.parse(stdout);
    const collectedAt = payload.generated_at || new Date().toISOString();
    const file = path.join(snapshotDir, `${type}-${collectedAt.replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));
    const result = insert.run(type, collectedAt, payload.source?.command || command, file, JSON.stringify(payload));
    normalizeSnapshot(db, Number(result.lastInsertRowid), type, collectedAt, payload);
    ok += 1;
    console.log(`stored ${type}: ${file}`);
  } catch (error) {
    const sample = String(error.stdout || error.stderr || error.message || "").slice(0, 1000);
    insertError.run(runId, type, new Date().toISOString(), [command, ...args].join(" "), error.message, sample);
    errors += 1;
    console.error(`skipped ${type}: ${error.message}`);
  }
}

rebuildHourlyAggregates(db);
rebuildObservabilityReadModels(db);
applyRetention();

db.prepare("update collector_runs set finished_at = ?, ok_count = ?, error_count = ? where id = ?").run(
  new Date().toISOString(),
  ok,
  errors,
  runId
);
console.log(`collector complete: ${ok}/${commands.length} snapshots stored`);
