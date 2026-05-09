import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

const normalizeModule = await import(new URL("../scr" + "ipts/lib/normalize.mjs", import.meta.url));
const {
  ensureConsoleSchema,
  normalizeSnapshot,
  pruneOperationalTables,
  repairAggregateRange,
  rebuildHourlyAggregates,
  rebuildObservabilityReadModels,
  rebuildPreparedWindows,
} = normalizeModule;
const classificationModule = await import(new URL("../src/lib/traffic-classification.mjs", import.meta.url));
const { deviceRole, displayDestination, trafficClassFor } = classificationModule;
const attributionModule = await import(new URL("../src/lib/device-attribution.mjs", import.meta.url));
const { applyDeviceAttribution, displayDeviceLabel, loadDeviceAttributions, resolveClient } = attributionModule;
const trafficWindowModule = await import(new URL("../src/lib/traffic-window.mjs", import.meta.url));
const {
  concreteTrafficDestination,
  destinationEvidence,
  aggregateDnsInterest,
  dedupeAlerts,
  groupAttributionRows,
  groupDestinationRows,
  reconcileTrafficRows,
  snapshotMatchesPeriod,
  trafficDisplayDestination,
} = trafficWindowModule;
const dashboardAnalyticsModule = await import(new URL("../src/lib/dashboard-analytics.mjs", import.meta.url));
const { buildDashboardAnalyticsFromRows, isMobileTrafficRow, routeByteSplit } = dashboardAnalyticsModule;
const timeWindowModule = await import(new URL("../src/lib/time/window.mjs", import.meta.url));
const { bucketStartUtc, mskWindowBounds, toMskKey, toUtcIsoFromMskKey } = timeWindowModule;
const collectorLockModule = await import(new URL("../scr" + "ipts/lib/collector-lock.mjs", import.meta.url));
const { acquireCollectorLock } = collectorLockModule;
const snapshotContractsModule = await import(new URL("../scr" + "ipts/lib/snapshot-contracts.mjs", import.meta.url));
const { validateSnapshotPayload, withSnapshotContractDefaults } = snapshotContractsModule;

test("console data directory can hold factual snapshots", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghostroute-console-"));
  const snapshots = path.join(tmp, "snapshots");
  fs.mkdirSync(snapshots);
  fs.writeFileSync(
    path.join(snapshots, "traffic-sample.json"),
    JSON.stringify({
      schema_version: 1,
      generated_at: "2026-04-29T00:00:00Z",
      source: { command: "traffic-report" },
      totals: { client_observed_bytes: 100, via_vps_bytes: 70, direct_bytes: 30 },
      devices: [{ id: "lan-host-01", label: "lan-host-01", total_bytes: 100, via_vps_bytes: 70, direct_bytes: 30, confidence: "exact" }],
      app_flows: [{ client: "lan-host-01", destination: "telegram.org", route: "VPS", connections: 1, confidence: "exact" }],
    })
  );
  assert.equal(fs.readdirSync(snapshots).length, 1);
});

test("snapshot contracts keep unknown fields and reject missing core fields", () => {
  const payload = validateSnapshotPayload("traffic_summary", {
    schema_version: 1,
    generated_at: "2026-05-07T00:00:00Z",
    source: { command: "traffic-summary", extra_source_field: true },
    confidence: "mixed",
    totals: { client_observed_bytes: 10 },
    future_field: { kept: true },
  });
  assert.equal(payload.future_field.kept, true);
  assert.equal(payload.source.extra_source_field, true);
  assert.throws(
    () => validateSnapshotPayload("traffic_summary", {
      schema_version: 1,
      source: { command: "traffic-summary" },
      totals: { client_observed_bytes: 10 },
    }),
    /generated_at/
  );
});

test("deploy gate contract defaults preserve legacy live-check payloads", () => {
  const payload = withSnapshotContractDefaults("deploy_gate", {
    schema_version: 1,
    command: "ghostroute-health-monitor live-check",
    generated_at: "2026-05-09T10:00:00Z",
    mode: "deploy-gate",
    deploy_gate: true,
    overall_status: "WARN",
    checks: [],
  });
  const validated = validateSnapshotPayload("deploy_gate", payload);
  assert.equal(validated.source.command, "ghostroute-health-monitor live-check");
  assert.equal(validated.source.mode, "deploy-gate");
});

test("collector lock replaces stale locks and preserves active peer locks", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghostroute-console-lock-"));
  const lockFile = path.join(tmp, "collector.lock");
  let deadPid = 999999;
  while (deadPid > 900000) {
    try {
      process.kill(deadPid, 0);
      deadPid -= 1;
    } catch (error) {
      if (error?.code === "ESRCH") break;
      deadPid -= 1;
    }
  }

  fs.writeFileSync(lockFile, `collector ${deadPid} 2026-05-05T00:00:00.000Z\n`);
  const release = acquireCollectorLock(lockFile, "collector", 60000);
  assert.equal(typeof release, "function");
  assert.match(fs.readFileSync(lockFile, "utf8"), new RegExp(`collector ${process.pid} `));
  release();
  assert.equal(fs.existsSync(lockFile), false);

  fs.writeFileSync(lockFile, `collector ${process.pid} 2026-05-05T00:00:00.000Z\n`);
  const samePidRelease = acquireCollectorLock(lockFile, "collector", 60000);
  assert.equal(typeof samePidRelease, "function");
  samePidRelease();

  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  fs.writeFileSync(lockFile, `collector ${child.pid} 2026-05-05T00:00:00.000Z\n`);
  assert.equal(acquireCollectorLock(lockFile, "collector", 60000), null);
  child.kill("SIGTERM");
  fs.unlinkSync(lockFile);
});

test("alarm-state command stores ack snooze and reopen as bounded JSON", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghostroute-alarm-state-"));
  const stateFile = path.join(tmp, "alarm-state.json");
  const command = path.resolve(new URL("../../bin/alarm-state", import.meta.url).pathname);
  const env = { ...process.env, GHOSTROUTE_ALARM_STATE_FILE: stateFile };

  let state = JSON.parse(execFileSync(command, ["--json", "get"], { encoding: "utf8", env }));
  assert.equal(state.version, 1);
  assert.deepEqual(state.alarms, {});

  state = JSON.parse(execFileSync(command, ["--json", "ack", "alarm:1"], { encoding: "utf8", env }));
  assert.equal(state.alarms["alarm:1"].status, "acknowledged");
  assert.equal(state.alarms["alarm:1"].actor, "console");

  state = JSON.parse(execFileSync(command, ["--json", "snooze", "alarm:1", "60"], { encoding: "utf8", env }));
  assert.equal(state.alarms["alarm:1"].status, "snoozed");
  assert.match(state.alarms["alarm:1"].snoozed_until, /^20/);

  state = JSON.parse(execFileSync(command, ["--json", "open", "alarm:1"], { encoding: "utf8", env }));
  assert.equal(state.alarms["alarm:1"].status, "open");
  assert.equal(state.alarms["alarm:1"].snoozed_until, "");
});

test("collector normalizes factual traffic and catalog snapshots", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghostroute-console-db-"));
  const db = new Database(path.join(tmp, "ghostroute.db"));
  ensureConsoleSchema(db);
  const traffic = {
    generated_at: "2026-04-29T00:00:00Z",
    source: { command: "traffic-report" },
    confidence: "mixed",
    devices: [
      {
        id: "lan-host-01",
        label: "lan-host-01",
        ip: "192.168.1.24",
        mac: "02:00:00:00:00:24",
        hostname: "operator-laptop.local",
        total_bytes: 100,
        via_vps_bytes: 70,
        direct_bytes: 30,
        confidence: "exact",
      },
    ],
    app_flows: [{
      client: "lan-host-01",
      client_ip: "192.168.1.24",
      canonical_hint: "lan-host-01",
      identity_type: "lan_host",
      bytes_confidence: "exact",
      counter_scope: "cumulative_day",
      destination_class: "Telegram",
      destination: "telegram.org",
      destination_port: "443",
      route: "VPS",
      bytes: 70,
      protocol: "TCP / TLS",
      sni: "telegram.org",
      sing_box_outbound: "reality-out",
      matched_rule: "STEALTH_DOMAINS",
      rule_set: "STEALTH_DOMAINS",
      egress_ip: "203.0.113.67",
      egress_asn: "AS209529",
      confidence: "exact"
    }],
    home_reality_clients: [{
      label: "mobile-client-04 (Mamulia)",
      profile: "mobile-client-04",
      total_bytes: 40,
      via_vps_bytes: 30,
      direct_bytes: 10,
      confidence: "estimated",
    }, {
      label: "mobile-client-05",
      profile: "macbook",
      total_bytes: 60,
      via_vps_bytes: 50,
      direct_bytes: 10,
      confidence: "estimated",
    }],
  };
  normalizeSnapshot(db, 1, "traffic", traffic.generated_at, traffic);
  assert.equal(db.prepare("select count(*) as count from normalized_devices").get().count, 3);
  assert.deepEqual(
    db.prepare("select ip, hostname, mac from normalized_devices where device_id = 'lan-host-01'").get(),
    {
      ip: "192.168.1.24",
      hostname: "operator-laptop.local",
      mac: "02:00:00:00:00:24",
    }
  );
  assert.equal(
    db.prepare("select channel from normalized_devices where label = 'mobile-client-04 (Mamulia)'").get().channel,
    "A/Home Reality"
  );
  assert.equal(db.prepare("select label from normalized_devices where device_id = 'macbook'").get().label, "macbook");
  assert.equal(db.prepare("select count(*) as count from normalized_flows").get().count, 1);
  assert.equal(db.prepare("select channel from normalized_flows limit 1").get().channel, "Home Wi-Fi/LAN");
  const flow = db.prepare("select client, client_ip, sni, outbound, matched_rule, egress_ip, egress_asn, raw_json from normalized_flows limit 1").get();
  assert.equal(flow.client, "lan-host-01");
  assert.equal(flow.client_ip, "192.168.1.24");
  assert.equal(flow.sni, "telegram.org");
  assert.equal(flow.outbound, "reality-out");
  assert.equal(flow.matched_rule, "STEALTH_DOMAINS");
  assert.equal(flow.egress_ip, "203.0.113.67");
  assert.equal(flow.egress_asn, "AS209529");
  assert.equal(JSON.parse(flow.raw_json).identity_type, "lan_host");
  assert.equal(JSON.parse(flow.raw_json).bytes_confidence, "exact");
  assert.equal(db.prepare("select count(*) as count from events where event_type = 'flow.observed'").get().count, 1);
  assert.equal(db.prepare("select count(*) as count from route_decisions").get().count, 1);

  normalizeSnapshot(db, 2, "traffic_summary", "2026-04-29T00:05:00Z", {
    generated_at: "2026-04-29T00:05:00Z",
    source: { command: "traffic-summary", period: "today" },
    confidence: "mixed",
    totals: { client_observed_bytes: 40, via_vps_bytes: 30, direct_bytes: 10 },
    devices: [{ id: "192.168.1.24", label: "phone", total_bytes: 40, via_vps_bytes: 30, direct_bytes: 10, confidence: "exact" }],
  });
  assert.equal(db.prepare("select count(*) as count from normalized_devices where snapshot_type = 'traffic_summary'").get().count, 1);

  normalizeSnapshot(db, 3, "live", "2026-04-29T00:00:01Z", {
    source: { command: "live-events-report" },
    cursor: { next: "event-1" },
    events: [{
      event_id: "event-1",
      event_type: "route.decision",
      ts: "2026-04-29T00:00:01Z",
      client: "192.168.1.24",
      client_ip: "192.168.1.24",
      channel: "Home Wi-Fi/LAN",
      destination: "telegram.org",
      destination_port: "443",
      route_decision: "VPS",
      sing_box_outbound: "reality-out",
      matched_rule: "STEALTH_DOMAINS",
      confidence: "exact",
      raw_refs: [{ source_log: "sing-box.log" }],
    }],
  });
  assert.equal(db.prepare("select cursor from live_cursors where source = 'live-events-report'").get().cursor, "event-1");
  normalizeSnapshot(db, 4, "live", "2026-04-29T00:00:02Z", {
    source: { command: "live-events-report" },
    cursor: { next: "event-1" },
    events: [{
      event_id: "event-1",
      event_type: "route.decision",
      ts: "2026-04-29T00:00:01Z",
      destination: "telegram.org",
      route_decision: "VPS",
      confidence: "exact",
    }],
  });
  assert.equal(db.prepare("select count(*) as count from events where event_id = 'event-1'").get().count, 1);

  normalizeSnapshot(db, 2, "domains", "2026-04-29T00:00:00Z", {
    source: { command: "domain-report" },
    auto: [{ domain: "telegram.org", confidence: "exact" }],
    candidates: [{ domain: "example.org" }],
  });
  normalizeSnapshot(db, 5, "dns", "2026-04-29T00:00:03Z", {
    source: { command: "dns-forensics-report" },
    queries: [{
      client: "lan-host-01",
      client_ip: "192.168.1.24",
      domain: "telegram.org",
      qtype: "A",
      answer_ip: "203.0.113.220",
      count: 1,
      confidence: "dns-interest",
    }],
  });
  assert.equal(db.prepare("select count(*) as count from normalized_catalog").get().count, 2);
  const readModels = rebuildObservabilityReadModels(db);
  rebuildPreparedWindows(db, "2026-04-29T00:05:00Z");
  rebuildHourlyAggregates(db);
  assert.equal(db.prepare("select count(*) as count from hourly_traffic").get().count >= 1, true);
  assert.equal(db.prepare("select count(*) as count from client_traffic_hourly").get().count > 0, true);
  assert.equal(db.prepare("select count(*) as count from traffic_window_snapshots where kind = 'dashboard' and window in ('today','week','month')").get().count, 3);
  const preparedDashboard = JSON.parse(db.prepare("select payload_json from traffic_window_snapshots where kind = 'dashboard' and window = 'today'").get().payload_json);
  assert.equal(preparedDashboard.prepared, true);
  assert.equal(preparedDashboard.window, "today");
  assert.equal(readModels.flowCount, 1);
  assert.equal(db.prepare("select policy from flow_sessions where destination = 'telegram.org'").get().policy, "STEALTH_DOMAINS");
  const sessionFlow = db.prepare("select dns_qname, dns_answer_ip, sni, egress_ip, egress_asn, egress_country, ts_confidence from flow_sessions where destination = 'telegram.org'").get();
  assert.equal(sessionFlow.dns_qname, "");
  assert.equal(sessionFlow.sni, "telegram.org");
  assert.equal(sessionFlow.egress_ip, "203.0.113.67");
  assert.equal(sessionFlow.egress_asn, "AS209529");
  assert.equal(sessionFlow.egress_country, "");
  assert.equal(sessionFlow.ts_confidence, "");
  assert.equal(db.prepare("select catalog_status from dns_query_log where domain = 'telegram.org'").get().catalog_status, "managed");
  assert.equal(db.prepare("select count(*) as count from device_inventory").get().count > 0, true);
  assert.ok(db.prepare("select 1 from read_model_state where model = 'flow_sessions'").get());
  db.close();
});

test("schema includes collector reliability and post-MVP tables", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghostroute-console-schema-"));
  const db = new Database(path.join(tmp, "ghostroute.db"));
  ensureConsoleSchema(db);
  for (const table of ["hourly_traffic", "retention_runs", "collector_runs", "collector_errors", "events", "route_decisions", "live_cursors", "audit_log", "notifications", "notification_settings", "catalog_reviews", "ops_runs", "read_model_state", "flow_sessions", "dns_query_log", "device_inventory", "alarm_events", "console_settings", "console_page_summaries", "client_traffic_5min", "client_traffic_hourly", "client_traffic_daily", "dns_log_5min", "top_clients_window", "top_destinations_window", "traffic_window_snapshots", "aggregate_state"]) {
    assert.ok(db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(table), table);
  }
  assert.ok(db.prepare("select version from schema_migrations where version = 6").get());
  assert.ok(db.prepare("select version from schema_migrations where version = 7").get());
  assert.ok(db.prepare("select version from schema_migrations where version = 8").get());
  assert.ok(db.prepare("select version from schema_migrations where version = 9").get());
  assert.ok(db.prepare("select 1 from pragma_table_info('normalized_flows') where name = 'egress_asn'").get());
  assert.ok(db.prepare("select 1 from pragma_table_info('normalized_flows') where name = 'traffic_class'").get());
  assert.ok(db.prepare("select 1 from pragma_table_info('normalized_devices') where name = 'hostname'").get());
  assert.ok(db.prepare("select 1 from pragma_table_info('normalized_devices') where name = 'mac'").get());
  assert.ok(db.prepare("select 1 from pragma_table_info('client_traffic_hourly') where name = 'destination_key'").get());
  assert.ok(db.prepare("select 1 from pragma_table_info('client_traffic_daily') where name = 'destination_key'").get());
  assert.ok(db.prepare("select 1 from pragma_table_info('normalized_flows') where name = 'unknown_bytes'").get());
  assert.ok(db.prepare("select 1 from pragma_table_info('flow_sessions') where name = 'egress_asn'").get());
  assert.ok(db.prepare("select 1 from pragma_table_info('flow_sessions') where name = 'dns_qname'").get());
  assert.ok(db.prepare("select 1 from pragma_table_info('flow_sessions') where name = 'traffic_class'").get());
  db.close();
});

test("observability rebuild writes capped prepared health summaries", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghostroute-console-summary-"));
  const db = new Database(path.join(tmp, "ghostroute.db"));
  ensureConsoleSchema(db);
  const insertSnapshot = (type, collectedAt, payload) => {
    const result = db
      .prepare("insert into snapshots(type, collected_at, source, path, payload_json) values (?, ?, ?, ?, ?)")
      .run(type, collectedAt, "test", `${type}.json`, JSON.stringify(payload));
    normalizeSnapshot(db, Number(result.lastInsertRowid), type, collectedAt, payload);
  };
  insertSnapshot("health", "2026-05-08T10:00:00Z", {
    generated_at: "2026-05-08T10:00:00Z",
    source: { command: "health" },
    services: { router: "OK", reality: "OK", dns: "OK", ipv6: "OK", rule_set_sync: "WARN" },
    router: { product: "RT-AX88U_PRO" },
    checks: Array.from({ length: 25 }, (_, i) => ({ name: `health-${i}`, status: "OK", message: `probe ${i}` })),
  });
  insertSnapshot("leaks", "2026-05-08T10:01:00Z", {
    generated_at: "2026-05-08T10:01:00Z",
    source: { command: "leak-check" },
    overall: "WARN",
    confidence: "exact",
    leaks: Array.from({ length: 12 }, (_, i) => ({ label: `leak-${i}`, status: "WARN", evidence: `signal ${i}` })),
    checks: Array.from({ length: 12 }, (_, i) => ({ probe: `leak-check-${i}`, status: "WARN", message: `leak probe ${i}` })),
    evidence: Array.from({ length: 12 }, (_, i) => ({ probe: `evidence-${i}`, evidence: `row ${i}` })),
  });
  insertSnapshot("deploy_gate", "2026-05-08T10:02:00Z", {
    generated_at: "2026-05-08T10:02:00Z",
    source: { command: "deploy-gate" },
    overall_status: "WARN",
    mode: "readonly",
    checks: Array.from({ length: 12 }, (_, i) => ({ id: `deploy-${i}`, component: "test", status: "WARN", summary: `deploy check ${i}` })),
  });
  const result = rebuildObservabilityReadModels(db);
  assert.equal(result.summaryCount, 3);
  const row = db.prepare("select payload_json from console_page_summaries where page = 'health_mobile'").get();
  assert.ok(row);
  const summary = JSON.parse(row.payload_json);
  assert.equal(summary.alarms.length, 10);
  assert.equal(summary.deployGate.checks.length, 10);
  assert.equal(summary.health.checks.length, 20);
  assert.equal(summary.leaks.evidence.length, 10);
  assert.ok(db.prepare("select 1 from read_model_state where model = 'console_page_summaries'").get());
  db.close();
});

test("destination attribution coverage keeps unattributed accounting buckets", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghostroute-console-coverage-"));
  const db = new Database(path.join(tmp, "ghostroute.db"));
  ensureConsoleSchema(db);
  const observed = 23 * 1024 ** 3;
  const attributed = 800 * 1024 ** 2;
  const unattributed = observed - attributed;
  normalizeSnapshot(db, 1, "traffic", "2026-04-29T12:00:00Z", {
    generated_at: "2026-04-29T12:00:00Z",
    source: { command: "traffic-report", period: "today" },
    totals: { client_observed_bytes: observed, via_vps_bytes: observed, direct_bytes: 0, unknown_bytes: 0 },
    destination_attribution_coverage: {
      observed_bytes: observed,
      attributed_bytes: attributed,
      unattributed_bytes: unattributed,
      coverage_pct: 3.4,
      sources: {
        lan_wifi: {
          observed_bytes: unattributed,
          attributed_bytes: 0,
          unattributed_bytes: unattributed,
          confidence: "exact",
          destination_confidence: "none",
        },
      },
    },
    app_flows: [{
      client: "lan-host-01",
      destination: "video.example.invalid",
      route: "VPS",
      bytes: attributed,
      confidence: "exact",
      bytes_confidence: "exact",
      destination_evidence: "domain_or_sni",
    }],
    destinations: [{
      client: "Home Wi-Fi/LAN",
      channel: "Home Wi-Fi/LAN",
      destination: "Unknown/Unattributed LAN-Wi-Fi",
      route: "VPS",
      total_bytes: unattributed,
      via_vps_bytes: unattributed,
      direct_bytes: 0,
      confidence: "exact",
      accounting_bucket: true,
      allocation_basis: "unattributed_bucket",
      bytes_confidence: "exact-counter",
      destination_evidence: "none",
    }],
  });
  assert.equal(db.prepare("select count(*) as count from normalized_flows").get().count, 2);
  const bucket = db.prepare("select bytes, raw_json from normalized_flows where destination = 'Unknown/Unattributed LAN-Wi-Fi'").get();
  assert.equal(bucket.bytes, unattributed);
  assert.equal(JSON.parse(bucket.raw_json).accounting_bucket, true);
  assert.equal(trafficClassFor(JSON.parse(bucket.raw_json)), "unclassified");
  assert.equal(displayDestination(JSON.parse(bucket.raw_json)), "Unknown/Unattributed LAN-Wi-Fi");
  rebuildObservabilityReadModels(db);
  assert.equal(db.prepare("select bytes from flow_sessions where destination = 'Unknown/Unattributed LAN-Wi-Fi'").get().bytes, unattributed);
  const total = db.prepare("select sum(bytes) as total from flow_sessions").get().total;
  assert.equal(total, observed);
  db.close();
});

test("traffic class separates client, service background and attribution gaps", () => {
  assert.equal(trafficClassFor({ destination: "Google/YouTube", bytes: 1024, confidence: "estimated" }), "client");
  assert.equal(trafficClassFor({ destination: "Apple/iCloud", bytes: 1024, confidence: "estimated" }), "service_background");
  assert.equal(trafficClassFor({ destination: "DNS/Resolver", bytes: 1024, confidence: "estimated" }), "service_background");
  assert.equal(trafficClassFor({ destination: "Other", bytes: 1024, confidence: "estimated" }), "unclassified");
  assert.equal(trafficClassFor({ destination: "Other/IP", bytes: 1024, confidence: "estimated" }), "unclassified");
  assert.equal(trafficClassFor({ destination: "example.invalid", bytes: 0, confidence: "dns-interest" }), "service_background");
  assert.equal(displayDestination({ destination: "Other", bytes: 1024, confidence: "estimated" }), "Unclassified domain");
  assert.equal(displayDestination({ destination: "Other/IP", bytes: 1024, confidence: "estimated" }), "IP-only / no DNS match");
  assert.equal(displayDestination({ destination: "Other", bytes: 0, confidence: "dns-interest" }), "DNS-only interest");
  assert.equal(trafficClassFor({ destination: "Unknown/Unattributed LAN-Wi-Fi", bytes: 1024, accounting_bucket: true }), "unclassified");
});

test("normalization keeps signed unknown bytes and records counter drift", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghostroute-console-drift-"));
  const db = new Database(path.join(tmp, "ghostroute.db"));
  ensureConsoleSchema(db);
  normalizeSnapshot(db, 1, "traffic", "2026-05-09T10:00:00Z", {
    generated_at: "2026-05-09T10:00:00Z",
    source: { command: "traffic-report", period: "today" },
    app_flows: [{
      client: "client-a",
      destination: "drift.example.invalid",
      route: "Mixed",
      bytes: 100,
      via_vps_bytes: 80,
      direct_bytes: 40,
      confidence: "exact",
    }],
  });
  const row = db.prepare("select traffic_class, via_vps_bytes, direct_bytes, unknown_bytes from normalized_flows").get();
  assert.equal(row.traffic_class, "client");
  assert.equal(row.via_vps_bytes, 80);
  assert.equal(row.direct_bytes, 40);
  assert.equal(row.unknown_bytes, -20);
  assert.ok(db.prepare("select 1 from collector_errors where type = 'counter_drift'").get());
  db.close();
});

test("operational pruning keeps raw tables bounded after prepared windows exist", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghostroute-console-prune-"));
  const db = new Database(path.join(tmp, "ghostroute.db"));
  ensureConsoleSchema(db);
  normalizeSnapshot(db, 1, "traffic", "2026-04-01T10:00:00Z", {
    generated_at: "2026-04-01T10:00:00Z",
    source: { command: "traffic-report", period: "today" },
    app_flows: [{ client: "old-client", destination: "old.example.invalid", route: "VPS", bytes: 100 }],
  });
  normalizeSnapshot(db, 2, "traffic", "2026-05-09T10:00:00Z", {
    generated_at: "2026-05-09T10:00:00Z",
    source: { command: "traffic-report", period: "today" },
    app_flows: [{ client: "new-client", destination: "new.example.invalid", route: "VPS", bytes: 100 }],
  });
  const pruned = pruneOperationalTables(db, "2026-05-09T12:00:00Z");
  assert.equal(pruned.normalized_flows > 0, true);
  assert.equal(db.prepare("select count(*) as count from normalized_flows where client = 'old-client'").get().count, 0);
  assert.equal(db.prepare("select count(*) as count from normalized_flows where client = 'new-client'").get().count, 1);
  db.close();
});

test("time helper produces stable MSK windows over UTC storage", () => {
  assert.equal(toMskKey("2026-05-09T10:17:42.000Z", "5min"), "2026-05-09T13:15");
  assert.equal(bucketStartUtc("2026-05-09T10:17:42.000Z", "5min"), "2026-05-09T10:15:00.000Z");
  assert.equal(toUtcIsoFromMskKey("2026-05-09", "day"), "2026-05-08T21:00:00.000Z");
  assert.equal(toUtcIsoFromMskKey("2026-05-10T24:40", "5min"), "2026-05-09T21:40:00.000Z");
  assert.deepEqual(mskWindowBounds("week", "2026-05-09T10:17:42.000Z").startMskKey, "2026-05-03");
});

test("dashboard analytics derives traffic charts quotas and mobile LTE usage from flows", () => {
  const rows = [
    { client: "Laptop", channel: "Home Wi-Fi/LAN", destination: "telegram.org", route: "VPS", bytes: 100, last_seen: "2026-05-07T09:00:00Z" },
    { client: "Laptop", channel: "Home Wi-Fi/LAN", destination: "ai.test", route: "Mixed", bytes: 1000, evidence_json: JSON.stringify({ via_vps_bytes: 700, direct_bytes: 250 }), last_seen: "2026-05-07T09:30:00Z" },
    { client: "Phone", channel: "C/Mobile LTE", destination: "youtube.test", route: "Direct", bytes: 50, last_seen: "2026-05-07T10:00:00Z" },
    { client: "Phone", channel: "Channel B", destination: "telegram.org", route: "VPS", bytes: 25, last_seen: "2026-05-06T10:00:00Z" },
    { client: "Tablet", channel: "Home Wi-Fi/LAN", destination: "unknown destination", route: "Unknown", bytes: 10, last_seen: "2026-05-07T11:00:00Z" },
    { client: "Tablet", channel: "Home Wi-Fi/LAN", destination: "IP-only / no DNS match", route: "Unknown", bytes: 0, unknown_bytes: 40, last_seen: "2026-05-07T11:30:00Z" },
    { client: "Old", channel: "Home Wi-Fi/LAN", destination: "old.test", route: "VPS", bytes: 20, last_seen: "2026-04-30T11:00:00Z" },
  ];
  const analytics = buildDashboardAnalyticsFromRows(rows, {
    now: "2026-05-07T12:00:00Z",
    period: "today",
    vpsQuotaGb: 1,
    lteQuotaGb: 1,
    resetDay: 1,
  });
  assert.deepEqual(routeByteSplit(rows[1]), { totalBytes: 1000, viaVpsBytes: 700, directBytes: 250, unknownBytes: 50 });
  assert.deepEqual(routeByteSplit(rows[5]), { totalBytes: 40, viaVpsBytes: 0, directBytes: 0, unknownBytes: 40 });
  assert.equal(analytics.trafficToday.totalBytes, 1200);
  assert.equal(analytics.trafficToday.points.reduce((sum, row) => sum + row.viaVpsBytes, 0), 800);
  assert.equal(analytics.trafficToday.points.reduce((sum, row) => sum + row.directBytes, 0), 300);
  assert.equal(analytics.trafficToday.points.reduce((sum, row) => sum + row.unknownBytes, 0), 100);
  assert.equal(analytics.topClients[0].label, "Laptop");
  assert.equal(analytics.topClients[0].viaVpsBytes, 800);
  assert.equal(analytics.topClients[0].directBytes, 250);
  assert.equal(analytics.topClients[0].unknownBytes, 50);
  assert.equal(analytics.topDestinations[0].label, "ai.test");
  assert.equal(analytics.quota.vps.usedBytes, 825);
  assert.equal(analytics.quota.lte.usedBytes, 75);
  assert.equal(analytics.usage.points.at(-1).vpsForecastBytes > analytics.quota.vps.usedBytes, true);
  assert.equal(isMobileTrafficRow({ channel: "A/Home Reality", client: "mobile-client-04" }), true);
  assert.equal(isMobileTrafficRow({ channel: "Home Wi-Fi/LAN", client: "Laptop" }), false);
});

test("prepared traffic windows use operator clients and preserve destination tops", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghostroute-console-prepared-clients-"));
  fs.writeFileSync(
    path.join(tmp, "device-attribution.json"),
    JSON.stringify({
      schema_version: 2,
      clients: {
        macbook: {
          label: "macbook (Operator MacBook)",
          device_key: "operator-macbook",
          device_label: "Operator MacBook",
          aliases: { lan_wifi: ["lan-host-13"] },
        },
        "operator-phone": {
          label: "operator-phone (Operator iPhone)",
          aliases: { channel_a: ["iphone-1"] },
        },
      },
    })
  );
  const previousDataDir = process.env.GHOSTROUTE_CONSOLE_DATA_DIR;
  process.env.GHOSTROUTE_CONSOLE_DATA_DIR = tmp;
  const db = new Database(path.join(tmp, "ghostroute.db"));
    try {
    ensureConsoleSchema(db);
    db.prepare(`
      insert into device_inventory(device_key, label, ip, hostname, mac, aliases_json, profile, trust_state, device_type,
        channel, route, confidence, last_seen, total_bytes, via_vps_bytes, direct_bytes, unknown_bytes, top_domains_json,
        health_status, risk, evidence_json)
      values (?, ?, ?, ?, ?, ?, ?, 'trusted', 'MacBook', 'Home Wi-Fi/LAN', 'Direct', 'exact', ?, 0, 0, 0, 0, '[]', 'OK', 'low', '{}')
    `).run("lan-host-13", "lan-host-13 (Unknown device)", "192.0.2.44", "operator-macbook.local", "02:00:00:00:13:13", JSON.stringify(["lan-host-13"]), "lan-host-13", "2026-05-07T08:00:00Z");
    const insert = db.prepare(`
      insert into normalized_flows(snapshot_id, snapshot_type, collected_at, client, channel, destination, route, confidence,
        bytes, connections, protocol, client_ip, traffic_class, via_vps_bytes, direct_bytes, unknown_bytes, raw_json)
      values (?, 'traffic', ?, ?, ?, ?, ?, ?, ?, ?, 'TCP', ?, ?, ?, ?, ?, ?)
    `);
    insert.run(1, "2026-05-07T08:00:00Z", "lan-host-13", "Home Wi-Fi/LAN", "torrent.example", "Direct", "exact", 1200, 8, "", "client", 0, 1200, 0, JSON.stringify({ client: "lan-host-13" }));
    insert.run(1, "2026-05-07T08:02:00Z", "192.0.2.44", "Home Wi-Fi/LAN", "large-download.example", "Direct", "exact", 2200, 10, "192.0.2.44", "client", 0, 2200, 0, JSON.stringify({ client_ip: "192.0.2.44" }));
    insert.run(1, "2026-05-07T08:05:00Z", "lan-host-13", "Home Wi-Fi/LAN", "unknown destination", "Unknown", "estimated", 0, 0, "", "client", 0, 0, 1234, JSON.stringify({ client: "lan-host-13", accounting_bucket: true }));
    insert.run(1, "2026-05-07T08:10:00Z", "A/Home Reality", "A/Home Reality", "internal.example", "Unknown", "estimated", 6, 1, "", "client", 0, 0, 6, JSON.stringify({ client: "A/Home Reality" }));
    insert.run(1, "2026-05-07T08:15:00Z", "lan-host-99", "Home Wi-Fi/LAN", "unregistered.example", "Direct", "exact", 900, 5, "", "client", 0, 900, 0, JSON.stringify({ client: "lan-host-99" }));
    insert.run(1, "2026-05-07T08:20:00Z", "iphone-1", "A/Home Reality", "ai.example", "VPS", "exact", 500, 3, "", "client", 500, 0, 0, JSON.stringify({ profile: "iphone-1" }));

    rebuildPreparedWindows(db, "2026-05-07T09:00:00Z");
    const preparedDashboard = JSON.parse(db.prepare("select payload_json from traffic_window_snapshots where kind = 'dashboard' and window = 'today'").get().payload_json);
    const labels = preparedDashboard.dashboardAnalytics.topClients.map((row) => row.label);
    assert.deepEqual(labels, ["macbook (Operator MacBook)", "operator-phone (Operator iPhone)"]);
    assert.equal(preparedDashboard.dashboardAnalytics.topClients.some((row) => row.bytes <= 0), false);
    assert.equal(preparedDashboard.dashboardAnalytics.topClients[0].bytes, 1234);
    assert.equal(preparedDashboard.dashboardAnalytics.topClients[0].totalBytes, 1234);
    assert.equal(preparedDashboard.dashboardAnalytics.topClients[0].unknownBytes, 1234);
    assert.equal(labels.some((label) => /A\/Home Reality|lan-host-99/.test(label)), false);
    assert.equal(preparedDashboard.dashboardAnalytics.topDestinations[0].label, "large-download.example");
    assert.equal(db.prepare("select client_key from client_traffic_5min where destination_key = 'torrent.example'").get().client_key, "macbook");
    assert.equal(db.prepare("select client_key from client_traffic_5min where destination_key = 'large-download.example'").get().client_key, "macbook");
    assert.equal(db.prepare("select count(*) as count from top_clients_window where bytes <= 0 or label in ('A/Home Reality', 'B/XHTTP relay')").get().count, 0);
    assert.ok(db.prepare("select 1 from aggregate_state where model = 'dashboard' and window_key = 'today'").get());
    const dryRun = repairAggregateRange(db, { fromUtc: "2026-05-07T08:00:00Z", toUtc: "2026-05-07T10:00:00Z", dryRun: true });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.status, "ok");
    const missing = repairAggregateRange(db, { fromUtc: "2026-05-01T00:00:00Z", toUtc: "2026-05-01T01:00:00Z" });
    assert.equal(missing.status, "missing_source");
    assert.ok(db.prepare("select 1 from aggregate_state where model = 'repair_aggregates' and status = 'missing_source'").get());
  } finally {
    db.close();
    if (previousDataDir === undefined) delete process.env.GHOSTROUTE_CONSOLE_DATA_DIR;
    else process.env.GHOSTROUTE_CONSOLE_DATA_DIR = previousDataDir;
  }
});

test("traffic window keeps stale today snapshots out of current-day views", () => {
  const now = new Date("2026-05-03T17:00:00Z");
  assert.equal(snapshotMatchesPeriod({
    type: "traffic",
    collectedAt: "2026-05-03T14:00:00Z",
    payload: { source: { command: "traffic-report", period: "today" } },
  }, "today", now), true);
  assert.equal(snapshotMatchesPeriod({
    type: "traffic",
    collectedAt: "2026-05-02T14:00:00Z",
    payload: { source: { command: "traffic-report", period: "today" } },
  }, "today", now), false);
  assert.equal(snapshotMatchesPeriod({
    type: "traffic",
    collectedAt: "2026-05-03T14:00:00Z",
    payload: { source: { command: "traffic-report", period: "week" } },
  }, "today", now), false);
});

test("traffic presentation prefers concrete destinations over generic categories", () => {
  const rows = groupDestinationRows([
    { client: "lan-host-01", destination: "AI services", dns_qname: "chat.example.invalid", destinationLabel: "AI services", route: "VPS", bytes: 100 },
    { client: "lan-host-02", destination: "Dev/Productivity", sni: "docs.example.invalid", destinationLabel: "Dev/Productivity", route: "Direct", bytes: 50 },
    { client: "lan-host-03", destination: "AI services", route: "VPS", bytes: 200 },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].destinationLabel, "chat.example.invalid");
  assert.equal(trafficDisplayDestination(rows[0]), "chat.example.invalid");
  assert.equal(concreteTrafficDestination({ destination: "AI services" }), "");
  assert.deepEqual(destinationEvidence({ dns_qname: "chat.example.invalid", destination: "AI services" }), {
    label: "chat.example.invalid",
    kind: "DNS",
    exact: true,
  });
  assert.deepEqual(destinationEvidence({ destination: "Apple/iCloud" }), {
    label: "Apple/iCloud",
    kind: "category",
    exact: false,
  });
});

test("dns interest aggregation groups duplicate domains", () => {
  const rows = aggregateDnsInterest([
    { domain: "www.google.com", count: 1, collected_at: "2026-05-08T10:00:00Z" },
    { qname: "www.google.com", count: 3, collected_at: "2026-05-08T10:01:00Z" },
    { dns_qname: "setup.fe2.apple-dns.net", collected_at: "2026-05-08T10:02:00Z" },
    { domain: "www.google.com", collected_at: "2026-05-08T10:03:00Z" },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].domain, "www.google.com");
  assert.equal(rows[0].count, 5);
  assert.equal(rows[1].domain, "setup.fe2.apple-dns.net");
  assert.equal(rows[1].count, 1);
});

test("traffic rows reconcile cumulative source totals to authoritative current-day KPI", () => {
  const rows = reconcileTrafficRows([
    { client: "client-a", destination: "video.example.invalid", total_bytes: 700, via_vps_bytes: 500, direct_bytes: 200, route: "Mixed" },
    { client: "client-b", destination: "chat.example.invalid", total_bytes: 300, via_vps_bytes: 250, direct_bytes: 50, route: "Mixed" },
  ], { observed: 500, vps: 350, direct: 150 });
  assert.equal(rows.reduce((sum, row) => sum + row.total_bytes, 0), 500);
  assert.equal(rows.reduce((sum, row) => sum + row.via_vps_bytes, 0), 350);
  assert.equal(rows.reduce((sum, row) => sum + row.direct_bytes, 0), 150);
  assert.equal(rows[0].reconciled, true);
  assert.equal(rows[0].raw_total_bytes, 700);
});

test("traffic reconciliation leaves already consistent rows unchanged", () => {
  const rows = [{ client: "client-a", destination: "video.example.invalid", bytes: 100, route: "VPS" }];
  assert.equal(reconcileTrafficRows(rows, { observed: 110, vps: 100, direct: 0 }), rows);
});

test("traffic reconciliation bounds no-split rows to unknown budget", () => {
  const rows = reconcileTrafficRows([
    { client: "client-a", destination: "video.example.invalid", total_bytes: 1200, via_vps_bytes: 1200, direct_bytes: 0, route: "VPS" },
    { client: "client-b", destination: "unknown.example.invalid", total_bytes: 500, route: "Unknown" },
  ], { observed: 1000, vps: 900, direct: 50 });
  assert.equal(rows.reduce((sum, row) => sum + row.total_bytes, 0), 950);
  assert.equal(rows[0].total_bytes, 900);
  assert.equal(rows[1].total_bytes, 50);
});

test("needs attribution groups duplicate reasons and keeps evidence details", () => {
  const rows = groupAttributionRows([
    { client: "lan-host-01", destination: "Other", destinationLabel: "Unclassified domain", destination_ip: "203.0.113.10", route: "VPS", bytes: 100 },
    { client: "lan-host-02", destination: "Other", destinationLabel: "Unclassified domain", destination_ip: "203.0.113.10", route: "VPS", bytes: 50 },
    { client: "lan-host-03", destination: "Other/IP", destinationLabel: "IP-only / no DNS match", route: "Direct", bytes: 25 },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].bytes, 150);
  assert.match(rows[0].attributionDetail, /203\.0\.113\.10/);
  assert.match(rows[0].attributionDetail, /2 rows/);
});

test("warnings are deduplicated and include concrete evidence", () => {
  const rows = dedupeAlerts([
    { title: "ru_looking_domain_in_managed_catalog", severity: "review", source: "traffic-report", destination: "example.invalid" },
    { title: "ru_looking_domain_in_managed_catalog", severity: "review", source: "traffic-report", destination: "example.invalid" },
    { title: "collector skipped traffic", severity: "warning", source: "collector", evidence: "timeout" },
  ]);
  assert.equal(rows.length, 2);
  assert.match(rows[0].detail, /example\.invalid/);
  assert.match(rows[0].detail, /2 repeats/);
});

test("device role inference keeps pseudo sources out of normal device meaning", () => {
  assert.equal(deviceRole({ label: "lan-host-08", channel: "Home Wi-Fi/LAN" }), "Home LAN device");
  assert.equal(deviceRole({ label: "mobile-client-04" }), "Home Reality profile");
  assert.equal(deviceRole({ label: "mobile-source-08" }), "Unattributed mobile ingress source");
  assert.equal(deviceRole({ label: "iphone-b-3", channel: "Channel B" }), "Channel B profile");
  assert.equal(deviceRole({ label: "1-SR", channel: "Channel C" }), "Channel C profile");
  assert.equal(deviceRole({ label: "family iPad" }), "iPad");
  assert.equal(deviceRole({ label: "lan-host-12 (Windows laptop)" }), "Windows laptop");
  assert.equal(deviceRole({ label: "lan-host-09 (Windows PC)" }), "Windows PC");
  assert.equal(deviceRole({ label: "lan-host-07 (Unknown mobile/private MAC)" }), "Private MAC mobile device");
});

test("operator-local device attribution labels known devices and marks unknown sources", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghostroute-console-attribution-"));
  fs.writeFileSync(
    path.join(tmp, "device-attribution.json"),
    JSON.stringify({
      schema_version: 1,
      devices: {
        "lan-host-08": { label: "lan-host-08 (Phone)", role: "iPhone", channel: "Home Wi-Fi/LAN" },
        "mobile-client-01": { label: "mobile-client-01 (Owner A)", role: "Home Reality profile" },
        "macbook": { label: "MacBook Owner", role: "MacBook", aliases: ["mobile-client-05"] },
      },
    })
  );
  const registry = loadDeviceAttributions(tmp);
  assert.equal(displayDeviceLabel("lan-host-08", registry), "lan-host-08 (Phone)");
  assert.equal(displayDeviceLabel("mobile-client-01 / B", registry), "mobile-client-01 (Owner A) / B");
  assert.equal(displayDeviceLabel("lan-host-99", registry), "lan-host-99 (Unknown device)");
  assert.equal(displayDeviceLabel("mobile-source-08", registry), "mobile-source-08 (Unattributed source)");
  assert.equal(displayDeviceLabel({ device_id: "macbook", label: "mobile-client-05" }, registry), "MacBook Owner");
  const attributed = applyDeviceAttribution({ id: "lan-host-08", label: "lan-host-08", role: "Home LAN device", total_bytes: 1 }, registry);
  assert.equal(attributed.id, "lan-host-08");
  assert.equal(attributed.label, "lan-host-08 (Phone)");
  assert.equal(attributed.client_key, "lan-host-08");
  assert.equal(attributed.role, "iPhone");
  assert.equal(attributed.channel, "Home Wi-Fi/LAN");
  assert.equal(attributed.attribution_confidence, "operator-local");
});

test("unified client registry resolves A/B/C aliases and keeps source counters diagnostic", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghostroute-client-registry-"));
  fs.writeFileSync(
    path.join(tmp, "device-attribution.json"),
    JSON.stringify({
      schema_version: 2,
      clients: {
        "client-alpha": {
          label: "client-alpha (Operator phone)",
          device_key: "operator-phone",
          device_label: "Operator iPhone",
          owner: "Operator",
          device_type: "iPhone",
          role: "iPhone",
          primary_channel: "A/Home Reality",
          aliases: {
            channel_a: ["iphone-1"],
            channel_b: ["iphone-b-1"],
            channel_c: ["c1_iphone_1", "1-SR"],
            lan_wifi: ["lan-host-01"],
          },
          observed_ids: ["client-alpha-ios"],
          mac_aliases: ["02:00:00:00:00:01"],
          ip_aliases: ["192.0.2.10"],
        },
        "client-beta": {
          label: "client-beta (Laptop)",
          role: "MacBook",
          aliases: { channel_a: ["iphone-2"], lan_wifi: ["lan-host-07"] },
        },
      },
    })
  );
  fs.writeFileSync(
    path.join(tmp, "device-attribution.local.json"),
    JSON.stringify({
      schema_version: 2,
      clients: {
        "client-beta": {
          ip_aliases: ["192.0.2.20"],
          mac_aliases: ["02:00:00:00:00:20"],
          aliases: { hostnames: ["operator-laptop.local"] },
        },
      },
    })
  );
  const registry = loadDeviceAttributions(tmp);
  for (const alias of ["iphone-1", "iphone-b-1", "c1_iphone_1", "1-SR", "lan-host-01"]) {
    assert.equal(resolveClient(alias, registry).client_key, "client-alpha", alias);
  }
  const reportLocalAlias = resolveClient("mobile-client-01", registry);
  assert.equal(reportLocalAlias.client_key, "mobile-client-01");
  assert.equal(reportLocalAlias.attribution_confidence, "inferred");
  const profileBackedRow = resolveClient({ client: "mobile-client-01", raw: { profile: "iphone-2" } }, registry);
  assert.equal(profileBackedRow.client_key, "client-beta");
  assert.deepEqual(profileBackedRow.observed_aliases, ["iphone-2"]);
  assert.equal(resolveClient({ mac: "02-00-00-00-00-01" }, registry).client_key, "client-alpha");
  assert.equal(resolveClient("iphone-b-1", registry).device_key, "operator-phone");
  assert.equal(resolveClient("iphone-b-1", registry).device_label, "Operator iPhone");
  assert.equal(resolveClient("iphone-b-1", registry).client_owner, "Operator");
  assert.equal(resolveClient("iphone-b-1", registry).device_type, "iPhone");
  assert.equal(resolveClient({ client_ip: "192.0.2.10" }, registry).matched_by, "explicit_ip_alias");
  assert.equal(resolveClient({ client_ip: "192.0.2.20" }, registry).client_key, "client-beta");
  assert.equal(resolveClient({ mac: "02-00-00-00-00-20" }, registry).client_label, "client-beta (Laptop)");
  assert.equal(resolveClient("operator-laptop.local", registry).client_key, "client-beta");
  assert.equal(resolveClient({ mac: "02:00:00:00:00:02" }, registry).client_key, "");
  assert.equal(resolveClient("mobile-source-15", registry).client_key, "mobile-source-15");
  assert.equal(resolveClient("mobile-source-15", registry).attribution_confidence, "unattributed");
});
