#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import Database from "better-sqlite3";
import { isAttributableSiteRow } from "../src/lib/attribution-eligibility.mjs";
import { loadDeviceAttributions } from "../src/lib/device-attribution.mjs";
import { bucketStartUtc, mskWindowBounds } from "../src/lib/time/window.mjs";
import { deviceCounterRowsForWindow } from "./lib/normalize.mjs";

const appDir = path.resolve(import.meta.dirname, "..");
const moduleDir = path.resolve(appDir, "..");
const dataDir = process.env.GHOSTROUTE_CONSOLE_DATA_DIR || path.resolve(moduleDir, "data");
const dbFile = path.join(dataDir, "ghostroute.db");
const db = new Database(dbFile, { readonly: true, fileMustExist: true });
const registry = loadDeviceAttributions(dataDir);
const trafficClasses = ["all", "client", "personal_cloud", "service_background", "unclassified"];
const driftCheckedClasses = new Set(["all", "client"]);
const trafficDriftTolerance = Number(process.env.GHOSTROUTE_AGGREGATE_TRAFFIC_DRIFT_TOLERANCE || 0.3);
const strictTrafficDrift = process.env.GHOSTROUTE_AGGREGATE_STRICT_TRAFFIC_DRIFT === "1";

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

function concreteDestination(row) {
  return isAttributableSiteRow({
    destination: row.destination_key,
    destination_key: row.destination_key,
    destination_label: row.destination_key,
    traffic_class: row.traffic_class,
  });
}

function payload(kind, window, trafficClass = "client") {
  const row = db
    .prepare("select payload_json from traffic_window_snapshots where kind = ? and window = ? and traffic_class = ?")
    .get(kind, window, trafficClass);
  return row ? JSON.parse(row.payload_json || "{}") : null;
}

function tableExists(table) {
  return Boolean(db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(table));
}

for (const table of ["client_traffic_by_lane", "client_destination_by_lane", "client_route_evidence_defects", "ip_prefix_catalog", "ip_enrichment_cache"]) {
  assert.ok(tableExists(table), `missing ${table}`);
}

for (const table of ["client_traffic_by_lane", "client_destination_by_lane", "client_route_evidence_defects"]) {
  const bad = db.prepare(`
    select count(*) as count
      from ${table}
     where bytes < 0
        or via_vps_bytes < 0
        or direct_bytes < 0
        or unknown_bytes < 0
        or bytes != via_vps_bytes + direct_bytes + unknown_bytes
  `).get();
  assert.equal(number(bad.count), 0, `${table} has invalid byte splits`);
}

function aggregateSegments(window, now) {
  const bounds = mskWindowBounds(window, now);
  const todayStart = mskWindowBounds("today", now).startUtc;
  const weekStart = mskWindowBounds("week", now).startUtc;
  const freshHours = Math.max(1, number(process.env.GHOSTROUTE_PREPARED_FINE_HOURS || 2));
  const freshStart = maxIso(todayStart, bucketStartUtc(isoMinusHours(now, freshHours), "hour"));
  const endExclusive = isoPlusMs(bounds.endUtc, 1);
  const segments = [];
  if (window === "month" && Date.parse(bounds.startUtc) < Date.parse(weekStart)) {
    segments.push({ layer: "weekly", start: bounds.startUtc, end: weekStart });
  }
  const dailyStart = window === "month" ? maxIso(bounds.startUtc, weekStart) : bounds.startUtc;
  if (window !== "today" && Date.parse(dailyStart) < Date.parse(todayStart)) {
    segments.push({ layer: "daily", start: dailyStart, end: todayStart });
  }
  const hourlyStart = maxIso(bounds.startUtc, todayStart);
  if (Date.parse(hourlyStart) < Date.parse(freshStart)) segments.push({ layer: "hourly", start: hourlyStart, end: freshStart });
  if (Date.parse(freshStart) < Date.parse(endExclusive)) segments.push({ layer: "5min", start: freshStart, end: endExclusive });
  return segments;
}

function trafficClassPredicate(trafficClass) {
  if (trafficClass === "all") return { sql: "and traffic_class in ('client', 'personal_cloud', 'service_background', 'unclassified')", params: [] };
  return { sql: "and traffic_class = ?", params: [trafficClass] };
}

function segmentRows(segment, trafficClass = "client") {
  const detailTable = segment.layer === "weekly" ? "client_destination_traffic_weekly" : segment.layer === "daily" ? "client_destination_traffic_daily" : segment.layer === "hourly" ? "client_destination_traffic_hourly" : "client_destination_traffic_5min";
  const totalTable = segment.layer === "weekly" ? "client_traffic_weekly" : segment.layer === "daily" ? "client_traffic_daily" : segment.layer === "hourly" ? "client_traffic_hourly" : "client_traffic_5min";
  const timeColumn = segment.layer === "weekly" ? "week_start_utc" : segment.layer === "daily" ? "day_start_utc" : segment.layer === "hourly" ? "hour_start_utc" : "bucket_start_utc";
  const classPredicate = trafficClassPredicate(trafficClass);
  const detailRows = db.prepare(`
    select client_key, channel, destination_key, traffic_class, confidence, bytes, via_vps_bytes, direct_bytes, unknown_bytes,
           attributed_bytes, case when attributed_bytes <= 0 or destination_key = '' or destination_key = 'unknown destination' then 1 else 0 end as accounting_bucket
      from ${detailTable}
     where ${timeColumn} >= ?
       and ${timeColumn} < ?
       ${classPredicate.sql}
  `).all(segment.start, segment.end, ...classPredicate.params);
  const totalRows = db.prepare(`
    select client_key, channel, '' as destination_key, traffic_class, confidence, bytes, via_vps_bytes, direct_bytes, unknown_bytes,
           attributed_bytes, 1 as accounting_bucket
      from ${totalTable}
     where ${timeColumn} >= ?
       and ${timeColumn} < ?
       ${classPredicate.sql}
  `).all(segment.start, segment.end, ...classPredicate.params);
  return [...detailRows, ...totalRows];
}

function composedRows(window, now, trafficClass = "client") {
  return aggregateSegments(window, now).flatMap((segment) => segmentRows(segment, trafficClass));
}

function observedBytes(rows, allowedClientKeys = null) {
  const groups = new Map();
  for (const row of rows) {
    if (!registry.clients[row.client_key]) continue;
    if (allowedClientKeys && !allowedClientKeys.has(row.client_key)) continue;
    if (String(row.confidence || "").toLowerCase() === "dns-interest") continue;
    const key = [row.client_key, row.channel || ""].join("|");
    const current = groups.get(key) || { counter: 0, accounting: 0, detail: 0 };
    if (row.accounting_source === "device_counter_delta") current.counter += number(row.bytes);
    else if (row.accounting_bucket) current.accounting += number(row.bytes);
    else current.detail += number(row.bytes);
    groups.set(key, current);
  }
  return Array.from(groups.values()).reduce((sum, row) => sum + (row.counter > 0 ? row.counter : row.accounting > 0 ? row.accounting : row.detail), 0);
}

function rowTotalBytes(row) {
  const explicit = number(row.bytes || row.total_bytes);
  if (explicit > 0) return explicit;
  return number(row.via_vps_bytes || row.viaVpsBytes)
    + number(row.direct_bytes || row.directBytes)
    + number(row.unknown_bytes || row.unknownBytes);
}

function byteValue(row) {
  return number(row?.total_bytes ?? row?.bytes ?? row?.effective_bytes)
    || number(row?.via_vps_bytes ?? row?.viaVpsBytes)
      + number(row?.direct_bytes ?? row?.directBytes)
      + number(row?.unknown_bytes ?? row?.unknownBytes);
}

function assertWithinRatio(actual, expected, tolerance, message) {
  if (expected <= 0) return;
  const drift = Math.abs(actual - expected) / expected;
  const detail = `${message}: actual=${actual} expected=${expected} drift=${Math.round(drift * 1000) / 10}% tolerance=${Math.round(tolerance * 100)}%`;
  if (drift <= tolerance) return;
  if (strictTrafficDrift) assert.fail(detail);
  console.warn(`aggregate traffic conservation warning: ${detail}`);
}

function preparedClientRows(...payloads) {
  for (const value of payloads) {
    if (!value || typeof value !== "object") continue;
    for (const key of ["rows", "devices", "clients"]) {
      if (Array.isArray(value[key]) && value[key].length > 0) return value[key];
    }
    if (Array.isArray(value.inventory?.rows) && value.inventory.rows.length > 0) return value.inventory.rows;
  }
  return [];
}

function repairHint(window, dashboard) {
  return `./modules/ghostroute-console/bin/ghostroute-console repair-aggregates --from ${dashboard.windowStartUtc} --to ${dashboard.windowEndUtc}`;
}

for (const window of ["today", "week", "month"]) {
  for (const trafficClass of trafficClasses) {
    const dashboard = payload("dashboard", window, trafficClass);
    assert.ok(dashboard, `missing prepared dashboard ${window}/${trafficClass}`);
    assert.ok(payload("clients", window, trafficClass), `missing prepared clients ${window}/${trafficClass}`);
    assert.ok(payload("reports_llm_safe", window, trafficClass), `missing prepared reports_llm_safe ${window}/${trafficClass}`);
    const rows = composedRows(window, dashboard.windowEndUtc, trafficClass);
    if (driftCheckedClasses.has(trafficClass)) {
      const preparedDevices = dashboard.devices || [];
      const preparedClientKeys = new Set(preparedDevices.map((row) => row.client_key).filter(Boolean));
      const counterRows = window === "today" && ["all", "client"].includes(trafficClass)
        ? deviceCounterRowsForWindow(db, window, dashboard.windowEndUtc, registry)
        : [];
      const aggregateBytes = observedBytes([...rows, ...counterRows], preparedClientKeys);
      const preparedBytes = preparedDevices.reduce((sum, row) => sum + rowTotalBytes(row), 0)
        || number(dashboard.destinationAttributionCoverage?.observed_bytes || dashboard.totals?.observedBytes);
      const allowed = Math.max(1, aggregateBytes * 0.01);
      if (Math.abs(aggregateBytes - preparedBytes) > allowed) {
        console.warn(`${window}/${trafficClass} aggregate drift: aggregate=${aggregateBytes} prepared=${preparedBytes}; repair: ${repairHint(window, dashboard)}`);
      }
    }

    const state = db
      .prepare("select status, detail_json from aggregate_state where model = 'dashboard' and window_key = ?")
      .get(window);
    assert.ok(state, `missing aggregate_state dashboard/${window}; repair: ${repairHint(window, dashboard)}`);
    assert.ok(["ok", "partial"].includes(state.status), `aggregate_state dashboard/${window} status=${state.status}; repair: ${repairHint(window, dashboard)}`);

    const concreteOperatorBytes = rows
      .filter((row) => registry.clients[row.client_key] && concreteDestination(row) && number(row.attributed_bytes) > 0)
      .reduce((sum, row) => sum + number(row.attributed_bytes), 0);
    const topDestinations = dashboard.dashboardAnalytics?.topDestinations || [];
    assert.ok(
      concreteOperatorBytes <= 0 || topDestinations.length > 0,
      `${window}/${trafficClass} has concrete destination bytes but no top destinations; repair: ${repairHint(window, dashboard)}`
    );
  }
}

const topClients = db.prepare("select window, rank, client_key, label, bytes from top_clients_window where traffic_class in ('all', 'client', 'personal_cloud')").all();
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

const laneDetailBytes = number(db.prepare("select coalesce(sum(bytes), 0) as bytes from client_destination_by_lane").get().bytes);
const laneSummaryBytes = number(db.prepare("select coalesce(sum(bytes), 0) as bytes from client_traffic_by_lane where traffic_lane != 'all'").get().bytes);
const laneAllBytes = number(db.prepare("select coalesce(sum(bytes), 0) as bytes from client_traffic_by_lane where traffic_lane = 'all'").get().bytes);
assert.equal(laneSummaryBytes, laneDetailBytes, "client_traffic_by_lane lane rows do not match destination detail bytes");
assert.equal(laneAllBytes, laneDetailBytes, "client_traffic_by_lane all rows do not match destination detail bytes");

for (const model of ["client_traffic_by_lane", "client_destination_by_lane", "client_route_evidence_defects"]) {
  assert.ok(db.prepare("select 1 from aggregate_state where model = ? and window_key = 'all'").get(model), `missing aggregate_state ${model}/all`);
}

const todayDashboard = payload("dashboard", "today", "all");
const todayClients = payload("clients", "today", "all");
const dashboardObserved = number(todayDashboard?.totals?.observedBytes || todayDashboard?.dashboardAnalytics?.trafficToday?.totalBytes);
const inventoryRows = preparedClientRows(todayClients, todayDashboard).filter((row) => byteValue(row) > 0);
const inventoryBytes = inventoryRows.reduce((sum, row) => sum + byteValue(row), 0);
assertWithinRatio(inventoryBytes, dashboardObserved, trafficDriftTolerance, "today client inventory total does not match dashboard observed traffic");

db.close();
console.log("aggregate windows ok");
