import { classifyDestination } from "../../../../traffic-intelligence/lib/classification.mjs";
import { bucketStartUtc, toMskKey, toUtcIsoFromMskKey } from "../../src/lib/time/window.mjs";

export const CLIENT_TRAFFIC_LANE_TABLES = [
  "client_traffic_by_lane",
  "client_destination_by_lane",
  "client_route_evidence_defects",
];

const layerMeta = {
  "5min": {
    sourceTable: "client_destination_traffic_5min",
    sourceTime: "bucket_start_utc",
    sourceKey: "bucket_msk_key",
    granularity: "5min",
  },
  hour: {
    sourceTable: "client_destination_traffic_hourly",
    sourceTime: "hour_start_utc",
    sourceKey: "hour_msk_key",
    granularity: "hour",
  },
  day: {
    sourceTable: "client_destination_traffic_daily",
    sourceTime: "day_start_utc",
    sourceKey: "day_msk_key",
    granularity: "day",
  },
  week: {
    sourceTable: "client_destination_traffic_weekly",
    sourceTime: "week_start_utc",
    sourceKey: "week_msk_key",
    granularity: "week",
  },
  month: {
    sourceTable: "client_destination_traffic_monthly",
    sourceTime: "month_start_utc",
    sourceKey: "month_msk_key",
    granularity: "month",
  },
};

function text(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function json(value) {
  return JSON.stringify(value || []);
}

function isoPlusMs(iso, ms) {
  return new Date(Date.parse(iso) + ms).toISOString();
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

function routeFromSplit(row) {
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

function isIpLiteral(value) {
  const normalized = text(value).trim().toLowerCase();
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(normalized)) return true;
  return normalized.includes(":") && /^[0-9a-f:.]+$/i.test(normalized);
}

function defaultLane(row) {
  if (row.ip_traffic_lane_hint && (!row.traffic_lane || row.traffic_lane === "unknown_review")) return row.ip_traffic_lane_hint;
  if (row.traffic_lane) return row.traffic_lane;
  if (["client", "personal_cloud"].includes(text(row.traffic_class))) return "client_observed";
  if (row.traffic_class === "service_background") return "service_system";
  return "unknown_review";
}

function defaultDnsCategory(row, lane) {
  if (row.ip_dns_category_hint && (!row.dns_category || row.dns_category === "unknown_ip_only" || row.dns_category === "unknown_domain")) return row.ip_dns_category_hint;
  if (row.dns_category) return row.dns_category;
  if (lane === "client_observed" && row.traffic_class === "personal_cloud") return "personal_cloud";
  if (lane === "client_observed") return "user_content";
  if (lane === "service_system") return "system_background";
  return isIpLiteral(row.destination_key) ? "unknown_ip_only" : "unknown_domain";
}

function defaultDecisionHint(row, lane) {
  if (row.ip_decision_hint && (!row.decision_hint || row.decision_hint === "ask_user")) return row.ip_decision_hint;
  if (row.decision_hint) return row.decision_hint;
  if (lane === "unknown_review") return "ask_user";
  if (lane === "service_system") return "allow";
  return "monitor";
}

function enrichmentStatus(row) {
  if (row.ip_cache_key && row.enrichment_key && text(row.category).startsWith("unknown.")) return text(row.ip_lookup_status || row.ip_source || "ip_cache", "ip_cache");
  if (row.enrichment_key) return text(row.enrichment_source || "local_rules", "local_rules");
  if (row.ip_cache_key) return text(row.ip_lookup_status || row.ip_source || "ip_cache", "ip_cache");
  return "missing";
}

function preferKnown(current, fallback, unknownValues = []) {
  const value = text(current);
  if (!value) return fallback;
  if (value.startsWith("unknown.")) return fallback || current;
  if (unknownValues.includes(value)) return fallback || current;
  return current;
}

function normalizeLaneRow(row, layer) {
  const fallback = (!row.enrichment_key || text(row.category).startsWith("unknown.") || text(row.traffic_lane) === "unknown_review") && !row.ip_cache_key
    ? classifyDestination({ destination: row.destination_key, traffic_class: row.traffic_class })
    : null;
  const classified = {
    ...row,
    category: preferKnown(row.category, fallback?.category),
    provider: row.provider || fallback?.provider,
    traffic_class: preferKnown(row.traffic_class, fallback?.traffic_class, ["unclassified"]),
    traffic_lane: preferKnown(row.traffic_lane, fallback?.traffic_lane, ["unknown_review"]),
    dns_category: preferKnown(row.dns_category, fallback?.dns_category, ["unknown_domain", "unknown_ip_only"]),
    traffic_role: preferKnown(row.traffic_role, fallback?.traffic_role, ["unknown"]),
    traffic_purpose: preferKnown(row.traffic_purpose, fallback?.traffic_purpose, ["unknown"]),
    decision_hint: preferKnown(row.decision_hint, fallback?.decision_hint, ["ask_user"]),
    enrichment_source: row.enrichment_source || (fallback ? "local_rules" : ""),
  };
  const lane = defaultLane(classified);
  const dnsCategory = defaultDnsCategory(classified, lane);
  const decisionHint = defaultDecisionHint(classified, lane);
  return {
    bucket_granularity: layer,
    bucket_key: row.bucket_key,
    bucket_start_utc: row.bucket_start_utc,
    client_key: text(row.client_key),
    client_label: text(row.client_label || row.client_key),
    channel: text(row.channel, "Unknown"),
    route: text(row.route, "Unknown"),
    confidence: text(row.confidence, "unknown"),
    traffic_class: text(classified.traffic_class || row.traffic_class, "unclassified"),
    traffic_lane: lane,
    dns_category: dnsCategory,
    decision_hint: decisionHint,
    destination_key: text(row.destination_key),
    destination_label: text(row.destination_label || row.destination_key),
    category: text((text(classified.category).startsWith("unknown.") && classified.ip_category_hint ? classified.ip_category_hint : classified.category) || classified.ip_category_hint || "unknown"),
    provider: text(classified.provider || classified.ip_provider || ""),
    traffic_role: text(classified.traffic_role || "unknown"),
    traffic_purpose: text(classified.traffic_purpose || "unknown"),
    source: text(classified.enrichment_source || classified.ip_source || ""),
    enrichment_status: enrichmentStatus(classified),
    bytes: number(row.bytes),
    via_vps_bytes: number(row.via_vps_bytes),
    direct_bytes: number(row.direct_bytes),
    unknown_bytes: number(row.unknown_bytes),
    flows: number(row.flows || 1),
    first_seen_utc: text(row.bucket_start_utc),
    last_seen_utc: text(row.bucket_start_utc),
  };
}

function routeEvidenceFor(row) {
  const intendedRoute = text(row.intended_route).toLowerCase();
  const route = text(row.route).toLowerCase();
  const verification = text(row.route_verification).toLowerCase();
  if (verification === "counter_allocated" || verification === "ingress_route_allocated") return "counter_allocated";
  if (verification === "mismatch") return "mismatch";
  if (number(row.unknown_bytes) <= 0) return "proven";
  if (verification === "intent_only" && intendedRoute === "vps") return "intent_only_vps";
  if (verification === "intent_only" && intendedRoute === "direct") return "intent_only_direct";
  if (verification === "intent_only" && route === "vps") return "intent_only_vps";
  if (verification === "intent_only" && route === "direct") return "intent_only_direct";
  return "unknown_route";
}

function routeClassificationFor(row, ipCache) {
  const destination = text(row.destination_key || row.destination || row.destination_ip || "");
  const fallback = classifyDestination({ destination, traffic_class: row.traffic_class });
  const cached = isIpLiteral(destination) ? ipCache.get(destination) : null;
  return {
    destination_key: destination,
    destination_label: text(row.destination_label || row.destination || destination),
    traffic_lane: text(cached?.traffic_lane_hint || fallback?.traffic_lane || "unknown_review"),
    dns_category: text(cached?.dns_category_hint || fallback?.dns_category || (isIpLiteral(destination) ? "unknown_ip_only" : "unknown_domain")),
    category: text(cached?.category_hint || fallback?.category || "unknown"),
    provider: text(cached?.provider || fallback?.provider || ""),
  };
}

function addMetrics(target, row) {
  target.bytes += number(row.bytes);
  target.via_vps_bytes += number(row.via_vps_bytes);
  target.direct_bytes += number(row.direct_bytes);
  target.unknown_bytes += number(row.unknown_bytes);
  target.flows += number(row.flows || 1);
  if (!target.first_seen_utc || row.first_seen_utc < target.first_seen_utc) target.first_seen_utc = row.first_seen_utc;
  if (!target.last_seen_utc || row.last_seen_utc > target.last_seen_utc) target.last_seen_utc = row.last_seen_utc;
}

function addDestination(target, row) {
  const key = row.destination_key || "unknown destination";
  const current = target.destinationMap.get(key) || {
    destination_key: key,
    destination_label: row.destination_label || key,
    traffic_lane: row.traffic_lane,
    dns_category: row.dns_category,
    decision_hint: row.decision_hint,
    enrichment_status: row.enrichment_status,
    bytes: 0,
    via_vps_bytes: 0,
    direct_bytes: 0,
    unknown_bytes: 0,
    flows: 0,
  };
  addMetrics(current, row);
  target.destinationMap.set(key, current);
}

function topDestinations(row) {
  return Array.from(row.destinationMap.values())
    .sort((a, b) => number(b.bytes) - number(a.bytes) || String(a.destination_key).localeCompare(String(b.destination_key)))
    .slice(0, 10)
    .map((destination) => ({
      destination_key: destination.destination_key,
      destination_label: destination.destination_label,
      traffic_lane: destination.traffic_lane,
      dns_category: destination.dns_category,
      decision_hint: destination.decision_hint,
      enrichment_status: destination.enrichment_status,
      bytes: destination.bytes,
      via_vps_bytes: destination.via_vps_bytes,
      direct_bytes: destination.direct_bytes,
      unknown_bytes: destination.unknown_bytes,
      flows: destination.flows,
    }));
}

function confidenceFor(values) {
  const unique = Array.from(values).filter(Boolean);
  if (unique.length === 1) return unique[0];
  return unique.length > 1 ? "mixed" : "unknown";
}

function enrichmentStatusFor(values) {
  const unique = Array.from(values).filter(Boolean);
  if (unique.length === 1) return unique[0];
  return unique.length > 1 ? "mixed" : "missing";
}

function insertGroupedRows(db, detailRows, layer, updatedAt) {
  const insertDetail = db.prepare(`
    insert into client_destination_by_lane(bucket_granularity, bucket_key, bucket_start_utc, client_key, client_label,
      channel, route, confidence, traffic_class, traffic_lane, dns_category, decision_hint, destination_key,
      destination_label, category, provider, traffic_role, traffic_purpose, source, enrichment_status,
      bytes, via_vps_bytes, direct_bytes, unknown_bytes, flows, first_seen_utc, last_seen_utc, updated_at_utc)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSummary = db.prepare(`
    insert into client_traffic_by_lane(bucket_granularity, bucket_key, bucket_start_utc, client_key, client_label,
      channel, route, confidence, traffic_class, traffic_lane, dns_category, decision_hint, enrichment_status,
      bytes, via_vps_bytes, direct_bytes, unknown_bytes, flows, destinations_count, top_destinations_json,
      first_seen_utc, last_seen_utc, updated_at_utc)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const detailGrouped = new Map();
  const laneGrouped = new Map();
  const allGrouped = new Map();

  for (const sourceRow of detailRows) {
    const row = normalizeLaneRow(sourceRow, layer);
    if (!row.client_key || !row.destination_key) continue;
    const detailKey = [
      row.bucket_granularity,
      row.bucket_key,
      row.client_key,
      row.channel,
      row.route,
      row.confidence,
      row.traffic_class,
      row.traffic_lane,
      row.dns_category,
      row.decision_hint,
      row.destination_key,
    ].join("|");
    const detail = detailGrouped.get(detailKey) || { ...row, bytes: 0, via_vps_bytes: 0, direct_bytes: 0, unknown_bytes: 0, flows: 0 };
    addMetrics(detail, row);
    if (row.last_seen_utc > detail.last_seen_utc) {
      detail.client_label = row.client_label;
      detail.destination_label = row.destination_label;
    }
    detailGrouped.set(detailKey, detail);

    const laneKey = [
      row.bucket_granularity,
      row.bucket_key,
      row.client_key,
      row.channel,
      row.route,
      row.confidence,
      row.traffic_class,
      row.traffic_lane,
      row.dns_category,
      row.decision_hint,
    ].join("|");
    const lane = laneGrouped.get(laneKey) || {
      ...row,
      destinationMap: new Map(),
      bytes: 0,
      via_vps_bytes: 0,
      direct_bytes: 0,
      unknown_bytes: 0,
      flows: 0,
    };
    addMetrics(lane, row);
    addDestination(lane, row);
    laneGrouped.set(laneKey, lane);

    const allKey = [row.bucket_granularity, row.bucket_key, row.client_key, row.channel].join("|");
    const all = allGrouped.get(allKey) || {
      ...row,
      route: "Unknown",
      confidence: "unknown",
      traffic_class: "all",
      traffic_lane: "all",
      dns_category: "all",
      decision_hint: "all",
      enrichment_status: "missing",
      confidenceValues: new Set(),
      enrichmentValues: new Set(),
      destinationMap: new Map(),
      bytes: 0,
      via_vps_bytes: 0,
      direct_bytes: 0,
      unknown_bytes: 0,
      flows: 0,
    };
    addMetrics(all, row);
    addDestination(all, row);
    all.confidenceValues.add(row.confidence);
    all.enrichmentValues.add(row.enrichment_status);
    allGrouped.set(allKey, all);
  }

  for (const row of detailGrouped.values()) {
    insertDetail.run(row.bucket_granularity, row.bucket_key, row.bucket_start_utc, row.client_key, row.client_label,
      row.channel, row.route, row.confidence, row.traffic_class, row.traffic_lane, row.dns_category, row.decision_hint,
      row.destination_key, row.destination_label, row.category, row.provider, row.traffic_role, row.traffic_purpose,
      row.source, row.enrichment_status, row.bytes, row.via_vps_bytes, row.direct_bytes, row.unknown_bytes,
      row.flows, row.first_seen_utc, row.last_seen_utc, updatedAt);
  }
  for (const row of [...laneGrouped.values(), ...allGrouped.values()]) {
    row.route = row.traffic_lane === "all" ? routeFromSplit(row) : row.route;
    row.confidence = row.traffic_lane === "all" ? confidenceFor(row.confidenceValues || []) : row.confidence;
    row.enrichment_status = row.traffic_lane === "all" ? enrichmentStatusFor(row.enrichmentValues || []) : row.enrichment_status;
    const destinations = topDestinations(row);
    insertSummary.run(row.bucket_granularity, row.bucket_key, row.bucket_start_utc, row.client_key, row.client_label,
      row.channel, row.route, row.confidence, row.traffic_class, row.traffic_lane, row.dns_category, row.decision_hint,
      row.enrichment_status, row.bytes, row.via_vps_bytes, row.direct_bytes, row.unknown_bytes, row.flows,
      row.destinationMap.size, json(destinations), row.first_seen_utc, row.last_seen_utc, updatedAt);
  }
}

function sourceRows(db, meta, startUtc, endUtc) {
  return db.prepare(`
    select d.${meta.sourceKey} as bucket_key,
           d.${meta.sourceTime} as bucket_start_utc,
           d.client_key,
           d.client_label,
           d.channel,
           d.route,
           d.confidence,
           d.traffic_class,
           d.destination_key,
           d.bytes,
           d.via_vps_bytes,
           d.direct_bytes,
           d.unknown_bytes,
           d.flows,
           e.destination_key as enrichment_key,
           e.value as destination_label,
           e.category,
           e.provider,
           e.traffic_lane,
           e.dns_category,
           e.traffic_role,
           e.traffic_purpose,
           e.decision_hint,
           e.source as enrichment_source,
           c.ip as ip_cache_key,
           c.provider as ip_provider,
           c.category_hint as ip_category_hint,
           c.traffic_lane_hint as ip_traffic_lane_hint,
           c.dns_category_hint as ip_dns_category_hint,
           c.decision_hint as ip_decision_hint,
           c.lookup_status as ip_lookup_status,
           c.source as ip_source
      from ${meta.sourceTable} d
      left join destination_enrichment e on e.destination_key = lower(d.destination_key)
      left join ip_enrichment_cache c on c.ip = lower(d.destination_key)
     where d.${meta.sourceTime} >= ?
       and d.${meta.sourceTime} < ?
       and coalesce(d.destination_key, '') != ''
  `).all(startUtc, endUtc);
}

function writeAggregateState(db, model, windowKey, builtUntilUtc, sourceVersion, status, detail, updatedAt) {
  db.prepare(`
    insert into aggregate_state(model, window_key, source_snapshot_id, built_until_utc, status, detail_json, updated_at_utc)
    values (?, ?, ?, ?, ?, ?, ?)
    on conflict(model, window_key) do update set
      source_snapshot_id = excluded.source_snapshot_id,
      built_until_utc = excluded.built_until_utc,
      status = excluded.status,
      detail_json = excluded.detail_json,
      updated_at_utc = excluded.updated_at_utc
  `).run(model, windowKey, sourceVersion, builtUntilUtc, status, JSON.stringify(detail || {}), updatedAt);
}

function writeLaneStates(db, sourceVersion, dirtyStartUtc, dirtyEndUtc, updatedAt) {
  for (const table of CLIENT_TRAFFIC_LANE_TABLES) {
    const rows = db.prepare(`
      select bucket_granularity, count(*) as rows, coalesce(sum(bytes), 0) as bytes,
             min(bucket_start_utc) as min_ts, max(bucket_start_utc) as max_ts
        from ${table}
       where bucket_start_utc >= ?
         and bucket_start_utc < ?
       group by bucket_granularity
    `).all(dirtyStartUtc, dirtyEndUtc);
    const total = rows.reduce((acc, row) => {
      acc.rows += number(row.rows);
      acc.bytes += number(row.bytes);
      if (!acc.min_ts || (row.min_ts && row.min_ts < acc.min_ts)) acc.min_ts = row.min_ts || acc.min_ts;
      if (!acc.max_ts || (row.max_ts && row.max_ts > acc.max_ts)) acc.max_ts = row.max_ts || acc.max_ts;
      return acc;
    }, { rows: 0, bytes: 0, min_ts: "", max_ts: "" });
    writeAggregateState(db, table, "all", dirtyEndUtc, sourceVersion, "ok", { ...total, range_start_utc: dirtyStartUtc, range_end_utc: dirtyEndUtc }, updatedAt);
    for (const row of rows) {
      writeAggregateState(db, table, row.bucket_granularity, row.max_ts || dirtyEndUtc, sourceVersion, "ok", {
        rows: number(row.rows),
        bytes: number(row.bytes),
        min_ts: row.min_ts || "",
        max_ts: row.max_ts || "",
        range_start_utc: dirtyStartUtc,
        range_end_utc: dirtyEndUtc,
      }, updatedAt);
    }
  }
}

function addRouteEvidence(map, key, seed, row) {
  const current = map.get(key) || {
    ...seed,
    bytes: 0,
    via_vps_bytes: 0,
    direct_bytes: 0,
    unknown_bytes: 0,
    flows: 0,
    first_seen_utc: "",
    last_seen_utc: "",
  };
  current.bytes += number(row.bytes);
  current.via_vps_bytes += number(row.via_vps_bytes);
  current.direct_bytes += number(row.direct_bytes);
  current.unknown_bytes += number(row.unknown_bytes);
  current.flows += number(row.flows || 1);
  const seen = text(row.collected_at || row.last_seen || "");
  if (seen && (!current.first_seen_utc || seen < current.first_seen_utc)) current.first_seen_utc = seen;
  if (seen && (!current.last_seen_utc || seen > current.last_seen_utc)) current.last_seen_utc = seen;
  map.set(key, current);
}

function rebuildRouteEvidenceDefects(db, facts, ranges, updatedAt) {
  const ipCache = db.prepare(`
    select ip, provider, category_hint, traffic_lane_hint, dns_category_hint
      from ip_enrichment_cache
     where ip = ?
  `);
  const insert = db.prepare(`
    insert into client_route_evidence_defects(bucket_granularity, bucket_key, bucket_start_utc,
      client_key, client_label, channel, destination_key, destination_label, traffic_lane, dns_category,
      category, provider, route_evidence, route, intended_route, route_verification, route_status,
      matched_ipset, bytes, via_vps_bytes, direct_bytes, unknown_bytes, flows,
      first_seen_utc, last_seen_utc, updated_at_utc)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [layer, [startUtc, endUtc]] of Object.entries(ranges)) {
    db.prepare("delete from client_route_evidence_defects where bucket_granularity = ? and bucket_start_utc >= ? and bucket_start_utc < ?").run(layer, startUtc, endUtc);
    const grouped = new Map();
    for (const row of facts || []) {
      const ts = text(row.collected_at || row.last_seen || "");
      if (!ts || Date.parse(ts) < Date.parse(startUtc) || Date.parse(ts) >= Date.parse(endUtc)) continue;
      const bucket = bucketStartUtc(ts, layer);
      const bucketKey = toMskKey(bucket, layer);
      const routeEvidence = routeEvidenceFor(row);
      const classification = routeClassificationFor(row, ipCache);
      const key = [
        layer,
        bucketKey,
        row.client_key,
        row.channel,
        classification.destination_key,
        classification.traffic_lane,
        classification.dns_category,
        routeEvidence,
        row.route,
        row.intended_route,
        row.route_verification,
        row.route_status,
        row.matched_ipset,
      ].join("|");
      addRouteEvidence(grouped, key, {
        bucket_granularity: layer,
        bucket_key: bucketKey,
        bucket_start_utc: bucket,
        client_key: text(row.client_key),
        client_label: text(row.client_label || row.client_key),
        channel: text(row.channel, "Unknown"),
        destination_key: classification.destination_key,
        destination_label: classification.destination_label,
        traffic_lane: classification.traffic_lane,
        dns_category: classification.dns_category,
        category: classification.category,
        provider: classification.provider,
        route_evidence: routeEvidence,
        route: text(row.route, "Unknown"),
        intended_route: text(row.intended_route, "Unknown"),
        route_verification: text(row.route_verification || "unknown"),
        route_status: text(row.route_status || "unknown"),
        matched_ipset: text(row.matched_ipset || ""),
      }, row);
    }
    for (const row of grouped.values()) {
      insert.run(row.bucket_granularity, row.bucket_key, row.bucket_start_utc, row.client_key, row.client_label,
        row.channel, row.destination_key, row.destination_label, row.traffic_lane, row.dns_category,
        row.category, row.provider, row.route_evidence, row.route, row.intended_route, row.route_verification,
        row.route_status, row.matched_ipset, row.bytes, row.via_vps_bytes, row.direct_bytes, row.unknown_bytes,
        row.flows, row.first_seen_utc, row.last_seen_utc, updatedAt);
    }
  }
}

export function rebuildClientTrafficLaneReadModels(db, options = {}) {
  const updatedAt = options.updatedAt || options.now || new Date().toISOString();
  const dirtyStartUtc = options.dirtyStartUtc || options.fromUtc || updatedAt;
  const dirtyEndUtc = options.dirtyEndUtc || options.toUtc || updatedAt;
  const sourceVersion = options.sourceVersion || "";
  const ranges = {
    "5min": [bucketStartUtc(dirtyStartUtc, "5min"), dirtyEndUtc],
    hour: [bucketStartUtc(dirtyStartUtc, "hour"), bucketRangeEndUtc(dirtyEndUtc, "hour")],
    day: [bucketStartUtc(dirtyStartUtc, "day"), bucketRangeEndUtc(dirtyEndUtc, "day")],
    week: [bucketStartUtc(dirtyStartUtc, "week"), bucketRangeEndUtc(dirtyEndUtc, "week")],
    month: [bucketStartUtc(dirtyStartUtc, "month"), bucketRangeEndUtc(dirtyEndUtc, "month")],
  };

  if (Array.isArray(options.facts)) {
    rebuildRouteEvidenceDefects(db, options.facts, ranges, updatedAt);
  }

  let summaryRows = 0;
  let detailRows = 0;
  for (const [layer, meta] of Object.entries(layerMeta)) {
    const [startUtc, endUtc] = ranges[layer];
    db.prepare("delete from client_traffic_by_lane where bucket_granularity = ? and bucket_start_utc >= ? and bucket_start_utc < ?").run(layer, startUtc, endUtc);
    db.prepare("delete from client_destination_by_lane where bucket_granularity = ? and bucket_start_utc >= ? and bucket_start_utc < ?").run(layer, startUtc, endUtc);
    insertGroupedRows(db, sourceRows(db, meta, startUtc, endUtc), layer, updatedAt);
    summaryRows += number(db.prepare("select count(*) as count from client_traffic_by_lane where bucket_granularity = ? and bucket_start_utc >= ? and bucket_start_utc < ?").get(layer, startUtc, endUtc)?.count);
    detailRows += number(db.prepare("select count(*) as count from client_destination_by_lane where bucket_granularity = ? and bucket_start_utc >= ? and bucket_start_utc < ?").get(layer, startUtc, endUtc)?.count);
  }
  writeLaneStates(db, sourceVersion, bucketStartUtc(dirtyStartUtc, "month"), bucketRangeEndUtc(dirtyEndUtc, "month"), updatedAt);
  return { summaryRows, detailRows };
}
