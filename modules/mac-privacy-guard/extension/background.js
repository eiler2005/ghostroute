'use strict';
importScripts('counts.js','pac.js','strict.js');
const profile=crypto.randomUUID().replaceAll('-','');
let port=null,inFlight=0,connected=false,blocked=0,allowed=0,missed=0,reporting=true,protection=true,pausedUntil=0,owner=null;
let accessWanted=false,appAllowed=false,leaseUntil=0;
let diagnostic={ready:false,session:null,remaining:0};
const seen=new Set();
const PAUSE_RULE=900001;
const catalog=fetch(chrome.runtime.getURL('rules.json')).then(response=>response.json());
const strictController=new GuardStrict(catalog,()=>restoreProtection(),()=>agent());
let nativeQueue=Promise.resolve();
let policyQueue=Promise.resolve();
function policy(action){const result=policyQueue.catch(()=>{}).then(action);policyQueue=result;return result;}
const id=value=>typeof value==='string' && /^[a-f0-9]{32}$/.test(value);
async function restoreProtection(){
  return policy(async()=>{
    pausedUntil=0;appAllowed=false;leaseUntil=0;
    await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[PAUSE_RULE]});
    await chrome.declarativeNetRequest.updateEnabledRulesets({enableRulesetIds:['sensitive']});
    protection=(await chrome.declarativeNetRequest.getEnabledRulesets()).includes('sensitive');
  });
}
async function allowAppAccess(){
  return policy(async()=>{
    if(!connected || !accessWanted || Date.now()>=leaseUntil)return false;
    if(strictController.required && (!strictController.ready || !strictController.current?.ready))return false;
    const changed=!appAllowed || protection;
    if(changed){
      const rules=await catalog;
      await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[PAUSE_RULE],addRules:[{
        id:PAUSE_RULE,priority:2,action:{type:'allow'},condition:{requestDomains:rules.flatMap(rule=>rule.condition.requestDomains),resourceTypes:rules[0].condition.resourceTypes}
      }]});
    }
    appAllowed=true;pausedUntil=0;protection=false;return true;
  });
}
function accessLease(value){
  accessWanted=value==='allow';
  if(accessWanted){leaseUntil=Date.now()+15000;if(!appAllowed || protection)void allowAppAccess().catch(()=>{});}
  else if(appAllowed)void restoreProtection().catch(()=>{});
}
function connect(){
  if(port)return port;
  port=chrome.runtime.connectNative('org.ghostroute.guard.events');
  port.onMessage.addListener(reply=>{
    inFlight=Math.max(0,inFlight-1);connected=reply.ok===true;
    nativeQueue=nativeQueue.catch(()=>{}).then(async()=>{
      if(reply.ok!==true){missed++;accessWanted=false;await restoreProtection();await strictController.lost();return;}
      if(reply.strict)await strictController.sync(reply.strict);
      else if(strictController.required){accessWanted=false;await restoreProtection();await strictController.lost();return;}
      accessLease(reply.access);
      if(reply.command)await command(reply.command);
    });
  });
  port.onDisconnect.addListener(()=>{void chrome.runtime.lastError;port=null;inFlight=0;connected=false;accessWanted=false;void restoreProtection().then(()=>strictController.lost()).catch(()=>{});});
  return port;
}
function send(message){
  if(inFlight>=32){missed++;return;}
  try{connect().postMessage({...message,profile});inFlight++;}catch(_){connected=false;missed++;accessWanted=false;if(pausedUntil || appAllowed)void restoreProtection().catch(()=>{});}
}
function agent(){const strict=strictController.report();send({op:'agent',...diagnostic,reporting,protection,pause_remaining:Math.max(0,Math.ceil((pausedUntil-Date.now())/1000)),...(strict?{strict}:{})});}
async function heartbeat(){
  if(pausedUntil && Date.now()>=pausedUntil)await restoreProtection();
  if(appAllowed && Date.now()>=leaseUntil)await restoreProtection();
  const enabled=await chrome.declarativeNetRequest.getEnabledRulesets();
  const sessionRules=await chrome.declarativeNetRequest.getSessionRules();
  protection=enabled.includes('sensitive') && !sessionRules.some(rule=>rule.id===PAUSE_RULE);
  if(!pausedUntil && !appAllowed && !protection)await restoreProtection();
  send({op:'heartbeat',version:chrome.runtime.getManifest().version,rules_enabled:protection});agent();
}
async function command(value){
  if(!value || !id(value.id) || seen.has(value.id) || !['start','stop','clear','preview','reporting_on','reporting_off','pause_protection','resume_protection','allow_sites','block_sites'].includes(value.action))return;
  if(value.event!==null && !id(value.event))return;
  seen.add(value.id);while(seen.size>32)seen.delete(seen.values().next().value);
  let success=false;
  try{
    if(value.action==='reporting_on' || value.action==='reporting_off'){reporting=value.action==='reporting_on';success=true;}
    else if(value.action==='allow_sites'){success=await allowAppAccess();}
    else if(value.action==='block_sites'){accessWanted=false;await restoreProtection();success=protection;}
    else if(value.action==='pause_protection'){
      if(strictController.required)throw new Error('Strict mode has no direct pause');
      // Explicit app confirmation grants a short lease, never a permanent bypass.
      success=await policy(async()=>{
        if(!connected)return false;
        const rules=await catalog;
        await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[PAUSE_RULE],addRules:[{
          id:PAUSE_RULE,priority:2,action:{type:'allow'},condition:{requestDomains:rules.flatMap(rule=>rule.condition.requestDomains),resourceTypes:rules[0].condition.resourceTypes}
        }]});
        appAllowed=false;pausedUntil=Date.now()+60000;protection=false;return true;
      });
    }else if(value.action==='resume_protection'){await restoreProtection();success=protection;}
    else if(owner && diagnostic.ready && value.session===diagnostic.session){owner.postMessage(value);return;}
  }catch(_){success=false;}
  agent();send({op:'result',command:value.id,success});
}
chrome.runtime.onConnect.addListener(candidate=>{
  if(candidate.name!=='guard-diagnostics' || candidate.sender?.id!==chrome.runtime.id || candidate.sender?.url!==chrome.runtime.getURL('devtools.html'))return;
  candidate.onMessage.addListener(message=>{
    if(message.op==='state'){
      const ready=message.ready===true && id(message.session);
      if(owner && owner!==candidate && !ready)return;
      if(ready && owner && owner!==candidate)owner.postMessage({id:crypto.randomUUID().replaceAll('-',''),action:'revoke',session:diagnostic.session,event:null});
      owner=ready?candidate:null;
      diagnostic={ready,session:ready?message.session:null,remaining:ready?Math.max(0,Math.min(60,message.remaining|0)):0};agent();
    }else if(candidate===owner && ['http','preview','result','reset'].includes(message.op)){send(message);}
  });
  candidate.onDisconnect.addListener(()=>{if(candidate===owner){owner=null;diagnostic={ready:false,session:null,remaining:0};agent();}});
});
chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(info=>{
  const permitted=info.rule.rulesetId==='_session' && info.rule.ruleId===PAUSE_RULE;
  if(!permitted && info.rule.rulesetId!=='sensitive')return;
  let host;try{host=new URL(info.request.url).hostname;}catch(_){return;}
  if(permitted)allowed++;else blocked++;
  chrome.action.setBadgeText({text:GuardCounts.badge(blocked+allowed)});
  chrome.action.setBadgeBackgroundColor({color:'#287964'});
  chrome.action.setTitle({title:`Guard · запросов каталога: ${GuardCounts.exact(blocked+allowed)} · разрешено: ${GuardCounts.exact(allowed)} · заблокировано: ${GuardCounts.exact(blocked)}`});
  const method=['GET','POST','PUT','DELETE','HEAD','OPTIONS','PATCH','CONNECT','TRACE'].includes(info.request.method)?info.request.method:'OTHER';
  if(reporting)send({op:permitted?'allowed':'blocked',host,method,resource_type:info.request.type,rule_id:info.rule.ruleId});
});
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(sender.id!==chrome.runtime.id)return;
  if(message?.op==='set_access'){
    if(sender.url!==chrome.runtime.getURL('popup.html') || typeof message.allowed!=='boolean' || !connected){reply({ok:false});return;}
    send({op:'access',allowed:message.allowed});reply({ok:true});return;
  }
  if(message?.op!=='status')return;
  heartbeat().then(()=>reply({connected,blocked,allowed,missed,reporting,protection,appAllowed,strict:strictController.required?strictController.current:null,pauseRemaining:Math.max(0,Math.ceil((pausedUntil-Date.now())/1000)),...diagnostic})).catch(()=>reply({connected:false,blocked,allowed,missed,protection:false,reporting}));return true;
});
chrome.runtime.onStartup.addListener(()=>restoreProtection().then(heartbeat).catch(()=>{}));
chrome.runtime.onInstalled.addListener(()=>restoreProtection().then(heartbeat).catch(()=>{}));
void restoreProtection().then(heartbeat).catch(()=>{});
setInterval(()=>void heartbeat().catch(()=>{}),500);
