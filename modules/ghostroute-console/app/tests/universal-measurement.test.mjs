import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {ensureConsoleSchema, normalizeSnapshot, rebuildPreparedWindows} from '../scripts/lib/normalize.mjs';
import {assertTrafficVolumeContract} from '../scripts/lib/traffic-volume-contract.mjs';
import {trafficMeasurement} from '../src/lib/traffic-measurement.mjs';

const channels = ['Home Wi-Fi/LAN', 'A/Home Reality', 'Channel B', 'Channel C', 'Channel D', 'Channel anyT', 'Channel Snell', 'Channel Amn', 'Channel M'];

test('every channel keeps measured volume separate from connection and destination evidence', () => {
  const db = new Database(':memory:');
  try {
    ensureConsoleSchema(db);
    const facts = channels.flatMap((channel, index) => {
      const common = {client_key: `fixture-${index}`, client_label: `Fixture ${index}`, channel,
        traffic_class: 'client', confidence: 'observed', event_ts_utc: '2026-11-20T09:05:00.000Z'};
      return [
        {...common, fact_id: `volume-${index}`, sample_id: `volume-${index}`, bytes: 1000, via_vps_bytes: 0, direct_bytes: 0, unknown_bytes: 1000,
          destination: '', destination_kind: 'unattributed_counter', measurement_kind: 'counter_delta', measurement_role: 'volume',
          byte_confidence: 'observed_delta', evidence_level: 'isolated_channel_profile_counter', allocation_basis: 'observed_profile_counter_delta',
          interval_start_utc: '2026-11-20T09:00:00.000Z', interval_end_utc: '2026-11-20T09:05:00.000Z', route: 'Unknown'},
        {...common, fact_id: `event-${index}`, sample_id: `event-${index}`, bytes: 0, via_vps_bytes: 0, direct_bytes: 0, unknown_bytes: 0,
          destination: 'example.invalid', destination_kind: 'connection_event', measurement_kind: 'connection_event', measurement_role: 'detail',
          byte_confidence: 'not_measured', evidence_level: 'proxy_connection_event', allocation_basis: 'connection_event_only',
          route: 'VPS', route_verification: 'verified_vps', outbound: 'reality-out', connections: 1},
      ];
    });
    normalizeSnapshot(db, 1, 'traffic_facts', '2026-11-20T09:06:00.000Z', {traffic_facts: facts});
    normalizeSnapshot(db, 2, 'traffic_facts', '2026-11-20T09:07:00.000Z', {traffic_facts: facts});
    rebuildPreparedWindows(db, '2026-11-20T09:08:00.000Z');
    assert.equal(db.prepare('select count(*) n from normalized_flows').get().n, facts.length, 'repeated snapshots replace the same fact');
    assert.equal(db.prepare('select sum(bytes) n from client_traffic_5min').get().n, channels.length * 1000);
    assert.equal(db.prepare('select sum(via_vps_bytes) n from client_traffic_5min').get().n, 0, 'a routed event cannot allocate profile bytes');
    assert.equal(db.prepare('select sum(bytes) n from client_destination_traffic_5min').get().n, 0);
    assert.equal(db.prepare('select count(distinct channel) n from client_destination_traffic_5min').get().n, channels.length);
    assert.deepEqual(db.prepare('select distinct confidence from normalized_flows').all(), [{confidence:'observed'}]);
    assertTrafficVolumeContract(db);
  } finally { db.close(); }
});

test('unmeasured event bytes remain distinct from an observed zero on desktop and mobile consumers', () => {
  for (const channel of channels) {
    const event = {channel, bytes:0, confidence:'observed', evidence_json: JSON.stringify({measurement_kind:'connection_event',byte_confidence:'not_measured'})};
    assert.equal(trafficMeasurement(event).bytesMeasured, false);
    assert.equal(trafficMeasurement({...event, raw:{measurement_kind:'counter_delta',byte_confidence:'observed_delta'}}).bytesMeasured, true);
    assert.equal(trafficMeasurement({channel,bytes:0,confidence:'observed'}).bytesMeasured, true);
  }
});

test('measurement metadata survives an API roundtrip without raw evidence',()=>{
  for(const kind of ['connection_event','counter_delta','completed_stream','flow_sample']) {
    const source={measurement_kind:kind,byte_confidence:kind==='connection_event'?'not_measured':'observed_delta'};
    const measurement=trafficMeasurement({evidence_json:JSON.stringify(source),bytes:0});
    const api=JSON.parse(JSON.stringify({bytes:0,confidence:'observed',measurement}));
    assert.deepEqual(trafficMeasurement(api),measurement);
  }
});
