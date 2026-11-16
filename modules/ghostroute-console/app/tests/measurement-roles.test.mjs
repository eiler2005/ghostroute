import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {ensureConsoleSchema,normalizeSnapshot,rebuildPreparedWindows} from '../scripts/lib/normalize.mjs';
import {trafficRankingMetrics,appByteQuality} from '../src/lib/traffic-ranking.mjs';
import {classifyAppFamily} from '../src/lib/app-family.mjs';
import {assertTrafficVolumeContract} from '../scripts/lib/traffic-volume-contract.mjs';

test('measured volume and application detail are independent partitions, not additive traffic',()=>{
 const db=new Database(':memory:');
 try {
  ensureConsoleSchema(db);
  const common={client_key:'fixture',client_label:'Fixture',channel:'Home Wi-Fi/LAN',route:'Direct',traffic_class:'client',confidence:'observed',event_ts_utc:'2026-11-16T09:05:00.000Z',allocation_basis:'observed_delta',evidence_level:'flow_sample',accounting_status:'ok',sources:['traffic-evidence']};
  const volume=20*1024**3, detail=8*1024**2;
  normalizeSnapshot(db,1,'traffic_facts','2026-11-16T09:06:00.000Z',{traffic_facts:[
   {...common,fact_id:'counter',bytes:volume,direct_bytes:volume,via_vps_bytes:0,unknown_bytes:0,destination:'',destination_kind:'unattributed_counter',measurement_role:'volume',measurement_scope:'fixture_counter',interval_start_utc:'2026-11-16T09:00:00.000Z',interval_end_utc:'2026-11-16T09:05:00.000Z'},
   {...common,fact_id:'detail',bytes:detail,direct_bytes:detail,via_vps_bytes:0,unknown_bytes:0,destination:'example.invalid'},
  ]});
  rebuildPreparedWindows(db,'2026-11-16T09:07:00.000Z');
  assert.equal(db.prepare('select sum(bytes) n from client_traffic_5min').get().n,volume);
  assert.equal(db.prepare('select sum(bytes) n from client_destination_traffic_5min').get().n,detail);
  assert.equal(db.prepare("select sum(bytes) n from client_traffic_by_lane where bucket_granularity='5min' and traffic_lane='all'").get().n,volume);
  const counter=(id,start,end,bytes)=>({...common,fact_id:id,event_ts_utc:end,bytes,direct_bytes:bytes,via_vps_bytes:0,unknown_bytes:0,destination:'',destination_kind:'unattributed_counter',measurement_role:'volume',measurement_scope:'fixture_counter',interval_start_utc:start,interval_end_utc:end});
  normalizeSnapshot(db,2,'traffic_facts','2026-11-16T09:11:00.000Z',{traffic_facts:[
   counter('extended','2026-11-16T09:00:00.000Z','2026-11-16T09:10:00.000Z',2*volume),
  ]});
  rebuildPreparedWindows(db,'2026-11-16T09:12:00.000Z');
  assert.equal(db.prepare('select sum(bytes) n from client_traffic_5min').get().n,2*volume,'live endpoint supersedes earlier partial volume');
  normalizeSnapshot(db,3,'traffic_facts','2026-11-16T16:16:00.000Z',{traffic_facts:[
   counter('retained','2026-11-16T09:00:00.000Z','2026-11-16T09:12:00.000Z',3*volume),
   counter('next','2026-11-16T09:12:00.000Z','2026-11-16T16:15:00.000Z',volume),
  ]});
  rebuildPreparedWindows(db,'2026-11-16T16:17:00.000Z');
  assert.equal(db.prepare('select sum(bytes) n from client_traffic_5min').get().n,4*volume,'retained interval replaces live partials and adjacent interval remains additive');
  assert.equal(db.prepare("select sum(bytes) n from client_traffic_by_lane where bucket_granularity='5min' and traffic_lane='all'").get().n,4*volume);
  assert.equal(db.prepare('select sum(bytes) n from client_destination_traffic_5min').get().n,detail);
  normalizeSnapshot(db,4,'traffic_facts','2026-11-16T16:20:00.000Z',{traffic_facts:[
   {...counter('second-interface','2026-11-16T09:00:00.000Z','2026-11-16T16:15:00.000Z',volume),client_ip:'192.0.2.30'},
  ]});
  rebuildPreparedWindows(db,'2026-11-16T16:21:00.000Z');
  assert.equal(db.prepare('select sum(bytes) n from client_traffic_5min').get().n,5*volume,'independent counter sources mapped to one device are not superseded');
  assertTrafficVolumeContract(db);
  db.prepare("update client_traffic_by_lane set bytes=bytes+1 where bucket_granularity='5min' and traffic_lane='all'").run();
  assert.throws(()=>assertTrafficVolumeContract(db),/volume differs/,'the production verifier rejects a broken consumer partition');
 } finally {db.close()}
});
test('rank share uses sum and bar geometry uses maximum',()=>{
 const m=trafficRankingMetrics([{bytes:100},{bytes:60},{bytes:40}]);
 assert.deepEqual(m.map(r=>r.sharePct),[50,30,20]);
 assert.deepEqual(m.map(r=>r.relativePct),[100,60,40]);
});
test('residual cannot inherit an application or factual attribution from provider hints',()=>{
 const row={attribution_source:'aggregate_residual',provider:'Google',destination:'youtube.com',factual_bytes:10,residual_bytes:100};
 assert.equal(classifyAppFamily(row).app_source,'aggregate_residual');
 assert.equal(classifyAppFamily(row).app_family,'Other / uncategorized');
 assert.equal(appByteQuality(row),'residual');
});
