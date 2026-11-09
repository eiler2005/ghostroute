'use strict';
const channel=chrome.runtime.connect({name:'guard-diagnostics'});
const diagnostics=new GuardDiagnostics(message=>channel.postMessage(message));
chrome.devtools.network.onRequestFinished.addListener(request=>diagnostics.record(request));
chrome.devtools.network.onNavigated.addListener(()=>diagnostics.navigated());
channel.onMessage.addListener(async command=>{
  let success=false;try{success=await diagnostics.command(command);}catch(_){}
  channel.postMessage({op:'result',command:command.id,success});
});
channel.onDisconnect.addListener(()=>diagnostics.hide());
chrome.devtools.panels.create('Guard','icon-16.png','diagnostics.html',panel=>{
  panel.onShown.addListener(window=>{diagnostics.visible=true;window.mountGuard(diagnostics);diagnostics.changed();});
  panel.onHidden.addListener(()=>diagnostics.hide());
});
setInterval(()=>{diagnostics.tick();if(diagnostics.visible)diagnostics.changed();},1000);
