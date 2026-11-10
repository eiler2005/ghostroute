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
  closeOwned=async()=>{
    await control('close-browser');
    await waitFor(async()=>(await control('status')).browser_running===false,'Owned Chrome did not close');
  };
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
  await waitFor(async()=>(await api('chrome')).agents.length===1,'Chrome agent was not registered');
  const agentId=(await api('chrome')).agents[0].id;
  const command=async(action,event)=>{
    await api('chrome/command',{profile:agentId,action,...(event?{event}:{})});
    await waitFor(async()=>!(await api('chrome')).agents[0]?.pending,'Chrome did not acknowledge '+action);
  };
  // Contract fixture for DevTools callbacks, with the real extension runtime,
  // native host, authenticated app commands and response-preview round trip.
  // This does not claim visual acceptance of Chrome's own DevTools container.
  await ordinary.addInitScript(()=>{
    if(location.pathname!=='/devtools.html')return;
    chrome.devtools={network:{onRequestFinished:{addListener:callback=>{window.fixtureRequest=callback;}},onNavigated:{addListener:callback=>{window.fixtureNavigate=callback;}}},panels:{create:(_title,_icon,_page,callback)=>callback({onShown:{addListener:callback=>{window.fixtureShow=callback;}},onHidden:{addListener:callback=>{window.fixtureHide=callback;}}})}};
  });
  const tools=await ordinary.newPage();
  await tools.goto(`chrome-extension://${settings.extension_id}/devtools.html`);
  await tools.evaluate(()=>{fixtureShow({mountGuard:controller=>{window.fixtureController=controller;}});fixtureController.allow(true);});
  await waitFor(async()=>(await api('chrome')).agents[0]?.ready,'Prepared DevTools panel was not registered');
  await command('start');
  await waitFor(async()=>(await api('chrome')).agents[0]?.remaining>0,'App did not start prepared-tab diagnostics');
  await tools.evaluate(()=>fixtureRequest({request:{url:'https://notfixture.example.org/private?private-query=must-not-log',method:'GET',headers:[{name:'Cookie',value:'must-not-log'}]},response:{status:200,content:{mimeType:'text/html',size:80}},time:12,getContent:callback=>callback('<h1>Protected fixture response</h1>','')}));
  await waitFor(async()=>(await api('chrome')).events.length===1,'HTTP metadata did not reach app');
  const captured=await api('chrome');assert(!JSON.stringify(captured).includes('must-not-log'));
  assert.equal(captured.preview,null,'Preview appeared without app request');
  await command('preview',captured.events[0].event);
  await waitFor(async()=>(await api('chrome')).preview?.text.includes('Protected fixture response'),'App preview request did not return text');
  assert(!JSON.stringify(await api('activity')).includes('Protected fixture response'),'Response body entered event journal');
  await api('chrome/preview/clear',{});assert.equal((await api('chrome')).preview,null);
  await command('clear');assert.equal((await api('chrome')).events.length,0);
  await tools.evaluate(()=>fixtureRequest({request:{url:'https://notfixture.example.org/',method:'GET'},response:{status:204,content:{mimeType:'text/plain',size:0}},time:1,getContent:callback=>callback('','')}));
  await waitFor(async()=>(await api('chrome')).events.length===1,'Cleared capture did not continue');
  await command('stop');assert.equal((await api('chrome')).events.length,0);
  await tools.evaluate(()=>fixtureHide());
  await waitFor(async()=>(await api('chrome')).agents[0]?.ready===false,'Hidden panel did not revoke app control');
  await tools.close();
  for(const file of ['popup.html','help.html']){
    const ui=await ordinary.newPage();await ui.setViewportSize({width:file==='popup.html'?380:850,height:900});
    await ui.goto(`chrome-extension://${settings.extension_id}/${file}`);
    await ui.waitForFunction(()=>document.querySelector('#state').textContent.includes('подключён') || document.querySelector('#state').textContent.includes('на связи'));
    assert(await ui.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Extension UI overflows viewport');
    if(report)await ui.screenshot({path:path.join(report,file+'.png'),fullPage:true});await ui.close();
  }
  const panel=await ordinary.newPage();await panel.setViewportSize({width:850,height:900});
  await panel.goto(`chrome-extension://${settings.extension_id}/diagnostics.html`);
  await panel.addScriptTag({url:`chrome-extension://${settings.extension_id}/diagnostics.js`});
  await panel.evaluate(()=>{window.controllerFixture=new GuardDiagnostics(()=>{});controllerFixture.visible=true;mountGuard(controllerFixture);});
  await panel.locator('#allow').check();await panel.locator('#start').click();
  await panel.evaluate(()=>controllerFixture.record({request:{url:'https://fixture.example.org/private?hidden=query',method:'GET'},response:{status:200,content:{mimeType:'text/html',size:80}},time:8,getContent:callback=>callback('<script>globalThis.previewExecuted=true</script>','')}));
  await panel.locator('tbody button').click();
  assert((await panel.locator('#preview').textContent()).includes('<script>'));
  assert(await panel.evaluate(()=>globalThis.previewExecuted===undefined),'HTML response executed in diagnostics UI');
  if(report)await panel.screenshot({path:path.join(report,'diagnostics-panel.png'),fullPage:true});
  await panel.locator('#stop').click();assert.equal(await panel.locator('tbody tr').count(),0);await panel.close();
  await ordinaryPage.bringToFront();
  const beforeLastBlock=(await api('status')).chrome_blocked;
  await blockPage();
  await waitFor(async()=>(await api('status')).chrome_blocked>beforeLastBlock,'Baseline block was not delivered before allow accounting');
  const beforeAllowed=(await api('status')).chrome_allowed;
  const beforeAllowedBlocks=(await api('status')).chrome_blocked;
  const applyStarted=performance.now();
  await command('allow_sites');
  await waitFor(async()=>(await api('chrome')).agents[0]?.protection===false,'Ordinary Chrome access did not open');
  const applyMs=Math.round(performance.now()-applyStarted);
  const pageStarted=performance.now();
  await ordinaryPage.reload({waitUntil:'domcontentloaded'});
  const pageMs=Math.round(performance.now()-pageStarted);
  assert.equal(await ordinaryPage.locator('h1').textContent(),'Protected fixture','App access did not allow the same ordinary Chrome tab');
  await waitFor(async()=>(await api('status')).chrome_allowed>beforeAllowed,'Allowed DNR request did not reach native journal');
  assert((await api('activity')).events.some(event=>event.source==='chrome' && event.reason==='chrome_allowed' && event.host==='fixture.example.org'),'Allowed request missing from journal');
  assert.equal((await api('status')).chrome_blocked,beforeAllowedBlocks,'Allow rule was incorrectly reported as blocked');
  assert.equal((await api('status')).allowed,allowedBeforeClear,'Ordinary requests were counted as gateway tunnels');
  const counts=await worker.evaluate(async()=>({allowed,blocked,badge:await chrome.action.getBadgeText({})}));
  assert(counts.allowed>0,'Extension did not count allowed requests');
  assert.equal(counts.badge,String(counts.allowed+counts.blocked),'Badge did not include allowed requests');
  await ordinaryPage.goto(`http://notfixture.example.org:${settings.plain_origin}/`);
  await new Promise(resolve=>setTimeout(resolve,200));
  assert(!(await api('activity')).events.some(event=>event.source==='chrome' && event.host==='notfixture.example.org'),'Unlisted website leaked into sensitive journal');
  await command('reporting_off');
  const beforeMuted=(await api('status')).chrome_allowed;
  const localBeforeMuted=await worker.evaluate(()=>allowed);
  await ordinaryPage.goto(`http://fixture.example.org:${settings.plain_origin}/muted`);
  await waitFor(()=>worker.evaluate(before=>allowed>before,localBeforeMuted),'Local allowed counter did not advance with reporting off');
  assert.equal((await api('status')).chrome_allowed,beforeMuted,'Reporting off still forwarded an allowed match');
  await command('reporting_on');
  const popup=await ordinary.newPage();await popup.goto(`chrome-extension://${settings.extension_id}/popup.html`);
  await waitFor(async()=>Number(await popup.locator('#allowed').textContent())>0,'Popup allowed metric stayed empty');
  assert.equal(Number(await popup.locator('#count').textContent()),Number(await popup.locator('#allowed').textContent())+Number(await popup.locator('#blocked').textContent()));
  await popup.close();
  const switchTimings=[];
  for(let cycle=0;cycle<8;cycle++){
    for(const action of ['block_sites','allow_sites']){
      const started=performance.now();await command(action);
      await waitFor(async()=>(await api('chrome')).agents[0]?.protection===(action==='block_sites'),'Actual Chrome rule state not acknowledged');
      const elapsed=Math.round(performance.now()-started);
      switchTimings.push({action,ms:elapsed});
      assert(elapsed<2000,`${action} exceeded two-second switch budget: ${elapsed}ms`);
    }
  }
  const timings={ordinary_rule_apply_ms:applyMs,allowed_fixture_dom_ms:pageMs,switches:switchTimings};
  if(report)writeFileSync(path.join(report,'latency.json'),JSON.stringify(timings,null,2));
  console.log('Fixture latency (not live website acceptance): '+JSON.stringify(timings));
  assert.equal((await api('status')).state,'locked','Ordinary access opened the optional protected gateway');
  // Advance more than the old 60-second pause: live app replies renew access.
  await worker.evaluate(()=>{globalThis.guardOriginalNow=Date.now;const future=Date.now()+70000;Date.now=()=>future;});
  await new Promise(resolve=>setTimeout(resolve,2500));
  await waitFor(async()=>(await api('chrome')).agents[0]?.protection===false,'App access acted like a one-minute pause');
  await worker.evaluate(()=>{Date.now=globalThis.guardOriginalNow;delete globalThis.guardOriginalNow;});
  await command('block_sites');
  await waitFor(async()=>(await api('chrome')).agents[0]?.protection===true,'Ordinary Chrome access did not close');
  await blockPage();
  await command('pause_protection');
  assert.equal((await api('chrome')).agents[0].protection,false);
  assert((await worker.evaluate(()=>chrome.declarativeNetRequest.getEnabledRulesets())).includes('sensitive'),'Pause disabled the permanent ruleset');
  await ordinaryPage.goto(`http://fixture.example.org:${settings.plain_origin}/paused`);
  assert.equal(await ordinaryPage.locator('h1').textContent(),'Protected fixture','App pause was not applied to Chrome');
  await command('resume_protection');await blockPage();
  await command('reporting_off');
  const beforeReportingOff=(await api('status')).chrome_blocked;
  await blockPage();await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal((await api('status')).chrome_blocked,beforeReportingOff,'Reporting off still forwarded a block');
  await command('reporting_on');await blockPage();
  await waitFor(async()=>(await api('status')).chrome_blocked>beforeReportingOff,'Reporting on did not resume events');
  await command('pause_protection');
  await worker.evaluate(()=>{globalThis.guardOriginalNow=Date.now;const future=Date.now()+61000;Date.now=()=>future;});
  await waitFor(async()=>(await api('chrome')).agents[0].protection,'Pause did not expire');
  await worker.evaluate(()=>{Date.now=globalThis.guardOriginalNow;delete globalThis.guardOriginalNow;});
  await blockPage();
  if(report)writeFileSync(path.join(report,'fixture-proof.json'),JSON.stringify({guard:await api('status'),events:proof.events},null,2));
  await command('allow_sites');
  await waitFor(async()=>(await api('chrome')).agents[0]?.protection===false,'Access was not allowed before disconnect');
  await control('chrome-offline');
  await waitFor(async()=>(await worker.evaluate(()=>chrome.declarativeNetRequest.getSessionRules())).length===0,'Lost native app did not restore Chrome block');
  const beforeOfflineOrigin=(await control('status')).origin;await blockPage();
  assert.equal((await control('status')).origin,beforeOfflineOrigin,'Loss of journal disabled Chrome block');
  await control('gate-down');await mustFail('https://fixture.example.org/gate-down');
  assert.equal((await control('status')).direct,0);
  await browser.close();browser=null;
  const netlog=JSON.parse(readFileSync(path.join(root,'netlog.json')));
  const names=Object.fromEntries(Object.entries(netlog.constants.logEventTypes).map(([name,id])=>[id,name]));
  assert.equal(netlog.events.filter(event=>/DNS_TRANSACTION|DNS_TASK/.test(names[event.type] || '')).length,0,'Protected browser performed DNS');
  console.log('PASS: ordinary allow/block, allowed journal and badge counts, unlisted-site privacy, reporting isolation, independent optional gateway, lease/disconnect restoration and protected-browser no-direct/DNS/WebRTC bypass.');
} finally {
  if(browser)await browser.close();if(ordinary)await ordinary.close();
  if(closeOwned)await closeOwned().catch(()=>{});
  fixture.kill('SIGTERM');rmSync(root,{recursive:true,force:true});
}
