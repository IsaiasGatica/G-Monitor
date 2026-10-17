// Keep a COM reserved while an upload temporarily closes its serial handle.
// Mock devices are independent and may be used by several windows at once.
export class PortReservations {
  private owners=new Map<string,string>();
  private key(port:string) {return process.platform==='win32' ? port.replace(/^\\\\\.\\/,'').toUpperCase() : port;}
  claim(port:string,monitorId:string) {
    if(port==='mock') return;
    const key=this.key(port),owner=this.owners.get(key);
    if(owner && owner!==monitorId) throw new Error(`El puerto ${port} está ocupado por otro monitor`);
    this.owners.set(key,monitorId);
  }
  release(monitorId:string) {for(const [port,owner] of this.owners) if(owner===monitorId)this.owners.delete(port);}
}
