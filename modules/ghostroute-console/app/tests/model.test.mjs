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
  rebuildAllTrafficReadModels,
  rebuildPreparedWindows,
  resolvedDnsQname,
  resolvedTrafficDestination,
} = normalizeModule;
const classificationModule = await import(new URL("../src/lib/traffic-classification.mjs", import.meta.url));
const { deviceReviewState, deviceRole, displayDestination, trafficClassFor, trafficIntelligenceFor } = classificationModule;
const attributionModule = await import(new URL("../src/lib/device-attribution.mjs", import.meta.url));
const { applyDeviceAttribution, displayDeviceLabel, loadDeviceAttributions, resolveClient } = attributionModule;
const routingPolicySnapshotModule = await import(new URL("../src/lib/routing-policy-snapshot.mjs", import.meta.url));
const { normalizeRoutingPolicySnapshot } = routingPolicySnapshotModule;
const popularSitesModule = await import(new URL("../src/lib/client-popular-sites.mjs", import.meta.url));
const { composePopularSiteRows, counterFallbackRows, groupPopularSites, siteBytes } = popularSitesModule;
const attributionEligibilityModule = await import(new URL("../src/lib/attribution-eligibility.mjs", import.meta.url));
const { attributionEligibility, isAttributableSiteRow } = attributionEligibilityModule;
const trafficWindowModule = await import(new URL("../src/lib/traffic-window.mjs", import.meta.url));
const {
  concreteTrafficDestination,
  destinationEvidence,
  aggregateDnsInterest,
  dnsInterestTrafficClass,
  dedupeAlerts,
  filterDnsInterestRows,
  groupAttributionRows,
  groupDestinationRows,
  isPrimaryTrafficDestinationLabel,
  reconcileTrafficRows,
  snapshotMatchesPeriod,
  trafficDisplayDestination,
  noisyDomainRule,
  trafficPresentationBytes,
} = trafficWindowModule;
const dashboardAnalyticsModule = await import(new URL("../src/lib/dashboard-analytics.mjs", import.meta.url));
const { buildDashboardAnalyticsFromRows, isMobileTrafficRow, routeByteSplit } = dashboardAnalyticsModule;
const domainAttributionModule = await import(new URL("../src/lib/domain-attribution.mjs", import.meta.url));
const { isPersonalCloudDomain, isServiceDomain, isUnclassifiedDomain, normalizeDomainBreakdown, trafficClassForDomain, trafficDomainLabel } = domainAttributionModule;
const appFamilyModule = await import(new URL("../../../traffic-intelligence/lib/app-family.mjs", import.meta.url));
const { classifyAppFamily, isClientFacingAppFamily } = appFamilyModule;
const ndpiModule = await import(new URL("../src/lib/ndpi-diagnostics.mjs", import.meta.url));
const { expectedNdpiProtocol, ndpiDiagnosticForApp } = ndpiModule;
const timeWindowModule = await import(new URL("../src/lib/time/window.mjs", import.meta.url));
const { bucketStartUtc, mskWindowBounds, toMskKey, toUtcIsoFromMskKey } = timeWindowModule;
const collectorLockModule = await import(new URL("../scr" + "ipts/lib/collector-lock.mjs", import.meta.url));
const { acquireCollectorLock } = collectorLockModule;
const snapshotContractsModule = await import(new URL("../scr" + "ipts/lib/snapshot-contracts.mjs", import.meta.url));
const { validateSnapshotPayload, withSnapshotContractDefaults } = snapshotContractsModule;
const routerRollupsModule = await import(new URL("../scr" + "ipts/lib/router-rollups.mjs", import.meta.url));
const { routerMskKey, routerMskTimestampToUtc } = routerRollupsModule;

async function withTempConsoleDataDir(prefix, callback) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const previousDataDir = process.env.GHOSTROUTE_CONSOLE_DATA_DIR;
  process.env.GHOSTROUTE_CONSOLE_DATA_DIR = tmp;
  try {
    return await callback(tmp);
  } finally {
    if (previousDataDir === undefined) delete process.env.GHOSTROUTE_CONSOLE_DATA_DIR;
    else process.env.GHOSTROUTE_CONSOLE_DATA_DIR = previousDataDir;
  }
}

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

test("routing policy snapshots sanitize selected full-VPS state", () => {
  const payload = validateSnapshotPayload("routing_policy", {
    schema_version: 1,
    generated_at: "2026-05-16T08:00:00.000Z",
    source: { command: "policy-snapshot.local", mode: "sanitized" },
    confidence: "exact",
    home_wifi_lan_full_vps: [{
      name: "Test/Home iPad",
      label: "Test/Home iPad",
      ip: "192.0.2.44",
      mac: "02:00:5e:10:00:44",
      ip_token: "ip-aabbccdd",
      mac_token: "mac-ddeeffaa",
      strict_dns_resolver_ip: "192.0.2.53",
      full_vps: true,
    }],
    channel_profiles: [
      { channel: "A", profile: "test-a-full", policy: "full_vps", full_vps: true, full_vps_supported: true },
      { channel: "B", profile: "test-b", policy: "full_vps", full_vps: true, full_vps_supported: true },
      { channel: "C", profile: "test-c", policy: "full_vps", full_vps: true, full_vps_supported: true },
    ],
  });
  const normalized = normalizeRoutingPolicySnapshot(payload, { source_path: "policy-snapshot.local.json" });
  assert.equal(normalized.summary.home_full_vps, 1);
  assert.equal(normalized.summary.channel_a_full_vps, 1);
  assert.equal(normalized.summary.channel_b_profiles, 1);
  assert.equal(normalized.summary.channel_c_profiles, 1);
  assert.equal(normalized.home_wifi_lan_full_vps[0].ip_token, "ip-aabbccdd");
  assert.equal(normalized.home_wifi_lan_full_vps[0].mac_token, "mac-ddeeffaa");
  assert.equal(normalized.home_wifi_lan_full_vps[0].strict_dns_status, "configured");
  assert.equal(normalized.channel_profiles.find((row) => row.channel === "B").full_vps_supported, false);
  assert.equal(normalized.channel_profiles.find((row) => row.channel === "B").full_vps, false);
  assert.equal(normalized.channel_profiles.find((row) => row.channel === "C").policy, "compatibility");
  const serialized = JSON.stringify(normalized);
  assert.equal(serialized.includes("192.0.2.44"), false);
  assert.equal(serialized.includes("02:00:5e:10:00:44"), false);
  assert.equal(serialized.includes("192.0.2.53"), false);
});

test("router rollup helpers preserve MSK bucket identity", () => {
  assert.equal(routerMskTimestampToUtc("2026-05-11T12:35:00+0300"), "2026-05-11T09:35:00.000Z");
  assert.equal(routerMskKey("2026-05-11T00:00:00+0300", "daily"), "2026-05-11");
  assert.equal(routerMskKey("2026-05-01T00:00:00+0300", "monthly"), "2026-05");
  const payload = validateSnapshotPayload("router_rollups", {
    schema_version: 1,
    generated_at: "2026-05-11T09:35:00.000Z",
    source: { command: "router-rollup-export" },
    collector_metrics: { status: "ok" },
    traffic_totals: [{
      layer: "5min",
      window_start_msk: "2026-05-11T12:35:00+0300",
      client_ip: "192.0.2.10",
      channel: "Home Wi-Fi/LAN",
      route: "VPS",
      traffic_class: "client",
      bytes: 100,
      via_vps_bytes: 100,
      direct_bytes: 0,
      unknown_bytes: 0,
      flows: 1,
    }],
    traffic_destinations: [],
    dns_rollups: [],
  });
  assert.equal(payload.traffic_totals[0].layer, "5min");
});

test("traffic facts v2 normalize facts, clients and gaps without synthetic flow rows", () => {
  const db = new Database(":memory:");
  ensureConsoleSchema(db);
  const payload = {
    schema_version: 2,
    generated_at: "2026-05-10T08:00:00.123Z",
    source: { command: "traffic-facts", period: "today" },
    confidence: "mixed",
    window: { period: "today" },
    collector_metrics: { duration_ms: 12, source_row_counts: { traffic_facts: 1, attribution_gaps: 1 } },
    clients: [{
      client_key: "operator-phone",
      client_label: "Operator Phone",
      client_ip: "192.0.2.10",
      hostname: "phone.local",
      mac_hash: "hash",
      channel: "Home Wi-Fi/LAN",
      route: "VPS",
      traffic_class: "client",
      total_bytes: 1500,
      via_vps_bytes: 1500,
      direct_bytes: 0,
      unknown_bytes: 0,
      identity_confidence: "exact",
      sources: ["fixture"],
    }],
    traffic_facts: [{
      fact_id: "fact-1",
      client_key: "operator-phone",
      client_label: "Operator Phone",
      client_ip: "192.0.2.10",
      channel: "Home Wi-Fi/LAN",
      route: "VPS",
      traffic_class: "client",
      destination: "Telegram",
      destination_kind: "category",
      dns_qname: "telegram.org",
      sni: "",
      destination_ip: "",
      bytes: 1500,
      via_vps_bytes: 1500,
      direct_bytes: 0,
      unknown_bytes: 0,
      connections: 3,
      identity_confidence: "exact",
      byte_confidence: "allocated",
      destination_confidence: "dns_family",
      allocation_basis: "dns_family_share",
      evidence_level: "dns_family",
      sources: ["fixture"],
      confidence: "estimated",
      display_ts_utc: "2026-05-10T08:00:00.123Z",
      time_precision: "event_ms",
    }],
    attribution_gaps: [{
      gap_id: "gap-1",
      scope: "Home Wi-Fi/LAN",
      client_key: "lan",
      client_label: "Home Wi-Fi/LAN",
      channel: "Home Wi-Fi/LAN",
      route: "Mixed",
      destination: "Unknown/Unattributed LAN-Wi-Fi",
      bytes: 900,
      via_vps_bytes: 0,
      direct_bytes: 0,
      unknown_bytes: 900,
      reason: "unattributed accounting bucket",
      allocation_basis: "unattributed_bucket",
      evidence_level: "gap",
    }],
    coverage: { observed_bytes: 2400, attributed_bytes: 1500, unattributed_bytes: 900 },
  };
  validateSnapshotPayload("traffic_facts", payload);
  normalizeSnapshot(db, 1, "traffic_facts", payload.generated_at, payload);
  assert.equal(db.prepare("select count(*) as count from traffic_clients").get().count, 1);
  assert.equal(db.prepare("select count(*) as count from traffic_facts").get().count, 1);
  assert.equal(db.prepare("select count(*) as count from traffic_attribution_gaps").get().count, 1);
  assert.equal(db.prepare("select count(*) as count from normalized_flows where destination = 'Unknown/Unattributed LAN-Wi-Fi'").get().count, 0);
  const flow = db.prepare("select client, channel, destination, traffic_class, via_vps_bytes from normalized_flows").get();
  assert.deepEqual(flow, {
    client: "Operator Phone",
    channel: "Home Wi-Fi/LAN",
    destination: "telegram.org",
    traffic_class: "client",
    via_vps_bytes: 1500,
  });
  const duplicatePayload = structuredClone(payload);
  duplicatePayload.generated_at = "2026-05-10T08:01:00.456Z";
  normalizeSnapshot(db, 2, "traffic_facts", duplicatePayload.generated_at, duplicatePayload);
  assert.equal(db.prepare("select count(*) as count from traffic_facts where fact_id = 'fact-1'").get().count, 1);
  rebuildPreparedWindows(db, "2026-05-10T08:10:00.000Z");
  assert.equal(
    db.prepare("select sum(bytes) as bytes from client_traffic_5min where client_key = 'operator-phone'").get().bytes,
    1500
  );
  db.close();
});

test("traffic facts v2 resolves LAN IP facts through private device registry", () => {
  const previousDataDir = process.env.GHOSTROUTE_CONSOLE_DATA_DIR;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghostroute-console-attribution-"));
  process.env.GHOSTROUTE_CONSOLE_DATA_DIR = tmp;
  fs.writeFileSync(path.join(tmp, "device-attribution.local.json"), JSON.stringify({
    clients: {
      "operator-laptop": {
        label: "Operator Laptop",
        device_key: "operator-laptop",
        primary_channel: "Home Wi-Fi/LAN",
        ip_aliases: ["192.0.2.44"],
      },
    },
  }));
  const db = new Database(":memory:");
  try {
    ensureConsoleSchema(db);
    const payload = {
      schema_version: 2,
      generated_at: "2026-05-10T08:00:00.123Z",
      source: { command: "traffic-facts", period: "today" },
      window: { period: "today" },
      traffic_facts: [{
        fact_id: "lan-fact-1",
        client_ip: "192.0.2.44",
        client_label: "192.0.2.44",
        channel: "Home Wi-Fi/LAN",
        route: "VPS",
        traffic_class: "client",
        destination: "198.51.100.10",
        destination_kind: "ip",
        destination_ip: "198.51.100.10",
        bytes: 4096,
        via_vps_bytes: 4096,
        direct_bytes: 0,
        unknown_bytes: 0,
        connections: 1,
        identity_confidence: "exact",
        byte_confidence: "observed_delta",
        destination_confidence: "ip",
        allocation_basis: "conntrack_snapshot_delta",
        evidence_level: "conntrack",
        confidence: "exact",
        display_ts_utc: "2026-05-10T08:00:00.123Z",
        time_precision: "event_ms",
      }],
    };
    normalizeSnapshot(db, 1, "traffic_facts", payload.generated_at, payload);
    const fact = db.prepare("select client_key, client_label, channel from traffic_facts where fact_id = ?").get("lan-fact-1");
    assert.deepEqual(fact, {
      client_key: "operator-laptop",
      client_label: "Operator Laptop",
      channel: "Home Wi-Fi/LAN",
    });
    assert.equal(db.prepare("select client from normalized_flows where destination_ip = ?").get("198.51.100.10").client, "Operator Laptop");
  } finally {
    db.close();
    if (previousDataDir === undefined) delete process.env.GHOSTROUTE_CONSOLE_DATA_DIR;
    else process.env.GHOSTROUTE_CONSOLE_DATA_DIR = previousDataDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("traffic facts remain authoritative for prepared accounting when router rollups exist", () => {
  const previousDataDir = process.env.GHOSTROUTE_CONSOLE_DATA_DIR;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghostroute-console-rollups-"));
  process.env.GHOSTROUTE_CONSOLE_DATA_DIR = tmp;
  fs.writeFileSync(path.join(tmp, "device-attribution.local.json"), JSON.stringify({
    clients: {
      "operator-laptop": {
        label: "Operator Laptop",
        device_key: "operator-laptop",
        primary_channel: "Home Wi-Fi/LAN",
        ip_aliases: ["192.0.2.44"],
      },
    },
  }));
  const db = new Database(":memory:");
  try {
    ensureConsoleSchema(db);
    const rollups = {
      schema_version: 1,
      generated_at: "2026-05-10T08:00:00.123Z",
      source: { command: "router-rollup-export" },
      collector_metrics: { status: "ok" },
      traffic_totals: [{
        layer: "5min",
        window_start_msk: "2026-05-10T11:00:00+0300",
        client_ip: "192.0.2.44",
        channel: "Home Wi-Fi/LAN",
        route: "VPS",
        traffic_class: "client",
        bytes: 9999,
        via_vps_bytes: 9999,
        direct_bytes: 0,
        unknown_bytes: 0,
        flows: 2,
      }],
      traffic_destinations: [],
      dns_rollups: [],
    };
    const facts = {
      schema_version: 2,
      generated_at: "2026-05-10T08:00:00.456Z",
      source: { command: "traffic-facts", period: "today" },
      collector_metrics: {},
      clients: [],
      traffic_facts: [{
        fact_id: "detail-fact",
        client_ip: "192.0.2.44",
        channel: "Home Wi-Fi/LAN",
        route: "VPS",
        traffic_class: "client",
        destination: "example.invalid",
        destination_kind: "domain",
        bytes: 100,
        via_vps_bytes: 0,
        direct_bytes: 0,
        unknown_bytes: 100,
        route_verification: "intent_only",
        accounting_status: "ok",
        connections: 1,
        confidence: "estimated",
      }],
      attribution_gaps: [],
      coverage: {},
    };
    validateSnapshotPayload("router_rollups", rollups);
    validateSnapshotPayload("traffic_facts", facts);
    normalizeSnapshot(db, 1, "router_rollups", rollups.generated_at, rollups);
    normalizeSnapshot(db, 2, "traffic_facts", facts.generated_at, facts);
    rebuildPreparedWindows(db, "2026-05-10T08:10:00.000Z");
    assert.deepEqual(db.prepare("select sum(bytes) as bytes, sum(via_vps_bytes) as vps, sum(direct_bytes) as direct, sum(unknown_bytes) as unknown from client_traffic_5min where client_key = 'operator-laptop'").get(), {
      bytes: 100,
      vps: 0,
      direct: 0,
      unknown: 100,
    });
    assert.equal(db.prepare("select sum(bytes) as bytes from client_destination_traffic_5min where client_key = 'operator-laptop'").get().bytes, 100);
  } finally {
    db.close();
    if (previousDataDir === undefined) delete process.env.GHOSTROUTE_CONSOLE_DATA_DIR;
    else process.env.GHOSTROUTE_CONSOLE_DATA_DIR = previousDataDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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
  const flow = db.prepare("select client, client_ip, sni, outbound, matched_rule, egress_ip, egress_asn, display_ts_utc, time_precision, raw_json from normalized_flows limit 1").get();
  assert.equal(flow.client, "lan-host-01");
  assert.equal(flow.client_ip, "192.168.1.24");
  assert.equal(flow.sni, "telegram.org");
  assert.equal(flow.outbound, "reality-out");
  assert.equal(flow.matched_rule, "STEALTH_DOMAINS");
  assert.equal(flow.egress_ip, "203.0.113.67");
  assert.equal(flow.egress_asn, "AS209529");
  assert.match(flow.display_ts_utc, /\.\d{3}Z$/);
  assert.equal(flow.time_precision, "collector_ms");
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
  assert.equal(db.prepare("select count(*) as count from traffic_window_snapshots where kind = 'dashboard' and window in ('today','week','month')").get().count, 15);
  const preparedDashboard = JSON.parse(db.prepare("select payload_json from traffic_window_snapshots where kind = 'dashboard' and window = 'today' and traffic_class = 'all'").get().payload_json);
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
  db.prepare("update normalized_dns set client_ip = '' where domain = 'telegram.org'").run();
  rebuildPreparedWindows(db, "2026-04-29T00:05:00Z");
  const dnsPrepared = JSON.parse(db.prepare("select payload_json from traffic_window_snapshots where kind = 'dns_counts' and window = 'today'").get().payload_json);
  const preparedDnsRow = dnsPrepared.rows.find((row) => row.domain === "telegram.org");
  assert.equal(preparedDnsRow.client, "lan-host-01");
  assert.equal(preparedDnsRow.client_ip, "192.168.1.24");
  assert.equal(db.prepare("select count(*) as count from device_inventory").get().count > 0, true);
  assert.ok(db.prepare("select 1 from read_model_state where model = 'flow_sessions'").get());
  db.close();
});

test("schema includes collector reliability and post-MVP tables", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghostroute-console-schema-"));
  const db = new Database(path.join(tmp, "ghostroute.db"));
  ensureConsoleSchema(db);
  for (const table of ["hourly_traffic", "retention_runs", "collector_runs", "collector_errors", "events", "route_decisions", "live_cursors", "audit_log", "notifications", "notification_settings", "catalog_reviews", "ops_runs", "read_model_state", "flow_sessions", "dns_query_log", "device_inventory", "alarm_events", "console_settings", "console_page_summaries", "router_traffic_rollups", "client_traffic_5min", "client_traffic_hourly", "client_traffic_daily", "client_traffic_weekly", "client_traffic_monthly", "client_destination_traffic_5min", "client_destination_traffic_hourly", "client_destination_traffic_daily", "client_destination_traffic_weekly", "client_destination_traffic_monthly", "client_traffic_by_lane", "client_destination_by_lane", "client_route_evidence_defects", "ip_prefix_catalog", "ip_enrichment_cache", "dns_log_5min", "dns_log_hourly", "dns_log_daily", "dns_log_weekly", "dns_log_monthly", "top_clients_window", "top_destinations_window", "traffic_window_snapshots", "aggregate_state"]) {
    assert.ok(db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(table), table);
  }
  assert.ok(db.prepare("select version from schema_migrations where version = 6").get());
  assert.ok(db.prepare("select version from schema_migrations where version = 7").get());
  assert.ok(db.prepare("select version from schema_migrations where version = 8").get());
  assert.ok(db.prepare("select version from schema_migrations where version = 9").get());
  assert.ok(db.prepare("select version from schema_migrations where version = 10").get());
  assert.ok(db.prepare("select version from schema_migrations where version = 12").get());
  assert.ok(db.prepare("select version from schema_migrations where version = 13").get());
  assert.ok(db.prepare("select version from schema_migrations where version = 14").get());
  assert.ok(db.prepare("select version from schema_migrations where version = 15").get());
  assert.ok(db.prepare("select version from schema_migrations where version = 16").get());
  assert.ok(db.prepare("select 1 from pragma_table_info('normalized_flows') where name = 'egress_asn'").get());
  assert.ok(db.prepare("select 1 from pragma_table_info('normalized_flows') where name = 'traffic_class'").get());
  assert.ok(db.prepare("select 1 from pragma_table_info('normalized_flows') where name = 'display_ts_utc'").get());
  assert.ok(db.prepare("select 1 from pragma_table_info('normalized_dns') where name = 'time_precision'").get());
  assert.ok(db.prepare("select 1 from pragma_table_info('normalized_devices') where name = 'hostname'").get());
  assert.ok(db.prepare("select 1 from pragma_table_info('normalized_devices') where name = 'mac'").get());
  assert.equal(Boolean(db.prepare("select 1 from pragma_table_info('client_traffic_hourly') where name = 'destination_key'").get()), false);
  assert.equal(Boolean(db.prepare("select 1 from pragma_table_info('client_traffic_daily') where name = 'destination_key'").get()), false);
  assert.ok(db.prepare("select 1 from pragma_table_info('client_destination_traffic_hourly') where name = 'destination_key'").get());
  assert.ok(db.prepare("select 1 from pragma_table_info('client_destination_traffic_daily') where name = 'destination_key'").get());
  assert.ok(db.prepare("select 1 from pragma_table_info('normalized_flows') where name = 'unknown_bytes'").get());
  assert.ok(db.prepare("select 1 from pragma_table_info('flow_sessions') where name = 'egress_asn'").get());
  assert.ok(db.prepare("select 1 from pragma_table_info('flow_sessions') where name = 'dns_qname'").get());
  assert.ok(db.prepare("select 1 from pragma_table_info('flow_sessions') where name = 'traffic_class'").get());
  assert.ok(db.prepare("select 1 from pragma_table_info('dns_query_log') where name = 'display_ts_utc'").get());
  for (const column of ["protocol", "bytes_up", "bytes_down", "route_source", "route_basis", "matched_ipset", "egress_iface", "fwmark", "intended_route", "route_verification", "route_status", "dns_link_id", "dns_link_confidence", "dns_status", "dns_ts_source", "accounting_status"]) {
    assert.ok(db.prepare("select 1 from pragma_table_info('traffic_facts') where name = ?").get(column), column);
  }
  for (const column of ["id", "destination_ip", "destination_port", "protocol", "dns_answer_ip", "dns_event_ts_utc", "dns_ts_source", "flow_event_ts_utc"]) {
    assert.ok(db.prepare("select 1 from pragma_table_info('traffic_dns_links') where name = ?").get(column), column);
  }
  for (const column of ["traffic_class", "traffic_lane", "dns_category", "traffic_role", "traffic_purpose", "decision_hint", "human_explanation", "source", "evidence_sources_json"]) {
    assert.ok(db.prepare("select 1 from pragma_table_info('destination_enrichment') where name = ?").get(column), column);
  }
  for (const column of ["traffic_lane", "dns_category", "decision_hint", "top_destinations_json", "enrichment_status"]) {
    assert.ok(db.prepare("select 1 from pragma_table_info('client_traffic_by_lane') where name = ?").get(column), column);
  }
  for (const column of ["destination_key", "traffic_lane", "dns_category", "decision_hint", "category", "provider", "enrichment_status"]) {
    assert.ok(db.prepare("select 1 from pragma_table_info('client_destination_by_lane') where name = ?").get(column), column);
  }
  for (const column of ["destination_key", "destination_label", "traffic_lane", "dns_category", "category", "provider", "route_evidence", "intended_route", "route_verification", "matched_ipset"]) {
    assert.ok(db.prepare("select 1 from pragma_table_info('client_route_evidence_defects') where name = ?").get(column), column);
  }
  for (const column of ["range_start", "range_end", "range_start_u32", "range_end_u32", "asn", "asn_org", "provider"]) {
    assert.ok(db.prepare("select 1 from pragma_table_info('ip_prefix_catalog') where name = ?").get(column), column);
  }
  assert.ok(db.prepare("select 1 from sqlite_master where type = 'table' and name = 'decision_candidates'").get());
  assert.ok(db.prepare("select 1 from sqlite_master where type = 'index' and name = 'idx_traffic_dns_links_client_dest'").get());
  assert.ok(db.prepare("select 1 from sqlite_master where type = 'index' and name = 'idx_traffic_dns_links_domain_answer'").get());
  assert.ok(db.prepare("select 1 from sqlite_master where type = 'index' and name = 'idx_traffic_facts_client_dest'").get());
  db.close();
});

test("schema repairs traffic intelligence columns even when migration marker already exists", () => {
  const db = new Database(":memory:");
  db.exec(`
    create table schema_migrations(version integer primary key, applied_at text not null);
    insert into schema_migrations(version, applied_at) values (15, '2026-05-12T00:00:00.000Z');
    create table destination_enrichment (
      destination_key text primary key,
      kind text not null,
      value text not null,
      normalized_value text not null,
      category text not null default 'unknown',
      provider text not null default '',
      action_hint text not null default 'monitor',
      confidence text not null default 'unknown',
      reason_code text not null default '',
      sources_json text not null default '[]',
      evidence_json text not null default '{}',
      first_seen text not null,
      last_seen text not null,
      expires_at text not null default ''
    );
  `);
  ensureConsoleSchema(db);
  for (const column of ["traffic_class", "traffic_lane", "dns_category", "traffic_role", "traffic_purpose", "decision_hint", "human_explanation", "source", "evidence_sources_json"]) {
    assert.ok(db.prepare("select 1 from pragma_table_info('destination_enrichment') where name = ?").get(column), column);
  }
  assert.ok(db.prepare("select version from schema_migrations where version = 16").get());
  db.close();
});

test("traffic facts v3 persists route accounting and dns link details", () => {
  const db = new Database(":memory:");
  ensureConsoleSchema(db);
  const payload = {
    schema_version: 3,
    generated_at: "2026-05-11T09:00:00.000Z",
    source: { command: "traffic-facts", source_report: "traffic-evidence" },
    confidence: "mixed",
    window: { period: "today", start_ts_utc: "2026-05-10T21:00:00.000Z", end_ts_utc: "2026-05-11T21:00:00.000Z" },
    collector_metrics: { duration_ms: 1, source_row_counts: { traffic_facts: 1, dns_links: 1 } },
    clients: [],
    traffic_facts: [
      {
        fact_id: "v3-fact-1",
        event_ts_utc: "2026-05-11T09:00:00.000Z",
        client_key: "192.0.2.10",
        client_label: "192.0.2.10",
        client_ip: "192.0.2.10",
        channel: "Home Wi-Fi/LAN",
        route: "VPS",
        traffic_class: "service_background",
        destination: "example.invalid",
        destination_kind: "domain",
        destination_ip: "198.51.100.20",
        destination_port: "443",
        protocol: "tcp",
        dns_qname: "example.invalid",
        dns_answer_ip: "198.51.100.20",
        dns_link_id: "dns-link-1",
        dns_link_confidence: "high",
        bytes: 4200,
        bytes_up: 1200,
        bytes_down: 3000,
        via_vps_bytes: 0,
        direct_bytes: 0,
        unknown_bytes: 4200,
        route_source: "ipset",
        route_basis: "ipset_membership",
        matched_ipset: "STEALTH_DOMAINS",
        egress_iface: "",
        fwmark: "",
        route_verification: "intent_only",
        route_status: "intent_only",
        dns_status: "approximate_ts",
        dns_ts_source: "snapshot_approx",
        accounting_status: "ok",
        confidence: "observed",
      },
      {
        fact_id: "home-reality-1",
        event_ts_utc: "2026-05-11T09:05:00.000Z",
        client_key: "iphone-4",
        client_label: "iphone-4 (Mamulia)",
        client_ip: "198.51.100.10",
        channel: "A/Home Reality",
        route: "Unknown",
        intended_route: "Unknown",
        traffic_class: "client",
        destination: "Home Reality ingress",
        destination_kind: "encrypted_ingress",
        bytes: 4096,
        bytes_up: 1024,
        bytes_down: 3072,
        via_vps_bytes: 0,
        direct_bytes: 0,
        unknown_bytes: 4096,
        route_source: "none",
        route_basis: "home_reality_ingress",
        route_verification: "unknown",
        route_status: "unknown",
        dns_link_confidence: "no_dns_match",
        dns_status: "no_match",
        accounting_status: "ok",
        byte_confidence: "observed_delta",
        destination_confidence: "none",
        allocation_basis: "observed_profile_counter_delta",
        evidence_level: "home_reality_profile_counter",
        confidence: "observed",
      },
      {
        fact_id: "counter-allocated-1",
        event_ts_utc: "2026-05-11T09:06:00.000Z",
        client_key: "192.0.2.11",
        client_label: "192.0.2.11",
        client_ip: "192.0.2.11",
        channel: "Home Wi-Fi/LAN",
        route: "Mixed",
        intended_route: "VPS",
        traffic_class: "client",
        destination: "counter.example.invalid",
        destination_kind: "domain",
        destination_ip: "198.51.100.21",
        destination_port: "443",
        protocol: "tcp",
        bytes: 6000,
        bytes_up: 2000,
        bytes_down: 4000,
        via_vps_bytes: 4000,
        direct_bytes: 1000,
        unknown_bytes: 1000,
        route_source: "ipset",
        route_basis: "client_counter_delta",
        matched_ipset: "STEALTH_DOMAINS",
        route_verification: "counter_allocated",
        dns_link_confidence: "no_dns_match",
        dns_status: "no_match",
        accounting_status: "ok",
        confidence: "observed",
      },
    ],
    dns_links: [{
      id: "dns-link-1",
      client_key: "192.0.2.10",
      client_ip: "192.0.2.10",
      domain: "example.invalid",
      destination: "198.51.100.20",
      destination_ip: "198.51.100.20",
      destination_port: "443",
      protocol: "tcp",
      dns_answer_ip: "198.51.100.20",
      dns_event_ts_utc: "2026-05-11T08:59:00.000Z",
      dns_ts_source: "snapshot_approx",
      flow_event_ts_utc: "2026-05-11T09:00:00.000Z",
      link_type: "exact_client_ip",
      confidence: "high",
    }],
    attribution_gaps: [],
    coverage: {},
  };
  normalizeSnapshot(db, 1, "traffic_facts", payload.generated_at, payload);
  const fact = db.prepare("select protocol, bytes_up, bytes_down, route_source, route_basis, matched_ipset, intended_route, route_verification, route_status, dns_link_id, dns_link_confidence, dns_status, dns_ts_source, accounting_status from traffic_facts where fact_id = 'v3-fact-1'").get();
  assert.equal(fact.protocol, "tcp");
  assert.equal(fact.bytes_up, 1200);
  assert.equal(fact.bytes_down, 3000);
  assert.equal(fact.route_source, "ipset");
  assert.equal(fact.route_basis, "ipset_membership");
  assert.equal(fact.matched_ipset, "STEALTH_DOMAINS");
  assert.equal(fact.intended_route, "VPS");
  assert.equal(fact.route_verification, "intent_only");
  assert.equal(fact.route_status, "intent_only");
  const counterAllocated = db.prepare("select route_verification, route_status, via_vps_bytes, direct_bytes, unknown_bytes from traffic_facts where fact_id = 'counter-allocated-1'").get();
  assert.equal(counterAllocated.route_verification, "counter_allocated");
  assert.equal(counterAllocated.route_status, "counter_allocated");
  assert.equal(counterAllocated.via_vps_bytes + counterAllocated.direct_bytes + counterAllocated.unknown_bytes, 6000);
  assert.equal(fact.dns_link_id, "dns-link-1");
  assert.equal(fact.dns_link_confidence, "high");
  assert.equal(fact.dns_status, "approximate_ts");
  assert.equal(fact.dns_ts_source, "snapshot_approx");
  assert.equal(fact.accounting_status, "ok");
  const link = db.prepare("select id, destination_ip, destination_port, protocol, dns_answer_ip, dns_event_ts_utc, dns_ts_source, flow_event_ts_utc from traffic_dns_links where id = 'dns-link-1'").get();
  assert.equal(link.destination_ip, "198.51.100.20");
  assert.equal(link.destination_port, "443");
  assert.equal(link.protocol, "tcp");
  assert.equal(link.dns_answer_ip, "198.51.100.20");
  assert.equal(link.dns_event_ts_utc, "2026-05-11T08:59:00.000Z");
  assert.equal(link.dns_ts_source, "snapshot_approx");
  assert.equal(link.flow_event_ts_utc, "2026-05-11T09:00:00.000Z");
  const enrichment = db.prepare("select category, traffic_class, traffic_lane, dns_category, traffic_role, decision_hint, source from destination_enrichment where destination_key = 'example.invalid'").get();
  assert.equal(enrichment.category, "unknown.domain");
  assert.equal(enrichment.traffic_class, "unclassified");
  assert.equal(enrichment.traffic_lane, "unknown_review");
  assert.equal(enrichment.dns_category, "unknown_domain");
  assert.equal(enrichment.traffic_role, "unknown");
  assert.equal(enrichment.decision_hint, "ask_user");
  assert.equal(enrichment.source, "local_rules");
  const candidate = db.prepare("select proposed_action, status, applied from decision_candidates where destination_key = 'example.invalid'").get();
  assert.equal(candidate.proposed_action, "ask_user");
  assert.equal(candidate.status, "pending");
  assert.equal(candidate.applied, 0);
  const homeReality = db.prepare("select destination, traffic_class, bytes, via_vps_bytes, direct_bytes, unknown_bytes, route_verification, dns_status, outbound from traffic_facts where fact_id = 'home-reality-1'").get();
  assert.equal(homeReality.destination, "Home Reality ingress");
  assert.equal(homeReality.traffic_class, "client");
  assert.equal(homeReality.bytes, 4096);
  assert.equal(homeReality.via_vps_bytes, 0);
  assert.equal(homeReality.direct_bytes, 0);
  assert.equal(homeReality.unknown_bytes, 4096);
  assert.equal(homeReality.route_verification, "unknown");
  assert.equal(homeReality.dns_status, "no_match");
  assert.equal(homeReality.outbound, "");
  const homeRealityEnrichment = db.prepare("select category, traffic_class, traffic_lane, dns_category, decision_hint from destination_enrichment where destination_key = 'home reality ingress'").get();
  assert.equal(homeRealityEnrichment.category, "client.home_reality_ingress");
  assert.equal(homeRealityEnrichment.traffic_class, "client");
  assert.equal(homeRealityEnrichment.traffic_lane, "client_observed");
  assert.equal(homeRealityEnrichment.dns_category, "user_content");
  assert.equal(homeRealityEnrichment.decision_hint, "monitor");
  rebuildPreparedWindows(db, "2026-05-11T09:10:00.000Z");
  const laneRows = db.prepare("select traffic_lane, dns_category, decision_hint, sum(bytes) as bytes from client_traffic_by_lane where bucket_granularity = '5min' and traffic_lane != 'all' group by traffic_lane, dns_category, decision_hint order by traffic_lane").all();
  assert.deepEqual(laneRows.map((row) => [row.traffic_lane, row.dns_category, row.decision_hint, row.bytes]), [
    ["client_observed", "user_content", "monitor", 4096],
    ["unknown_review", "unknown_domain", "ask_user", 10200],
  ]);
  const allLaneBytes = db.prepare("select sum(bytes) as bytes from client_traffic_by_lane where bucket_granularity = '5min' and traffic_lane = 'all'").get().bytes;
  const detailLaneBytes = db.prepare("select sum(bytes) as bytes from client_destination_by_lane where bucket_granularity = '5min'").get().bytes;
  assert.equal(allLaneBytes, detailLaneBytes);
  const unknownDestination = db.prepare("select destination_key, traffic_lane, dns_category, decision_hint, category from client_destination_by_lane where bucket_granularity = '5min' and destination_key = 'example.invalid'").get();
  assert.equal(unknownDestination.traffic_lane, "unknown_review");
  assert.equal(unknownDestination.dns_category, "unknown_domain");
  assert.equal(unknownDestination.decision_hint, "ask_user");
  assert.equal(unknownDestination.category, "unknown.domain");
  const routeDefect = db.prepare("select destination_key, traffic_lane, dns_category, route_evidence, unknown_bytes from client_route_evidence_defects where bucket_granularity = '5min' and client_key = 'iphone-4'").get();
  assert.equal(routeDefect.destination_key, "Home Reality ingress");
  assert.equal(routeDefect.traffic_lane, "client_observed");
  assert.equal(routeDefect.dns_category, "user_content");
  assert.equal(routeDefect.route_evidence, "unknown_route");
  assert.equal(routeDefect.unknown_bytes, 4096);
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
  assert.equal(db.prepare("select count(*) as count from flow_sessions where destination = 'Unknown/Unattributed LAN-Wi-Fi'").get().count, 0);
  const total = db.prepare("select sum(bytes) as total from flow_sessions").get().total;
  assert.equal(total, attributed);
  db.close();
});

test("traffic class separates client personal cloud service background and attribution gaps", () => {
  assert.equal(trafficClassFor({ destination: "Google/YouTube", bytes: 1024, confidence: "estimated" }), "client");
  assert.equal(trafficClassFor({ destination: "Apple/iCloud", bytes: 1024, confidence: "estimated" }), "personal_cloud");
  assert.equal(trafficClassFor({ destination: "www.dropbox.com", bytes: 1024, confidence: "estimated" }), "personal_cloud");
  assert.equal(trafficClassFor({ destination: "DNS/Resolver", bytes: 1024, confidence: "estimated" }), "service_background");
  assert.equal(trafficClassFor({ domain: "_dns.resolver.arpa", qtype: "PTR", count: 2, confidence: "dns-interest" }), "service_background");
  assert.equal(trafficClassFor({ domain: "miro.com", count: 2, confidence: "dns-interest" }), "client");
  assert.equal(trafficClassFor({ destination: "Other", bytes: 1024, confidence: "estimated" }), "unclassified");
  assert.equal(trafficClassFor({ destination: "Other/IP", bytes: 1024, confidence: "estimated" }), "unclassified");
  assert.equal(displayDestination({ destination: "Other", bytes: 1024, confidence: "estimated" }), "Unclassified domain");
  assert.equal(displayDestination({ destination: "Other/IP", bytes: 1024, confidence: "estimated" }), "IP-only / no DNS match");
  assert.equal(displayDestination({ destination: "Other", bytes: 0, confidence: "dns-interest" }), "DNS-only interest");
  assert.equal(trafficClassFor({ destination: "Unknown/Unattributed LAN-Wi-Fi", bytes: 1024, accounting_bucket: true }), "unclassified");
});

test("domain breakdown scales category evidence to authoritative client total", () => {
  const breakdown = normalizeDomainBreakdown([
    { destination: "Apple/iCloud", bytes: 6000, via_vps_bytes: 6000, trafficClass: "personal_cloud", route: "VPS" },
    { destination: "Google/YouTube", bytes: 3000, via_vps_bytes: 2000, direct_bytes: 1000, trafficClass: "client", route: "Mixed" },
    { destination: "Other/IP", bytes: 1000, direct_bytes: 1000, trafficClass: "unclassified", route: "Direct" },
  ], 2000, { limit: 8, minimumCoverageRatio: 0.5 });
  assert.equal(breakdown.scaled, true);
  assert.equal(breakdown.unattributedBytes, 0);
  assert.equal(breakdown.rows.reduce((sum, row) => sum + row.bytes, 0), 2000);
  assert.equal(breakdown.rows[0].destination, "Apple/iCloud");
  assert.equal(breakdown.rows[0].trafficClass, "personal_cloud");

  const sparse = normalizeDomainBreakdown([
    { destination: "Google/YouTube", bytes: 100, trafficClass: "client", route: "VPS" },
  ], 2000, { limit: 8, minimumCoverageRatio: 0.5 });
  assert.equal(sparse.scaled, false);
  assert.equal(sparse.unattributedBytes, 1900);
});

test("domain attribution module classifies personal cloud service client and unresolved domains", () => {
  assert.equal(trafficDomainLabel({ dns_qname: "api.example.invalid", destination: "" }), "api.example.invalid");
  assert.equal(trafficDomainLabel({ destination: "unknown", sni: "video.example.invalid" }), "video.example.invalid");
  assert.equal(isPersonalCloudDomain("mask.icloud.com"), true);
  assert.equal(isPersonalCloudDomain("www.dropbox.com"), true);
  assert.equal(isServiceDomain("mask.icloud.com"), false);
  assert.equal(isServiceDomain("configuration.apple.com"), true);
  assert.equal(isServiceDomain("a123.dscg.akamai.net"), true);
  assert.equal(isServiceDomain("assets.cloudfront.net"), true);
  assert.equal(isServiceDomain("www.youtube.com"), false);
  assert.equal(isUnclassifiedDomain("Other/IP"), true);
  assert.equal(isUnclassifiedDomain("Unknown/Unattributed client traffic"), true);
  assert.equal(trafficClassForDomain({ destination: "configuration.apple.com", bytes: 2048 }), "service_background");
  assert.equal(trafficClassForDomain({ destination: "Apple/iCloud", bytes: 2048 }), "personal_cloud");
  assert.equal(trafficClassForDomain({ destination: "www.youtube.com", bytes: 2048 }), "client");
  assert.equal(trafficClassForDomain({ destination: "Other/IP", bytes: 2048 }), "unclassified");
  assert.equal(trafficClassForDomain({ domain: "dns.msftncsi.com", count: 4, confidence: "dns-interest" }), "service_background");
});

test("local traffic intelligence returns deterministic labels and action hints", () => {
  assert.deepEqual(
    pick(trafficIntelligenceFor({ destination: "app-measurement.com" })),
    { category: "analytics.firebase", traffic_lane: "privacy_risk", dns_category: "analytics", action_hint: "block_candidate" }
  );
  assert.deepEqual(
    pick(trafficIntelligenceFor({ destination: "push.apple.com" })),
    { category: "system.apple.push", traffic_lane: "service_system", dns_category: "system_push", action_hint: "allow" }
  );
  assert.deepEqual(
    pick(trafficIntelligenceFor({ destination: "www.dropbox.com" })),
    { category: "personal_cloud.dropbox", traffic_lane: "client_observed", dns_category: "personal_cloud", action_hint: "monitor" }
  );
  assert.deepEqual(
    pick(trafficIntelligenceFor({ destination_ip: "192.0.2.20" })),
    { category: "unknown.ip_only", traffic_lane: "unknown_review", dns_category: "unknown_ip_only", action_hint: "ask_user" }
  );
  assert.deepEqual(
    pick(trafficIntelligenceFor({ destination_ip: "192.0.2.20", dns_link_confidence: "no_dns_match" })),
    { category: "unknown.no_dns_match", traffic_lane: "unknown_review", dns_category: "unknown_ip_only", action_hint: "ask_user" }
  );
  assert.deepEqual(
    pick(trafficIntelligenceFor({ destination: "", dns_link_confidence: "low" })),
    { category: "unknown.shared_dns_answer", traffic_lane: "unknown_review", dns_category: "unknown_shared_answer", action_hint: "ask_user" }
  );
  assert.deepEqual(
    pick(trafficIntelligenceFor({ destination: "unknown-service.example.invalid" })),
    { category: "unknown.domain", traffic_lane: "unknown_review", dns_category: "unknown_domain", action_hint: "ask_user" }
  );
  assert.deepEqual(
    pick(trafficIntelligenceFor({ destination: "Home Reality ingress", destination_kind: "encrypted_ingress" })),
    { category: "client.home_reality_ingress", traffic_lane: "client_observed", dns_category: "user_content", action_hint: "monitor" }
  );
  assert.deepEqual(
    pick(trafficIntelligenceFor({ destination: "rr1.sn-ajixh5-55.googlevideo.com" })),
    { category: "client.google.youtube", traffic_lane: "client_observed", dns_category: "media_streaming", action_hint: "monitor" }
  );
  assert.deepEqual(
    pick(trafficIntelligenceFor({ destination: "api.anthropic.com" })),
    { category: "client.ai.anthropic", traffic_lane: "client_observed", dns_category: "ai_assistant", action_hint: "monitor" }
  );
  assert.deepEqual(
    pick(trafficIntelligenceFor({ destination: "zoomfrarr62mmr.fra.zoom.us" })),
    { category: "client.meeting.zoom", traffic_lane: "client_observed", dns_category: "meeting_platform", action_hint: "monitor" }
  );
  assert.deepEqual(
    pick(trafficIntelligenceFor({ destination: "eu-central-courier-4.push-apple.com.akadns.net" })),
    { category: "system.apple.push", traffic_lane: "service_system", dns_category: "system_push", action_hint: "allow" }
  );
});

function pick(row) {
  return { category: row.category, traffic_lane: row.traffic_lane, dns_category: row.dns_category, action_hint: row.action_hint };
}

test("domain breakdown keeps client personal cloud and unclassified rows separate after scaling", () => {
  const breakdown = normalizeDomainBreakdown([
    { destination: "Apple/iCloud", bytes: 700, via_vps_bytes: 700 },
    { destination: "www.youtube.com", bytes: 200, via_vps_bytes: 100, direct_bytes: 100 },
    { destination: "Other/IP", bytes: 100, direct_bytes: 100 },
    { destination: "Unknown/Unattributed client traffic", bytes: 5000, accounting_bucket: true },
  ], 100, { limit: 8, minimumCoverageRatio: 0.5 });
  assert.equal(breakdown.scaled, true);
  assert.equal(breakdown.rows.reduce((sum, row) => sum + row.bytes, 0), 100);
  assert.deepEqual(breakdown.rows.map((row) => row.trafficClass), ["personal_cloud", "client", "unclassified"]);
  assert.equal(breakdown.rows.some((row) => row.accounting_bucket), false);
});

test("domain breakdown avoids manufacturing attribution from sparse evidence", () => {
  const breakdown = normalizeDomainBreakdown([
    { destination: "www.youtube.com", bytes: 50, via_vps_bytes: 50 },
    { destination: "Other/IP", bytes: 25, direct_bytes: 25 },
  ], 1000, { limit: 8, minimumCoverageRatio: 0.5 });
  assert.equal(breakdown.scaled, false);
  assert.equal(breakdown.rows.reduce((sum, row) => sum + row.bytes, 0), 75);
  assert.equal(breakdown.unattributedBytes, 925);
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
  assert.equal(row.traffic_class, "unclassified");
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

test("operational pruning keeps only the latest traffic facts snapshot", () => {
  const db = new Database(":memory:");
  ensureConsoleSchema(db);
  const insertSnapshot = db.prepare("insert into snapshots(id, type, collected_at, source, path, payload_json) values (?, 'traffic_facts', ?, 'test', '', '{}')");
  const payloadFor = (factId, generatedAt, bytes) => ({
    schema_version: 3,
    generated_at: generatedAt,
    source: { command: "traffic-facts", source_report: "traffic-evidence" },
    confidence: "observed",
    window: { period: "today", start_ts_utc: "2026-05-11T21:00:00.000Z", end_ts_utc: "2026-05-12T21:00:00.000Z" },
    collector_metrics: { duration_ms: 1, source_row_counts: { traffic_facts: 1 } },
    clients: [],
    traffic_facts: [{
      fact_id: factId,
      event_ts_utc: generatedAt,
      client_key: "client-1",
      client_label: "Client 1",
      client_ip: "192.0.2.10",
      channel: "Home Wi-Fi/LAN",
      route: "VPS",
      intended_route: "VPS",
      traffic_class: "client",
      destination: "example.invalid",
      destination_kind: "domain",
      bytes,
      via_vps_bytes: bytes,
      direct_bytes: 0,
      unknown_bytes: 0,
      route_verification: "counter_allocated",
      route_status: "counter_allocated",
      accounting_status: "ok",
      confidence: "observed",
    }],
    dns_links: [],
    attribution_gaps: [],
    coverage: {},
  });
  insertSnapshot.run(1, "2026-05-12T08:00:00.000Z");
  normalizeSnapshot(db, 1, "traffic_facts", "2026-05-12T08:00:00.000Z", payloadFor("old-fact", "2026-05-12T08:00:00.000Z", 1000));
  insertSnapshot.run(2, "2026-05-12T09:00:00.000Z");
  normalizeSnapshot(db, 2, "traffic_facts", "2026-05-12T09:00:00.000Z", payloadFor("new-fact", "2026-05-12T09:00:00.000Z", 2000));
  db.prepare("insert into flow_sessions(id, snapshot_id, collected_at, client, destination, bytes) values (?, ?, ?, ?, ?, ?)").run("old-session", 1, "2026-05-12T08:00:00.000Z", "Client 1", "old.example.invalid", 1000);
  db.prepare("insert into flow_sessions(id, snapshot_id, collected_at, client, destination, bytes) values (?, ?, ?, ?, ?, ?)").run("new-session", 2, "2026-05-12T09:00:00.000Z", "Client 1", "new.example.invalid", 2000);

  assert.equal(db.prepare("select count(*) as count from traffic_facts").get().count, 2);
  const pruned = pruneOperationalTables(db, "2026-05-12T10:00:00.000Z");
  assert.equal(pruned.superseded_traffic_fact_snapshots, 1);
  assert.equal(db.prepare("select group_concat(id) as ids from snapshots where type = 'traffic_facts'").get().ids, "2");
  assert.equal(db.prepare("select group_concat(snapshot_id) as ids from traffic_facts").get().ids, "2");
  assert.equal(db.prepare("select group_concat(snapshot_id) as ids from normalized_flows").get().ids, "2");
  assert.equal(db.prepare("select group_concat(snapshot_id) as ids from flow_sessions").get().ids, "2");
  db.close();
});

test("time helper produces stable MSK windows over UTC storage", () => {
  assert.equal(toMskKey("2026-05-09T10:17:42.000Z", "5min"), "2026-05-09T13:15");
  assert.equal(bucketStartUtc("2026-05-09T10:17:42.000Z", "5min"), "2026-05-09T10:15:00.000Z");
  assert.equal(toUtcIsoFromMskKey("2026-05-09", "day"), "2026-05-08T21:00:00.000Z");
  assert.equal(toUtcIsoFromMskKey("2026-05-10T24:40", "5min"), "2026-05-09T21:40:00.000Z");
  assert.deepEqual(mskWindowBounds("week", "2026-05-09T10:17:42.000Z").startMskKey, "2026-05-04");
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
    insert.run(1, "2026-05-07T08:06:00Z", "lan-host-13", "Home Wi-Fi/LAN", "unknown destination", "Direct", "estimated", 1000, 0, "", "client", 0, 1000, 0, JSON.stringify({ client: "lan-host-13", accounting_bucket: true }));
    insert.run(1, "2026-05-07T08:07:00Z", "lan-host-13", "Home Wi-Fi/LAN", "unknown destination", "Mixed", "estimated", 1200, 0, "", "client", 200, 1000, 0, JSON.stringify({ client: "lan-host-13", accounting_bucket: true }));
    insert.run(1, "2026-05-07T08:08:00Z", "192.0.2.44", "Home Wi-Fi/LAN", "unknown destination", "Mixed", "estimated", 1300, 0, "192.0.2.44", "client", 300, 1000, 0, JSON.stringify({ client: "192.0.2.44", client_ip: "192.0.2.44", accounting_bucket: true }));
    insert.run(1, "2026-05-07T08:10:00Z", "A/Home Reality", "A/Home Reality", "internal.example", "Unknown", "estimated", 6, 1, "", "client", 0, 0, 6, JSON.stringify({ client: "A/Home Reality" }));
    insert.run(1, "2026-05-07T08:15:00Z", "lan-host-99", "Home Wi-Fi/LAN", "unregistered.example", "Direct", "exact", 900, 5, "", "client", 0, 900, 0, JSON.stringify({ client: "lan-host-99" }));
    insert.run(1, "2026-05-07T08:20:00Z", "iphone-1", "A/Home Reality", "ai.example", "VPS", "exact", 500, 3, "", "client", 500, 0, 0, JSON.stringify({ profile: "iphone-1" }));

    rebuildPreparedWindows(db, "2026-05-07T09:00:00Z");
    const preparedDashboard = JSON.parse(db.prepare("select payload_json from traffic_window_snapshots where kind = 'dashboard' and window = 'today' and traffic_class = 'all'").get().payload_json);
    const labels = preparedDashboard.dashboardAnalytics.topClients.map((row) => row.label);
    assert.deepEqual(labels, ["macbook (Operator MacBook)", "operator-phone (Operator iPhone)"]);
    assert.equal(preparedDashboard.dashboardAnalytics.topClients.some((row) => row.bytes <= 0), false);
    assert.equal(preparedDashboard.dashboardAnalytics.topClients[0].bytes, 3400);
    assert.equal(preparedDashboard.dashboardAnalytics.topClients[0].totalBytes, 3400);
    assert.equal(preparedDashboard.dashboardAnalytics.topClients[0].unknownBytes, 0);
    assert.equal(labels.some((label) => /A\/Home Reality|lan-host-99/.test(label)), false);
    assert.equal(preparedDashboard.dashboardAnalytics.topDestinations[0].label, "large-download.example");
    assert.equal(db.prepare("select client_key from client_destination_traffic_5min where destination_key = 'torrent.example'").get().client_key, "macbook");
    assert.equal(db.prepare("select client_key from client_destination_traffic_5min where destination_key = 'large-download.example'").get().client_key, "macbook");
    assert.equal(db.prepare("select count(*) as count from pragma_table_info('client_traffic_5min') where name = 'destination_key'").get().count, 0);
    assert.equal(db.prepare("select count(*) as count from client_traffic_hourly where substr(hour_start_utc, 15, 5) != '00:00'").get().count, 0);
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

test("prepared DNS and client totals share canonical operator identity", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghostroute-console-canonical-client-"));
  fs.writeFileSync(
    path.join(tmp, "device-attribution.json"),
    JSON.stringify({
      schema_version: 2,
      clients: {
        macbook: {
          label: "MacBook Owner",
          device_key: "operator-macbook",
          aliases: { lan_wifi: ["lan-host-11"], hostnames: ["operator-macbook.local"] },
          ip_aliases: ["192.0.2.44"],
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
      values ('lan-host-11', 'lan-host-11 (Unknown device)', '192.0.2.44', 'operator-macbook.local', '', '["lan-host-11"]',
        'lan-host-11', 'trusted', 'MacBook', 'Home Wi-Fi/LAN', 'Mixed', 'exact', '2026-05-07T08:00:00Z',
        0, 0, 0, 0, '[]', 'OK', 'low', '{}')
    `).run();
    db.prepare(`
      insert into normalized_flows(snapshot_id, snapshot_type, collected_at, client, channel, destination, route, confidence,
        bytes, connections, protocol, client_ip, traffic_class, via_vps_bytes, direct_bytes, unknown_bytes, raw_json)
      values (1, 'traffic', '2026-05-07T08:00:00Z', '192.0.2.44', 'Home Wi-Fi/LAN', 'unknown destination',
        'Mixed', 'estimated', 40000000, 8, 'TCP', '192.0.2.44', 'client', 30000000, 10000000, 0,
        '{"client":"192.0.2.44","client_ip":"192.0.2.44","device_key":"192.0.2.44"}')
    `).run();
    const insertDns = db.prepare(`
      insert into normalized_dns(snapshot_id, collected_at, client, client_ip, domain, qtype, count, answer_ip,
        event_ts, event_ts_utc, observed_at_utc, display_ts_utc, time_precision, ts_confidence, confidence, raw_json)
      values (2, ?, ?, ?, ?, 'A', ?, '', ?, ?, ?, ?, 'collector_ms', 'exact', 'dns-interest', ?)
    `);
    insertDns.run("2026-05-07T08:01:00Z", "unattributed source", "", "chatgpt.com", 12,
      "2026-05-07T08:01:00Z", "2026-05-07T08:01:00Z", "2026-05-07T08:01:00Z", "2026-05-07T08:01:00Z",
      JSON.stringify({ client_ip: "192.0.2.44", device_key: "192.0.2.44" }));
    insertDns.run("2026-05-07T08:02:00Z", "192.0.2.44", "192.0.2.44", "www.youtube.com", 8,
      "2026-05-07T08:02:00Z", "2026-05-07T08:02:00Z", "2026-05-07T08:02:00Z", "2026-05-07T08:02:00Z",
      JSON.stringify({ client_ip: "192.0.2.44", device_key: "192.0.2.44" }));

    rebuildPreparedWindows(db, "2026-05-07T09:00:00Z");

    assert.equal(
      db.prepare("select sum(query_count) as count from dns_log_5min where client_key = 'macbook'").get().count,
      20
    );
    assert.equal(
      db.prepare("select count(*) as count from dns_log_5min where client_key = '192.0.2.44'").get().count,
      0
    );
    assert.equal(
      db.prepare("select sum(bytes) as bytes from client_traffic_by_lane where client_key = 'macbook' and traffic_lane = 'all' and bucket_granularity = 'day'").get().bytes,
      40000000
    );
    assert.equal(
      db.prepare("select sum(bytes) as bytes from client_traffic_by_lane where client_key = 'macbook' and traffic_lane = 'all' and traffic_class = 'all' and bucket_granularity = 'day'").get().bytes,
      40000000
    );
  } finally {
    db.close();
    if (previousDataDir === undefined) delete process.env.GHOSTROUTE_CONSOLE_DATA_DIR;
    else process.env.GHOSTROUTE_CONSOLE_DATA_DIR = previousDataDir;
  }
});

test("prepared counters preserve canonical client totals when flow detail is sampled", async () => {
  await withTempConsoleDataDir("ghostroute-console-client-counter-coverage-", async (tmp) => {
    fs.writeFileSync(
      path.join(tmp, "device-attribution.json"),
      JSON.stringify({
        schema_version: 2,
        clients: {
          macbook: {
            label: "MacBook Owner",
            device_key: "operator-macbook",
            aliases: { lan_wifi: ["lan-host-11"], hostnames: ["operator-macbook.local"] },
            ip_aliases: ["192.0.2.44"],
          },
        },
      })
    );
    const db = new Database(path.join(tmp, "ghostroute.db"));
    try {
      ensureConsoleSchema(db);
      const deviceStmt = db.prepare(`
        insert into normalized_devices(snapshot_id, snapshot_type, collected_at, device_id, label, ip, route, confidence,
          total_bytes, via_vps_bytes, direct_bytes, raw_json, channel)
        values (?, 'traffic_summary', ?, '192.0.2.44', 'lan-host-11', '192.0.2.44', 'Mixed', 'exact', ?, ?, ?, ?, 'Home Wi-Fi/LAN')
      `);
      deviceStmt.run(1, "2026-05-07T08:00:00Z", 1_000_000_000, 900_000_000, 100_000_000, JSON.stringify({ id: "192.0.2.44", label: "lan-host-11", ip: "192.0.2.44" }));
      deviceStmt.run(2, "2026-05-07T09:00:00Z", 8_000_000_000, 7_200_000_000, 800_000_000, JSON.stringify({ id: "192.0.2.44", label: "lan-host-11", ip: "192.0.2.44" }));
      const flowStmt = db.prepare(`
        insert into normalized_flows(snapshot_id, snapshot_type, collected_at, client, channel, destination, route, confidence,
          bytes, connections, protocol, client_ip, traffic_class, via_vps_bytes, direct_bytes, unknown_bytes, raw_json)
        values (3, 'traffic_facts', ?, '192.0.2.44', 'Home Wi-Fi/LAN', 'unknown destination',
          'Mixed', 'estimated', 100000000, 12, 'TCP', '192.0.2.44', 'client', 90000000, 10000000, 0,
          '{"client":"192.0.2.44","client_ip":"192.0.2.44","device_key":"192.0.2.44"}')
      `);
      flowStmt.run("2026-05-07T09:02:00Z");
      const dnsStmt = db.prepare(`
        insert into normalized_dns(snapshot_id, collected_at, client, client_ip, domain, qtype, count, answer_ip,
          event_ts, event_ts_utc, observed_at_utc, display_ts_utc, time_precision, ts_confidence, confidence, raw_json)
        values (4, ?, ?, ?, ?, 'A', ?, '', ?, ?, ?, ?, 'collector_ms', 'exact', 'dns-interest', ?)
      `);
      const dnsRows = [
        ["chatgpt.com", 50],
        ["www.youtube.com", 40],
        ["github.com", 30],
        ["api.github.com", 20],
        ["dropbox.com", 10],
      ];
      for (const [domain, count] of dnsRows) {
        dnsStmt.run("2026-05-07T09:03:00Z", "unattributed source", "", domain, count,
          "2026-05-07T09:03:00Z", "2026-05-07T09:03:00Z", "2026-05-07T09:03:00Z", "2026-05-07T09:03:00Z",
          JSON.stringify({ client_ip: "192.0.2.44", device_key: "192.0.2.44" }));
      }

      rebuildPreparedWindows(db, "2026-05-07T10:00:00Z");
    } finally {
      db.close();
    }

    const checkDb = new Database(path.join(tmp, "ghostroute.db"), { readonly: true });
    try {
      const prepared = JSON.parse(checkDb.prepare("select payload_json from traffic_window_snapshots where kind = 'clients' and window = 'today' and traffic_class = 'all'").get().payload_json);
      const macbook = prepared.rows.find((row) => row.client_key === "macbook");
      assert.ok(macbook, "canonical MacBook row should be visible");
      assert.ok(Number(macbook.total_bytes || macbook.bytes || 0) >= 6_900_000_000, `MacBook current total too low: ${macbook.total_bytes || macbook.bytes}`);
      assert.equal(checkDb.prepare("select sum(query_count) as count from dns_log_5min where client_key = 'macbook'").get().count, 150);
    } finally {
      checkDb.close();
    }
  });
});

test("prepared dashboard top destinations exclude client counter pseudo labels", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghostroute-console-prepared-destinations-"));
  fs.writeFileSync(path.join(tmp, "device-attribution.json"), JSON.stringify({
    schema_version: 2,
    clients: {
      phone: { label: "phone", aliases: { lan_wifi: ["lan-host-08"] } },
    },
  }));
  const previousDataDir = process.env.GHOSTROUTE_CONSOLE_DATA_DIR;
  process.env.GHOSTROUTE_CONSOLE_DATA_DIR = tmp;
  const db = new Database(path.join(tmp, "ghostroute.db"));
  try {
    ensureConsoleSchema(db);
    const insert = db.prepare(`
      insert into normalized_flows(snapshot_id, snapshot_type, collected_at, client, channel, destination, route, confidence,
        bytes, connections, protocol, client_ip, traffic_class, via_vps_bytes, direct_bytes, unknown_bytes, raw_json)
      values (1, 'traffic', ?, 'lan-host-08', 'Home Wi-Fi/LAN', ?, 'Direct', 'estimated', ?, 1, 'TCP', '', 'client', 0, ?, 0, ?)
    `);
    insert.run("2026-05-07T08:00:00Z", "Client", 10_000, 10_000, JSON.stringify({ client: "lan-host-08", destination_evidence: "counter" }));
    insert.run("2026-05-07T08:01:00Z", "media.example.invalid", 1_000, 1_000, JSON.stringify({ client: "lan-host-08" }));
    rebuildPreparedWindows(db, "2026-05-07T09:00:00Z");
    const payload = JSON.parse(db.prepare("select payload_json from traffic_window_snapshots where kind = 'dashboard' and window = 'today' and traffic_class = 'all'").get().payload_json);
    assert.deepEqual(payload.dashboardAnalytics.topDestinations.map((row) => row.label), ["media.example.invalid"]);
  } finally {
    db.close();
    if (previousDataDir === undefined) delete process.env.GHOSTROUTE_CONSOLE_DATA_DIR;
    else process.env.GHOSTROUTE_CONSOLE_DATA_DIR = previousDataDir;
  }
});

test("prepared traffic windows exclude legacy report-derived facts from current GUI totals", () => {
  const db = new Database(":memory:");
  try {
    ensureConsoleSchema(db);
    const insert = db.prepare(`
      insert into normalized_flows(snapshot_id, snapshot_type, collected_at, client, channel, destination, route, confidence,
        bytes, connections, protocol, client_ip, traffic_class, via_vps_bytes, direct_bytes, unknown_bytes, raw_json)
      values (?, 'traffic_facts', ?, ?, ?, ?, ?, ?, ?, ?, 'TCP', ?, 'client', ?, ?, ?, ?)
    `);
    insert.run(10, "2026-05-12T02:00:00.000Z", "iphone-4 (Mamulia)", "A/Home Reality", "Apple/iCloud", "VPS", "estimated",
      20_000_000_000, 10, "192.0.2.40", 20_000_000_000, 0, 0, JSON.stringify({
        client: "report-mobile-profile-02",
        allocation_basis: "connection_share",
        evidence_level: "domain_or_sni",
        sources: ["traffic-report"],
      }));
    insert.run(11, "2026-05-12T04:00:00.000Z", "iphone-4 (Mamulia)", "A/Home Reality", "push.apple.com", "VPS", "estimated",
      1_500, 2, "192.0.2.40", 0, 0, 1_500, JSON.stringify({
        fact_id: "v3-iphone-4-apple-push",
        schema_version: 3,
        route_verification: "intent_only",
        accounting_status: "ok",
        dns_link_confidence: "medium",
        unknown_bytes: 1_500,
      }));

    rebuildPreparedWindows(db, "2026-05-12T05:00:00.000Z");

    const topClient = db.prepare("select * from top_clients_window where window = 'today' and client_key like '%iphone-4%'").get();
    assert.equal(topClient.bytes, 1_500);
    assert.equal(topClient.unknown_bytes, 1_500);
    assert.equal(topClient.via_vps_bytes, 0);
    assert.equal(db.prepare("select count(*) as count from top_destinations_window where window = 'today' and destination = 'Apple/iCloud'").get().count, 0);
    assert.equal(db.prepare("select count(*) as count from client_traffic_5min where unknown_bytes < 0 or bytes != via_vps_bytes + direct_bytes + unknown_bytes").get().count, 0);
  } finally {
    db.close();
  }
});

test("prepared traffic windows keep personal-cloud clients visible in all traffic without polluting client view", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghostroute-console-classes-"));
  fs.writeFileSync(
    path.join(tmp, "device-attribution.json"),
    JSON.stringify({
      clients: {
        mamulia: {
          label: "iphone-4 (Mamulia)",
          device_key: "mamulia-iphone",
          device_label: "iphone-4 (Mamulia)",
          primary_channel: "A/Home Reality",
          aliases: { channel_a: ["iphone-4", "iphone-4 (Mamulia)"] },
        },
        macbook: {
          label: "lan-host-13 (MacBook Denis 23)",
          device_key: "operator-macbook",
          device_label: "MacBook Denis 23",
          aliases: { lan_wifi: ["lan-host-13", "lan-host-13 (MacBook Denis 23)"] },
        },
      },
    })
  );
  const previousDataDir = process.env.GHOSTROUTE_CONSOLE_DATA_DIR;
  process.env.GHOSTROUTE_CONSOLE_DATA_DIR = tmp;
  const db = new Database(path.join(tmp, "ghostroute.db"));
  try {
    ensureConsoleSchema(db);
    const insert = db.prepare(`
      insert into normalized_flows(snapshot_id, snapshot_type, collected_at, client, channel, destination, route, confidence,
        bytes, connections, protocol, client_ip, traffic_class, via_vps_bytes, direct_bytes, unknown_bytes, raw_json)
      values (?, 'traffic_facts', ?, ?, ?, ?, ?, ?, ?, ?, 'TCP', ?, ?, ?, ?, ?, ?)
    `);
    insert.run(30, "2026-05-12T04:00:00.000Z", "iphone-4 (Mamulia)", "A/Home Reality", "Apple/iCloud", "Unknown", "estimated",
      21_000, 8, "192.0.2.40", "personal_cloud", 0, 0, 21_000, JSON.stringify({ fact_id: "pc-iphone", schema_version: 3, unknown_bytes: 21_000 }));
    insert.run(31, "2026-05-12T04:05:00.000Z", "lan-host-13 (MacBook Denis 23)", "Home Wi-Fi/LAN", "www.youtube.com", "Direct", "exact",
      3_000, 3, "192.0.2.13", "client", 0, 3_000, 0, JSON.stringify({ fact_id: "client-macbook", schema_version: 3, direct_bytes: 3_000 }));

    rebuildPreparedWindows(db, "2026-05-12T05:00:00.000Z");

    const payload = (kind, trafficClass) => JSON.parse(db.prepare(
      "select payload_json from traffic_window_snapshots where kind = ? and window = 'today' and traffic_class = ?"
    ).get(kind, trafficClass).payload_json);
    const allClients = payload("clients", "all").rows.map((row) => row.label);
    const clientClients = payload("clients", "client").rows.map((row) => row.label);
    const personalClients = payload("clients", "personal_cloud").rows.map((row) => row.label);
    assert.ok(allClients.includes("iphone-4 (Mamulia)"));
    assert.ok(allClients.includes("lan-host-13 (MacBook Denis 23)"));
    assert.equal(clientClients.includes("iphone-4 (Mamulia)"), false);
    assert.deepEqual(personalClients, ["iphone-4 (Mamulia)"]);

    const allTop = payload("dashboard", "all").dashboardAnalytics.topClients.map((row) => row.label);
    const clientTop = payload("dashboard", "client").dashboardAnalytics.topClients.map((row) => row.label);
    assert.ok(allTop.includes("iphone-4 (Mamulia)"));
    assert.equal(clientTop.includes("iphone-4 (Mamulia)"), false);
    assert.equal(db.prepare("select bytes from top_clients_window where window = 'today' and traffic_class = 'all' and label = 'iphone-4 (Mamulia)'").get().bytes, 21_000);
    assert.equal(db.prepare("select count(*) as count from top_clients_window where window = 'today' and traffic_class = 'client' and label = 'iphone-4 (Mamulia)'").get().count, 0);
  } finally {
    db.close();
    if (previousDataDir === undefined) delete process.env.GHOSTROUTE_CONSOLE_DATA_DIR;
    else process.env.GHOSTROUTE_CONSOLE_DATA_DIR = previousDataDir;
  }
});

test("prepared dashboard all traffic totals prefer authoritative router summary", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghostroute-console-authoritative-"));
  fs.writeFileSync(
    path.join(tmp, "device-attribution.json"),
    JSON.stringify({
      clients: {
        macbook: {
          label: "lan-host-13 (MacBook Denis 23)",
          device_key: "operator-macbook",
          device_label: "MacBook Denis 23",
          primary_channel: "Home Wi-Fi/LAN",
          aliases: { lan_wifi: ["lan-host-13", "lan-host-13 (MacBook Denis 23)"] },
        },
      },
    })
  );
  const previousDataDir = process.env.GHOSTROUTE_CONSOLE_DATA_DIR;
  process.env.GHOSTROUTE_CONSOLE_DATA_DIR = tmp;
  const db = new Database(path.join(tmp, "ghostroute.db"));
  try {
    ensureConsoleSchema(db);
    db.prepare("insert into snapshots(type, collected_at, source, path, payload_json) values (?, ?, ?, ?, ?)").run(
      "traffic_summary",
      "2026-05-13T00:05:00.000Z",
      "test",
      "traffic_summary-early.json",
      JSON.stringify({
        generated_at: "2026-05-13T00:05:00.000Z",
        source: { command: "traffic-summary", period: "today" },
        totals: { client_observed_bytes: 800_000, via_vps_bytes: 600_000, direct_bytes: 200_000, unknown_bytes: 0 },
      })
    );
    db.prepare("insert into snapshots(type, collected_at, source, path, payload_json) values (?, ?, ?, ?, ?)").run(
      "traffic_summary",
      "2026-05-13T01:05:00.000Z",
      "test",
      "traffic_summary.json",
      JSON.stringify({
        generated_at: "2026-05-13T01:05:00.000Z",
        source: { command: "traffic-summary", period: "today" },
        totals: { client_observed_bytes: 2_000_000, via_vps_bytes: 1_500_000, direct_bytes: 500_000, unknown_bytes: 0 },
      })
    );
    db.prepare(`
      insert into normalized_flows(snapshot_id, snapshot_type, collected_at, client, channel, destination, route, confidence,
        bytes, connections, protocol, client_ip, traffic_class, via_vps_bytes, direct_bytes, unknown_bytes, raw_json)
      values (1, 'traffic_facts', '2026-05-13T06:55:00.000Z', 'lan-host-13 (MacBook Denis 23)', 'Home Wi-Fi/LAN',
        'example.invalid', 'Direct', 'exact', 100_000, 1, 'TCP', '192.0.2.13', 'client', 0, 100_000, 0, ?)
    `).run(JSON.stringify({ fact_id: "small-attributed-flow", schema_version: 3 }));

    rebuildPreparedWindows(db, "2026-05-13T07:05:00.000Z");
    const allDashboard = JSON.parse(db.prepare("select payload_json from traffic_window_snapshots where kind = 'dashboard' and window = 'today' and traffic_class = 'all'").get().payload_json);
    const clientDashboard = JSON.parse(db.prepare("select payload_json from traffic_window_snapshots where kind = 'dashboard' and window = 'today' and traffic_class = 'client'").get().payload_json);
    assert.equal(allDashboard.totals.observedBytes, 2_000_000);
    assert.equal(allDashboard.totals.viaVpsBytes, 1_500_000);
    assert.equal(allDashboard.totals.directBytes, 500_000);
    assert.equal(clientDashboard.totals.observedBytes, 100_000);
    assert.equal(allDashboard.dashboardAnalytics.trafficToday.totalBytes, 2_000_000);
    assert.equal(allDashboard.dashboardAnalytics.trafficToday.points.find((row) => row.hour === "00:00").totalBytes, 200_000);
    assert.equal(allDashboard.dashboardAnalytics.trafficToday.points.find((row) => row.hour === "03:00").totalBytes, 200_000);
    assert.equal(allDashboard.dashboardAnalytics.trafficToday.points.find((row) => row.hour === "04:00").totalBytes, 1_200_000);
  } finally {
    db.close();
    if (previousDataDir === undefined) delete process.env.GHOSTROUTE_CONSOLE_DATA_DIR;
    else process.env.GHOSTROUTE_CONSOLE_DATA_DIR = previousDataDir;
  }
});

test("prepared dashboard traffic chart reconciles non-monotonic summary snapshots to latest total", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghostroute-console-summary-chart-"));
  fs.writeFileSync(path.join(tmp, "device-attribution.json"), JSON.stringify({ clients: {} }));
  const previousDataDir = process.env.GHOSTROUTE_CONSOLE_DATA_DIR;
  process.env.GHOSTROUTE_CONSOLE_DATA_DIR = tmp;
  const db = new Database(path.join(tmp, "ghostroute.db"));
  try {
    ensureConsoleSchema(db);
    for (const sample of [
      ["2026-05-13T00:05:00.000Z", 800_000, 600_000, 200_000, 0],
      ["2026-05-13T01:05:00.000Z", 5_000_000, 4_600_000, 400_000, 0],
      ["2026-05-13T02:05:00.000Z", 2_000_000, 1_500_000, 500_000, 0],
    ]) {
      db.prepare("insert into snapshots(type, collected_at, source, path, payload_json) values (?, ?, ?, ?, ?)").run(
        "traffic_summary",
        sample[0],
        "test",
        `traffic_summary-${sample[0]}.json`,
        JSON.stringify({
          generated_at: sample[0],
          source: { command: "traffic-summary", period: "today" },
          totals: {
            client_observed_bytes: sample[1],
            via_vps_bytes: sample[2],
            direct_bytes: sample[3],
            unknown_bytes: sample[4],
          },
        })
      );
    }
    rebuildPreparedWindows(db, "2026-05-13T07:05:00.000Z");
    const allDashboard = JSON.parse(db.prepare("select payload_json from traffic_window_snapshots where kind = 'dashboard' and window = 'today' and traffic_class = 'all'").get().payload_json);
    const points = allDashboard.dashboardAnalytics.trafficToday.points;
    assert.equal(allDashboard.totals.observedBytes, 2_000_000);
    assert.equal(allDashboard.dashboardAnalytics.trafficToday.totalBytes, 2_000_000);
    assert.equal(points.reduce((sum, row) => sum + row.totalBytes, 0), 2_000_000);
    assert.equal(points.reduce((sum, row) => sum + row.viaVpsBytes, 0), 1_500_000);
    assert.equal(points.reduce((sum, row) => sum + row.directBytes, 0), 500_000);
  } finally {
    db.close();
    if (previousDataDir === undefined) delete process.env.GHOSTROUTE_CONSOLE_DATA_DIR;
    else process.env.GHOSTROUTE_CONSOLE_DATA_DIR = previousDataDir;
  }
});

test("client popular sites include residual counter traffic when site attribution is partial", () => {
  const selected = {
    id: "lan-host-13",
    label: "lan-host-13 (MacBook Denis 23)",
    total_bytes: 4_500_000_000,
    via_vps_bytes: 4_300_000_000,
    direct_bytes: 200_000_000,
    flows: 120,
  };
  const siteRows = groupPopularSites([
    {
      destination: "lan-host-13 (MacBook Denis 23)",
      destination_label: "lan-host-13 (MacBook Denis 23)",
      traffic_lane: "client_observed",
      traffic_class: "client",
      route: "Mixed",
      bytes: 4_300_000_000,
      flows: 1,
    },
    {
      destination: "Cloudflare network",
      destination_label: "Cloudflare network",
      provider: "Cloudflare",
      category: "ip_asn.cdn_cloud_hosting",
      traffic_lane: "shared_infra",
      traffic_class: "client",
      route: "Mixed",
      bytes: 90_000_000,
      flows: 15,
    },
    {
      destination: "Google network",
      destination_label: "Google network",
      provider: "Google",
      category: "ip_asn.google_infra",
      traffic_lane: "shared_infra",
      traffic_class: "client",
      route: "Mixed",
      bytes: 10_000_000,
      flows: 4,
    },
  ], "client", 15, { excludeLabels: [selected.id, selected.label] });
  const attributedBytes = siteRows.reduce((sum, row) => sum + siteBytes(row), 0);
  const residualRows = counterFallbackRows(selected, [], "Mixed", "client", attributedBytes);
  const visible = composePopularSiteRows(siteRows, [{ label: "dns-only.example", flows: 20, dnsOnly: true }], []);
  assert.equal(siteBytes(residualRows[0]), 4_400_000_000);
  assert.equal(residualRows[0].label, "Unattributed traffic not mapped to sites");
  assert.equal(visible[0].label, "Cloudflare network");
  assert.equal(siteBytes(visible[0]), 90_000_000);
  assert.equal(visible.some((row) => row.label === "lan-host-13 (MacBook Denis 23)"), false);
  assert.equal(visible.some((row) => row.dnsOnly), false);
  assert.equal(visible.find((row) => row.label === "Cloudflare network").rank, 1);
});

test("client popular sites rank explicit inferred DNS attribution when byte detail undercounts", () => {
  const selected = {
    id: "lan-host-02",
    label: "lan-host-02 (iPhone)",
    total_bytes: 1_070_000_000,
    flows: 150,
  };
  const byteRows = groupPopularSites([
    {
      destination: "Apple network",
      destination_label: "Apple network",
      provider: "Apple",
      category: "ip_asn.apple_infra",
      traffic_lane: "shared_infra",
      traffic_class: "client",
      route: "Mixed",
      bytes: 1_000_000,
      flows: 9,
    },
  ], "client", 15, { excludeLabels: [selected.id, selected.label] });
  const attributedBytes = byteRows.reduce((sum, row) => sum + siteBytes(row), 0);
  const fallbackRows = counterFallbackRows(selected, [], "Mixed", "client", attributedBytes);
  const inferredRows = groupPopularSites([
    {
      domain: "www.youtube.com",
      url_label: "www.youtube.com",
      traffic_lane: "client_observed",
      traffic_class: "client",
      route: "Mixed",
      effective_bytes: 700_000_000,
      inferred_bytes: 700_000_000,
      dns_queries: 80,
      attribution_source: "dns_inferred",
      byte_confidence: "estimated",
    },
    {
      domain: "docs.google.com",
      url_label: "docs.google.com",
      traffic_lane: "client_observed",
      traffic_class: "client",
      route: "Mixed",
      effective_bytes: 369_000_000,
      inferred_bytes: 369_000_000,
      dns_queries: 30,
      attribution_source: "dns_inferred",
      byte_confidence: "estimated",
    },
  ], "client", 15, { excludeLabels: [selected.id, selected.label] });
  const visible = composePopularSiteRows(inferredRows, [], []);
  assert.equal(visible[0].label, "www.youtube.com");
  assert.equal(siteBytes(visible[0]), 700_000_000);
  assert.equal(visible.some((row) => row.label === "Apple network"), false);
  assert.equal(visible.some((row) => row.label === "Unattributed traffic not mapped to sites"), false);
  assert.equal(visible.reduce((sum, row) => sum + siteBytes(row), 0), 1_069_000_000);
  assert.equal(siteBytes(fallbackRows[0]), siteBytes(selected) - attributedBytes);
  assert.deepEqual(
    inferredRows.map((row) => ({ label: row.label, source: row.attribution_source, confidence: row.byte_confidence })),
    [
      { label: "www.youtube.com", source: "dns_inferred", confidence: "estimated" },
      { label: "docs.google.com", source: "dns_inferred", confidence: "estimated" },
    ]
  );
});

test("client popular sites keep residual unmapped when no DNS attribution exists", () => {
  const selected = {
    id: "lan-host-02",
    label: "lan-host-02 (iPhone)",
    total_bytes: 1_070_000_000,
    flows: 150,
  };
  const byteRows = groupPopularSites([
    {
      destination: "Apple network",
      destination_label: "Apple network",
      provider: "Apple",
      category: "ip_asn.apple_infra",
      traffic_lane: "shared_infra",
      traffic_class: "client",
      route: "Mixed",
      bytes: 1_000_000,
      flows: 9,
    },
  ], "client", 15, { excludeLabels: [selected.id, selected.label] });
  const attributedBytes = byteRows.reduce((sum, row) => sum + siteBytes(row), 0);
  const fallbackRows = counterFallbackRows(selected, [], "Mixed", "client", attributedBytes);
  const visible = composePopularSiteRows(byteRows, [], []);
  assert.equal(visible[0].label, "Apple network");
  assert.equal(visible.some((row) => row.label === "Unattributed traffic not mapped to sites"), false);
  assert.equal(visible.reduce((sum, row) => sum + siteBytes(row), 0), attributedBytes);
  assert.equal(siteBytes(fallbackRows[0]), siteBytes(selected) - attributedBytes);
});

test("client popular sites exclude internal GhostRoute ingress and aggregate residual labels", () => {
  const rows = groupPopularSites([
    {
      destination: "Home Reality ingress",
      destination_label: "Home Reality ingress",
      provider: "ghostroute",
      category: "client.home_reality_ingress",
      traffic_lane: "client_observed",
      traffic_class: "client",
      route: "Mixed",
      bytes: 857_700_000,
      flows: 1,
    },
    {
      destination: "Other / uncategorized",
      destination_label: "Other / uncategorized",
      attribution_source: "aggregate_residual",
      traffic_lane: "unknown_review",
      traffic_class: "client",
      route: "Mixed",
      bytes: 857_700_000,
      flows: 0,
    },
    {
      domain: "video.example.invalid",
      url_label: "video.example.invalid",
      traffic_lane: "client_observed",
      traffic_class: "client",
      route: "VPS",
      effective_bytes: 120_000_000,
      flows: 12,
    },
  ], "client", 15);
  assert.deepEqual(rows.map((row) => row.label), ["video.example.invalid"]);
  assert.equal(attributionEligibility({ destination: "Home Reality ingress", provider: "ghostroute", category: "client.home_reality_ingress" }).state, "service_only");
  assert.equal(isAttributableSiteRow({ destination: "Other / uncategorized", attribution_source: "aggregate_residual" }), false);
});

test("app-family catalog classifies managed and observed client apps", () => {
  assert.equal(classifyAppFamily("rr4---sn-n8v7kn7r.googlevideo.com").app_family, "YouTube");
  assert.equal(classifyAppFamily("youtubei.googleapis.com").app_family, "YouTube");
  assert.equal(classifyAppFamily("scontent.cdninstagram.com").app_family, "Instagram / Meta");
  assert.equal(classifyAppFamily("cdn.openai.com").app_family, "OpenAI / ChatGPT");
  assert.equal(classifyAppFamily("api.ozon.ru").app_family, "Shopping / marketplaces");
  assert.equal(classifyAppFamily("static-basket-01.wbbasket.ru").app_family, "Shopping / marketplaces");
  assert.equal(classifyAppFamily("m.vk.com").app_family, "VK / Mail.ru");
  assert.equal(classifyAppFamily("mc.yandex.ru").app_family, "Yandex");
  assert.equal(classifyAppFamily("api.x.com").app_family, "X / Twitter");
  assert.equal(classifyAppFamily("pbs.twimg.com").app_family, "X / Twitter");
  assert.equal(classifyAppFamily("miro.com").app_family, "Productivity / knowledge tools");
  assert.equal(classifyAppFamily("owa.cinimex.ru").app_family, "Corporate mail / OWA");
  assert.equal(classifyAppFamily("rutube.ru").app_family, "Media / streaming");
  assert.equal(classifyAppFamily("gs-loc.apple.com").app_family, "Apple / iCloud");
  assert.equal(classifyAppFamily("gs-loc.ls-apple.com.akadns.net").app_family, "Apple / iCloud");
  assert.equal(classifyAppFamily("gsp85-ssl.ls2-apple.com.akadns.net").app_family, "Apple / iCloud");
  assert.equal(classifyAppFamily("ftrr01.finam.ru").app_family, "Finance / banking");
  assert.equal(classifyAppFamily("main.vscode-cdn.net").app_family, "GitHub / dev");
  assert.equal(classifyAppFamily("otus.ru").app_family, "Education / learning");
  assert.equal(classifyAppFamily("audid-api.taobao.com").app_family, "Shopping / marketplaces");
  assert.equal(classifyAppFamily("mediation.goog").app_family, "Service / system");
  assert.equal(classifyAppFamily("discovery-lookup.syncthing.net").app_family, "Personal cloud / sync");
  assert.equal(classifyAppFamily("www.clarity.ms").app_family, "Service / system");
  assert.equal(isClientFacingAppFamily(classifyAppFamily("cnam4c.skadsdkless.appsflyersdk.com")), false);
  assert.equal(isClientFacingAppFamily(classifyAppFamily("firebaselogging-pa.googleapis.com")), false);
  assert.equal(isClientFacingAppFamily(classifyAppFamily("app-measurement.com")), false);
  assert.deepEqual(
    {
      family: classifyAppFamily({ destination: "203.0.113.10", category: "ip_asn.social_platform.facebook", provider: "Meta Platforms" }).app_family,
      source: classifyAppFamily({ destination: "203.0.113.10", category: "ip_asn.social_platform.facebook", provider: "Meta Platforms" }).app_source,
    },
    { family: "Instagram / Meta", source: "provider_hint" }
  );
  assert.equal(classifyAppFamily({ destination: "203.0.113.11", provider: "Cloudflare", category: "ip_asn.cdn_cloud_hosting" }).app_family, "Provider / CDN");
  assert.equal(classifyAppFamily({ dns_qname: "youtubei.googleapis.com", provider: "Cloudflare", category: "ip_asn.cdn_cloud_hosting" }).app_family, "YouTube");
  assert.equal(classifyAppFamily({ destination: "203.0.113.12" }).app_source, "ip_only");
  const selected = { id: "lan-host-13", label: "lan-host-13 (MacBook Denis 23)", total_bytes: 3_000_000_000 };
  const byteRows = groupPopularSites([
    { destination: "Cloudflare network", provider: "Cloudflare", category: "ip_asn.cdn_cloud_hosting", traffic_lane: "shared_infra", traffic_class: "client", route: "Mixed", bytes: 20_000_000, flows: 4 },
  ], "client", 15, { excludeLabels: [selected.id, selected.label] });
  const visible = composePopularSiteRows(byteRows, [{ label: "youtubei.googleapis.com", flows: 200, dnsOnly: true }], []);
  assert.equal(visible.some((row) => row.label === "youtubei.googleapis.com"), false);
  assert.equal(visible[0].label, "Cloudflare network");
  assert.equal(siteBytes(visible[0]), 20_000_000);
});

test("nDPI diagnostic prototype compares labels without affecting traffic bytes", () => {
  const row = { app_family: "YouTube", bytes: 1234, sample_domains: ["r1---sn.googlevideo.com"] };
  assert.equal(expectedNdpiProtocol(row.app_family), "YouTube");
  assert.deepEqual(ndpiDiagnosticForApp(row), {
    status: "not sampled",
    expected: "YouTube",
    protocol: "",
    detail: "nDPI sample not available",
  });
  assert.equal(ndpiDiagnosticForApp(row, [{ domain: "r1---sn.googlevideo.com", ndpi_protocol: "YouTube" }]).status, "match");
  assert.equal(row.bytes, 1234);
});

test("client popular sites keep unmapped residual separate from ranked sites", () => {
  const selected = {
    id: "lan-host-04",
    label: "lan-host-04 (Sofi)",
    total_bytes: 516_000_000,
    flows: 9,
  };
  const byteRows = groupPopularSites([], "client", 15, { excludeLabels: [selected.id, selected.label] });
  const fallbackRows = counterFallbackRows(selected, [], "Mixed", "client", 0);
  const visible = composePopularSiteRows(byteRows, [], []);
  assert.equal(visible.length, 0);
  assert.equal(fallbackRows[0].label, "Unattributed traffic not mapped to sites");
  assert.equal(siteBytes(fallbackRows[0]), siteBytes(selected));
});

test("prepared traffic aggregates quarantine invalid split rows and full rebuild clears stale windows", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghostroute-console-aggregate-registry-"));
  fs.writeFileSync(path.join(tmp, "device-attribution.json"), JSON.stringify({
    schema_version: 2,
    clients: {
      "lan-host-13": {
        label: "lan-host-13 (MacBook Denis 23)",
        device_key: "lan-host-13",
        device_type: "MacBook",
        aliases: { lan_wifi: ["lan-host-13"] },
      },
    },
  }));
  const previousDataDir = process.env.GHOSTROUTE_CONSOLE_DATA_DIR;
  process.env.GHOSTROUTE_CONSOLE_DATA_DIR = tmp;
  const db = new Database(":memory:");
  try {
    ensureConsoleSchema(db);
    db.prepare(`
      insert into top_clients_window(window, traffic_class, rank, client_key, label, channel, route, bytes,
        via_vps_bytes, direct_bytes, unknown_bytes, flows, computed_at_utc)
      values ('today', 'client', 1, 'stale', 'stale', 'Unknown', 'Mixed', 999, 1000, 0, -1, 1, '2026-05-12T00:00:00.000Z')
    `).run();
    const insert = db.prepare(`
      insert into normalized_flows(snapshot_id, snapshot_type, collected_at, client, channel, destination, route, confidence,
        bytes, connections, protocol, client_ip, traffic_class, via_vps_bytes, direct_bytes, unknown_bytes, raw_json)
      values (?, 'traffic_facts', ?, ?, ?, ?, ?, ?, ?, ?, 'TCP', ?, 'client', ?, ?, ?, ?)
    `);
    insert.run(20, "2026-05-12T04:10:00.000Z", "lan-host-13 (MacBook Denis 23)", "Home Wi-Fi/LAN", "bad.example", "Mixed", "estimated",
      100, 1, "192.0.2.13", 120, 0, -20, JSON.stringify({ fact_id: "bad-split", schema_version: 3, accounting_status: "accounting_error" }));
    insert.run(21, "2026-05-12T04:15:00.000Z", "lan-host-13 (MacBook Denis 23)", "Home Wi-Fi/LAN", "ok.example", "Unknown", "estimated",
      700, 1, "192.0.2.13", 0, 0, 700, JSON.stringify({ fact_id: "ok-split", schema_version: 3, accounting_status: "ok", unknown_bytes: 700 }));

    const result = rebuildAllTrafficReadModels(db, { fromUtc: "2026-05-12T00:00:00.000Z", toUtc: "2026-05-12T05:00:00.000Z", computedAt: "2026-05-12T05:00:00.000Z" });
    assert.equal(result.repaired, true);
    assert.equal(db.prepare("select count(*) as count from top_clients_window where client_key = 'stale'").get().count, 0);
    assert.equal(db.prepare("select count(*) as count from client_destination_traffic_5min where destination_key = 'bad.example'").get().count, 0);
    const macbook = db.prepare("select bytes, via_vps_bytes, direct_bytes, unknown_bytes from top_clients_window where window = 'today' and client_key like '%lan-host-13%'").get();
    assert.deepEqual(macbook, { bytes: 700, via_vps_bytes: 0, direct_bytes: 0, unknown_bytes: 700 });
    for (const table of ["client_traffic_5min", "client_destination_traffic_5min", "top_clients_window"]) {
      assert.equal(db.prepare(`select count(*) as count from ${table} where unknown_bytes < 0 or bytes != via_vps_bytes + direct_bytes + unknown_bytes`).get().count, 0, table);
    }
  } finally {
    db.close();
    if (previousDataDir === undefined) delete process.env.GHOSTROUTE_CONSOLE_DATA_DIR;
    else process.env.GHOSTROUTE_CONSOLE_DATA_DIR = previousDataDir;
    fs.rmSync(tmp, { recursive: true, force: true });
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
  assert.equal(trafficDisplayDestination({ destination: "not observed", dns_qname: "www.youtube.com" }), "www.youtube.com");
  assert.equal(trafficDisplayDestination({ destination: "Home Reality ingress", dns_qname: "www.youtube.com", category: "client.home_reality_ingress" }), "www.youtube.com");
  assert.equal(resolvedTrafficDestination({ destination: "not observed", dns_qname: "www.youtube.com" }), "www.youtube.com");
  assert.equal(resolvedTrafficDestination({ destination: "Home Reality ingress", destination_ip: "198.51.100.5" }, { domain: "setup.icloud.com" }), "setup.icloud.com");
  assert.equal(resolvedDnsQname({ destination: "Home Reality ingress" }, { domain: "setup.icloud.com" }), "setup.icloud.com");
  assert.deepEqual(destinationEvidence({ destination: "Home Reality ingress", dns_qname: "www.youtube.com", dns_status: "linked" }), {
    label: "www.youtube.com",
    kind: "DNS-linked",
    exact: false,
  });
  assert.equal(concreteTrafficDestination({ destination_ip: "203.0.113.10" }), "");
  assert.equal(trafficDisplayDestination({ destination: "203.0.113.10", destination_ip: "203.0.113.10" }), "IP-only destination");
  assert.equal(trafficDisplayDestination({ destination: "198.51.100.63", destination_ip: "198.51.100.63", provider: "FACEBOOK", category: "ip_asn.social_platform.facebook" }), "Facebook network");
  assert.deepEqual(destinationEvidence({ destination: "198.51.100.8", destination_ip: "198.51.100.8", provider: "YANDEX LLC" }), {
    label: "Yandex network",
    kind: "IP/provider",
    exact: false,
    technical: "198.51.100.8",
  });
  assert.equal(trafficDisplayDestination({ destination: "Home Reality ingress", category: "client.home_reality_ingress" }), "Encrypted ingress traffic");
  assert.deepEqual(destinationEvidence({ destination: "Home Reality ingress" }), {
    label: "Encrypted ingress traffic",
    kind: "counter",
    exact: false,
  });
  assert.equal(isPrimaryTrafficDestinationLabel("203.0.113.10"), false);
  assert.equal(isPrimaryTrafficDestinationLabel("Home Reality ingress"), false);
  assert.equal(isPrimaryTrafficDestinationLabel("Client"), false);
});

test("traffic presentation down-ranks known noisy domains without changing factual bytes", () => {
  const direct = { destination: "miro.com", bytes: 25_000, route: "VPS" };
  const subdomain = { dns_qname: "api.miro.com", total_bytes: 50_000, route: "VPS" };
  const normal = { dns_qname: "docs.example.invalid", bytes: 25_000, route: "VPS" };
  assert.equal(noisyDomainRule(direct)?.factor, 25);
  assert.equal(noisyDomainRule(subdomain)?.factor, 25);
  assert.equal(noisyDomainRule(normal), null);
  assert.equal(trafficPresentationBytes(direct), 1_000);
  assert.equal(trafficPresentationBytes(subdomain), 2_000);
  assert.equal(trafficPresentationBytes(normal), 25_000);
  assert.equal(direct.bytes, 25_000);
});

test("dashboard top destinations exclude raw IP and pseudo ingress labels", () => {
  const analytics = buildDashboardAnalyticsFromRows([
    { client: "lan-host-01", destination: "Home Reality ingress", category: "client.home_reality_ingress", bytes: 500, unknown_bytes: 500, collected_at: "2026-05-12T09:00:00Z" },
    { client: "lan-host-02", destination: "203.0.113.10", destination_ip: "203.0.113.10", bytes: 400, direct_bytes: 400, collected_at: "2026-05-12T09:01:00Z" },
    { client: "lan-host-04", destination: "Client", bytes: 350, direct_bytes: 350, collected_at: "2026-05-12T09:01:30Z" },
    { client: "lan-host-03", dns_qname: "video.example.invalid", destination: "Media", bytes: 300, via_vps_bytes: 300, collected_at: "2026-05-12T09:02:00Z" },
  ], { now: "2026-05-12T10:00:00Z" });
  assert.deepEqual(analytics.topDestinations.map((row) => row.label), ["video.example.invalid"]);
});

test("dashboard route byte split clamps explicit counters to factual total", () => {
  const split = routeByteSplit({
    destination: "video.example.invalid",
    bytes: 1000,
    via_vps_bytes: 900,
    direct_bytes: 900,
    unknown_bytes: 0,
  });
  assert.equal(split.totalBytes, 1000);
  assert.equal(split.viaVpsBytes + split.directBytes + split.unknownBytes, 1000);
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

test("client DNS interest defaults to client-facing domains and can include service domains", () => {
  const rows = aggregateDnsInterest([
    { domain: "www.youtube.com", count: 4, confidence: "dns-interest" },
    { domain: "app-measurement.com", count: 3, confidence: "dns-interest" },
    { domain: "miro.com", count: 2, confidence: "dns-interest" },
    { domain: "dns.msftncsi.com", count: 1, confidence: "dns-interest" },
  ], 10);
  assert.equal(dnsInterestTrafficClass(rows.find((row) => row.domain === "app-measurement.com")), "service_background");
  assert.deepEqual(filterDnsInterestRows(rows).map((row) => row.domain), ["www.youtube.com", "miro.com"]);
  assert.deepEqual(filterDnsInterestRows(rows, { includeService: true }).map((row) => row.domain), ["www.youtube.com", "app-measurement.com", "miro.com", "dns.msftncsi.com"]);
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

test("device review state keeps noisy sources out of primary inventory", () => {
  assert.equal(deviceReviewState({ label: "192.0.2.10", total_bytes: 5_000_000, traffic_window_active: true }).review_state, "raw_ip_source");
  assert.equal(deviceReviewState({ label: "lan-host-99", total_bytes: 32_000, traffic_window_active: true }).review_state, "low_signal");
  assert.equal(deviceReviewState({ label: "dns resolver", total_bytes: 5_000_000, traffic_window_active: true, traffic_lane: "service_system" }).review_state, "service_source");
  assert.equal(deviceReviewState({ label: "old private mac", total_bytes: 0, traffic_window_active: false }).review_state, "stale_historical");
  assert.equal(deviceReviewState({ label: "lan-host-01", registry_registered: true }).review_state, "registry_known");
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
  assert.equal(displayDeviceLabel("192.168.50.68", registry), "Unknown LAN device");
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
