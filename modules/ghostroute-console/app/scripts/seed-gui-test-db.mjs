#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ensureConsoleSchema, rebuildPreparedWindows } from "./lib/normalize.mjs";

const appDir = path.resolve(import.meta.dirname, "..");
const defaultDataDir = path.resolve(appDir, "..", "data", "gui-test");
const dataDir = path.resolve(process.env.GHOSTROUTE_CONSOLE_DATA_DIR || defaultDataDir);
const dbFile = path.join(dataDir, "ghostroute.db");
const snapshotsDir = path.join(dataDir, "snapshots");

process.env.GHOSTROUTE_CONSOLE_DATA_DIR = dataDir;

function iso(now, offsetMs = 0) {
  return new Date(now.getTime() - offsetMs).toISOString();
}

function flowOffsetMs(index) {
  if (index < 144) {
    const hour = index % 24;
    const sample = Math.floor(index / 24);
    return (hour * 60 * 60 + sample * 7 * 60 + (index % 11) * 9) * 1000;
  }
  const day = 1 + (index % 30);
  const hour = (index * 5) % 24;
  const minute = (index * 13) % 60;
  return (day * 24 * 60 * 60 + hour * 60 * 60 + minute * 60) * 1000;
}

function resetDataDir() {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(snapshotsDir, { recursive: true });
}

function createSchema(db) {
  db.exec(`
    create table if not exists snapshots (
      id integer primary key autoincrement,
      type text not null,
      collected_at text not null,
      source text not null,
      path text not null,
      payload_json text not null
    );
    create index if not exists idx_snapshots_type_collected on snapshots(type, collected_at desc);

    create table if not exists events (
      id integer primary key autoincrement,
      snapshot_id integer,
      event_type text not null,
      occurred_at text not null,
      client text not null default '',
      channel text not null default 'Unknown',
      destination text not null default '',
      route text not null default 'Unknown',
      confidence text not null default 'unknown',
      summary text not null default '',
      event_id text not null default '',
      client_ip text not null default '',
      destination_ip text not null default '',
      destination_port text not null default '',
      dns_qname text not null default '',
      dns_answer_ip text not null default '',
      sni text not null default '',
      outbound text not null default '',
      matched_rule text not null default '',
      rule_set text not null default '',
      egress_ip text not null default '',
      egress_asn text not null default '',
      egress_country text not null default '',
      source_log text not null default '',
      evidence_json text not null default '{}'
    );
    create index if not exists idx_events_occurred on events(occurred_at desc);

    create table if not exists route_decisions (
      id integer primary key autoincrement,
      snapshot_id integer,
      occurred_at text not null,
      client text not null default '',
      channel text not null default 'Unknown',
      destination text not null default '',
      route text not null default 'Unknown',
      outbound text not null default '',
      matched_rule text not null default '',
      visible_ip text not null default '',
      event_id text not null default '',
      client_ip text not null default '',
      destination_ip text not null default '',
      destination_port text not null default '',
      dns_qname text not null default '',
      dns_answer_ip text not null default '',
      sni text not null default '',
      rule_set text not null default '',
      egress_asn text not null default '',
      egress_country text not null default '',
      source_log text not null default '',
      confidence text not null default 'unknown',
      evidence_json text not null default '{}'
    );
    create index if not exists idx_route_decisions_occurred on route_decisions(occurred_at desc);

    create table if not exists normalized_devices (
      snapshot_id integer not null,
      snapshot_type text not null,
      collected_at text not null,
      device_id text not null,
      label text not null,
      ip text not null default '',
      route text not null default 'Unknown',
      confidence text not null default 'unknown',
      total_bytes integer not null default 0,
      via_vps_bytes integer not null default 0,
      direct_bytes integer not null default 0,
      raw_json text not null,
      channel text not null default 'Unknown'
    );
    create index if not exists idx_normalized_devices_snapshot on normalized_devices(snapshot_id);

    create table if not exists read_model_state (
      model text primary key,
      source_version text not null default '',
      rebuilt_at text not null,
      row_count integer not null default 0,
      duration_ms integer not null default 0,
      status text not null default 'ok',
      detail text not null default ''
    );
    create table if not exists flow_sessions (
      id text primary key,
      snapshot_id integer,
      collected_at text not null,
      first_seen text not null default '',
      last_seen text not null default '',
      client text not null default '',
      client_ip text not null default '',
      device_key text not null default '',
      channel text not null default 'Unknown',
      destination text not null default '',
      destination_ip text not null default '',
      destination_port text not null default '',
      protocol text not null default '',
      route text not null default 'Unknown',
      policy text not null default '',
      matched_rule text not null default '',
      outbound text not null default '',
      dns_qname text not null default '',
      dns_answer_ip text not null default '',
      sni text not null default '',
      egress_ip text not null default '',
      egress_asn text not null default '',
      egress_country text not null default '',
      ts_confidence text not null default '',
      bytes integer not null default 0,
      connections integer not null default 0,
      duration_seconds integer not null default 0,
      duration_confidence text not null default 'unknown',
      risk text not null default 'low',
      risk_reason text not null default '',
      confidence text not null default 'unknown',
      source_kind text not null default 'traffic',
      evidence_json text not null default '{}'
    );
    create index if not exists idx_flow_sessions_time on flow_sessions(last_seen desc, first_seen desc);
    create index if not exists idx_flow_sessions_filters on flow_sessions(route, channel, confidence, risk, client, destination);
    create table if not exists dns_query_log (
      id text primary key,
      snapshot_id integer,
      collected_at text not null,
      event_ts text not null default '',
      client text not null default '',
      client_ip text not null default '',
      device_key text not null default '',
      domain text not null default '',
      qtype text not null default '',
      answer_ip text not null default '',
      route text not null default 'Unknown',
      catalog_status text not null default 'unknown',
      status text not null default 'OK',
      count integer not null default 0,
      risk text not null default 'low',
      confidence text not null default 'dns-interest',
      evidence_json text not null default '{}'
    );
    create index if not exists idx_dns_query_log_time on dns_query_log(event_ts desc, collected_at desc);
    create index if not exists idx_dns_query_log_filters on dns_query_log(route, catalog_status, status, client, domain);
    create table if not exists device_inventory (
      device_key text primary key,
      label text not null default '',
      ip text not null default '',
      hostname text not null default '',
      mac text not null default '',
      aliases_json text not null default '[]',
      profile text not null default '',
      trust_state text not null default 'unknown',
      device_type text not null default 'unknown',
      channel text not null default 'Unknown',
      route text not null default 'Unknown',
      confidence text not null default 'unknown',
      last_seen text not null default '',
      total_bytes integer not null default 0,
      via_vps_bytes integer not null default 0,
      direct_bytes integer not null default 0,
      unknown_bytes integer not null default 0,
      top_domains_json text not null default '[]',
      health_status text not null default 'unknown',
      risk text not null default 'low',
      evidence_json text not null default '{}'
    );
    create index if not exists idx_device_inventory_activity on device_inventory(last_seen desc, total_bytes desc, route);
    create table if not exists alarm_events (
      id text primary key,
      snapshot_id integer,
      collected_at text not null,
      severity text not null default 'warning',
      source text not null default '',
      title text not null default '',
      status text not null default 'open',
      evidence text not null default '',
      suggested_action text not null default '',
      snoozed_until text not null default '',
      confidence text not null default 'unknown',
      risk text not null default 'medium',
      evidence_json text not null default '{}'
    );
    create table if not exists console_page_summaries (
      page text primary key,
      source_version text not null default '',
      rebuilt_at text not null,
      payload_json text not null
    );
  `);
}

function insertSnapshot(db, now, type, offsetMs, payload) {
  const collectedAt = iso(now, offsetMs);
  const file = path.join(snapshotsDir, `test-seed-${type}.json`);
  const body = {
    schema_version: 1,
    generated_at: collectedAt,
    source: { command: "test-seed", period: "today", confidence: "synthetic" },
    confidence: "synthetic",
    ...payload,
  };
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  return Number(
    db
      .prepare("insert into snapshots(type, collected_at, source, path, payload_json) values (?, ?, ?, ?, ?)")
      .run(type, collectedAt, "test-seed", file, JSON.stringify(body)).lastInsertRowid
  );
}

function seed(db) {
  const now = new Date();
  const clients = [
    { key: "test-home-laptop", label: "Test/Home Laptop", ip: "10.10.0.11", channel: "Home Wi-Fi/LAN", type: "MacBook" },
    { key: "test-office-tablet", label: "Test/Office Tablet", ip: "10.10.0.21", channel: "B/Office Direct", type: "iPad" },
    { key: "test-mobile-lte", label: "Test/Mobile LTE", ip: "10.10.0.31", channel: "C/Mobile LTE", type: "iPhone" },
    { key: "test-home-console", label: "Test/Home Console", ip: "10.10.0.41", channel: "A/Home Reality", type: "Windows PC" },
    { key: "test-iphone-heavy", label: "Test/iPhone Heavy", ip: "10.10.0.51", channel: "Home Wi-Fi/LAN", type: "iPhone" },
    { key: "test-macbook-heavy", label: "Test/MacBook Heavy", ip: "10.10.0.61", channel: "Home Wi-Fi/LAN", type: "MacBook" },
  ];
  fs.writeFileSync(
    path.join(dataDir, "device-attribution.json"),
    `${JSON.stringify({
      schema_version: 2,
      clients: Object.fromEntries(clients.map((client) => [client.key, {
        label: client.label,
        device_key: client.key,
        device_label: client.label,
        device_type: client.type,
        primary_channel: client.channel,
        aliases: [client.label, client.key],
        ip_aliases: [client.ip],
      }])),
    }, null, 2)}\n`
  );
  const destinations = [
    ["Apple/iCloud", "icloud.test.invalid", "203.0.113.10"],
    ["Google/YouTube", "youtube.test.invalid", "203.0.113.20"],
    ["Telegram", "telegram.test.invalid", "203.0.113.30"],
    ["Meta/Instagram", "instagram.test.invalid", "203.0.113.40"],
    ["Retail/RU", "retail.test.invalid", "203.0.113.50"],
    ["Home Reality ingress", "", "198.51.100.30"],
    ["Unclassified domain", "unknown-destination.test.invalid", "198.51.100.20"],
  ];
  const routes = ["VPS", "Direct", "Mixed", "VPS", "Direct"];
  const dnsDomains = [
    "updates.test.invalid",
    "cdn.test.invalid",
    "mail.test.invalid",
    "video.test.invalid",
    "api.test.invalid",
    "telemetry.test.invalid",
    "assets.test.invalid",
    "auth.test.invalid",
  ];
  const ipEnrichmentStmt = db.prepare(`insert into ip_enrichment_cache(
    ip,prefix_cidr,asn,asn_org,provider,category_hint,traffic_lane_hint,dns_category_hint,decision_hint,
    country,registry,source,confidence,lookup_status,raw_json,first_seen_utc,last_seen_utc,updated_at_utc,expires_at_utc
  ) values (@ip,@prefix_cidr,@asn,@asn_org,@provider,@category_hint,@traffic_lane_hint,@dns_category_hint,@decision_hint,@country,@registry,@source,@confidence,@lookup_status,@raw_json,@first_seen_utc,@last_seen_utc,@updated_at_utc,@expires_at_utc)`);
  for (const row of [
    ["203.0.113.70", "Apple Services", "ip_asn.apple_infra", "shared_infra", "apple_infra"],
    ["203.0.113.71", "Cloudflare", "ip_asn.cdn_cloud_hosting.cloudflare", "shared_infra", "cdn_shared"],
    ["203.0.113.72", "Meta Platforms", "ip_asn.social_platform.facebook", "client_observed", "social_platform"],
    ["203.0.113.73", "Example Hosting", "unknown.ip_only", "unknown_review", "unknown_ip_only"],
  ]) {
    ipEnrichmentStmt.run({
      ip: row[0],
      prefix_cidr: `${row[0]}/32`,
      asn: "AS64500",
      asn_org: row[1],
      provider: row[1],
      category_hint: row[2],
      traffic_lane_hint: row[3],
      dns_category_hint: row[4],
      decision_hint: "monitor",
      country: "ZZ",
      registry: "test",
      source: "test-seed",
      confidence: "synthetic",
      lookup_status: "hit",
      raw_json: JSON.stringify({ synthetic: true }),
      first_seen_utc: iso(now, 120000),
      last_seen_utc: iso(now, 1000),
      updated_at_utc: iso(now),
      expires_at_utc: "",
    });
  }
  const trafficSnapshotId = insertSnapshot(db, now, "traffic_facts", 0, {
    schema_version: 3,
    source: { command: "traffic-facts", period: "today" },
    coverage: {
      observed_bytes: 734003200,
      attributed_bytes: 608174080,
      unattributed_bytes: 125829120,
    },
    clients: [],
    traffic_facts: [],
    dns_links: [],
    attribution_gaps: [],
  });
  const summarySnapshotId = insertSnapshot(db, now, "traffic_summary", 500, {
    totals: {
      client_observed_bytes: 734003200,
      via_vps_bytes: 356515840,
      direct_bytes: 251658240,
      unknown_bytes: 125829120,
    },
  });
  const dnsSnapshotId = insertSnapshot(db, now, "dns", 700, { queries: [] });
  const liveSnapshotId = insertSnapshot(db, now, "live", 900, { events: [] });

  const flowStmt = db.prepare(`insert into flow_sessions(
    id, snapshot_id, collected_at, first_seen, last_seen, client, client_ip, device_key, channel,
    destination, destination_ip, destination_port, protocol, route, policy, matched_rule, outbound,
    dns_qname, dns_answer_ip, sni, egress_ip, egress_asn, egress_country, ts_confidence,
    bytes, connections, duration_seconds, duration_confidence, risk, risk_reason, confidence,
    source_kind, evidence_json
  ) values (@id,@snapshot_id,@collected_at,@first_seen,@last_seen,@client,@client_ip,@device_key,@channel,@destination,@destination_ip,@destination_port,@protocol,@route,@policy,@matched_rule,@outbound,@dns_qname,@dns_answer_ip,@sni,@egress_ip,@egress_asn,@egress_country,@ts_confidence,@bytes,@connections,@duration_seconds,@duration_confidence,@risk,@risk_reason,@confidence,@source_kind,@evidence_json)`);
  const normalizedFlowStmt = db.prepare(`insert into normalized_flows(
    snapshot_id, snapshot_type, collected_at, client, channel, destination, route, confidence,
    bytes, connections, protocol, client_ip, destination_ip, destination_port, dns_qname,
    dns_answer_ip, sni, outbound, matched_rule, rule_set, source_log, traffic_class,
    via_vps_bytes, direct_bytes, unknown_bytes, route_verification, route_status, raw_json
  ) values (@snapshot_id,@snapshot_type,@collected_at,@client,@channel,@destination,@route,@confidence,@bytes,@connections,@protocol,@client_ip,@destination_ip,@destination_port,@dns_qname,@dns_answer_ip,@sni,@outbound,@matched_rule,@rule_set,@source_log,@traffic_class,@via_vps_bytes,@direct_bytes,@unknown_bytes,@route_verification,@route_status,@raw_json)`);
  for (let i = 0; i < 320; i++) {
    const client = clients[i % clients.length];
    const [destLabel, domain, ip] = destinations[i % destinations.length];
    const route = routes[i % routes.length];
    const offsetMs = flowOffsetMs(i);
    const durationSeconds = 30 + (i % 900);
    const bytes = 90000000 - i * 177000;
    const viaVpsBytes = route === "VPS" ? bytes : route === "Mixed" ? Math.floor(bytes * 0.55) : 0;
    const directBytes = route === "Direct" ? bytes : route === "Mixed" ? Math.floor(bytes * 0.35) : 0;
    const unknownBytes = bytes - viaVpsBytes - directBytes;
    const flow = {
      id: `test-seed:flow:${String(i + 1).padStart(4, "0")}`,
      snapshot_id: trafficSnapshotId,
      collected_at: iso(now, offsetMs),
      first_seen: iso(now, offsetMs + durationSeconds * 1000),
      last_seen: iso(now, offsetMs),
      client: client.label,
      client_ip: client.ip,
      device_key: client.key,
      channel: client.channel,
      destination: destLabel,
      destination_ip: ip,
      destination_port: i % 3 === 0 ? "443" : i % 3 === 1 ? "853" : "",
      protocol: i % 4 === 0 ? "UDP" : "TCP",
      route,
      policy: route === "VPS" ? "STEALTH_DOMAINS" : route === "Direct" ? "DEFAULT_DIRECT" : "MIXED_ROUTE",
      matched_rule: route === "VPS" ? domain : route === "Direct" ? "direct-policy" : "mixed-policy",
      outbound: route === "VPS" ? "reality-out" : route === "Direct" ? "direct" : "mixed",
      dns_qname: domain,
      dns_answer_ip: ip,
      sni: domain,
      egress_ip: route === "VPS" ? "198.51.100.200" : "",
      egress_asn: route === "VPS" ? "AS64500" : "",
      egress_country: route === "VPS" ? "Testland" : "",
      ts_confidence: i % 5 === 0 ? "snapshot" : "exact",
      bytes,
      connections: 2 + (i % 9),
      duration_seconds: durationSeconds,
      duration_confidence: i % 5 === 0 ? "estimated" : "exact",
      risk: i % 19 === 0 ? "medium" : "low",
      risk_reason: i % 19 === 0 ? "synthetic review sample" : "",
      confidence: i % 7 === 0 ? "dns-interest" : "estimated",
      source_kind: "local-test-seed",
      evidence_json: JSON.stringify({ synthetic: true, domain }),
    };
    flowStmt.run(flow);
    normalizedFlowStmt.run({
      ...flow,
      snapshot_type: "traffic_facts",
      rule_set: flow.policy,
      source_log: "local-test-seed",
      traffic_class: "client",
      via_vps_bytes: viaVpsBytes,
      direct_bytes: directBytes,
      unknown_bytes: unknownBytes,
      route_verification: route === "Mixed" ? "counter_allocated" : route === "VPS" ? "verified_vps" : route === "Direct" ? "verified_direct" : "unknown",
      route_status: route === "Mixed" ? "counter_allocated" : route === "VPS" || route === "Direct" ? "verified" : "unknown",
      raw_json: JSON.stringify({
        fact_id: `test-seed:fact:${String(i + 1).padStart(4, "0")}`,
        schema_version: 3,
        synthetic: true,
        domain,
        via_vps_bytes: viaVpsBytes,
        direct_bytes: directBytes,
        unknown_bytes: unknownBytes,
        accounting_status: "ok",
      }),
    });
  }
  const heavyFlows = [
    ["test-iphone-heavy", "203.0.113.70", "VPS", 1_200_000_000, 1_100_000_000, 60_000_000],
    ["test-iphone-heavy", "203.0.113.71", "Mixed", 760_000_000, 360_000_000, 280_000_000],
    ["test-iphone-heavy", "203.0.113.73", "Direct", 280_000_000, 0, 220_000_000],
    ["test-macbook-heavy", "203.0.113.72", "VPS", 950_000_000, 900_000_000, 0],
    ["test-macbook-heavy", "203.0.113.71", "Mixed", 640_000_000, 310_000_000, 250_000_000],
  ];
  for (const [clientKey, destinationIp, route, bytes, viaVpsBytes, directBytes] of heavyFlows) {
    const client = clients.find((entry) => entry.key === clientKey);
    const idx = heavyFlows.findIndex((entry) => entry[0] === clientKey && entry[1] === destinationIp);
    const unknownBytes = bytes - viaVpsBytes - directBytes;
    const flow = {
      id: `test-seed:defect-flow:${String(idx + 1).padStart(2, "0")}`,
      snapshot_id: trafficSnapshotId,
      collected_at: iso(now, 45000 + idx * 3000),
      first_seen: iso(now, 47000 + idx * 3000),
      last_seen: iso(now, 45000 + idx * 3000),
      client: client.label,
      client_ip: client.ip,
      device_key: client.key,
      channel: client.channel,
      destination: destinationIp,
      destination_ip: destinationIp,
      destination_port: "443",
      protocol: "TCP",
      route,
      policy: route === "VPS" ? "STEALTH_DOMAINS" : route === "Direct" ? "DEFAULT_DIRECT" : "MIXED_ROUTE",
      matched_rule: "",
      outbound: route === "VPS" ? "reality-out" : route === "Direct" ? "direct" : "mixed",
      dns_qname: "",
      dns_answer_ip: "",
      sni: "",
      egress_ip: route === "VPS" ? "198.51.100.200" : "",
      egress_asn: route === "VPS" ? "AS64500" : "",
      egress_country: route === "VPS" ? "Testland" : "",
      ts_confidence: "estimated",
      bytes,
      connections: 24 + idx,
      duration_seconds: 360,
      duration_confidence: "estimated",
      risk: "low",
      risk_reason: "",
      confidence: "estimated",
      source_kind: "local-test-seed",
      evidence_json: JSON.stringify({ synthetic: true, ip_provider_case: true }),
    };
    flowStmt.run(flow);
    normalizedFlowStmt.run({
      ...flow,
      snapshot_type: "traffic_facts",
      rule_set: flow.policy,
      source_log: "local-test-seed",
      traffic_class: "client",
      via_vps_bytes: viaVpsBytes,
      direct_bytes: directBytes,
      unknown_bytes: unknownBytes,
      route_verification: route === "Mixed" ? "counter_allocated" : route === "VPS" ? "verified_vps" : "verified_direct",
      route_status: route === "Mixed" ? "counter_allocated" : "verified",
      raw_json: JSON.stringify({ synthetic: true, ip_provider_case: true }),
    });
  }

  const dnsStmt = db.prepare(`insert into dns_query_log(
    id, snapshot_id, collected_at, event_ts, client, client_ip, device_key, domain, qtype,
    answer_ip, route, catalog_status, status, count, risk, confidence, evidence_json
  ) values (@id,@snapshot_id,@collected_at,@event_ts,@client,@client_ip,@device_key,@domain,@qtype,@answer_ip,@route,@catalog_status,@status,@count,@risk,@confidence,@evidence_json)`);
  for (let i = 0; i < 260; i++) {
    const client = clients[i % clients.length];
    const route = i % 6 === 0 ? "Direct" : i % 5 === 0 ? "Unknown" : "VPS";
    const catalogStatus = route === "VPS" ? "managed" : route === "Direct" ? "candidate" : "unknown";
    dnsStmt.run({
      id: `test-seed:dns:${String(i + 1).padStart(4, "0")}`,
      snapshot_id: dnsSnapshotId,
      collected_at: iso(now, 700),
      event_ts: iso(now, i * 1003 + (i % 23)),
      client: client.label,
      client_ip: client.ip,
      device_key: client.key,
      domain: dnsDomains[i % dnsDomains.length],
      qtype: i % 8 === 0 ? "HTTPS" : "A",
      answer_ip: i % 11 === 0 ? "NODATA" : `198.51.100.${10 + (i % 80)}`,
      route,
      catalog_status: catalogStatus,
      status: catalogStatus === "candidate" ? "Review" : "OK",
      count: 1 + (i % 3),
      risk: catalogStatus === "candidate" ? "medium" : "low",
      confidence: i % 4 === 0 ? "dns-interest" : "exact",
      evidence_json: JSON.stringify({ synthetic: true }),
    });
  }
  const heavyDnsRows = [
    ["test-iphone-heavy", "gs-loc.apple.com", 5],
    ["test-iphone-heavy", "gs-loc.ls-apple.com.akadns.net", 4],
    ["test-iphone-heavy", "youtubei.googleapis.com", 3],
    ["test-macbook-heavy", "graph.instagram.com", 6],
    ["test-macbook-heavy", "chatgpt.com", 5],
    ["test-macbook-heavy", "cloudflare.com", 2],
  ];
  for (const [clientKey, domain, count] of heavyDnsRows) {
    const client = clients.find((entry) => entry.key === clientKey);
    const idx = heavyDnsRows.findIndex((entry) => entry[0] === clientKey && entry[1] === domain);
    dnsStmt.run({
      id: `test-seed:defect-dns:${String(idx + 1).padStart(2, "0")}`,
      snapshot_id: dnsSnapshotId,
      collected_at: iso(now, 500),
      event_ts: iso(now, 2000 + idx * 100),
      client: client.label,
      client_ip: client.ip,
      device_key: client.key,
      domain,
      qtype: "A",
      answer_ip: `203.0.113.${70 + (idx % 4)}`,
      route: "VPS",
      catalog_status: "managed",
      status: "OK",
      count,
      risk: "low",
      confidence: "exact",
      evidence_json: JSON.stringify({ synthetic: true, ip_provider_case: true }),
    });
  }

  const deviceStmt = db.prepare(`insert into device_inventory(
    device_key,label,ip,hostname,mac,aliases_json,profile,trust_state,device_type,channel,route,confidence,last_seen,total_bytes,via_vps_bytes,direct_bytes,unknown_bytes,top_domains_json,health_status,risk,evidence_json
  ) values (@device_key,@label,@ip,@hostname,@mac,@aliases_json,@profile,@trust_state,@device_type,@channel,@route,@confidence,@last_seen,@total_bytes,@via_vps_bytes,@direct_bytes,@unknown_bytes,@top_domains_json,@health_status,@risk,@evidence_json)`);
  const normalizedDeviceStmt = db.prepare(`insert into normalized_devices(
    snapshot_id,snapshot_type,collected_at,device_id,label,ip,route,confidence,total_bytes,via_vps_bytes,direct_bytes,raw_json,channel
  ) values (@snapshot_id,@snapshot_type,@collected_at,@device_id,@label,@ip,@route,@confidence,@total_bytes,@via_vps_bytes,@direct_bytes,@raw_json,@channel)`);
  for (let i = 0; i < 12; i++) {
    const client = clients[i % clients.length];
    const device = {
      device_key: `${client.key}-${i}`,
      label: `${client.label} ${i + 1}`,
      ip: `10.10.${i}.10`,
      hostname: `test-device-${i + 1}`,
      mac: "",
      aliases_json: JSON.stringify([client.label, client.ip]),
      profile: client.channel,
      trust_state: i % 5 === 0 ? "unknown" : "trusted",
      device_type: client.type,
      channel: client.channel,
      route: routes[i % routes.length],
      confidence: "synthetic",
      last_seen: iso(now, i * 60000),
      total_bytes: 500000000 - i * 25000000,
      via_vps_bytes: 220000000 - i * 8000000,
      direct_bytes: 180000000 - i * 7000000,
      unknown_bytes: 100000000 - i * 5000000,
      top_domains_json: JSON.stringify(dnsDomains.slice(0, 4)),
      health_status: "online",
      risk: i % 5 === 0 ? "medium" : "low",
      evidence_json: JSON.stringify({ synthetic: true }),
    };
    deviceStmt.run(device);
    normalizedDeviceStmt.run({
      snapshot_id: trafficSnapshotId,
      snapshot_type: "traffic",
      collected_at: device.last_seen,
      device_id: device.device_key,
      label: device.label,
      ip: device.ip,
      route: device.route,
      confidence: device.confidence,
      total_bytes: device.total_bytes,
      via_vps_bytes: device.via_vps_bytes,
      direct_bytes: device.direct_bytes,
      raw_json: JSON.stringify({ synthetic: true, profile: device.profile, device_type: device.device_type }),
      channel: device.channel,
    });
  }

  const eventStmt = db.prepare(`insert into events(
    snapshot_id,event_type,occurred_at,client,channel,destination,route,confidence,summary,event_id,
    client_ip,destination_ip,destination_port,dns_qname,dns_answer_ip,sni,outbound,matched_rule,rule_set,source_log,evidence_json
  ) values (@snapshot_id,@event_type,@occurred_at,@client,@channel,@destination,@route,@confidence,@summary,@event_id,@client_ip,@destination_ip,@destination_port,@dns_qname,@dns_answer_ip,@sni,@outbound,@matched_rule,@rule_set,@source_log,@evidence_json)`);
  const decisionStmt = db.prepare(`insert into route_decisions(
    snapshot_id,occurred_at,client,channel,destination,route,outbound,matched_rule,visible_ip,event_id,
    client_ip,destination_ip,destination_port,dns_qname,dns_answer_ip,sni,rule_set,source_log,confidence,evidence_json
  ) values (@snapshot_id,@occurred_at,@client,@channel,@destination,@route,@outbound,@matched_rule,@visible_ip,@event_id,@client_ip,@destination_ip,@destination_port,@dns_qname,@dns_answer_ip,@sni,@rule_set,@source_log,@confidence,@evidence_json)`);
  for (let i = 0; i < 360; i++) {
    const client = clients[i % clients.length];
    const [destLabel, domain, ip] = destinations[i % destinations.length];
    const route = routes[i % routes.length];
    const occurredAt = iso(now, i * 777 + (i % 9));
    const eventType = i % 3 === 0 ? "dns.query" : i % 3 === 1 ? "dns.answer" : "route.decision";
    eventStmt.run({
      snapshot_id: liveSnapshotId,
      event_type: eventType,
      occurred_at: occurredAt,
      client: client.label,
      channel: client.channel,
      destination: eventType === "route.decision" ? destLabel : domain,
      route,
      confidence: i % 5 === 0 ? "dns-interest" : "estimated",
      summary: `${client.label} -> ${domain}`,
      event_id: `test-seed:event:${i + 1}`,
      client_ip: client.ip,
      destination_ip: ip,
      destination_port: "443",
      dns_qname: domain,
      dns_answer_ip: ip,
      sni: domain,
      outbound: route === "VPS" ? "reality-out" : route === "Direct" ? "direct" : "mixed",
      matched_rule: route === "VPS" ? domain : "",
      rule_set: route === "VPS" ? "STEALTH_DOMAINS" : "DEFAULT",
      source_log: "local-test-seed",
      evidence_json: JSON.stringify({ synthetic: true }),
    });
    if (i % 2 === 0) {
      decisionStmt.run({
        snapshot_id: liveSnapshotId,
        occurred_at: iso(now, i * 777 + (i % 9) + 1),
        client: client.label,
        channel: client.channel,
        destination: destLabel,
        route,
        outbound: route === "VPS" ? "reality-out" : route === "Direct" ? "direct" : "mixed",
        matched_rule: route === "VPS" ? domain : "",
        visible_ip: route === "VPS" ? "198.51.100.200" : client.ip,
        event_id: `test-seed:decision:${i + 1}`,
        client_ip: client.ip,
        destination_ip: ip,
        destination_port: "443",
        dns_qname: domain,
        dns_answer_ip: ip,
        sni: domain,
        rule_set: route === "VPS" ? "STEALTH_DOMAINS" : "DEFAULT",
        source_log: "local-test-seed",
        confidence: i % 5 === 0 ? "dns-interest" : "estimated",
        evidence_json: JSON.stringify({ synthetic: true }),
      });
    }
  }

  const alarmStmt = db.prepare(`insert into alarm_events(id,snapshot_id,collected_at,severity,source,title,status,evidence,suggested_action,snoozed_until,confidence,risk,evidence_json)
    values (@id,@snapshot_id,@collected_at,@severity,@source,@title,@status,@evidence,@suggested_action,@snoozed_until,@confidence,@risk,@evidence_json)`);
  for (let i = 0; i < 4; i++) {
    alarmStmt.run({
      id: `test-seed:alarm:${i + 1}`,
      snapshot_id: summarySnapshotId,
      collected_at: iso(now, i * 30000),
      severity: i === 0 ? "warning" : "info",
      source: "test-seed",
      title: i === 0 ? "Synthetic DNS review signal" : `Synthetic ops signal ${i + 1}`,
      status: "open",
      evidence: "Local synthetic data for UI verification only.",
      suggested_action: "Verify dense table paging and filters.",
      snoozed_until: "",
      confidence: "synthetic",
      risk: i === 0 ? "medium" : "low",
      evidence_json: JSON.stringify({ synthetic: true }),
    });
  }

  const healthSummary = {
    rebuiltAt: iso(now),
    snapshotTimes: {
      traffic_summary: iso(now, 500),
      health: iso(now, 1100),
      leaks: iso(now, 1200),
      deploy_gate: iso(now, 1300),
    },
    statusCards: [
      { label: "Router", status: "OK", detail: "RT-AX88U_PRO" },
      { label: "Reality", status: "OK", detail: "home ingress / reality-out" },
      { label: "DNS", status: "OK", detail: "dnscrypt + policy" },
      { label: "IPv6", status: "OK", detail: "not in routing scope" },
      { label: "Rule-set", status: "UNKNOWN", detail: "catalog mirror" },
      { label: "Leaks", status: "WARN", detail: "1 signals" },
    ],
    alarmCounts: { total: 4, active: 4, critical: 0, warning: 1, info: 3 },
    alarms: Array.from({ length: 4 }, (_, i) => ({
      id: `test-seed:alarm:${i + 1}`,
      collected_at: iso(now, i * 30000),
      severity: i === 0 ? "warning" : "info",
      source: "test-seed",
      title: i === 0 ? "Synthetic DNS review signal" : `Synthetic ops signal ${i + 1}`,
      status: "open",
      evidence: "Local synthetic data for UI verification only.",
      suggested_action: "Verify dense table paging and filters.",
      confidence: "synthetic",
      risk: i === 0 ? "medium" : "low",
      evidence_json: { synthetic: true },
    })),
    deployGate: {
      status: "OK",
      mode: "readonly",
      estimated_duration: "synthetic",
      generated_at: iso(now, 1300),
      checks: [
        { id: "router_split", label: "router_split", component: "router", status: "OK", summary: "Synthetic split route canary passed.", message: "Synthetic split route canary passed.", evidence: "seeded", suggested_action: "", confidence: "synthetic" },
        { id: "vps_edge", label: "vps_edge", component: "vps", status: "OK", summary: "Synthetic VPS edge canary passed.", message: "Synthetic VPS edge canary passed.", evidence: "seeded", suggested_action: "", confidence: "synthetic" },
      ],
    },
    health: {
      overall: "OK",
      checks: [
        { id: "router", label: "Router", probe: "router", status: "OK", summary: "Synthetic router probe.", message: "Synthetic router probe.", evidence: "seeded", suggested_action: "", confidence: "synthetic" },
        { id: "dns", label: "DNS", probe: "dns", status: "OK", summary: "Synthetic DNS probe.", message: "Synthetic DNS probe.", evidence: "seeded", suggested_action: "", confidence: "synthetic" },
      ],
    },
    leaks: {
      overall: "WARN",
      confidence: "synthetic",
      leakSignals: 1,
      evidenceRows: 2,
      checks: [{ id: "dns_leak", label: "DNS leak", probe: "dns_leak", status: "WARN", summary: "Synthetic leak probe.", message: "Synthetic leak probe.", evidence: "seeded", suggested_action: "", confidence: "synthetic" }],
      evidence: [
        { id: "resolver", label: "Resolver", probe: "resolver", status: "UNKNOWN", summary: "Synthetic resolver evidence.", message: "Synthetic resolver evidence.", evidence: "seeded", suggested_action: "", confidence: "synthetic" },
        { id: "visible_ip", label: "Visible IP", probe: "visible_ip", status: "UNKNOWN", summary: "Synthetic visible IP evidence.", message: "Synthetic visible IP evidence.", evidence: "seeded", suggested_action: "", confidence: "synthetic" },
      ],
    },
    totals: {
      observedBytes: 734003200,
      viaVpsBytes: 356515840,
      directBytes: 251658240,
      unknownBytes: 125829120,
    },
  };
  const summaryStmt = db.prepare("insert into console_page_summaries(page, source_version, rebuilt_at, payload_json) values (?, ?, ?, ?)");
  summaryStmt.run("health_mobile", "test-seed", iso(now), JSON.stringify(healthSummary));
  summaryStmt.run("health_shell", "test-seed", iso(now), JSON.stringify(healthSummary));
  summaryStmt.run("live_mobile", "test-seed", iso(now), JSON.stringify({
    rebuiltAt: iso(now),
    snapshotTimes: healthSummary.snapshotTimes,
    statusCards: healthSummary.statusCards,
    alarmCounts: healthSummary.alarmCounts,
    totals: healthSummary.totals,
  }));

  const stateStmt = db.prepare(
    "insert into read_model_state(model, source_version, rebuilt_at, row_count, duration_ms, status, detail) values (?, ?, ?, ?, ?, ?, ?)"
  );
  stateStmt.run("flow_sessions", "test-seed", iso(now), 325, 1, "ok", "local synthetic rows");
  stateStmt.run("dns_query_log", "test-seed", iso(now), 266, 1, "ok", "local synthetic rows");
  stateStmt.run("device_inventory", "test-seed", iso(now), 12, 1, "ok", "local synthetic rows");
  stateStmt.run("alarm_events", "test-seed", iso(now), 4, 1, "ok", "local synthetic rows");
  stateStmt.run("console_page_summaries", "test-seed", iso(now), 3, 1, "ok", "local synthetic rows");
}

resetDataDir();
const db = new Database(dbFile);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 10000");
createSchema(db);
ensureConsoleSchema(db);
db.transaction(() => seed(db))();
rebuildPreparedWindows(db);
db.close();

console.log(`seeded GUI test DB: ${dbFile}`);
console.log("rows: flow_sessions=325 dns_query_log=266 events=360 route_decisions=180 device_inventory=12 alarm_events=4 console_page_summaries=3 prepared_windows=today/week/month");
