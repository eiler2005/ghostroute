// Exercise the real controller against Chrome settings, including upgrade from
// a previously composed PAC. All addresses and settings below are disposable.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
const source='function FindProxyForURL(){return "PROXY external.example.invalid:10080";}';
async function scenario(mode, initial, control='controlled_by_this_extension'){
  let proxy={levelOfControl:control,value:initial},blocked=0;
  const setting=value=>({get:async()=>({levelOfControl:'controlled_by_this_extension',value}),set:async next=>{value=next.value;},onChange:{addListener(){}}});
  const settings={get:async()=>proxy,set:async next=>{proxy={levelOfControl:'controlled_by_this_extension',value:next.value};},onChange:{addListener(){}}};
  const context=vm.createContext({TextEncoder,TextDecoder,btoa,atob,crypto:webcrypto,
    fetch:async url=>({ok:true,json:async()=>url==='ordinary-routing.json'?{mode}:[]}),
    chrome:{runtime:{getURL:p=>p},proxy:{settings,onProxyError:{addListener(){}}},privacy:{network:{webRTCIPHandlingPolicy:setting('default'),networkPredictionEnabled:setting(true)}}}});
  for(const file of ['pac.js','strict.js'])vm.runInContext(readFileSync(new URL('../extension/'+file,import.meta.url),'utf8'),context);
  const guard=new context.GuardStrict(Promise.resolve([{condition:{requestDomains:['sensitive.example.org']}}]),async()=>{blocked++;},()=>{});
  await guard.loaded;
  await guard.sync({enabled:true,system_direct:true,port:10081,catalog_digest:guard.digest});
  return {guard,proxy,blocked,pac:context.GuardPAC};
}
const provider={mode:'pac_script',pacScript:{data:source}};
const explicit=await scenario('external_pac',provider);
assert(explicit.guard.ready);assert.equal(explicit.guard.report().baseline,'external_pac');
assert.equal(explicit.pac.baseline(explicit.proxy.value.pacScript.data,true),source);
// Upgrade must drop both a provider PAC and its embedded previous Guard snapshot.
for(const initial of [provider,explicit.proxy.value]){
  const {guard,proxy}=await scenario('network',initial);
  assert(guard.ready);assert.equal(guard.report().baseline,'direct');
  assert(!proxy.value.pacScript.data.includes('external.example.invalid'));
  assert(!proxy.value.pacScript.data.includes('GhostRoute baseline'));
  const resolver=vm.createContext({});vm.runInContext(proxy.value.pacScript.data,resolver);
  assert.equal(resolver.FindProxyForURL('https://ordinary.example.org/','ordinary.example.org'),'DIRECT');
  assert.equal(resolver.FindProxyForURL('https://sensitive.example.org/','sensitive.example.org'),'PROXY 127.0.0.1:10081');
  await guard.sync({enabled:false});
  assert.equal(guard.ready,false);assert.equal(proxy.value.pacScript.mandatory,true);
  // Same controller restart/requalification must not restore an old snapshot.
  await guard.sync({enabled:true,system_direct:true,port:10082,catalog_digest:guard.digest});
  assert(guard.ready);assert.equal(guard.baseline,null);
}
const malformed=await scenario('network',{mode:'pac_script',pacScript:{data:'// GhostRoute sensitive route\n// GhostRoute baseline !!!\n'}});
assert(malformed.guard.ready,'Network mode must not parse or execute obsolete provider source');
const conflict=await scenario('network',provider,'controlled_by_other_extensions');
assert.equal(conflict.guard.ready,false);assert.equal(conflict.guard.state,'conflict');assert.equal(conflict.proxy.value,provider);
await assert.rejects(()=>scenario('unknown',provider),/Invalid ordinary routing/);
console.log('PASS: network default drops provider and legacy snapshots, sensitive gate retained, external PAC explicit, conflicts and invalid policy fail closed');
