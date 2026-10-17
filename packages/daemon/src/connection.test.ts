import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SerialConnection, type PortDevice } from './connection.js';
import { SerialHub } from './core.js';
import type {SerialFormat} from './serial-format.js';

class Device extends EventEmitter implements PortDevice {
  isOpen = false;
  writes:Buffer[] = [];
  flags?:{dtr:boolean; rts:boolean};
  constructor(readonly path:string, private trace:string[], private failSet = false) { super(); }
  open(cb:(error:Error | null) => void) { this.isOpen = true; this.trace.push(`open:${this.path}`); cb(null); }
  close(cb:(error:Error | null) => void) { this.isOpen = false; this.trace.push(`close:${this.path}`); this.emit('close'); cb(null); }
  set(flags:{dtr:boolean; rts:boolean}, cb:(error:Error | null) => void) { this.flags = flags; cb(this.failSet ? new Error('set failed') : null); }
  write(text:string | Buffer, cb:(error:Error | null) => void) { this.writes.push(Buffer.from(text)); this.trace.push(`write:${this.path}:${text}`); cb(null); }
  drain(cb:(error:Error | null) => void) { setTimeout(() => { this.trace.push(`drain:${this.path}`); cb(null); },10); }
}
test('close/reopen cannot race Claude or manual TX; flags applied on each open', async () => {
  const trace:string[] = []; const devices:Device[] = [];
  const hub = new SerialHub(30,payload => connection.send(payload));
  const connection:SerialConnection = new SerialConnection({baudRate:115200,dtr:false,rts:false},(source,text) => hub.record(source,text),() => {},
    path => { const device = new Device(path,trace); devices.push(device); return device; },async () => [{path:'COM1'}]);
  await hub.runExclusive(() => connection.open('COM1',115200));
  await Promise.all([
    hub.write('A','claude'),
    hub.runExclusive(() => connection.close()),
    hub.runExclusive(() => connection.open('COM2',9600)),
    hub.write('B','user')
  ]);
  assert.deepEqual(trace,['open:COM1','write:COM1:A','drain:COM1','close:COM1','open:COM2','write:COM2:B','drain:COM2']);
  assert.deepEqual(devices.map(d => d.flags),[{dtr:false,rts:false},{dtr:false,rts:false}]);
  await assert.rejects(connection.open('COM3',9600),/Close/);
  await connection.close(); await assert.rejects(connection.send('late'),/Port closed/);
  await hub.stop();
});
test('failed DTR/RTS setup releases descriptor and allows a later open', async () => {
  const trace:string[] = [];
  const connection = new SerialConnection({baudRate:115200,dtr:false,rts:false},() => {},() => {},path => new Device(path,trace,path === 'COM1'));
  await assert.rejects(connection.open('COM1',115200),/set failed/);
  assert.equal(connection.status().connected,false);
  assert.deepEqual(trace,['open:COM1','close:COM1']);
  await connection.open('COM2',115200); await connection.close();
});

test('serial framing reaches the driver, defaults to 8N1 and survives close/reopen and reset', async () => {
  const formats:SerialFormat[]=[];
  const connection = new SerialConnection({baudRate:115200,dtr:false,rts:false},()=>{},()=>{},
    (path,_baud,format)=>{formats.push(format);return new Device(path,[]);});
  await connection.open('COM1',115200);
  assert.deepEqual(formats[0],{dataBits:8,parity:'none',stopBits:1});
  await connection.close();
  await assert.rejects(connection.open('COM1',115200,{dataBits:9 as 8}),/Invalid serial format/);
  assert.equal(formats.length,1);
  const selected:SerialFormat={dataBits:7,parity:'even',stopBits:2};
  await connection.open('COM1',9600,selected);
  await assert.rejects(connection.open('COM1',9600,{dataBits:8}),/Close/);
  await connection.resetEsp32();
  assert.deepEqual(connection.status().serialFormat,selected);
  await connection.close();await connection.open('COM1',9600);
  assert.deepEqual(formats,[{dataBits:8,parity:'none',stopBits:1},selected,selected]);
  const snapshot=connection.status();snapshot.serialFormat.dataBits=5;
  assert.equal(connection.status().serialFormat.dataBits,7);
  await connection.close();
});

test('ESP32 reset holds RTS for 100 ms, releases GPIO0 and serializes TX/close', async () => {
  const trace:string[] = [];
  const changes:{dtr:boolean; rts:boolean; time:number}[] = [];
  class ResetDevice extends Device {
    override set(flags:{dtr:boolean; rts:boolean}, cb:(error:Error | null) => void) {
      changes.push({...flags,time:Date.now()});
      trace.push(`signals:${flags.dtr}:${flags.rts}`);
      super.set(flags,cb);
    }
  }
  const device = new ResetDevice('COM1',trace);
  const hub = new SerialHub(30,payload => connection.send(payload));
  const connection:SerialConnection = new SerialConnection({baudRate:115200,dtr:true,rts:true},
    (source,text) => hub.record(source,text),() => {},() => device);
  await assert.rejects(connection.resetEsp32(),/Port closed/);
  await connection.open('COM1',115200);
  trace.length = 0; changes.length = 0;
  const reset = hub.runExclusive(() => connection.resetEsp32());
  const write = hub.write('after reset','user');
  const close = hub.runExclusive(() => connection.close());
  await Promise.all([reset,write,close]);
  assert.deepEqual(changes.map(({dtr,rts}) => ({dtr,rts})),[{dtr:false,rts:true},{dtr:false,rts:false}]);
  assert.ok(changes[1].time - changes[0].time >= 90,'reset pulse must last approximately 100 ms');
  assert.deepEqual(trace,['signals:false:true','signals:false:false','write:COM1:after reset','drain:COM1','close:COM1']);
  assert.equal(connection.status().busy,false);
  await hub.stop();
});

test('ESP32 reset releases signals on failure and closes if release fails', async () => {
  for (const failedCall of [2,3]) {
    const trace:string[] = [];
    const changes:{dtr:boolean;rts:boolean}[] = [];
    class FailingDevice extends Device {
      override set(flags:{dtr:boolean; rts:boolean}, cb:(error:Error | null) => void) {
        changes.push({...flags});
        if (changes.length === failedCall) cb(new Error('reset signals failed'));
        else super.set(flags,cb);
      }
    }
    const device = new FailingDevice('COM1',trace);
    const connection = new SerialConnection({baudRate:115200,dtr:false,rts:false},() => {},() => {},() => device);
    await connection.open('COM1',115200);
    await assert.rejects(connection.resetEsp32(),/reset signals failed/);
    assert.deepEqual(changes.at(-1),{dtr:false,rts:false});
    assert.equal(connection.status().connected,failedCall === 2);
    assert.equal(connection.status().busy,false);
    await connection.close();
  }
});

test('hardware capture retains binary bytes and flushes an unterminated frame on close', async () => {
  const device = new Device('COM1',[]);
  const hub = new SerialHub(10,async () => {});
  const connection = new SerialConnection({baudRate:9600,dtr:false,rts:false},
    (source,text,bytesHex) => hub.record(source,text,bytesHex),() => {},() => device);
  await connection.open('COM1',9600);
  device.emit('data',Buffer.from([1,3,0,0xff,0x80]));
  await connection.close();
  assert.equal(hub.buffer.read().find(record => record.source === 'hardware')?.bytesHex,'010300ff80');
  await hub.stop();
});

test('HEX writes reach the device unchanged and the TX log retains binary bytes', async () => {
  const device = new Device('COM1',[]);
  const hub = new SerialHub(10,payload => connection.send(payload));
  const connection:SerialConnection = new SerialConnection({baudRate:9600,dtr:false,rts:false},
    (source,text,bytesHex) => hub.record(source,text,bytesHex),() => {},() => device);
  await connection.open('COM1',9600);
  const bytes = Buffer.from([0,1,3,0xff,0x80]);
  await hub.write(bytes,'user');
  assert.deepEqual(device.writes,[bytes]);
  assert.equal(hub.buffer.read().find(record => record.source === 'user')?.bytesHex,'000103ff80');
  await connection.close(); await hub.stop();
});
