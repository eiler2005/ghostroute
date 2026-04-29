const MIGRATION_VERSION = 2;

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
      destination text not null default '',
      route text not null default 'Unknown',
      confidence text not null default 'unknown',
      bytes integer not null default 0,
      connections integer not null default 0,
      protocol text not null default '',
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
}

function normalizeTraffic(db, snapshotId, type, collectedAt, payload) {
  const deviceInsert = db.prepare(`
    insert into normalized_devices(snapshot_id, snapshot_type, collected_at, device_id, label, ip, route, confidence, total_bytes, via_vps_bytes, direct_bytes, raw_json)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of [...(payload.devices || []), ...(payload.home_reality_clients || [])]) {
    deviceInsert.run(
      snapshotId,
      type,
      collectedAt,
      text(row.id || row.ip || row.profile || row.label, "unknown-device"),
      text(row.label || row.profile || row.ip || row.id, "Unknown device"),
      text(row.ip || ""),
      text(row.route || "Unknown"),
      confidence(row.confidence, "estimated"),
      number(row.total_bytes),
      number(row.via_vps_bytes || row.reality_bytes),
      number(row.direct_bytes || row.wan_bytes),
      json(row)
    );
  }

  const flowInsert = db.prepare(`
    insert into normalized_flows(snapshot_id, snapshot_type, collected_at, client, destination, route, confidence, bytes, connections, protocol, raw_json)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of [...(payload.app_flows || []), ...(payload.destinations || [])]) {
    flowInsert.run(
      snapshotId,
      type,
      collectedAt,
      text(row.client || row.label || row.channel || ""),
      text(row.destination || row.domain || row.app || row.family || ""),
      text(row.route || routeFromTraffic(row)),
      confidence(row.confidence, "estimated"),
      number(row.bytes || row.total_bytes),
      number(row.connections || row.total_connections),
      text(row.protocol || ""),
      json(row)
    );
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
    insert into normalized_dns(snapshot_id, collected_at, client, domain, qtype, count, confidence, raw_json)
    values (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of payload.queries || []) {
    insert.run(
      snapshotId,
      collectedAt,
      text(row.client || row.ip || ""),
      text(row.domain || row.qname || row.query || ""),
      text(row.qtype || row.type || ""),
      number(row.count || row.queries || 1),
      confidence(row.confidence, "dns-interest"),
      json(row)
    );
  }
}

function routeFromTraffic(row) {
  if (number(row.via_vps_bytes || row.reality_bytes || row.vps_connections) > 0) return "VPS";
  if (number(row.direct_bytes || row.wan_bytes || row.direct_connections) > 0) return "Direct";
  return "Unknown";
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
