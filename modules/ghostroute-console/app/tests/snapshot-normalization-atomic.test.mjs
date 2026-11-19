import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { ensureConsoleSchema, normalizeSnapshot } from "../scripts/lib/normalize.mjs";

test("a failed snapshot restores previous facts and normalized rows atomically", () => {
  const db = new Database(":memory:");
  try {
    ensureConsoleSchema(db);
    const fact = {fact_id:"stable", client_key:"fixture", client_label:"Fixture", channel:"Home Wi-Fi/LAN", destination:"example.invalid", bytes:10, unknown_bytes:10};
    normalizeSnapshot(db,1,"traffic_facts","2026-11-19T10:00:00Z",{traffic_facts:[fact]});
    db.exec("create trigger reject_fixture before insert on normalized_flows when new.destination='reject.invalid' begin select raise(abort,'fixture failure'); end");
    assert.throws(() => normalizeSnapshot(db,1,"traffic_facts","2026-11-19T10:01:00Z",{traffic_facts:[{...fact,bytes:20,unknown_bytes:20},{...fact,fact_id:"bad",destination:"reject.invalid"}]}), /fixture failure/);
    assert.equal(db.prepare("select bytes from traffic_facts where fact_id='stable'").get().bytes,10);
    assert.equal(db.prepare("select bytes from normalized_flows where snapshot_id=1").get().bytes,10);
    assert.equal(db.prepare("select count(*) n from traffic_facts where fact_id='bad'").get().n,0);
    const plan=db.prepare("explain query plan delete from normalized_flows where snapshot_type='traffic_facts' and json_valid(raw_json) and json_extract(raw_json,'$.fact_id')=?").all("stable");
    assert.ok(plan.some(row=>/SEARCH .*idx_normalized_flows_fact_id/.test(row.detail)),JSON.stringify(plan));
  } finally {db.close();}
});

