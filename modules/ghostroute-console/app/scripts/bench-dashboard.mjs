#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";

const appDir = path.resolve(import.meta.dirname, "..");
const moduleDir = path.resolve(appDir, "..");
const dataDir = process.env.GHOSTROUTE_CONSOLE_DATA_DIR || path.resolve(moduleDir, "data");
const dbFile = path.join(dataDir, "ghostroute.db");
const db = new Database(dbFile, { readonly: true, fileMustExist: true });
const durations = [];

for (let i = 0; i < 50; i += 1) {
  for (const window of ["today", "week", "month"]) {
    for (const trafficClass of ["all", "client", "personal_cloud", "service_background", "unclassified"]) {
      const started = performance.now();
      const row = db
        .prepare("select payload_json from traffic_window_snapshots where kind = 'dashboard' and window = ? and traffic_class = ?")
        .get(window, trafficClass);
      assert.ok(row, `missing dashboard prepared window ${window}/${trafficClass}`);
      JSON.parse(row.payload_json || "{}");
      durations.push(performance.now() - started);
    }
  }
}

durations.sort((a, b) => a - b);
const p95 = durations[Math.floor(durations.length * 0.95)] || 0;
db.close();
console.log(`dashboard_prepared_p95_ms=${p95.toFixed(2)}`);
assert.ok(p95 < Number(process.env.GHOSTROUTE_DASHBOARD_BENCH_P95_MS || 500), `dashboard prepared p95 too high: ${p95}`);
