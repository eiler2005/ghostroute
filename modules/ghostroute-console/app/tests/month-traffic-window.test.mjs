import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { ensureConsoleSchema, normalizeSnapshot, rebuildPreparedWindows } from "../scripts/lib/normalize.mjs";

test("calendar month includes daily buckets in its first partial week", () => {
  const db = new Database(":memory:");
  try {
    ensureConsoleSchema(db);
    for (const [i, day] of ["01", "02", "03"].entries()) {
      const ts = `2026-11-${day}T09:00:00.000Z`;
      const fact = {
        fact_id: `month-${day}`, client_key: "fixture", client_label: "Fixture",
        channel: "Home Wi-Fi/LAN", event_ts_utc: ts, display_ts_utc: ts,
        observed_at_utc: ts, route: "VPS", traffic_class: "client",
        destination: "example.invalid", destination_kind: "domain",
        bytes: 100, via_vps_bytes: 100, direct_bytes: 0, unknown_bytes: 0,
        confidence: "observed", evidence_level: "flow_sample",
        allocation_basis: "observed_delta", accounting_status: "ok",
        sources: ["traffic-evidence"],
      };
      normalizeSnapshot(db, i + 1, "traffic_facts", ts, { traffic_facts: [fact] });
      rebuildPreparedWindows(db, `2026-11-${day}T10:00:00.000Z`);
    }
    const payload = JSON.parse(db.prepare("select payload_json from traffic_window_snapshots where kind = 'dashboard' and window = 'month' and traffic_class = 'all'").get().payload_json);
    assert.equal(payload.totals.observedBytes, 300);
  } finally {
    db.close();
  }
});
