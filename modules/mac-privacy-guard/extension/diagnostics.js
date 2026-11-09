// Shared by the DevTools page and deterministic tests. No disk or network I/O.
class GuardDiagnostics {
  static reader(read) { return callback=>read(callback); }
  constructor(emit, now = () => Date.now()) {
    this.emit = emit; this.now = now; this.visible = false; this.allowed = false;
    this.session = null; this.deadline = 0; this.generation = 0;
    this.requests = new Map(); this.events = []; this.text = ''; this.onChange = () => {};
  }
  state() { return {ready:this.visible && this.allowed,session:this.session,remaining:Math.max(0,Math.ceil((this.deadline-this.now())/1000))}; }
  changed() { this.emit({op:'state',...this.state()}); this.onChange(this); }
  allow(value) {
    this.stop(); this.allowed = value === true && this.visible;
    this.session = this.allowed ? crypto.randomUUID().replaceAll('-','') : null; this.changed();
  }
  hide() { this.visible=false;this.allow(false);this.onChange=()=>{}; }
  start() {
    if (!this.state().ready) return false;
    this.clear();this.deadline=this.now()+60000;this.changed();return true;
  }
  clear() { this.generation++;this.requests.clear();this.events=[];this.text='';this.changed(); }
  stop() { this.deadline=0;this.clear(); }
  tick() { if (this.deadline && this.now()>=this.deadline) this.stop(); }
  navigated() { this.clear();if(this.state().remaining)this.emit({op:'reset',session:this.session}); }
  record(request) {
    this.tick();if(!this.state().ready || !this.state().remaining)return;
    let url;try{url=new URL(request.request.url);}catch(_){return;}
    if(!['http:','https:'].includes(url.protocol))return;
    const event=crypto.randomUUID().replaceAll('-','');
    const mime=(request.response.content?.mimeType || '').split(';')[0].slice(0,100);
    const entry={op:'http',session:this.session,event,host:url.hostname,
      method:['GET','POST','PUT','DELETE','HEAD','OPTIONS','PATCH','CONNECT','TRACE'].includes(request.request.method)?request.request.method:'OTHER',
      status:Math.max(0,Math.min(599,Math.round(request.response.status || 0))),
      mime:/^[A-Za-z0-9.+/-]*$/.test(mime)?mime:'',duration_ms:Math.max(0,Math.min(600000,Math.round(request.time || 0)))};
    // Retain only a bounded body-reader, not the HAR object with its URLs/headers.
    const size=request.response.content?.size;
    const readable=Number.isFinite(size) && size>=0 && size<=262144 && /^(text\/|application\/(json|[^/]+\+json|javascript|xml|[^/]+\+xml)|image\/svg\+xml)/i.test(mime);
    this.requests.set(event,readable?GuardDiagnostics.reader(request.getContent):null);
    while(this.requests.size>100)this.requests.delete(this.requests.keys().next().value);
    this.events.unshift(entry);this.events=this.events.slice(0,100);this.emit(entry);this.onChange(this);
  }
  async preview(event, command=null) {
    this.tick();const reader=this.requests.get(event),generation=this.generation,session=this.session;
    if(!this.state().ready || !this.state().remaining || !reader)throw new Error('Текст недоступен: ответ не текстовый, слишком большой или уже удалён.');
    const text=await new Promise((resolve,reject)=>{
      try{reader((body,encoding)=>{if(encoding || typeof body!=='string' || body.length>262144)reject(new Error('Ответ не подходит для текстового предпросмотра.'));else resolve(body);});}
      catch(_){reject(new Error('Chrome больше не хранит этот ответ.'));}
    });
    if(generation!==this.generation || session!==this.session || !this.state().remaining)throw new Error('Сеанс завершён.');
    this.text=text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'�').slice(0,1024);
    if(command)this.emit({op:'preview',session,event,command,text:this.text});this.onChange(this);return this.text;
  }
  async command(value) {
    if(value.session!==this.session || !this.state().ready)return false;
    if(value.action==='revoke'){this.allow(false);return true;}
    if(value.action==='start')return this.start();
    if(value.action==='stop'){this.stop();return true;}
    if(value.action==='clear'){this.clear();return true;}
    if(value.action==='preview'){await this.preview(value.event,value.id);return true;}
    return false;
  }
}
globalThis.GuardDiagnostics=GuardDiagnostics;
