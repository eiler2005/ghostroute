import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { channelTrafficFromSegments, channelTrafficHistory } from '../src/lib/channel-traffic.mjs';

test('keeps one device on different channels separate without adding detailed lanes twice', () => {
  const db = new Database(':memory:');
  db.exec('create table client_traffic_by_lane (bucket_granularity text, bucket_start_utc text, client_key text, channel text, traffic_lane text, bytes integer)');
  const insert = db.prepare('insert into client_traffic_by_lane values (?, ?, ?, ?, ?, ?)');
  insert.run('5min', '2026-01-01T00:00:00Z', 'device', 'Channel anyT', 'all', 100);
  insert.run('5min', '2026-01-01T00:00:00Z', 'device', 'Channel anyT', 'client_observed', 100);
  insert.run('5min', '2026-01-01T00:00:00Z', 'device', 'Channel Snell', 'all', 40);
  insert.run('5min', '2026-01-02T00:00:00Z', 'device', 'Channel Snell', 'all', 900);
  assert.deepEqual(channelTrafficFromSegments(db, [{ granularity: '5min', start: '2026-01-01', end: '2026-01-02' }]), [
    { channel: 'Channel anyT', bytes: 100 }, { channel: 'Channel Snell', bytes: 40 },
  ]);
  db.close();
});

test('daily history sums channels and client profiles without including detailed lanes', () => {
  const db = new Database(':memory:');
  db.exec('create table client_traffic_by_lane (bucket_granularity text, bucket_start_utc text, bucket_key text, client_key text, client_label text, channel text, traffic_lane text, bytes integer)');
  const add = db.prepare('insert into client_traffic_by_lane values (?, ?, ?, ?, ?, ?, ?, ?)');
  add.run('day', '2026-01-01T00:00:00Z', '2026-01-01', 'profile', 'Client', 'Channel anyT', 'all', 100);
  add.run('day', '2026-01-01T00:00:00Z', '2026-01-01', 'profile', 'Client', 'Channel anyT', 'detail', 100);
  add.run('day', '2026-01-01T00:00:00Z', '2026-01-01', 'profile', 'Client', 'Channel Snell', 'all', 40);
  add.run('day', '2026-01-02T00:00:00Z', '2026-01-02', 'profile', 'Client', 'Channel anyT', 'all', 20);
  const history = channelTrafficHistory(db, '2026-01-01', '2026-01-03');
  assert.deepEqual(history.daily.map((row) => row.bytes), [20, 100, 40]);
  assert.deepEqual(history.clients, [{ client: 'profile', label: 'Client', bytes: 160 }]);
  db.close();
});
