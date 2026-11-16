import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { ensureConsoleSchema, normalizeSnapshot, rebuildObservabilityReadModels } from "../scripts/lib/normalize.mjs";

test("active alarms follow the latest source snapshot while history is retained", () => {
  const db = new Database(":memory:");
  try {
    ensureConsoleSchema(db);
    const store = (type, time, payload) => {
      const id = Number(db.prepare("insert into snapshots(type,collected_at,source,path,payload_json) values(?,?,'test','',?)").run(type, time, JSON.stringify(payload)).lastInsertRowid);
      normalizeSnapshot(db, id, type, time, payload);
    };
    const fault = { leaks: [{ probe: "rule_set_sync", label: "Rule-set sync", severity: "critical", status: "CRIT" }], checks: [] };
    store("leaks", "2026-11-16T08:00:00Z", fault);
    store("leaks", "2026-11-16T08:05:00Z", fault);
    rebuildObservabilityReadModels(db);
    assert.equal(db.prepare("select count(*) as n from alarm_events").get().n, 1);
    store("leaks", "2026-11-16T08:10:00Z", { leaks: [], checks: [{ probe: "rule_set_sync", status: "OK" }] });
    rebuildObservabilityReadModels(db);
    assert.equal(db.prepare("select count(*) as n from alarm_events").get().n, 0);
    assert.equal(db.prepare("select count(*) as n from normalized_alerts").get().n, 2);
  } finally { db.close(); }
});
