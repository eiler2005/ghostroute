#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ensureConsoleSchema, normalizeSnapshot, pruneOperationalTables, rebuildHourlyAggregates, rebuildObservabilityReadModels } from "./lib/normalize.mjs";
import { acquireCollectorLock, acquireSharedCollectorLock } from "./lib/collector-lock.mjs";
import { validateSnapshotPayload, withSnapshotContractDefaults } from "./lib/snapshot-contracts.mjs";
import { runSqliteBackupRetention } from "./lib/sqlite-backups.mjs";

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
const lockRelease = acquireCollectorLock(
  lockFile,
  "collector",
  Math.max(30000, Number(process.env.GHOSTROUTE_COLLECT_TIMEOUT_SECONDS || 900) * 1000 * 2)
);
if (!lockRelease) {
  console.log("collector skipped: another collect-once run is active");
  process.exit(0);
}

let db = null;

const commands = [
  ["traffic_summary", "modules/traffic-observatory/bin/traffic-summary", ["--json", "today"]],
  ["router_rollups", "modules/traffic-observatory/bin/traffic-rollup-export", ["--json", process.env.GHOSTROUTE_CONSOLE_PERIOD || "today"], { allowFailure: true, retries: 1 }],
  ["traffic_evidence", "modules/traffic-observatory/bin/traffic-evidence", ["--json", process.env.GHOSTROUTE_CONSOLE_PERIOD || "today"], { allowFailure: true, retries: 1 }],
  ["traffic_facts", "modules/traffic-observatory/bin/traffic-facts", ["--json", process.env.GHOSTROUTE_CONSOLE_PERIOD || "today"]],
  ["health", "modules/ghostroute-health-monitor/bin/router-health-report", ["--json"], { allowFailure: true, retries: 1 }],
  ["deploy_gate", "modules/ghostroute-health-monitor/bin/live-check", ["--json", "--active-probe", "--deploy-gate", "--no-log"], { allowFailure: true, retries: 1 }],
  ["leaks", "modules/ghostroute-health-monitor/bin/leak-check", ["--json"], { timeoutMs: 300000 }],
  ["domains", "modules/dns-catalog-intelligence/bin/domain-report", ["--json", "--all"]],
  ["dns", "modules/dns-catalog-intelligence/bin/dns-forensics-report", ["--json"]],
];

const allowedCommands = new Set(commands.map(([, command]) => command));

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runReadOnlyCommandOnce(command, args, options = {}) {
  if (!allowedCommands.has(command)) {
    throw new Error(`collector command is not whitelisted: ${command}`);
  }
  const commandTimeoutMs = Math.max(30000, Number(options.timeoutMs || process.env.GHOSTROUTE_COLLECT_COMMAND_TIMEOUT_MS || 120000));

  if ((process.env.GHOSTROUTE_COLLECTOR_MODE || "local") === "ssh") {
    const host = process.env.GHOSTROUTE_READONLY_SSH_HOST;
    const user = process.env.GHOSTROUTE_READONLY_SSH_USER || "ghostroute_readonly";
    const key = process.env.GHOSTROUTE_READONLY_SSH_KEY_PATH || process.env.SSH_KEY_PATH || "/ssh/id_ed25519";
    const remoteRoot = process.env.GHOSTROUTE_READONLY_REMOTE_ROOT || "/opt/router_configuration";
    if (!host) throw new Error("GHOSTROUTE_READONLY_SSH_HOST is required in ssh collector mode");
    const remoteCommand = [path.posix.join(remoteRoot, command), ...args].join(" ");
    try {
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
        timeout: commandTimeoutMs,
        maxBuffer: collectMaxBuffer,
      });
    } catch (error) {
      if (options.allowFailure && error.stdout) return String(error.stdout);
      throw error;
    }
  }

  try {
    return execFileSync(path.join(repoRoot, command), args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      timeout: commandTimeoutMs,
      maxBuffer: collectMaxBuffer,
    });
  } catch (error) {
    if (options.allowFailure && error.stdout) return String(error.stdout);
    throw error;
  }
}

function runReadOnlyCommand(command, args, options = {}) {
  const attempts = Math.max(1, 1 + Number(options.retries || 0));
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return runReadOnlyCommandOnce(command, args, options);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) sleepMs(Math.min(5000, 750 * attempt));
    }
  }
  throw lastError;
}

function normalizePayloadContract(type, command, args, payload) {
  return withSnapshotContractDefaults(type, payload, { command, mode: (args || []).join(" ") });
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

function applyRetention() {
  const rawDays = days("GHOSTROUTE_RAW_RETENTION_DAYS", 7);
  const hourlyDays = days("GHOSTROUTE_HOURLY_RETENTION_DAYS", 30);
  const backupRetention = runSqliteBackupRetention({
    dataDir,
    backupsDir,
    dbFile: path.join(dataDir, "ghostroute.db"),
    env: process.env,
  });
  if (backupRetention.skippedReason && !["disabled", "missing-db", "already-backed-up-today"].includes(backupRetention.skippedReason)) {
    console.log(`sqlite backup skipped: ${backupRetention.skippedReason}`);
  }
  const rawDeleted = pruneFiles(snapshotDir, rawDays, (name) => name.endsWith(".json"));
  const snapshotRows = db
    .prepare("delete from snapshots where collected_at < ?")
    .run(cutoffIso(rawDays)).changes;
  db.prepare("delete from hourly_traffic where hour_key < ?").run(cutoffIso(hourlyDays));
  db.prepare(
    `insert into retention_runs(ran_at, raw_deleted, snapshot_rows_deleted, backups_deleted, backup_path)
     values (?, ?, ?, ?, ?)`
  ).run(new Date().toISOString(), rawDeleted, snapshotRows, backupRetention.backupsDeleted, backupRetention.backupPath);
}

const collected = [];
for (const [type, command, args, options = {}] of commands) {
  try {
    const stdout = runReadOnlyCommand(command, args, options);
    const payload = normalizePayloadContract(type, command, args, JSON.parse(stdout));
    validateSnapshotPayload(type, payload);
    const collectedAt = payload.generated_at || new Date().toISOString();
    const file = path.join(snapshotDir, `${type}-${collectedAt.replace(/[:.]/g, "-")}.json`);
    collected.push({ type, command, args, payload, collectedAt, file });
  } catch (error) {
    const sample = String(error.stdout || error.stderr || error.message || "").slice(0, 1000);
    collected.push({ type, command, args, error, sample });
    console.error(`skipped ${type}: ${error.message}`);
  }
}

const writerRelease = acquireSharedCollectorLock(dataDir, "collector");
try {
  db = new Database(path.join(dataDir, "ghostroute.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 10000");
  ensureConsoleSchema(db);

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

  for (const entry of collected) {
    if (entry.error) {
      insertError.run(
        runId,
        entry.type,
        new Date().toISOString(),
        [entry.command, ...entry.args].join(" "),
        entry.error.message,
        entry.sample
      );
      errors += 1;
      continue;
    }

    fs.writeFileSync(entry.file, JSON.stringify(entry.payload, null, 2));
    const result = insert.run(
      entry.type,
      entry.collectedAt,
      entry.payload.source?.command || entry.command,
      entry.file,
      JSON.stringify(entry.payload)
    );
    normalizeSnapshot(db, Number(result.lastInsertRowid), entry.type, entry.collectedAt, entry.payload);
    ok += 1;
    console.log(`stored ${entry.type}: ${entry.file}`);
  }

  pruneOperationalTables(db);
  rebuildObservabilityReadModels(db);
  rebuildHourlyAggregates(db);
  applyRetention();

  db.prepare("update collector_runs set finished_at = ?, ok_count = ?, error_count = ? where id = ?").run(
    new Date().toISOString(),
    ok,
    errors,
    runId
  );
  console.log(`collector complete: ${ok}/${commands.length} snapshots stored`);
} finally {
  try {
    db?.close();
  } catch {
    // Best-effort close.
  }
  writerRelease();
  lockRelease();
}
