import { randomBytes,randomUUID,timingSafeEqual } from 'node:crypto';
export class ClaudeModDelivery {
  private routes=new Map<string,{key:string;seen:number;pending?:{id:string;text:string;scope:string;claimed:boolean;timer:ReturnType<typeof setTimeout>;resolve:(value:object)=>void;reject:(error:Error)=>void}}>();
  private sweep:ReturnType<typeof setInterval>;
  constructor(private detached:(sessionId:string)=>void,private receiptMs=30000,private leaseMs=30000,private agentType:'claude_code'|'antigravity'='claude_code') {
    this.sweep=setInterval(()=>{
      for(const [id,route] of this.routes) if(Date.now()-route.seen>this.leaseMs) this.remove(id);
    },Math.min(5000,leaseMs));this.sweep.unref();
  }
  register(sessionId:string) {
    if(this.routes.has(sessionId)) this.remove(sessionId);
    if(this.routes.size>=32) throw new Error('Hay demasiadas sesiones de G Monitor conectadas.');
    const key=randomBytes(32).toString('hex');this.routes.set(sessionId,{key,seen:Date.now()});return {sessionId,key};
  }
  private route(sessionId:string,key:string) {
    const route=this.routes.get(sessionId);const a=Buffer.from(key);const b=Buffer.from(route?.key ?? '');
    if(!route || a.length!==b.length || !timingSafeEqual(a,b)) throw new Error('El plugin no está vinculado a esta sesión.');
    if(Date.now()-route.seen>this.leaseMs) {this.remove(sessionId);throw new Error('La conexión del plugin venció. Volvé a vincular el monitor.');}
    route.seen=Date.now();return route;
  }
  connected(sessionId:string) {const route=this.routes.get(sessionId);return !!route && Date.now()-route.seen<=this.leaseMs;}
  touch(sessionId:string,key:string) {this.route(sessionId,key);}
  poll(sessionId:string,key:string) {
    const route=this.route(sessionId,key);const message=route.pending;
    if(!message || message.claimed) return {message:null};
    message.claimed=true;return {message:{id:message.id,text:message.text,scope:message.scope}};
  }
  acknowledge(sessionId:string,key:string,messageId:string,error?:string) {
    const route=this.route(sessionId,key);const pending=route.pending;
    if(!pending || pending.id!==messageId || !pending.claimed) throw new Error('Ese mensaje no está pendiente de confirmación en este chat.');
    clearTimeout(pending.timer);route.pending=undefined;
    if(error) pending.reject(new Error(`${this.label} rechazó el envío: ${error}`));
    else pending.resolve({agentType:this.agentType,sessionId,messageId,confirmed:true});
    return {ok:true};
  }
  send(sessionId:string,text:string,scope:'selection'|'all') {
    const route=this.routes.get(sessionId);
    if(!route || !this.connected(sessionId)) return Promise.reject(new Error(`El puente de ${this.label} no está conectado. Volvé a abrir el monitor desde el chat.`));
    if(route.pending) return Promise.reject(new Error('Ya hay un envío pendiente para este chat.'));
    return new Promise<object>((resolve,reject)=>{
      const id=randomUUID();const timer=setTimeout(()=>{
        if(route.pending?.id===id) route.pending=undefined;
        reject(new Error(`${this.label} no confirmó la entrega. Puede estar ocupado: comprobá el chat antes de reenviar.`));
      },this.receiptMs);
      route.pending={id,text,scope,claimed:false,timer,resolve,reject};
    });
  }
  disconnect(sessionId:string,key:string) {this.route(sessionId,key);this.remove(sessionId);return {ok:true};}
  private remove(sessionId:string) {
    const route=this.routes.get(sessionId);if(!route) return;
    if(route.pending) {clearTimeout(route.pending.timer);route.pending.reject(new Error(`El puente de ${this.label} se desconectó antes de confirmar la entrega.`));}
    this.routes.delete(sessionId);this.detached(sessionId);
  }
  close() {clearInterval(this.sweep);for(const id of this.routes.keys())this.remove(id);}
  private get label() {return this.agentType === 'antigravity' ? 'Antigravity' : 'Claude';}
}
