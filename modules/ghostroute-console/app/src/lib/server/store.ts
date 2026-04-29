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

export function getDb() {
  ensureDirs();
  if (!db) {
    db = new Database(dbPath());
    db.pragma("journal_mode = WAL");
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
      2,
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
  return {
    id: row.id,
    type: row.type,
    collectedAt: row.collected_at,
    source: row.source,
    path: row.path,
    payload: JSON.parse(row.payload_json),
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

function inferType(payload: any, fileName: string): SnapshotType | null {
  const command = String(payload?.source?.command || fileName);
  if (command.includes("traffic")) return "traffic";
  if (command.includes("router-health")) return "health";
  if (command.includes("leak")) return "leaks";
  if (command.includes("domain-report")) return "domains";
  if (command.includes("dns-forensics")) return "dns";
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
  const merged = new Map<SnapshotType, SnapshotRecord>();
  for (const row of latestSnapshotsFromDisk()) merged.set(row.type, row);
  for (const row of latestSnapshotsFromDb()) {
    const current = merged.get(row.type);
    if (!current || row.collectedAt >= current.collectedAt) merged.set(row.type, row);
  }
  return Array.from(merged.values());
}

function latestSnapshotIdsByType() {
  return latestSnapshots()
    .filter((row) => row.id > 0)
    .map((row) => row.id);
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
