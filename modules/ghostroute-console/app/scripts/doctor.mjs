#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";

const appDir = path.resolve(new URL("..", import.meta.url).pathname);
const moduleDir = path.resolve(appDir, "..");
const dataDir = process.env.GHOSTROUTE_CONSOLE_DATA_DIR || path.resolve(moduleDir, "data");
const snapshotDir = path.join(dataDir, "snapshots");
const dbFile = path.join(dataDir, "ghostroute.db");

console.log(`data_dir=${dataDir}`);
console.log(`snapshots_dir=${snapshotDir}`);
console.log(`db=${dbFile}`);
console.log(`collector_mode=${process.env.GHOSTROUTE_COLLECTOR_MODE || "disabled"}`);
console.log(`collect_interval_seconds=${process.env.GHOSTROUTE_COLLECT_INTERVAL_SECONDS || "300"}`);

if (!fs.existsSync(snapshotDir)) {
  console.log("snapshots=0");
  process.exit(0);
}

const files = fs.readdirSync(snapshotDir).filter((file) => file.endsWith(".json"));
console.log(`snapshots=${files.length}`);

if (fs.existsSync(dbFile)) {
  const db = new Database(dbFile, { readonly: true });
  const count = db.prepare("select count(*) as count from snapshots").get().count;
  console.log(`db_snapshots=${count}`);
  const migrations = db
    .prepare("select version, applied_at from schema_migrations order by version")
    .all()
    .map((row) => `${row.version}@${row.applied_at}`)
    .join(",");
  console.log(`schema_migrations=${migrations || "none"}`);
  const latest = db.prepare("select max(collected_at) as latest from snapshots").get().latest;
  console.log(`latest_snapshot=${latest || "n/a"}`);
  if (latest) {
    const minutes = Math.max(0, Math.round((Date.now() - Date.parse(latest)) / 60000));
    console.log(`freshness_minutes=${minutes}`);
  }
  for (const table of [
    "normalized_devices",
    "normalized_flows",
    "normalized_dns",
    "normalized_health",
    "normalized_catalog",
    "normalized_alerts",
    "collector_errors",
    "collector_runs",
    "hourly_traffic",
    "retention_runs",
  ]) {
    const exists = db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(table);
    if (!exists) continue;
    const rows = db.prepare(`select count(*) as count from ${table}`).get().count;
    console.log(`${table}=${rows}`);
  }
  const recentError = db
    .prepare("select type, message from collector_errors order by collected_at desc limit 1")
    .get();
  if (recentError) console.log(`latest_collector_error=${recentError.type}: ${recentError.message}`);
  db.close();
}

for (const [label, command] of [
  ["traffic", "modules/traffic-observatory/bin/traffic-report"],
  ["health", "modules/ghostroute-health-monitor/bin/router-health-report"],
  ["leaks", "modules/ghostroute-health-monitor/bin/leak-check"],
  ["domains", "modules/dns-catalog-intelligence/bin/domain-report"],
  ["dns", "modules/dns-catalog-intelligence/bin/dns-forensics-report"],
]) {
  const full = path.join(process.env.GHOSTROUTE_CONSOLE_REPO_ROOT || path.resolve(moduleDir, "../.."), command);
  console.log(`command_${label}=${fs.existsSync(full) ? "present" : "missing"}`);
}

try {
  const response = execFileSync("node", ["-e", "require('http').get('http://127.0.0.1:3000/api/health',r=>{console.log(r.statusCode); r.resume();}).on('error',()=>process.exit(2))"], {
    encoding: "utf8",
    timeout: 5000,
  }).trim();
  console.log(`local_health_http=${response}`);
} catch {
  console.log("local_health_http=unreachable");
}
