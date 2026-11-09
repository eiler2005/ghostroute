// Real browser and native-messaging checks. No operator profiles are touched.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,mkdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const {chromium}=require(process.env.GUARD_PLAYWRIGHT || path.join(repo,'modules/ghostroute-console/app/node_modules/playwright'));
const root=mkdtempSync(path.join(process.platform==='darwin'?'/tmp':tmpdir(),'guard-browser-test-'));
const report=process.env.GUARD_REPORT_DIR;
if(report)mkdirSync(report,{recursive:true});
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=fixture.example.org','-addext','subjectAltName=DNS:fixture.example.org','-keyout',path.join(root,'key.pem'),'-out',path.join(root,'cert.pem')],{stdio:'ignore'});
const fixture=spawn('python3',['-B',path.join(path.dirname(fileURLToPath(import.meta.url)),'browser_fixture.py'),root],{stdio:['ignore','pipe','inherit']});
let browser,ordinary,closeOwned;
try {
  const settings=await new Promise((resolve,reject)=>{
    let buffer='';fixture.stdout.on('data',data=>{buffer+=data;if(buffer.includes('\n'))resolve(JSON.parse(buffer.split('\n')[0]));});
    fixture.once('exit',()=>reject(new Error('Fixture exited before startup')));
  });
  const control=async action=>(await fetch(`http://127.0.0.1:${settings.control}/${action}`)).json();
  closeOwned=()=>control('close-browser');
  const endpoint=new URL(settings.dashboard);
  const api=async(action,payload)=>{
    const response=await fetch(endpoint.origin+'/api/'+action,{method:payload===undefined?'GET':'POST',headers:{Authorization:'Bearer '+endpoint.hash.slice(1),'Content-Type':'application/json'},...(payload===undefined?{}:{body:JSON.stringify(payload)})});
    assert.equal(response.status,200);return response.json();
  };
  const waitFor=async(condition,message)=>{for(let i=0;i<100;i++){if(await condition())return;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error(message);};
  const chrome=process.env.GUARD_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser=await chromium.launchPersistentContext(path.join(root,'browser'),{executablePath:chrome,headless:true,chromiumSandbox:true,args:[...settings.arguments,'--ignore-certificate-errors',`--log-net-log=${path.join(root,'netlog.json')}`]});
  const page=await browser.newPage();
  const mustFail=async url=>{let failed=false;try{await page.goto(url,{timeout:5000,waitUntil:'domcontentloaded'});}catch(_){failed=true;}assert(failed,'Expected a closed network path');};
  await mustFail('https://fixture.example.org/locked');
  assert.equal((await control('status')).origin,0);
  await api('activate',{route:'fixture'});
  await waitFor(async()=>(await api('status')).state==='active','Qualification did not finish');
  await page.goto('https://fixture.example.org/');
  assert.equal(await page.locator('h1').textContent(),'Protected fixture');
  const candidates=await page.evaluate(async({udp,tcp})=>{
    const pc=new RTCPeerConnection({iceServers:[{urls:`stun:127.0.0.1:${udp}`},{urls:`turn:127.0.0.1:${tcp}?transport=tcp`,username:'fixture',credential:'fixture'}]});
    const result=[];pc.onicecandidate=event=>{if(event.candidate)result.push(event.candidate.candidate);};
    pc.createDataChannel('fixture');await pc.setLocalDescription(await pc.createOffer());
    await new Promise(resolve=>setTimeout(resolve,2000));pc.close();return result;
  },{udp:settings.udp,tcp:settings.tripwire});
  assert.equal((await control('status')).udp,0);assert.equal(candidates.length,0);
  await mustFail('https://blocked.example.org/');
  await mustFail(`http://127.0.0.1:${settings.tripwire}/implicit-bypass`);
  await mustFail(`http://[::1]:${settings.tripwire6}/ipv6-bypass`);
  assert.equal((await control('status')).direct,0);
  const status=await api('status');assert(status.bytes_sent>0 && status.bytes_received>0);
  assert((await api('activity')).events.some(event=>event.reason==='not_allowed'));
  const beforeApplicationLaunch=(await control('status')).origin;
  const launched=await api('open',{url:'https://fixture.example.org/'});
  assert(Number.isInteger(launched.browser_pid) && launched.browser_pid>1,'Application did not report its owned Chrome PID');
  assert.equal((await control('status')).browser_opened,1);
  await waitFor(async()=>(await control('status')).origin>beforeApplicationLaunch,'Actual application launcher did not load its site');
  assert((await api('activity')).events.some(event=>event.reason==='browser_opened'));
  await closeOwned();
  await api('lock',{});await mustFail('https://fixture.example.org/lock-from-app');
  await control('delay');await api('activate',{route:'fixture'});
  assert.equal((await api('status')).state,'qualifying');
  await api('lock',{});await control('release');
  assert.equal((await api('status')).state,'locked');
  const allowedBeforeClear=(await api('status')).allowed;
  await api('activity/clear',{});
  assert.equal((await api('activity')).events.length,0);
  assert.equal((await api('status')).allowed,allowedBeforeClear);
  await control('upstream-down');await mustFail('https://fixture.example.org/upstream-down');
  assert((await api('activity')).events.some(event=>event.kind==='error'));
  await control('restore');

  // The unique host registration lives inside this temporary browser profile.
  assert(existsSync(chromium.executablePath()),'Install the test Chromium with playwright install chromium');
  const nativeName='org.ghostroute.guard.fixture_'+process.pid;
  const nativeDirectory=path.join(root,'ordinary','NativeMessagingHosts');mkdirSync(nativeDirectory,{recursive:true});
  const manifest=JSON.parse(readFileSync(settings.native_manifest));manifest.name=nativeName;
  writeFileSync(path.join(nativeDirectory,nativeName+'.json'),JSON.stringify(manifest),{mode:0o600,flag:'wx'});
  const workerPath=path.join(settings.extension,'background.js');
  writeFileSync(workerPath,readFileSync(workerPath,'utf8').replace('org.ghostroute.guard.events',nativeName));
  ordinary=await chromium.launchPersistentContext(path.join(root,'ordinary'),{channel:'chromium',headless:true,chromiumSandbox:true,args:[`--disable-extensions-except=${settings.extension}`,`--load-extension=${settings.extension}`,'--host-resolver-rules=MAP *.example.org 127.0.0.1']});
  const worker=ordinary.serviceWorkers()[0] || await ordinary.waitForEvent('serviceworker');
  assert.equal(new URL(worker.url()).hostname,settings.extension_id);
  await waitFor(async()=>(await api('status')).chrome_connected,'Native heartbeat not delivered');
  const ordinaryPage=await ordinary.newPage();
  const blockPage=async()=>{
    try{await ordinaryPage.goto(`http://fixture.example.org:${settings.plain_origin}/private?secret=must-not-log`,{timeout:5000});assert.fail('Sensitive main frame was allowed');} // FAKE query tests redaction.
    catch(error){assert(String(error).includes('ERR_BLOCKED_BY_CLIENT'),String(error));}
  };
  const beforeOrigin=(await control('status')).origin;await blockPage();
  await waitFor(async()=>(await api('activity')).events.some(event=>event.source==='chrome'),'Chrome event not delivered');
  assert.equal((await control('status')).origin,beforeOrigin);
  await ordinaryPage.goto(`http://notfixture.example.org:${settings.plain_origin}/`);
  assert.equal(await ordinaryPage.locator('h1').textContent(),'Protected fixture','Domain substring caused false block');
  await ordinaryPage.evaluate(async port=>{try{await fetch(`http://api.fixture.example.org:${port}/private?secret=must-not-log`,{method:'POST',body:'private-body-must-not-log'});}catch(_){}},settings.plain_origin); // FAKE query and body.
  await waitFor(async()=>(await api('activity')).events.some(event=>event.source==='chrome' && event.method==='POST'),'Subresource block not delivered');
  const proof=await api('activity');
  assert(!JSON.stringify(proof).includes('must-not-log'));
  if(report)writeFileSync(path.join(report,'fixture-proof.json'),JSON.stringify({guard:await api('status'),events:proof.events},null,2));
  await control('chrome-offline');
  const beforeOfflineOrigin=(await control('status')).origin;await blockPage();
  assert.equal((await control('status')).origin,beforeOfflineOrigin,'Loss of journal disabled Chrome block');
  await control('gate-down');await mustFail('https://fixture.example.org/gate-down');
  assert.equal((await control('status')).direct,0);
  await browser.close();browser=null;
  const netlog=JSON.parse(readFileSync(path.join(root,'netlog.json')));
  const names=Object.fromEntries(Object.entries(netlog.constants.logEventTypes).map(([name,id])=>[id,name]));
  assert.equal(netlog.events.filter(event=>/DNS_TRANSACTION|DNS_TASK/.test(names[event.type] || '')).length,0,'Protected browser performed DNS');
  console.log('PASS: real Chrome HTTPS, close/cancel and no direct/DNS/WebRTC bypass; counters and journal; actual Chrome main-frame/subresource block → native host → Guard; block persists when journal is unavailable.');
} finally {
  if(browser)await browser.close();if(ordinary)await ordinary.close();
  if(closeOwned)await closeOwned().catch(()=>{});
  fixture.kill('SIGTERM');rmSync(root,{recursive:true,force:true});
}
