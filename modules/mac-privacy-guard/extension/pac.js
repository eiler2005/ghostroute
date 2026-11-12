'use strict';
// The provider baseline remains opaque, local Chrome configuration. Never send
// it through Native Messaging or write it into a repository/report.
const GuardPAC=(()=>{
  const prefix='// GhostRoute sensitive route\n';
  const limit=1048576;
  function encode(value){return btoa(Array.from(new TextEncoder().encode(value),byte=>String.fromCharCode(byte)).join(''));}
  function decode(value){return new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(value),c=>c.charCodeAt(0)));}
  function baseline(data,ours){
    if(typeof data!=='string')return null;
    let value=data;
    if(ours){
      const line=data.split('\n')[1];
      if(!line?.startsWith('// GhostRoute baseline '))return null;
      value=decode(line.slice('// GhostRoute baseline '.length));
    }
    if(!value || value.length>limit)throw new Error('Unsupported PAC baseline');
    return value;
  }
  function build(domains,port,source=null,direct=[]){
    if(!Number.isInteger(port) || port<1024 || port>65535 || !Array.isArray(domains) || !domains.length || domains.some(d=>!/^([a-z0-9-]+\.)*[a-z0-9-]+$/.test(d)))throw new Error('Invalid strict PAC');
    if(source!==null && (typeof source!=='string' || source.length>limit || !source.length))throw new Error('Invalid baseline');
    if(!Array.isArray(direct) || direct.length>32 || direct.some(d=>typeof d!=='string' || d.length>253 || !/^([a-z0-9-]+\.)+[a-z0-9-]+$/.test(d) || domains.some(s=>d===s || d.endsWith('.'+s) || s.endsWith('.'+d))))throw new Error('Invalid ordinary exceptions');
    // Bind the catalog gate before delegating. Capture/freeze primitives before
    // provider code runs, then install an immutable global entry point. A PAC
    // error is mandatory-fail-closed; never catch it and return DIRECT.
    return prefix+(source?'// GhostRoute baseline '+encode(source)+'\n':'')+`(function(){
const __grRoot=this;
const __grDefine=Object.defineProperty;
const __grLower=Function.prototype.call.bind(String.prototype.toLowerCase);
const __grSlice=Function.prototype.call.bind(String.prototype.slice);
const __grCall=Function.prototype.call.bind(Function.prototype.call);
const __grDomains=Object.freeze(${JSON.stringify(domains)});
const __grDirect=Object.freeze(${JSON.stringify(direct)});
const __grProxy=${JSON.stringify('PROXY 127.0.0.1:'+port)};
const __grFallback=${source?'(function(){\n'+source+'\n;return FindProxyForURL;})()':'null'};
__grDefine(__grRoot,'FindProxyForURL',{configurable:false,writable:false,value:function(url,host){
 host=__grLower(host);if(__grSlice(host,-1)==='.')host=__grSlice(host,0,-1);
 for(var i=0;i<__grDomains.length;i++){var d=__grDomains[i];if(host===d || __grSlice(host,-(d.length+1))==='.'+d)return __grProxy;}
 for(var j=0;j<__grDirect.length;j++){var normal=__grDirect[j];if(host===normal || __grSlice(host,-(normal.length+1))==='.'+normal)return 'DIRECT';}
 return __grFallback?__grCall(__grFallback,__grRoot,url,host):'DIRECT';
}});
})();`;
  }
  return {prefix,baseline,build};
})();
globalThis.GuardPAC=GuardPAC;
