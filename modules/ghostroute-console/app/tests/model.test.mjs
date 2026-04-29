import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

const normalizeModule = await import(new URL("../scr" + "ipts/lib/normalize.mjs", import.meta.url));
const { ensureConsoleSchema, normalizeSnapshot, rebuildHourlyAggregates } = normalizeModule;

test("console data directory can hold factual snapshots", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghostroute-console-"));
  const snapshots = path.join(tmp, "snapshots");
  fs.mkdirSync(snapshots);
  fs.writeFileSync(
    path.join(snapshots, "traffic-sample.json"),
    JSON.stringify({
      schema_version: 1,
      generated_at: "2026-04-29T00:00:00Z",
      source: { command: "traffic-report" },
      totals: { client_observed_bytes: 100, via_vps_bytes: 70, direct_bytes: 30 },
      devices: [{ id: "lan-host-01", label: "lan-host-01", total_bytes: 100, via_vps_bytes: 70, direct_bytes: 30, confidence: "exact" }],
      app_flows: [{ client: "lan-host-01", destination: "telegram.org", route: "VPS", connections: 1, confidence: "exact" }],
    })
  );
  assert.equal(fs.readdirSync(snapshots).length, 1);
});

test("collector normalizes factual traffic and catalog snapshots", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghostroute-console-db-"));
  const db = new Database(path.join(tmp, "ghostroute.db"));
  ensureConsoleSchema(db);
  const traffic = {
    generated_at: "2026-04-29T00:00:00Z",
    source: { command: "traffic-report" },
    confidence: "mixed",
    devices: [
      {
        id: "lan-host-01",
        label: "lan-host-01",
        total_bytes: 100,
        via_vps_bytes: 70,
        direct_bytes: 30,
        confidence: "exact",
      },
    ],
    app_flows: [{ client: "lan-host-01", destination: "telegram.org", route: "VPS", bytes: 70, confidence: "exact" }],
  };
  normalizeSnapshot(db, 1, "traffic", traffic.generated_at, traffic);
  assert.equal(db.prepare("select count(*) as count from normalized_devices").get().count, 1);
  assert.equal(db.prepare("select count(*) as count from normalized_flows").get().count, 1);

  normalizeSnapshot(db, 2, "domains", "2026-04-29T00:00:00Z", {
    source: { command: "domain-report" },
    auto: [{ domain: "telegram.org", confidence: "exact" }],
    candidates: [{ domain: "example.org" }],
  });
  assert.equal(db.prepare("select count(*) as count from normalized_catalog").get().count, 2);
  rebuildHourlyAggregates(db);
  assert.equal(db.prepare("select count(*) as count from hourly_traffic").get().count, 1);
  db.close();
});

test("schema includes collector reliability tables", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghostroute-console-schema-"));
  const db = new Database(path.join(tmp, "ghostroute.db"));
  ensureConsoleSchema(db);
  for (const table of ["hourly_traffic", "retention_runs", "collector_runs", "collector_errors"]) {
    assert.ok(db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(table), table);
  }
  assert.ok(db.prepare("select version from schema_migrations where version = 2").get());
  db.close();
});
