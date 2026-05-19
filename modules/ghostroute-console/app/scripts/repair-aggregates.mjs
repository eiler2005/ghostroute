#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ensureConsoleSchema, rebuildAllTrafficReadModels, repairAggregateRange } from "./lib/normalize.mjs";
import { acquireCollectorLock, acquireSharedCollectorLock } from "./lib/collector-lock.mjs";
import { parseSourceTimestamp, toUtcIsoFromMskKey } from "../src/lib/time/window.mjs";

const appDir = path.resolve(import.meta.dirname, "..");
const moduleDir = path.resolve(appDir, "..");
const dataDir = path.resolve(process.env.GHOSTROUTE_CONSOLE_DATA_DIR || path.resolve(moduleDir, "data"));
const dbFile = path.join(dataDir, "ghostroute.db");

function usage() {
  console.error("Usage: ghostroute-console repair-aggregates --from <YYYY-MM-DD|ISO> [--to <YYYY-MM-DD|ISO>] [--dry-run]");
  console.error("       ghostroute-console repair-aggregates --full [--from <YYYY-MM-DD|ISO>] [--to <YYYY-MM-DD|ISO>]");
}

function parseArgs(argv) {
  const result = { from: "", to: "", dryRun: false, full: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      result.dryRun = true;
    } else if (arg === "--full") {
      result.full = true;
    } else if (arg === "--from") {
      result.from = argv[++i] || "";
    } else if (arg === "--to") {
      result.to = argv[++i] || "";
    } else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown repair-aggregates argument: ${arg}`);
    }
  }
  if (!result.full && !result.from) throw new Error("--from is required");
  return result;
}

function rangeBoundary(value, isEnd = false) {
  const text = String(value || "").trim();
  if (!text) return new Date().toISOString();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return toUtcIsoFromMskKey(text, "day");
  return parseSourceTimestamp(text);
}

function compactResult(result) {
  return {
    status: result.status,
    dry_run: Boolean(result.dryRun),
    repaired: Boolean(result.repaired),
    from_utc: result.fromUtc,
    to_utc: result.toUtc,
    fact_count: result.factCount || 0,
    source_rows: {
      normalized_flows: Number(result.source?.normalized_flows?.rows || 0),
      flow_sessions: Number(result.source?.flow_sessions?.rows || 0),
      normalized_dns: Number(result.source?.normalized_dns?.rows || 0),
      dns_query_log: Number(result.source?.dns_query_log?.rows || 0),
    },
    windows: (result.windows || []).map((row) => ({ window: row.window, rows: row.rows, clients: row.clients })),
  };
}

async function backupDbFile(db, dbFile) {
  const backupDir = path.join(path.dirname(dbFile), "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, `${path.basename(dbFile)}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await db.backup(backupFile);
  return backupFile;
}

function earliestSourceTimestamp(db) {
  const candidates = [];
  for (const [table, column] of [
    ["normalized_flows", "collected_at"],
    ["flow_sessions", "collected_at"],
    ["normalized_dns", "collected_at"],
    ["dns_query_log", "collected_at"],
  ]) {
    try {
      const row = db.prepare(`select min(${column}) as min_ts from ${table}`).get();
      if (row?.min_ts) candidates.push(row.min_ts);
    } catch {
      // Best-effort helper for partial/local DBs.
    }
  }
  return candidates.filter(Boolean).sort()[0] || "";
}

let lockRelease = null;
let writerRelease = null;
let db = null;

try {
  const args = parseArgs(process.argv.slice(2));
  const fromUtc = args.from ? rangeBoundary(args.from, false) : "";
  const toUtc = rangeBoundary(args.to, true);
  if (fromUtc && Date.parse(fromUtc) >= Date.parse(toUtc)) throw new Error("--from must be earlier than --to");
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dbFile)) throw new Error(`SQLite database does not exist: ${dbFile}`);
  if (!args.dryRun) {
    lockRelease = acquireCollectorLock(
      path.join(dataDir, "collector.lock"),
      "repair-aggregates",
      Math.max(600000, Number(process.env.GHOSTROUTE_COLLECT_TIMEOUT_SECONDS || 900) * 1000 * 2),
      { waitMs: Math.max(0, Number(process.env.GHOSTROUTE_REPAIR_LOCK_WAIT_SECONDS || 120) * 1000) }
    );
    if (!lockRelease) {
      console.log("repair-aggregates skipped: another collector run is active");
      process.exit(0);
    }
    writerRelease = acquireSharedCollectorLock(dataDir, "repair-aggregates");
  }
  db = new Database(dbFile, args.dryRun ? { readonly: true, fileMustExist: true } : undefined);
  db.pragma("busy_timeout = 10000");
  if (!args.dryRun) ensureConsoleSchema(db);
  let backupPath = "";
  if (args.full && !args.dryRun) backupPath = await backupDbFile(db, dbFile);
  const fullFromUtc = fromUtc || earliestSourceTimestamp(db) || new Date(Date.now() - 86400000).toISOString();
  const result = args.full
    ? (args.dryRun
        ? repairAggregateRange(db, { fromUtc: fullFromUtc, toUtc, dryRun: true })
        : db.transaction(() => rebuildAllTrafficReadModels(db, { fromUtc, toUtc }))())
    : (args.dryRun
        ? repairAggregateRange(db, { fromUtc, toUtc, dryRun: true })
        : db.transaction(() => repairAggregateRange(db, { fromUtc, toUtc }))());
  console.log(JSON.stringify({ ...compactResult(result), full_rebuild: Boolean(args.full), backup_path: backupPath }, null, 2));
} catch (error) {
  usage();
  console.error(`repair-aggregates failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  try {
    db?.close();
  } catch {
    // Best-effort close.
  }
  try {
    writerRelease?.();
  } catch {
    // Best-effort unlock.
  }
  try {
    lockRelease?.();
  } catch {
    // Best-effort unlock.
  }
}
