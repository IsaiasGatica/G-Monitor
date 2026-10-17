import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentFromMetadata, agentSchema, appRequest, MAX_AGENT_TEXT_BYTES, sendToAgent } from './agent.js';

async function fakeApp(reply:(message:any) => any) {
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\codex-g-monitor-test-${randomUUID()}` : join(tmpdir(),`codex-${randomUUID()}.sock`);
  const calls:any[] = []; const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close',() => sockets.delete(socket)); socket.on('error',() => {});
    let buffer = Buffer.alloc(0);
    socket.on('data',chunk => {
      buffer = Buffer.concat([buffer,chunk]);
      if (buffer.length < 4 || buffer.length < buffer.readUInt32LE(0)+4) return;
      const message = JSON.parse(buffer.subarray(4).toString()); calls.push(message);
      const body = Buffer.from(JSON.stringify({jsonrpc:'2.0',id:message.id,...reply(message)}));
      const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
      // Exercise fragmented framing and multi-byte UTF-8.
      const frame = Buffer.concat([header,body]); socket.write(frame.subarray(0,3));
      setImmediate(() => {if (!socket.destroyed) socket.write(frame.subarray(3));});
    });
  });
  server.listen(pipe); await once(server,'listening');
  return {pipe,calls,close:async () => {for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve()));}};
}
const catalog = {result:{tools:[{name:'send_message_to_thread',namespace:'codex_app'}]}};
test('sends exact selection to the bound existing chat, with no create/resume call', async () => {
  const app = await fakeApp(message => message.method === 'tools/list' ? catalog : {result:{success:true,contentItems:[{type:'inputText',text:'Enviado ✓'}]}});
  try {
    const thread = randomUUID();
    const target = {type:'codex' as const,thread_id:thread,app_tools_pipe:app.pipe};
    const text = ' ERROR á\n$(do not execute) `literal`\n';
    assert.deepEqual(await sendToAgent(target,text,'selection',{projectDir:'C:/project',port:'COM21'}),{threadId:thread});
    assert.equal(app.calls.length,2);
    const call = app.calls[1];
    assert.equal(call.params.tool,'send_message_to_thread');
    assert.equal(call.params.threadId,thread); assert.equal(call.params.arguments.threadId,thread);
    assert.ok(call.params.arguments.prompt.endsWith(text));
    assert.equal(call.params.arguments.model,undefined);
    assert.equal(call.params.arguments.thinking,undefined);
  } finally {await app.close();}
});
test('delivery rejection and missing tool never report success or create a chat', async () => {
  const app = await fakeApp(message => message.method === 'tools/list' ? catalog : {result:{success:false,contentItems:[{type:'inputText',text:'Chat unavailable'}]}});
  try {
    await assert.rejects(sendToAgent({type:'codex',thread_id:randomUUID(),app_tools_pipe:app.pipe},'log','all',{projectDir:'project',port:''}),/Chat unavailable/);
    assert.deepEqual(app.calls.map(call => call.method),['tools/list','tools/call']);
  } finally {await app.close();}
  const missing = await fakeApp(() => ({result:{tools:[]}}));
  try {
    await assert.rejects(sendToAgent({type:'codex',thread_id:randomUUID(),app_tools_pipe:missing.pipe},'log','all',{projectDir:'project',port:''}),/no ofrece/);
    assert.equal(missing.calls.length,1);
  } finally {await missing.close();}
});
test('rejects empty or oversized UTF-8 logs without contacting the app', async () => {
  const target = {type:'codex' as const,thread_id:randomUUID(),app_tools_pipe:'unused'};
  await assert.rejects(sendToAgent(target,'  ','all',{projectDir:'project',port:''}),/No hay texto/);
  await assert.rejects(sendToAgent(target,'á'.repeat(MAX_AGENT_TEXT_BYTES),'all',{projectDir:'project',port:''}),/supera 1 MiB/);
});
test('metadata binds the invoking chat; shared daemon startup identity is never reused', () => {
  const current = randomUUID();
  const env = {CODEX_THREAD_ID:randomUUID(),CODEX_APP_TOOLS_PIPE_PATH:'\\\\.\\pipe\\codex-test'};
  assert.equal(agentFromMetadata(undefined,env),undefined);
  assert.equal(agentFromMetadata({'x-codex-turn-metadata':JSON.stringify({thread_id:current})},env)?.thread_id,current);
  assert.equal(agentSchema.safeParse({type:'codex',thread_id:current,app_tools_pipe:'https://example.com'}).success,false);
});
test('RPC errors and timeouts fail without retries', async () => {
  const app = await fakeApp(() => ({error:{code:-1,message:'Rejected'}}));
  try {await assert.rejects(appRequest(app.pipe,'tools/list',{}),/Rejected/); assert.equal(app.calls.length,1);}
  finally {await app.close();}
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\codex-timeout-${randomUUID()}` : join(tmpdir(),`codex-${randomUUID()}.sock`);
  let client:Socket | undefined;
  const server = createServer(socket => {client = socket; socket.on('error',() => {});});
  server.listen(pipe); await once(server,'listening');
  try {await assert.rejects(appRequest(pipe,'tools/list',{},50),/confirmar la entrega/);}
  finally {client?.destroy(); await new Promise<void>(resolve => server.close(() => resolve()));}
});
