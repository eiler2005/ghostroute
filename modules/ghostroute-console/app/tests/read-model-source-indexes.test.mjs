import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { ensureConsoleSchema, rebuildObservabilityReadModels } from "../scripts/lib/normalize.mjs";

test("read model source limits use timestamp indexes without sorting retained history", () => {
  const db = new Database(":memory:");
  try {
    ensureConsoleSchema(db);
    const seen = new Set();
    const queryDb = new Proxy(db, {
      get(target, key) {
        if (key === "prepare") return (sql) => {
          const match = sql.match(/from (normalized_flows|normalized_dns|normalized_devices) order by collected_at desc, rowid desc limit \?/);
          if (match) {
            seen.add(match[1]);
            const plan = db.prepare("explain query plan " + sql).all(5000);
            assert.ok(plan.some(row => row.detail.includes(`USING INDEX idx_${match[1]}_recent`)), JSON.stringify(plan));
            assert.ok(plan.every(row => !row.detail.includes("TEMP B-TREE")), JSON.stringify(plan));
          }
          return target.prepare(sql);
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    rebuildObservabilityReadModels(queryDb);
    assert.deepEqual([...seen].sort(), ["normalized_devices", "normalized_dns", "normalized_flows"]);
  } finally {
    db.close();
  }
});
