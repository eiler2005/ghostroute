import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

const normalizeModule = await import(new URL("../scr" + "ipts/lib/normalize.mjs", import.meta.url));
const { ensureConsoleSchema, normalizeSnapshot, rebuildHourlyAggregates } = normalizeModule;
const classificationModule = await import(new URL("../src/lib/traffic-classification.mjs", import.meta.url));
const { deviceRole, displayDestination, trafficClassFor } = classificationModule;
const attributionModule = await import(new URL("../src/lib/device-attribution.mjs", import.meta.url));
const { applyDeviceAttribution, displayDeviceLabel, loadDeviceAttributions, resolveClient } = attributionModule;
const trafficWindowModule = await import(new URL("../src/lib/traffic-window.mjs", import.meta.url));
const {
  concreteTrafficDestination,
  dedupeAlerts,
  groupAttributionRows,
  groupDestinationRows,
  reconcileTrafficRows,
  snapshotMatchesPeriod,
  trafficDisplayDestination,
} = trafficWindowModule;

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
  assert.equal(db.prepare("select count(*) as count from normalized_catalog").get().count, 2);
  rebuildHourlyAggregates(db);
  assert.equal(db.prepare("select count(*) as count from hourly_traffic").get().count, 1);
  db.close();
});

test("schema includes collector reliability and post-MVP tables", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghostroute-console-schema-"));
  const db = new Database(path.join(tmp, "ghostroute.db"));
  ensureConsoleSchema(db);
  for (const table of ["hourly_traffic", "retention_runs", "collector_runs", "collector_errors", "events", "route_decisions", "live_cursors", "audit_log", "notifications", "notification_settings", "catalog_reviews", "ops_runs"]) {
    assert.ok(db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(table), table);
  }
  assert.ok(db.prepare("select version from schema_migrations where version = 4").get());
  assert.ok(db.prepare("select 1 from pragma_table_info('normalized_flows') where name = 'egress_asn'").get());
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
  assert.equal(resolveClient({ mac: "02:00:00:00:00:02" }, registry).client_key, "");
  assert.equal(resolveClient("mobile-source-15", registry).client_key, "mobile-source-15");
  assert.equal(resolveClient("mobile-source-15", registry).attribution_confidence, "unattributed");
});
