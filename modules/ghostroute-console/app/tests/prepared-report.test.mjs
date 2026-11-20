import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function run(prepared) {
  const text=fs.readFileSync(new URL('../src/lib/server/selectors.ts',import.meta.url),'utf8');
  const source=text.match(/export function buildReportModel\([\s\S]*?\n\}/)[0]
    .replace('export ','').replace('filters: ConsoleFilters = {}','filters = {}').replace('): ConsoleModel',')');
  const requested=[], decorated=[];
  const model=vm.runInNewContext(`${source};buildReportModel({period:'week',trafficClass:'client'})`,{
    withSnapshotVersion: fn=>fn(),
    getPreparedWindowSnapshot: (...args)=>{requested.push(args);return {payload:prepared};},
    buildLightweightShellModel: ()=>({totals:{observedBytes:0},alerts:[]}),
    latestSnapshotMetaRecords: ()=>[{type:'health',collectedAt:'2026-01-01T00:00:00Z'}],
    latestByType: rows=>Object.fromEntries(rows.map(row=>[row.type,row])),
    filterRows: rows=>rows,
    decorateTrafficRow: row=>{decorated.push(row);return row;},
    buildConsoleModel: ()=>{throw Error('export loaded unrelated raw snapshots');},
  });
  return {model,requested,decorated};
}

test('safe report uses the selected prepared window and bounds work before decoration',()=>{
  const rows=Array.from({length:1000},(_,id)=>({id,bytes:id}));
  const {model,requested,decorated}=run({totals:{observedBytes:123},flows:rows,devices:rows});
  assert.deepEqual(requested,[['reports_llm_safe','week','client']]);
  assert.equal(model.totals.observedBytes,123);
  assert.equal(model.flows.length,40);
  assert.equal(decorated.length,40);
  assert.equal(model.devices.length,30);
  assert.equal(model.snapshots.health.type,'health');
});

test('missing prepared report yields empty evidence without loading raw history',()=>{
  const {model,decorated}=run(undefined);
  assert.equal(model.flows.length,0);assert.equal(model.devices.length,0);assert.equal(decorated.length,0);
});
