import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm,writeFile,mkdir,cp,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { WebSocket } from 'ws';

import { configureIntegrations,updateCodexConfig,updateAntigravityConfig } from './integrations.js';
const entry=fileURLToPath(new URL('./index.ts',import.meta.url));
const payload=(result:any) => JSON.parse(result.content[0].text);
async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),'g-monitor-http-'));
  const child=spawn(process.execPath,['--import','tsx',entry,'--http'],{stdio:['ignore','ignore','pipe'],env:{...process.env,SERIAL_SERVICE_DIR:dir,SERIAL_HTTP_PORT:'0',SERIAL_WS_PORT:'0',SERIAL_MOCK:'true',SERIAL_UI_EXECUTABLE:''}});
  let trace='';child.stderr!.on('data',data => {trace+=data;});
  let descriptor:any;
  for (let attempt=0;attempt<100;attempt++) {
    try {descriptor=JSON.parse(await readFile(join(dir,'service.json'),'utf8'));break;} catch {}
    await new Promise(resolve => setTimeout(resolve,30));
  }
  if (!descriptor) {child.kill();throw new Error(trace || 'HTTP startup timeout');}
  const session=JSON.parse(await readFile(descriptor.sessionFile,'utf8'));
  const clients:{client:Client;transport:StreamableHTTPClientTransport}[]=[];
  async function connect(name='hybrid-test') {
    const client=new Client({name,version:'test'});
    const transport=new StreamableHTTPClientTransport(new URL(descriptor.url),{requestInit:{headers:{Authorization:`Bearer ${descriptor.token}`}}});
    await client.connect(transport);clients.push({client,transport});return {client,transport};
  }
  return {dir,descriptor,session,connect,child,close:async () => {
    for (const {client,transport} of clients) {await transport.terminateSession().catch(() => {});await client.close();}
    const exited=once(child,'exit');child.kill();await exited;await rm(dir,{recursive:true,force:true});
  }};
}
test('HTTP MCP authenticates, rejects browser origins and shares one serial owner across sessions', {timeout:10000},async () => {
  const f=await fixture();
  try {
    assert.equal((await fetch(f.descriptor.url,{method:'POST'})).status,401);
    assert.equal((await fetch(f.descriptor.url,{method:'POST',headers:{Authorization:`Bearer ${f.descriptor.token}`,Origin:'https://foreign.example'}})).status,403);
    const a=await f.connect();const b=await f.connect();
    assert.notEqual(a.transport.sessionId,b.transport.sessionId);
    assert.equal((await a.client.callTool({name:'serial_new_monitor',arguments:{}})).isError,true);
    assert.equal(payload(await a.client.callTool({name:'serial_list_monitors',arguments:{}})).monitors.length,1);
    assert.equal(payload(await a.client.callTool({name:'serial_close_port',arguments:{}})).status.connected,false);
    assert.equal(payload(await b.client.callTool({name:'serial_list_ports',arguments:{}})).status.connected,false);
    assert.equal(payload(await b.client.callTool({name:'serial_open_port',arguments:{port:'mock'}})).status.connected,true);
    await a.transport.terminateSession();await a.client.close();
    assert.equal(payload(await b.client.callTool({name:'serial_write',arguments:{payload:'HTTP SAME COM'}})).ok,true);
    const records=payload(await b.client.callTool({name:'serial_read',arguments:{lines:10}})).records;
    assert.ok(records.some((record:any) => record.text === 'HTTP SAME COM'));
  } finally {await f.close();}
});
test('mod HTTP delivers a selection to only the bound existing Claude chat', {timeout:15000},async () => {
  const f=await fixture();let socket:WebSocket|undefined;
  try {
    const call=async (path:string,body:object) => {
      const response=await fetch(f.descriptor.url.replace('/mcp',path),{method:'POST',headers:{Authorization:'Bearer '+f.descriptor.token,'Content-Type':'application/json'},body:JSON.stringify(body)});
      const value=await response.json();if(!response.ok) throw new Error(JSON.stringify(value));return value as any;
    };
    const a=await call('/mod/register',{sessionId:'11111111-1111-4111-8111-111111111111'});
    const b=await call('/mod/register',{sessionId:'22222222-2222-4222-8222-222222222222'});
    await assert.rejects(call('/mod/poll',{...a,key:b.key}));
    socket=new WebSocket(f.session.wsUrl+'/?token='+f.session.token);await once(socket,'open');
    const attached=new Promise<void>(resolve=>socket!.on('message',raw=>{const message=JSON.parse(raw.toString());if(message.requestId==='attach') resolve();}));
    socket.send(JSON.stringify({type:'ui_attached',requestId:'attach'}));await attached;
    const bound=await call('/mod/open',{...a,project_dir:f.dir});
    const http=await f.connect();
    assert.ok(!(await http.client.listTools()).tools.some(tool => /channel|ack_agent/.test(tool.name)));
    const reply=new Promise<any>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Delivery timeout')),4000);
      socket!.on('message',raw=>{const message=JSON.parse(raw.toString());if(message.requestId==='selection'){clearTimeout(timer);resolve(message);}});
    });
    socket.send(JSON.stringify({type:'send_to_agent',requestId:'selection',text:'ERROR exact á',scope:'selection',bindingId:bound.agent.bindingId}));
    let delivery:any;
    for(let i=0;i<30;i++){delivery=await call('/mod/poll',a);if(delivery.message) break;await new Promise(r=>setTimeout(r,20));}
    assert.ok(delivery.message.text.endsWith('ERROR exact á'));
    assert.equal((await call('/mod/poll',b)).message,null);
    assert.equal((await call('/mod/poll',a)).message,null);
    await assert.rejects(call('/mod/ack',{...b,messageId:delivery.message.id}));
    await call('/mod/ack',{...a,messageId:delivery.message.id});
    assert.equal((await reply).delivery.confirmed,true);
    await call('/mod/disconnect',a);
    assert.equal(payload(await http.client.callTool({name:'serial_list_ports',arguments:{}})).status.agent,null);
  } finally {socket?.terminate();await f.close();}
});

test('Antigravity bridge delivers to the captured existing conversation and rejects stale bindings and wrong receipts',{timeout:15000},async()=>{
  const f=await fixture();let socket:WebSocket|undefined;
  try {
    const call=async(path:string,body:object)=>{
      const response=await fetch(f.descriptor.url.replace('/mcp','/mod/antigravity/'+path),{method:'POST',headers:{Authorization:`Bearer ${f.descriptor.token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
      const value=await response.json();if(!response.ok) throw new Error(JSON.stringify(value));return value as any;
    };
    const bridge=await call('register',{});
    const client=(await f.connect('antigravity-test')).client;
    socket=new WebSocket(f.session.wsUrl+'/?token='+f.session.token);await once(socket,'open');
    const reply=(id:string)=>new Promise<any>((resolve,reject)=>{
      const timer=setTimeout(()=>{socket!.off('message',receive);reject(new Error('No UI receipt'));},4000);
      function receive(raw:any) {const value=JSON.parse(raw.toString());if(value.requestId===id){clearTimeout(timer);socket!.off('message',receive);resolve(value);}}
      socket!.on('message',receive);
    });
    let received=reply('attach-ag');socket.send(JSON.stringify({type:'ui_attached',requestId:'attach-ag'}));await received;
    const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222';
    const open=async(id:string)=>payload(await client.callTool({name:'serial_open_ui',arguments:{project_dir:f.dir,agent:{type:'antigravity',conversation_id:id}}}));
    const bound=await open(first);assert.equal(bound.agent.threadId,first);
    received=reply('ag-send');
    socket.send(JSON.stringify({type:'send_to_agent',requestId:'ag-send',text:'ERROR exact á & %PATH%',scope:'selection',bindingId:bound.agent.bindingId}));
    let message:any;
    for(let i=0;i<50;i++) {message=(await call('poll',bridge)).message;if(message)break;await new Promise(r=>setTimeout(r,10));}
    assert.ok(message);
    // Rebinding does not redirect a selection already captured for the first chat.
    await open(second);
    const envelope=JSON.parse(message.text);
    assert.equal(envelope.conversationId,first);assert.ok(envelope.text.endsWith('ERROR exact á & %PATH%'));
    assert.equal((await call('poll',bridge)).message,null);
    await assert.rejects(call('ack',{...bridge,key:'0'.repeat(64),messageId:message.id}));
    await call('ack',{...bridge,messageId:message.id});
    const delivered=await received;assert.equal(delivered.ok,true);assert.equal(delivered.delivery.agentType,'antigravity');
    received=reply('ag-stale');socket.send(JSON.stringify({type:'send_to_agent',requestId:'ag-stale',text:'stale',scope:'all',bindingId:bound.agent.bindingId}));
    assert.equal((await received).ok,false);
    const current=await open(second);
    received=reply('ag-error');socket.send(JSON.stringify({type:'send_to_agent',requestId:'ag-error',text:'failure',scope:'all',bindingId:current.agent.bindingId}));
    for(let i=0;i<50;i++) {message=(await call('poll',bridge)).message;if(message)break;await new Promise(r=>setTimeout(r,10));}
    assert.ok(message);await call('ack',{...bridge,messageId:message.id,error:'agentapi rejected'});
    assert.equal((await received).ok,false);
    await call('disconnect',bridge);
    assert.equal(payload(await client.callTool({name:'serial_list_ports',arguments:{}})).status.agent,null);
    assert.equal((await client.callTool({name:'serial_open_ui',arguments:{agent:{type:'antigravity',conversation_id:second}}})).isError,true);
  } finally {socket?.terminate();await f.close();}
});

test('one-time integration preserves other servers and settings, installs portable skills and backs up originals',async () => {
  const dir=await mkdtemp(join(tmpdir(),'g-monitor-config-'));const home=join(dir,'home');
  try {
    await mkdir(join(dir,'docs/skills/g-monitor'),{recursive:true});await writeFile(join(dir,'docs/skills/g-monitor/SKILL.md'),'installation={{G_MONITOR_ROOT}}');
    await cp(fileURLToPath(new URL('../../../plugins',import.meta.url)),join(dir,'plugins'),{recursive:true});
    await cp(fileURLToPath(new URL('../../../scripts',import.meta.url)),join(dir,'scripts'),{recursive:true});
    await mkdir(join(home,'.codex'),{recursive:true});
    const toml='model = "my-model"\n[mcp_servers.other]\nurl = "https://other.example"\n[mcp_servers.serial-monitor]\ncommand = "old-node"\n[mcp_servers.serial-monitor.env]\nSERIAL_PORT = "COM9"\n[profiles.work]\nmodel = "another"\n';
    await writeFile(join(home,'.codex/config.toml'),toml);
    await mkdir(join(home,'.claude'),{recursive:true});
    const settings={permissions:{allow:['Read']},enabledPlugins:{'other@other-market':true},extraKnownMarketplaces:{other:{source:{source:'github',repo:'example/other'}}}};
    await writeFile(join(home,'.claude/settings.json'),JSON.stringify(settings));
    const claude={projects:{example:{trust:true}},mcpServers:{other:{command:'keep'},'serial-monitor-channel':{command:'node',args:[join(dir,'scripts/claude-bridge.mjs')]}}};await writeFile(join(home,'.claude.json'),JSON.stringify(claude));
    const context={root:dir,url:'http://127.0.0.1:47831/mcp',token:'a'.repeat(64),home,codexHome:join(home,'.codex')};
    const result=await configureIntegrations({codex:true,claude:true},context);
    assert.equal(result.claudePlugin?.status,'manual');
    assert.ok(result.message.includes('Claude Desktop'));
    assert.ok(!result.message.includes('powershell'));
    const newSettings=JSON.parse(await readFile(join(home,'.claude/settings.json'),'utf8'));
    assert.deepEqual(newSettings.permissions,settings.permissions);
    assert.deepEqual(newSettings.enabledPlugins,settings.enabledPlugins);
    assert.deepEqual(newSettings.extraKnownMarketplaces.other,settings.extraKnownMarketplaces.other);
    assert.deepEqual(newSettings.extraKnownMarketplaces['g-monitor-local'],{source:{source:'directory',path:join(dir,'.session/claude-plugin')}});
    const backups=(await readdir(join(home,'.claude'))).filter(name=>name.endsWith('.bak'));
    assert.equal(backups.length,1);
    assert.deepEqual(JSON.parse(await readFile(join(home,'.claude',backups[0]),'utf8')),settings);
    assert.ok((await readFile(join(dir,'.session/claude-plugin/INSTALAR-DESKTOP.txt'),'utf8')).includes('2.1.286'));
    const changed=await readFile(join(home,'.codex/config.toml'),'utf8');
    assert.ok(changed.includes('model = "my-model"'));assert.ok(changed.includes('[profiles.work]'));assert.ok(changed.includes('[mcp_servers.other]'));assert.ok(!changed.includes('old-node'));
    assert.equal(changed,updateCodexConfig(changed,context.url,context.token));
    const json=JSON.parse(await readFile(join(home,'.claude.json'),'utf8'));assert.deepEqual(json.projects,claude.projects);assert.deepEqual(json.mcpServers.other,claude.mcpServers.other);
    const manifest=JSON.parse(await readFile(join(dir,'.session/claude-plugin/plugins/g-monitor/.claude-plugin/plugin.json'),'utf8'));assert.equal(manifest.mcpServers['serial-monitor'].type,'http');assert.equal(json.mcpServers['serial-monitor-channel'],undefined);
    assert.ok((await readFile(join(dir,'.session/claude-plugin/plugins/g-monitor/skills/g-monitor/SKILL.md'),'utf8')).includes('open_monitor'));
    assert.ok((await readFile(join(dir,'.session/claude-plugin/Instalar-plugin.ps1'),'utf8')).includes('claude plugin install g-monitor@g-monitor-local'));
    assert.ok((await readFile(join(dir,'.session/claude-plugin/plugins/g-monitor/hooks/connection.js'),'utf8')).includes(context.token));
    await configureIntegrations({codex:false,claude:true},context);
    assert.deepEqual(JSON.parse(await readFile(join(home,'.claude/settings.json'),'utf8')),newSettings);
    // Refuse malformed settings or a foreign marketplace before modifying either agent's config.
    for (const invalid of ['{broken', '[]', '{"extraKnownMarketplaces":[]}', '{"extraKnownMarketplaces":{"g-monitor-local":{"source":{"source":"github","repo":"other/plugin"}}}}']) {
      await writeFile(join(home,'.claude/settings.json'),invalid);
      const before=await readFile(join(home,'.claude.json'),'utf8');
      await assert.rejects(configureIntegrations({codex:true,claude:true},context));
      assert.equal(await readFile(join(home,'.claude.json'),'utf8'),before);
      assert.equal(await readFile(join(home,'.codex/config.toml'),'utf8'),changed);
      assert.equal(await readFile(join(home,'.claude/settings.json'),'utf8'),invalid);
    }
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('Antigravity MCP setup preserves other settings, backs up originals and rejects invalid configurations before writing',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'g-monitor-antigravity-'));const home=join(dir,'home');
  try {
    await mkdir(join(dir,'docs/skills/g-monitor'),{recursive:true});
    await writeFile(join(dir,'docs/skills/g-monitor/SKILL.md'),'installation={{G_MONITOR_ROOT}}');
    const configPath=join(home,'.gemini/config/mcp_config.json');
    await mkdir(join(home,'.gemini/config'),{recursive:true});
    const original={preferences:{keep:true},mcpServers:{other:{command:'keep',args:['a']},'serial-monitor':{command:'old-node',disabled:true}}};
    await writeFile(configPath,'\ufeff'+JSON.stringify(original));
    const otherHook={PreInvocation:[{command:'keep-hook'}]};
    await writeFile(join(home,'.gemini/config/hooks.json'),JSON.stringify({other:otherHook}));
    await writeFile(join(home,'.gemini/config/config.json'),JSON.stringify({theme:'keep',sidecars:{other:{enabled:true}}}));
    const context={root:dir,home,url:'http://127.0.0.1:47831/mcp',token:'a'.repeat(64),codexHome:join(home,'.codex')};
    const result=await configureIntegrations({codex:false,claude:false,antigravity:true},context);
    assert.ok(result.files.includes(configPath));
    const hooks=JSON.parse(await readFile(join(home,'.gemini/config/hooks.json'),'utf8'));
    assert.deepEqual(hooks.other,otherHook);
    assert.match(hooks['g-monitor-send'].PreInvocation[0].command,/antigravity-hook\.mjs/);
    const settings=JSON.parse(await readFile(join(home,'.gemini/config/config.json'),'utf8'));
    assert.equal(settings.theme,'keep');assert.equal(settings.sidecars.other.enabled,true);assert.equal(settings.sidecars['g-monitor'].enabled,true);
    const sidecar=JSON.parse(await readFile(join(home,'.gemini/config/sidecars/g-monitor/sidecar.json'),'utf8'));
    assert.equal(sidecar.command,process.execPath);assert.deepEqual(sidecar.args,[join(dir,'scripts/antigravity-sidecar.mjs')]);
    assert.match(result.message,/Antigravity/);
    const changed=await readFile(configPath,'utf8');
    const config=JSON.parse(changed);
    assert.deepEqual(config.preferences,original.preferences);
    assert.deepEqual(config.mcpServers.other,original.mcpServers.other);
    assert.deepEqual(config.mcpServers['serial-monitor'],{serverUrl:context.url,headers:{Authorization:`Bearer ${context.token}`}});
    assert.equal(updateAntigravityConfig(changed,context.url,context.token),changed);
    const backups=(await readdir(join(home,'.gemini/config'))).filter(name=>name.endsWith('.bak'));
    const mcpBackups=backups.filter(name=>name.startsWith('mcp_config.json.'));
    assert.equal(mcpBackups.length,1);
    assert.equal(await readFile(join(home,'.gemini/config',mcpBackups[0]),'utf8'),'\ufeff'+JSON.stringify(original));
    await mkdir(context.codexHome,{recursive:true});
    await writeFile(join(context.codexHome,'config.toml'),'model = "keep"\n');
    for (const invalid of ['{broken','[]','null','{"mcpServers":[]}','{"mcpServers":null}','{"mcpServers":"broken"}']) {
      await writeFile(configPath,invalid);
      await assert.rejects(configureIntegrations({codex:true,claude:false,antigravity:true},context));
      assert.equal(await readFile(configPath,'utf8'),invalid);
      assert.equal(await readFile(join(context.codexHome,'config.toml'),'utf8'),'model = "keep"\n');
    }
    await rm(configPath);
    await configureIntegrations({codex:false,claude:false,antigravity:true},context);
    assert.deepEqual(JSON.parse(await readFile(configPath,'utf8')).mcpServers['serial-monitor'],config.mcpServers['serial-monitor']);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('installer without Claude CLI exits with Desktop instructions instead of CommandNotFoundException', {skip:process.platform!=='win32'},async()=>{
  const powershell=join(process.env.SystemRoot ?? 'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const installer=fileURLToPath(new URL('../../../scripts/install-claude-plugin.ps1',import.meta.url));
  const child=spawn(powershell,['-NoProfile','-ExecutionPolicy','Bypass','-File',installer],{env:{...process.env,PATH:''},windowsHide:true});
  let output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
  const [code]=await once(child,'exit');
  assert.equal(code,20);assert.ok(output.includes('Claude Desktop'));assert.ok(!output.includes('CommandNotFoundException'));
});

test('plugin uses host session identity and acknowledges only when prompt.submit starts a turn', {timeout:15000},async()=>{
  const f=await fixture();let socket:WebSocket|undefined;
  try {
    async function host(name:string,initialId:string) {
      const root=join(f.dir,name);await cp(fileURLToPath(new URL('../../../plugins/claude-g-monitor',import.meta.url)),root,{recursive:true});
      await writeFile(join(root,'hooks/connection.js'),'export const CONNECTION = '+JSON.stringify({url:f.descriptor.url,token:f.descriptor.token,node:'stub-node',startScript:'stub-start'})+';');
      const module=await import(pathToFileURL(join(root,'hooks/register.js')).href);
      const hooks=new Map<string,Function>();let timer:Function=()=>{};let sessionId=initialId;let release:()=>void=()=>{};
      const prompts:string[]=[];const logs:string[]=[];
      const api={session:{id:async()=>sessionId,cwd:async()=>f.dir},process:{run:async()=>({exitCode:0})},mcp:{connect:async()=>{}},ui:{log:async(text:string)=>logs.push(text)},tool:{register:async()=>{}},
        clock:{every:(_:number,fn:Function)=>{timer=fn;return {cancel(){}};}},
        http:{fetch:async(url:string,init:any)=>{const r=await fetch(url,init);return {ok:r.ok,status:r.status,text:await r.text()};}},
        prompt:{submit:({text}:{text:string})=>{prompts.push(text);return new Promise<void>(resolve=>{release=resolve;});}}};
      module.register((event:string,filterOrHandler:any,handler?:Function)=>hooks.set(event,handler??filterOrHandler));
      await hooks.get('session.start')!(api,{},async()=>{});assert.deepEqual(logs,[]);
      return {api,hooks,prompts,tick:()=>timer(),release:()=>release(),switchId:(id:string)=>{sessionId=id;}};
    }
    const a=await host('a','11111111-1111-4111-8111-111111111111');const b=await host('b','22222222-2222-4222-8222-222222222222');
    socket=new WebSocket(f.session.wsUrl+'/?token='+f.session.token);await once(socket,'open');
    const bound=JSON.parse((await a.hooks.get('tool.call')!(a.api,{project_dir:f.dir,baud:9600})).result);
    let confirmed=false;
    const reply=new Promise<any>(resolve=>socket!.on('message',raw=>{const m=JSON.parse(raw.toString());if(m.requestId==='mod-prompt'){confirmed=true;resolve(m);}}));
    socket.send(JSON.stringify({type:'send_to_agent',requestId:'mod-prompt',text:'from mod á',scope:'selection',bindingId:bound.agent.bindingId}));
    for(let i=0;i<30 && !a.prompts.length;i++){await a.tick();await new Promise(r=>setTimeout(r,10));}
    assert.ok(a.prompts[0].endsWith('from mod á'));assert.equal(confirmed,false);
    await a.tick();await b.tick();assert.equal(a.prompts.length,1);assert.equal(b.prompts.length,0);
    a.release();assert.equal((await reply).delivery.confirmed,true);
    await a.hooks.get('session.end')!(a.api,{reason:'resume'},async()=>{});
    a.switchId('33333333-3333-4333-8333-333333333333');await a.tick();
    const http=await f.connect();assert.equal(payload(await http.client.callTool({name:'serial_list_ports',arguments:{}})).status.agent,null);
    const rebound=JSON.parse((await a.hooks.get('tool.call')!(a.api,{})).result);assert.notEqual(rebound.agent.bindingId,bound.agent.bindingId);
  } finally {socket?.terminate();await f.close();}
});
test('config migration preserves table-like text inside TOML multiline instructions',() => {
  const instructions='developer_instructions = """\n[mcp_servers.serial-monitor]\nThis is an example, not a table.\n"""\n';
  const result=updateCodexConfig(instructions+'[mcp_servers.serial-monitor]\ncommand="old"\n','http://127.0.0.1:47831/mcp','a'.repeat(64));
  assert.ok(result.startsWith(instructions));assert.ok(!result.includes('command="old"'));
});


