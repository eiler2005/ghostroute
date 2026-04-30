const MIGRATION_VERSION = 4;

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

function addColumnIfMissing(db, table, column, definition) {
  const columns = db.prepare(`pragma table_info(${table})`).all();
  if (!columns.some((row) => row.name === column)) {
    db.exec(`alter table ${table} add column ${column} ${definition}`);
  }
}

function inferChannel(row) {
  const raw = JSON.stringify(row || {}).toLowerCase();
  const client = text(row.client || row.label || row.profile || row.channel || row.source || "");
  const source = `${raw} ${client.toLowerCase()}`;
  if (/\b\/\s*c1\b|\bc1_|channel-c|shadowrocket|naive/.test(source)) return "Channel C";
  if (/\b\/\s*b\b|iphone-b|channel-b|xhttp|xray|selected-client/.test(source)) return "Channel B";
  if (source.includes("channel-c") || source.includes("shadowrocket") || source.includes("naive")) return "Channel C";
  if (source.includes("channel-b") || source.includes("xhttp") || source.includes("xray") || source.includes("selected-client")) return "Channel B";
  if (source.includes("home_reality") || source.includes("home-reality") || source.includes("reality-in") || source.includes("reality qr")) return "Channel A";
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
  return text(row.ts || row.timestamp || row.occurred_at || collectedAt);
}

export function ensureConsoleSchema(db) {
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
      ts_confidence text not null default '',
      source_log text not null default '',
      raw_json text not null
    );
    create index if not exists idx_normalized_flows_snapshot on normalized_flows(snapshot_id);

    create table if not exists normalized_dns (
      snapshot_id integer not null,
      collected_at text not null,
      client text not null default '',
      domain text not null default '',
      qtype text not null default '',
      count integer not null default 0,
      answer_ip text not null default '',
      event_ts text not null default '',
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
  `);
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
      ts_confidence: "text not null default ''",
      source_log: "text not null default ''",
    },
    normalized_dns: {
      answer_ip: "text not null default ''",
      event_ts: "text not null default ''",
      ts_confidence: "text not null default ''",
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
    },
  })) {
      for (const [column, definition] of Object.entries(columns)) addColumnIfMissing(db, table, column, definition);
  }
  db.exec(`
    create unique index if not exists idx_events_event_id on events(event_id) where event_id != '';
    create unique index if not exists idx_route_decisions_event_id on route_decisions(event_id) where event_id != '';
  `);

  db.prepare("insert or ignore into schema_migrations(version, applied_at) values (?, ?)").run(
    MIGRATION_VERSION,
    new Date().toISOString()
  );
}

export function rebuildHourlyAggregates(db) {
  db.prepare("delete from hourly_traffic").run();
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

export function resetNormalizedForSnapshot(db, snapshotId) {
  for (const table of [
    "normalized_devices",
    "normalized_flows",
    "normalized_dns",
    "normalized_health",
    "normalized_catalog",
    "normalized_alerts",
    "events",
    "route_decisions",
  ]) {
    db.prepare(`delete from ${table} where snapshot_id = ?`).run(snapshotId);
  }
}

export function normalizeSnapshot(db, snapshotId, type, collectedAt, payload) {
  resetNormalizedForSnapshot(db, snapshotId);
  if (type === "traffic") normalizeTraffic(db, snapshotId, type, collectedAt, payload);
  if (type === "health") normalizeHealth(db, snapshotId, type, collectedAt, payload);
  if (type === "leaks") normalizeLeaks(db, snapshotId, type, collectedAt, payload);
  if (type === "domains") normalizeDomains(db, snapshotId, type, collectedAt, payload);
  if (type === "dns") normalizeDns(db, snapshotId, collectedAt, payload);
  if (type === "live") normalizeLive(db, snapshotId, type, collectedAt, payload);
}

function normalizeTraffic(db, snapshotId, type, collectedAt, payload) {
  const deviceInsert = db.prepare(`
    insert into normalized_devices(snapshot_id, snapshot_type, collected_at, device_id, label, ip, channel, route, confidence, total_bytes, via_vps_bytes, direct_bytes, raw_json)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of [...(payload.devices || []), ...(payload.home_reality_clients || [])]) {
    deviceInsert.run(
      snapshotId,
      type,
      collectedAt,
      text(row.id || row.ip || row.profile || row.label, "unknown-device"),
      text(row.label || row.profile || row.ip || row.id, "Unknown device"),
      text(row.ip || ""),
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
    insert into normalized_flows(snapshot_id, snapshot_type, collected_at, client, channel, destination, route, confidence, bytes, connections, protocol, client_ip, destination_ip, destination_port, dns_qname, dns_answer_ip, sni, outbound, matched_rule, rule_set, egress_ip, egress_asn, egress_country, event_ts, ts_confidence, source_log, raw_json)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of [...(payload.app_flows || []), ...(payload.destinations || []), ...(payload.route_events || [])]) {
    const route = text(row.route || routeFromTraffic(row));
    const channel = inferChannel(row);
    const client = text(row.client || row.label || row.channel || "");
    const destination = text(row.destination || row.domain || row.app || row.family || "");
    const rowConfidence = confidence(row.confidence, "estimated");
    const eventTs = eventTimestamp(row, collectedAt);
    const rawRefs = Array.isArray(row.raw_refs) ? row.raw_refs : [];
    flowInsert.run(
      snapshotId,
      type,
      collectedAt,
      client,
      channel,
      destination,
      route,
      rowConfidence,
      number(row.bytes || row.total_bytes),
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
      text(row.ts_confidence || ""),
      text(rawRefs[0]?.source_log || rawRefs[0]?.source || ""),
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
    insert into normalized_dns(snapshot_id, collected_at, client, domain, qtype, count, answer_ip, event_ts, ts_confidence, confidence, raw_json)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of payload.queries || []) {
    const client = text(row.client || row.client_ip || row.ip || "");
    const domain = text(row.domain || row.qname || row.query || "");
    const rowConfidence = confidence(row.confidence, "dns-interest");
    const eventTs = eventTimestamp(row, collectedAt);
    insert.run(
      snapshotId,
      collectedAt,
      client,
      domain,
      text(row.qtype || row.query_type || row.type || ""),
      number(row.count || row.queries || 1),
      text(row.answer_ip || row.dns_answer_ip || ""),
      eventTs,
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
  db.prepare(`
    insert or ignore into events(snapshot_id, event_type, occurred_at, client, channel, destination, route, confidence, summary, event_id, client_ip, destination_ip, destination_port, dns_qname, dns_answer_ip, sni, outbound, matched_rule, rule_set, egress_ip, egress_asn, egress_country, source_log, evidence_json)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    snapshotId,
    eventType,
    occurredAt,
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
  db.prepare(`
    insert or ignore into route_decisions(snapshot_id, occurred_at, client, channel, destination, route, outbound, matched_rule, visible_ip, event_id, client_ip, destination_ip, destination_port, dns_qname, dns_answer_ip, sni, rule_set, egress_asn, egress_country, source_log, confidence, evidence_json)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    snapshotId,
    occurredAt,
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
