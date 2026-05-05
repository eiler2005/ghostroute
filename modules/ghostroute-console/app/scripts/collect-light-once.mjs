#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ensureConsoleSchema, normalizeSnapshot, rebuildObservabilityReadModels } from "./lib/normalize.mjs";
import { acquireSharedCollectorLock } from "./lib/collector-lock.mjs";

const appDir = path.resolve(new URL("..", import.meta.url).pathname);
const moduleDir = path.resolve(appDir, "..");
const repoRoot = process.env.GHOSTROUTE_CONSOLE_REPO_ROOT || path.resolve(moduleDir, "../..");
const dataDir = process.env.GHOSTROUTE_CONSOLE_DATA_DIR || path.resolve(moduleDir, "data");
const snapshotDir = path.join(dataDir, "snapshots");
const collectMaxBuffer = Math.max(1024 * 1024, Number(process.env.GHOSTROUTE_LIGHT_COLLECT_MAX_BUFFER_BYTES || 16 * 1024 * 1024));
fs.mkdirSync(snapshotDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const lockFile = path.join(dataDir, "light-collector.lock");
let lockFd = null;
try {
  const stat = fs.statSync(lockFile);
  const maxAgeMs = Math.max(30000, Number(process.env.GHOSTROUTE_LIGHT_COLLECT_TIMEOUT_SECONDS || 45) * 1000 * 2);
  if (Date.now() - stat.mtimeMs > maxAgeMs) fs.unlinkSync(lockFile);
} catch {
  // No existing lock.
}
try {
  lockFd = fs.openSync(lockFile, "wx");
  fs.writeFileSync(lockFd, `${process.pid} ${new Date().toISOString()}\n`);
} catch {
  console.log("light collector skipped: another collect-light-once run is active");
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
acquireSharedCollectorLock(dataDir, "light collector");

const db = new Database(path.join(dataDir, "ghostroute.db"));
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 10000");
ensureConsoleSchema(db);

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

try {
  const stdout = runReadOnlyCommand(["--json", "today"]);
  const payload = JSON.parse(stdout);
  const collectedAt = payload.generated_at || new Date().toISOString();
  const file = path.join(snapshotDir, `traffic_summary-${collectedAt.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  const result = db
    .prepare("insert into snapshots(type, collected_at, source, path, payload_json) values (?, ?, ?, ?, ?)")
    .run("traffic_summary", collectedAt, payload.source?.command || command, file, JSON.stringify(payload));
  normalizeSnapshot(db, Number(result.lastInsertRowid), "traffic_summary", collectedAt, payload);
  rebuildObservabilityReadModels(db);
  const rawDays = days("GHOSTROUTE_RAW_RETENTION_DAYS", 7);
  pruneFiles(snapshotDir, rawDays, (name) => name.endsWith(".json"));
  db.prepare("delete from snapshots where collected_at < ?").run(cutoffIso(rawDays));
  console.log(`stored traffic_summary: ${file}`);
} catch (error) {
  const sample = String(error.stdout || error.stderr || error.message || "").slice(0, 1000);
  console.error(`skipped traffic_summary: ${sample || error.message}`);
  process.exit(1);
}
