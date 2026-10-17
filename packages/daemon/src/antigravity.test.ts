import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentSchema,sendToAgent } from './agent.js';
const sidecar=await import(new URL('../../../scripts/antigravity-sidecar.mjs',import.meta.url).href);
const hook=await import(new URL('../../../scripts/antigravity-hook.mjs',import.meta.url).href);

test('Antigravity hook supplies only the invoking App conversation, and never binds another surface',()=>{
  const id=randomUUID();
  const input={conversationId:id,transcriptPath:`C:\\Users\\test\\.gemini\\antigravity\\brain\\${id}\\transcript.jsonl`};
  assert.ok(hook.conversationContext(input).injectSteps[0].ephemeralMessage.includes(id));
  assert.deepEqual(hook.conversationContext({...input,conversationId:'guess'}),{});
  assert.deepEqual(hook.conversationContext({...input,transcriptPath:'/home/test/.gemini/antigravity-cli/transcript.jsonl'}),{});
  assert.deepEqual(hook.conversationContext({}),{});
});

test('Antigravity delivery preserves exact text and current destination without a shell, new chat or replay',async()=>{
  const conversationId=randomUUID();const calls:any[]=[];
  const text='ERROR á\n" & %PATH% $(echo secret) `literal`\n';
  const command={executable:fileURLToPath(new URL('./fake-agentapi.exe',import.meta.url)),prefix:['agentapi']};
  const run=async(...args:any[])=>{calls.push(args);return {stdout:'{"success":true}'};};
  const target={type:'antigravity' as const,conversation_id:conversationId};
  assert.equal(agentSchema.safeParse(target).success,true);
  assert.equal(agentSchema.safeParse({...target,conversation_id:'latest'}).success,false);
  await sendToAgent(target,text,'selection',{projectDir:'C:/project',port:'COM21'},undefined,async(id,prompt)=>{
    assert.equal(id,conversationId);assert.ok(prompt.endsWith(text));
    await sidecar.deliverAntigravityMessage({conversationId:id,text:prompt},command,run,'win32');
  });
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0][1].slice(0,3),['agentapi','send-message',conversationId]);
  assert.ok(calls[0][1][3].endsWith(text));
  assert.equal(calls[0][2].shell,false);assert.equal(calls[0][2].windowsHide,true);
  await assert.rejects(sendToAgent(target,text,'all',{projectDir:'project',port:''}),/puente de Antigravity/);
  for(const stdout of ['{"error":"not connected"}','{"success":false}','not json','null','[]','']) {
    let attempts=0;
    await assert.rejects(sidecar.deliverAntigravityMessage({conversationId,text},command,async()=>{attempts++;return {stdout};},'win32'));
    assert.equal(attempts,1);
  }
  await assert.rejects(sidecar.deliverAntigravityMessage({conversationId,text:'x'.repeat(30000)},command,run,'win32'),/fragmento/);
  await assert.rejects(sidecar.deliverAntigravityMessage({conversationId,text:'nul\0'},command,run,'win32'),/inválido/);
  assert.equal(calls.length,1);
});

test('Windows agentapi launcher is resolved to a native executable; arbitrary wrappers are rejected',async()=>{
  const home=await mkdtemp(join(tmpdir(),'g-monitor-agentapi-'));
  try {
    await mkdir(join(home,'.gemini/antigravity/bin'),{recursive:true});
    const path=join(home,'.gemini/antigravity/bin/agentapi.bat');
    const executable=join(home,'App with spaces','language_server.exe');
    await writeFile(path,`@echo off\r\n"${executable}" agentapi %*\r\n`);
    assert.deepEqual(await sidecar.agentApiCommand(home,'win32'),{executable,prefix:['agentapi']});
    await writeFile(path,'@echo off\ncmd /c arbitrary %*');
    await assert.rejects(sidecar.agentApiCommand(home,'win32'),/localizar/);
  } finally {await rm(home,{recursive:true,force:true});}
});
