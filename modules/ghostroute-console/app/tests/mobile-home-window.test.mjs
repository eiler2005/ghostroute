import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { ensureConsoleSchema, buildPreparedMobileHomeSummary } from "../scripts/lib/normalize.mjs";

test("mobile home uses today's prepared client totals and excludes retained previous-day detail", () => {
  const db = new Database(":memory:");
  try {
    ensureConsoleSchema(db);
    const now = "2026-11-19T12:00:00.000Z";
    const today = "2026-11-18T21:05:00.000Z";
    const yesterday = "2026-11-18T20:59:00.000Z";
    const rows = [{ id: "fixture", label: "Fixture", total_bytes: 300 * 1024 ** 2, channel: "Home Wi-Fi/LAN" }];
    db.prepare("insert into traffic_window_snapshots(kind, window, traffic_class, window_start_utc, window_end_utc, source_version, computed_at_utc, payload_json) values ('clients','today','all','2026-11-18T21:00:00.000Z','2026-11-19T12:00:00.000Z','fixture',?,?)")
      .run(now, JSON.stringify({ rows }));
    db.prepare("insert into device_inventory(device_key,label,total_bytes,last_seen) values ('fixture','Fixture',?,?)")
      .run(800 * 1024 ** 3, yesterday);
    for (const [id, at, size] of [["old", yesterday, 800 * 1024 ** 3], ["current", today, 5 * 1024 ** 2]]) {
      db.prepare("insert into flow_sessions(id,snapshot_id,collected_at,last_seen,display_ts_utc,client,destination,bytes,connections,traffic_class) values (?,1,?,?,?,'Fixture','example.invalid',?,2,'client')")
        .run(id, at, at, at, size);
      db.prepare("insert into dns_query_log(id,snapshot_id,collected_at,event_ts,event_ts_utc,display_ts_utc,client,domain,count) values (?,1,?,?,?,?,'Fixture','example.invalid',1)")
        .run(id, at, at, at, at);
    }
    const plans = [];
    const queryDb = { prepare(sql) {
      if (sql.includes("from flow_sessions") || sql.includes("from dns_query_log")) {
        plans.push(db.prepare("explain query plan " + sql).all("2026-11-18T21:00:00.000Z", now));
      }
      return db.prepare(sql);
    }};
    const mobile = buildPreparedMobileHomeSummary(queryDb, now);
    assert.equal(plans.length, 2);
    for (const plan of plans) {
      assert.ok(plan.some(row => /SEARCH .* USING INDEX idx_.*_mobile_time/.test(row.detail)), JSON.stringify(plan));
    }
    assert.equal(mobile.clients[0].total_bytes, rows[0].total_bytes);
    assert.deepEqual(mobile.flows.map(row => row.id), ["current"]);
    assert.deepEqual(mobile.dnsRows.map(row => row.id), ["current"]);
    db.prepare("delete from traffic_window_snapshots").run();
    assert.deepEqual(buildPreparedMobileHomeSummary(db, now).clients, []);
  } finally { db.close(); }
});

