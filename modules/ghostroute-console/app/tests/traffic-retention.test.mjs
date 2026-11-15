import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { ensureConsoleSchema, pruneOperationalTables } from "../scripts/lib/normalize.mjs";
import { trafficRetentionDays, pruneTrafficHistory } from "../scripts/lib/traffic-retention.mjs";

test("legacy retention settings cannot extend traffic history past 90 days", () => {
  assert.equal(trafficRetentionDays(400, 90, 35), 90);
  assert.equal(trafficRetentionDays(100, 90, 35), 90);
  assert.equal(trafficRetentionDays("bad", 7), 7);
  assert.equal(trafficRetentionDays(7, 90), 7);
});

test("90-day boundary covers coarse and lane history while preserving operator state", () => {
  const db = new Database(":memory:");
  try {
    ensureConsoleSchema(db);
    const now = "2026-11-15T00:00:00.000Z";
    const cutoff = new Date(Date.parse(now) - 90 * 86400000).toISOString();
    const old = new Date(Date.parse(cutoff) - 1).toISOString();
    for (const [table, key, time] of [
      ["client_traffic_daily", "day_msk_key", "day_start_utc"],
      ["client_traffic_weekly", "week_msk_key", "week_start_utc"],
      ["client_traffic_monthly", "month_msk_key", "month_start_utc"],
      ["dns_log_daily", "day_msk_key", "day_start_utc"],
      ["dns_log_weekly", "week_msk_key", "week_start_utc"],
      ["dns_log_monthly", "month_msk_key", "month_start_utc"],
    ]) {
      const insert = db.prepare(`insert into ${table}(${key},${time},client_key,updated_at_utc) values(?,?,?,?)`);
      insert.run("old", old, "test-client", now);
      insert.run("boundary", cutoff, "test-client", now);
    }
    db.prepare(`insert into client_traffic_by_lane(bucket_granularity,bucket_key,bucket_start_utc,client_key,updated_at_utc) values('hourly','old',?,'test-client',?)`).run(old, now);
    db.prepare(`insert into router_traffic_rollups(snapshot_id,collected_at,window_start_utc) values(1,?,?)`).run(now, old);
    db.prepare(`insert into snapshots(type,collected_at,source,path,payload_json) values(?,?,'test','','{}')`).run("traffic_summary", old);
    db.prepare(`insert into snapshots(type,collected_at,source,path,payload_json) values(?,?,'test','','{}')`).run("health", old);
    db.prepare(`insert into console_settings(key,value_json,updated_at) values('test','{}',?)`).run(old);
    const result = pruneTrafficHistory(db, now);
    assert.equal(result.max_days, 90);
    for (const table of ["client_traffic_daily", "client_traffic_weekly", "client_traffic_monthly", "dns_log_daily", "dns_log_weekly", "dns_log_monthly"]) {
      assert.equal(db.prepare(`select count(*) as count from ${table}`).get().count, 1);
    }
    assert.equal(db.prepare("select count(*) as count from client_traffic_by_lane").get().count, 0);
    assert.equal(db.prepare("select count(*) as count from router_traffic_rollups").get().count, 0);
    assert.deepEqual(db.prepare("select type from snapshots").all(), [{ type: "health" }]);
    assert.equal(db.prepare("select count(*) as count from console_settings").get().count, 1);
    assert.equal(db.prepare("pragma integrity_check").get().integrity_check, "ok");
  } finally { db.close(); }
});

test("ordinary collector pruning enforces the 90-day cap even with a legacy 400-day setting", () => {
  const previous = process.env.GHOSTROUTE_DAILY_AGGREGATE_RETENTION_DAYS;
  process.env.GHOSTROUTE_DAILY_AGGREGATE_RETENTION_DAYS = "400";
  const db = new Database(":memory:");
  try {
    ensureConsoleSchema(db);
    db.prepare(`insert into client_traffic_daily(day_msk_key,day_start_utc,client_key,updated_at_utc) values('old','2026-01-01T00:00:00.000Z','test','2026-01-01T00:00:00.000Z')`).run();
    pruneOperationalTables(db, "2026-11-15T00:00:00.000Z");
    assert.equal(db.prepare("select count(*) as count from client_traffic_daily").get().count, 0);
  } finally {
    db.close();
    if (previous === undefined) delete process.env.GHOSTROUTE_DAILY_AGGREGATE_RETENTION_DAYS;
    else process.env.GHOSTROUTE_DAILY_AGGREGATE_RETENTION_DAYS = previous;
  }
});
