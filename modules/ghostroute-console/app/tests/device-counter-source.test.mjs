import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureConsoleSchema, normalizeSnapshot, deviceCounterRowsForWindow } from "../scripts/lib/normalize.mjs";
import { loadDeviceAttributions } from "../src/lib/device-attribution.mjs";

test("fact client totals do not become samples in a summary counter stream", () => {
  const db = new Database(":memory:");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-counter-fixture-"));
  try {
    ensureConsoleSchema(db);
    const device = total => ({id:"fixture", label:"Fixture", channel:"Home Wi-Fi/LAN", total_bytes:total, via_vps_bytes:total, direct_bytes:0});
    fs.writeFileSync(path.join(dir, "device-attribution.json"), JSON.stringify({clients:{fixture:{label:"Fixture", primary_channel:"Home Wi-Fi/LAN"}}}));
    const registry = loadDeviceAttributions(dir);
    normalizeSnapshot(db, 1, "traffic_summary", "2026-11-16T07:00:00.000Z", {devices:[device(1000)]});
    normalizeSnapshot(db, 2, "traffic_facts", "2026-11-16T07:01:00.000Z", {clients:[device(100)], traffic_facts:[]});
    normalizeSnapshot(db, 3, "traffic_summary", "2026-11-16T07:02:00.000Z", {devices:[device(1200)]});
    const rows = deviceCounterRowsForWindow(db, "today", "2026-11-16T08:00:00.000Z", registry);
    assert.equal(rows.reduce((sum, row) => sum + row.bytes, 0), 1200);
  } finally { db.close(); fs.rmSync(dir, {recursive:true, force:true}); }
});
