const MIGRATION_VERSION = 5;

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
    create index if not exists idx_flow_sessions_time on flow_sessions(last_seen desc, first_seen desc);
    create index if not exists idx_flow_sessions_filters on flow_sessions(route, channel, confidence, risk, client, destination);
    create index if not exists idx_flow_sessions_destination on flow_sessions(destination, destination_ip, destination_port);
    create index if not exists idx_dns_query_log_time on dns_query_log(event_ts desc, collected_at desc);
    create index if not exists idx_dns_query_log_filters on dns_query_log(route, catalog_status, status, client, domain);
    create index if not exists idx_device_inventory_activity on device_inventory(last_seen desc, total_bytes desc, route);
    create index if not exists idx_alarm_events_status on alarm_events(status, severity, collected_at desc);
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

function readModelSourceVersion(db) {
  return db
    .prepare("select id, type, collected_at from snapshots order by id")
    .all()
    .map((row) => `${row.id}:${row.type}:${row.collected_at}`)
    .join("|") || "empty";
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
  return text(row.event_ts || row.occurred_at || row.collected_at || row.created_at || "");
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
  const bytes = number(row.bytes || row.total_bytes);
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

    const catalogRows = db.prepare("select rowid, * from normalized_catalog order by collected_at desc, rowid desc").all();
    const catalogMatch = buildCatalogMatcher(catalogRows);
    const flowInsert = db.prepare(`
      insert into flow_sessions(id, snapshot_id, collected_at, first_seen, last_seen, client, client_ip,
        device_key, channel, destination, destination_ip, destination_port, protocol, route, policy,
        matched_rule, outbound, bytes, connections, duration_seconds, duration_confidence, risk,
        risk_reason, confidence, source_kind, evidence_json)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const flowRows = db.prepare("select rowid, * from normalized_flows order by collected_at desc, rowid desc limit ?").all(flowLimit);
    const flowTopDomains = new Map();
    for (const row of flowRows) {
      const raw = parseJson(row.raw_json, {});
      const seen = primaryTime(row) || row.collected_at;
      const risk = riskForFlow(row);
      const key = identityKey(row);
      const destination = text(row.destination || row.dns_qname || row.destination_ip, "unknown destination");
      flowInsert.run(
        `flow:${row.rowid}`,
        row.snapshot_id,
        row.collected_at,
        seen,
        seen,
        text(row.client),
        text(row.client_ip),
        key,
        text(row.channel || inferChannel(raw)),
        destination,
        text(row.destination_ip),
        text(row.destination_port),
        text(row.protocol),
        text(row.route || routeFromTraffic(raw), "Unknown"),
        policyForFlow(row),
        text(row.matched_rule),
        text(row.outbound),
        number(row.bytes),
        number(row.connections),
        durationSeconds(row),
        durationConfidence(row),
        risk.risk,
        risk.reason,
        confidence(row.confidence),
        text(row.snapshot_type || "traffic"),
        json({ ...raw, normalized_rowid: row.rowid })
      );
      flowCount += 1;
      if (destination && destination !== "unknown destination") {
        const current = flowTopDomains.get(key) || new Map();
        current.set(destination, number(current.get(destination)) + number(row.bytes || row.connections || 1));
        flowTopDomains.set(key, current);
      }
    }

    const dnsInsert = db.prepare(`
      insert or replace into dns_query_log(id, snapshot_id, collected_at, event_ts, client, client_ip,
        device_key, domain, qtype, answer_ip, route, catalog_status, status, count, risk,
        confidence, evidence_json)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const dnsRows = db.prepare("select rowid, * from normalized_dns order by collected_at desc, rowid desc limit ?").all(dnsLimit);
    for (const row of dnsRows) {
      const match = catalogMatchFor(row.domain, catalogMatch);
      const status = queryStatusForDns(match, row);
      dnsInsert.run(
        `dns:n:${row.rowid}`,
        row.snapshot_id,
        row.collected_at,
        primaryTime(row) || row.collected_at,
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
      dnsInsert.run(
        `dns:e:${row.id}`,
        row.snapshot_id,
        row.collected_at,
        row.occurred_at,
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
  })();

  writeReadModelState(db, "flow_sessions", sourceVersion, flowCount, startedAt);
  writeReadModelState(db, "dns_query_log", sourceVersion, dnsCount, startedAt);
  writeReadModelState(db, "device_inventory", sourceVersion, deviceCount, startedAt);
  writeReadModelState(db, "alarm_events", sourceVersion, alarmCount, startedAt);
  return { flowCount, dnsCount, deviceCount, alarmCount, sourceVersion };
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
    "events",
    "route_decisions",
  ]) {
    db.prepare(`delete from ${table} where snapshot_id = ?`).run(snapshotId);
  }
}

export function normalizeSnapshot(db, snapshotId, type, collectedAt, payload) {
  resetNormalizedForSnapshot(db, snapshotId);
  if (type === "traffic" || type === "traffic_summary") normalizeTraffic(db, snapshotId, type, collectedAt, payload);
  if (type === "health") normalizeHealth(db, snapshotId, type, collectedAt, payload);
  if (type === "deploy_gate") normalizeDeployGate(db, snapshotId, type, collectedAt, payload);
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
      usefulDeviceLabel(row),
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
    const client = text(row.canonical_hint || row.profile || row.client || row.label || row.channel || "");
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
