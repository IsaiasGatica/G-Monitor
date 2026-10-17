import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SerialHub } from './core.js';
import { startWebSocket } from './websocket.js';


const entrypoint = fileURLToPath(new URL('./index.ts', import.meta.url));
function payload(result:any) { return JSON.parse(result.content[0].text); }
function sessionPath(stream:NodeJS.ReadableStream) {
  return new Promise<string>((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('Session startup timeout')), 15000);
    stream.on('data', chunk => {
      text += chunk.toString(); const match = text.match(/Session file: (.+)\r?\n/);
      if (match) { clearTimeout(timer); resolve(match[1].trim()); }
    });
  });
}
test('MCP stdio and authenticated WebSocket share a single stream concurrently', {timeout:20000}, async () => {
  const transport = new StdioClientTransport({command:process.execPath, args:['--import','tsx',entrypoint], env:{...process.env as Record<string,string>, SERIAL_MOCK:'true', SERIAL_WS_PORT:'0', SERIAL_UI_EXECUTABLE:''}, stderr:'pipe'});
  const pathPromise = sessionPath(transport.stderr!);
  const client = new Client({name:'integration-test',version:'1.0.0'});
  let socket:WebSocket | undefined;
  try {
    await client.connect(transport);
    const missingUI = await client.callTool({name:'serial_open_ui',arguments:{}});
    assert.equal(missingUI.isError,true);
    const path = await pathPromise;
    const session = JSON.parse(await readFile(path,'utf8'));
    socket = new WebSocket(`${session.wsUrl}/?token=${session.token}`);
    const messages:any[] = [];
    socket.on('message', raw => messages.push(JSON.parse(raw.toString())));
    await once(socket,'open');
    async function control(type:string, extra:object = {}) {
      const requestId = `control-${Math.random()}`;
      return await new Promise<any>((resolve,reject) => {
        const timer = setTimeout(() => { socket!.off('message',listener); reject(new Error('Control timeout')); },4000);
        const listener = (raw:Buffer) => {
          const message = JSON.parse(raw.toString());
          if (message.requestId === requestId) { clearTimeout(timer); socket!.off('message',listener); resolve(message); }
        };
        socket!.on('message',listener); socket!.send(JSON.stringify({type,requestId,...extra}));
      });
    }
    const listed = await control('list_ports');
    assert.equal((await control('send_to_agent',{text:'selected log',scope:'selection',bindingId:'00000000-0000-4000-8000-000000000000'})).ok,false);
    const bound = payload(await client.callTool({name:'serial_open_ui',arguments:{agent:{type:'codex',thread_id:'00000000-0000-4000-8000-000000000001',app_tools_pipe:'\\\\.\\pipe\\codex-unavailable-test'}}}));
    assert.equal(bound.agent.threadId,'00000000-0000-4000-8000-000000000001');
    const rebound = payload(await client.callTool({name:'serial_open_ui',arguments:{agent:{type:'codex',thread_id:'00000000-0000-4000-8000-000000000002',app_tools_pipe:'\\\\.\\pipe\\codex-unavailable-test'}}}));
    assert.notEqual(bound.agent.bindingId,rebound.agent.bindingId);
    const stale = await control('send_to_agent',{text:'x'.repeat(16000),scope:'all',bindingId:bound.agent.bindingId});
    assert.equal(stale.ok,false); assert.match(stale.error,/Cambió el chat/);
    const unavailable = await control('send_to_agent',{text:'exact selection',scope:'selection',bindingId:rebound.agent.bindingId});
    assert.equal(unavailable.ok,false); assert.match(unavailable.error,/no está disponible/);
    const unbound = payload(await client.callTool({name:'serial_open_ui',arguments:{}}));
    assert.equal(unbound.agent,null);
    assert.ok(listed.ports.some((p:any) => p.path === 'mock'));
    assert.equal((await control('close')).ok,true);
    assert.equal((await control('reset_esp32')).ok,false);
    assert.equal((await client.callTool({name:'serial_reset_esp32',arguments:{}})).isError,true);
    const closedWrite = await client.callTool({name:'serial_write',arguments:{payload:'closed'}});
    assert.equal(closedWrite.isError,true);
    const mcpListed = payload(await client.callTool({name:'serial_list_ports',arguments:{}}));
    assert.ok(mcpListed.ports.some((p:any) => p.path === 'mock'));
    assert.equal(mcpListed.status.connected,false);
    assert.equal((await client.callTool({name:'serial_open_port',arguments:{port:'mock',data_bits:9}})).isError,true);
    const framed=payload(await client.callTool({name:'serial_open_port',arguments:{port:'mock',baud_rate:57600,data_bits:7,parity:'even',stop_bits:2}}));
    assert.equal(framed.status.connected,true);
    assert.deepEqual(framed.status.serialFormat,{dataBits:7,parity:'even',stopBits:2});
    const reset = payload(await client.callTool({name:'serial_reset_esp32',arguments:{}}));
    assert.equal(reset.ok,true);
    assert.equal(reset.status.port,'mock');
    assert.equal(reset.status.baudRate,57600);
    assert.equal(reset.status.connected,true);
    assert.equal((await control('reset_esp32')).ok,true);
    assert.ok(payload(await client.callTool({name:'serial_read',arguments:{lines:50}})).records.some((r:any) => /Simulated ESP32 reset/.test(r.text)));
    assert.equal((await client.callTool({name:'serial_open_port',arguments:{port:'mock'}})).isError,true);
    assert.ok(messages.some(m => m.type === 'status' && m.status.connected && m.status.baudRate === 57600));
    assert.equal(payload(await client.callTool({name:'serial_close_port',arguments:{}})).status.connected,false);
    assert.equal((await control('open',{port:'mock',baudRate:9600,parity:'invalid'})).ok,false);
    assert.equal((await control('open',{port:'mock',baudRate:9600,dataBits:8,parity:'none',stopBits:1})).ok,true);
    assert.deepEqual(payload(await client.callTool({name:'serial_list_ports',arguments:{}})).status.serialFormat,{dataBits:8,parity:'none',stopBits:1});
    assert.equal(payload(await client.callTool({name:'serial_read',arguments:{lines:1}})).status.baudRate,9600);
    const waiting = client.callTool({name:'serial_wait_for', arguments:{pattern:'HEARTBEAT',timeout_ms:4000}});
    socket.send(JSON.stringify({type:'write',requestId:'manual',payload:'USER',appendNewline:true}));
    const written = await client.callTool({name:'serial_write',arguments:{payload:'CLAUDE\n'}});
    assert.equal(payload(written).ok,true);
    assert.equal(payload(await waiting).matched,true);
    const read = payload(await client.callTool({name:'serial_read',arguments:{lines:50}}));
    assert.ok(read.records.some((r:any) => r.source === 'user' && r.text === 'USER\n'));
    assert.ok(read.records.some((r:any) => r.source === 'claude' && r.text === 'CLAUDE\n'));
    assert.ok(read.records.some((r:any) => r.source === 'hardware' && r.text === 'ACK USER'));
    assert.ok(messages.some(m => m.type === 'snapshot'));
    assert.ok(messages.some(m => m.requestId === 'manual' && m.ok));
  } finally { socket?.terminate(); await client.close(); }
});
test('WebSocket rejects wrong token and untrusted browser origin', async () => {
  const hub = new SerialHub(10,async () => {});
  const ws = await startWebSocket(hub,'secret',0,{});
  try {
    for (const [token, origin] of [['bad','http://localhost:1420'],['secret','https://evil.example']]) {
      const socket = new WebSocket(`ws://127.0.0.1:${ws.port}/?token=${token}`,{origin});
      const [code] = await once(socket,'close'); assert.equal(code,1008);
    }
    assert.equal(hub.buffer.read().length,0);
  } finally { await ws.close(); }
});

test('WebSocket HEX TX sends exact bytes, validates input and keeps legacy ASCII writes', async () => {
  const sent:(string | Buffer)[] = [];
  const hub = new SerialHub(10,async payload => {sent.push(payload);});
  const ws = await startWebSocket(hub,'secret',0,{});
  const socket = new WebSocket(`ws://127.0.0.1:${ws.port}/?token=secret`);
  const results = new Map<string,any>();
  socket.on('message',raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'result') results.set(message.requestId,message);
  });
  try {
    await once(socket,'open');
    const write = async (requestId:string,extra:object) => {
      socket.send(JSON.stringify({type:'write',requestId,...extra}));
      const deadline = Date.now() + 3000;
      while (!results.has(requestId) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve,5));
      assert.ok(results.has(requestId),'write acknowledged');
      return results.get(requestId);
    };
    assert.equal((await write('hex',{payload:'01 03 00 FF 80',encoding:'hex'})).ok,true);
    assert.deepEqual(sent[0],Buffer.from([1,3,0,255,128]));
    assert.equal(hub.buffer.read().at(-1)?.bytesHex,'010300ff80');
    assert.equal((await write('lf',{payload:'FF',encoding:'hex',appendNewline:true})).ok,true);
    assert.deepEqual(sent[1],Buffer.from([255,10]));
    assert.equal((await write('invalid',{payload:'01 F',encoding:'hex'})).ok,false);
    assert.equal(sent.length,2);
    assert.equal((await write('ascii',{payload:'hello',appendNewline:true})).ok,true);
    assert.equal(sent[2],'hello\n');
  } finally {socket.terminate(); await ws.close(); await hub.stop();}
});

test('project actions share MCP and WebSocket, run in the project directory and block TX', {timeout:20000}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'serial-action-integration-'));
  const otherDir = join(dir, 'other-project');
  await mkdir(otherDir);
  await writeFile(join(otherDir, 'platformio.ini'), '[env]');
  await writeFile(join(dir, 'action.cjs'), `console.log(process.cwd()); console.log(process.argv[2]); setTimeout(() => process.exit(process.argv[3] === 'fail' ? 2 : 0), 400);`);
  const command = `"${process.execPath}" action.cjs {port}`;
  await writeFile(join(dir, '.serial-monitor.json'), JSON.stringify({actions:[
    {label:'Test action', command, reopen:false},
    {label:'Fail action', command:command+' fail', reopen:false}
  ]}));
  const transport = new StdioClientTransport({command:process.execPath, args:['--import','tsx',entrypoint], env:{...process.env as Record<string,string>, SERIAL_MOCK:'false', SERIAL_PORT:'', SERIAL_PROJECT_DIR:dir, SERIAL_WS_PORT:'0'}, stderr:'pipe'});
  const pathPromise = sessionPath(transport.stderr!);
  const client = new Client({name:'action-test',version:'1.0.0'});
  let socket:WebSocket | undefined;
  try {
    await client.connect(transport);
    const session = JSON.parse(await readFile(await pathPromise, 'utf8'));
    socket = new WebSocket(`${session.wsUrl}/?token=${session.token}`);
    await once(socket, 'open');
    const request = (type:string, extra:object = {}) => new Promise<any>((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => { socket!.off('message', listener); reject(new Error('Action request timeout')); }, 5000);
      const listener = (raw:Buffer) => {
        const message = JSON.parse(raw.toString());
        if (message.requestId === requestId) { clearTimeout(timer); socket!.off('message', listener); resolve(message); }
      };
      socket!.on('message', listener); socket!.send(JSON.stringify({type, requestId, ...extra}));
    });
    assert.equal((await request('project')).project.dir, dir);
    assert.equal(payload(await client.callTool({name:'serial_list_actions',arguments:{}})).actions.length, 2);
    assert.equal((await client.callTool({name:'serial_run_action',arguments:{label:'Test action'}})).isError, true);
    assert.equal((await request('run_action', {label:'Test action', port:'mock'})).ok, false);
    // This script only prints its arguments; it never opens the placeholder COM or flashes hardware.
    const started = new Promise<void>(resolve => {
      const listener = (raw:Buffer) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'status' && msg.status.action === 'Test action') { socket!.off('message', listener); resolve(); }
      };
      socket!.on('message', listener);
    });
    const running = request('run_action', {label:'Test action', port:'COM_TEST_ONLY'});
    await started;
    const blocked = await client.callTool({name:'serial_write',arguments:{payload:'test'}});
    assert.equal(blocked.isError, true);
    assert.match(payload(blocked).error, /in progress/);
    const busySwitch = await client.callTool({name:'serial_open_ui', arguments:{project_dir:otherDir}});
    assert.equal(busySwitch.isError, true);
    assert.equal((await request('set_project', {dir:otherDir})).ok, false);
    assert.equal((await running).action.ok, true);
    const records = payload(await client.callTool({name:'serial_read',arguments:{lines:50}})).records;
    assert.ok(records.some((record:any) => record.source === 'system' && record.text === dir));
    assert.ok(records.some((record:any) => record.text === 'COM_TEST_ONLY'));
    const failed = payload(await client.callTool({name:'serial_run_action',arguments:{label:'Fail action',port:'COM_TEST_ONLY'}}));
    assert.equal(failed.ok, false);
    assert.equal(failed.exitCode, 2);
    assert.equal(payload(await client.callTool({name:'serial_list_ports',arguments:{}})).status.action, '');
    assert.equal((await client.callTool({name:'serial_open_ui',arguments:{project_dir:'relative/path'}})).isError, true);
    assert.equal((await client.callTool({name:'serial_open_ui',arguments:{project_dir:join(dir,'missing')}})).isError, true);
    assert.equal(payload(await client.callTool({name:'serial_list_actions',arguments:{}})).dir, dir);
    const updated = new Promise<any>(resolve => {
      const listener = (raw:Buffer) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'project') { socket!.off('message', listener); resolve(msg.project); }
      };
      socket!.on('message', listener);
    });
    const reused = payload(await client.callTool({name:'serial_open_ui',arguments:{project_dir:otherDir}}));
    assert.equal(reused.alreadyRunning, true);
    assert.equal(reused.projectDir, otherDir);
    assert.equal((await updated).dir, otherDir);
    const switched = payload(await client.callTool({name:'serial_list_actions',arguments:{}}));
    assert.equal(switched.dir, otherDir);
    assert.deepEqual(switched.actions.map((action:any) => action.label), ['Upload firmware','Upload filesystem']);
    const selected = payload(await client.callTool({name:'serial_open_ui',arguments:{project_dir:otherDir,port:'COM21',baud_rate:9600}}));
    assert.equal(selected.selectedPort, 'COM21');
    assert.equal(selected.baudRate, 9600);
    const selectedStatus = payload(await client.callTool({name:'serial_list_ports',arguments:{}})).status;
    assert.equal(selectedStatus.connected, false);
    assert.equal(selectedStatus.selection.port, 'COM21');
    assert.equal(selectedStatus.selection.baudRate, 9600);
    // Manual selection uses the same project state as MCP, validates folders, and clears a stale COM.
    assert.equal((await request('set_project', {dir:'relative/path'})).ok, false);
    assert.equal((await request('set_project', {dir:join(dir, 'missing')})).ok, false);
    assert.equal((await request('set_project', {dir:join(dir, 'action.cjs')})).ok, false);
    assert.equal((await request('project')).project.dir, otherDir);
    const manual = await request('set_project', {dir});
    assert.equal(manual.ok, true);
    assert.equal(manual.project.dir, dir);
    assert.deepEqual(manual.project.actions.map((action:any) => action.label), ['Test action', 'Fail action']);
    assert.equal(payload(await client.callTool({name:'serial_list_actions',arguments:{}})).dir, dir);
    assert.equal(payload(await client.callTool({name:'serial_list_ports',arguments:{}})).status.selection.port, '');
    await client.callTool({name:'serial_open_ui',arguments:{project_dir:otherDir,port:'COM21',baud_rate:9600}});
    const reconnect = new WebSocket(`${session.wsUrl}/?token=${session.token}`);
    try {
      const [raw] = await once(reconnect, 'message');
      const snapshot = JSON.parse(raw.toString());
      assert.equal(snapshot.type, 'snapshot');
      assert.equal(snapshot.status.selection.port, 'COM21');
    } finally { reconnect.terminate(); }
    const changed = payload(await client.callTool({name:'serial_open_ui',arguments:{project_dir:dir}}));
    assert.equal(changed.selectedPort, ''); // Another project's COM must not carry over.
    assert.equal(payload(await client.callTool({name:'serial_open_port',arguments:{port:'mock'}})).status.connected, true);
    assert.equal((await client.callTool({name:'serial_open_ui',arguments:{port:'COM22'}})).isError, true);
    assert.equal(payload(await client.callTool({name:'serial_list_ports',arguments:{}})).status.port, 'mock');
  } finally { socket?.terminate(); await client.close(); await rm(dir, {recursive:true, force:true}); }
});
test('UI child exit releases the port while the same MCP session can reopen it', {timeout:10000}, async () => {
  // Node with ignored stdin exits immediately, standing in for a closed native window.
  const transport = new StdioClientTransport({command:process.execPath,args:['--import','tsx',entrypoint],env:{...process.env as Record<string,string>,SERIAL_MOCK:'true',SERIAL_WS_PORT:'0',SERIAL_UI_EXECUTABLE:process.execPath},stderr:'pipe'});
  const client = new Client({name:'ui-exit-test',version:'1.0.0'});
  try {
    await client.connect(transport);
    assert.equal(payload(await client.callTool({name:'serial_list_ports',arguments:{}})).status.connected,true);
    assert.equal(payload(await client.callTool({name:'serial_open_ui',arguments:{}})).opened,true);
    const deadline = Date.now()+4000;
    let status;
    do {
      status = payload(await client.callTool({name:'serial_list_ports',arguments:{}})).status;
      if (!status.connected) break;
      await new Promise(resolve => setTimeout(resolve,25));
    } while (Date.now() < deadline);
    assert.equal(status.connected,false);
    assert.deepEqual(payload(await client.callTool({name:'serial_read',arguments:{lines:50}})).records,[]);
    assert.equal((await client.callTool({name:'serial_write',arguments:{payload:'closed'}})).isError,true);
    assert.equal(payload(await client.callTool({name:'serial_open_port',arguments:{port:'mock'}})).status.connected,true);
    assert.equal(payload(await client.callTool({name:'serial_write',arguments:{payload:'reopened'}})).ok,true);
  } finally {await client.close();}
});

test('stdin EOF releases daemon and removes session file', {timeout:15000}, async () => {
  const child = spawn(process.execPath,['--import','tsx',entrypoint],{env:{...process.env,SERIAL_MOCK:'true',SERIAL_WS_PORT:'0'},stdio:['pipe','pipe','pipe']});
  try {
    const path = await sessionPath(child.stderr!);
    const exited = once(child,'exit'); child.stdin!.end();
    const [code] = await exited; assert.equal(code,0);
    await assert.rejects(access(path));
  } finally { child.kill(); }
});
