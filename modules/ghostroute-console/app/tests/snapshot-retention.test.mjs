import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { ensureConsoleSchema, pruneOperationalTables, rebuildPreparedWindows } from "../scripts/lib/normalize.mjs";
import { pruneSnapshotFiles, pruneSnapshotMetadata, pruneSnapshotPayloads } from "../scripts/lib/snapshot-retention.mjs";

test("six-hour raw archive keeps latest source payloads and normalized/aggregate history", () => {
  const db = new Database(":memory:");
  try {
    ensureConsoleSchema(db);
    const now = "2026-11-20T12:00:00.000Z";
    const insert = db.prepare("insert into snapshots(type,collected_at,source,path,payload_json) values(?,?,'fixture','','{\"fixture\":true}')");
    for (const type of ["traffic_evidence", "traffic_facts", "router_rollups", "health", "domains"]) {
      insert.run(type, "2026-11-20T05:59:59.999Z");
      insert.run(type, "2026-11-20T06:00:00.000Z");
      insert.run(type, "2026-11-20T07:00:00.000Z");
    }
    // Latest means source time, even when a delayed old snapshot was inserted later.
    insert.run("health", "2026-11-01T00:00:00.000Z");
    insert.run("leaks", "2026-11-01T00:00:00.000Z");
    insert.run("traffic_summary", "2026-11-20T01:00:00.000Z");
    insert.run("traffic_summary", "2026-11-20T07:00:00.000Z");
    db.prepare("insert into client_traffic_daily(day_msk_key,day_start_utc,client_key,updated_at_utc) values('fixture','2026-11-01T00:00:00.000Z','fixture',?)").run(now);
    assert.equal(pruneSnapshotPayloads(db, now), 6);
    assert.equal(db.prepare("select count(*) as n from snapshots where payload_json='' and collected_at >= '2026-11-20T06:00:00.000Z'").get().n, 0);
    assert.notEqual(db.prepare("select payload_json from snapshots where type='leaks'").get().payload_json, "");
    assert.equal(db.prepare("select count(*) as n from snapshots where type='traffic_summary' and payload_json!=''").get().n, 2);
    assert.equal(db.prepare("select count(*) as n from client_traffic_daily").get().n, 1);
    assert.equal(pruneSnapshotPayloads(db, now), 0);
    assert.equal(pruneSnapshotMetadata(db, "2026-11-13T12:00:00.000Z"), 1);
    assert.equal(db.prepare("select count(*) as n from snapshots where type='leaks'").get().n, 1);
  } finally { db.close(); }
});

test("file archive prunes old JSON duplicates but retains boundary files and cold sources", () => {
  const db = new Database(":memory:");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-retention-"));
  try {
    ensureConsoleSchema(db);
    const now = "2026-11-20T12:00:00.000Z";
    for (const [name, at] of [["old.json", "2026-11-19T00:00:00Z"], ["latest.json", "2026-11-19T00:00:00Z"], ["boundary.json", "2026-11-20T06:00:00Z"], ["operator.txt", "2026-11-19T00:00:00Z"]]) {
      fs.writeFileSync(path.join(dir, name), "{}");
      fs.utimesSync(path.join(dir, name), new Date(at), new Date(at));
    }
    db.prepare("insert into snapshots(type,collected_at,source,path,payload_json) values('health','2026-11-19T00:00:00Z','fixture',?,'{}')").run(path.join(dir, "latest.json"));
    assert.equal(pruneSnapshotFiles(db, dir, now), 1);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["boundary.json", "latest.json", "operator.txt"]);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("operational pruning bounds old catalog and health rows while keeping each latest source", () => {
  const db = new Database(":memory:");
  try {
    ensureConsoleSchema(db);
    const now = "2026-11-20T12:00:00.000Z", old = "2026-11-01T00:00:00Z";
    for (const [table, type, field] of [["normalized_catalog", "domains", "domain,entry_type"], ["normalized_health", "health", "check_name,status"]]) {
      for (let i=0;i<2;i++) {
        const id=db.prepare("insert into snapshots(type,collected_at,source,path,payload_json) values(?,?,'fixture','','{}')").run(type,old).lastInsertRowid;
        db.prepare(`insert into ${table}(snapshot_id,collected_at,${field},raw_json) values(?,?,'fixture','OK','{}')`).run(id,old);
      }
    }
    pruneOperationalTables(db,now);
    for(const table of ["normalized_catalog","normalized_health"]) assert.equal(db.prepare(`select count(*) as n from ${table}`).get().n,1);
  } finally {db.close();}
});

test("counter charts retain small summaries and skip empty archived payloads", () => {
  const db=new Database(":memory:");
  try {
    ensureConsoleSchema(db);
    const insert=db.prepare("insert into snapshots(type,collected_at,source,path,payload_json) values('traffic_summary',?,'fixture','',?)");
    insert.run('2026-11-20T01:00:00.000Z',JSON.stringify({totals:{client_observed_bytes:100,via_vps_bytes:40,direct_bytes:60}}));
    insert.run('2026-11-20T01:30:00.000Z','');
    pruneSnapshotPayloads(db,'2026-11-20T12:00:00.000Z');
    rebuildPreparedWindows(db,'2026-11-20T12:00:00.000Z');
    const prepared=JSON.parse(db.prepare("select payload_json from traffic_window_snapshots where kind='dashboard' and window='today' and traffic_class='all'").get().payload_json);
    assert.equal(prepared.dashboardAnalytics.trafficToday.points.length,1);
    assert.equal(prepared.dashboardAnalytics.trafficToday.points[0].totalBytes,100);
  } finally {db.close();}
});
