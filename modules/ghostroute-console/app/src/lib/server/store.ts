import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { dataDir, dbPath, snapshotsDir } from "./paths";
import type { SnapshotRecord, SnapshotType } from "./types";

let db: Database.Database | null = null;

function ensureDirs() {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.mkdirSync(snapshotsDir(), { recursive: true });
}

function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string) {
  const columns = db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((row) => row.name === column)) {
    db.exec(`alter table ${table} add column ${column} ${definition}`);
  }
}

function tableHasColumn(db: Database.Database, table: string, column: string) {
  return (db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).some((row) => row.name === column);
}

function migrateAggregateDestinationKeys(db: Database.Database) {
  if (!tableHasColumn(db, "client_traffic_hourly", "destination_key")) {
    db.exec(`
      drop table if exists client_traffic_hourly_legacy_v9;
      alter table client_traffic_hourly rename to client_traffic_hourly_legacy_v9;
      create table client_traffic_hourly (
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
      insert or ignore into client_traffic_hourly(hour_msk_key, hour_start_utc, client_key, client_label, channel, route,
        confidence, traffic_class, destination_key, bytes, via_vps_bytes, direct_bytes, unknown_bytes, observed_bytes,
        attributed_bytes, flows, clients, updated_at_utc)
      select hour_msk_key, hour_start_utc, client_key, client_label, channel, route, confidence, traffic_class, '',
        bytes, via_vps_bytes, direct_bytes, unknown_bytes, observed_bytes, attributed_bytes, flows, clients, updated_at_utc
        from client_traffic_hourly_legacy_v9;
      drop table client_traffic_hourly_legacy_v9;
    `);
  }
  if (!tableHasColumn(db, "client_traffic_daily", "destination_key")) {
    db.exec(`
      drop table if exists client_traffic_daily_legacy_v9;
      alter table client_traffic_daily rename to client_traffic_daily_legacy_v9;
      create table client_traffic_daily (
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
      insert or ignore into client_traffic_daily(day_msk_key, day_start_utc, client_key, client_label, channel, route,
        confidence, traffic_class, destination_key, bytes, via_vps_bytes, direct_bytes, unknown_bytes, observed_bytes,
        attributed_bytes, flows, clients, updated_at_utc)
      select day_msk_key, day_start_utc, client_key, client_label, channel, route, confidence, traffic_class, '',
        bytes, via_vps_bytes, direct_bytes, unknown_bytes, observed_bytes, attributed_bytes, flows, clients, updated_at_utc
        from client_traffic_daily_legacy_v9;
      drop table client_traffic_daily_legacy_v9;
    `);
  }
}

export function getDb() {
  ensureDirs();
  if (!db) {
    db = new Database(dbPath());
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 10000");
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
      create table if not exists client_traffic_hourly (
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
      create table if not exists client_traffic_daily (
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
    `);
    migrateAggregateDestinationKeys(db);
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
    db.exec(`
      create unique index if not exists idx_events_event_id on events(event_id) where event_id != '';
      create unique index if not exists idx_route_decisions_event_id on route_decisions(event_id) where event_id != '';
      create index if not exists idx_normalized_flows_fast on normalized_flows(snapshot_id, collected_at desc, event_ts desc, client, route, channel, confidence);
      create index if not exists idx_normalized_flows_destination on normalized_flows(snapshot_id, destination, destination_ip, dns_qname);
      create index if not exists idx_normalized_devices_fast on normalized_devices(collected_at desc, label, device_id, channel, route);
      create index if not exists idx_events_fast on events(occurred_at desc, event_type, client, channel, route);
      create index if not exists idx_route_decisions_fast on route_decisions(occurred_at desc, client, channel, route);
      create index if not exists idx_flow_sessions_time on flow_sessions(last_seen desc, first_seen desc);
      create index if not exists idx_flow_sessions_filters on flow_sessions(route, channel, confidence, risk, client, destination);
      create index if not exists idx_flow_sessions_destination on flow_sessions(destination, destination_ip, destination_port);
      create index if not exists idx_dns_query_log_time on dns_query_log(event_ts desc, collected_at desc);
      create index if not exists idx_dns_query_log_filters on dns_query_log(route, catalog_status, status, client, domain);
      create index if not exists idx_device_inventory_activity on device_inventory(last_seen desc, total_bytes desc, route);
      create index if not exists idx_alarm_events_status on alarm_events(status, severity, collected_at desc);
      create index if not exists idx_ct5_msk on client_traffic_5min(bucket_msk_key desc);
      create index if not exists idx_ct5_class_msk on client_traffic_5min(traffic_class, bucket_msk_key desc);
      create index if not exists idx_ct5_client_msk on client_traffic_5min(client_key, bucket_msk_key desc);
      create index if not exists idx_cth_msk on client_traffic_hourly(hour_msk_key desc);
      create index if not exists idx_cth_class_msk on client_traffic_hourly(traffic_class, hour_msk_key desc);
      create index if not exists idx_ctd_msk on client_traffic_daily(day_msk_key desc);
      create index if not exists idx_dl5_msk on dns_log_5min(bucket_msk_key desc);
      create index if not exists idx_dl5_domain on dns_log_5min(domain, bucket_msk_key desc);
      create index if not exists idx_tws_window on traffic_window_snapshots(kind, window, traffic_class, computed_at_utc desc);
    `);
    db.prepare("insert or ignore into schema_migrations(version, applied_at) values (?, ?)").run(
      6,
      new Date().toISOString()
    );
    db.prepare("insert or ignore into schema_migrations(version, applied_at) values (?, ?)").run(
      7,
      new Date().toISOString()
    );
    db.prepare("insert or ignore into schema_migrations(version, applied_at) values (?, ?)").run(
      8,
      new Date().toISOString()
    );
    db.prepare("insert or ignore into schema_migrations(version, applied_at) values (?, ?)").run(
      9,
      new Date().toISOString()
    );
    db.prepare("insert or ignore into schema_migrations(version, applied_at) values (?, ?)").run(
      10,
      new Date().toISOString()
    );
  }
  return db;
}

export function insertSnapshot(type: SnapshotType, filePath: string, payload: any) {
  const collectedAt = payload?.generated_at || new Date().toISOString();
  const source = payload?.source?.command || type;
  getDb()
    .prepare("insert into snapshots(type, collected_at, source, path, payload_json) values (?, ?, ?, ?, ?)")
    .run(type, collectedAt, source, filePath, JSON.stringify(payload));
}

function rowToSnapshot(row: any): SnapshotRecord {
  let payload = {};
  try {
    payload = row.payload_json ? JSON.parse(row.payload_json) : {};
  } catch {
    payload = {};
  }
  return {
    id: row.id,
    type: row.type,
    collectedAt: row.collected_at,
    source: row.source,
    path: row.path,
    payload,
  };
}

function rowToSnapshotMeta(row: any): SnapshotRecord {
  return {
    id: row.id,
    type: row.type,
    collectedAt: row.collected_at,
    source: row.source,
    path: row.path,
    payload: {},
  };
}

export function latestSnapshotsFromDb(): SnapshotRecord[] {
  try {
    const rows = getDb()
      .prepare(
        `select s.* from snapshots s
         join (select type, max(collected_at) as collected_at from snapshots group by type) latest
           on latest.type = s.type and latest.collected_at = s.collected_at
         order by s.collected_at desc`
      )
      .all();
    return rows.map(rowToSnapshot);
  } catch {
    return [];
  }
}

export function latestSnapshotMetasFromDb(): SnapshotRecord[] {
  try {
    const rows = getDb()
      .prepare(
        `select s.id, s.type, s.collected_at, s.source, s.path from snapshots s
         join (select type, max(collected_at) as collected_at from snapshots group by type) latest
           on latest.type = s.type and latest.collected_at = s.collected_at
         order by s.collected_at desc`
      )
      .all();
    return rows.map(rowToSnapshotMeta);
  } catch {
    return [];
  }
}

export function latestSnapshotsForTypes(types: SnapshotType[]): SnapshotRecord[] {
  const uniqueTypes = Array.from(new Set(types)).filter(Boolean);
  if (uniqueTypes.length === 0) return [];
  try {
    const placeholders = uniqueTypes.map(() => "?").join(",");
    const rows = getDb()
      .prepare(
        `select s.* from snapshots s
         join (select type, max(collected_at) as collected_at from snapshots where type in (${placeholders}) group by type) latest
           on latest.type = s.type and latest.collected_at = s.collected_at
         order by s.collected_at desc`
      )
      .all(...uniqueTypes);
    if (rows.length > 0) return rows.map(rowToSnapshot);
  } catch {
    // Fall through to disk snapshots for local/dev setups without DB rows.
  }
  return latestSnapshotsFromDisk().filter((row) => uniqueTypes.includes(row.type));
}

function inferType(payload: any, fileName: string): SnapshotType | null {
  const command = String(payload?.source?.command || fileName);
  if (command.includes("traffic-summary")) return "traffic_summary";
  if (command.includes("traffic")) return "traffic";
  if (command.includes("router-health")) return "health";
  if (command.includes("leak")) return "leaks";
  if (command.includes("domain-report")) return "domains";
  if (command.includes("dns-forensics")) return "dns";
  if (command.includes("live-events")) return "live";
  return null;
}

export function latestSnapshotsFromDisk(): SnapshotRecord[] {
  if (!fs.existsSync(snapshotsDir())) return [];
  const byType = new Map<SnapshotType, SnapshotRecord>();
  const files = fs
    .readdirSync(snapshotsDir())
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.join(snapshotsDir(), file))
    .sort();

  for (const file of files) {
    try {
      const payload = JSON.parse(fs.readFileSync(file, "utf8"));
      const type = inferType(payload, path.basename(file));
      if (!type) continue;
      const collectedAt = payload?.generated_at || fs.statSync(file).mtime.toISOString();
      const current = byType.get(type);
      if (!current || collectedAt >= current.collectedAt) {
        byType.set(type, {
          id: 0,
          type,
          collectedAt,
          source: payload?.source?.command || type,
          path: file,
          payload,
        });
      }
    } catch {
      // Ignore incomplete collector writes.
    }
  }
  return Array.from(byType.values());
}

export function latestSnapshots() {
  const fromDb = latestSnapshotsFromDb();
  if (fromDb.length > 0) return fromDb;
  const merged = new Map<SnapshotType, SnapshotRecord>();
  for (const row of latestSnapshotsFromDisk()) merged.set(row.type, row);
  return Array.from(merged.values());
}

export function latestSnapshotMetas() {
  const fromDb = latestSnapshotMetasFromDb();
  if (fromDb.length > 0) return fromDb;
  return latestSnapshotsFromDisk().map((row) => ({ ...row, payload: {} }));
}

function latestSnapshotIdsByType() {
  return latestSnapshots()
    .filter((row) => row.id > 0)
    .map((row) => row.id);
}

export function latestSnapshotIds() {
  return latestSnapshotIdsByType();
}

function parseRaw(row: any) {
  try {
    return row.raw_json ? JSON.parse(row.raw_json) : {};
  } catch {
    return {};
  }
}

export function normalizedRows(table: string) {
  const allowed = new Set([
    "normalized_devices",
    "normalized_flows",
    "normalized_dns",
    "normalized_health",
    "normalized_catalog",
    "normalized_alerts",
  ]);
  if (!allowed.has(table)) return [];
  const ids = latestSnapshotIdsByType();
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  try {
    return getDb()
      .prepare(`select * from ${table} where snapshot_id in (${placeholders}) order by collected_at desc`)
      .all(...ids)
      .map((row: any) => ({ ...row, raw: parseRaw(row) }));
  } catch {
    return [];
  }
}

export function knownDeviceRows(limit = 1000) {
  try {
    return getDb()
      .prepare(
        `select snapshot_id, snapshot_type, collected_at, device_id, label, ip, hostname, mac, channel, route,
                confidence, total_bytes, via_vps_bytes, direct_bytes, raw_json
           from normalized_devices
          order by collected_at desc
          limit ?`
      )
      .all(limit)
      .map((row: any) => ({ ...row, raw: parseRaw(row) }));
  } catch {
    return [];
  }
}

function parseEvidence(row: any) {
  try {
    return row.evidence_json ? JSON.parse(row.evidence_json) : {};
  } catch {
    return {};
  }
}

export function latestEvents(limit = 120) {
  try {
    return getDb()
      .prepare(
        `select id, snapshot_id, event_type, occurred_at, client, channel, destination, route, confidence, summary,
                event_id, client_ip, destination_ip, destination_port, dns_qname, dns_answer_ip, sni,
                outbound, matched_rule, rule_set, egress_ip, egress_asn, egress_country, source_log, evidence_json
         from events
         order by occurred_at desc, id desc
         limit ?`
      )
      .all(limit)
      .map((row: any) => ({ ...row, evidence: parseEvidence(row) }));
  } catch {
    return [];
  }
}

export function latestRouteDecisions(limit = 120) {
  try {
    return getDb()
      .prepare(
        `select id, snapshot_id, occurred_at, client, channel, destination, route, outbound, matched_rule, visible_ip,
                event_id, client_ip, destination_ip, destination_port, dns_qname, dns_answer_ip, sni,
                rule_set, egress_asn, egress_country, source_log, confidence, evidence_json
         from route_decisions
         order by occurred_at desc, id desc
         limit ?`
      )
      .all(limit)
      .map((row: any) => ({ ...row, evidence: parseEvidence(row) }));
  } catch {
    return [];
  }
}

export function catalogReviews(limit = 100) {
  try {
    return getDb()
      .prepare(
        `select id, domain, decision, reason, status, created_at, updated_at
         from catalog_reviews
         order by updated_at desc, id desc
         limit ?`
      )
      .all(limit);
  } catch {
    return [];
  }
}

export function notifications(limit = 100) {
  try {
    return getDb()
      .prepare(
        `select id, type, severity, title, status, channel, target, created_at, updated_at, snoozed_until, evidence_json
         from notifications
         order by updated_at desc, id desc
         limit ?`
      )
      .all(limit)
      .map((row: any) => ({ ...row, evidence: parseEvidence(row) }));
  } catch {
    return [];
  }
}

export function notificationSettings() {
  try {
    const rows = getDb().prepare("select key, value_json from notification_settings").all() as Array<any>;
    return Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value_json)]));
  } catch {
    return {};
  }
}

export function auditLog(limit = 100) {
  try {
    return getDb()
      .prepare(
        `select id, actor, action, target, status, summary, rollback_ref, created_at, evidence_json
         from audit_log
         order by created_at desc, id desc
         limit ?`
      )
      .all(limit)
      .map((row: any) => ({ ...row, evidence: parseEvidence(row) }));
  } catch {
    return [];
  }
}

export function opsRuns(limit = 50) {
  try {
    return getDb()
      .prepare(
        `select id, action, status, started_at, finished_at, summary, evidence_json
         from ops_runs
         order by started_at desc, id desc
         limit ?`
      )
      .all(limit)
      .map((row: any) => ({ ...row, evidence: parseEvidence(row) }));
  } catch {
    return [];
  }
}

export function recordAudit(action: string, target: string, status: string, summary: string, evidence: unknown = {}, rollbackRef = "") {
  return getDb()
    .prepare(
      `insert into audit_log(actor, action, target, status, summary, rollback_ref, created_at, evidence_json)
       values (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      "local-console",
      action,
      target,
      status,
      summary,
      rollbackRef,
      new Date().toISOString(),
      JSON.stringify(evidence || {})
    );
}

export function upsertCatalogReview(domain: string, decision: string, reason: string) {
  const now = new Date().toISOString();
  const existing = getDb().prepare("select id from catalog_reviews where domain = ?").get(domain) as { id: number } | undefined;
  if (existing) {
    getDb()
      .prepare("update catalog_reviews set decision = ?, reason = ?, status = 'reviewed', updated_at = ? where id = ?")
      .run(decision, reason, now, existing.id);
    return existing.id;
  }
  const result = getDb()
    .prepare("insert into catalog_reviews(domain, decision, reason, status, created_at, updated_at) values (?, ?, ?, 'reviewed', ?, ?)")
    .run(domain, decision, reason, now, now);
  return Number(result.lastInsertRowid);
}

export function setNotificationSetting(key: string, value: unknown) {
  getDb()
    .prepare(
      `insert into notification_settings(key, value_json, updated_at) values (?, ?, ?)
       on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`
    )
    .run(key, JSON.stringify(value || {}), new Date().toISOString());
}

export function updateNotification(id: number, status: string, snoozedUntil = "") {
  getDb()
    .prepare("update notifications set status = ?, snoozed_until = ?, updated_at = ? where id = ?")
    .run(status, snoozedUntil, new Date().toISOString(), id);
}

export function recordOpsRun(action: string, status: string, summary: string, evidence: unknown = {}) {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare("insert into ops_runs(action, status, started_at, finished_at, summary, evidence_json) values (?, ?, ?, ?, ?, ?)")
    .run(action, status, now, now, summary, JSON.stringify(evidence || {}));
  recordAudit(`ops.${action}`, action, status, summary, evidence);
  return Number(result.lastInsertRowid);
}

export function latestCollectorErrors(limit = 5) {
  try {
    return getDb()
      .prepare(
        `select type, collected_at, command, message, output_sample
         from collector_errors
         where run_id = (select max(id) from collector_runs)
         order by collected_at desc
         limit ?`
      )
      .all(limit);
  } catch {
    return [];
  }
}

export function hourlyTraffic(limit = 72) {
  try {
    return getDb()
      .prepare(
        `select hour_key, route, bytes, flows, clients, updated_at
         from hourly_traffic
         order by hour_key desc, route
         limit ?`
      )
      .all(limit);
  } catch {
    return [];
  }
}

export function latestCollectorRun() {
  try {
    return getDb()
      .prepare(
        `select id, started_at, finished_at, ok_count, error_count
         from collector_runs
         order by id desc
         limit 1`
      )
      .get();
  } catch {
    return null;
  }
}
