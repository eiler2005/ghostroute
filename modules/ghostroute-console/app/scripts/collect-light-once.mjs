#!/usr/bin/env node
import { trafficRetentionDays, pruneTrafficHistory } from "./lib/traffic-retention.mjs";
import { pruneSnapshotFiles, pruneSnapshotMetadata } from "./lib/snapshot-retention.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ensureConsoleSchema, normalizeSnapshot, pruneOperationalTables, rebuildHourlyAggregates, rebuildObservabilityReadModels } from "./lib/normalize.mjs";
import { acquireCollectorLock, acquireSharedCollectorLock } from "./lib/collector-lock.mjs";
import { recordCollectorError } from "./lib/collector-errors.mjs";
import { validateSnapshotPayload } from "./lib/snapshot-contracts.mjs";

const appDir = path.resolve(new URL("..", import.meta.url).pathname);
const moduleDir = path.resolve(appDir, "..");
const repoRoot = process.env.GHOSTROUTE_CONSOLE_REPO_ROOT || path.resolve(moduleDir, "../..");
const dataDir = process.env.GHOSTROUTE_CONSOLE_DATA_DIR || path.resolve(moduleDir, "data");
const snapshotDir = path.join(dataDir, "snapshots");
const collectMaxBuffer = Math.max(1024 * 1024, Number(process.env.GHOSTROUTE_LIGHT_COLLECT_MAX_BUFFER_BYTES || 16 * 1024 * 1024));
fs.mkdirSync(snapshotDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const lockFile = path.join(dataDir, "light-collector.lock");
const lockRelease = acquireCollectorLock(
  lockFile,
  "light collector",
  Math.max(30000, Number(process.env.GHOSTROUTE_LIGHT_COLLECT_TIMEOUT_SECONDS || 45) * 1000 * 2)
);
if (!lockRelease) {
  console.log("light collector skipped: another collect-light-once run is active");
  process.exit(0);
}

const command = "modules/traffic-observatory/bin/traffic-summary";

function runReadOnlyCommand(args) {
  const mode = process.env.GHOSTROUTE_LIGHT_COLLECTOR_MODE || process.env.GHOSTROUTE_COLLECTOR_MODE || "local";
  if (mode === "ssh") {
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
      timeout: Math.max(30000, Number(process.env.GHOSTROUTE_LIGHT_COLLECT_TIMEOUT_SECONDS || 45) * 1000),
      maxBuffer: collectMaxBuffer,
    });
  }

  return execFileSync(path.join(repoRoot, command), args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    timeout: Math.max(30000, Number(process.env.GHOSTROUTE_LIGHT_COLLECT_TIMEOUT_SECONDS || 45) * 1000),
    maxBuffer: collectMaxBuffer,
  });
}

function days(name, fallback) {
  const parsed = Number(process.env[name] || fallback);
  return trafficRetentionDays(parsed, fallback, 0);
}

function cutoffIso(retentionDays) {
  return new Date(Date.now() - retentionDays * 86400000).toISOString();
}

try {
  const stdout = runReadOnlyCommand(["--json", "today"]);
  const payload = JSON.parse(stdout);
  validateSnapshotPayload("traffic_summary", payload);
  const collectedAt = payload.generated_at || new Date().toISOString();
  const file = path.join(snapshotDir, `traffic_summary-${collectedAt.replace(/[:.]/g, "-")}.json`);

  const writerRelease = acquireSharedCollectorLock(dataDir, "light collector");
  let db = null;
  try {
    db = new Database(path.join(dataDir, "ghostroute.db"));
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 10000");
    ensureConsoleSchema(db);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));
    const result = db
      .prepare("insert into snapshots(type, collected_at, source, path, payload_json) values (?, ?, ?, ?, ?)")
      .run("traffic_summary", collectedAt, payload.source?.command || command, file, JSON.stringify(payload));
    normalizeSnapshot(db, Number(result.lastInsertRowid), "traffic_summary", collectedAt, payload);
    pruneOperationalTables(db);
    rebuildObservabilityReadModels(db);
    rebuildHourlyAggregates(db);
    pruneTrafficHistory(db, new Date().toISOString());
    const rawDays = days("GHOSTROUTE_RAW_RETENTION_DAYS", 7);
    pruneSnapshotFiles(db, snapshotDir);
    pruneSnapshotMetadata(db, cutoffIso(rawDays));
  } finally {
    try {
      db?.close();
    } catch {
      // Best-effort close.
    }
    writerRelease();
  }
  console.log(`stored traffic_summary: ${file}`);
} catch (error) {
  const sample = String(error.stdout || error.stderr || error.message || "").slice(0, 1000);
  recordCollectorError({
    dataDir,
    type: "traffic_summary",
    command,
    args: ["--json", "today"],
    error,
    sample,
  });
  console.error(`skipped traffic_summary: ${sample || error.message}`);
  process.exit(1);
} finally {
  lockRelease();
}
