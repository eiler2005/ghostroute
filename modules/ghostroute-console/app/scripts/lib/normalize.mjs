import crypto from "node:crypto";
import { classifyDestination } from "../../../../traffic-intelligence/lib/classification.mjs";
import { buildDashboardAnalyticsFromRows } from "../../src/lib/dashboard-analytics.mjs";
import { loadDeviceAttributions, resolveClient } from "../../src/lib/device-attribution.mjs";
import { trafficClassFor } from "../../src/lib/traffic-classification.mjs";
import { bucketStartUtc, mskWindowBounds, mskWindowLabel, parseSourceTimestamp, toMskKey, toUtcIsoFromMskKey } from "../../src/lib/time/window.mjs";
import { CLIENT_TRAFFIC_LANE_TABLES, rebuildClientTrafficLaneReadModels } from "./client-traffic-lanes.mjs";
import { normalizeRouterRollups } from "./router-rollups.mjs";

const MIGRATION_VERSION = 16;
const TRAFFIC_READ_MODEL_TABLES = [
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
  "dns_log_5min",
  "dns_log_hourly",
  "dns_log_daily",
  "dns_log_weekly",
  "dns_log_monthly",
  ...CLIENT_TRAFFIC_LANE_TABLES,
  "top_clients_window",
  "top_destinations_window",
  "traffic_window_snapshots",
];
const PREPARED_TRAFFIC_CLASSES = ["all", "client", "personal_cloud", "service_background", "unclassified"];

function json(value) {
  return JSON.stringify(value || {});
}

function confidence(value, fallback = "unknown") {
  const normalized = String(value || fallback);
  if (["exact", "estimated", "dns-interest", "unknown", "mixed"].includes(normalized)) return normalized;
  return fallback;
}

function text(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseJson(value, fallback = {}) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function lower(value) {
  return text(value).toLowerCase();
}

function suffixMatch(domain, candidate) {
  const a = lower(domain).replace(/^\*\./, "");
  const b = lower(candidate).replace(/^\*\./, "");
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function domainKey(value) {
  return lower(value).replace(/^\*\./, "").replace(/\.$/, "");
}

function addColumnIfMissing(db, table, column, definition) {
  const columns = db.prepare(`pragma table_info(${table})`).all();
  if (!columns.some((row) => row.name === column)) {
    db.exec(`alter table ${table} add column ${column} ${definition}`);
  }
}

function dropLegacyAggregateTablesForV12(db) {
  const version = db.prepare("select coalesce(max(version), 0) as version from schema_migrations").get()?.version || 0;
  if (version >= 12) return;
  db.exec(`
    drop table if exists client_traffic_5min;
    drop table if exists client_traffic_hourly;
    drop table if exists client_traffic_daily;
    drop table if exists client_traffic_weekly;
    drop table if exists client_traffic_monthly;
    drop table if exists client_destination_traffic_5min;
    drop table if exists client_destination_traffic_hourly;
    drop table if exists client_destination_traffic_daily;
    drop table if exists client_destination_traffic_weekly;
    drop table if exists client_destination_traffic_monthly;
    drop table if exists dns_log_5min;
    drop table if exists dns_log_hourly;
    drop table if exists dns_log_daily;
    drop table if exists dns_log_weekly;
    drop table if exists dns_log_monthly;
  `);
}

function inferChannel(row) {
  const raw = JSON.stringify(row || {}).toLowerCase();
  const client = text(row.client || row.label || row.profile || row.channel || row.source || "");
  const source = `${raw} ${client.toLowerCase()}`;
  if (source.includes('mobile-client-') || source.includes('report-mobile-profile-')) return 'A/Home Reality';
  if (/\b\/\s*c1\b|\bc1_|channel-c|shadowrocket|naive/.test(source)) return "Channel C";
  if (/\b\/\s*b\b|iphone-b|channel-b|xhttp|xray|selected-client/.test(source)) return "Channel B";
  if (source.includes("channel-c") || source.includes("shadowrocket") || source.includes("naive")) return "Channel C";
  if (source.includes("channel-b") || source.includes("xhttp") || source.includes("xray") || source.includes("selected-client")) return "Channel B";
  if (source.includes("home_reality") || source.includes("home-reality") || source.includes("reality-in") || source.includes("reality qr")) return "A/Home Reality";
  if (source.includes("br0") || source.includes("lan") || source.includes("wi-fi") || source.includes("wifi") || source.includes("192.168.")) return "Home Wi-Fi/LAN";
  if (/^lan-host-|^unknown device|^iphone|^ipad|^macbook|^apple tv/i.test(client)) return "Home Wi-Fi/LAN";
  return text(row.channel || "Unknown");
}

function routeFromTraffic(row) {
  if (number(row.via_vps_bytes || row.reality_bytes || row.vps_connections) > 0) return "VPS";
  if (number(row.direct_bytes || row.wan_bytes || row.direct_connections) > 0) return "Direct";
  return text(row.route || "Unknown");
}

function outboundFor(row) {
  const raw = JSON.stringify(row || {});
  if (routeFromTraffic(row) === "Direct") return "direct-out";
  if (/reality-out|stealth-vps|vps/i.test(raw) || routeFromTraffic(row) === "VPS") return "reality-out";
  if (/direct-out|direct|wan/i.test(raw)) return "direct-out";
  return text(row.outbound || row.raw_outbound || "");
}

function visibleIp(row) {
  return text(row.egress_ip || row.exit_ip || row.visible_ip || row.public_ip || row.ip || "");
}

function destinationIp(row) {
  const candidate = text(row.destination_ip || row.ip || "");
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(candidate) ? candidate : "";
}

function eventTimestamp(row, collectedAt) {
  return parseSourceTimestamp(row.ts || row.timestamp || row.occurred_at || collectedAt);
}

function sourceTimeRaw(row) {
  return text(row?.ts || row?.timestamp || row?.occurred_at || "");
}

function hasExplicitMillis(raw) {
  return /\.\d{1,9}(?:Z|[+-]\d\d:?\d\d)?$/.test(text(raw));
}

function timestampContract(row, collectedAt) {
  const observedAtUtc = parseSourceTimestamp(collectedAt);
  const raw = sourceTimeRaw(row);
  if (raw) {
    const eventTsUtc = parseSourceTimestamp(raw);
    const precision = hasExplicitMillis(raw) ? "event_ms" : "event_second";
    return {
      eventTsUtc,
      observedAtUtc,
      displayTsUtc: precision === "event_ms" ? eventTsUtc : observedAtUtc,
      timePrecision: precision,
    };
  }
  return {
    eventTsUtc: "",
    observedAtUtc,
    displayTsUtc: observedAtUtc,
    timePrecision: "collector_ms",
  };
}

function hasNumber(value) {
  return value !== undefined && value !== null && value !== "" && Number.isFinite(Number(value));
}

function firstNumber(...values) {
  for (const value of values) {
    if (hasNumber(value)) return number(value);
  }
  return 0;
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    if (!hasNumber(value)) continue;
    const parsed = number(value);
    if (parsed > 0) return parsed;
  }
  return 0;
}

function splitByteTotal(row) {
  return number(row?.via_vps_bytes || row?.reality_bytes)
    + number(row?.direct_bytes || row?.wan_bytes)
    + number(row?.unknown_bytes || row?.unresolved_bytes);
}

function aggregateTotalBytes(row) {
  return firstPositiveNumber(row?.bytes, row?.total_bytes, row?.observed_bytes) || splitByteTotal(row);
}

function signedByteSplit(row, route = row?.route, totalBytes = number(row?.bytes || row?.total_bytes)) {
  const evidence = row?.evidence_json ? parseJson(row.evidence_json, {}) : row?.raw || row || {};
  let total = number(totalBytes);
  let explicitVps = hasNumber(row?.via_vps_bytes) || hasNumber(row?.reality_bytes) || hasNumber(evidence.via_vps_bytes) || hasNumber(evidence.reality_bytes);
  let explicitDirect = hasNumber(row?.direct_bytes) || hasNumber(row?.wan_bytes) || hasNumber(evidence.direct_bytes) || hasNumber(evidence.wan_bytes);
  let explicitUnknown = hasNumber(row?.unknown_bytes) || hasNumber(row?.unresolved_bytes) || hasNumber(evidence.unknown_bytes) || hasNumber(evidence.unresolved_bytes);
  let viaVpsBytes = firstNumber(row?.via_vps_bytes, row?.reality_bytes, evidence.via_vps_bytes, evidence.reality_bytes);
  let directBytes = firstNumber(row?.direct_bytes, row?.wan_bytes, evidence.direct_bytes, evidence.wan_bytes);
  let unknownBytes = firstNumber(row?.unknown_bytes, row?.unresolved_bytes, evidence.unknown_bytes, evidence.unresolved_bytes);
  const evidenceHasSplit = hasNumber(evidence.via_vps_bytes) || hasNumber(evidence.reality_bytes)
    || hasNumber(evidence.direct_bytes) || hasNumber(evidence.wan_bytes)
    || hasNumber(evidence.unknown_bytes) || hasNumber(evidence.unresolved_bytes);
  if (total > 0 && !evidenceHasSplit && viaVpsBytes === 0 && directBytes === 0 && unknownBytes === 0) {
    explicitVps = false;
    explicitDirect = false;
    explicitUnknown = false;
  }
  if (total <= 0 && viaVpsBytes + directBytes + unknownBytes > 0) {
    total = viaVpsBytes + directBytes + unknownBytes;
  }
  if (total > 0 && viaVpsBytes === 0 && directBytes === 0 && unknownBytes === 0) {
    explicitVps = hasNumber(evidence.via_vps_bytes) || hasNumber(evidence.reality_bytes) || hasNumber(row?.reality_bytes);
    explicitDirect = hasNumber(evidence.direct_bytes) || hasNumber(evidence.wan_bytes) || hasNumber(row?.wan_bytes);
    explicitUnknown = hasNumber(evidence.unknown_bytes) || hasNumber(evidence.unresolved_bytes) || hasNumber(row?.unresolved_bytes);
  }
  const routeValue = text(route || row?.route, "Unknown").toLowerCase();
  if (!explicitVps && !explicitDirect && !explicitUnknown) {
    if (routeValue === "vps") viaVpsBytes = total;
    else if (routeValue === "direct") directBytes = total;
    else unknownBytes = total;
  } else if (!explicitUnknown) {
    unknownBytes = total - viaVpsBytes - directBytes;
  }
  return { totalBytes: total, viaVpsBytes, directBytes, unknownBytes };
}

function rawSplitValues(row = {}, raw = row?.raw || {}) {
  return {
    via_vps_bytes: firstNumber(row?.via_vps_bytes, row?.reality_bytes, raw?.via_vps_bytes, raw?.reality_bytes),
    direct_bytes: firstNumber(row?.direct_bytes, row?.wan_bytes, raw?.direct_bytes, raw?.wan_bytes),
    unknown_bytes: firstNumber(row?.unknown_bytes, row?.unresolved_bytes, raw?.unknown_bytes, raw?.unresolved_bytes),
  };
}

function hasAnyExplicitSplit(row = {}, raw = row?.raw || {}) {
  const rawExplicit = hasNumber(raw?.via_vps_bytes) || hasNumber(raw?.reality_bytes)
    || hasNumber(raw?.direct_bytes) || hasNumber(raw?.wan_bytes)
    || hasNumber(raw?.unknown_bytes) || hasNumber(raw?.unresolved_bytes);
  if (rawExplicit) return true;
  const split = rawSplitValues(row, raw);
  return split.via_vps_bytes !== 0 || split.direct_bytes !== 0 || split.unknown_bytes !== 0;
}

function invalidExplicitSplit(row = {}, raw = row?.raw || {}, totalBytes = aggregateTotalBytes(row)) {
  if (!hasAnyExplicitSplit(row, raw)) return false;
  const split = rawSplitValues(row, raw);
  if (split.via_vps_bytes < 0 || split.direct_bytes < 0 || split.unknown_bytes < 0) return true;
  const hasExplicitUnknown = hasNumber(row?.unknown_bytes) || hasNumber(row?.unresolved_bytes)
    || hasNumber(raw?.unknown_bytes) || hasNumber(raw?.unresolved_bytes);
  const explicitSum = split.via_vps_bytes + split.direct_bytes + split.unknown_bytes;
  if (hasExplicitUnknown && explicitSum !== number(totalBytes)) return true;
  if (!hasExplicitUnknown && split.via_vps_bytes + split.direct_bytes > number(totalBytes)) return true;
  return false;
}

function legacyReportDerivedTrafficFact(row = {}, raw = row?.raw || {}) {
  const basis = lower(raw?.allocation_basis || row?.allocation_basis || row?.source_log || "");
  const evidence = lower(raw?.evidence_level || row?.evidence_level || "");
  const sourceText = lower(JSON.stringify({
    sources: raw?.sources || row?.sources || "",
    source: raw?.source || row?.source || "",
    client: raw?.client || row?.client || "",
    client_label: raw?.client_label || row?.client_label || "",
  }));
  if (basis === "connection_share") return true;
  if (evidence === "domain_or_sni") return true;
  if (sourceText.includes("traffic-report")) return true;
  if (sourceText.includes("report-mobile-profile-")) return true;
  return false;
}

function splitInvariantHolds(split) {
  return split.totalBytes >= 0
    && split.viaVpsBytes >= 0
    && split.directBytes >= 0
    && split.unknownBytes >= 0
    && split.totalBytes === split.viaVpsBytes + split.directBytes + split.unknownBytes;
}

function trafficAggregateEligibility(row = {}, raw = row?.raw || {}, split = signedByteSplit(row)) {
  const snapshotType = text(row?.snapshot_type || raw?.snapshot_type || "");
  if (snapshotType === "traffic_facts" && legacyReportDerivedTrafficFact(row, raw)) {
    return { eligible: false, reason: "legacy_report_derived" };
  }
  if (invalidExplicitSplit(row, raw, split.totalBytes)) {
    return { eligible: false, reason: "invalid_explicit_split" };
  }
  if (!splitInvariantHolds(split)) {
    return { eligible: false, reason: "invalid_split_invariant" };
  }
  return { eligible: true, reason: "ok" };
}

function flowTrafficClass(row) {
  return trafficClassFor({ ...row, raw: row?.raw || row });
}

function intendedRoute(row) {
  const route = text(row?.intended_route || row?.route || "");
  if (["VPS", "Direct"].includes(route)) return route;
  return "Unknown";
}

function routeStatus(row) {
  const value = text(row?.route_status || "").toLowerCase();
  if (["verified", "counter_allocated", "intent_only", "mismatch", "unknown"].includes(value)) return value;
  const verification = text(row?.route_verification || "").toLowerCase();
  if (["verified_vps", "verified_direct"].includes(verification)) return "verified";
  if (verification === "counter_allocated" || verification === "ingress_route_allocated") return "counter_allocated";
  if (verification === "intent_only") return "intent_only";
  if (verification === "mismatch") return "mismatch";
  return "unknown";
}

function dnsStatus(row) {
  const value = text(row?.dns_status || "").toLowerCase();
  if (["exact", "shared", "no_match", "approximate_ts"].includes(value)) return value;
  const confidenceValue = text(row?.dns_link_confidence || "").toLowerCase();
  if (confidenceValue === "no_dns_match") return "no_match";
  if (confidenceValue === "low") return "shared";
  if (text(row?.dns_ts_source || "").toLowerCase() === "snapshot_approx") return "approximate_ts";
  return confidenceValue ? "exact" : "no_match";
}

function dnsTsSource(row) {
  return text(row?.dns_ts_source || row?.ts_source || "");
}

function destinationKeyFor(row) {
  const value = text(row?.dns_qname || row?.domain || row?.destination || row?.destination_ip || row?.ip || "").trim().toLowerCase();
  return value || "unknown";
}

function destinationKindFor(row) {
  const key = destinationKeyFor(row);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(key) || (key.includes(":") && /^[0-9a-f:.]+$/i.test(key))) return "ip";
  return "domain";
}

function syncTrafficIntelligence(db, snapshotId, collectedAt, fact) {
  const classification = classifyDestination(fact);
  const destinationKey = destinationKeyFor(fact);
  const kind = destinationKindFor(fact);
  const value = text(fact.dns_qname || fact.domain || fact.destination || fact.destination_ip || destinationKey);
  const normalizedValue = destinationKey;
  const now = collectedAt || new Date().toISOString();
  const sources = classification.evidence_sources || [];
  const evidence = {
    fact_id: fact.fact_id,
    route: fact.route,
    intended_route: fact.intended_route,
    route_verification: fact.route_verification,
    route_status: fact.route_status,
    dns_link_confidence: fact.dns_link_confidence,
    dns_status: fact.dns_status,
  };
  db.prepare(`
    insert into destination_enrichment(destination_key, kind, value, normalized_value, category, provider, action_hint,
      traffic_class, traffic_lane, dns_category, traffic_role, traffic_purpose, decision_hint, human_explanation, source, confidence, reason_code,
      sources_json, evidence_sources_json, evidence_json, first_seen, last_seen, expires_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')
    on conflict(destination_key) do update set
      kind = excluded.kind,
      value = excluded.value,
      normalized_value = excluded.normalized_value,
      category = excluded.category,
      provider = excluded.provider,
      action_hint = excluded.action_hint,
      traffic_class = excluded.traffic_class,
      traffic_lane = excluded.traffic_lane,
      dns_category = excluded.dns_category,
      traffic_role = excluded.traffic_role,
      traffic_purpose = excluded.traffic_purpose,
      decision_hint = excluded.decision_hint,
      human_explanation = excluded.human_explanation,
      source = excluded.source,
      confidence = excluded.confidence,
      reason_code = excluded.reason_code,
      sources_json = excluded.sources_json,
      evidence_sources_json = excluded.evidence_sources_json,
      evidence_json = excluded.evidence_json,
      last_seen = excluded.last_seen
  `).run(
    destinationKey,
    kind,
    value,
    normalizedValue,
    classification.category,
    classification.provider,
    classification.action_hint || classification.decision_hint,
    classification.traffic_class,
    classification.traffic_lane,
    classification.dns_category,
    classification.traffic_role,
    classification.traffic_purpose,
    classification.decision_hint,
    classification.human_explanation,
    "local_rules",
    classification.confidence,
    classification.reason_code,
    JSON.stringify(sources),
    JSON.stringify(sources),
    JSON.stringify(evidence),
    now,
    now
  );

  const actionable = new Set(["block_candidate", "ask_user", "route_vps_candidate", "direct_candidate", "investigate"]);
  if (!actionable.has(classification.decision_hint)) return;
  const candidateId = crypto.createHash("sha256")
    .update([snapshotId, destinationKey, fact.client_key || "", classification.decision_hint, classification.reason_code].join("|"))
    .digest("hex")
    .slice(0, 32);
  db.prepare(`
    insert or replace into decision_candidates(candidate_id, snapshot_id, destination_key, client_key, client_ip,
      proposed_action, confidence, reason_code, explanation, status, applied, created_at_utc, updated_at_utc, evidence_json)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
  `).run(
    candidateId,
    snapshotId,
    destinationKey,
    text(fact.client_key || ""),
    text(fact.client_ip || ""),
    classification.decision_hint,
    classification.confidence,
    classification.reason_code,
    classification.human_explanation,
    now,
    now,
    JSON.stringify({ ...evidence, category: classification.category, traffic_class: classification.traffic_class, traffic_lane: classification.traffic_lane, dns_category: classification.dns_category })
  );
}

function isConcreteDestination(value) {
  const normalized = lower(value);
  return Boolean(normalized && normalized !== "unknown destination" && normalized !== "unknown" && normalized !== "n/a");
}

function registryHasClient(registry, key) {
  return Boolean(key && registry?.clients?.[key]);
}

function normalizedHint(value) {
  return lower(value).replace(/-/g, ":");
}

function registeredClientResult(registry, key, row, matchedBy = "runtime_hint") {
  const entry = registry?.clients?.[key];
  if (!entry) return null;
  return {
    registered: true,
    client_key: key,
    client_label: entry.label || text(row?.client_label || row?.label || key, key),
    device_key: entry.device_key || key,
    channel: text(entry.primary_channel || entry.channel || row?.channel || inferChannel(row?.raw || row), "Unknown"),
    matched_by: matchedBy,
  };
}

function buildInventoryNetworkHints(db, registry = loadDeviceAttributions()) {
  const hints = new Map();
  try {
    const rows = db.prepare("select device_key, label, ip, hostname, mac, aliases_json, profile, channel from device_inventory").all();
    for (const row of rows) {
      const aliases = parseJson(row.aliases_json, []);
      const resolved = resolveClient({
        ...row,
        client: row.device_key || row.label || row.profile || "",
        raw: { profile: row.profile, client: row.device_key, ip: row.ip, mac: row.mac },
        aliases,
      }, registry);
      if (!registryHasClient(registry, resolved.client_key)) continue;
      for (const candidate of [row.ip, row.mac, row.hostname, row.device_key, row.label, row.profile, ...aliases]) {
        const key = normalizedHint(candidate);
        if (key) hints.set(key, resolved.client_key);
      }
    }
  } catch {
    return hints;
  }
  return hints;
}

function resolveOperatorClient(row, registry = loadDeviceAttributions(), networkHints = new Map()) {
  const raw = row?.raw || {};
  const resolved = resolveClient({
    ...row,
    raw,
    client: row?.client_key || row?.device_key || row?.client || raw.client || "",
    label: row?.client_label || row?.label || raw.label || raw.client || "",
    profile: raw.profile || row?.profile || row?.device_key || "",
    client_ip: row?.client_ip || raw.client_ip || raw.ip || "",
    ip: row?.client_ip || raw.client_ip || raw.ip || "",
    mac: row?.mac || raw.mac || raw.mac_address || "",
  }, registry);
  const registered = registryHasClient(registry, resolved.client_key);
  if (!registered) {
    for (const candidate of [row?.client_ip, row?.ip, row?.source_ip, row?.mac, row?.device_key, raw.client_ip, raw.ip, raw.source_ip, raw.mac, raw.mac_address]) {
      const key = networkHints.get(normalizedHint(candidate));
      const hinted = registeredClientResult(registry, key, row, "device_inventory_network_hint");
      if (hinted) return hinted;
    }
  }
  return {
    registered,
    client_key: registered ? resolved.client_key : text(row?.client_key || row?.client || raw.profile || raw.client || row?.client_ip || "Unknown client"),
    client_label: registered ? resolved.client_label : text(row?.client_label || row?.label || row?.client_key || row?.client || raw.client || "Unknown client"),
    device_key: registered ? resolved.device_key : "",
    channel: registered ? text(resolved.client_channel || row?.channel || inferChannel(raw), "Unknown") : text(row?.channel || inferChannel(raw), "Unknown"),
    matched_by: resolved.matched_by || "unmatched",
  };
}

function isOperatorTrafficRow(row, registry = loadDeviceAttributions()) {
  if (number(row?.bytes || row?.total_bytes) <= 0) return false;
  if (!["client", "personal_cloud"].includes(row?.traffic_class)) return false;
  if (String(row?.confidence || "").toLowerCase() === "dns-interest") return false;
  return registryHasClient(registry, row?.client_key);
}

function insertCollectorWarning(db, type, collectedAt, message, evidence = {}) {
  db.prepare(
    "insert into collector_errors(run_id, type, collected_at, command, message, output_sample) values (?, ?, ?, ?, ?, ?)"
  ).run(null, type, collectedAt || new Date().toISOString(), "normalize", message, JSON.stringify(evidence).slice(0, 1000));
}

function maybeLogCounterDrift(db, collectedAt, row, split) {
  if (split.unknownBytes >= 0) return;
  insertCollectorWarning(db, "counter_drift", collectedAt, "traffic counters exceed total bytes", {
    client: row.client || row.label || "",
    destination: row.destination || row.domain || row.app || "",
    total_bytes: split.totalBytes,
    via_vps_bytes: split.viaVpsBytes,
    direct_bytes: split.directBytes,
    unknown_bytes: split.unknownBytes,
  });
}

export function ensureConsoleSchema(db) {
  db.exec(`
    create table if not exists schema_migrations (
      version integer primary key,
      applied_at text not null
    );
  `);
  dropLegacyAggregateTablesForV12(db);
  db.exec(`
    create table if not exists schema_migrations (
      version integer primary key,
      applied_at text not null
    );

    create table if not exists snapshots (
      id integer primary key autoincrement,
      type text not null,
      collected_at text not null,
      source text not null,
      path text not null,
      payload_json text not null
    );
    create index if not exists idx_snapshots_type_collected on snapshots(type, collected_at desc);

    create table if not exists collector_runs (
      id integer primary key autoincrement,
      started_at text not null,
      finished_at text,
      ok_count integer not null default 0,
      error_count integer not null default 0
    );

    create table if not exists collector_errors (
      id integer primary key autoincrement,
      run_id integer,
      type text not null,
      collected_at text not null,
      command text not null,
      message text not null,
      output_sample text not null default ''
    );
    create index if not exists idx_collector_errors_collected on collector_errors(collected_at desc);

      create table if not exists normalized_devices (
      snapshot_id integer not null,
      snapshot_type text not null,
      collected_at text not null,
        device_id text not null,
        label text not null,
        ip text not null default '',
        hostname text not null default '',
        mac text not null default '',
        channel text not null default 'Unknown',
        route text not null default 'Unknown',
      confidence text not null default 'unknown',
      total_bytes integer not null default 0,
      via_vps_bytes integer not null default 0,
      direct_bytes integer not null default 0,
      raw_json text not null
    );
    create index if not exists idx_normalized_devices_snapshot on normalized_devices(snapshot_id);

      create table if not exists normalized_flows (
      snapshot_id integer not null,
      snapshot_type text not null,
        collected_at text not null,
        client text not null default '',
        channel text not null default 'Unknown',
        destination text not null default '',
      route text not null default 'Unknown',
      confidence text not null default 'unknown',
      bytes integer not null default 0,
      connections integer not null default 0,
      protocol text not null default '',
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
      event_ts text not null default '',
      event_ts_utc text not null default '',
      observed_at_utc text not null default '',
      display_ts_utc text not null default '',
      time_precision text not null default 'collector_ms',
      ts_confidence text not null default '',
      source_log text not null default '',
      raw_json text not null
    );
    create index if not exists idx_normalized_flows_snapshot on normalized_flows(snapshot_id);

    create table if not exists traffic_facts (
      fact_id text primary key,
      snapshot_id integer not null,
      collected_at text not null,
      event_ts_utc text not null default '',
      observed_at_utc text not null default '',
      display_ts_utc text not null default '',
      time_precision text not null default 'collector_ms',
      client_key text not null default '',
      client_label text not null default '',
      client_ip text not null default '',
      device_key text not null default '',
      channel text not null default 'Unknown',
      route text not null default 'Unknown',
      traffic_class text not null default 'client',
      destination text not null default '',
      destination_kind text not null default '',
      destination_ip text not null default '',
      destination_port text not null default '',
      dns_qname text not null default '',
      dns_answer_ip text not null default '',
      sni text not null default '',
      policy text not null default '',
      matched_rule text not null default '',
      outbound text not null default '',
      bytes integer not null default 0,
      via_vps_bytes integer not null default 0,
      direct_bytes integer not null default 0,
      unknown_bytes integer not null default 0,
      connections integer not null default 0,
      identity_confidence text not null default 'unknown',
      byte_confidence text not null default 'unknown',
      destination_confidence text not null default 'unknown',
      allocation_basis text not null default '',
      evidence_level text not null default '',
      confidence text not null default 'unknown',
      evidence_json text not null default '{}'
    );
    create index if not exists idx_traffic_facts_collected on traffic_facts(collected_at desc);
    create index if not exists idx_traffic_facts_client on traffic_facts(client_key, collected_at desc);
    create index if not exists idx_traffic_facts_destination on traffic_facts(destination, dns_qname, destination_ip);

    create table if not exists router_traffic_rollups (
      snapshot_id integer not null,
      collected_at text not null,
      kind text not null default 'total',
      layer text not null default '',
      window_start_utc text not null default '',
      window_msk_key text not null default '',
      client_key text not null default '',
      client_label text not null default '',
      client_ip text not null default '',
      channel text not null default 'Home Wi-Fi/LAN',
      route text not null default 'Unknown',
      traffic_class text not null default 'client',
      destination_ip text not null default '',
      bytes integer not null default 0,
      via_vps_bytes integer not null default 0,
      direct_bytes integer not null default 0,
      unknown_bytes integer not null default 0,
      flows integer not null default 0,
      source text not null default 'router_edge_rollup',
      evidence_json text not null default '{}',
      primary key (snapshot_id, kind, layer, window_start_utc, client_ip, channel, route, traffic_class, destination_ip)
    );
    create index if not exists idx_router_rollups_layer_window on router_traffic_rollups(kind, layer, window_start_utc);
    create index if not exists idx_router_rollups_client on router_traffic_rollups(client_key, window_start_utc);

    create table if not exists traffic_clients (
      snapshot_id integer not null,
      collected_at text not null,
      client_key text not null default '',
      client_label text not null default '',
      client_ip text not null default '',
      hostname text not null default '',
      mac_hash text not null default '',
      channel text not null default 'Unknown',
      route text not null default 'Unknown',
      traffic_class text not null default 'client',
      total_bytes integer not null default 0,
      via_vps_bytes integer not null default 0,
      direct_bytes integer not null default 0,
      unknown_bytes integer not null default 0,
      identity_confidence text not null default 'unknown',
      evidence_json text not null default '{}',
      primary key (snapshot_id, client_key, channel)
    );
    create index if not exists idx_traffic_clients_collected on traffic_clients(collected_at desc);

    create table if not exists traffic_dns_links (
      snapshot_id integer not null,
      collected_at text not null,
      client_key text not null default '',
      client_ip text not null default '',
      domain text not null default '',
      destination text not null default '',
      link_type text not null default '',
      confidence text not null default 'unknown',
      evidence_json text not null default '{}'
    );
    create index if not exists idx_traffic_dns_links_domain on traffic_dns_links(domain, collected_at desc);

    create table if not exists traffic_attribution_gaps (
      gap_id text primary key,
      snapshot_id integer not null,
      collected_at text not null,
      scope text not null default '',
      client_key text not null default '',
      client_label text not null default '',
      client_ip text not null default '',
      channel text not null default 'Unknown',
      route text not null default 'Unknown',
      destination text not null default '',
      bytes integer not null default 0,
      via_vps_bytes integer not null default 0,
      direct_bytes integer not null default 0,
      unknown_bytes integer not null default 0,
      reason text not null default '',
      allocation_basis text not null default '',
      evidence_level text not null default 'gap',
      evidence_json text not null default '{}'
    );
    create index if not exists idx_traffic_gaps_collected on traffic_attribution_gaps(collected_at desc);

    create table if not exists normalized_dns (
      snapshot_id integer not null,
      collected_at text not null,
      client text not null default '',
      client_ip text not null default '',
      domain text not null default '',
      qtype text not null default '',
      count integer not null default 0,
      answer_ip text not null default '',
      event_ts text not null default '',
      event_ts_utc text not null default '',
      observed_at_utc text not null default '',
      display_ts_utc text not null default '',
      time_precision text not null default 'collector_ms',
      ts_confidence text not null default '',
      confidence text not null default 'dns-interest',
      raw_json text not null
    );
    create index if not exists idx_normalized_dns_snapshot on normalized_dns(snapshot_id);

    create table if not exists normalized_health (
      snapshot_id integer not null,
      collected_at text not null,
      check_name text not null,
      status text not null default 'UNKNOWN',
      confidence text not null default 'unknown',
      detail text not null default '',
      raw_json text not null
    );
    create index if not exists idx_normalized_health_snapshot on normalized_health(snapshot_id);

    create table if not exists normalized_catalog (
      snapshot_id integer not null,
      collected_at text not null,
      domain text not null,
      entry_type text not null,
      source text not null default '',
      confidence text not null default 'unknown',
      raw_json text not null
    );
    create index if not exists idx_normalized_catalog_snapshot on normalized_catalog(snapshot_id);

    create table if not exists normalized_alerts (
      snapshot_id integer,
      snapshot_type text not null,
      collected_at text not null,
      severity text not null default 'warning',
      title text not null,
      status text not null default '',
      confidence text not null default 'unknown',
      evidence text not null default '',
      raw_json text not null
    );
    create index if not exists idx_normalized_alerts_collected on normalized_alerts(collected_at desc);

    create table if not exists hourly_traffic (
      hour_key text not null,
      route text not null default 'Unknown',
      bytes integer not null default 0,
      flows integer not null default 0,
      clients integer not null default 0,
      updated_at text not null,
      primary key (hour_key, route)
    );

      create table if not exists retention_runs (
      id integer primary key autoincrement,
      ran_at text not null,
      raw_deleted integer not null default 0,
      snapshot_rows_deleted integer not null default 0,
      backups_deleted integer not null default 0,
        backup_path text not null default ''
      );
      create table if not exists events (
        id integer primary key autoincrement,
         snapshot_id integer,
         event_type text not null,
         occurred_at text not null,
         event_ts_utc text not null default '',
         observed_at_utc text not null default '',
         display_ts_utc text not null default '',
         time_precision text not null default 'collector_ms',
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
         event_ts_utc text not null default '',
         observed_at_utc text not null default '',
         display_ts_utc text not null default '',
         time_precision text not null default 'collector_ms',
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
      create table if not exists live_cursors (
        source text primary key,
        cursor text not null default '',
        updated_at text not null
      );
      create table if not exists audit_log (
        id integer primary key autoincrement,
        actor text not null default 'local-console',
        action text not null,
        target text not null default '',
        status text not null default 'recorded',
        summary text not null default '',
        rollback_ref text not null default '',
        created_at text not null,
        evidence_json text not null default '{}'
      );
      create table if not exists notifications (
        id integer primary key autoincrement,
        type text not null,
        severity text not null default 'info',
        title text not null,
        status text not null default 'open',
        channel text not null default '',
        target text not null default '',
        created_at text not null,
        updated_at text not null,
        snoozed_until text not null default '',
        evidence_json text not null default '{}'
      );
      create table if not exists notification_settings (
        key text primary key,
        value_json text not null,
        updated_at text not null
      );
      create table if not exists catalog_reviews (
        id integer primary key autoincrement,
        domain text not null,
        decision text not null,
        reason text not null default '',
        status text not null default 'reviewed',
        created_at text not null,
        updated_at text not null
      );
      create table if not exists ops_runs (
        id integer primary key autoincrement,
        action text not null,
        status text not null,
        started_at text not null,
        finished_at text not null default '',
        summary text not null default '',
        evidence_json text not null default '{}'
      );

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
         event_ts_utc text not null default '',
         observed_at_utc text not null default '',
         display_ts_utc text not null default '',
         time_precision text not null default 'collector_ms',
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
      create table if not exists dns_query_log (
        id text primary key,
         snapshot_id integer,
         collected_at text not null,
         event_ts text not null default '',
         event_ts_utc text not null default '',
         observed_at_utc text not null default '',
         display_ts_utc text not null default '',
         time_precision text not null default 'collector_ms',
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
      create table if not exists console_settings (
        key text primary key,
        value_json text not null,
        updated_at text not null
      );
      create table if not exists console_page_summaries (
        page text primary key,
        source_version text not null default '',
        rebuilt_at text not null,
        payload_json text not null
      );
      create table if not exists client_traffic_5min (
        bucket_start_utc text not null,
        bucket_msk_key text not null,
        client_key text not null default '',
        client_label text not null default '',
        channel text not null default 'Unknown',
        route text not null default 'Unknown',
        confidence text not null default 'unknown',
        traffic_class text not null default 'client',
        bytes integer not null default 0,
        via_vps_bytes integer not null default 0,
        direct_bytes integer not null default 0,
        unknown_bytes integer not null default 0,
        flows integer not null default 0,
        connections integer not null default 0,
        observed_bytes integer not null default 0,
        attributed_bytes integer not null default 0,
        updated_at_utc text not null default '',
        primary key (bucket_start_utc, client_key, channel, route, confidence, traffic_class)
      );
      create table if not exists client_traffic_hourly (
        hour_msk_key text not null,
        hour_start_utc text not null,
        client_key text not null default '',
        client_label text not null default '',
        channel text not null default 'Unknown',
        route text not null default 'Unknown',
        confidence text not null default 'unknown',
        traffic_class text not null default 'client',
        bytes integer not null default 0,
        via_vps_bytes integer not null default 0,
        direct_bytes integer not null default 0,
        unknown_bytes integer not null default 0,
        observed_bytes integer not null default 0,
        attributed_bytes integer not null default 0,
        flows integer not null default 0,
        clients integer not null default 0,
        updated_at_utc text not null,
        primary key (hour_msk_key, client_key, channel, route, confidence, traffic_class)
      );
      create table if not exists client_traffic_daily (
        day_msk_key text not null,
        day_start_utc text not null,
        client_key text not null default '',
        client_label text not null default '',
        channel text not null default 'Unknown',
        route text not null default 'Unknown',
        confidence text not null default 'unknown',
        traffic_class text not null default 'client',
        bytes integer not null default 0,
        via_vps_bytes integer not null default 0,
        direct_bytes integer not null default 0,
        unknown_bytes integer not null default 0,
        observed_bytes integer not null default 0,
        attributed_bytes integer not null default 0,
        flows integer not null default 0,
        clients integer not null default 0,
        updated_at_utc text not null,
        primary key (day_msk_key, client_key, channel, route, confidence, traffic_class)
      );
      create table if not exists client_traffic_weekly (
        week_msk_key text not null,
        week_start_utc text not null,
        client_key text not null default '',
        client_label text not null default '',
        channel text not null default 'Unknown',
        route text not null default 'Unknown',
        confidence text not null default 'unknown',
        traffic_class text not null default 'client',
        bytes integer not null default 0,
        via_vps_bytes integer not null default 0,
        direct_bytes integer not null default 0,
        unknown_bytes integer not null default 0,
        observed_bytes integer not null default 0,
        attributed_bytes integer not null default 0,
        flows integer not null default 0,
        clients integer not null default 0,
        updated_at_utc text not null,
        primary key (week_msk_key, client_key, channel, route, confidence, traffic_class)
      );
      create table if not exists client_traffic_monthly (
        month_msk_key text not null,
        month_start_utc text not null,
        client_key text not null default '',
        client_label text not null default '',
        channel text not null default 'Unknown',
        route text not null default 'Unknown',
        confidence text not null default 'unknown',
        traffic_class text not null default 'client',
        bytes integer not null default 0,
        via_vps_bytes integer not null default 0,
        direct_bytes integer not null default 0,
        unknown_bytes integer not null default 0,
        observed_bytes integer not null default 0,
        attributed_bytes integer not null default 0,
        flows integer not null default 0,
        clients integer not null default 0,
        updated_at_utc text not null,
        primary key (month_msk_key, client_key, channel, route, confidence, traffic_class)
      );
      create table if not exists client_destination_traffic_5min (
        bucket_start_utc text not null,
        bucket_msk_key text not null,
        client_key text not null default '',
        client_label text not null default '',
        channel text not null default 'Unknown',
        route text not null default 'Unknown',
        confidence text not null default 'unknown',
        traffic_class text not null default 'client',
        destination_key text not null default '',
        bytes integer not null default 0,
        via_vps_bytes integer not null default 0,
        direct_bytes integer not null default 0,
        unknown_bytes integer not null default 0,
        flows integer not null default 0,
        connections integer not null default 0,
        observed_bytes integer not null default 0,
        attributed_bytes integer not null default 0,
        updated_at_utc text not null default '',
        primary key (bucket_start_utc, client_key, channel, route, confidence, traffic_class, destination_key)
      );
      create table if not exists client_destination_traffic_hourly (
        hour_msk_key text not null,
        hour_start_utc text not null,
        client_key text not null default '',
        client_label text not null default '',
        channel text not null default 'Unknown',
        route text not null default 'Unknown',
        confidence text not null default 'unknown',
        traffic_class text not null default 'client',
        destination_key text not null default '',
        bytes integer not null default 0,
        via_vps_bytes integer not null default 0,
        direct_bytes integer not null default 0,
        unknown_bytes integer not null default 0,
        observed_bytes integer not null default 0,
        attributed_bytes integer not null default 0,
        flows integer not null default 0,
        clients integer not null default 0,
        updated_at_utc text not null,
        primary key (hour_msk_key, client_key, channel, route, confidence, traffic_class, destination_key)
      );
      create table if not exists client_destination_traffic_daily (
        day_msk_key text not null,
        day_start_utc text not null,
        client_key text not null default '',
        client_label text not null default '',
        channel text not null default 'Unknown',
        route text not null default 'Unknown',
        confidence text not null default 'unknown',
        traffic_class text not null default 'client',
        destination_key text not null default '',
        bytes integer not null default 0,
        via_vps_bytes integer not null default 0,
        direct_bytes integer not null default 0,
        unknown_bytes integer not null default 0,
        observed_bytes integer not null default 0,
        attributed_bytes integer not null default 0,
        flows integer not null default 0,
        clients integer not null default 0,
        updated_at_utc text not null,
        primary key (day_msk_key, client_key, channel, route, confidence, traffic_class, destination_key)
      );
      create table if not exists client_destination_traffic_weekly (
        week_msk_key text not null,
        week_start_utc text not null,
        client_key text not null default '',
        client_label text not null default '',
        channel text not null default 'Unknown',
        route text not null default 'Unknown',
        confidence text not null default 'unknown',
        traffic_class text not null default 'client',
        destination_key text not null default '',
        bytes integer not null default 0,
        via_vps_bytes integer not null default 0,
        direct_bytes integer not null default 0,
        unknown_bytes integer not null default 0,
        observed_bytes integer not null default 0,
        attributed_bytes integer not null default 0,
        flows integer not null default 0,
        clients integer not null default 0,
        updated_at_utc text not null,
        primary key (week_msk_key, client_key, channel, route, confidence, traffic_class, destination_key)
      );
      create table if not exists client_destination_traffic_monthly (
        month_msk_key text not null,
        month_start_utc text not null,
        client_key text not null default '',
        client_label text not null default '',
        channel text not null default 'Unknown',
        route text not null default 'Unknown',
        confidence text not null default 'unknown',
        traffic_class text not null default 'client',
        destination_key text not null default '',
        bytes integer not null default 0,
        via_vps_bytes integer not null default 0,
        direct_bytes integer not null default 0,
        unknown_bytes integer not null default 0,
        observed_bytes integer not null default 0,
        attributed_bytes integer not null default 0,
        flows integer not null default 0,
        clients integer not null default 0,
        updated_at_utc text not null,
        primary key (month_msk_key, client_key, channel, route, confidence, traffic_class, destination_key)
      );
      create table if not exists dns_log_5min (
        bucket_start_utc text not null,
        bucket_msk_key text not null,
        client_key text not null default '',
        client_ip text not null default '',
        domain text not null default '',
        qtype text not null default '',
        catalog_status text not null default 'unknown',
        route text not null default 'Unknown',
        confidence text not null default 'dns-interest',
        query_count integer not null default 0,
        updated_at_utc text not null default '',
        primary key (bucket_start_utc, client_key, client_ip, domain, qtype, catalog_status, route)
      );
      create table if not exists dns_log_hourly (
        hour_msk_key text not null,
        hour_start_utc text not null,
        client_key text not null default '',
        client_ip text not null default '',
        domain text not null default '',
        qtype text not null default '',
        catalog_status text not null default 'unknown',
        route text not null default 'Unknown',
        confidence text not null default 'dns-interest',
        query_count integer not null default 0,
        updated_at_utc text not null default '',
        primary key (hour_msk_key, client_key, client_ip, domain, qtype, catalog_status, route)
      );
      create table if not exists dns_log_daily (
        day_msk_key text not null,
        day_start_utc text not null,
        client_key text not null default '',
        client_ip text not null default '',
        domain text not null default '',
        qtype text not null default '',
        catalog_status text not null default 'unknown',
        route text not null default 'Unknown',
        confidence text not null default 'dns-interest',
        query_count integer not null default 0,
        updated_at_utc text not null default '',
        primary key (day_msk_key, client_key, client_ip, domain, qtype, catalog_status, route)
      );
      create table if not exists dns_log_weekly (
        week_msk_key text not null,
        week_start_utc text not null,
        client_key text not null default '',
        client_ip text not null default '',
        domain text not null default '',
        qtype text not null default '',
        catalog_status text not null default 'unknown',
        route text not null default 'Unknown',
        confidence text not null default 'dns-interest',
        query_count integer not null default 0,
        updated_at_utc text not null default '',
        primary key (week_msk_key, client_key, client_ip, domain, qtype, catalog_status, route)
      );
      create table if not exists dns_log_monthly (
        month_msk_key text not null,
        month_start_utc text not null,
        client_key text not null default '',
        client_ip text not null default '',
        domain text not null default '',
        qtype text not null default '',
        catalog_status text not null default 'unknown',
        route text not null default 'Unknown',
        confidence text not null default 'dns-interest',
        query_count integer not null default 0,
        updated_at_utc text not null default '',
        primary key (month_msk_key, client_key, client_ip, domain, qtype, catalog_status, route)
      );
      create table if not exists top_clients_window (
        window text not null,
        traffic_class text not null default 'client',
        rank integer not null,
        client_key text not null default '',
        label text not null default '',
        channel text not null default 'Unknown',
        route text not null default 'Unknown',
        bytes integer not null default 0,
        via_vps_bytes integer not null default 0,
        direct_bytes integer not null default 0,
        unknown_bytes integer not null default 0,
        flows integer not null default 0,
        computed_at_utc text not null,
        primary key (window, traffic_class, rank)
      );
      create table if not exists top_destinations_window (
        window text not null,
        traffic_class text not null default 'client',
        rank integer not null,
        destination text not null default '',
        channel text not null default 'Unknown',
        route text not null default 'Unknown',
        bytes integer not null default 0,
        flows integer not null default 0,
        observed_bytes integer not null default 0,
        attributed_bytes integer not null default 0,
        computed_at_utc text not null,
        primary key (window, traffic_class, rank)
      );
      create table if not exists traffic_window_snapshots (
        kind text not null,
        window text not null,
        traffic_class text not null default 'client',
        window_start_utc text not null,
        window_end_utc text not null,
        source_version text not null default '',
        computed_at_utc text not null,
        payload_json text not null,
        primary key (kind, window, traffic_class)
      );
      create table if not exists client_traffic_by_lane (
        bucket_granularity text not null,
        bucket_key text not null,
        bucket_start_utc text not null,
        client_key text not null default '',
        client_label text not null default '',
        channel text not null default 'Unknown',
        route text not null default 'Unknown',
        confidence text not null default 'unknown',
        traffic_class text not null default 'unclassified',
        traffic_lane text not null default 'unknown_review',
        dns_category text not null default 'unknown_domain',
        decision_hint text not null default 'monitor',
        enrichment_status text not null default 'missing',
        bytes integer not null default 0,
        via_vps_bytes integer not null default 0,
        direct_bytes integer not null default 0,
        unknown_bytes integer not null default 0,
        flows integer not null default 0,
        destinations_count integer not null default 0,
        top_destinations_json text not null default '[]',
        first_seen_utc text not null default '',
        last_seen_utc text not null default '',
        updated_at_utc text not null default '',
        primary key (bucket_granularity, bucket_key, client_key, channel, route, confidence, traffic_class, traffic_lane, dns_category, decision_hint)
      );
      create table if not exists client_destination_by_lane (
        bucket_granularity text not null,
        bucket_key text not null,
        bucket_start_utc text not null,
        client_key text not null default '',
        client_label text not null default '',
        channel text not null default 'Unknown',
        route text not null default 'Unknown',
        confidence text not null default 'unknown',
        traffic_class text not null default 'unclassified',
        traffic_lane text not null default 'unknown_review',
        dns_category text not null default 'unknown_domain',
        decision_hint text not null default 'monitor',
        destination_key text not null default '',
        destination_label text not null default '',
        category text not null default 'unknown',
        provider text not null default '',
        traffic_role text not null default 'unknown',
        traffic_purpose text not null default 'unknown',
        source text not null default '',
        enrichment_status text not null default 'missing',
        bytes integer not null default 0,
        via_vps_bytes integer not null default 0,
        direct_bytes integer not null default 0,
        unknown_bytes integer not null default 0,
        flows integer not null default 0,
        first_seen_utc text not null default '',
        last_seen_utc text not null default '',
        updated_at_utc text not null default '',
        primary key (bucket_granularity, bucket_key, client_key, channel, route, confidence, traffic_class, traffic_lane, dns_category, decision_hint, destination_key)
      );
      create table if not exists client_route_evidence_defects (
        bucket_granularity text not null,
        bucket_key text not null,
        bucket_start_utc text not null,
        client_key text not null default '',
        client_label text not null default '',
        channel text not null default 'Unknown',
        destination_key text not null default '',
        destination_label text not null default '',
        traffic_lane text not null default 'unknown_review',
        dns_category text not null default 'unknown_domain',
        category text not null default 'unknown',
        provider text not null default '',
        route_evidence text not null default 'unknown_route',
        route text not null default 'Unknown',
        intended_route text not null default 'Unknown',
        route_verification text not null default 'unknown',
        route_status text not null default 'unknown',
        matched_ipset text not null default '',
        bytes integer not null default 0,
        via_vps_bytes integer not null default 0,
        direct_bytes integer not null default 0,
        unknown_bytes integer not null default 0,
        flows integer not null default 0,
        first_seen_utc text not null default '',
        last_seen_utc text not null default '',
        updated_at_utc text not null default '',
        primary key (bucket_granularity, bucket_key, client_key, channel, destination_key, traffic_lane, dns_category, route_evidence, route, intended_route, route_verification, route_status, matched_ipset)
      );
      create table if not exists aggregate_state (
        model text not null,
        window_key text not null,
        source_snapshot_id text not null default '',
        built_until_utc text not null default '',
        status text not null default 'ok',
        detail_json text not null default '{}',
        updated_at_utc text not null,
        primary key (model, window_key)
      );
      create table if not exists destination_enrichment (
        destination_key text primary key,
        kind text not null,
        value text not null,
        normalized_value text not null,
        category text not null default 'unknown',
        provider text not null default '',
        action_hint text not null default 'monitor',
        traffic_class text not null default 'unclassified',
        traffic_lane text not null default 'unknown_review',
        dns_category text not null default 'unknown_domain',
        traffic_role text not null default 'unknown',
        traffic_purpose text not null default 'unknown',
        decision_hint text not null default 'monitor',
        human_explanation text not null default '',
        source text not null default 'local_rules',
        confidence text not null default 'unknown',
        reason_code text not null default '',
        sources_json text not null default '[]',
        evidence_sources_json text not null default '[]',
        evidence_json text not null default '{}',
        first_seen text not null,
        last_seen text not null,
        expires_at text not null default ''
      );
      create table if not exists ip_prefix_catalog (
        prefix_cidr text primary key,
        range_start text not null default '',
        range_end text not null default '',
        range_start_u32 integer not null default 0,
        range_end_u32 integer not null default 0,
        asn text not null default '',
        asn_org text not null default '',
        provider text not null default '',
        country text not null default '',
        registry text not null default '',
        source text not null default 'local',
        updated_at_utc text not null default ''
      );
      create table if not exists ip_enrichment_cache (
        ip text primary key,
        prefix_cidr text not null default '',
        asn text not null default '',
        asn_org text not null default '',
        provider text not null default '',
        category_hint text not null default '',
        traffic_lane_hint text not null default '',
        dns_category_hint text not null default '',
        decision_hint text not null default '',
        country text not null default '',
        registry text not null default '',
        source text not null default '',
        confidence text not null default 'unknown',
        lookup_status text not null default 'pending',
        raw_json text not null default '{}',
        first_seen_utc text not null default '',
        last_seen_utc text not null default '',
        updated_at_utc text not null default '',
        expires_at_utc text not null default ''
      );
      create table if not exists decision_candidates (
        candidate_id text primary key,
        snapshot_id integer,
        destination_key text not null default '',
        client_key text not null default '',
        client_ip text not null default '',
        proposed_action text not null,
        confidence text not null default 'unknown',
        reason_code text not null default '',
        explanation text not null default '',
        status text not null default 'pending',
        applied integer not null default 0,
        created_at_utc text not null,
        updated_at_utc text not null,
        evidence_json text not null default '{}'
      );
      create table if not exists filter_rules (
        rule_id text primary key,
        scope text not null,
        match_kind text not null,
        match_value text not null,
        action text not null,
        priority integer not null default 100,
        enabled integer not null default 0,
        dry_run integer not null default 1,
        reason text not null default '',
        created_by text not null default 'operator',
        created_at_utc text not null,
        updated_at_utc text not null,
        evidence_json text not null default '{}'
      );
      create table if not exists filter_decisions (
        decision_id text primary key,
        snapshot_id text not null,
        observed_at_utc text not null,
        rule_id text not null,
        client_key text not null default '',
        client_ip text not null default '',
        destination text not null default '',
        destination_ip text not null default '',
        matched_field text not null default '',
        matched_value text not null default '',
        would_have_action text not null,
        applied integer not null default 0,
        evidence_json text not null default '{}'
      );
    `);
  addColumnIfMissing(db, "normalized_devices", "hostname", "text not null default ''");
    addColumnIfMissing(db, "normalized_devices", "mac", "text not null default ''");
    addColumnIfMissing(db, "normalized_devices", "channel", "text not null default 'Unknown'");
  addColumnIfMissing(db, "normalized_flows", "channel", "text not null default 'Unknown'");
  for (const [table, columns] of Object.entries({
      normalized_flows: {
      client_ip: "text not null default ''",
      destination_ip: "text not null default ''",
      destination_port: "text not null default ''",
      dns_qname: "text not null default ''",
      dns_answer_ip: "text not null default ''",
      sni: "text not null default ''",
      outbound: "text not null default ''",
      matched_rule: "text not null default ''",
      rule_set: "text not null default ''",
      egress_ip: "text not null default ''",
      egress_asn: "text not null default ''",
      egress_country: "text not null default ''",
      event_ts: "text not null default ''",
      event_ts_utc: "text not null default ''",
      observed_at_utc: "text not null default ''",
      display_ts_utc: "text not null default ''",
      time_precision: "text not null default 'collector_ms'",
      ts_confidence: "text not null default ''",
      source_log: "text not null default ''",
      traffic_class: "text not null default 'client'",
      via_vps_bytes: "integer not null default 0",
      direct_bytes: "integer not null default 0",
      unknown_bytes: "integer not null default 0",
      bytes_up: "integer not null default 0",
      bytes_down: "integer not null default 0",
        route_source: "text not null default ''",
        route_basis: "text not null default ''",
        matched_ipset: "text not null default ''",
        intended_route: "text not null default 'Unknown'",
        route_verification: "text not null default ''",
        route_status: "text not null default 'unknown'",
        dns_link_id: "text not null default ''",
        dns_link_confidence: "text not null default ''",
        dns_status: "text not null default 'no_match'",
        dns_ts_source: "text not null default ''",
        accounting_status: "text not null default 'ok'",
      },
    normalized_dns: {
      client_ip: "text not null default ''",
      answer_ip: "text not null default ''",
      event_ts: "text not null default ''",
      event_ts_utc: "text not null default ''",
      observed_at_utc: "text not null default ''",
      display_ts_utc: "text not null default ''",
      time_precision: "text not null default 'collector_ms'",
      ts_confidence: "text not null default ''",
    },
    flow_sessions: {
      dns_qname: "text not null default ''",
      dns_answer_ip: "text not null default ''",
      sni: "text not null default ''",
      egress_ip: "text not null default ''",
      egress_asn: "text not null default ''",
      egress_country: "text not null default ''",
      event_ts_utc: "text not null default ''",
      observed_at_utc: "text not null default ''",
      display_ts_utc: "text not null default ''",
      time_precision: "text not null default 'collector_ms'",
      ts_confidence: "text not null default ''",
      traffic_class: "text not null default 'client'",
      via_vps_bytes: "integer not null default 0",
      direct_bytes: "integer not null default 0",
      unknown_bytes: "integer not null default 0",
      bytes_up: "integer not null default 0",
      bytes_down: "integer not null default 0",
        route_source: "text not null default ''",
        route_basis: "text not null default ''",
        matched_ipset: "text not null default ''",
        intended_route: "text not null default 'Unknown'",
        route_verification: "text not null default ''",
        route_status: "text not null default 'unknown'",
        dns_link_id: "text not null default ''",
        dns_link_confidence: "text not null default ''",
        dns_status: "text not null default 'no_match'",
        dns_ts_source: "text not null default ''",
        accounting_status: "text not null default 'ok'",
      },
    events: {
      event_id: "text not null default ''",
      client_ip: "text not null default ''",
      destination_ip: "text not null default ''",
      destination_port: "text not null default ''",
      dns_qname: "text not null default ''",
      dns_answer_ip: "text not null default ''",
      sni: "text not null default ''",
      outbound: "text not null default ''",
      matched_rule: "text not null default ''",
      rule_set: "text not null default ''",
      egress_ip: "text not null default ''",
      egress_asn: "text not null default ''",
      egress_country: "text not null default ''",
      source_log: "text not null default ''",
      event_ts_utc: "text not null default ''",
      observed_at_utc: "text not null default ''",
      display_ts_utc: "text not null default ''",
      time_precision: "text not null default 'collector_ms'",
    },
    route_decisions: {
      event_id: "text not null default ''",
      client_ip: "text not null default ''",
      destination_ip: "text not null default ''",
      destination_port: "text not null default ''",
      dns_qname: "text not null default ''",
      dns_answer_ip: "text not null default ''",
      sni: "text not null default ''",
      rule_set: "text not null default ''",
      egress_asn: "text not null default ''",
      egress_country: "text not null default ''",
      source_log: "text not null default ''",
      event_ts_utc: "text not null default ''",
      observed_at_utc: "text not null default ''",
      display_ts_utc: "text not null default ''",
      time_precision: "text not null default 'collector_ms'",
    },
    dns_query_log: {
      event_ts_utc: "text not null default ''",
      observed_at_utc: "text not null default ''",
      display_ts_utc: "text not null default ''",
      time_precision: "text not null default 'collector_ms'",
    },
    dns_log_5min: {
      client_ip: "text not null default ''",
    },
  })) {
      for (const [column, definition] of Object.entries(columns)) addColumnIfMissing(db, table, column, definition);
  }
  for (const [table, columns] of Object.entries({
      traffic_facts: {
        protocol: "text not null default ''",
        bytes_up: "integer not null default 0",
        bytes_down: "integer not null default 0",
        route_source: "text not null default ''",
        route_basis: "text not null default ''",
        matched_ipset: "text not null default ''",
        egress_iface: "text not null default ''",
        fwmark: "text not null default ''",
        intended_route: "text not null default 'Unknown'",
        route_verification: "text not null default ''",
        route_status: "text not null default 'unknown'",
        dns_link_id: "text not null default ''",
        dns_link_confidence: "text not null default ''",
        dns_status: "text not null default 'no_match'",
        dns_ts_source: "text not null default ''",
        accounting_status: "text not null default 'ok'",
      },
      traffic_dns_links: {
      id: "text not null default ''",
      destination_ip: "text not null default ''",
      destination_port: "text not null default ''",
      protocol: "text not null default ''",
        dns_answer_ip: "text not null default ''",
        dns_event_ts_utc: "text not null default ''",
        dns_ts_source: "text not null default ''",
        flow_event_ts_utc: "text not null default ''",
      },
      destination_enrichment: {
        traffic_class: "text not null default 'unclassified'",
        traffic_lane: "text not null default 'unknown_review'",
        dns_category: "text not null default 'unknown_domain'",
        traffic_role: "text not null default 'unknown'",
        traffic_purpose: "text not null default 'unknown'",
        decision_hint: "text not null default 'monitor'",
        human_explanation: "text not null default ''",
        source: "text not null default 'local_rules'",
        evidence_sources_json: "text not null default '[]'",
      },
      decision_candidates: {
        snapshot_id: "integer",
        client_ip: "text not null default ''",
        applied: "integer not null default 0",
      },
      ip_prefix_catalog: {
        range_start: "text not null default ''",
        range_end: "text not null default ''",
        range_start_u32: "integer not null default 0",
        range_end_u32: "integer not null default 0",
      },
      client_route_evidence_defects: {
        destination_key: "text not null default ''",
        destination_label: "text not null default ''",
        traffic_lane: "text not null default 'unknown_review'",
        dns_category: "text not null default 'unknown_domain'",
        category: "text not null default 'unknown'",
        provider: "text not null default ''",
      },
  })) {
    for (const [column, definition] of Object.entries(columns)) addColumnIfMissing(db, table, column, definition);
  }
  db.exec(`
    create unique index if not exists idx_events_event_id on events(event_id) where event_id != '';
    create unique index if not exists idx_route_decisions_event_id on route_decisions(event_id) where event_id != '';
    create index if not exists idx_flow_sessions_time on flow_sessions(last_seen desc, first_seen desc);
    create index if not exists idx_flow_sessions_filters on flow_sessions(route, channel, confidence, risk, client, destination);
    create index if not exists idx_flow_sessions_destination on flow_sessions(destination, destination_ip, destination_port);
    create index if not exists idx_dns_query_log_time on dns_query_log(event_ts desc, collected_at desc);
    create index if not exists idx_dns_query_log_filters on dns_query_log(route, catalog_status, status, client, domain);
    create index if not exists idx_device_inventory_activity on device_inventory(last_seen desc, total_bytes desc, route);
    create index if not exists idx_alarm_events_status on alarm_events(status, severity, collected_at desc);
    create index if not exists idx_normalized_flows_fast on normalized_flows(snapshot_id, collected_at desc, event_ts desc, client, route, channel, confidence);
    create index if not exists idx_normalized_flows_destination on normalized_flows(snapshot_id, destination, destination_ip, dns_qname);
    create index if not exists idx_normalized_devices_fast on normalized_devices(collected_at desc, label, device_id, channel, route);
    create index if not exists idx_ct5_msk on client_traffic_5min(bucket_msk_key desc);
    create index if not exists idx_ct5_class_msk on client_traffic_5min(traffic_class, bucket_msk_key desc);
    create index if not exists idx_ct5_client_msk on client_traffic_5min(client_key, bucket_msk_key desc);
    create index if not exists idx_cth_msk on client_traffic_hourly(hour_msk_key desc);
    create index if not exists idx_cth_class_msk on client_traffic_hourly(traffic_class, hour_msk_key desc);
    create index if not exists idx_ctd_msk on client_traffic_daily(day_msk_key desc);
    create index if not exists idx_ctw_msk on client_traffic_weekly(week_msk_key desc);
    create index if not exists idx_ctm_msk on client_traffic_monthly(month_msk_key desc);
    create index if not exists idx_cdt5_msk on client_destination_traffic_5min(bucket_msk_key desc);
    create index if not exists idx_cdth_msk on client_destination_traffic_hourly(hour_msk_key desc);
    create index if not exists idx_cdtd_msk on client_destination_traffic_daily(day_msk_key desc);
    create index if not exists idx_cdtw_msk on client_destination_traffic_weekly(week_msk_key desc);
    create index if not exists idx_cdtm_msk on client_destination_traffic_monthly(month_msk_key desc);
    create index if not exists idx_ctl_client_lane on client_traffic_by_lane(client_key, bucket_granularity, traffic_lane, bucket_start_utc desc);
    create index if not exists idx_ctl_lane_time on client_traffic_by_lane(bucket_granularity, traffic_lane, bucket_start_utc desc);
    create index if not exists idx_cdl_client_lane on client_destination_by_lane(client_key, bucket_granularity, traffic_lane, bucket_start_utc desc);
    create index if not exists idx_cdl_destination on client_destination_by_lane(destination_key, bucket_start_utc desc);
    create index if not exists idx_cred_route_evidence on client_route_evidence_defects(bucket_granularity, route_evidence, bucket_start_utc desc);
    create index if not exists idx_cred_client on client_route_evidence_defects(client_key, bucket_granularity, bucket_start_utc desc);
    create index if not exists idx_cred_destination on client_route_evidence_defects(destination_key, bucket_start_utc desc);
    create index if not exists idx_dl5_msk on dns_log_5min(bucket_msk_key desc);
    create index if not exists idx_dl5_domain on dns_log_5min(domain, bucket_msk_key desc);
    create index if not exists idx_dlh_msk on dns_log_hourly(hour_msk_key desc);
    create index if not exists idx_dld_msk on dns_log_daily(day_msk_key desc);
    create index if not exists idx_dlw_msk on dns_log_weekly(week_msk_key desc);
    create index if not exists idx_dlm_msk on dns_log_monthly(month_msk_key desc);
    create index if not exists idx_tws_window on traffic_window_snapshots(kind, window, traffic_class, computed_at_utc desc);
    create index if not exists idx_traffic_dns_links_client_dest on traffic_dns_links(client_ip, destination_ip, collected_at desc);
    create index if not exists idx_traffic_dns_links_domain_answer on traffic_dns_links(domain, dns_answer_ip, collected_at desc);
    create index if not exists idx_traffic_facts_client_dest on traffic_facts(client_ip, destination_ip, event_ts_utc desc);
    create index if not exists idx_destination_enrichment_class on destination_enrichment(traffic_class, category, last_seen desc);
    create index if not exists idx_ip_enrichment_cache_status on ip_enrichment_cache(lookup_status, updated_at_utc desc);
    create index if not exists idx_ip_enrichment_cache_prefix on ip_enrichment_cache(prefix_cidr);
    create index if not exists idx_ip_prefix_catalog_v4_range on ip_prefix_catalog(range_start_u32, range_end_u32);
    create index if not exists idx_decision_candidates_status on decision_candidates(status, updated_at_utc desc);
    create index if not exists idx_decision_candidates_destination on decision_candidates(destination_key, client_key, updated_at_utc desc);
    create index if not exists idx_filter_rules_match on filter_rules(scope, match_kind, match_value);
    create index if not exists idx_filter_rules_enabled on filter_rules(enabled, priority);
    create index if not exists idx_filter_decisions_obs on filter_decisions(observed_at_utc desc);
    create index if not exists idx_filter_decisions_rule on filter_decisions(rule_id, observed_at_utc desc);
    create index if not exists idx_filter_decisions_client on filter_decisions(client_key, observed_at_utc desc);
  `);

  for (const version of [6, 7, 8, 9, 10, 12, 13, 14, 15, MIGRATION_VERSION]) {
    db.prepare("insert or ignore into schema_migrations(version, applied_at) values (?, ?)").run(
      version,
      new Date().toISOString()
    );
  }
}

export function rebuildHourlyAggregates(db) {
  db.prepare("delete from hourly_traffic").run();
  const preparedRows = db
    .prepare(
      `select hour_start_utc as hour_key,
              coalesce(nullif(route, ''), 'Unknown') as route,
              sum(bytes) as bytes,
              sum(flows) as flows,
              count(distinct nullif(client_key, '')) as clients
         from client_traffic_hourly
        group by hour_key, route`
    )
    .all();
  if (preparedRows.length > 0) {
    const insert = db.prepare(
      `insert into hourly_traffic(hour_key, route, bytes, flows, clients, updated_at)
       values (?, ?, ?, ?, ?, ?)`
    );
    const now = new Date().toISOString();
    for (const row of preparedRows) {
      insert.run(row.hour_key, row.route || "Unknown", number(row.bytes), number(row.flows), number(row.clients), now);
    }
    return;
  }
  const rows = db
    .prepare(
      `select substr(collected_at, 1, 13) || ':00:00Z' as hour_key,
              coalesce(nullif(route, ''), 'Unknown') as route,
              sum(bytes) as bytes,
              count(*) as flows,
              count(distinct client) as clients
         from normalized_flows
        group by hour_key, route`
    )
    .all();
  const insert = db.prepare(
    `insert into hourly_traffic(hour_key, route, bytes, flows, clients, updated_at)
     values (?, ?, ?, ?, ?, ?)`
  );
  const now = new Date().toISOString();
  for (const row of rows) {
    insert.run(row.hour_key, row.route || "Unknown", number(row.bytes), number(row.flows), number(row.clients), now);
  }
}

function flowRollupKey(row) {
  const accountingBucket = row.raw?.accounting_bucket || row.raw?.device_counter || row.accounting_bucket;
  return [
    accountingBucket ? "" : row.raw?.flow_group_key,
    accountingBucket ? "bucket" : "",
    row.channel,
    accountingBucket ? "" : row.raw?.profile,
    accountingBucket ? row.client_key : (row.raw?.client || row.client || row.client_key),
    accountingBucket ? "" : row.destination,
    accountingBucket ? "" : row.route,
    row.confidence,
    row.traffic_class,
  ].filter(Boolean).join("|").toLowerCase();
}

function routeFromAggregate(row) {
  const vps = number(row.via_vps_bytes);
  const direct = number(row.direct_bytes);
  const unknown = number(row.unknown_bytes);
  const count = [vps > 0, direct > 0, unknown > 0].filter(Boolean).length;
  if (count > 1) return "Mixed";
  if (vps > 0) return "VPS";
  if (direct > 0) return "Direct";
  if (unknown > 0) return "Unknown";
  return text(row.route, "Unknown");
}

function bucketRangeEndUtc(endUtc, granularity) {
  const bucket = bucketStartUtc(endUtc, granularity);
  if (Date.parse(bucket) === Date.parse(endUtc)) return endUtc;
  if (granularity === "week") return isoPlusMs(bucket, 7 * 86400000);
  if (granularity === "month") {
    const [year, month] = toMskKey(bucket, "month").split("-").map((part) => Number(part));
    const nextMonth = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
    return toUtcIsoFromMskKey(nextMonth, "month");
  }
  const ms = granularity === "day" ? 86400000 : granularity === "5min" ? 300000 : 3600000;
  return isoPlusMs(bucket, ms);
}

function isoMinusHours(iso, hours) {
  return new Date(Date.parse(iso) - hours * 3600000).toISOString();
}

function aggregateDirtyStart(db, now) {
  const monthStart = mskWindowBounds("month", now).startUtc;
  const hasAggregates = db.prepare("select 1 from client_traffic_5min limit 1").get();
  if (!hasAggregates) return monthStart;
  const todayStart = mskWindowBounds("today", now).startUtc;
  const hours = Math.max(1, number(process.env.GHOSTROUTE_ROLLUP_REBUILD_HOURS || 6));
  const rollingStart = isoMinusHours(now, hours);
  return Date.parse(rollingStart) > Date.parse(todayStart) ? rollingStart : todayStart;
}

function flowFactsFromNormalized(db, startUtc, endUtc) {
  const registry = loadDeviceAttributions();
  const networkHints = buildInventoryNetworkHints(db, registry);
  const hasTrafficFacts = Boolean(
    db.prepare("select 1 from traffic_facts where collected_at >= ? and collected_at < ? limit 1").get(startUtc, endUtc)
  );
  let sourceRows = db
    .prepare(
      `select rowid, *
         from normalized_flows
        where collected_at >= ? and collected_at < ?
          ${hasTrafficFacts ? "and snapshot_type = 'traffic_facts'" : ""}
        order by collected_at asc, rowid asc`
    )
    .all(startUtc, endUtc);
  if (hasTrafficFacts) {
    const uniqueRows = new Map();
    for (const row of sourceRows) {
      const raw = parseJson(row.raw_json, {});
      const stableKey = text(
        raw.fact_id ||
          [
            row.snapshot_type,
            raw.allocation_basis || row.source_log || "",
            row.display_ts_utc || row.event_ts_utc || row.event_ts || row.collected_at,
            row.client_ip,
            row.destination_ip || row.destination,
            row.destination_port,
            row.route,
            row.bytes,
          ].join("|")
      );
      uniqueRows.set(stableKey, row);
    }
    sourceRows = Array.from(uniqueRows.values()).sort((a, b) => {
      const collected = a.collected_at.localeCompare(b.collected_at);
      return collected || a.rowid - b.rowid;
    });
  }
  if (sourceRows.length === 0) {
    sourceRows = db
      .prepare(
        `select rowid, snapshot_id, 'traffic' as snapshot_type, collected_at, client, client_ip, device_key, channel,
                destination, destination_ip, destination_port, route, confidence, bytes, connections,
                protocol, dns_qname, dns_answer_ip, sni, outbound, matched_rule, policy as rule_set,
                egress_ip, egress_asn, egress_country, last_seen as event_ts, ts_confidence,
                source_kind as source_log, traffic_class, via_vps_bytes, direct_bytes, unknown_bytes,
                evidence_json as raw_json
           from flow_sessions
          where collected_at >= ? and collected_at < ?
          order by collected_at asc, rowid asc`
      )
      .all(startUtc, endUtc);
  }
  const rows = sourceRows.map((row) => {
      const raw = parseJson(row.raw_json, {});
      if (raw.accounting_bucket) return null;
      const trafficClass = text(row.traffic_class || flowTrafficClass({ ...raw, ...row }), "client");
      const split = signedByteSplit({ ...raw, ...row }, row.route, number(row.bytes));
      const eligibility = trafficAggregateEligibility(row, raw, split);
      if (!eligibility.eligible) return null;
      const destination = text(row.destination || row.dns_qname || row.sni || row.destination_ip || raw.destination || raw.domain, "unknown destination");
      const clientKey = text(raw.client_key || row.device_key || raw.device_key || raw.profile || raw.client || row.client || row.client_ip || "Unknown client");
      const resolved = resolveOperatorClient({
        ...row,
        raw,
        client_key: clientKey,
        client_label: raw.client_label || row.client || clientKey,
        device_key: row.device_key || raw.device_key || raw.device_id || "",
        client_ip: row.client_ip || raw.client_ip || "",
      }, registry, networkHints);
      return {
        rowid: row.rowid,
        snapshot_id: row.snapshot_id,
        collected_at: parseSourceTimestamp(row.collected_at),
        last_seen: parseSourceTimestamp(row.event_ts || row.collected_at),
        client_key: resolved.client_key,
        client_label: resolved.client_label,
        channel: resolved.channel || text(row.channel || inferChannel(raw), "Unknown"),
        destination,
        destination_key: destination,
        route: text(row.route || routeFromTraffic(raw), "Unknown"),
        intended_route: text(row.intended_route || raw.intended_route || row.route || routeFromTraffic(raw), "Unknown"),
        route_verification: text(row.route_verification || raw.route_verification || "unknown"),
        route_status: text(row.route_status || raw.route_status || "unknown"),
        matched_ipset: text(row.matched_ipset || raw.matched_ipset || ""),
        confidence: confidence(row.confidence),
        traffic_class: trafficClass,
        bytes: split.totalBytes,
        via_vps_bytes: split.viaVpsBytes,
        direct_bytes: split.directBytes,
        unknown_bytes: split.unknownBytes,
        connections: number(row.connections),
        accounting_bucket: Boolean(raw.accounting_bucket),
        raw,
      };
    }).filter(Boolean);
  const grouped = new Map();
  for (const row of rows) {
    const key = flowRollupKey(row);
    const list = grouped.get(key) || [];
    list.push(row);
    grouped.set(key, list);
  }
  const facts = [];
  for (const list of grouped.values()) {
    const ordered = list.sort((a, b) => Date.parse(a.collected_at) - Date.parse(b.collected_at));
    let previous = null;
    for (const sample of ordered) {
      const first = !previous;
      const bytes = first ? sample.bytes : Math.max(0, sample.bytes - previous.bytes);
      const viaVps = first ? sample.via_vps_bytes : Math.max(0, sample.via_vps_bytes - previous.via_vps_bytes);
      const direct = first ? sample.direct_bytes : Math.max(0, sample.direct_bytes - previous.direct_bytes);
      let unknown = first ? sample.unknown_bytes : Math.max(0, sample.unknown_bytes - previous.unknown_bytes);
      previous = sample;
      if (bytes !== viaVps + direct + unknown) unknown = bytes - viaVps - direct;
      if (bytes < 0 || viaVps < 0 || direct < 0 || unknown < 0 || bytes !== viaVps + direct + unknown) continue;
      if (bytes <= 0 && viaVps <= 0 && direct <= 0 && unknown <= 0 && sample.connections <= 0) continue;
      facts.push({
        ...sample,
        bytes,
        total_bytes: bytes,
        via_vps_bytes: viaVps,
        direct_bytes: direct,
        unknown_bytes: unknown,
        route: routeFromAggregate({ ...sample, via_vps_bytes: viaVps, direct_bytes: direct, unknown_bytes: unknown }),
      });
    }
  }
  return facts;
}

function addToGroup(map, key, seed, row) {
  const current = map.get(key) || { ...seed, bytes: 0, total_bytes: 0, via_vps_bytes: 0, direct_bytes: 0, unknown_bytes: 0, observed_bytes: 0, attributed_bytes: 0, flows: 0, connections: 0 };
  const rowTotal = aggregateTotalBytes(row);
  const split = signedByteSplit(row, row?.route, rowTotal);
  if (!trafficAggregateEligibility(row, row?.raw || row, split).eligible) return current;
  current.bytes += rowTotal;
  current.total_bytes += rowTotal;
  current.via_vps_bytes += number(row.via_vps_bytes);
  current.direct_bytes += number(row.direct_bytes);
  current.unknown_bytes += number(row.unknown_bytes);
  current.observed_bytes += number(row.observed_bytes ?? (row.traffic_class === "client" ? rowTotal : 0));
  current.attributed_bytes += number(row.attributed_bytes ?? (row.accounting_bucket ? 0 : rowTotal));
  current.flows += number(row.flows || 1);
  current.connections += number(row.connections);
  current.route = routeFromAggregate(current);
  map.set(key, current);
  return current;
}

const trafficPeriodMeta = {
  week: { table: "client_traffic_weekly", keyColumn: "week_msk_key", timeColumn: "week_start_utc", granularity: "week" },
  month: { table: "client_traffic_monthly", keyColumn: "month_msk_key", timeColumn: "month_start_utc", granularity: "month" },
};

const destinationRollupMeta = {
  hour: {
    sourceTable: "client_destination_traffic_5min",
    sourceKey: "bucket_msk_key",
    sourceTime: "bucket_start_utc",
    table: "client_destination_traffic_hourly",
    keyColumn: "hour_msk_key",
    timeColumn: "hour_start_utc",
    granularity: "hour",
  },
  day: {
    sourceTable: "client_destination_traffic_hourly",
    sourceKey: "hour_msk_key",
    sourceTime: "hour_start_utc",
    table: "client_destination_traffic_daily",
    keyColumn: "day_msk_key",
    timeColumn: "day_start_utc",
    granularity: "day",
  },
  week: {
    sourceTable: "client_destination_traffic_daily",
    sourceKey: "day_msk_key",
    sourceTime: "day_start_utc",
    table: "client_destination_traffic_weekly",
    keyColumn: "week_msk_key",
    timeColumn: "week_start_utc",
    granularity: "week",
  },
  month: {
    sourceTable: "client_destination_traffic_daily",
    sourceKey: "day_msk_key",
    sourceTime: "day_start_utc",
    table: "client_destination_traffic_monthly",
    keyColumn: "month_msk_key",
    timeColumn: "month_start_utc",
    granularity: "month",
  },
};

function rollupTotalTrafficPeriod(db, period, startUtc, endUtc, now) {
  const meta = trafficPeriodMeta[period];
  if (!meta) return;
  const sourceRows = db.prepare(`
    select * from client_traffic_daily
     where day_start_utc >= ?
       and day_start_utc < ?
  `).all(startUtc, endUtc);
  const grouped = new Map();
  for (const row of sourceRows) {
    const windowStart = bucketStartUtc(row.day_start_utc, meta.granularity);
    const windowKey = toMskKey(windowStart, meta.granularity);
    addToGroup(grouped, [windowKey, row.client_key, row.channel, row.route, row.confidence, row.traffic_class].join("|"), {
      windowKey,
      windowStart,
      client_key: row.client_key,
      client_label: row.client_label,
      channel: row.channel,
      route: row.route,
      confidence: row.confidence,
      traffic_class: row.traffic_class,
    }, row);
  }
  const insert = db.prepare(`
    insert into ${meta.table}(${meta.keyColumn}, ${meta.timeColumn}, client_key, client_label, channel, route,
      confidence, traffic_class, bytes, via_vps_bytes, direct_bytes, unknown_bytes, observed_bytes,
      attributed_bytes, flows, clients, updated_at_utc)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of grouped.values()) {
    insert.run(row.windowKey, row.windowStart, row.client_key, row.client_label, row.channel, row.route, row.confidence, row.traffic_class, number(row.bytes), number(row.via_vps_bytes), number(row.direct_bytes), number(row.unknown_bytes), number(row.observed_bytes), number(row.attributed_bytes), number(row.flows), 1, now);
  }
}

function rollupDestinationTraffic(db, period, startUtc, endUtc, now) {
  const meta = destinationRollupMeta[period];
  if (!meta) return;
  const sourceRows = db.prepare(`
    select * from ${meta.sourceTable}
     where ${meta.sourceTime} >= ?
       and ${meta.sourceTime} < ?
  `).all(startUtc, endUtc);
  const grouped = new Map();
  for (const row of sourceRows) {
    const windowStart = bucketStartUtc(row[meta.sourceTime], meta.granularity);
    const windowKey = toMskKey(windowStart, meta.granularity);
    addToGroup(grouped, [windowKey, row.client_key, row.channel, row.route, row.confidence, row.traffic_class, row.destination_key].join("|"), {
      windowKey,
      windowStart,
      client_key: row.client_key,
      client_label: row.client_label,
      channel: row.channel,
      route: row.route,
      confidence: row.confidence,
      traffic_class: row.traffic_class,
      destination_key: row.destination_key,
    }, row);
  }
  const insert = db.prepare(`
    insert into ${meta.table}(${meta.keyColumn}, ${meta.timeColumn}, client_key, client_label, channel, route,
      confidence, traffic_class, destination_key, bytes, via_vps_bytes, direct_bytes, unknown_bytes, observed_bytes,
      attributed_bytes, flows, clients, updated_at_utc)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of grouped.values()) {
    insert.run(row.windowKey, row.windowStart, row.client_key, row.client_label, row.channel, row.route, row.confidence, row.traffic_class, row.destination_key, number(row.bytes), number(row.via_vps_bytes), number(row.direct_bytes), number(row.unknown_bytes), number(row.observed_bytes), number(row.attributed_bytes), number(row.flows), 1, now);
  }
}

function rebuildTrafficAggregates(db, facts, now, dirtyStartUtc, dirtyEndUtc = now, sourceVersion = "") {
  const dirty5Start = bucketStartUtc(dirtyStartUtc, "5min");
  const dirtyHourStart = bucketStartUtc(dirtyStartUtc, "hour");
  const dirtyHourEnd = bucketRangeEndUtc(dirtyEndUtc, "hour");
  const dirtyDayStart = bucketStartUtc(dirtyStartUtc, "day");
  const dirtyDayEnd = bucketRangeEndUtc(dirtyEndUtc, "day");
  const dirtyWeekStart = bucketStartUtc(dirtyStartUtc, "week");
  const dirtyWeekEnd = bucketRangeEndUtc(dirtyEndUtc, "week");
  const dirtyMonthStart = bucketStartUtc(dirtyStartUtc, "month");
  const dirtyMonthEnd = bucketRangeEndUtc(dirtyEndUtc, "month");
  db.prepare("delete from client_traffic_5min where bucket_start_utc >= ? and bucket_start_utc < ?").run(dirty5Start, dirtyEndUtc);
  db.prepare("delete from client_destination_traffic_5min where bucket_start_utc >= ? and bucket_start_utc < ?").run(dirty5Start, dirtyEndUtc);
  db.prepare("delete from client_traffic_hourly where hour_start_utc >= ? and hour_start_utc < ?").run(dirtyHourStart, dirtyHourEnd);
  db.prepare("delete from client_destination_traffic_hourly where hour_start_utc >= ? and hour_start_utc < ?").run(dirtyHourStart, dirtyHourEnd);
  db.prepare("delete from client_traffic_daily where day_start_utc >= ? and day_start_utc < ?").run(dirtyDayStart, dirtyDayEnd);
  db.prepare("delete from client_destination_traffic_daily where day_start_utc >= ? and day_start_utc < ?").run(dirtyDayStart, dirtyDayEnd);
  db.prepare("delete from client_traffic_weekly where week_start_utc >= ? and week_start_utc < ?").run(dirtyWeekStart, dirtyWeekEnd);
  db.prepare("delete from client_destination_traffic_weekly where week_start_utc >= ? and week_start_utc < ?").run(dirtyWeekStart, dirtyWeekEnd);
  db.prepare("delete from client_traffic_monthly where month_start_utc >= ? and month_start_utc < ?").run(dirtyMonthStart, dirtyMonthEnd);
  db.prepare("delete from client_destination_traffic_monthly where month_start_utc >= ? and month_start_utc < ?").run(dirtyMonthStart, dirtyMonthEnd);

  const insertTotal5 = db.prepare(`
    insert into client_traffic_5min(bucket_start_utc, bucket_msk_key, client_key, client_label, channel, route,
      confidence, traffic_class, bytes, via_vps_bytes, direct_bytes, unknown_bytes, flows,
      connections, observed_bytes, attributed_bytes, updated_at_utc)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertDetail5 = db.prepare(`
    insert into client_destination_traffic_5min(bucket_start_utc, bucket_msk_key, client_key, client_label, channel, route,
      confidence, traffic_class, destination_key, bytes, via_vps_bytes, direct_bytes, unknown_bytes, flows,
      connections, observed_bytes, attributed_bytes, updated_at_utc)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const totalBuckets = new Map();
  const detailBuckets = new Map();
  const routerTotals = db.prepare(`
    select *
      from router_traffic_rollups
     where kind = 'total'
       and layer = '5min'
       and window_start_utc >= ?
       and window_start_utc < ?
  `).all(dirty5Start, dirtyEndUtc);
  const useRouterTotals = routerTotals.length > 0 && facts.length === 0;

  if (useRouterTotals) {
    for (const row of routerTotals) {
      const bucket = bucketStartUtc(row.window_start_utc, "5min");
      const totalKey = [bucket, row.client_key, row.channel, row.route, "exact", row.traffic_class].join("|");
      addToGroup(totalBuckets, totalKey, {
        bucket_start_utc: bucket,
        bucket_msk_key: toMskKey(bucket, "5min"),
        client_key: row.client_key,
        client_label: row.client_label,
        channel: row.channel,
        route: row.route,
        confidence: "exact",
        traffic_class: row.traffic_class,
        observed_bytes: 0,
        attributed_bytes: 0,
      }, {
        ...row,
        total_bytes: number(row.bytes),
        confidence: "exact",
        observed_bytes: number(row.bytes),
        attributed_bytes: number(row.bytes),
      });
    }
  }

  for (const row of facts) {
    const bucket = bucketStartUtc(row.collected_at, "5min");
    if (!useRouterTotals) {
      const totalKey = [bucket, row.client_key, row.channel, row.route, row.confidence, row.traffic_class].join("|");
      addToGroup(totalBuckets, totalKey, {
        bucket_start_utc: bucket,
        bucket_msk_key: toMskKey(bucket, "5min"),
        client_key: row.client_key,
        client_label: row.client_label,
        channel: row.channel,
        route: row.route,
        confidence: row.confidence,
        traffic_class: row.traffic_class,
        observed_bytes: 0,
        attributed_bytes: 0,
      }, row);
    }
    const destination = text(row.destination_key || "", "");
    if (destination) {
      const detailKey = [bucket, row.client_key, row.channel, row.route, row.confidence, row.traffic_class, destination].join("|");
      addToGroup(detailBuckets, detailKey, {
        bucket_start_utc: bucket,
        bucket_msk_key: toMskKey(bucket, "5min"),
        client_key: row.client_key,
        client_label: row.client_label,
        channel: row.channel,
        route: row.route,
        confidence: row.confidence,
        traffic_class: row.traffic_class,
        destination_key: destination,
        observed_bytes: 0,
        attributed_bytes: 0,
      }, row);
    }
  }
  for (const row of totalBuckets.values()) {
    insertTotal5.run(row.bucket_start_utc, row.bucket_msk_key, row.client_key, row.client_label, row.channel, row.route, row.confidence, row.traffic_class, row.bytes, row.via_vps_bytes, row.direct_bytes, row.unknown_bytes, row.flows, row.connections, row.observed_bytes, row.attributed_bytes, now);
  }
  for (const row of detailBuckets.values()) {
    insertDetail5.run(row.bucket_start_utc, row.bucket_msk_key, row.client_key, row.client_label, row.channel, row.route, row.confidence, row.traffic_class, row.destination_key, row.bytes, row.via_vps_bytes, row.direct_bytes, row.unknown_bytes, row.flows, row.connections, row.observed_bytes, row.attributed_bytes, now);
  }

  const insertTotalHour = db.prepare(`
    insert into client_traffic_hourly(hour_msk_key, hour_start_utc, client_key, client_label, channel, route,
      confidence, traffic_class, bytes, via_vps_bytes, direct_bytes, unknown_bytes, observed_bytes,
      attributed_bytes, flows, clients, updated_at_utc)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const hourly = db.prepare(`
    select substr(bucket_msk_key, 1, 13) as hour_msk_key,
           min(bucket_start_utc) as hour_start_utc,
           client_key, max(client_label) as client_label, channel, route, confidence, traffic_class,
           sum(bytes) as bytes, sum(via_vps_bytes) as via_vps_bytes, sum(direct_bytes) as direct_bytes,
           sum(unknown_bytes) as unknown_bytes, sum(observed_bytes) as observed_bytes,
           sum(attributed_bytes) as attributed_bytes, sum(flows) as flows,
           count(distinct client_key) as clients
      from client_traffic_5min
     where bucket_start_utc >= ?
       and bucket_start_utc < ?
     group by hour_msk_key, client_key, channel, route, confidence, traffic_class
  `).all(dirtyHourStart, dirtyHourEnd);
  for (const row of hourly) {
    insertTotalHour.run(row.hour_msk_key, bucketStartUtc(row.hour_start_utc, "hour"), row.client_key, row.client_label, row.channel, row.route, row.confidence, row.traffic_class, number(row.bytes), number(row.via_vps_bytes), number(row.direct_bytes), number(row.unknown_bytes), number(row.observed_bytes), number(row.attributed_bytes), number(row.flows), number(row.clients), now);
  }

  rollupDestinationTraffic(db, "hour", dirtyHourStart, dirtyHourEnd, now);

  const insertTotalDay = db.prepare(`
    insert into client_traffic_daily(day_msk_key, day_start_utc, client_key, client_label, channel, route,
      confidence, traffic_class, bytes, via_vps_bytes, direct_bytes, unknown_bytes, observed_bytes,
      attributed_bytes, flows, clients, updated_at_utc)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const daily = db.prepare(`
    select substr(hour_msk_key, 1, 10) as day_msk_key,
           min(hour_start_utc) as day_start_utc,
           client_key, max(client_label) as client_label, channel, route, confidence, traffic_class,
           sum(bytes) as bytes, sum(via_vps_bytes) as via_vps_bytes, sum(direct_bytes) as direct_bytes,
           sum(unknown_bytes) as unknown_bytes, sum(observed_bytes) as observed_bytes,
           sum(attributed_bytes) as attributed_bytes, sum(flows) as flows,
           count(distinct client_key) as clients
      from client_traffic_hourly
     where hour_start_utc >= ?
       and hour_start_utc < ?
     group by day_msk_key, client_key, channel, route, confidence, traffic_class
  `).all(dirtyDayStart, dirtyDayEnd);
  for (const row of daily) {
    insertTotalDay.run(row.day_msk_key, bucketStartUtc(row.day_start_utc, "day"), row.client_key, row.client_label, row.channel, row.route, row.confidence, row.traffic_class, number(row.bytes), number(row.via_vps_bytes), number(row.direct_bytes), number(row.unknown_bytes), number(row.observed_bytes), number(row.attributed_bytes), number(row.flows), number(row.clients), now);
  }

  rollupDestinationTraffic(db, "day", dirtyDayStart, dirtyDayEnd, now);
  rollupTotalTrafficPeriod(db, "week", dirtyWeekStart, dirtyWeekEnd, now);
  rollupDestinationTraffic(db, "week", dirtyWeekStart, dirtyWeekEnd, now);
  rollupTotalTrafficPeriod(db, "month", dirtyMonthStart, dirtyMonthEnd, now);
  rollupDestinationTraffic(db, "month", dirtyMonthStart, dirtyMonthEnd, now);
  rebuildClientTrafficLaneReadModels(db, {
    dirtyStartUtc,
    dirtyEndUtc,
    updatedAt: now,
    sourceVersion,
    facts,
  });
}

function dnsRowsForAggregateRange(db, dirtyStartUtc, dirtyEndUtc) {
  const normalized = db.prepare("select rowid, * from normalized_dns where collected_at >= ? and collected_at < ? order by collected_at asc, rowid asc").all(dirtyStartUtc, dirtyEndUtc);
  if (normalized.length) return normalized;
  try {
    return db.prepare(`
      select rowid, * from dns_query_log
       where collected_at >= ?
         and collected_at < ?
       order by event_ts asc, rowid asc
    `).all(dirtyStartUtc, dirtyEndUtc);
  } catch {
    return [];
  }
}

function rebuildDnsAggregates(db, now, dirtyStartUtc, dirtyEndUtc = now) {
  const dirty5Start = bucketStartUtc(dirtyStartUtc, "5min");
  const dirtyHourStart = bucketStartUtc(dirtyStartUtc, "hour");
  const dirtyHourEnd = bucketRangeEndUtc(dirtyEndUtc, "hour");
  const dirtyDayStart = bucketStartUtc(dirtyStartUtc, "day");
  const dirtyDayEnd = bucketRangeEndUtc(dirtyEndUtc, "day");
  const dirtyWeekStart = bucketStartUtc(dirtyStartUtc, "week");
  const dirtyWeekEnd = bucketRangeEndUtc(dirtyEndUtc, "week");
  const dirtyMonthStart = bucketStartUtc(dirtyStartUtc, "month");
  const dirtyMonthEnd = bucketRangeEndUtc(dirtyEndUtc, "month");
  db.prepare("delete from dns_log_5min where bucket_start_utc >= ? and bucket_start_utc < ?").run(dirty5Start, dirtyEndUtc);
  db.prepare("delete from dns_log_hourly where hour_start_utc >= ? and hour_start_utc < ?").run(dirtyHourStart, dirtyHourEnd);
  db.prepare("delete from dns_log_daily where day_start_utc >= ? and day_start_utc < ?").run(dirtyDayStart, dirtyDayEnd);
  db.prepare("delete from dns_log_weekly where week_start_utc >= ? and week_start_utc < ?").run(dirtyWeekStart, dirtyWeekEnd);
  db.prepare("delete from dns_log_monthly where month_start_utc >= ? and month_start_utc < ?").run(dirtyMonthStart, dirtyMonthEnd);
  const catalogRows = db.prepare("select rowid, * from normalized_catalog order by collected_at desc, rowid desc").all();
  const catalogMatch = buildCatalogMatcher(catalogRows);
  const rows = dnsRowsForAggregateRange(db, dirtyStartUtc, dirtyEndUtc);
  const grouped = new Map();
  for (const row of rows) {
    const bucket = bucketStartUtc(row.event_ts || row.collected_at, "5min");
    const match = catalogMatchFor(row.domain, catalogMatch);
    const catalogStatusValue = text(row.catalog_status) || catalogStatus(match);
    const route = text(row.route) || routeForDns(match, row);
    const raw = parseJson(row.raw_json, {});
    const clientIp = text(row.client_ip || row.ip || raw.client_ip || raw.ip || "");
    const rawClient = text(row.client || "");
    const clientKey = rawClient.toLowerCase().startsWith("unattributed") && clientIp ? clientIp : text(rawClient || clientIp);
    const key = [bucket, clientKey, clientIp, row.domain || "", row.qtype || "", catalogStatusValue, route].join("|");
    const current = grouped.get(key) || {
      bucket_start_utc: bucket,
      bucket_msk_key: toMskKey(bucket, "5min"),
      client_key: clientKey,
      client_ip: clientIp,
      domain: text(row.domain),
      qtype: text(row.qtype),
      catalog_status: catalogStatusValue,
      route,
      confidence: confidence(row.confidence, "dns-interest"),
      query_count: 0,
    };
    current.query_count += number(row.count || 1);
    grouped.set(key, current);
  }
  const insert = db.prepare(`
    insert into dns_log_5min(bucket_start_utc, bucket_msk_key, client_key, client_ip, domain, qtype, catalog_status,
      route, confidence, query_count, updated_at_utc)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of grouped.values()) {
    insert.run(row.bucket_start_utc, row.bucket_msk_key, row.client_key, row.client_ip, row.domain, row.qtype, row.catalog_status, row.route, row.confidence, row.query_count, now);
  }
  rollupDnsLayer(db, "hour", dirtyHourStart, dirtyHourEnd, now);
  rollupDnsLayer(db, "day", dirtyDayStart, dirtyDayEnd, now);
  rollupDnsLayer(db, "week", dirtyWeekStart, dirtyWeekEnd, now);
  rollupDnsLayer(db, "month", dirtyMonthStart, dirtyMonthEnd, now);
}

const dnsRollupMeta = {
  hour: { sourceTable: "dns_log_5min", sourceTime: "bucket_start_utc", table: "dns_log_hourly", keyColumn: "hour_msk_key", timeColumn: "hour_start_utc", granularity: "hour" },
  day: { sourceTable: "dns_log_hourly", sourceTime: "hour_start_utc", table: "dns_log_daily", keyColumn: "day_msk_key", timeColumn: "day_start_utc", granularity: "day" },
  week: { sourceTable: "dns_log_daily", sourceTime: "day_start_utc", table: "dns_log_weekly", keyColumn: "week_msk_key", timeColumn: "week_start_utc", granularity: "week" },
  month: { sourceTable: "dns_log_daily", sourceTime: "day_start_utc", table: "dns_log_monthly", keyColumn: "month_msk_key", timeColumn: "month_start_utc", granularity: "month" },
};

function rollupDnsLayer(db, period, startUtc, endUtc, now) {
  const meta = dnsRollupMeta[period];
  if (!meta) return;
  const rows = db.prepare(`
    select * from ${meta.sourceTable}
     where ${meta.sourceTime} >= ?
       and ${meta.sourceTime} < ?
  `).all(startUtc, endUtc);
  const grouped = new Map();
  for (const row of rows) {
    const windowStart = bucketStartUtc(row[meta.sourceTime], meta.granularity);
    const windowKey = toMskKey(windowStart, meta.granularity);
    const key = [windowKey, row.client_key, row.client_ip, row.domain, row.qtype, row.catalog_status, row.route, row.confidence].join("|");
    const current = grouped.get(key) || {
      windowKey,
      windowStart,
      client_key: row.client_key,
      client_ip: row.client_ip,
      domain: row.domain,
      qtype: row.qtype,
      catalog_status: row.catalog_status,
      route: row.route,
      confidence: row.confidence,
      query_count: 0,
    };
    current.query_count += number(row.query_count);
    grouped.set(key, current);
  }
  const insert = db.prepare(`
    insert into ${meta.table}(${meta.keyColumn}, ${meta.timeColumn}, client_key, client_ip, domain, qtype,
      catalog_status, route, confidence, query_count, updated_at_utc)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of grouped.values()) {
    insert.run(row.windowKey, row.windowStart, row.client_key, row.client_ip, row.domain, row.qtype, row.catalog_status, row.route, row.confidence, row.query_count, now);
  }
}

function factsForWindow(facts, window, now) {
  const bounds = mskWindowBounds(window, now);
  const start = Date.parse(bounds.startUtc);
  const end = Date.parse(bounds.endUtc);
  return facts.filter((row) => {
    const ts = Date.parse(row.collected_at || row.last_seen || "");
    return Number.isFinite(ts) && ts >= start && ts <= end;
  });
}

function totalsForFacts(facts) {
  return facts.reduce((acc, row) => {
    acc.observedBytes += number(row.bytes);
    acc.viaVpsBytes += number(row.via_vps_bytes);
    acc.directBytes += number(row.direct_bytes);
    acc.unknownBytes += number(row.unknown_bytes);
    return acc;
  }, { observedBytes: 0, viaVpsBytes: 0, directBytes: 0, unknownBytes: 0 });
}

function isoPlusMs(iso, ms) {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function maxIso(...values) {
  return values.filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0] || "";
}

function windowAggregateSegments(window, now) {
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
  if (Date.parse(hourlyStart) < Date.parse(freshStart)) {
    segments.push({ layer: "hourly", start: hourlyStart, end: freshStart });
  }
  if (Date.parse(freshStart) < Date.parse(endExclusive)) {
    segments.push({ layer: "5min", start: freshStart, end: endExclusive });
  }
  return segments;
}

function aggregateLayerMeta(layer, detail = false) {
  const prefix = detail ? "client_destination_traffic" : "client_traffic";
  if (layer === "monthly") return { table: `${prefix}_monthly`, timeColumn: "month_start_utc" };
  if (layer === "weekly") return { table: `${prefix}_weekly`, timeColumn: "week_start_utc" };
  if (layer === "daily") return { table: `${prefix}_daily`, timeColumn: "day_start_utc" };
  if (layer === "hourly") return { table: `${prefix}_hourly`, timeColumn: "hour_start_utc" };
  return { table: `${prefix}_5min`, timeColumn: "bucket_start_utc" };
}

function aggregateRowsFromLayer(db, layer, startUtc, endUtc, detail = false) {
  if (Date.parse(startUtc) >= Date.parse(endUtc)) return [];
  const { table, timeColumn } = aggregateLayerMeta(layer, detail);
  return db.prepare(`
    select client_key,
           max(client_label) as client_label,
           channel,
           route,
           confidence,
           traffic_class,
           ${detail ? "destination_key" : "'' as destination_key"},
           sum(bytes) as bytes,
           sum(bytes) as total_bytes,
           sum(via_vps_bytes) as via_vps_bytes,
           sum(direct_bytes) as direct_bytes,
           sum(unknown_bytes) as unknown_bytes,
           sum(flows) as flows,
           ${layer === "5min" ? "sum(connections)" : "0"} as connections,
           sum(observed_bytes) as observed_bytes,
           sum(attributed_bytes) as attributed_bytes,
           max(${timeColumn}) as collected_at,
           max(${timeColumn}) as last_seen,
           ${detail ? "case when sum(attributed_bytes) <= 0 or destination_key = '' or destination_key = 'unknown destination' then 1 else 0 end" : "1"} as accounting_bucket,
           '${layer}' as aggregate_layer
      from ${table}
     where ${timeColumn} >= ?
       and ${timeColumn} < ?
     group by client_key, channel, route, confidence, traffic_class${detail ? ", destination_key" : ""}
  `).all(startUtc, endUtc);
}

function aggregateRowsForWindow(db, window, now) {
  const segments = windowAggregateSegments(window, now);
  const rows = [
    ...segments.flatMap((segment) => aggregateRowsFromLayer(db, segment.layer, segment.start, segment.end, true)),
    ...segments.flatMap((segment) => aggregateRowsFromLayer(db, segment.layer, segment.start, segment.end, false)),
  ];
  return groupRows(
    rows,
    (row) => [row.client_key, row.channel, row.route, row.confidence, row.traffic_class, row.destination_key].join("|"),
    (row) => ({
      client_key: row.client_key,
      client_label: row.client_label,
      channel: row.channel,
      route: row.route,
      confidence: row.confidence,
      traffic_class: row.traffic_class,
      destination_key: row.destination_key,
      accounting_bucket: Boolean(row.accounting_bucket),
      collected_at: row.collected_at,
      last_seen: row.last_seen,
    })
  );
}

function latestAuthoritativeTotals(db, window, now) {
  if (window !== "today") return null;
  const today = toMskKey(now, "day");
  const rows = db
    .prepare("select collected_at, payload_json from snapshots where type in ('traffic_summary','traffic') order by collected_at desc limit 50")
    .all();
  for (const row of rows) {
    if (toMskKey(row.collected_at, "day") !== today) continue;
    const payload = parseJson(row.payload_json, {});
    const totals = payload.totals || {};
    if (!totals.client_observed_bytes && !totals.via_vps_bytes && !totals.direct_bytes) continue;
    return {
      observedBytes: number(totals.client_observed_bytes),
      viaVpsBytes: number(totals.via_vps_bytes),
      directBytes: number(totals.direct_bytes),
      unknownBytes: hasNumber(totals.unknown_bytes)
        ? number(totals.unknown_bytes)
        : number(totals.client_observed_bytes) - number(totals.via_vps_bytes) - number(totals.direct_bytes),
      periodLabel: trafficPeriodLabelForPayload(payload, window),
      windowLabel: trafficWindowLabelForPayload(payload, window),
    };
  }
  return null;
}

function trafficPeriodLabelForPayload(payload, window) {
  return text(payload?.period_label || payload?.source?.period || payload?.period || window, window);
}

function trafficWindowLabelForPayload(payload, window) {
  return text(payload?.window_label || payload?.traffic_window || payload?.source?.window || "", window);
}

function groupRows(rows, keyFor, seedFor) {
  const grouped = new Map();
  for (const row of rows) addToGroup(grouped, keyFor(row), seedFor(row), row);
  return Array.from(grouped.values()).map((row) => ({ ...row, route: routeFromAggregate(row) }));
}

function preparedRowsForWindow(rows, trafficClass = "client") {
  return rows.filter((row) => {
    if (!trafficClass || trafficClass === "all") return true;
    if (trafficClass === "primary_client") return ["client", "personal_cloud"].includes(row.traffic_class);
    if (row.traffic_class === trafficClass) return true;
    return trafficClass === "client" && row.accounting_bucket && row.traffic_class === "client";
  });
}

function topClientAnalyticsFromRows(rows, limit = 5) {
  const total = rows.reduce((sum, row) => sum + aggregateTotalBytes(row), 0) || 1;
  return rows
    .filter((row) => aggregateTotalBytes(row) > 0)
    .sort((a, b) => aggregateTotalBytes(b) - aggregateTotalBytes(a))
    .slice(0, limit)
    .map((row, idx) => {
      const rowTotal = aggregateTotalBytes(row);
      return {
        rank: idx + 1,
        key: row.client_key || row.id || row.label || "",
        label: row.label || row.client_label || row.client_key || "Unknown client",
        channel: row.channel || "Unknown",
        bytes: rowTotal,
        totalBytes: rowTotal,
        total_bytes: rowTotal,
        viaVpsBytes: number(row.via_vps_bytes),
        directBytes: number(row.direct_bytes),
        unknownBytes: number(row.unknown_bytes),
        sharePct: Math.round((rowTotal / total) * 100),
        route: routeFromAggregate(row),
        status: "OK",
      };
    });
}

function clientChannelObservedRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = [row.client_key, row.channel || "Unknown"].join("|");
    const current = groups.get(key) || {
      id: `${row.client_key}:${row.channel || "Unknown"}`,
      device_id: row.client_key,
      client_key: row.client_key,
      client_label: row.client_label,
      label: row.client_label,
      channel: row.channel || "Unknown",
      confidence: row.confidence,
      last_seen: row.last_seen || row.collected_at,
      traffic_window_active: true,
      traffic_collected_at: row.last_seen || row.collected_at,
      accounting: { bytes: 0, via_vps_bytes: 0, direct_bytes: 0, unknown_bytes: 0, flows: 0, connections: 0 },
      detail: { bytes: 0, via_vps_bytes: 0, direct_bytes: 0, unknown_bytes: 0, flows: 0, connections: 0 },
    };
    const target = row.accounting_bucket || !text(row.destination_key) ? current.accounting : current.detail;
    target.bytes += aggregateTotalBytes(row);
    target.via_vps_bytes += number(row.via_vps_bytes);
    target.direct_bytes += number(row.direct_bytes);
    target.unknown_bytes += number(row.unknown_bytes);
    target.flows += number(row.flows || 1);
    target.connections += number(row.connections);
    if (Date.parse(row.last_seen || row.collected_at || "") > Date.parse(current.last_seen || "")) {
      current.last_seen = row.last_seen || row.collected_at;
      current.traffic_collected_at = row.last_seen || row.collected_at;
    }
    groups.set(key, current);
  }
  return Array.from(groups.values()).map((row) => {
    const source = row.accounting.bytes > 0 ? row.accounting : row.detail;
    return {
      ...row,
      bytes: source.bytes,
      total_bytes: source.bytes,
      via_vps_bytes: source.via_vps_bytes,
      direct_bytes: source.direct_bytes,
      unknown_bytes: source.unknown_bytes,
      flows: source.flows,
      connections: source.connections,
      route: routeFromAggregate(source),
      accounting_bucket: row.accounting.bytes > 0,
    };
  }).filter((row) => number(row.bytes) > 0);
}

function clientObservedRows(rows) {
  return groupRows(
    clientChannelObservedRows(rows),
    (row) => row.client_key,
    (row) => ({
      id: row.client_key,
      device_id: row.client_key,
      client_key: row.client_key,
      client_label: row.client_label,
      label: row.client_label,
      channel: row.channel,
      confidence: row.confidence,
      last_seen: row.last_seen || row.collected_at,
      traffic_window_active: true,
      traffic_collected_at: row.last_seen || row.collected_at,
    })
  );
}

function buildPreparedWindowPayload(db, window, facts, now, trafficClass = "all") {
  const bounds = mskWindowBounds(window, now);
  const registry = loadDeviceAttributions();
  const rows = preparedRowsForWindow(facts, trafficClass);
  const allRows = rows.filter((row) => aggregateTotalBytes(row) > 0);
  const primaryRows = preparedRowsForWindow(rows, "primary_client").filter((row) => aggregateTotalBytes(row) > 0);
  const operatorRows = allRows.filter((row) => isOperatorTrafficRow(row, registry));
  const clientRows = clientObservedRows(operatorRows).sort((a, b) => number(b.bytes) - number(a.bytes)).slice(0, 200);
  const supportRows = allRows.filter((row) => !isOperatorTrafficRow(row, registry) && ["service_background", "unclassified"].includes(row.traffic_class));
  const modelRows = trafficClass === "client" || trafficClass === "personal_cloud"
    ? operatorRows
    : [...operatorRows, ...supportRows];
  const groupedFlowRows = groupRows(
    modelRows,
    (row) => [row.client_key || row.client_label || row.channel || "source", row.destination_key, row.channel, row.route, row.confidence, row.traffic_class].join("|"),
    (row) => ({
      id: `prepared:${window}:${row.client_key || row.client_label || row.channel || "source"}:${row.destination_key}:${row.route}:${row.traffic_class}`,
      client: row.client_label || row.channel || "",
      client_key: row.client_key || "",
      client_label: row.client_label || row.channel || "",
      channel: row.channel,
      destination: row.destination_key,
      destinationLabel: row.destination_key,
      dns_qname: row.destination_key,
      sni: row.destination_key,
      route: row.route,
      confidence: row.confidence,
      trafficClass: row.traffic_class,
      traffic_class: row.traffic_class,
      accounting_bucket: row.accounting_bucket,
      last_seen: row.last_seen || row.collected_at,
      collected_at: row.collected_at,
    })
  ).sort((a, b) => number(b.bytes) - number(a.bytes));
  const flowRows = groupedFlowRows.slice(0, 250);
  const authoritative = latestAuthoritativeTotals(db, window, now);
  const clientTotals = totalsForFacts(clientRows);
  const factTotals = totalsForFacts(primaryRows.filter((row) => row.accounting_bucket || !text(row.destination_key)));
  const accountingTotals = clientTotals.observedBytes > 0 ? clientTotals : factTotals.observedBytes > 0 ? factTotals : authoritative;
  const totals = {
    ...(accountingTotals || { observedBytes: 0, viaVpsBytes: 0, directBytes: 0, unknownBytes: 0 }),
    periodLabel: authoritative?.periodLabel || window,
    windowLabel: authoritative?.windowLabel || mskWindowLabel(window, bounds),
  };
  const destinationObserved = clientRows.reduce((sum, row) => sum + number(row.bytes), 0);
  const destinationAttributed = operatorRows.filter((row) => !row.accounting_bucket).reduce((sum, row) => sum + number(row.bytes), 0);
  const dashboardRows = flowRows.map((row) => ({
    ...row,
    bytes: aggregateTotalBytes(row),
    total_bytes: aggregateTotalBytes(row),
    via_vps_bytes: number(row.via_vps_bytes),
    direct_bytes: number(row.direct_bytes),
    unknown_bytes: number(row.unknown_bytes),
    last_seen: row.last_seen || row.collected_at,
  }));
  const destinationRows = groupedFlowRows.map((row) => ({
    ...row,
    bytes: aggregateTotalBytes(row),
    total_bytes: aggregateTotalBytes(row),
    via_vps_bytes: number(row.via_vps_bytes),
    direct_bytes: number(row.direct_bytes),
    unknown_bytes: number(row.unknown_bytes),
    last_seen: row.last_seen || row.collected_at,
  })).filter((row) => !row.accounting_bucket && isConcreteDestination(row.destination));
  const dashboardAnalytics = buildDashboardAnalyticsFromRows(dashboardRows, {
    now,
    period: window,
    vpsQuotaBytes: process.env.GHOSTROUTE_CONSOLE_VPS_QUOTA_BYTES,
    vpsQuotaGb: process.env.GHOSTROUTE_CONSOLE_VPS_QUOTA_GB,
    lteQuotaBytes: process.env.GHOSTROUTE_CONSOLE_LTE_QUOTA_BYTES,
    lteQuotaGb: process.env.GHOSTROUTE_CONSOLE_LTE_QUOTA_GB,
    resetDay: process.env.GHOSTROUTE_CONSOLE_BILLING_RESET_DAY,
  });
  dashboardAnalytics.topClients = topClientAnalyticsFromRows(clientRows);
  dashboardAnalytics.topDestinations = buildDashboardAnalyticsFromRows(destinationRows, {
    now,
    period: window,
  }).topDestinations;
  return {
    generatedAt: now,
    prepared: true,
    window,
    trafficClass,
    windowStartUtc: bounds.startUtc,
    windowEndUtc: bounds.endUtc,
    totals,
    destinationAttributionCoverage: {
      observed_bytes: destinationObserved,
      attributed_bytes: destinationAttributed,
      unattributed_bytes: Math.max(0, destinationObserved - destinationAttributed),
      coverage_pct: destinationObserved > 0 ? Math.round((destinationAttributed / destinationObserved) * 1000) / 10 : 0,
      denominator: "observed_client",
    },
    devices: clientRows.map((row) => ({
      ...row,
      total_bytes: aggregateTotalBytes(row),
      bytes: aggregateTotalBytes(row),
      route: routeFromAggregate(row),
    })),
    flows: dashboardRows,
    dashboardAnalytics,
  };
}

function writePreparedWindow(db, kind, window, trafficClass, bounds, sourceVersion, computedAt, payload) {
  db.prepare(`
    insert into traffic_window_snapshots(kind, window, traffic_class, window_start_utc, window_end_utc,
      source_version, computed_at_utc, payload_json)
    values (?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(kind, window, traffic_class) do update set
      window_start_utc = excluded.window_start_utc,
      window_end_utc = excluded.window_end_utc,
      source_version = excluded.source_version,
      computed_at_utc = excluded.computed_at_utc,
      payload_json = excluded.payload_json
  `).run(kind, window, trafficClass, bounds.startUtc, bounds.endUtc, sourceVersion, computedAt, json(payload));
}

function writeAggregateState(db, model, windowKey, builtUntilUtc, sourceVersion, status = "ok", detail = {}) {
  db.prepare(`
    insert into aggregate_state(model, window_key, source_snapshot_id, built_until_utc, status, detail_json, updated_at_utc)
    values (?, ?, ?, ?, ?, ?, ?)
    on conflict(model, window_key) do update set
      source_snapshot_id = excluded.source_snapshot_id,
      built_until_utc = excluded.built_until_utc,
      status = excluded.status,
      detail_json = excluded.detail_json,
      updated_at_utc = excluded.updated_at_utc
  `).run(model, windowKey, sourceVersion, builtUntilUtc, status, json(detail), new Date().toISOString());
}

function tableStatsForRange(db, table, timeColumn, startUtc, endUtc) {
  try {
    return db.prepare(`
      select count(*) as rows, min(${timeColumn}) as min_ts, max(${timeColumn}) as max_ts
        from ${table}
       where ${timeColumn} >= ?
         and ${timeColumn} < ?
    `).get(startUtc, endUtc);
  } catch {
    return { rows: 0, min_ts: "", max_ts: "" };
  }
}

function sourceStatsForRange(db, startUtc, endUtc) {
  return {
    normalized_flows: tableStatsForRange(db, "normalized_flows", "collected_at", startUtc, endUtc),
    flow_sessions: tableStatsForRange(db, "flow_sessions", "collected_at", startUtc, endUtc),
    normalized_dns: tableStatsForRange(db, "normalized_dns", "collected_at", startUtc, endUtc),
    dns_query_log: tableStatsForRange(db, "dns_query_log", "collected_at", startUtc, endUtc),
  };
}

function earliestSourceTimestamp(db) {
  const candidates = [];
  for (const [table, column] of [
    ["normalized_flows", "collected_at"],
    ["flow_sessions", "collected_at"],
    ["normalized_dns", "collected_at"],
    ["dns_query_log", "collected_at"],
  ]) {
    try {
      const row = db.prepare(`select min(${column}) as min_ts from ${table}`).get();
      if (row?.min_ts) candidates.push(row.min_ts);
    } catch {
      // Table may not exist in partially initialized fixture DBs.
    }
  }
  return candidates.filter(Boolean).sort()[0] || "";
}

export function clearTrafficReadModels(db) {
  for (const table of TRAFFIC_READ_MODEL_TABLES) {
    db.prepare(`delete from ${table}`).run();
  }
  db.prepare("delete from aggregate_state where model like 'client_traffic_%' or model like 'client_destination_%' or model like 'dns_log_%' or model in ('dashboard', 'dns_counts', 'repair_aggregates')").run();
}

function sourceRowCount(stats, trafficOnly = false) {
  const trafficRows = number(stats.normalized_flows?.rows) + number(stats.flow_sessions?.rows);
  if (trafficOnly) return trafficRows;
  return trafficRows + number(stats.normalized_dns?.rows) + number(stats.dns_query_log?.rows);
}

function repairStatusForSource(stats, startUtc, endUtc) {
  if (sourceRowCount(stats) <= 0) return "missing_source";
  const minCandidates = [stats.normalized_flows?.min_ts, stats.flow_sessions?.min_ts, stats.normalized_dns?.min_ts, stats.dns_query_log?.min_ts].filter(Boolean).sort();
  const maxCandidates = [stats.normalized_flows?.max_ts, stats.flow_sessions?.max_ts, stats.normalized_dns?.max_ts, stats.dns_query_log?.max_ts].filter(Boolean).sort();
  const minTs = minCandidates[0] || "";
  const maxTs = maxCandidates.at(-1) || "";
  const warnMs = Math.max(1, number(process.env.GHOSTROUTE_REPAIR_GAP_WARN_HOURS || 6)) * 3600000;
  if ((minTs && Date.parse(minTs) - Date.parse(startUtc) > warnMs) || (maxTs && Date.parse(endUtc) - Date.parse(maxTs) > warnMs)) {
    return "partial";
  }
  return "ok";
}

function repairRangeKey(startUtc, endUtc) {
  return `${startUtc}..${endUtc}`;
}

function writeAggregateLayerStates(db, { model, table, timeColumn, mskKeyColumn, metricColumn = "bytes", startUtc, endUtc, sourceVersion, status = "ok", detail = {} }) {
  const rows = db.prepare(`
    select substr(${mskKeyColumn}, 1, 10) as window_key,
           count(*) as bucket_count,
           coalesce(sum(${metricColumn}), 0) as metric,
           min(${timeColumn}) as min_ts,
           max(${timeColumn}) as max_ts
      from ${table}
     where ${timeColumn} >= ?
       and ${timeColumn} < ?
     group by substr(${mskKeyColumn}, 1, 10)
  `).all(startUtc, endUtc);
  const all = rows.reduce((acc, row) => {
    acc.bucket_count += number(row.bucket_count);
    acc.metric += number(row.metric);
    if (!acc.min_ts || (row.min_ts && row.min_ts < acc.min_ts)) acc.min_ts = row.min_ts || acc.min_ts;
    if (!acc.max_ts || (row.max_ts && row.max_ts > acc.max_ts)) acc.max_ts = row.max_ts || acc.max_ts;
    return acc;
  }, { bucket_count: 0, metric: 0, min_ts: "", max_ts: "" });
  writeAggregateState(db, model, "all", endUtc, sourceVersion, status, { ...detail, ...all, range_start_utc: startUtc, range_end_utc: endUtc });
  for (const row of rows) {
    writeAggregateState(db, model, row.window_key, row.max_ts || endUtc, sourceVersion, status, {
      ...detail,
      bucket_count: number(row.bucket_count),
      metric: number(row.metric),
      min_ts: row.min_ts || "",
      max_ts: row.max_ts || "",
      range_start_utc: startUtc,
      range_end_utc: endUtc,
    });
  }
}

function rebuildTopWindows(db, window, payload, computedAt, trafficClass = "all") {
  db.prepare("delete from top_clients_window where window = ? and traffic_class = ?").run(window, trafficClass);
  db.prepare("delete from top_destinations_window where window = ? and traffic_class = ?").run(window, trafficClass);
  const insertClient = db.prepare(`
    insert into top_clients_window(window, traffic_class, rank, client_key, label, channel, route, bytes,
      via_vps_bytes, direct_bytes, unknown_bytes, flows, computed_at_utc)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  (payload.devices || []).slice(0, 50).forEach((row, idx) => {
    insertClient.run(window, trafficClass, idx + 1, row.client_key || row.id || row.label || "", row.label || row.client_label || "", row.channel || "Unknown", row.route || "Unknown", aggregateTotalBytes(row), number(row.via_vps_bytes), number(row.direct_bytes), number(row.unknown_bytes), number(row.flows || 1), computedAt);
  });
  const insertDestination = db.prepare(`
    insert into top_destinations_window(window, traffic_class, rank, destination, channel, route, bytes,
      flows, observed_bytes, attributed_bytes, computed_at_utc)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  (payload.dashboardAnalytics?.topDestinations || []).slice(0, 50).forEach((row, idx) => {
    insertDestination.run(window, trafficClass, idx + 1, row.label || row.destination || "", row.channel || "Unknown", row.route || "Unknown", number(row.bytes), number(row.flows || 1), number(row.bytes), row.accounting_bucket ? 0 : number(row.bytes), computedAt);
  });
}

function rebuildDnsPreparedWindows(db, sourceVersion, computedAt) {
  for (const window of ["today", "week", "month"]) {
    const bounds = mskWindowBounds(window, computedAt);
    const grouped = new Map();
    for (const segment of windowAggregateSegments(window, computedAt)) {
      const layer = segment.layer === "weekly" ? "week" : segment.layer === "daily" ? "day" : segment.layer === "hourly" ? "hour" : "5min";
      const meta = dnsRollupMeta[layer] || { sourceTable: "dns_log_5min", sourceTime: "bucket_start_utc" };
      const rows = db.prepare(`
        select client_key as client, client_ip, domain, qtype, catalog_status, route, confidence, sum(query_count) as count,
               max(${meta.sourceTime}) as event_ts
          from ${meta.sourceTable}
         where ${meta.sourceTime} >= ? and ${meta.sourceTime} < ?
         group by client_key, client_ip, domain, qtype, catalog_status, route, confidence
      `).all(segment.start, segment.end);
      for (const row of rows) {
        const key = [row.client, row.client_ip, row.domain, row.qtype, row.catalog_status, row.route, row.confidence].join("|");
        const current = grouped.get(key) || { ...row, count: 0 };
        current.count += number(row.count);
        if (String(row.event_ts || "") > String(current.event_ts || "")) current.event_ts = row.event_ts;
        grouped.set(key, current);
      }
    }
    const rows = Array.from(grouped.values()).sort((a, b) => number(b.count) - number(a.count) || String(b.event_ts || "").localeCompare(String(a.event_ts || ""))).slice(0, 500);
    writePreparedWindow(db, "dns_counts", window, "all", bounds, sourceVersion, computedAt, {
      generatedAt: computedAt,
      prepared: true,
      window,
      rows,
      total: rows.length,
    });
  }
}

function rebuildPreparedWindowPayloads(db, sourceVersion, computedAt) {
  const windows = [];
  for (const window of ["today", "week", "month"]) {
    const bounds = mskWindowBounds(window, computedAt);
    const facts = aggregateRowsForWindow(db, window, computedAt);
    const payload = buildPreparedWindowPayload(db, window, facts, computedAt, "all");
    for (const trafficClass of PREPARED_TRAFFIC_CLASSES) {
      const classPayload = trafficClass === "all" ? payload : buildPreparedWindowPayload(db, window, facts, computedAt, trafficClass);
      writePreparedWindow(db, "dashboard", window, trafficClass, bounds, sourceVersion, computedAt, classPayload);
      writePreparedWindow(db, "clients", window, trafficClass, bounds, sourceVersion, computedAt, {
        generatedAt: computedAt,
        prepared: true,
        window,
        trafficClass,
        rows: classPayload.devices,
        total: classPayload.devices.length,
      });
      writePreparedWindow(db, "reports_llm_safe", window, trafficClass, bounds, sourceVersion, computedAt, classPayload);
      rebuildTopWindows(db, window, classPayload, computedAt, trafficClass);
    }
    writeAggregateState(db, "dashboard", window, bounds.endUtc, sourceVersion, "ok", {
      rows: payload.flows?.length || 0,
      clients: payload.devices?.length || 0,
      window_start_utc: bounds.startUtc,
      window_end_utc: bounds.endUtc,
    });
    windows.push({ window, bounds, rows: payload.flows?.length || 0, clients: payload.devices?.length || 0 });
  }
  rebuildDnsPreparedWindows(db, sourceVersion, computedAt);
  return windows;
}

export function rebuildPreparedWindows(db, computedAt = new Date().toISOString()) {
  const sourceVersion = compactSourceVersion(readModelSourceVersion(db));
  const dirtyStart = aggregateDirtyStart(db, computedAt);
  const facts = flowFactsFromNormalized(db, dirtyStart, computedAt);
  rebuildTrafficAggregates(db, facts, computedAt, dirtyStart, computedAt, sourceVersion);
  rebuildDnsAggregates(db, computedAt, dirtyStart);
  writeAggregateLayerStates(db, { model: "client_traffic_5min", table: "client_traffic_5min", timeColumn: "bucket_start_utc", mskKeyColumn: "bucket_msk_key", startUtc: bucketStartUtc(dirtyStart, "5min"), endUtc: computedAt, sourceVersion, detail: { dirty_start_utc: dirtyStart, fact_count: facts.length } });
  writeAggregateLayerStates(db, { model: "client_traffic_hourly", table: "client_traffic_hourly", timeColumn: "hour_start_utc", mskKeyColumn: "hour_msk_key", startUtc: bucketStartUtc(dirtyStart, "hour"), endUtc: bucketRangeEndUtc(computedAt, "hour"), sourceVersion, detail: { dirty_start_utc: bucketStartUtc(dirtyStart, "hour") } });
  writeAggregateLayerStates(db, { model: "client_traffic_daily", table: "client_traffic_daily", timeColumn: "day_start_utc", mskKeyColumn: "day_msk_key", startUtc: bucketStartUtc(dirtyStart, "day"), endUtc: bucketRangeEndUtc(computedAt, "day"), sourceVersion, detail: { dirty_start_utc: bucketStartUtc(dirtyStart, "day") } });
  writeAggregateLayerStates(db, { model: "client_traffic_weekly", table: "client_traffic_weekly", timeColumn: "week_start_utc", mskKeyColumn: "week_msk_key", startUtc: bucketStartUtc(dirtyStart, "week"), endUtc: bucketRangeEndUtc(computedAt, "week"), sourceVersion, detail: { dirty_start_utc: bucketStartUtc(dirtyStart, "week") } });
  writeAggregateLayerStates(db, { model: "client_traffic_monthly", table: "client_traffic_monthly", timeColumn: "month_start_utc", mskKeyColumn: "month_msk_key", startUtc: bucketStartUtc(dirtyStart, "month"), endUtc: bucketRangeEndUtc(computedAt, "month"), sourceVersion, detail: { dirty_start_utc: bucketStartUtc(dirtyStart, "month") } });
  writeAggregateLayerStates(db, { model: "client_destination_traffic_5min", table: "client_destination_traffic_5min", timeColumn: "bucket_start_utc", mskKeyColumn: "bucket_msk_key", startUtc: bucketStartUtc(dirtyStart, "5min"), endUtc: computedAt, sourceVersion, detail: { dirty_start_utc: dirtyStart } });
  writeAggregateLayerStates(db, { model: "client_destination_traffic_hourly", table: "client_destination_traffic_hourly", timeColumn: "hour_start_utc", mskKeyColumn: "hour_msk_key", startUtc: bucketStartUtc(dirtyStart, "hour"), endUtc: bucketRangeEndUtc(computedAt, "hour"), sourceVersion, detail: { dirty_start_utc: bucketStartUtc(dirtyStart, "hour") } });
  writeAggregateLayerStates(db, { model: "client_destination_traffic_daily", table: "client_destination_traffic_daily", timeColumn: "day_start_utc", mskKeyColumn: "day_msk_key", startUtc: bucketStartUtc(dirtyStart, "day"), endUtc: bucketRangeEndUtc(computedAt, "day"), sourceVersion, detail: { dirty_start_utc: bucketStartUtc(dirtyStart, "day") } });
  writeAggregateLayerStates(db, { model: "client_destination_traffic_weekly", table: "client_destination_traffic_weekly", timeColumn: "week_start_utc", mskKeyColumn: "week_msk_key", startUtc: bucketStartUtc(dirtyStart, "week"), endUtc: bucketRangeEndUtc(computedAt, "week"), sourceVersion, detail: { dirty_start_utc: bucketStartUtc(dirtyStart, "week") } });
  writeAggregateLayerStates(db, { model: "client_destination_traffic_monthly", table: "client_destination_traffic_monthly", timeColumn: "month_start_utc", mskKeyColumn: "month_msk_key", startUtc: bucketStartUtc(dirtyStart, "month"), endUtc: bucketRangeEndUtc(computedAt, "month"), sourceVersion, detail: { dirty_start_utc: bucketStartUtc(dirtyStart, "month") } });
  writeAggregateLayerStates(db, { model: "dns_log_5min", table: "dns_log_5min", timeColumn: "bucket_start_utc", mskKeyColumn: "bucket_msk_key", metricColumn: "query_count", startUtc: dirtyStart, endUtc: computedAt, sourceVersion, detail: { dirty_start_utc: dirtyStart } });
  writeAggregateLayerStates(db, { model: "dns_log_hourly", table: "dns_log_hourly", timeColumn: "hour_start_utc", mskKeyColumn: "hour_msk_key", metricColumn: "query_count", startUtc: bucketStartUtc(dirtyStart, "hour"), endUtc: bucketRangeEndUtc(computedAt, "hour"), sourceVersion, detail: { dirty_start_utc: bucketStartUtc(dirtyStart, "hour") } });
  writeAggregateLayerStates(db, { model: "dns_log_daily", table: "dns_log_daily", timeColumn: "day_start_utc", mskKeyColumn: "day_msk_key", metricColumn: "query_count", startUtc: bucketStartUtc(dirtyStart, "day"), endUtc: bucketRangeEndUtc(computedAt, "day"), sourceVersion, detail: { dirty_start_utc: bucketStartUtc(dirtyStart, "day") } });
  writeAggregateLayerStates(db, { model: "dns_log_weekly", table: "dns_log_weekly", timeColumn: "week_start_utc", mskKeyColumn: "week_msk_key", metricColumn: "query_count", startUtc: bucketStartUtc(dirtyStart, "week"), endUtc: bucketRangeEndUtc(computedAt, "week"), sourceVersion, detail: { dirty_start_utc: bucketStartUtc(dirtyStart, "week") } });
  writeAggregateLayerStates(db, { model: "dns_log_monthly", table: "dns_log_monthly", timeColumn: "month_start_utc", mskKeyColumn: "month_msk_key", metricColumn: "query_count", startUtc: bucketStartUtc(dirtyStart, "month"), endUtc: bucketRangeEndUtc(computedAt, "month"), sourceVersion, detail: { dirty_start_utc: bucketStartUtc(dirtyStart, "month") } });
  const windows = rebuildPreparedWindowPayloads(db, sourceVersion, computedAt);
  return { factCount: facts.length, sourceVersion, windows };
}

export function repairAggregateRange(db, options = {}) {
  const computedAt = options.computedAt || new Date().toISOString();
  const sourceVersion = compactSourceVersion(readModelSourceVersion(db));
  const fromRaw = options.fromUtc || options.from || "";
  const toRaw = options.toUtc || options.to || computedAt;
  if (!fromRaw) throw new Error("repairAggregateRange requires fromUtc");
  const fromUtc = parseSourceTimestamp(fromRaw);
  const toUtc = parseSourceTimestamp(toRaw);
  if (!fromUtc || !toUtc || Date.parse(fromUtc) >= Date.parse(toUtc)) {
    throw new Error("repairAggregateRange requires a valid [fromUtc, toUtc) range");
  }
  const dryRun = Boolean(options.dryRun);
  const key = repairRangeKey(fromUtc, toUtc);
  const stats = sourceStatsForRange(db, fromUtc, toUtc);
  const status = repairStatusForSource(stats, fromUtc, toUtc);
  const detail = {
    repair_from_utc: fromUtc,
    repair_to_utc: toUtc,
    dry_run: dryRun,
    source: stats,
  };
  if (dryRun) return { status, dryRun, fromUtc, toUtc, sourceVersion, source: stats };
  if (status === "missing_source") {
    for (const model of ["repair_aggregates", "client_traffic_5min", "client_traffic_hourly", "client_traffic_daily", "dns_log_5min"]) {
      writeAggregateState(db, model, key, toUtc, sourceVersion, "missing_source", detail);
    }
    return { status, repaired: false, fromUtc, toUtc, sourceVersion, source: stats };
  }
  writeAggregateState(db, "repair_aggregates", key, toUtc, sourceVersion, "repairing", detail);
  try {
    const trafficSourceRows = sourceRowCount(stats, true);
    const dnsSourceRows = number(stats.normalized_dns?.rows) || number(stats.dns_query_log?.rows);
    const facts = trafficSourceRows > 0 ? flowFactsFromNormalized(db, fromUtc, toUtc) : [];
    if (trafficSourceRows > 0) {
      rebuildTrafficAggregates(db, facts, computedAt, fromUtc, toUtc, sourceVersion);
      writeAggregateLayerStates(db, { model: "client_traffic_5min", table: "client_traffic_5min", timeColumn: "bucket_start_utc", mskKeyColumn: "bucket_msk_key", startUtc: bucketStartUtc(fromUtc, "5min"), endUtc: toUtc, sourceVersion, status, detail: { ...detail, fact_count: facts.length } });
      writeAggregateLayerStates(db, { model: "client_traffic_hourly", table: "client_traffic_hourly", timeColumn: "hour_start_utc", mskKeyColumn: "hour_msk_key", startUtc: bucketStartUtc(fromUtc, "hour"), endUtc: bucketRangeEndUtc(toUtc, "hour"), sourceVersion, status, detail });
      writeAggregateLayerStates(db, { model: "client_traffic_daily", table: "client_traffic_daily", timeColumn: "day_start_utc", mskKeyColumn: "day_msk_key", startUtc: bucketStartUtc(fromUtc, "day"), endUtc: bucketRangeEndUtc(toUtc, "day"), sourceVersion, status, detail });
    } else {
      for (const model of ["client_traffic_5min", "client_traffic_hourly", "client_traffic_daily"]) {
        writeAggregateState(db, model, key, toUtc, sourceVersion, "missing_source", detail);
      }
    }
    if (dnsSourceRows > 0) {
      rebuildDnsAggregates(db, computedAt, fromUtc, toUtc);
      writeAggregateLayerStates(db, { model: "dns_log_5min", table: "dns_log_5min", timeColumn: "bucket_start_utc", mskKeyColumn: "bucket_msk_key", metricColumn: "query_count", startUtc: fromUtc, endUtc: toUtc, sourceVersion, status, detail });
    } else {
      writeAggregateState(db, "dns_log_5min", key, toUtc, sourceVersion, "missing_source", detail);
    }
    const windows = rebuildPreparedWindowPayloads(db, sourceVersion, computedAt);
    writeAggregateState(db, "repair_aggregates", key, toUtc, sourceVersion, status, { ...detail, fact_count: facts.length, windows });
    return { status, repaired: true, fromUtc, toUtc, sourceVersion, factCount: facts.length, windows, source: stats };
  } catch (error) {
    writeAggregateState(db, "repair_aggregates", key, toUtc, sourceVersion, "error", { ...detail, error: error.message });
    throw error;
  }
}

export function rebuildAllTrafficReadModels(db, options = {}) {
  const computedAt = options.computedAt || new Date().toISOString();
  const fromUtc = options.fromUtc || earliestSourceTimestamp(db) || mskWindowBounds("month", computedAt).startUtc;
  clearTrafficReadModels(db);
  return repairAggregateRange(db, { fromUtc, toUtc: options.toUtc || computedAt, computedAt });
}

export function pruneOperationalTables(db, now = new Date().toISOString()) {
  const rawDays = Math.max(1, number(process.env.GHOSTROUTE_RAW_RETENTION_DAYS || 7));
  const fineAggregateDays = Math.max(1, number(process.env.GHOSTROUTE_FINE_AGGREGATE_RETENTION_DAYS || 8));
  const aggregateDays = Math.max(31, number(process.env.GHOSTROUTE_AGGREGATE_RETENTION_DAYS || 35));
  const dailyAggregateDays = Math.max(35, number(process.env.GHOSTROUTE_DAILY_AGGREGATE_RETENTION_DAYS || 400));
  const dnsFineDays = Math.max(1, number(process.env.GHOSTROUTE_DNS_FINE_RETENTION_DAYS || 1));
  const dnsDailyDays = Math.max(35, number(process.env.GHOSTROUTE_DNS_DAILY_RETENTION_DAYS || 100));
  const serviceHours = Math.max(1, number(process.env.GHOSTROUTE_SERVICE_RAW_RETENTION_HOURS || 24));
  const unclassifiedHours = Math.max(1, number(process.env.GHOSTROUTE_UNCLASSIFIED_RAW_RETENTION_HOURS || 24));
  const filterDays = Math.max(1, number(process.env.GHOSTROUTE_FILTER_DECISION_RETENTION_DAYS || 30));
  const errorDays = Math.max(1, number(process.env.GHOSTROUTE_COLLECTOR_ERROR_RETENTION_DAYS || 14));
  const cutoff = (days) => new Date(Date.parse(now) - days * 86400000).toISOString();
  const cutoffHours = (hours) => new Date(Date.parse(now) - hours * 3600000).toISOString();
  const rawCutoff = cutoff(rawDays);
  const serviceCutoff = cutoffHours(serviceHours);
  const result = {
    normalized_flows: 0,
    flow_sessions: 0,
    normalized_dns: 0,
    events: 0,
    route_decisions: 0,
    collector_errors: 0,
    traffic_facts: 0,
    traffic_clients: 0,
    traffic_dns_links: 0,
    traffic_attribution_gaps: 0,
    client_traffic_5min: 0,
    client_traffic_hourly: 0,
    client_traffic_daily: 0,
    dns_log_5min: 0,
    dns_log_hourly: 0,
    dns_log_daily: 0,
    filter_decisions: 0,
    payloads_stripped: 0,
    superseded_traffic_fact_snapshots: 0,
  };
  const latestTrafficFactsSnapshot = db
    .prepare("select id from snapshots where type = 'traffic_facts' order by collected_at desc, id desc limit 1")
    .pluck()
    .get();
  if (latestTrafficFactsSnapshot !== undefined) {
    db.exec("drop table if exists temp.old_traffic_fact_snapshots");
    db.exec("create temp table old_traffic_fact_snapshots(id integer primary key)");
    const latestId = number(latestTrafficFactsSnapshot);
    const oldSnapshotInsert = db.prepare("insert or ignore into old_traffic_fact_snapshots(id) values (?)");
    for (const row of db.prepare("select id from snapshots where type = 'traffic_facts' and id != ?").all(latestId)) {
      oldSnapshotInsert.run(number(row.id));
    }
    for (const row of db.prepare("select distinct snapshot_id as id from normalized_flows where snapshot_type = 'traffic_facts' and snapshot_id != ?").all(latestId)) {
      oldSnapshotInsert.run(number(row.id));
    }
    for (const row of db.prepare("select distinct snapshot_id as id from traffic_facts where snapshot_id != ?").all(latestId)) {
      oldSnapshotInsert.run(number(row.id));
    }
    for (const row of db.prepare("select distinct snapshot_id as id from traffic_clients where snapshot_id != ?").all(latestId)) {
      oldSnapshotInsert.run(number(row.id));
    }
    for (const row of db.prepare("select distinct snapshot_id as id from traffic_dns_links where snapshot_id != ?").all(latestId)) {
      oldSnapshotInsert.run(number(row.id));
    }
    result.traffic_facts += db.prepare("delete from traffic_facts where snapshot_id in (select id from old_traffic_fact_snapshots)").run().changes;
    result.normalized_flows += db.prepare("delete from normalized_flows where snapshot_type = 'traffic_facts' and snapshot_id in (select id from old_traffic_fact_snapshots)").run().changes;
    result.flow_sessions += db.prepare("delete from flow_sessions where snapshot_id in (select id from old_traffic_fact_snapshots)").run().changes;
    result.traffic_dns_links += db.prepare("delete from traffic_dns_links where snapshot_id in (select id from old_traffic_fact_snapshots)").run().changes;
    result.traffic_attribution_gaps += db.prepare("delete from traffic_attribution_gaps where snapshot_id in (select id from old_traffic_fact_snapshots)").run().changes;
    result.traffic_clients += db.prepare("delete from traffic_clients where snapshot_id in (select id from old_traffic_fact_snapshots)").run().changes;
    result.superseded_traffic_fact_snapshots += db.prepare("delete from snapshots where type = 'traffic_facts' and id in (select id from old_traffic_fact_snapshots)").run().changes;
    db.exec("drop table if exists temp.old_traffic_fact_snapshots");
  }
  result.normalized_flows += db.prepare("delete from normalized_flows where collected_at < ?").run(rawCutoff).changes;
      result.normalized_flows += db.prepare("delete from normalized_flows where traffic_class not in ('client', 'personal_cloud') and collected_at < ?").run(serviceCutoff).changes;
  result.normalized_dns += db.prepare("delete from normalized_dns where collected_at < ?").run(rawCutoff).changes;
  result.events += db.prepare("delete from events where occurred_at < ?").run(rawCutoff).changes;
  result.route_decisions += db.prepare("delete from route_decisions where occurred_at < ?").run(rawCutoff).changes;
  result.collector_errors += db.prepare("delete from collector_errors where collected_at < ?").run(cutoff(errorDays)).changes;
  result.traffic_facts += db.prepare("delete from traffic_facts where traffic_class in ('client', 'personal_cloud') and coalesce(nullif(event_ts_utc, ''), collected_at) < ?").run(rawCutoff).changes;
  result.traffic_facts += db.prepare("delete from traffic_facts where traffic_class = 'service_background' and coalesce(nullif(event_ts_utc, ''), collected_at) < ?").run(serviceCutoff).changes;
  result.traffic_facts += db.prepare("delete from traffic_facts where traffic_class not in ('client', 'personal_cloud', 'service_background') and coalesce(nullif(event_ts_utc, ''), collected_at) < ?").run(cutoffHours(unclassifiedHours)).changes;
  result.traffic_dns_links += db.prepare("delete from traffic_dns_links where collected_at < ?").run(rawCutoff).changes;
  result.traffic_attribution_gaps += db.prepare("delete from traffic_attribution_gaps where collected_at < ?").run(rawCutoff).changes;
  result.client_traffic_5min += db.prepare("delete from client_traffic_5min where bucket_start_utc < ?").run(cutoff(fineAggregateDays)).changes;
  result.dns_log_5min += db.prepare("delete from dns_log_5min where bucket_start_utc < ?").run(cutoff(dnsFineDays)).changes;
  result.client_traffic_hourly += db.prepare("delete from client_traffic_hourly where hour_start_utc < ?").run(cutoff(aggregateDays)).changes;
  result.client_traffic_daily += db.prepare("delete from client_traffic_daily where day_start_utc < ?").run(cutoff(dailyAggregateDays)).changes;
  result.dns_log_hourly += db.prepare("delete from dns_log_hourly where hour_start_utc < ?").run(cutoff(aggregateDays)).changes;
  result.dns_log_daily += db.prepare("delete from dns_log_daily where day_start_utc < ?").run(cutoff(dnsDailyDays)).changes;
  result.filter_decisions += db.prepare("delete from filter_decisions where observed_at_utc < ?").run(cutoff(filterDays)).changes;
  result.payloads_stripped += db.prepare(`
    update snapshots
       set payload_json = ''
     where payload_json != ''
       and type in ('traffic', 'dns', 'live')
       and collected_at < ?
       and id not in (select max(id) from snapshots group by type)
  `).run(cutoffHours(24)).changes;
  return result;
}

function readModelSourceVersion(db) {
  return db
    .prepare("select id, type, collected_at from snapshots order by id")
    .all()
    .map((row) => `${row.id}:${row.type}:${row.collected_at}`)
    .join("|") || "empty";
}

function compactSourceVersion(value) {
  const sourceVersion = text(value);
  if (sourceVersion.length <= 512) return sourceVersion;
  return `sha256:${crypto.createHash("sha256").update(sourceVersion).digest("hex")}`;
}

function writeReadModelState(db, model, sourceVersion, rowCount, startedAt, status = "ok", detail = "") {
  db.prepare(`
    insert into read_model_state(model, source_version, rebuilt_at, row_count, duration_ms, status, detail)
    values (?, ?, ?, ?, ?, ?, ?)
    on conflict(model) do update set
      source_version = excluded.source_version,
      rebuilt_at = excluded.rebuilt_at,
      row_count = excluded.row_count,
      duration_ms = excluded.duration_ms,
      status = excluded.status,
      detail = excluded.detail
  `).run(model, sourceVersion, new Date().toISOString(), rowCount, Math.max(0, Date.now() - startedAt), status, detail);
}

function readModelLimit(name, fallback) {
  const parsed = Number(process.env[name] || fallback);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function latestSnapshotPayloads(db, types) {
  if (types.length === 0) return {};
  const placeholders = types.map(() => "?").join(",");
  const rows = db
    .prepare(
      `select s.id, s.type, s.collected_at, s.source, s.payload_json
         from snapshots s
         join (
           select type, max(collected_at) as collected_at
             from snapshots
            where type in (${placeholders})
            group by type
         ) latest on latest.type = s.type and latest.collected_at = s.collected_at
        order by s.collected_at desc, s.id desc`
    )
    .all(...types);
  const result = {};
  for (const row of rows) {
    if (result[row.type]) continue;
    result[row.type] = {
      id: row.id,
      type: row.type,
      collected_at: row.collected_at,
      source: row.source,
      payload: parseJson(row.payload_json, {}),
    };
  }
  return result;
}

function preparedStatus(value, fallback = "UNKNOWN") {
  return text(value || fallback, fallback).toUpperCase();
}

function preparedDetail(value, fallback = "not observed") {
  const detail = text(value || "").trim();
  return detail || fallback;
}

function compactPreparedCheck(row) {
  return {
    id: text(row.id || row.name || row.check || row.label || row.probe),
    label: text(row.label || row.name || row.check || row.probe || row.id || "check"),
    probe: text(row.probe || row.check || row.name || row.id || ""),
    component: text(row.component || ""),
    status: preparedStatus(row.status),
    summary: preparedDetail(row.summary || row.message || row.detail || row.evidence, ""),
    message: preparedDetail(row.message || row.detail || row.summary || row.evidence, ""),
    evidence: preparedDetail(row.evidence || row.detail || row.message || "", ""),
    suggested_action: text(row.suggested_action || row.suggestedAction || ""),
    confidence: confidence(row.confidence, "unknown"),
  };
}

function buildPreparedHealthSummary(db, rebuiltAt) {
  const snapshots = latestSnapshotPayloads(db, ["traffic_summary", "health", "leaks", "deploy_gate"]);
  const health = snapshots.health?.payload || {};
  const leaks = snapshots.leaks?.payload || {};
  const deployGate = snapshots.deploy_gate?.payload || null;
  const leakSignals = Array.isArray(leaks.leaks) ? leaks.leaks : [];
  const leakEvidence = Array.isArray(leaks.evidence) ? leaks.evidence : [];
  const deployChecks = Array.isArray(deployGate?.checks) ? deployGate.checks.map(compactPreparedCheck).slice(0, 10) : [];
  const healthChecks = [
    ...(Array.isArray(health.checks) ? health.checks : []),
    ...(Array.isArray(leaks.checks) ? leaks.checks : []),
  ].map(compactPreparedCheck).slice(0, 20);
  const alarms = db
    .prepare(
      `select id, collected_at, severity, source, title, status, evidence, suggested_action, confidence, risk, evidence_json
         from alarm_events
        order by case lower(severity)
          when 'critical' then 0
          when 'crit' then 0
          when 'error' then 0
          when 'warning' then 1
          when 'warn' then 1
          when 'review' then 1
          else 2
        end, collected_at desc
        limit 10`
    )
    .all()
    .map((row) => ({
      id: text(row.id),
      collected_at: text(row.collected_at),
      severity: text(row.severity || "warning"),
      source: text(row.source || "snapshot"),
      title: text(row.title || "alarm"),
      status: text(row.status || "open"),
      evidence: text(row.evidence || ""),
      suggested_action: text(row.suggested_action || ""),
      confidence: confidence(row.confidence, "unknown"),
      risk: text(row.risk || "medium"),
    }));
  const alarmStats = db.prepare(`
    select count(*) as total,
           sum(case when lower(status) in ('open','active','warn','warning','critical','review') then 1 else 0 end) as active,
           sum(case when lower(severity) in ('critical','crit','error') then 1 else 0 end) as critical,
           sum(case when lower(severity) in ('warning','warn','review') then 1 else 0 end) as warning,
           sum(case when lower(severity) = 'info' then 1 else 0 end) as info
      from alarm_events
  `).get();
  const statusCards = [
    { label: "Router", status: preparedStatus(health.services?.router || health.overall), detail: preparedDetail(health.router?.product) },
    { label: "Reality", status: preparedStatus(health.services?.reality), detail: "home ingress / reality-out" },
    { label: "DNS", status: preparedStatus(health.services?.dns), detail: "dnscrypt + policy" },
    { label: "IPv6", status: preparedStatus(health.services?.ipv6), detail: "not in routing scope" },
    { label: "Rule-set", status: preparedStatus(health.services?.rule_set_sync), detail: "catalog mirror" },
    { label: "Leaks", status: preparedStatus(leaks.overall), detail: `${leakSignals.length} signals` },
  ];
  const traffic = snapshots.traffic_summary?.payload || {};
  const totals = traffic.totals || {};
  return {
    rebuiltAt,
    snapshotTimes: Object.fromEntries(
      Object.entries(snapshots).map(([type, row]) => [type, row.collected_at || ""])
    ),
    statusCards,
    alarmCounts: {
      total: number(alarmStats?.total),
      active: number(alarmStats?.active),
      critical: number(alarmStats?.critical),
      warning: number(alarmStats?.warning),
      info: number(alarmStats?.info),
    },
    alarms,
    deployGate: deployGate
      ? {
          status: preparedStatus(deployGate.overall_status || deployGate.status),
          mode: text(deployGate.mode || ""),
          estimated_duration: text(deployGate.estimated_duration || ""),
          generated_at: text(deployGate.generated_at || snapshots.deploy_gate?.collected_at || ""),
          checks: deployChecks,
        }
      : null,
    health: {
      overall: preparedStatus(health.overall),
      checks: healthChecks,
    },
    leaks: {
      overall: preparedStatus(leaks.overall),
      confidence: confidence(leaks.confidence, "unknown"),
      leakSignals: leakSignals.length,
      evidenceRows: leakEvidence.length,
      checks: (Array.isArray(leaks.checks) ? leaks.checks : []).map(compactPreparedCheck).slice(0, 10),
      evidence: leakEvidence.map(compactPreparedCheck).slice(0, 10),
    },
    totals: {
      observedBytes: number(totals.client_observed_bytes),
      viaVpsBytes: number(totals.via_vps_bytes),
      directBytes: number(totals.direct_bytes),
      unknownBytes: number(totals.unknown_bytes),
    },
  };
}

function buildCatalogMatcher(catalogRows) {
  const exact = new Map();
  for (const row of catalogRows) {
    const key = domainKey(row.domain);
    if (key && !exact.has(key)) exact.set(key, row);
  }
  return (domain) => {
    const key = domainKey(domain);
    if (!key) return undefined;
    const labels = key.split(".");
    for (let index = 0; index < labels.length; index += 1) {
      const match = exact.get(labels.slice(index).join("."));
      if (match) return match;
    }
    return undefined;
  };
}

function identityKey(row) {
  const raw = parseJson(row.raw_json || row.evidence_json, {});
  return text(
    raw.device_key ||
      raw.client_key ||
      raw.canonical_hint ||
      raw.profile ||
      raw.device_id ||
      row.device_id ||
      row.client ||
      row.client_ip ||
      row.ip ||
      row.label,
    "unknown"
  );
}

function stableId(prefix, row) {
  const raw = parseJson(row.raw_json || row.evidence_json, {});
  return text(row.event_id || raw.event_id || `${prefix}:${row.rowid || row.id || row.snapshot_id || "row"}`);
}

function primaryTime(row) {
  return text(row.display_ts_utc || row.event_ts_utc || row.event_ts || row.occurred_at || row.collected_at || row.created_at || "");
}

function policyForFlow(row) {
  if (text(row.matched_rule)) return text(row.matched_rule);
  if (text(row.rule_set)) return text(row.rule_set);
  if (text(row.outbound) === "reality-out" || text(row.route) === "VPS") return "STEALTH_DOMAINS";
  if (text(row.outbound) === "direct-out" || text(row.route) === "Direct") return "DEFAULT_DIRECT";
  return "not observed";
}

function riskForFlow(row) {
  const raw = `${JSON.stringify(row)} ${text(row.destination)} ${text(row.matched_rule)} ${text(row.rule_set)}`.toLowerCase();
  const route = text(row.route);
  const bytes = aggregateTotalBytes(row);
  if (raw.includes("leak") || raw.includes("suspicious") || raw.includes("blocked")) {
    return { risk: "high", reason: "source evidence marks this flow as suspicious" };
  }
  if (route === "Direct" && (raw.includes("stealth_domains") || raw.includes("managed domain"))) {
    return { risk: "high", reason: "managed-looking destination used direct route" };
  }
  if (!text(row.destination) || text(row.destination).toLowerCase().includes("unknown")) {
    return { risk: bytes > 25 * 1024 * 1024 ? "high" : "medium", reason: "destination attribution is incomplete" };
  }
  if (text(row.confidence) === "dns-interest") {
    return { risk: "medium", reason: "DNS interest is not traffic proof" };
  }
  return { risk: "low", reason: "route matches available evidence" };
}

function durationSeconds(row) {
  const raw = parseJson(row.raw_json || row.evidence_json, {});
  const value = number(raw.duration_seconds || raw.duration || row.duration_seconds);
  return Math.max(0, Math.round(value));
}

function durationConfidence(row) {
  return durationSeconds(row) > 0 ? confidence(row.duration_confidence || "exact", "estimated") : "unknown";
}

function catalogMatchFor(domain, catalogRows) {
  if (typeof catalogRows === "function") return catalogRows(domain);
  return catalogRows.find((row) => suffixMatch(domain, row.domain));
}

function catalogStatus(match) {
  const kind = text(match?.entry_type || "").toLowerCase();
  if (kind === "managed" || kind === "auto") return "managed";
  if (kind === "candidates") return "candidate";
  if (kind === "blocked") return "blocked";
  return "unknown";
}

function routeForDns(match, row) {
  const status = catalogStatus(match);
  if (status === "managed") return "VPS";
  if (status === "blocked") return "Blocked";
  if (status === "candidate") return "Review";
  return text(row.route || "Direct");
}

function queryStatusForDns(match, row) {
  const status = catalogStatus(match);
  if (status === "blocked") return "Blocked";
  if (status === "candidate") return "Review";
  if (lower(row.confidence) === "unknown") return "Review";
  return "OK";
}

function riskForDns(match, row) {
  const status = catalogStatus(match);
  if (status === "blocked") return "high";
  if (status === "candidate") return "medium";
  if (!text(row.answer_ip) && text(row.qtype).toUpperCase() !== "AAAA") return "medium";
  return "low";
}

function severityRisk(severity) {
  const value = lower(severity);
  if (["critical", "crit", "high", "error"].includes(value)) return "high";
  if (["warning", "warn", "medium", "review"].includes(value)) return "medium";
  return "low";
}

function suggestedActionForAlarm(row) {
  const title = lower(row.title || row.evidence);
  if (title.includes("dns leak")) return "Run leak-check and inspect DNS/IPv6 evidence.";
  if (title.includes("managed") && title.includes("direct")) return "Open Flow Explorer and review catalog/rule-set evidence.";
  if (title.includes("stale")) return "Run a fresh Console collection and check collector logs.";
  if (title.includes("collector")) return "Check read-only collector command output and SSH forced-command access.";
  if (title.includes("catalog")) return "Open Catalog review before preparing any apply action.";
  return "Review source evidence before changing runtime state.";
}

function deviceTypeFrom(row) {
  const raw = parseJson(row.raw_json || row.evidence_json, {});
  const textValue = lower(`${raw.device_type || ""} ${raw.role || ""} ${row.label || ""}`);
  if (textValue.includes("iphone") || textValue.includes("mobile")) return "mobile";
  if (textValue.includes("ipad") || textValue.includes("tablet")) return "tablet";
  if (textValue.includes("macbook") || textValue.includes("laptop")) return "laptop";
  if (textValue.includes("apple tv") || textValue.includes("media")) return "media";
  return text(raw.device_type || raw.role || "unknown");
}

function trustStateFrom(row) {
  const raw = parseJson(row.raw_json || row.evidence_json, {});
  if (raw.trusted === true || raw.trust_state === "trusted") return "trusted";
  if (lower(row.label).includes("unknown") || lower(row.device_id).includes("unknown")) return "unknown";
  if (text(row.device_id) || text(raw.profile) || text(raw.client_key)) return "known";
  return "unknown";
}

function routeFromSplit(vps, direct, unknown = 0) {
  if (vps > 0 && direct > 0) return "Mixed";
  if (vps > 0) return "VPS";
  if (direct > 0) return "Direct";
  return unknown > 0 ? "Unknown" : "Unknown";
}

export function rebuildObservabilityReadModels(db) {
  const startedAt = Date.now();
  const sourceVersion = readModelSourceVersion(db);
  const now = new Date().toISOString();
  let flowCount = 0;
  let dnsCount = 0;
  let deviceCount = 0;
  let alarmCount = 0;
  let summaryCount = 0;
  const flowLimit = readModelLimit("GHOSTROUTE_READ_MODEL_FLOW_LIMIT", 5000);
  const dnsLimit = readModelLimit("GHOSTROUTE_READ_MODEL_DNS_LIMIT", 20000);
  const liveDnsLimit = readModelLimit("GHOSTROUTE_READ_MODEL_LIVE_DNS_LIMIT", 10000);
  const deviceLimit = readModelLimit("GHOSTROUTE_READ_MODEL_DEVICE_LIMIT", 5000);
  const alarmLimit = readModelLimit("GHOSTROUTE_READ_MODEL_ALARM_LIMIT", 2000);

  db.transaction(() => {
    db.prepare("delete from flow_sessions").run();
    db.prepare("delete from dns_query_log").run();
    db.prepare("delete from device_inventory").run();
    db.prepare("delete from alarm_events").run();
    db.prepare("delete from console_page_summaries").run();

    const catalogRows = db.prepare("select rowid, * from normalized_catalog order by collected_at desc, rowid desc").all();
    const catalogMatch = buildCatalogMatcher(catalogRows);
      const flowInsert = db.prepare(`
        insert into flow_sessions(id, snapshot_id, collected_at, first_seen, last_seen,
          event_ts_utc, observed_at_utc, display_ts_utc, time_precision, client, client_ip,
        device_key, channel, destination, destination_ip, destination_port, protocol, route, intended_route, policy,
        matched_rule, outbound, dns_qname, dns_answer_ip, sni, egress_ip, egress_asn, egress_country,
        ts_confidence, traffic_class, via_vps_bytes, direct_bytes, unknown_bytes, route_verification, route_status,
        dns_link_id, dns_link_confidence, dns_status, dns_ts_source, accounting_status, bytes, connections,
        duration_seconds, duration_confidence, risk, risk_reason, confidence, source_kind, evidence_json)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
    const flowRows = db.prepare("select rowid, * from normalized_flows order by collected_at desc, rowid desc limit ?").all(flowLimit);
    const flowTopDomains = new Map();
    for (const row of flowRows) {
      const raw = parseJson(row.raw_json, {});
      if (raw.accounting_bucket || raw.device_counter) continue;
      const seen = primaryTime(row) || row.collected_at;
      const timing = {
        eventTsUtc: text(row.event_ts_utc || row.event_ts || ""),
        observedAtUtc: text(row.observed_at_utc || row.collected_at),
        displayTsUtc: text(row.display_ts_utc || seen || row.collected_at),
        timePrecision: text(row.time_precision || (row.event_ts_utc ? "event_ms" : "collector_ms")),
      };
      const risk = riskForFlow(row);
      const key = identityKey(row);
      const destination = text(row.destination || row.dns_qname || row.destination_ip, "unknown destination");
      const rawSplit = signedByteSplit({ ...raw, ...row }, row.route, number(row.bytes));
      const trafficClass = text(row.traffic_class || flowTrafficClass({ ...raw, ...row }), "client");
      flowInsert.run(
        `flow:${row.rowid}`,
        row.snapshot_id,
        row.collected_at,
        seen,
        seen,
        timing.eventTsUtc,
        timing.observedAtUtc,
        timing.displayTsUtc,
        timing.timePrecision,
        text(row.client),
        text(row.client_ip),
        key,
        text(row.channel || inferChannel(raw)),
        destination,
        text(row.destination_ip),
        text(row.destination_port),
        text(row.protocol),
        text(row.route || routeFromTraffic(raw), "Unknown"),
        intendedRoute(row),
        policyForFlow(row),
        text(row.matched_rule),
        text(row.outbound),
        text(row.dns_qname),
        text(row.dns_answer_ip),
        text(row.sni),
        text(row.egress_ip),
        text(row.egress_asn),
        text(row.egress_country),
        text(row.ts_confidence),
        trafficClass,
        rawSplit.viaVpsBytes,
        rawSplit.directBytes,
        rawSplit.unknownBytes,
        text(row.route_verification || ""),
        routeStatus(row),
        text(row.dns_link_id || ""),
        text(row.dns_link_confidence || ""),
        dnsStatus(row),
        dnsTsSource(row),
        text(row.accounting_status || "ok"),
        number(row.bytes),
        number(row.connections),
        durationSeconds(row),
        durationConfidence(row),
        risk.risk,
        risk.reason,
        confidence(row.confidence),
        text(row.snapshot_type || "traffic"),
        json({ ...raw, normalized_rowid: row.rowid, intended_route: intendedRoute(row), route_status: routeStatus(row), dns_status: dnsStatus(row), dns_ts_source: dnsTsSource(row) })
      );
      flowCount += 1;
      if (destination && destination !== "unknown destination") {
        const current = flowTopDomains.get(key) || new Map();
        current.set(destination, number(current.get(destination)) + number(row.bytes || row.connections || 1));
        flowTopDomains.set(key, current);
      }
    }

    const dnsInsert = db.prepare(`
      insert or replace into dns_query_log(id, snapshot_id, collected_at, event_ts,
        event_ts_utc, observed_at_utc, display_ts_utc, time_precision, client, client_ip,
        device_key, domain, qtype, answer_ip, route, catalog_status, status, count, risk,
        confidence, evidence_json)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const dnsRows = db.prepare("select rowid, * from normalized_dns order by collected_at desc, rowid desc limit ?").all(dnsLimit);
    for (const row of dnsRows) {
      const match = catalogMatchFor(row.domain, catalogMatch);
      const status = queryStatusForDns(match, row);
      const timing = {
        eventTsUtc: text(row.event_ts_utc || row.event_ts || ""),
        observedAtUtc: text(row.observed_at_utc || row.collected_at),
        displayTsUtc: text(row.display_ts_utc || primaryTime(row) || row.collected_at),
        timePrecision: text(row.time_precision || (row.event_ts_utc ? "event_ms" : "collector_ms")),
      };
      dnsInsert.run(
        `dns:n:${row.rowid}`,
        row.snapshot_id,
        row.collected_at,
        primaryTime(row) || row.collected_at,
        timing.eventTsUtc,
        timing.observedAtUtc,
        timing.displayTsUtc,
        timing.timePrecision,
        text(row.client),
        text(row.client_ip || parseJson(row.raw_json, {}).client_ip || parseJson(row.raw_json, {}).ip),
        identityKey(row),
        text(row.domain),
        text(row.qtype),
        text(row.answer_ip),
        routeForDns(match, row),
        catalogStatus(match),
        status,
        number(row.count || 1),
        riskForDns(match, row),
        confidence(row.confidence, "dns-interest"),
        json({ ...parseJson(row.raw_json, {}), catalog_match: match?.domain || "" })
      );
      dnsCount += 1;
    }
    const liveDnsRows = db
      .prepare("select id, snapshot_id, occurred_at as collected_at, occurred_at, client, client_ip, dns_qname, dns_answer_ip, confidence, evidence_json from events where event_type in ('dns.query','dns.answer') order by occurred_at desc, id desc limit ?")
      .all(liveDnsLimit);
    for (const row of liveDnsRows) {
      const domain = text(row.dns_qname);
      if (!domain) continue;
      const match = catalogMatchFor(domain, catalogMatch);
      const timing = {
        eventTsUtc: text(row.event_ts_utc || row.occurred_at || ""),
        observedAtUtc: text(row.observed_at_utc || row.collected_at),
        displayTsUtc: text(row.display_ts_utc || row.occurred_at || row.collected_at),
        timePrecision: text(row.time_precision || (row.event_ts_utc ? "event_ms" : "collector_ms")),
      };
      dnsInsert.run(
        `dns:e:${row.id}`,
        row.snapshot_id,
        row.collected_at,
        row.occurred_at,
        timing.eventTsUtc,
        timing.observedAtUtc,
        timing.displayTsUtc,
        timing.timePrecision,
        text(row.client),
        text(row.client_ip),
        identityKey(row),
        domain,
        text(parseJson(row.evidence_json, {}).query_type || ""),
        text(row.dns_answer_ip),
        routeForDns(match, row),
        catalogStatus(match),
        queryStatusForDns(match, row),
        1,
        riskForDns(match, row),
        confidence(row.confidence, "dns-interest"),
        json({ ...parseJson(row.evidence_json, {}), catalog_match: match?.domain || "" })
      );
      dnsCount += 1;
    }

    const deviceInsert = db.prepare(`
      insert into device_inventory(device_key, label, ip, hostname, mac, aliases_json, profile, trust_state,
        device_type, channel, route, confidence, last_seen, total_bytes, via_vps_bytes, direct_bytes,
        unknown_bytes, top_domains_json, health_status, risk, evidence_json)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(device_key) do update set
        label = excluded.label,
        ip = coalesce(nullif(excluded.ip, ''), device_inventory.ip),
        hostname = coalesce(nullif(excluded.hostname, ''), device_inventory.hostname),
        mac = coalesce(nullif(excluded.mac, ''), device_inventory.mac),
        aliases_json = excluded.aliases_json,
        profile = coalesce(nullif(excluded.profile, ''), device_inventory.profile),
        trust_state = excluded.trust_state,
        device_type = excluded.device_type,
        channel = excluded.channel,
        route = excluded.route,
        confidence = excluded.confidence,
        last_seen = max(device_inventory.last_seen, excluded.last_seen),
        total_bytes = device_inventory.total_bytes + excluded.total_bytes,
        via_vps_bytes = device_inventory.via_vps_bytes + excluded.via_vps_bytes,
        direct_bytes = device_inventory.direct_bytes + excluded.direct_bytes,
        unknown_bytes = device_inventory.unknown_bytes + excluded.unknown_bytes,
        top_domains_json = excluded.top_domains_json,
        health_status = excluded.health_status,
        risk = excluded.risk,
        evidence_json = excluded.evidence_json
    `);
    const deviceRows = db.prepare("select rowid, * from normalized_devices order by collected_at desc, rowid desc limit ?").all(deviceLimit);
    for (const row of deviceRows) {
      const raw = parseJson(row.raw_json, {});
      const key = identityKey(row);
      const vps = number(row.via_vps_bytes);
      const direct = number(row.direct_bytes);
      const total = number(row.total_bytes);
      const unknown = Math.max(0, total - vps - direct);
      const topMap = flowTopDomains.get(key) || new Map();
      const topDomains = Array.from(topMap.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([domain, bytes]) => ({ domain, bytes }));
      const risk = lower(row.label).includes("unknown") ? "medium" : "low";
      deviceInsert.run(
        key,
        text(row.label || raw.device_label || row.device_id || key),
        text(row.ip || raw.ip || raw.client_ip || ""),
        text(raw.hostname || raw.host || ""),
        text(raw.mac || raw.mac_address || ""),
        json([row.label, row.device_id, raw.profile, raw.client].filter(Boolean)),
        text(raw.profile || row.device_id || ""),
        trustStateFrom(row),
        deviceTypeFrom(row),
        text(row.channel || inferChannel(raw)),
        routeFromSplit(vps, direct, unknown),
        confidence(row.confidence),
        text(row.collected_at),
        total,
        vps,
        direct,
        unknown,
        json(topDomains),
        "unknown",
        risk,
        json({ ...raw, normalized_rowid: row.rowid })
      );
    }
    deviceCount = number(db.prepare("select count(*) as count from device_inventory").get().count);

    const alarmInsert = db.prepare(`
      insert or replace into alarm_events(id, snapshot_id, collected_at, severity, source, title, status,
        evidence, suggested_action, snoozed_until, confidence, risk, evidence_json)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const alertRows = db.prepare("select rowid, * from normalized_alerts order by collected_at desc, rowid desc limit ?").all(alarmLimit);
    for (const row of alertRows) {
      const raw = parseJson(row.raw_json, {});
      const severity = lower(row.severity || raw.severity || "warning");
      const title = text(row.title || raw.title || raw.label || raw.probe || "alert");
      alarmInsert.run(
        `alarm:${row.rowid}`,
        row.snapshot_id,
        row.collected_at,
        severity,
        text(row.snapshot_type || raw.source || "snapshot"),
        title,
        text(row.status || "open"),
        text(row.evidence || raw.evidence || raw.message || ""),
        suggestedActionForAlarm({ title, evidence: row.evidence }),
        "",
        confidence(row.confidence, "unknown"),
        severityRisk(severity),
        json({ ...raw, normalized_rowid: row.rowid })
      );
      alarmCount += 1;
    }

    db.prepare("insert or ignore into console_settings(key, value_json, updated_at) values (?, ?, ?)").run(
      "redaction.default",
      JSON.stringify("standard"),
      now
    );
    db.prepare("insert or ignore into console_settings(key, value_json, updated_at) values (?, ?, ?)").run(
      "live.refresh_ms",
      JSON.stringify(15000),
      now
    );

    rebuildPreparedWindows(db, now);
    const summarySourceVersion = compactSourceVersion(sourceVersion);
    const healthSummary = buildPreparedHealthSummary(db, now);
    const summaryInsert = db.prepare(`
      insert or replace into console_page_summaries(page, source_version, rebuilt_at, payload_json)
      values (?, ?, ?, ?)
    `);
    summaryInsert.run("health_mobile", summarySourceVersion, now, json(healthSummary));
    summaryInsert.run("health_shell", summarySourceVersion, now, json(healthSummary));
    summaryInsert.run("live_mobile", summarySourceVersion, now, json({
      rebuiltAt: now,
      snapshotTimes: healthSummary.snapshotTimes,
      statusCards: healthSummary.statusCards,
      alarmCounts: healthSummary.alarmCounts,
      totals: healthSummary.totals,
    }));
    summaryCount = 3;
  })();

  writeReadModelState(db, "flow_sessions", sourceVersion, flowCount, startedAt);
  writeReadModelState(db, "dns_query_log", sourceVersion, dnsCount, startedAt);
  writeReadModelState(db, "device_inventory", sourceVersion, deviceCount, startedAt);
  writeReadModelState(db, "alarm_events", sourceVersion, alarmCount, startedAt);
  writeReadModelState(db, "console_page_summaries", sourceVersion, summaryCount, startedAt);
  return { flowCount, dnsCount, deviceCount, alarmCount, summaryCount, sourceVersion };
}

function usefulDeviceLabel(row) {
  const label = text(row.label || "");
  const profile = text(row.profile || "");
  if (profile && /^(mobile-client|report-mobile-profile)-\d+$/i.test(label)) return profile;
  return text(row.device_label || row.label || row.profile || row.ip || row.id, "Unknown device");
}

export function resetNormalizedForSnapshot(db, snapshotId) {
  for (const table of [
    "normalized_devices",
    "normalized_flows",
    "normalized_dns",
    "normalized_health",
    "normalized_catalog",
    "normalized_alerts",
    "traffic_facts",
    "router_traffic_rollups",
    "traffic_clients",
    "traffic_dns_links",
    "traffic_attribution_gaps",
    "events",
    "route_decisions",
    "decision_candidates",
  ]) {
    db.prepare(`delete from ${table} where snapshot_id = ?`).run(snapshotId);
  }
}

export function normalizeSnapshot(db, snapshotId, type, collectedAt, payload) {
  resetNormalizedForSnapshot(db, snapshotId);
  if (type === "router_rollups") normalizeRouterRollups(db, snapshotId, type, collectedAt, payload, {
    text,
    number,
    json,
    loadDeviceAttributions,
    buildInventoryNetworkHints,
    resolveOperatorClient,
  });
  if (type === "traffic_facts") normalizeTrafficFacts(db, snapshotId, type, collectedAt, payload);
  if (type === "traffic" || type === "traffic_summary") normalizeTraffic(db, snapshotId, type, collectedAt, payload);
  if (type === "health") normalizeHealth(db, snapshotId, type, collectedAt, payload);
  if (type === "deploy_gate") normalizeDeployGate(db, snapshotId, type, collectedAt, payload);
  if (type === "leaks") normalizeLeaks(db, snapshotId, type, collectedAt, payload);
  if (type === "domains") normalizeDomains(db, snapshotId, type, collectedAt, payload);
  if (type === "dns") normalizeDns(db, snapshotId, collectedAt, payload);
  if (type === "live") normalizeLive(db, snapshotId, type, collectedAt, payload);
}

function normalizeTrafficFacts(db, snapshotId, type, collectedAt, payload) {
  const registry = loadDeviceAttributions();
  const networkHints = buildInventoryNetworkHints(db, registry);
  const deviceInsert = db.prepare(`
    insert into normalized_devices(snapshot_id, snapshot_type, collected_at, device_id, label, ip, hostname, mac, channel, route, confidence, total_bytes, via_vps_bytes, direct_bytes, raw_json)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const clientInsert = db.prepare(`
    insert or replace into traffic_clients(snapshot_id, collected_at, client_key, client_label, client_ip, hostname, mac_hash, channel, route, traffic_class, total_bytes, via_vps_bytes, direct_bytes, unknown_bytes, identity_confidence, evidence_json)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of payload.clients || []) {
    const resolved = resolveOperatorClient({ ...row, raw: row }, registry, networkHints);
    const split = signedByteSplit(row, row.route, aggregateTotalBytes(row));
    const key = resolved.client_key;
    const label = resolved.client_label;
    const channel = resolved.channel;
    clientInsert.run(
      snapshotId,
      collectedAt,
      key,
      label,
      text(row.client_ip || row.ip || ""),
      text(row.hostname || row.host || ""),
      text(row.mac_hash || ""),
      channel,
      text(row.route || routeFromSplit(split.viaVpsBytes, split.directBytes, split.unknownBytes), "Unknown"),
      text(row.traffic_class || flowTrafficClass(row), "client"),
      split.totalBytes,
      split.viaVpsBytes,
      split.directBytes,
      split.unknownBytes,
      text(row.identity_confidence || row.confidence || "unknown", "unknown"),
      json(row)
    );
    deviceInsert.run(
      snapshotId,
      type,
      collectedAt,
      key,
      label,
      text(row.client_ip || row.ip || ""),
      text(row.hostname || row.host || ""),
      "",
      channel,
      text(row.route || routeFromSplit(split.viaVpsBytes, split.directBytes, split.unknownBytes), "Unknown"),
      confidence(row.identity_confidence || row.confidence, "unknown"),
      split.totalBytes,
      split.viaVpsBytes,
      split.directBytes,
      json(row)
    );
  }

  const factInsert = db.prepare(`
    insert or replace into traffic_facts(fact_id, snapshot_id, collected_at, event_ts_utc, observed_at_utc, display_ts_utc, time_precision, client_key, client_label, client_ip, device_key, channel, route, intended_route, traffic_class, destination, destination_kind, destination_ip, destination_port, dns_qname, dns_answer_ip, sni, policy, matched_rule, outbound, bytes, via_vps_bytes, direct_bytes, unknown_bytes, connections, identity_confidence, byte_confidence, destination_confidence, allocation_basis, evidence_level, confidence, evidence_json, protocol, bytes_up, bytes_down, route_source, route_basis, matched_ipset, egress_iface, fwmark, route_verification, route_status, dns_link_id, dns_link_confidence, dns_status, dns_ts_source, accounting_status)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const flowInsert = db.prepare(`
    insert into normalized_flows(snapshot_id, snapshot_type, collected_at, client, channel, destination, route, intended_route, confidence, bytes, connections, protocol, client_ip, destination_ip, destination_port, dns_qname, dns_answer_ip, sni, outbound, matched_rule, rule_set, egress_ip, egress_asn, egress_country, event_ts, event_ts_utc, observed_at_utc, display_ts_utc, time_precision, ts_confidence, source_log, traffic_class, via_vps_bytes, direct_bytes, unknown_bytes, bytes_up, bytes_down, route_source, route_basis, matched_ipset, route_verification, route_status, dns_link_id, dns_link_confidence, dns_status, dns_ts_source, accounting_status, raw_json)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const dnsLinkInsert = db.prepare(`
    insert into traffic_dns_links(snapshot_id, collected_at, client_key, client_ip, domain, destination, link_type, confidence, evidence_json, id, destination_ip, destination_port, protocol, dns_answer_ip, dns_event_ts_utc, dns_ts_source, flow_event_ts_utc)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const dnsLinksById = new Map((payload.dns_links || []).map((link) => [text(link.id || link.dns_link_id), link]));
  for (const row of payload.traffic_facts || []) {
    const timing = timestampContract(row, collectedAt);
    const eventTs = eventTimestamp(row, collectedAt);
    const split = signedByteSplit(row, row.route, aggregateTotalBytes(row));
    const resolved = resolveOperatorClient({ ...row, raw: row }, registry, networkHints);
    const key = resolved.client_key;
    const label = resolved.client_label;
    const channel = resolved.channel;
    const destination = text(row.destination || row.dns_qname || row.sni || row.destination_ip || "", "unknown destination");
    const rowConfidence = confidence(row.confidence || row.byte_confidence, "estimated");
    const trafficClass = text(row.traffic_class || flowTrafficClass(row), "client");
    const factId = text(row.fact_id || `${snapshotId}:${key}:${destination}:${eventTs}`, `${snapshotId}:${key}`);
    factInsert.run(
      factId,
      snapshotId,
      collectedAt,
      timing.eventTsUtc,
      timing.observedAtUtc,
      timing.displayTsUtc,
      timing.timePrecision,
      key,
      label,
      text(row.client_ip || row.ip || ""),
      resolved.device_key || text(row.device_key || ""),
      channel,
      text(row.route || routeFromSplit(split.viaVpsBytes, split.directBytes, split.unknownBytes), "Unknown"),
      intendedRoute(row),
      trafficClass,
      destination,
      text(row.destination_kind || ""),
      destinationIp(row),
      text(row.destination_port || row.port || ""),
      text(row.dns_qname || row.qname || row.domain || ""),
      text(row.dns_answer_ip || row.answer_ip || ""),
      text(row.sni || ""),
      text(row.policy || ""),
      text(row.matched_rule || row.rule || row.rule_name || ""),
      text(row.outbound || row.sing_box_outbound || ""),
      split.totalBytes,
      split.viaVpsBytes,
      split.directBytes,
      split.unknownBytes,
      number(row.connections || row.total_connections),
      text(row.identity_confidence || ""),
      text(row.byte_confidence || row.bytes_confidence || ""),
      text(row.destination_confidence || row.destination_evidence || ""),
      text(row.allocation_basis || ""),
      text(row.evidence_level || ""),
      rowConfidence,
      json(row),
      text(row.protocol || ""),
      number(row.bytes_up || row.out_bytes),
      number(row.bytes_down || row.in_bytes),
      text(row.route_source || ""),
      text(row.route_basis || ""),
      text(row.matched_ipset || ""),
      text(row.egress_iface || ""),
      text(row.fwmark || ""),
      text(row.route_verification || ""),
      routeStatus(row),
      text(row.dns_link_id || ""),
      text(row.dns_link_confidence || ""),
      dnsStatus(row),
      dnsTsSource(row),
      text(row.accounting_status || "ok")
    );
    flowInsert.run(
      snapshotId,
      type,
      collectedAt,
      label,
      channel,
      destination,
      text(row.route || routeFromSplit(split.viaVpsBytes, split.directBytes, split.unknownBytes), "Unknown"),
      intendedRoute(row),
      rowConfidence,
      split.totalBytes,
      number(row.connections || row.total_connections),
      text(row.protocol || ""),
      text(row.client_ip || row.ip || ""),
      destinationIp(row),
      text(row.destination_port || row.port || ""),
      text(row.dns_qname || row.qname || row.domain || ""),
      text(row.dns_answer_ip || row.answer_ip || ""),
      text(row.sni || ""),
      text(row.outbound || row.sing_box_outbound || ""),
      text(row.matched_rule || row.rule || row.rule_name || ""),
      text(row.policy || row.rule_set || ""),
      visibleIp(row),
      text(row.egress_asn || ""),
      text(row.egress_country || ""),
      eventTs,
      timing.eventTsUtc,
      timing.observedAtUtc,
      timing.displayTsUtc,
      timing.timePrecision,
      text(row.ts_confidence || ""),
      (Array.isArray(row.sources) ? row.sources[0] : "") || "",
      trafficClass,
      split.viaVpsBytes,
      split.directBytes,
      split.unknownBytes,
      number(row.bytes_up || row.out_bytes),
      number(row.bytes_down || row.in_bytes),
      text(row.route_source || ""),
      text(row.route_basis || ""),
      text(row.matched_ipset || ""),
      text(row.route_verification || ""),
      routeStatus(row),
      text(row.dns_link_id || ""),
      text(row.dns_link_confidence || ""),
      dnsStatus(row),
      dnsTsSource(row),
      text(row.accounting_status || "ok"),
      json(row)
    );
    syncTrafficIntelligence(db, snapshotId, collectedAt, {
      ...row,
      fact_id: factId,
      client_key: key,
      client_ip: text(row.client_ip || row.ip || ""),
      destination,
      destination_ip: destinationIp(row),
      dns_qname: text(row.dns_qname || row.qname || row.domain || ""),
      traffic_class: trafficClass,
      intended_route: intendedRoute(row),
      route_status: routeStatus(row),
      dns_status: dnsStatus(row),
      dns_ts_source: dnsTsSource(row),
    });
    const domain = text(row.dns_qname || row.domain || "");
    if (domain) {
      const linkedDns = dnsLinksById.get(text(row.dns_link_id || row.link_id)) || row;
      dnsLinkInsert.run(
        snapshotId,
        collectedAt,
        key,
        text(row.client_ip || row.ip || ""),
        text(linkedDns.domain || domain),
        text(linkedDns.destination || destination),
        text(linkedDns.link_type || row.allocation_basis || "dns_link"),
        text(linkedDns.confidence || row.destination_confidence || row.confidence || "unknown"),
        json(linkedDns),
        text(row.dns_link_id || row.link_id || `${snapshotId}:${key}:${domain}:${destinationIp(row)}`),
        text(linkedDns.destination_ip || destinationIp(row)),
        text(linkedDns.destination_port || row.destination_port || row.port || ""),
        text(linkedDns.protocol || row.protocol || ""),
        text(linkedDns.dns_answer_ip || row.dns_answer_ip || row.answer_ip || ""),
        text(linkedDns.dns_event_ts_utc || ""),
        text(linkedDns.dns_ts_source || row.dns_ts_source || ""),
        text(linkedDns.flow_event_ts_utc || row.event_ts_utc || "")
      );
    }
    insertEvent(db, snapshotId, "traffic.fact", eventTs, {
      event_id: factId,
      client: label,
      channel,
      destination,
      route: text(row.route || routeFromSplit(split.viaVpsBytes, split.directBytes, split.unknownBytes), "Unknown"),
      confidence: rowConfidence,
      client_ip: text(row.client_ip || row.ip || ""),
      destination_ip: destinationIp(row),
      destination_port: text(row.destination_port || row.port || ""),
      dns_qname: text(row.dns_qname || row.qname || row.domain || ""),
      dns_answer_ip: text(row.dns_answer_ip || row.answer_ip || ""),
      sni: text(row.sni || ""),
      outbound: text(row.outbound || row.sing_box_outbound || ""),
      matched_rule: text(row.matched_rule || row.rule || row.rule_name || ""),
      rule_set: text(row.policy || row.rule_set || ""),
      timing,
      summary: `${label} -> ${destination} via ${text(row.route || routeFromSplit(split.viaVpsBytes, split.directBytes, split.unknownBytes), "Unknown")}`,
      raw: row,
    });
  }

  const gapInsert = db.prepare(`
    insert or replace into traffic_attribution_gaps(gap_id, snapshot_id, collected_at, scope, client_key, client_label, client_ip, channel, route, destination, bytes, via_vps_bytes, direct_bytes, unknown_bytes, reason, allocation_basis, evidence_level, evidence_json)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of payload.attribution_gaps || []) {
    const split = signedByteSplit(row, row.route, aggregateTotalBytes(row));
    gapInsert.run(
      text(row.gap_id || `${snapshotId}:${row.scope || "gap"}:${row.destination || row.client_key || ""}`, `${snapshotId}:gap`),
      snapshotId,
      collectedAt,
      text(row.scope || "traffic"),
      text(row.client_key || ""),
      text(row.client_label || row.client || ""),
      text(row.client_ip || row.ip || ""),
      text(row.channel || inferChannel(row), "Unknown"),
      text(row.route || routeFromSplit(split.viaVpsBytes, split.directBytes, split.unknownBytes), "Unknown"),
      text(row.destination || row.reason || "attribution gap"),
      split.totalBytes,
      split.viaVpsBytes,
      split.directBytes,
      split.unknownBytes,
      text(row.reason || row.unattributed_reason || ""),
      text(row.allocation_basis || "unattributed_bucket"),
      text(row.evidence_level || "gap"),
      json(row)
    );
  }
  evaluateFilterDecisionsForSnapshot(db, snapshotId, collectedAt);
}

function filterRuleMatchesFact(rule, fact) {
  const kind = text(rule.match_kind).toLowerCase();
  const value = text(rule.match_value).toLowerCase();
  if (!value) return null;
  const domain = text(fact.dns_qname || fact.destination).toLowerCase();
  const destinationIp = text(fact.destination_ip).toLowerCase();
  const clientKey = text(fact.client_key).toLowerCase();
  const route = text(fact.route).toLowerCase();
  const trafficClass = text(fact.traffic_class).toLowerCase();
  if (kind === "domain" && domain === value) return { field: "domain", value: domain };
  if (kind === "domain_suffix" && (domain === value || domain.endsWith(`.${value}`))) return { field: "domain", value: domain };
  if (kind === "ip" && destinationIp === value) return { field: "destination_ip", value: destinationIp };
  if (kind === "client_key" && clientKey === value) return { field: "client_key", value: clientKey };
  if (kind === "route" && route === value) return { field: "route", value: route };
  if (kind === "category" && trafficClass === value) return { field: "traffic_class", value: trafficClass };
  return null;
}

function evaluateFilterDecisionsForSnapshot(db, snapshotId, observedAtUtc) {
  const rules = db.prepare("select * from filter_rules where enabled = 1 and dry_run = 1 order by priority asc, rule_id asc").all();
  if (rules.length === 0) return { decisions: 0 };
  const facts = db.prepare("select * from traffic_facts where snapshot_id = ?").all(snapshotId);
  const insert = db.prepare(`
    insert or replace into filter_decisions(decision_id, snapshot_id, observed_at_utc, rule_id, client_key, client_ip,
      destination, destination_ip, matched_field, matched_value, would_have_action, applied, evidence_json)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `);
  let decisions = 0;
  for (const fact of facts) {
    for (const rule of rules) {
      const match = filterRuleMatchesFact(rule, fact);
      if (!match) continue;
      const decisionId = crypto.createHash("sha256")
        .update([snapshotId, fact.fact_id, rule.rule_id, match.field, match.value].join("|"))
        .digest("hex")
        .slice(0, 32);
      insert.run(
        decisionId,
        String(snapshotId),
        text(fact.observed_at_utc || fact.event_ts_utc || observedAtUtc),
        text(rule.rule_id),
        text(fact.client_key),
        text(fact.client_ip),
        text(fact.destination),
        text(fact.destination_ip),
        match.field,
        match.value,
        text(rule.action || "monitor"),
        json({ dry_run: true, fact_id: fact.fact_id, rule })
      );
      decisions += 1;
    }
  }
  return { decisions };
}

function normalizeTraffic(db, snapshotId, type, collectedAt, payload) {
  const deviceInsert = db.prepare(`
    insert into normalized_devices(snapshot_id, snapshot_type, collected_at, device_id, label, ip, hostname, mac, channel, route, confidence, total_bytes, via_vps_bytes, direct_bytes, raw_json)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of [...(payload.devices || []), ...(payload.home_reality_clients || [])]) {
    deviceInsert.run(
      snapshotId,
      type,
      collectedAt,
      text(row.id || row.ip || row.profile || row.label, "unknown-device"),
      usefulDeviceLabel(row),
      text(row.ip || row.client_ip || ""),
      text(row.hostname || row.host || ""),
      text(row.mac || row.mac_address || ""),
      inferChannel(row),
      text(row.route || "Unknown"),
      confidence(row.confidence, "estimated"),
      number(row.total_bytes),
      number(row.via_vps_bytes || row.reality_bytes),
      number(row.direct_bytes || row.wan_bytes),
      json(row)
    );
  }

  const flowInsert = db.prepare(`
    insert into normalized_flows(snapshot_id, snapshot_type, collected_at, client, channel, destination, route, confidence, bytes, connections, protocol, client_ip, destination_ip, destination_port, dns_qname, dns_answer_ip, sni, outbound, matched_rule, rule_set, egress_ip, egress_asn, egress_country, event_ts, event_ts_utc, observed_at_utc, display_ts_utc, time_precision, ts_confidence, source_log, traffic_class, via_vps_bytes, direct_bytes, unknown_bytes, raw_json)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of [...(payload.app_flows || []), ...(payload.destinations || []), ...(payload.route_events || [])]) {
    const route = text(row.route || routeFromTraffic(row));
    const channel = inferChannel(row);
    const client = text(row.canonical_hint || row.profile || row.client || row.label || row.channel || "");
    const destination = text(row.destination || row.domain || row.app || row.family || "");
    const rowConfidence = confidence(row.confidence, "estimated");
    const eventTs = eventTimestamp(row, collectedAt);
    const timing = timestampContract(row, collectedAt);
    const rawRefs = Array.isArray(row.raw_refs) ? row.raw_refs : [];
    const bytes = aggregateTotalBytes(row);
    const split = signedByteSplit(row, route, bytes);
    const trafficClass = flowTrafficClass(row);
    maybeLogCounterDrift(db, collectedAt, { ...row, client, destination }, split);
    flowInsert.run(
      snapshotId,
      type,
      collectedAt,
      client,
      channel,
      destination,
      route,
      rowConfidence,
      bytes,
      number(row.connections || row.total_connections),
      text(row.protocol || ""),
      text(row.client_ip || row.ip || ""),
      destinationIp(row),
      text(row.destination_port || row.port || ""),
      text(row.dns_qname || row.qname || row.domain || ""),
      text(row.dns_answer_ip || row.answer_ip || ""),
      text(row.sni || ""),
      text(row.sing_box_outbound || row.outbound || outboundFor(row)),
      text(row.matched_rule || row.rule || row.rule_name || row.catalog_rule || ""),
      text(row.rule_set || ""),
      visibleIp(row),
      text(row.egress_asn || row.asn || ""),
      text(row.egress_country || row.country || ""),
      eventTs,
      timing.eventTsUtc,
      timing.observedAtUtc,
      timing.displayTsUtc,
      timing.timePrecision,
      text(row.ts_confidence || ""),
      text(rawRefs[0]?.source_log || rawRefs[0]?.source || ""),
      trafficClass,
      split.viaVpsBytes,
      split.directBytes,
      split.unknownBytes,
      json(row)
    );
    insertEvent(db, snapshotId, "flow.observed", eventTs, {
      event_id: text(row.event_id || ""),
      client,
      channel,
      destination,
      route,
      confidence: rowConfidence,
      client_ip: text(row.client_ip || row.ip || ""),
      destination_ip: destinationIp(row),
      destination_port: text(row.destination_port || row.port || ""),
      dns_qname: text(row.dns_qname || row.qname || row.domain || ""),
      dns_answer_ip: text(row.dns_answer_ip || row.answer_ip || ""),
      sni: text(row.sni || ""),
      outbound: text(row.sing_box_outbound || row.outbound || outboundFor(row)),
      matched_rule: text(row.matched_rule || row.rule || row.rule_name || row.catalog_rule || ""),
      rule_set: text(row.rule_set || ""),
      egress_ip: visibleIp(row),
      egress_asn: text(row.egress_asn || row.asn || ""),
      egress_country: text(row.egress_country || row.country || ""),
      source_log: text(rawRefs[0]?.source_log || rawRefs[0]?.source || ""),
      timing,
      summary: `${client || "client"} -> ${destination || "destination"} via ${route}`,
      raw: row,
    });
    insertRouteDecision(db, snapshotId, eventTs, {
      event_id: text(row.event_id || ""),
      client,
      channel,
      destination,
      route,
      outbound: text(row.sing_box_outbound || row.outbound || outboundFor(row)),
      matched_rule: text(row.matched_rule || row.rule || row.rule_name || row.catalog_rule || ""),
      visible_ip: visibleIp(row),
      client_ip: text(row.client_ip || row.ip || ""),
      destination_ip: destinationIp(row),
      destination_port: text(row.destination_port || row.port || ""),
      dns_qname: text(row.dns_qname || row.qname || row.domain || ""),
      dns_answer_ip: text(row.dns_answer_ip || row.answer_ip || ""),
      sni: text(row.sni || ""),
      rule_set: text(row.rule_set || ""),
      egress_asn: text(row.egress_asn || row.asn || ""),
      egress_country: text(row.egress_country || row.country || ""),
      source_log: text(rawRefs[0]?.source_log || rawRefs[0]?.source || ""),
      timing,
      confidence: rowConfidence,
      raw: row,
    });
  }

  for (const row of payload.routing_mistakes || []) {
    insertAlert(db, snapshotId, type, collectedAt, {
      severity: text(row.severity || "warning").toLowerCase(),
      title: text(row.kind || "routing review"),
      status: "WARN",
      confidence: confidence(row.confidence, "estimated"),
      evidence: text(row.destination || row.evidence || ""),
      raw: row,
    });
  }
}

function normalizeHealth(db, snapshotId, type, collectedAt, payload) {
  const insert = db.prepare(`
    insert into normalized_health(snapshot_id, collected_at, check_name, status, confidence, detail, raw_json)
    values (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of payload.checks || []) {
    insert.run(
      snapshotId,
      collectedAt,
      text(row.name || row.check || row.label, "health-check"),
      text(row.status || "UNKNOWN").toUpperCase(),
      confidence(row.confidence, payload.confidence || "unknown"),
      text(row.detail || row.message || row.evidence || ""),
      json(row)
    );
  }
  for (const [name, status] of Object.entries(payload.services || {})) {
    insert.run(snapshotId, collectedAt, name, text(status || "UNKNOWN").toUpperCase(), confidence(payload.confidence), "", json({ name, status }));
  }
}

function normalizeDeployGate(db, snapshotId, type, collectedAt, payload) {
  const insert = db.prepare(`
    insert into normalized_health(snapshot_id, collected_at, check_name, status, confidence, detail, raw_json)
    values (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of payload.checks || []) {
    insert.run(
      snapshotId,
      collectedAt,
      text(row.id || row.name || row.check || row.label, "deploy-gate-check"),
      text(row.status || "UNKNOWN").toUpperCase(),
      confidence(row.confidence, payload.overall_status === "OK" ? "exact" : "mixed"),
      text(row.summary || row.message || row.evidence || ""),
      json(row)
    );
  }
}

function normalizeLeaks(db, snapshotId, type, collectedAt, payload) {
  for (const row of payload.leaks || []) {
    insertAlert(db, snapshotId, type, collectedAt, {
      severity: text(row.severity || "warning").toLowerCase(),
      title: text(row.label || row.probe || "leak signal"),
      status: text(row.status || "WARN"),
      confidence: confidence(row.confidence, "exact"),
      evidence: text(row.evidence || row.message || ""),
      raw: row,
    });
  }
  const healthInsert = db.prepare(`
    insert into normalized_health(snapshot_id, collected_at, check_name, status, confidence, detail, raw_json)
    values (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of payload.checks || []) {
    healthInsert.run(
      snapshotId,
      collectedAt,
      text(row.probe || row.name, "leak-check"),
      text(row.status || "UNKNOWN").toUpperCase(),
      confidence(row.confidence, "exact"),
      text(row.message || row.evidence || ""),
      json(row)
    );
  }
}

function normalizeDomains(db, snapshotId, type, collectedAt, payload) {
  const insert = db.prepare(`
    insert into normalized_catalog(snapshot_id, collected_at, domain, entry_type, source, confidence, raw_json)
    values (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const entryType of ["managed", "auto", "candidates", "blocked"]) {
    const rows = Array.isArray(payload[entryType])
      ? payload[entryType]
      : payload[entryType] && typeof payload[entryType] === "object"
        ? Object.values(payload[entryType])
        : [];
    for (const row of rows) {
      const domain = typeof row === "string" ? row : row.domain || row.name || row.value;
      if (!domain) continue;
      const raw = typeof row === "string" ? { domain: row } : row;
      insert.run(
        snapshotId,
        collectedAt,
        text(domain),
        entryType,
        text(raw.source || payload.source?.command || "domain-report"),
        confidence(raw.confidence, entryType === "candidates" ? "dns-interest" : payload.confidence),
        json(raw)
      );
    }
  }
}

function normalizeDns(db, snapshotId, collectedAt, payload) {
  const insert = db.prepare(`
    insert into normalized_dns(snapshot_id, collected_at, client, client_ip, domain, qtype, count, answer_ip, event_ts, event_ts_utc, observed_at_utc, display_ts_utc, time_precision, ts_confidence, confidence, raw_json)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of payload.queries || []) {
    const client = text(row.client || row.client_ip || row.ip || "");
    const clientIp = text(row.client_ip || row.ip || "");
    const domain = text(row.domain || row.qname || row.query || "");
    const rowConfidence = confidence(row.confidence, "dns-interest");
    const eventTs = eventTimestamp(row, collectedAt);
    const timing = timestampContract(row, collectedAt);
    insert.run(
      snapshotId,
      collectedAt,
      client,
      clientIp,
      domain,
      text(row.qtype || row.query_type || row.type || ""),
      number(row.count || row.queries || 1),
      text(row.answer_ip || row.dns_answer_ip || ""),
      eventTs,
      timing.eventTsUtc,
      timing.observedAtUtc,
      timing.displayTsUtc,
      timing.timePrecision,
      text(row.ts_confidence || ""),
      rowConfidence,
      json(row)
    );
    insertEvent(db, snapshotId, "dns.query", eventTs, {
      event_id: text(row.event_id || ""),
      client,
      channel: inferChannel(row),
      destination: domain,
      route: "Unknown",
      confidence: rowConfidence,
      client_ip: text(row.client_ip || row.ip || ""),
      dns_qname: domain,
      dns_answer_ip: text(row.answer_ip || row.dns_answer_ip || ""),
      source_log: text(row.raw_refs?.[0]?.source_log || row.raw_refs?.[0]?.source || ""),
      timing,
      summary: `${client || "client"} queried ${domain || "domain"}`,
      raw: row,
    });
  }
}

function normalizeLive(db, snapshotId, type, collectedAt, payload) {
  const events = Array.isArray(payload.events) ? payload.events : [];
  for (const row of events) {
    const route = text(row.route || row.route_decision || "Unknown");
    const destination = text(row.destination || row.dns_qname || row.domain || "");
    const occurredAt = eventTimestamp(row, collectedAt);
    const rawRefs = Array.isArray(row.raw_refs) ? row.raw_refs : [];
    insertEvent(db, snapshotId, text(row.event_type || "live.event"), occurredAt, {
      event_id: text(row.event_id || ""),
      client: text(row.client || row.client_ip || ""),
      client_ip: text(row.client_ip || ""),
      channel: inferChannel(row),
      destination,
      destination_ip: destinationIp(row),
      destination_port: text(row.destination_port || ""),
      route,
      confidence: confidence(row.confidence, "unknown"),
      dns_qname: text(row.dns_qname || ""),
      dns_answer_ip: text(row.dns_answer_ip || row.answer_ip || ""),
      sni: text(row.sni || ""),
      outbound: text(row.sing_box_outbound || row.outbound || ""),
      matched_rule: text(row.matched_rule || ""),
      rule_set: text(row.rule_set || ""),
      egress_ip: text(row.egress_ip || ""),
      egress_asn: text(row.egress_asn || ""),
      egress_country: text(row.egress_country || ""),
      source_log: text(rawRefs[0]?.source_log || rawRefs[0]?.source || ""),
      summary: text(row.summary || destination || row.event_type || "live event"),
      raw: row,
    });
    if (row.event_type === "route.decision" || row.route_decision || row.sing_box_outbound) {
      insertRouteDecision(db, snapshotId, occurredAt, {
        event_id: text(row.event_id || ""),
        client: text(row.client || row.client_ip || ""),
        client_ip: text(row.client_ip || ""),
        channel: inferChannel(row),
        destination,
        destination_ip: destinationIp(row),
        destination_port: text(row.destination_port || ""),
        route,
        outbound: text(row.sing_box_outbound || row.outbound || ""),
        matched_rule: text(row.matched_rule || ""),
        visible_ip: text(row.egress_ip || ""),
        dns_qname: text(row.dns_qname || ""),
        dns_answer_ip: text(row.dns_answer_ip || row.answer_ip || ""),
        sni: text(row.sni || ""),
        rule_set: text(row.rule_set || ""),
        egress_asn: text(row.egress_asn || ""),
        egress_country: text(row.egress_country || ""),
        source_log: text(rawRefs[0]?.source_log || rawRefs[0]?.source || ""),
        confidence: confidence(row.confidence, "unknown"),
        raw: row,
      });
    }
  }
  if (payload.cursor?.next) {
    db.prepare(
      `insert into live_cursors(source, cursor, updated_at) values (?, ?, ?)
       on conflict(source) do update set cursor = excluded.cursor, updated_at = excluded.updated_at`
    ).run("live-events-report", payload.cursor.next, new Date().toISOString());
  }
}

function insertAlert(db, snapshotId, type, collectedAt, row) {
  db.prepare(`
    insert into normalized_alerts(snapshot_id, snapshot_type, collected_at, severity, title, status, confidence, evidence, raw_json)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    snapshotId,
    type,
    collectedAt,
    row.severity,
    row.title,
    row.status,
    row.confidence,
    row.evidence,
    json(row.raw)
  );
}

function insertEvent(db, snapshotId, eventType, occurredAt, row) {
  const timing = row.timing || timestampContract(row.raw || row, occurredAt);
  db.prepare(`
    insert or ignore into events(snapshot_id, event_type, occurred_at, event_ts_utc, observed_at_utc, display_ts_utc, time_precision, client, channel, destination, route, confidence, summary, event_id, client_ip, destination_ip, destination_port, dns_qname, dns_answer_ip, sni, outbound, matched_rule, rule_set, egress_ip, egress_asn, egress_country, source_log, evidence_json)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    snapshotId,
    eventType,
    occurredAt,
    timing.eventTsUtc,
    timing.observedAtUtc,
    timing.displayTsUtc,
    timing.timePrecision,
    row.client || "",
    row.channel || "Unknown",
    row.destination || "",
    row.route || "Unknown",
    row.confidence || "unknown",
    row.summary || "",
    row.event_id || "",
    row.client_ip || "",
    row.destination_ip || "",
    row.destination_port || "",
    row.dns_qname || "",
    row.dns_answer_ip || "",
    row.sni || "",
    row.outbound || "",
    row.matched_rule || "",
    row.rule_set || "",
    row.egress_ip || "",
    row.egress_asn || "",
    row.egress_country || "",
    row.source_log || "",
    json(row.raw || row)
  );
}

function insertRouteDecision(db, snapshotId, occurredAt, row) {
  const timing = row.timing || timestampContract(row.raw || row, occurredAt);
  db.prepare(`
    insert or ignore into route_decisions(snapshot_id, occurred_at, event_ts_utc, observed_at_utc, display_ts_utc, time_precision, client, channel, destination, route, outbound, matched_rule, visible_ip, event_id, client_ip, destination_ip, destination_port, dns_qname, dns_answer_ip, sni, rule_set, egress_asn, egress_country, source_log, confidence, evidence_json)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    snapshotId,
    occurredAt,
    timing.eventTsUtc,
    timing.observedAtUtc,
    timing.displayTsUtc,
    timing.timePrecision,
    row.client || "",
    row.channel || "Unknown",
    row.destination || "",
    row.route || "Unknown",
    row.outbound || "",
    row.matched_rule || "",
    row.visible_ip || "",
    row.event_id || "",
    row.client_ip || "",
    row.destination_ip || "",
    row.destination_port || "",
    row.dns_qname || "",
    row.dns_answer_ip || "",
    row.sni || "",
    row.rule_set || "",
    row.egress_asn || "",
    row.egress_country || "",
    row.source_log || "",
    row.confidence || "unknown",
    json(row.raw || row)
  );
}
