import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const entry=fileURLToPath(new URL('./index.ts',import.meta.url));
const payload=(result:any)=>JSON.parse(result.content[0].text);
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function eventually<T>(fn:()=>Promise<T|undefined>):Promise<T> {
  for(let i=0;i<120;i++){const value=await fn();if(value!==undefined)return value;await sleep(25);}
  throw new Error('Timed out waiting for monitor');
}

test('child windows inherit a fixed chat; logs, ports, projects and lifecycle stay independent',{timeout:20000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'g-monitor-windows-'));
  const fakeUI=join(dir,'fake-ui.mjs'),windows=join(dir,'windows');await mkdir(windows);
  await writeFile(fakeUI,`if(process.env.SERIAL_MONITOR_SESSION){const {readFile,writeFile}=await import('node:fs/promises');const {join}=await import('node:path');const file=process.env.SERIAL_MONITOR_SESSION;const session=JSON.parse(await readFile(file,'utf8'));await writeFile(join(process.env.TEST_MONITOR_WINDOWS,session.monitorId+'.json'),JSON.stringify({...session,pid:process.pid,sessionFile:file}));setInterval(()=>{},1000);}`);
  const child=spawn(process.execPath,['--import','tsx',entry,'--http'],{stdio:['ignore','ignore','pipe'],env:{...process.env,SERIAL_MONITOR_SESSION:'',SERIAL_SERVICE_DIR:dir,SERIAL_HTTP_PORT:'0',SERIAL_WS_PORT:'0',SERIAL_MOCK:'true',SERIAL_UI_EXECUTABLE:process.execPath,NODE_OPTIONS:`--import=${pathToFileURL(fakeUI).href}`,TEST_MONITOR_WINDOWS:windows}});
  let trace='';child.stderr.on('data',chunk=>trace+=chunk);
  const sockets:WebSocket[]=[];let client:Client|undefined,transport:StreamableHTTPClientTransport|undefined;
  async function socketFor(session:any,attach=true) {
    const socket=new WebSocket(`${session.wsUrl}/?token=${session.token}`);sockets.push(socket);
    await once(socket,'open');
    const request=(body:object)=>new Promise<any>((resolve,reject)=>{
      const id=crypto.randomUUID();const timer=setTimeout(()=>{socket.off('message',receive);reject(new Error('WS response timeout'));},4000);
      function receive(raw:any){const result=JSON.parse(raw.toString());if(result.requestId===id){clearTimeout(timer);socket.off('message',receive);resolve(result);}}
      socket.on('message',receive);socket.send(JSON.stringify({...body,requestId:id}));
    });
    if(attach)await request({type:'ui_attached'});
    return {socket,request};
  }
  try {
    const descriptor:any=await eventually(async()=>{try{return JSON.parse(await readFile(join(dir,'service.json'),'utf8'));}catch{if(child.exitCode!==null)throw new Error(trace);return undefined;}});
    const parentSession=JSON.parse(await readFile(descriptor.sessionFile,'utf8'));
    const parent=await socketFor(parentSession);
    const observer=await socketFor(parentSession,false);
    assert.equal((await observer.request({type:'new_monitor'})).ok,false);
    client=new Client({name:'multi-monitor-test',version:'test'});
    transport=new StreamableHTTPClientTransport(new URL(descriptor.url),{requestInit:{headers:{Authorization:`Bearer ${descriptor.token}`}}});await client.connect(transport);
    const call=async(name:string,args:object={})=>client!.callTool({name,arguments:args});
    const privateCall=async(operation:string,body:object)=>{
      const response=await fetch(new URL(`/mod/antigravity/${operation}`,descriptor.url),{method:'POST',headers:{Authorization:`Bearer ${descriptor.token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
      assert.equal(response.ok,true);return response.json() as Promise<any>;
    };
    const bridge=await privateCall('register',{});
    const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222';
    await call('serial_open_ui',{project_dir:dir,agent:{type:'antigravity',conversation_id:first}});
    const opened=await parent.request({type:'new_monitor'});assert.equal(opened.ok,true);
    const id=opened.monitor.monitorId;assert.equal(opened.monitor.parentMonitorId,parentSession.monitorId);
    const childSession:any=await eventually(async()=>{try{return JSON.parse(await readFile(join(windows,id+'.json'),'utf8'));}catch{return undefined;}});
    assert.notEqual(childSession.wsUrl,parentSession.wsUrl);assert.notEqual(childSession.token,parentSession.token);
    const childWindow=await socketFor(childSession);
    const initial=payload(await call('serial_list_ports',{monitor_id:id})).status;
    assert.equal(initial.connected,false);assert.equal(initial.selection.port,'');assert.equal(initial.agent.threadId,first);
    assert.deepEqual(payload(await call('serial_read',{monitor_id:id})).records,[]);
    await call('serial_open_port',{monitor_id:id,port:'mock',baud_rate:9600});
    await call('serial_write',{payload:'PARENT ONLY'});await call('serial_write',{monitor_id:id,payload:'CHILD ONLY'});
    assert.ok(!payload(await call('serial_read',{})).records.some((r:any)=>r.text.includes('CHILD ONLY')));
    assert.ok(!payload(await call('serial_read',{monitor_id:id})).records.some((r:any)=>r.text.includes('PARENT ONLY')));
    const otherProject=join(dir,'other-project');await mkdir(otherProject);
    await call('serial_open_ui',{project_dir:otherProject,agent:{type:'antigravity',conversation_id:second}});
    assert.equal(payload(await call('serial_list_actions',{monitor_id:id})).dir,dir);
    assert.equal(payload(await call('serial_list_actions',{})).dir,otherProject);
    assert.equal(payload(await call('serial_list_ports',{monitor_id:id})).status.agent.threadId,first);
    assert.equal(payload(await call('serial_list_ports',{})).status.agent.threadId,second);
    const receipt=childWindow.request({type:'send_to_agent',text:'selected child log',scope:'selection',bindingId:initial.agent.bindingId});
    const message:any=await eventually(async()=>{const message=(await privateCall('poll',bridge)).message;return message ?? undefined;});
    const envelope=JSON.parse(message.text);assert.equal(envelope.conversationId,first);assert.ok(envelope.text.includes(id));assert.ok(envelope.text.endsWith('selected child log'));
    await privateCall('ack',{...bridge,messageId:message.id});assert.equal((await receipt).ok,true);
    // Closing the parent window releases only its port. The child still writes and keeps the inherited chat.
    parent.socket.close();
    await eventually(async()=>payload(await call('serial_list_ports',{})).status.connected ? undefined:true);
    assert.equal(payload(await call('serial_list_ports',{monitor_id:id})).status.connected,true);
    assert.equal(payload(await call('serial_write',{monitor_id:id,payload:'CHILD SURVIVES'})).ok,true);
    assert.equal(payload(await call('serial_list_ports',{monitor_id:id})).status.agent.threadId,first);
    const grandchild=payload(await call('serial_new_monitor',{monitor_id:id}));
    assert.equal(grandchild.agent.threadId,first);assert.equal(grandchild.parentMonitorId,id);assert.equal(grandchild.projectDir,dir);
    const grandchildSession:any=await eventually(async()=>{try{return JSON.parse(await readFile(join(windows,grandchild.monitorId+'.json'),'utf8'));}catch{return undefined;}});
    assert.equal(payload(await call('serial_list_ports',{monitor_id:grandchild.monitorId})).status.connected,false);
    process.kill(childSession.pid);
    await eventually(async()=>payload(await call('serial_list_monitors',{})).monitors.some((m:any)=>m.monitorId===id) ? undefined:true);
    assert.equal((await call('serial_read',{monitor_id:id})).isError,true);
    await assert.rejects(access(childSession.sessionFile));
    assert.equal(payload(await call('serial_list_ports',{monitor_id:grandchild.monitorId})).status.agent.threadId,first);
    process.kill(grandchildSession.pid);
    await eventually(async()=>payload(await call('serial_list_monitors',{})).monitors.length===1 ? true:undefined);
    assert.equal(payload(await call('serial_open_port',{port:'mock'})).ok,true);
    assert.equal(payload(await call('serial_list_monitors',{})).monitors.length,1);
  } finally {
    for(const socket of sockets)socket.terminate();
    await transport?.terminateSession().catch(()=>{});await client?.close();
    if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}
    await rm(dir,{recursive:true,force:true});
  }
});
