import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { channelAppEvidence, channelClientsFromSegments } from '../src/lib/channel-traffic.mjs';
import { routeSplitLabel } from '../src/lib/route-split-label.mjs';
import { groupAdvisories } from '../src/lib/advisory-groups.mjs';

test('unattributed channel bytes never appear as known zero routes', () => {
  assert.equal(routeSplitLabel(0, 0, 10, String), 'Route not observed · 10 unattributed');
  assert.equal(routeSplitLabel(2, 3, 5, String), 'VPS 2 · Direct 3 · Unknown 5');
});

test('channel clients combine disjoint periods but do not double-count detail lanes', () => {
  const db = new Database(':memory:');
  db.exec('create table client_traffic_by_lane (bucket_granularity text, bucket_start_utc text, channel text, client_key text, client_label text, traffic_lane text, bytes integer, last_seen_utc text)');
  const add = db.prepare('insert into client_traffic_by_lane values (?, ?, ?, ?, ?, ?, ?, ?)');
  add.run('hour', '2026-01-01', 'Channel anyT', 'p1', 'Profile', 'all', 10, '2026-01-01T10:00Z');
  add.run('hour', '2026-01-01', 'Channel anyT', 'p1', 'Profile', 'detail', 10, '2026-01-01T10:00Z');
  add.run('5min', '2026-01-02', 'Channel anyT', 'p1', 'Profile', 'all', 20, '2026-01-02T11:00Z');
  add.run('5min', '2026-01-02', 'Channel D', 'p1', 'Profile', 'all', 5, '2026-01-02T11:00Z');
  const rows = channelClientsFromSegments(db, [{granularity:'hour',start:'2026-01-01',end:'2026-01-02'}, {granularity:'5min',start:'2026-01-02',end:'2026-01-03'}]);
  assert.deepEqual(rows.map(r => [r.channel, r.bytes, r.last_seen]), [['Channel anyT',30,'2026-01-02T11:00Z'],['Channel D',5,'2026-01-02T11:00Z']]);
  db.close();
});

test('groups identical advisories while preserving distinct decisions and evidence', () => {
  const row = {destination_key:'example.invalid', proposed_action:'ask_user', status:'pending', reason_code:'no_dns', explanation:'No safe match'};
  const groups = groupAdvisories([{...row,candidate_id:'1'}, {...row,candidate_id:'2'}, {...row,candidate_id:'3',proposed_action:'monitor'}]);
  assert.deepEqual(groups.map(group => group.evidenceRows.length), [2, 1]);
});

test('channel app evidence excludes counters, IP-only rows and other channels', () => {
  const db = new Database(':memory:');
  db.exec('create table client_destination_by_lane (client_key text, bucket_granularity text, bucket_start_utc text, channel text, traffic_lane text, destination_label text, category text, provider text, bytes integer, last_seen_utc text)');
  const add = db.prepare('insert into client_destination_by_lane values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  add.run('p1','5min','2026-01-01','Channel anyT','client_observed','youtube.com','','',40,'2026-01-01T10:00Z');
  add.run('p1','5min','2026-01-01','Channel anyT','all','youtube.com','','',40,'2026-01-01T10:00Z');
  add.run('p1','5min','2026-01-01','Channel anyT','client_observed','192.0.2.1','','',100,'2026-01-01T10:00Z');
  add.run('p1','5min','2026-01-01','Channel D','client_observed','youtube.com','','',300,'2026-01-01T10:00Z');
  add.run('p2','5min','2026-01-01','Channel anyT','client_observed','youtube.com','','',20,'2026-01-01T10:00Z');
  const rows = channelAppEvidence(db,[{granularity:'5min',start:'2026-01-01',end:'2026-01-02'}],[{channel:'Channel anyT',client:'p1',label:'One'}, {channel:'Channel anyT',client:'p2',label:'Two'}]);
  assert.deepEqual(rows.map(r => [r.channel,r.client,r.app,r.bytes]), [['Channel anyT','p1','YouTube',40],['Channel anyT','p2','YouTube',20]]);
  const selected = channelAppEvidence(db,[{granularity:'5min',start:'2026-01-01',end:'2026-01-02'}],[...Array.from({length:20},(_,i)=>({channel:'Other',client:`unused-${i}`})),{channel:'Channel anyT',client:'p2',label:'Two'}],{channel:'Channel anyT',client:'p2'});
  assert.deepEqual(selected.map(r => [r.client,r.bytes]), [['p2',20]]);
  const searched = channelAppEvidence(db,[{granularity:'5min',start:'2026-01-01',end:'2026-01-02'}],[...Array.from({length:20},(_,i)=>({channel:'Other',client:`unused-${i}`})),{channel:'Channel anyT',client:'p2',label:'Two'}],{search:'youtube'});
  assert.deepEqual(searched.map(r => [r.client,r.bytes]), [['p2',20]]);
  db.close();
});
