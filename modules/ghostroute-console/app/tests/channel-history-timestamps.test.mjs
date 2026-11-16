import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ensureConsoleSchema, normalizeSnapshot, rebuildPreparedWindows, pruneOperationalTables } from '../scripts/lib/normalize.mjs';
import { channelTrafficFromSegments, channelClientsFromSegments, channelTrafficHistory } from '../src/lib/channel-traffic.mjs';

test('counter-only channel totals and clients survive without destination evidence', () => {
  const db = new Database(':memory:');
  try {
    ensureConsoleSchema(db);
    normalizeSnapshot(db, 1, 'router_rollups', '2026-11-16T07:00:00.000Z', {
      traffic_totals:[{layer:'5min',window_start_msk:'2026-11-16T10:00:00+0300',client_key:'fixture',client_label:'Fixture',channel:'Channel anyT',route:'Unknown',traffic_class:'client',bytes:1000,via_vps_bytes:0,direct_bytes:0,unknown_bytes:1000,flows:1}],
      traffic_destinations:[],dns_rollups:[],
    });
    rebuildPreparedWindows(db, '2026-11-16T07:10:00.000Z');
    const segments=[{granularity:'5min',start:'2026-11-16T07:00:00.000Z',end:'2026-11-16T07:10:00.000Z'}];
    assert.deepEqual(channelTrafficFromSegments(db,segments),[{channel:'Channel anyT',bytes:1000}]);
    assert.equal(channelClientsFromSegments(db,segments)[0].bytes,1000);
    assert.equal(channelTrafficHistory(db,'2026-11-15T21:00:00.000Z','2026-11-16T08:00:00.000Z').daily[0].bytes,1000);
  } finally { db.close(); }
});

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
      pruneOperationalTables(db, time);
      rebuildPreparedWindows(db, new Date(Date.parse(time) + 1000).toISOString());
    }
    snapshot('2026-11-16T09:10:00.000Z', [first]);
    snapshot('2026-11-16T09:15:00.000Z', [first, second]);
    snapshot('2026-11-16T09:20:00.000Z', [second]);
    snapshot('2026-11-16T09:25:00.000Z', []);
    snapshot('2026-11-16T09:30:00.000Z', [second, first]);
    for (let i = 0; i < 20; i++) snapshot(`2026-11-16T09:${String(31+i).padStart(2,'0')}:00.000Z`, [first, second]);
    assert.equal(db.prepare("select count(*) as n from normalized_flows where snapshot_type='traffic_facts'").get().n, 2);
    assert.equal(db.prepare("select count(*) as n from traffic_facts").get().n, 2);
    const rows = db.prepare("select bucket_start_utc, sum(bytes) as bytes from client_traffic_5min where channel = 'Channel anyT' group by bucket_start_utc order by bucket_start_utc").all();
    assert.deepEqual(rows, [
      { bucket_start_utc: '2026-11-16T09:00:00.000Z', bytes: 100 },
      { bucket_start_utc: '2026-11-16T09:10:00.000Z', bytes: 200 },
    ]);
    const lane = db.prepare("select sum(bytes) as bytes from client_traffic_by_lane where bucket_granularity = 'day' and channel = 'Channel anyT' and traffic_lane = 'all'").get();
    assert.equal(lane.bytes, 300);
  } finally { db.close(); }
});
