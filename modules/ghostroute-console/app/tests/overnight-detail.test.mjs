import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {ensureConsoleSchema, normalizeSnapshot, rebuildPreparedWindows} from '../scripts/lib/normalize.mjs';
import {assertTrafficVolumeContract} from '../scripts/lib/traffic-volume-contract.mjs';

test('overnight prepared rankings retain measured domain/provider detail independently of volume',()=>{
 const db=new Database(':memory:');
 try {
  ensureConsoleSchema(db);
  db.prepare("insert into ip_enrichment_cache(ip,provider,lookup_status,confidence,source) values (?,'Apple Inc.','hit','estimated','fixture')").run('192.0.2.20');
  const at='2026-11-17T00:05:00.000Z', now='2026-11-17T06:07:00.000Z';
  const common={client_key:'192.0.2.10',client_ip:'192.0.2.10',client_label:'Fixture',channel:'Home Wi-Fi/LAN',route:'VPS',traffic_class:'client',confidence:'observed',event_ts_utc:at,allocation_basis:'observed_delta',evidence_level:'flow_sample',sources:['traffic-evidence']};
  const volume=10*1024**3,domainBytes=5*1024**2,providerBytes=2*1024**2;
  const facts=[
   {...common,fact_id:'volume',bytes:volume,via_vps_bytes:volume,direct_bytes:0,unknown_bytes:0,destination:'',destination_kind:'unattributed_counter',measurement_role:'volume',measurement_scope:'lan_route_counter',interval_start_utc:'2026-11-16T21:00:00.000Z',interval_end_utc:at},
   {...common,fact_id:'domain',bytes:domainBytes,via_vps_bytes:domainBytes,destination:'api.x.com',dns_qname:'api.x.com',destination_kind:'domain',measurement_role:'detail'},
   {...common,fact_id:'provider',bytes:providerBytes,via_vps_bytes:providerBytes,destination:'192.0.2.20',destination_ip:'192.0.2.20',destination_kind:'ip',measurement_role:'detail'},
  ];
  normalizeSnapshot(db,1,'traffic_facts',at,{traffic_facts:facts});
  rebuildPreparedWindows(db,now);
  assertTrafficVolumeContract(db);
  const prepared=JSON.parse(db.prepare("select payload_json from traffic_window_snapshots where kind='dashboard' and window='today' and traffic_class='all'").get().payload_json);
  assert.equal(prepared.totals.observedBytes,volume,'detail must not inflate volume');
  assert.equal(prepared.dashboardAnalytics.trafficReconciliation.destinationEvidenceBytes,domainBytes+providerBytes);
  const destinations=prepared.dashboardAnalytics.topDestinations;
  assert.ok(destinations.some(r=>/apple/i.test(r.label)),'provider-only measured detail must remain visible');
  assert.ok(destinations.some(r=>r.label==='api.x.com'));
  assert.ok(prepared.dashboardAnalytics.topAppFamilies.some(r=>r.app_family==='X / Twitter'),'prepared app ranking must not depend on request-time fallback');
  assert.equal(prepared.dashboardAnalytics.topAppFamilies.reduce((s,r)=>s+r.bytes,0),domainBytes+providerBytes,'unknown volume is not allocated to popular apps');
 } finally {db.close()}
});
