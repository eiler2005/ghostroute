import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ensureConsoleSchema, normalizeSnapshot, rebuildPreparedWindows } from '../scripts/lib/normalize.mjs';

test('repeated snapshots retain fact event times and do not duplicate channel bytes', () => {
  const db = new Database(':memory:');
  try {
    ensureConsoleSchema(db);
    const fact = (id, ts, count) => ({
      fact_id: id, sample_id: id, event_ts_utc: ts, event_ts: ts, observed_at_utc: ts,
      client_key: 'anyT-01', client_label: 'anyT-01', channel: 'Channel anyT', route: 'Unknown',
      destination: 'Encrypted channel ingress', destination_kind: 'encrypted_ingress', traffic_class: 'client',
      bytes: count, bytes_up: count, bytes_down: 0, unknown_bytes: count, direct_bytes: 0, via_vps_bytes: 0,
      confidence: 'observed', sources: ['traffic-evidence'], evidence_level: 'isolated_channel_profile_counter',
    });
    const first = fact('first', '2026-11-16T09:01:00.000Z', 100);
    const second = fact('second', '2026-11-16T09:12:00.000Z', 200);
    function snapshot(time, facts) {
      const payload = { schema_version: 3, clients: [], traffic_facts: facts, dns_links: [] };
      const id = Number(db.prepare("insert into snapshots(type,collected_at,source,path,payload_json) values('traffic_facts',?,'test','',?)").run(time, JSON.stringify(payload)).lastInsertRowid);
      normalizeSnapshot(db, id, 'traffic_facts', time, payload);
      rebuildPreparedWindows(db, new Date(Date.parse(time) + 1000).toISOString());
    }
    snapshot('2026-11-16T09:10:00.000Z', [first]);
    snapshot('2026-11-16T09:15:00.000Z', [first, second]);
    const rows = db.prepare("select bucket_start_utc, sum(bytes) as bytes from client_traffic_5min where channel = 'Channel anyT' group by bucket_start_utc order by bucket_start_utc").all();
    assert.deepEqual(rows, [
      { bucket_start_utc: '2026-11-16T09:00:00.000Z', bytes: 100 },
      { bucket_start_utc: '2026-11-16T09:10:00.000Z', bytes: 200 },
    ]);
    const lane = db.prepare("select sum(bytes) as bytes from client_traffic_by_lane where bucket_granularity = 'day' and channel = 'Channel anyT' and traffic_lane = 'all'").get();
    assert.equal(lane.bytes, 300);
  } finally { db.close(); }
});
