import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ensureConsoleSchema,normalizeSnapshot,rebuildPreparedWindows,deviceCounterRowsForWindow} from '../scripts/lib/normalize.mjs';
import {loadDeviceAttributions} from '../src/lib/device-attribution.mjs';

const at='2026-11-20T08:05:00.000Z',now='2026-11-20T10:05:00.000Z';
function fixture(keys,run){
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'console-volume-contract-'));
 const previous=process.env.GHOSTROUTE_CONSOLE_DATA_DIR;
 process.env.GHOSTROUTE_CONSOLE_DATA_DIR=folder;
 fs.writeFileSync(path.join(folder,'device-attribution.json'),JSON.stringify({clients:Object.fromEntries(keys.map(k=>[k,{label:k,primary_channel:'Home Wi-Fi/LAN'}]))}));
 const db=new Database(':memory:');
 try{ensureConsoleSchema(db);run(db,folder);}finally{db.close();if(previous===undefined)delete process.env.GHOSTROUTE_CONSOLE_DATA_DIR;else process.env.GHOSTROUTE_CONSOLE_DATA_DIR=previous;fs.rmSync(folder,{recursive:true,force:true});}
}
function volume(key,channel,amount,id=key){return {fact_id:id,client_key:key,client_label:key,channel,
 event_ts_utc:at,bytes:amount,bytes_up:0,bytes_down:amount,via_vps_bytes:0,direct_bytes:0,unknown_bytes:amount,
 destination:'',destination_kind:'unattributed_counter',measurement_role:'volume',measurement_scope:'isolated_profile_counter',
 confidence:'observed',byte_confidence:'observed_delta',traffic_class:'client',route:'Unknown'};}
function prepared(db){rebuildPreparedWindows(db,now);return JSON.parse(db.prepare("SELECT payload_json FROM traffic_window_snapshots WHERE kind='dashboard' AND window='today' AND traffic_class='all'").get().payload_json);}

test('dashboard KPI, chart and client sum use the same cross-channel volume',()=>fixture(['home','remote'],db=>{
 const summary={totals:{client_observed_bytes:1024**3,via_vps_bytes:1024**3,direct_bytes:0,unknown_bytes:0}};
 db.prepare("INSERT INTO snapshots(type,collected_at,source,path,payload_json) VALUES('traffic_summary',?,'fixture','',?)").run(at,JSON.stringify(summary));
 normalizeSnapshot(db,2,'traffic_facts',at,{traffic_facts:[volume('home','Home Wi-Fi/LAN',2*1024**3),volume('remote','Channel anyT',4*1024**3)]});
 const p=prepared(db),sum=p.devices.reduce((n,r)=>n+r.bytes,0);
 assert.equal(sum,6*1024**3);
 assert.equal(p.totals.observedBytes,sum,'a LAN-only summary cannot replace all-channel client volume');
 assert.equal(p.totals.unknownBytes,sum);
 assert.equal(p.dashboardAnalytics.trafficToday.totalBytes,sum);
 assert.equal(p.dashboardAnalytics.trafficToday.points.at(-1).totalBytes,sum);
 assert.equal(p.dashboardAnalytics.trafficReconciliation.summaryBytes,1024**3,'independent summary remains diagnostic');
 assert.equal(p.dashboardAnalytics.topClients.reduce((n,r)=>n+r.bytes,0),sum);
}));

test('client volume is never truncated by a display ranking limit',()=>{
 const keys=Array.from({length:205},(_,i)=>'fixture-'+i);
 fixture(keys,db=>{normalizeSnapshot(db,1,'traffic_facts',at,{traffic_facts:keys.map(k=>volume(k,'Channel anyT',100))});
 const p=prepared(db);assert.equal(p.totals.observedBytes,20500);assert.equal(p.devices.reduce((n,r)=>n+r.bytes,0),20500);});
});

test('unattributed destination detail does not duplicate its owning volume bucket',()=>fixture([],db=>{
 normalizeSnapshot(db,1,'traffic_facts',at,{traffic_facts:[{...volume('192.0.2.10','Home Wi-Fi/LAN',100),
   destination:'unknown destination',destination_kind:'unknown',
   measurement_role:'volume',measurement_scope:'conntrack_sample',evidence_level:'flow_sample'}]});
 const p=prepared(db);assert.equal(p.totals.observedBytes,100);
 assert.equal(p.devices.reduce((n,r)=>n+r.bytes,0),100);
 assert.equal(p.dashboardAnalytics.trafficToday.totalBytes,100);
}));

test('chart follows the same counter-versus-fact ownership across hours',()=>fixture(['home','remote'],db=>{
 for (const [id,ts,total] of [[1,'2026-11-20T07:05:00.000Z',100],[2,at,150]]) {
   normalizeSnapshot(db,id,'traffic_summary',ts,{devices:[{id:'home',label:'home',channel:'Home Wi-Fi/LAN',total_bytes:total,via_vps_bytes:total,direct_bytes:0}]});
 }
 normalizeSnapshot(db,3,'traffic_facts',at,{traffic_facts:[
   volume('home','Home Wi-Fi/LAN',80),volume('remote','Channel anyT',200),
   {...volume('home','Home Wi-Fi/LAN',30,'destination'),destination:'example.invalid',destination_kind:'domain',measurement_role:'detail'},
 ]});
 const p=prepared(db),points=p.dashboardAnalytics.trafficToday.points;
 assert.equal(p.totals.observedBytes,350,'overlapping counter and sampled facts are not added');
 assert.equal(points.find(r=>r.hour==='10:00').totalBytes,100);
 assert.equal(points.at(-1).totalBytes,350);
 assert.equal(points.at(-1).viaVpsBytes,150);
 assert.equal(points.at(-1).unknownBytes,200);
 assert.equal(points.some(r=>Number.parseInt(r.hour,10)>13),false,'future hours must not imply a measured zero');
}));

test('summary counter retains its measured channel despite registry primary channel',()=>fixture(['fixture'],(db,folder)=>{
 fs.writeFileSync(path.join(folder,'device-attribution.json'),JSON.stringify({clients:{fixture:{label:'fixture',primary_channel:'A/Home Reality'}}}));
 normalizeSnapshot(db,1,'traffic_summary',at,{devices:[{id:'fixture',label:'fixture',channel:'Home Wi-Fi/LAN',total_bytes:100,via_vps_bytes:100,direct_bytes:0}]});
 const rows=deviceCounterRowsForWindow(db,'today',now,loadDeviceAttributions(folder));
 assert.equal(rows[0].channel,'Home Wi-Fi/LAN');
}));
