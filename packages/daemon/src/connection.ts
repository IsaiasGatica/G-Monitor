import { SerialPort } from 'serialport';
import { SerialDataDecoder, type Source } from './core.js';
import { defaultSerialFormat, parseSerialFormat, serialFormatLabel, type SerialFormat } from './serial-format.js';

export interface PortDevice {
  readonly isOpen: boolean;
  on(event:string, listener:(...args:any[]) => void): unknown;
  open(callback:(error:Error | null) => void): unknown;
  close(callback:(error:Error | null) => void): unknown;
  set(options:{dtr:boolean; rts:boolean}, callback:(error:Error | null) => void): unknown;
  write(payload:string | Buffer, callback:(error:Error | null | undefined) => void): unknown;
  drain(callback:(error:Error | null | undefined) => void): unknown;
}
export type PortInfo = {path:string; manufacturer?:string; serialNumber?:string};
export class SerialConnection {
  private device?:PortDevice;
  private timer?:NodeJS.Timeout;
  private generation = 0;
  private path = '';
  private baudRate:number;
  private busy = false;
  private serialFormat:SerialFormat = {...defaultSerialFormat};
  constructor(private options:{baudRate:number; dtr:boolean; rts:boolean},
    private record:(source:Source, text:string, bytesHex?:string) => unknown,
    private changed:() => void,
    private factory:(path:string, baudRate:number, format:SerialFormat) => PortDevice = (path, baudRate, format) => new SerialPort({path, baudRate, ...format, autoOpen:false, rtscts:false, lock:true}),
    private enumerate:() => Promise<PortInfo[]> = () => SerialPort.list()) { this.baudRate = options.baudRate; }
  status() { return {port:this.path, baudRate:this.baudRate, serialFormat:{...this.serialFormat}, connected:!!this.timer || !!this.device?.isOpen, mock:this.path === 'mock', busy:this.busy}; }
  async list() { return [{path:'mock', manufacturer:'Dispositivo simulado'}, ...await this.enumerate()]; }
  private callback(fn:(cb:(error?:Error | null) => void) => unknown) {
    return new Promise<void>((resolve, reject) => fn(error => error ? reject(error) : resolve()));
  }
  // The daemon executes open/close and writes in the same SerialHub queue.
  async open(path:string, baudRate:number, format:Partial<SerialFormat> = {}) {
    if (this.status().connected) throw new Error('Close the current port before opening another');
    if (!path || path.length > 256 || !Number.isInteger(baudRate) || baudRate < 50 || baudRate > 4000000) throw new Error('Invalid port or baud rate');
    const selectedFormat = parseSerialFormat(format,this.serialFormat);
    this.busy = true; this.path = path; this.baudRate = baudRate; this.serialFormat=selectedFormat; this.changed();
    const generation = ++this.generation;
    try {
      if (path === 'mock') {
        this.timer = setInterval(() => this.record('hardware', `HEARTBEAT ${Date.now()}`), 1000);
        this.record('system','Simulated serial device ready');
      } else {
        const device = this.factory(path, baudRate, {...selectedFormat}); this.device = device;
        const lines = new SerialDataDecoder((text,bytesHex) => this.record('hardware',text,bytesHex));
        let flushed = false;
        const flush = () => { if (!flushed) { flushed = true; lines.flush(true); } };
        device.on('data', (data:Buffer) => { if (!flushed && generation === this.generation) lines.feed(data); });
        device.on('error', (error:Error) => { if (generation === this.generation) { this.record('system',error.message); this.changed(); } });
        device.on('close', () => { flush(); if (generation === this.generation) { this.record('system','Serial port closed'); this.changed(); } });
        await this.callback(cb => device.open(cb));
        await this.callback(cb => device.set({dtr:this.options.dtr, rts:this.options.rts},cb));
        this.record('system',`Opened ${path} at ${baudRate} ${serialFormatLabel(selectedFormat)}; DTR=${this.options.dtr}, RTS=${this.options.rts}`);
      }
    } catch (error) {
      if (this.device?.isOpen) await this.callback(cb => this.device!.close(cb));
      this.device = undefined;
      this.record('system',`Open failed: ${String(error)}`);
      throw error;
    } finally { this.busy = false; this.changed(); }
  }
  async close() {
    this.busy = true; this.changed();
    try {
      clearInterval(this.timer); this.timer = undefined;
      if (this.device?.isOpen) await this.callback(cb => this.device!.close(cb));
      this.device = undefined; this.generation++;
      this.record('system','Port closed');
    } finally { this.busy = false; this.changed(); }
  }
  async resetEsp32() {
    if (!this.status().connected) throw new Error('Port closed. Select a COM port and click Open.');
    this.busy = true; this.changed();
    try {
      if (this.timer) {
        this.record('system','Simulated ESP32 reset (no hardware signals changed)');
        return;
      }
      const device = this.device!;
      this.record('system','ESP32 reset: DTR=false, RTS pulse 100 ms');
      try {
        // USB-UART auto-reset circuit: release GPIO0 and pull EN low.
        await this.callback(cb => device.set({dtr:false,rts:true},cb));
        await new Promise(resolve => setTimeout(resolve,100));
      } finally {
        try {
          await this.callback(cb => device.set({dtr:false,rts:false},cb));
        } catch (error) {
          // If releasing EN fails, release the descriptor as well.
          try { if (device.isOpen) await this.callback(cb => device.close(cb)); }
          finally { if (!device.isOpen) this.device = undefined; }
          throw error;
        }
      }
      this.record('system','ESP32 reset pulse sent; DTR=false, RTS=false');
    } finally { this.busy = false; this.changed(); }
  }
  async send(payload:string | Buffer) {
    if (this.timer) {
      const generation = this.generation;
      setImmediate(() => {
        if (!this.timer || generation !== this.generation) return;
        if (Buffer.isBuffer(payload)) this.record('hardware',payload.toString('utf8'),payload.toString('hex'));
        else this.record('hardware',`ACK ${payload.trimEnd()}`);
      });
      return;
    }
    const device = this.device;
    if (!device?.isOpen) throw new Error('Port closed. Select a COM port and click Open.');
    await this.callback(cb => device.write(payload,cb));
    await this.callback(cb => device.drain(cb));
  }
}
