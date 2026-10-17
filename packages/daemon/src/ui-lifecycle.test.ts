import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { SerialHub, type RecordEntry } from './core.js';
import { SerialConnection } from './connection.js';
import { startWebSocket } from './websocket.js';

const delay = (ms:number) => new Promise(resolve => setTimeout(resolve,ms));
async function fixture() {
  let closed = 0;
  const hub = new SerialHub(10,text => connection.send(text));
  const connection = new SerialConnection({baudRate:115200,dtr:false,rts:false},(source,text) => hub.record(source,text),() => {});
  await connection.open('mock',115200);
  const server = await startWebSocket(hub,'secret',0,{}, {
    list:async () => [], open:(port,baud) => connection.open(port,baud), close:() => connection.close(),
    uiClosed:() => hub.runExclusive(async () => {closed++; await connection.close();},{cleanup:true})
  },60);
  const sockets:WebSocket[] = [];
  const snapshots = new Map<WebSocket,RecordEntry[]>();
  async function connect(ui = true) {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/?token=secret`); sockets.push(socket);
    socket.on('message',raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'snapshot') snapshots.set(socket,message.records);
    });
    await once(socket,'open');
    if (ui) await new Promise<void>((resolve,reject) => {
      const timer = setTimeout(() => reject(new Error('UI registration timeout')),1000);
      socket.on('message',raw => {
        const message = JSON.parse(raw.toString());
        if (message.requestId === 'attach') {clearTimeout(timer); assert.equal(message.ok,true); resolve();}
      });
      socket.send(JSON.stringify({type:'ui_attached',requestId:'attach'}));
    });
    return socket;
  }
  return {hub,connection,server,connect,snapshots,closed:() => closed,dispose:async () => {
    await server.close(); for (const socket of sockets) socket.terminate();
    await hub.stop(); await connection.close();
  }};
}
test('closing the last UI releases the port and clears history; ordinary clients do not keep it occupied', async () => {
  const f = await fixture();
  try {
    const observer = await f.connect(false); observer.close(); await once(observer,'close'); await delay(90);
    assert.equal(f.connection.status().connected,true);
    f.hub.record('hardware','old capture');
    const retainedObserver = await f.connect(false);
    const ui = await f.connect(); ui.close(); await once(ui,'close'); await delay(90);
    assert.equal(f.connection.status().connected,false); assert.equal(f.closed(),1);
    assert.deepEqual(f.hub.buffer.read(),[]);
    const reopenedUi = await f.connect();
    assert.deepEqual(f.snapshots.get(reopenedUi),[]);
    await assert.rejects(f.hub.write('late','claude'),/Port closed/);
    await f.hub.runExclusive(() => f.connection.open('mock',115200));
    await f.hub.write('reopened','claude');
    assert.equal(retainedObserver.readyState,WebSocket.OPEN);
  } finally {await f.dispose();}
});
test('a transient UI reconnect preserves the port; the remaining UI also preserves it', async () => {
  const f = await fixture();
  try {
    f.hub.record('hardware','capture to retain');
    const first = await f.connect(); first.close(); await once(first,'close');
    const second = await f.connect(); await delay(90);
    assert.equal(f.closed(),0); assert.equal(f.connection.status().connected,true);
    assert.ok(f.hub.buffer.read().some(record => record.text === 'capture to retain'));
    const third = await f.connect(); second.close(); await once(second,'close'); await delay(90);
    assert.equal(f.closed(),0);
    assert.ok(f.hub.buffer.read().some(record => record.text === 'capture to retain'));
    third.close(); await once(third,'close'); await delay(90);
    assert.equal(f.closed(),1);
    assert.deepEqual(f.hub.buffer.read(),[]);
  } finally {await f.dispose();}
});
test('UI process exit releases immediately and disconnect fallback does not close a subsequently reopened port', async () => {
  const f = await fixture();
  try {
    const ui = await f.connect();
    f.server.uiExited(); await delay(5);
    assert.equal(f.connection.status().connected,false); assert.equal(f.closed(),1);
    assert.deepEqual(f.hub.buffer.read(),[]);
    await f.hub.runExclusive(() => f.connection.open('mock',115200));
    ui.terminate(); await once(ui,'close'); await delay(90);
    assert.equal(f.closed(),1); assert.equal(f.connection.status().connected,true);
    assert.ok(f.hub.buffer.read().some(record => record.text === 'Simulated serial device ready'));
  } finally {await f.dispose();}
});
test('UI close cleanup waits behind an action even when normal commands are blocked', async () => {
  const f = await fixture();
  try {
    let release!:() => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    const action = f.hub.runExclusive(async () => {f.hub.blocked='Uploading'; await gate; f.hub.record('system','late upload output'); f.hub.blocked='';});
    await delay(0);
    await assert.rejects(f.hub.write('blocked','claude'),/Uploading/);
    f.server.uiExited(); await delay(5); assert.equal(f.closed(),0);
    assert.deepEqual(f.hub.buffer.read(),[]);
    release(); await action; await delay(5);
    assert.equal(f.closed(),1); assert.equal(f.connection.status().connected,false);
    assert.deepEqual(f.hub.buffer.read(),[]);
  } finally {await f.dispose();}
});
