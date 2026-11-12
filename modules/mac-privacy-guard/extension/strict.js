'use strict';
// Separate capability: ordinary Chrome proxy ownership, never page scripting.
class GuardStrict {
  constructor(catalog, block, changed){
    this.required=false;this.ready=false;this.state='waiting';this.digest='';this.current=null;
    this.baseline=null;this.expectedPac=null;this.failedPac=null;
    this.block=block;this.changed=changed;this.queue=Promise.resolve();this.updating=false;
    const local=path=>fetch(chrome.runtime.getURL(path)).then(response=>{if(!response.ok)throw new Error('Local policy unavailable');return response.json();});
    this.loaded=Promise.all([catalog,local('ordinary-direct-domains.json'),local('ordinary-routing.json')]).then(async([rules,direct,routing])=>{
      if(!routing || !['network','external_pac'].includes(routing.mode))throw new Error('Invalid ordinary routing');
      this.ordinaryRouting=routing.mode;
      this.domains=[...new Set(rules.flatMap(rule=>rule.condition.requestDomains))].sort();
      this.direct=direct;
      this.digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(this.domains.join('\n'))))].map(n=>n.toString(16).padStart(2,'0')).join('');
    });
    const invalidate=()=>{
      if(!this.required || this.updating)return;
      this.ready=false;
      void this.block().then(()=>this.sync(this.current)).then(()=>this.changed()).catch(()=>{});
    };
    chrome.proxy?.settings.onChange.addListener(invalidate);
    chrome.privacy?.network.webRTCIPHandlingPolicy.onChange.addListener(invalidate);
    chrome.privacy?.network.networkPredictionEnabled.onChange.addListener(invalidate);
    chrome.proxy?.onProxyError.addListener(details=>{
      if(!this.required || !['net::ERR_MANDATORY_PROXY_CONFIGURATION_FAILED','net::ERR_PAC_SCRIPT_FAILED'].includes(details.error))return;
      this.failedPac=this.expectedPac;this.ready=false;this.state='error';void this.block().then(()=>this.changed()).catch(()=>{});
    });
  }
  report(){return this.digest?{proxy:this.state,catalog_digest:this.digest,baseline:this.baseline?'external_pac':'direct'}:null;}
  pac(port){
    return GuardPAC.build(this.domains,port,this.baseline,this.ordinaryRouting==='external_pac'?this.direct:[]);
  }
  sync(value){
    this.queue=this.queue.catch(()=>{}).then(()=>this.apply(value));return this.queue;
  }
  async release(){
    await this.block();this.ready=false;
    // Keep owned PAC and privacy guards on failure/pause. Speculative CONNECTs
    // can precede DNR; the retained PAC must still point at a closed local gate.
    // Chrome clears our layer when the operator disables/removes the extension.
  }
  async lost(){
    this.current=null;this.ready=false;
    if(this.required){this.state='waiting';await this.block();}
  }
  async apply(value){
    if(!value)return;
    this.required=true;this.current=value;
    this.updating=true;
    try{
      await this.loaded;
      if(!chrome.proxy || !chrome.privacy){this.state='permission_required';await this.block();return;}
      if(!value.enabled){this.state='waiting';this.ready=false;await this.block();return;}
      if(!value.system_direct || !Number.isInteger(value.port) || value.port<1024 || value.port>65535 || value.catalog_digest!==this.digest){
        this.state='waiting';await this.release();return;
      }
      const settings=chrome.proxy.settings,webrtc=chrome.privacy.network.webRTCIPHandlingPolicy,prediction=chrome.privacy.network.networkPredictionEnabled;
      const [proxy,rtc,predict]=await Promise.all([settings.get({incognito:false}),webrtc.get({}),prediction.get({})]);
      const controllable=setting=>['controllable_by_this_extension','controlled_by_this_extension'].includes(setting.levelOfControl);
      if(![proxy,rtc,predict].every(controllable)){this.state='conflict';await this.release();return;}
      const ours=proxy.levelOfControl==='controlled_by_this_extension' && proxy.value.mode==='pac_script' && proxy.value.pacScript?.data?.startsWith(GuardPAC.prefix);
      const inline=proxy.value.mode==='pac_script' && typeof proxy.value.pacScript?.data==='string';
      if(this.ordinaryRouting==='network' && (inline || ['direct','system'].includes(proxy.value.mode))){
        // Explicit network policy replaces even a previously composed Guard PAC.
        // Do not decode or execute the obsolete provider snapshot during upgrade.
        this.baseline=null;
      }
      else if(ours)this.baseline=GuardPAC.baseline(proxy.value.pacScript.data,true);
      else if(inline)this.baseline=GuardPAC.baseline(proxy.value.pacScript.data,false);
      else if(!['direct','system'].includes(proxy.value.mode)){this.state='unsupported_proxy';await this.release();return;}
      else this.baseline=null;
      const data=this.pac(value.port);this.expectedPac=data;
      if(this.failedPac===data){this.ready=false;this.state='error';await this.block();return;}
      if(proxy.value.pacScript?.data!==data || rtc.value!=='disable_non_proxied_udp' || predict.value!==false){
        this.ready=false;await this.block();
        await webrtc.set({value:'disable_non_proxied_udp',scope:'regular'});
        await prediction.set({value:false,scope:'regular'});
        await settings.set({value:{mode:'pac_script',pacScript:{data,mandatory:true}},scope:'regular'});
      }
      const [effective,effectiveRTC,effectivePrediction]=await Promise.all([settings.get({incognito:false}),webrtc.get({}),prediction.get({})]);
      this.ready=effective.levelOfControl==='controlled_by_this_extension' && effective.value.mode==='pac_script'
        && effective.value.pacScript?.data===data && effective.value.pacScript?.mandatory===true
        && effectiveRTC.levelOfControl==='controlled_by_this_extension' && effectiveRTC.value==='disable_non_proxied_udp'
        && effectivePrediction.levelOfControl==='controlled_by_this_extension' && effectivePrediction.value===false;
      this.state=this.ready?'owned':'conflict';
      if(!this.ready)await this.release();
    }catch(error){
      // Provider source and raw setting errors never enter logs or IPC.
      this.ready=false;this.state=error?.message==='Unsupported PAC baseline'?'unsupported_proxy':'error';await this.block();
    }
    finally{this.updating=false;}
  }
}
globalThis.GuardStrict=GuardStrict;
