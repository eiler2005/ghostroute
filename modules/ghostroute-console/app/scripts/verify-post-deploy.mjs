#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

const appDir = path.resolve(import.meta.dirname, "..");
const moduleDir = path.resolve(appDir, "..");
const dataDir = process.env.GHOSTROUTE_CONSOLE_DATA_DIR || path.resolve(moduleDir, "data");
const dbFile = path.join(dataDir, "ghostroute.db");
const db = new Database(dbFile, { readonly: true, fileMustExist: true });

const windows = ["today", "week", "month"];
const classes = ["all", "client", "personal_cloud", "service_background", "unclassified"];
const preparedKinds = ["dashboard", "clients", "reports_llm_safe"];
const requiredFullSnapshots = ["traffic_summary", "router_rollups", "traffic_evidence", "traffic_facts"];
const aggregateTables = [
  "client_traffic_5min",
  "client_traffic_hourly",
  "client_traffic_daily",
  "client_traffic_weekly",
  "client_traffic_monthly",
  "client_destination_traffic_5min",
  "client_destination_traffic_hourly",
  "client_destination_traffic_daily",
  "client_destination_traffic_weekly",
  "client_destination_traffic_monthly",
  "top_clients_window",
];
const lockFiles = ["collector.lock", "light-collector.lock", "live-collector.lock", "collector-writer.lock"];

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function lockPid(content) {
  for (const token of String(content || "").trim().split(/\s+/)) {
    const pid = Number(token);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return 0;
}

function pidIsAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readPayload(kind, window, trafficClass) {
  const row = db.prepare(`
    select payload_json
      from traffic_window_snapshots
     where kind = ?
       and window = ?
       and traffic_class = ?
  `).get(kind, window, trafficClass);
  assert.ok(row, `missing prepared window kind=${kind} window=${window} traffic_class=${trafficClass}`);
  return JSON.parse(row.payload_json || "{}");
}

function latestSnapshotPayload(type) {
  const row = db.prepare(`
    select payload_json
      from snapshots
     where type = ?
     order by collected_at desc
     limit 1
  `).get(type);
  return row ? JSON.parse(row.payload_json || "{}") : {};
}

function tableHasColumn(table, column) {
  return Boolean(db.prepare(`select 1 from pragma_table_info('${table}') where name = ?`).get(column));
}

const activeLocks = [];
for (const file of lockFiles) {
  const fullPath = path.join(dataDir, file);
  if (!fs.existsSync(fullPath)) continue;
  const content = fs.readFileSync(fullPath, "utf8");
  const pid = lockPid(content);
  const active = pidIsAlive(pid);
  activeLocks.push({ file, pid, active });
}
assert.equal(activeLocks.filter((row) => row.active).length, 0, `collector still active: ${JSON.stringify(activeLocks)}`);

const latestRun = db.prepare(`
  select id, started_at, finished_at, ok_count, error_count
    from collector_runs
   order by id desc
   limit 1
`).get();
assert.ok(latestRun, "missing full collector run; run npm run collector:once after deploy");
assert.ok(latestRun.finished_at, `latest full collector run did not finish: ${JSON.stringify(latestRun)}`);
assert.equal(number(latestRun.error_count), 0, `latest full collector run has errors: ${JSON.stringify(latestRun)}`);

for (const type of requiredFullSnapshots) {
  const row = db.prepare(`
    select type, collected_at
      from snapshots
     where type = ?
     order by collected_at desc
     limit 1
  `).get(type);
  assert.ok(row, `missing required post-deploy snapshot type=${type}`);
}

for (const column of ["protocol", "bytes_up", "bytes_down", "route_source", "route_basis", "matched_ipset", "intended_route", "route_verification", "route_status", "dns_link_id", "dns_link_confidence", "dns_status", "dns_ts_source", "accounting_status"]) {
  assert.ok(tableHasColumn("traffic_facts", column), `traffic_facts missing ${column}`);
}
for (const column of ["id", "destination_ip", "destination_port", "protocol", "dns_answer_ip", "dns_event_ts_utc", "dns_ts_source", "flow_event_ts_utc"]) {
  assert.ok(tableHasColumn("traffic_dns_links", column), `traffic_dns_links missing ${column}`);
}
for (const column of ["traffic_class", "traffic_lane", "dns_category", "traffic_role", "traffic_purpose", "decision_hint", "human_explanation", "source", "evidence_sources_json"]) {
  assert.ok(tableHasColumn("destination_enrichment", column), `destination_enrichment missing ${column}`);
}

for (const kind of preparedKinds) {
  for (const window of windows) {
    for (const trafficClass of classes) {
      readPayload(kind, window, trafficClass);
    }
  }
}

for (const window of windows) {
  const allClients = readPayload("clients", window, "all");
  const clientClients = readPayload("clients", window, "client");
  assert.ok(number(allClients.total) >= number(clientClients.total), `all clients narrower than client for ${window}`);
  const allDashboard = readPayload("dashboard", window, "all");
  const clientDashboard = readPayload("dashboard", window, "client");
  assert.ok(
    number(allDashboard.dashboardAnalytics?.topClients?.length) >= number(clientDashboard.dashboardAnalytics?.topClients?.length),
    `all dashboard top clients narrower than client for ${window}`
  );
}

for (const table of aggregateTables) {
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

const factSplitViolations = db.prepare(`
  select count(*) as count
    from traffic_facts
   where bytes < 0
      or via_vps_bytes < 0
      or direct_bytes < 0
      or unknown_bytes < 0
      or bytes != via_vps_bytes + direct_bytes + unknown_bytes
`).get();
assert.equal(number(factSplitViolations.count), 0, "traffic_facts has invalid byte splits");

const badIntent = db.prepare(`
  select count(*) as count
    from traffic_facts
   where route_verification = 'intent_only'
     and lower(coalesce(route_source, '')) in ('', 'none')
`).get();
assert.equal(number(badIntent.count), 0, "traffic_facts has intent_only rows with route_source=none");

const latestSummary = latestSnapshotPayload("traffic_summary");
const latestEvidence = latestSnapshotPayload("traffic_evidence");
const homeRealityIngress = number(latestSummary?.totals?.home_reality_ingress_bytes || latestSummary?.home_reality_ingress_bytes);
const homeRealitySamples = Array.isArray(latestEvidence?.home_reality_samples) ? latestEvidence.home_reality_samples.length : 0;
assert.ok(homeRealityIngress <= 0 || homeRealitySamples > 0, `traffic_summary reports Home Reality ingress (${homeRealityIngress}) but latest traffic_evidence has no home_reality_samples`);

const legacyInLatestFacts = db.prepare(`
  select count(*) as count
    from traffic_facts
   where allocation_basis = 'connection_share'
      or evidence_level = 'domain_or_sni'
      or evidence_json like '%traffic-report app_flows%'
`).get();
assert.equal(number(legacyInLatestFacts.count), 0, "legacy traffic-report app_flows rows are present in authoritative traffic_facts; reset/quarantine polluted DB before GUI totals");

const factClasses = db.prepare("select traffic_class, count(*) as rows, sum(bytes) as bytes from traffic_facts group by traffic_class order by traffic_class").all();
const preparedSummary = db.prepare(`
  select kind, window, traffic_class, computed_at_utc
    from traffic_window_snapshots
   where kind in ('dashboard', 'clients', 'reports_llm_safe')
   order by kind, window, traffic_class
`).all();

db.close();
console.log(JSON.stringify({
  status: "ok",
  data_dir: dataDir,
  latest_full_collector: latestRun,
  prepared_windows: preparedSummary.length,
  fact_classes: factClasses,
  inactive_locks: activeLocks,
}, null, 2));
