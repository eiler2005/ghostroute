#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import Database from "better-sqlite3";

const appDir = path.resolve(import.meta.dirname, "..");
const moduleDir = path.resolve(appDir, "..");
const dataDir = process.env.GHOSTROUTE_CONSOLE_DATA_DIR || path.resolve(moduleDir, "data");
const dbFile = path.join(dataDir, "ghostroute.db");
const db = new Database(dbFile, { readonly: true, fileMustExist: true });

function payload(kind, window) {
  const row = db
    .prepare("select payload_json from traffic_window_snapshots where kind = ? and window = ? and traffic_class = 'client'")
    .get(kind, window);
  return row ? JSON.parse(row.payload_json || "{}") : null;
}

for (const window of ["today", "week", "month"]) {
  const dashboard = payload("dashboard", window);
  assert.ok(dashboard, `missing prepared dashboard ${window}`);
  const source = window === "today" ? "client_traffic_hourly" : "client_traffic_daily";
  const keyColumn = window === "today" ? "hour_start_utc" : "day_start_utc";
  const row = db
    .prepare(
      `select sum(bytes) as bytes, sum(via_vps_bytes) as via_vps_bytes, sum(direct_bytes) as direct_bytes
         from ${source}
        where traffic_class = 'client'
          and ${keyColumn} >= ?
          and ${keyColumn} <= ?`
    )
    .get(dashboard.windowStartUtc, dashboard.windowEndUtc);
  const aggregateBytes = Number(row?.bytes || 0);
  const preparedBytes = Number(dashboard.destinationAttributionCoverage?.observed_bytes || dashboard.totals?.observedBytes || 0);
  const allowed = Math.max(1, aggregateBytes * 0.01);
  assert.ok(Math.abs(aggregateBytes - preparedBytes) <= allowed, `${window} aggregate drift: aggregate=${aggregateBytes} prepared=${preparedBytes}`);
}

db.close();
console.log("aggregate windows ok");
