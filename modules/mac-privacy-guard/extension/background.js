'use strict';
const profile = crypto.randomUUID().replaceAll('-', '');
let port = null, inFlight = 0, connected = false, blocked = 0, missed = 0;
function connect() {
  if (port) return port;
  port = chrome.runtime.connectNative('org.ghostroute.guard.events');
  port.onMessage.addListener(reply => {inFlight = Math.max(0, inFlight - 1); connected = reply.ok === true; if (!connected) missed++;});
  port.onDisconnect.addListener(() => {void chrome.runtime.lastError; port = null; inFlight = 0; connected = false;});
  return port;
}
function send(message) {
  if (inFlight >= 32) {missed++; return;}
  try {connect().postMessage({...message, profile}); inFlight++;}
  catch (_) {connected = false; missed++;}
}
async function heartbeat() {
  const enabled = await chrome.declarativeNetRequest.getEnabledRulesets();
  send({op:'heartbeat', version:chrome.runtime.getManifest().version, rules_enabled:enabled.includes('sensitive')});
}
chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(info => {
  if (info.rule.rulesetId !== 'sensitive') return;
  let host;
  try {host = new URL(info.request.url).hostname;} catch (_) {return;}
  const method = ['GET','POST','PUT','DELETE','HEAD','OPTIONS','PATCH','CONNECT','TRACE'].includes(info.request.method) ? info.request.method : 'OTHER';
  blocked++;
  chrome.action.setBadgeText({text:String(blocked)});
  chrome.action.setBadgeBackgroundColor({color:'#395749'});
  // Full URL, tab identity, initiator, headers and body never leave this callback.
  send({op:'blocked', host, method, resource_type:info.request.type, rule_id:info.rule.ruleId});
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message?.op !== 'status') return;
  heartbeat().then(() => reply({connected, blocked, missed})).catch(() => reply({connected:false, blocked, missed}));
  return true;
});
chrome.runtime.onStartup.addListener(heartbeat);
chrome.runtime.onInstalled.addListener(heartbeat);
heartbeat();
setInterval(heartbeat, 20000);
