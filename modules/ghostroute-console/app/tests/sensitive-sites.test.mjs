import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { ensureConsoleSchema, normalizeSnapshot } from "../scripts/lib/normalize.mjs";

test("sensitive site live evidence preserves its outbound and policy", () => {
  const db = new Database(":memory:");
  try {
    ensureConsoleSchema(db);
    normalizeSnapshot(db, 1, "live", "2026-10-31T10:00:00Z", {
      source: { command: "live-events-report" },
      cursor: { next: "sensitive-fixture" },
      events: [{
        event_id: "sensitive-fixture",
        event_type: "route.decision",
        ts: "2026-10-31T10:00:00Z",
        client: "fixture-client",
        channel: "Channel A",
        destination: "claude.ai",
        destination_port: "443",
        route_decision: "VPS",
        sing_box_outbound: "sensitive-out",
        matched_rule: "SENSITIVE_SITES",
        confidence: "exact",
      }],
    });
    const row = db.prepare("select outbound, matched_rule from route_decisions where event_id = ?").get("sensitive-fixture");
    assert.equal(row.outbound, "sensitive-out");
    assert.equal(row.matched_rule, "SENSITIVE_SITES");
  } finally {
    db.close();
  }
});
