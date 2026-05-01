#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ensureConsoleSchema, normalizeSnapshot } from "./lib/normalize.mjs";

const appDir = path.resolve(new URL("..", import.meta.url).pathname);
const moduleDir = path.resolve(appDir, "..");
const repoRoot = process.env.GHOSTROUTE_CONSOLE_REPO_ROOT || path.resolve(moduleDir, "../..");
const dataDir = process.env.GHOSTROUTE_CONSOLE_DATA_DIR || path.resolve(moduleDir, "data");
const snapshotDir = path.join(dataDir, "snapshots");
fs.mkdirSync(snapshotDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const lockFile = path.join(dataDir, "live-collector.lock");
let lockFd = null;
try {
  const stat = fs.statSync(lockFile);
  const maxAgeMs = Math.max(10000, Number(process.env.GHOSTROUTE_LIVE_TIMEOUT_SECONDS || 30) * 1000 * 2);
  if (Date.now() - stat.mtimeMs > maxAgeMs) fs.unlinkSync(lockFile);
} catch {
  // No existing lock.
}
try {
  lockFd = fs.openSync(lockFile, "wx");
  fs.writeFileSync(lockFd, `${process.pid} ${new Date().toISOString()}\n`);
} catch {
  console.log("live collector skipped: another collect-live-once run is active");
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

const command = "modules/traffic-observatory/bin/live-events-report";
const limit = String(Math.max(1, Math.min(1000, Number(process.env.GHOSTROUTE_LIVE_LIMIT || 200))));

function cutoffIsoHours(retentionHours) {
  return new Date(Date.now() - retentionHours * 3600000).toISOString();
}

function pruneLiveSnapshots(retentionHours) {
  const cutoffMs = Date.now() - retentionHours * 3600000;
  let deleted = 0;
  for (const name of fs.readdirSync(snapshotDir)) {
    if (!name.startsWith("live-") || !name.endsWith(".json")) continue;
    const file = path.join(snapshotDir, name);
    const stat = fs.statSync(file);
    if (stat.isFile() && stat.mtimeMs < cutoffMs) {
      fs.unlinkSync(file);
      deleted += 1;
    }
  }
  const rows = db
    .prepare("delete from snapshots where type = 'live' and collected_at < ?")
    .run(cutoffIsoHours(retentionHours)).changes;
  return { files: deleted, rows };
}

function cursor() {
  try {
    return db.prepare("select cursor from live_cursors where source = ?").get("live-events-report")?.cursor || "";
  } catch {
    return "";
  }
}

function runReadOnlyCommand(args) {
  const mode = process.env.GHOSTROUTE_LIVE_COLLECTOR_MODE || process.env.GHOSTROUTE_COLLECTOR_MODE || "local";
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
      timeout: 20000,
    });
  }

  return execFileSync(path.join(repoRoot, command), args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    timeout: 20000,
  });
}

const args = ["--json", "--limit", limit];
const since = cursor();
if (since) args.push("--since", since);

const stdout = runReadOnlyCommand(args);
const payload = JSON.parse(stdout);
const collectedAt = payload.generated_at || new Date().toISOString();
const file = path.join(snapshotDir, `live-${collectedAt.replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(file, JSON.stringify(payload, null, 2));
const result = db
  .prepare("insert into snapshots(type, collected_at, source, path, payload_json) values (?, ?, ?, ?, ?)")
  .run("live", collectedAt, payload.source?.command || command, file, JSON.stringify(payload));
normalizeSnapshot(db, Number(result.lastInsertRowid), "live", collectedAt, payload);
const liveRetentionHours = Math.max(1, Number(process.env.GHOSTROUTE_LIVE_RAW_RETENTION_HOURS || 6));
const pruned = pruneLiveSnapshots(liveRetentionHours);
console.log(
  `stored live: ${payload.events?.length || 0} events, cursor=${payload.cursor?.next || ""}, pruned=${pruned.files}/${pruned.rows}`
);
