#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import Database from "better-sqlite3";
import { loadDeviceAttributions } from "../src/lib/device-attribution.mjs";
import { bucketStartUtc, mskWindowBounds } from "../src/lib/time/window.mjs";

const appDir = path.resolve(import.meta.dirname, "..");
const moduleDir = path.resolve(appDir, "..");
const dataDir = process.env.GHOSTROUTE_CONSOLE_DATA_DIR || path.resolve(moduleDir, "data");
const dbFile = path.join(dataDir, "ghostroute.db");
const db = new Database(dbFile, { readonly: true, fileMustExist: true });
const registry = loadDeviceAttributions(dataDir);

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoMinusHours(iso, hours) {
  return new Date(Date.parse(iso) - hours * 3600000).toISOString();
}

function isoPlusMs(iso, ms) {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function maxIso(...values) {
  return values.filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0] || "";
}

function concreteDestination(value) {
  const text = String(value || "").toLowerCase();
  return Boolean(text && text !== "unknown" && text !== "unknown destination" && text !== "n/a");
}

function payload(kind, window) {
  const row = db
    .prepare("select payload_json from traffic_window_snapshots where kind = ? and window = ? and traffic_class = 'client'")
    .get(kind, window);
  return row ? JSON.parse(row.payload_json || "{}") : null;
}

function aggregateSegments(window, now) {
  const bounds = mskWindowBounds(window, now);
  const todayStart = mskWindowBounds("today", now).startUtc;
  const freshHours = Math.max(1, number(process.env.GHOSTROUTE_PREPARED_FINE_HOURS || 2));
  const freshStart = maxIso(todayStart, bucketStartUtc(isoMinusHours(now, freshHours), "hour"));
  const endExclusive = isoPlusMs(bounds.endUtc, 1);
  const segments = [];
  if (window !== "today" && Date.parse(bounds.startUtc) < Date.parse(todayStart)) {
    segments.push({ layer: "daily", start: bounds.startUtc, end: todayStart });
  }
  const hourlyStart = maxIso(bounds.startUtc, todayStart);
  if (Date.parse(hourlyStart) < Date.parse(freshStart)) segments.push({ layer: "hourly", start: hourlyStart, end: freshStart });
  if (Date.parse(freshStart) < Date.parse(endExclusive)) segments.push({ layer: "5min", start: freshStart, end: endExclusive });
  return segments;
}

function segmentRows(segment) {
  const table = segment.layer === "daily" ? "client_traffic_daily" : segment.layer === "hourly" ? "client_traffic_hourly" : "client_traffic_5min";
  const timeColumn = segment.layer === "daily" ? "day_start_utc" : segment.layer === "hourly" ? "hour_start_utc" : "bucket_start_utc";
  return db.prepare(`
    select client_key, channel, destination_key, traffic_class, confidence, bytes, via_vps_bytes, direct_bytes, unknown_bytes,
           attributed_bytes,
           case when attributed_bytes <= 0 or destination_key = '' or destination_key = 'unknown destination' then 1 else 0 end as accounting_bucket
      from ${table}
     where ${timeColumn} >= ?
       and ${timeColumn} < ?
       and traffic_class = 'client'
  `).all(segment.start, segment.end);
}

function composedRows(window, now) {
  return aggregateSegments(window, now).flatMap(segmentRows);
}

function observedBytes(rows, allowedClientKeys = null) {
  const groups = new Map();
  for (const row of rows) {
    if (!registry.clients[row.client_key]) continue;
    if (allowedClientKeys && !allowedClientKeys.has(row.client_key)) continue;
    if (String(row.confidence || "").toLowerCase() === "dns-interest") continue;
    const key = [row.client_key, row.channel || ""].join("|");
    const current = groups.get(key) || { accounting: 0, detail: 0 };
    if (row.accounting_bucket) current.accounting += number(row.bytes);
    else current.detail += number(row.bytes);
    groups.set(key, current);
  }
  return Array.from(groups.values()).reduce((sum, row) => sum + (row.accounting > 0 ? row.accounting : row.detail), 0);
}

function rowTotalBytes(row) {
  const explicit = number(row.bytes || row.total_bytes);
  if (explicit > 0) return explicit;
  return number(row.via_vps_bytes || row.viaVpsBytes)
    + number(row.direct_bytes || row.directBytes)
    + number(row.unknown_bytes || row.unknownBytes);
}

function repairHint(window, dashboard) {
  return `./modules/ghostroute-console/bin/ghostroute-console repair-aggregates --from ${dashboard.windowStartUtc} --to ${dashboard.windowEndUtc}`;
}

for (const window of ["today", "week", "month"]) {
  const dashboard = payload("dashboard", window);
  assert.ok(dashboard, `missing prepared dashboard ${window}`);
  const rows = composedRows(window, dashboard.windowEndUtc);
  const preparedDevices = dashboard.devices || [];
  const preparedClientKeys = new Set(preparedDevices.map((row) => row.client_key).filter(Boolean));
  const aggregateBytes = observedBytes(rows, preparedClientKeys);
  const preparedBytes = preparedDevices.reduce((sum, row) => sum + rowTotalBytes(row), 0)
    || number(dashboard.destinationAttributionCoverage?.observed_bytes || dashboard.totals?.observedBytes);
  const allowed = Math.max(1, aggregateBytes * 0.01);
  if (Math.abs(aggregateBytes - preparedBytes) > allowed) {
    console.warn(`${window} aggregate drift: aggregate=${aggregateBytes} prepared=${preparedBytes}; repair: ${repairHint(window, dashboard)}`);
  }

  const state = db
    .prepare("select status, detail_json from aggregate_state where model = 'dashboard' and window_key = ?")
    .get(window);
  assert.ok(state, `missing aggregate_state dashboard/${window}; repair: ${repairHint(window, dashboard)}`);
  assert.ok(["ok", "partial"].includes(state.status), `aggregate_state dashboard/${window} status=${state.status}; repair: ${repairHint(window, dashboard)}`);

  const concreteOperatorBytes = rows
    .filter((row) => registry.clients[row.client_key] && concreteDestination(row.destination_key) && number(row.attributed_bytes) > 0)
    .reduce((sum, row) => sum + number(row.attributed_bytes), 0);
  const topDestinations = dashboard.dashboardAnalytics?.topDestinations || [];
  assert.ok(
    concreteOperatorBytes <= 0 || topDestinations.length > 0,
    `${window} has concrete destination bytes but no top destinations; repair: ${repairHint(window, dashboard)}`
  );
}

const topClients = db.prepare("select window, rank, client_key, label, bytes from top_clients_window where traffic_class = 'client'").all();
const pseudoClient = /^(A\/Home Reality|B\/XHTTP relay|C1?\b|Channel [BC]|Home Reality)$/i;
const badClients = topClients.filter((row) => number(row.bytes) <= 0 || pseudoClient.test(String(row.label || "")) || !registry.clients[row.client_key]);
assert.equal(
  badClients.length,
  0,
  `bad prepared top clients: ${badClients.slice(0, 5).map((row) => `${row.window}#${row.rank}:${row.label || row.client_key}`).join(", ")}`
);

const badStates = db.prepare("select model, window_key, status from aggregate_state where status = 'error'").all();
assert.equal(
  badStates.length,
  0,
  `aggregate gaps require repair: ${badStates.slice(0, 5).map((row) => `${row.model}/${row.window_key}=${row.status}`).join(", ")}`
);
const missingSourceStates = db.prepare("select model, window_key from aggregate_state where status = 'missing_source'").all();
if (missingSourceStates.length > 0) {
  console.warn(`aggregate missing source warnings: ${missingSourceStates.slice(0, 5).map((row) => `${row.model}/${row.window_key}`).join(", ")}`);
}

db.close();
console.log("aggregate windows ok");
