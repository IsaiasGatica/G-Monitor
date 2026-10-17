import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm, stat, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { config, integer } from './config.js';
import { startHttpMcp } from './http-mcp.js';
import { configureIntegrations } from './integrations.js';
import { SerialHub } from './core.js';
import { SerialConnection } from './connection.js';
import { serialFormatSchema } from './serial-format-schema.js';
import { startWebSocket } from './websocket.js';
import { ACTIONS_FILE, loadProject, runAction } from './project.js';
import { agentSchema, agentFromMetadata, sendToAgent, type AgentTarget } from './agent.js';
import { ClaudeModDelivery } from './claude-mod.js';
import { PortReservations } from './port-reservations.js';

async function main() {
  const initialConfig = config();
  const httpMode = process.argv.includes('--http');
  const root = fileURLToPath(new URL('../../../',import.meta.url));
  const serviceDir = process.env.SERIAL_SERVICE_DIR || join(root,'.session');
  let httpToken = '';
  if (httpMode) {
    await mkdir(serviceDir,{recursive:true});
    const tokenFile = join(serviceDir,'http-token');
    try {httpToken = (await readFile(tokenFile,'utf8')).trim();} catch {}
    if (!/^[a-f0-9]{64}$/.test(httpToken)) {httpToken = randomBytes(32).toString('hex'); await writeFile(tokenFile,httpToken,{mode:0o600});}
  }

  let stopping = false;
  const result = (value:unknown) => ({content:[{type:'text' as const, text:JSON.stringify(value)}]});
  const guarded = async (fn:() => unknown | Promise<unknown>) => {
    try { return result(await fn()); }
    catch (error) { return {...result({error:error instanceof Error ? error.message : String(error)}), isError:true}; }
  };
  type Monitor = {id:string;parentId?:string;sessionFile:string;status:()=>any;projectDir:()=>string;createMcp:()=>McpServer;invoke:(name:string,args:any,extra:any)=>Promise<any>;dispose:()=>Promise<void>;detach:(type:AgentTarget['type'],sessionId?:string)=>void;launch:()=>Promise<object>};
  const monitors=new Map<string,Monitor>();
  const creations=new Set<Promise<Monitor>>();
  const reservations=new PortReservations();
  let httpMcp:Awaited<ReturnType<typeof startHttpMcp>> | undefined;
  let legacyMcp:McpServer | undefined;
  const claudeMods=new ClaudeModDelivery(sessionId=>{
    for(const monitor of monitors.values()) monitor.detach('claude_code',sessionId);
  });
  const antigravityBridgeId=randomUUID();
  const antigravityBridge=new ClaudeModDelivery(()=>{
    for(const monitor of monitors.values()) monitor.detach('antigravity');
  },30000,30000,'antigravity');

  type MonitorSeed={projectDir:string;baudRate:number;agent?:AgentTarget;parentId:string};
  function createMonitor(seed?:MonitorSeed):Promise<Monitor> {
    if(stopping || monitors.size+creations.size>=16)return Promise.reject(new Error('Cerrá un monitor antes de abrir otro (máximo 16).'));
    const pending=buildMonitor(seed);creations.add(pending);
    void pending.then(()=>creations.delete(pending),()=>creations.delete(pending));
    return pending;
  }
  async function buildMonitor(seed?:MonitorSeed):Promise<Monitor> {
    const id=randomUUID();
    const cfg={...initialConfig,...(seed ? {projectDir:seed.projectDir,baudRate:seed.baudRate,path:'',wsPort:0}: {})};
    let child: ChildProcess | undefined;
    let disposed=false;
    const hub:SerialHub = new SerialHub(cfg.capacity, payload => connection.send(payload));
    const connection:SerialConnection = new SerialConnection(cfg, (source,text,bytesHex) => hub.record(source,text,bytesHex), () => {
      const current=connection.status();
      if(!current.connected && !current.busy && !running) reservations.release(id);
      ws.status(status());
    });
    const openPort:SerialConnection['open']=async(port,baudRate,format)=>{
      if(connection.status().connected) throw new Error('Close the current port before opening another');
      reservations.claim(port,id);
      try {await connection.open(port,baudRate,format);} catch(error) {if(!connection.status().connected && !running)reservations.release(id);throw error;}
    };
    const token = randomBytes(32).toString('hex');
    let running = '';
    let closeAfterAction = false;
    let agent:AgentTarget | undefined=seed?.agent ? structuredClone(seed.agent) : undefined;
    let bindingId = randomUUID();
    let agentSending = false;
    let selection = {port:cfg.path, baudRate:cfg.baudRate, revision:0};
    const status = () => ({...connection.status(), monitorId:id,parentMonitorId:seed?.parentId,action:running, selection, agent:agent ? {type:agent.type, ...(agent.type === 'codex' ? {threadId:agent.thread_id}:agent.type === 'antigravity' ? {threadId:agent.conversation_id}:{}), bindingId}:null});
    const selectProject = async (projectDir?:string, port?:string, baudRate?:number) => {
      let dir = cfg.projectDir;
      if (projectDir !== undefined) {
        if (!isAbsolute(projectDir)) throw new Error('project_dir debe ser una ruta absoluta');
        dir = resolve(projectDir);
        if (!(await stat(dir)).isDirectory()) throw new Error('project_dir debe ser una carpeta');
      }
      if (dir !== cfg.projectDir || port !== undefined || baudRate !== undefined) await hub.runExclusive(async () => {
        const before = connection.status();
        if (before.connected && port !== undefined && port !== before.port) throw new Error(`Port ${before.port} is already open. Close it before selecting ${port}.`);
        const changedProject = dir !== cfg.projectDir;
        selection = {port:port ?? (changedProject ? '' : selection.port), baudRate:baudRate ?? (changedProject ? cfg.baudRate : selection.baudRate), revision:selection.revision+1};
        if (changedProject) {
          agent = undefined; bindingId = randomUUID();
          cfg.projectDir = dir;
          ws.project(await loadProject(dir));
        }
        ws.status(status());
      });
      return loadProject(cfg.projectDir);
    };
    // Releases the port, runs the project command and reopens it, all as one exclusive step of the shared queue.
    const runProjectAction = (label:string, port?:string) => hub.runExclusive(async () => {
      const action = (await loadProject(cfg.projectDir)).actions.find(a => a.label === label);
      if (!action) throw new Error(`Unknown action: ${label}`);
      const before = connection.status();
      // Only the open port or an explicit choice: a stale "last used" port could flash the wrong board.
      const target = port || (before.connected ? before.port : '');
      if (!target || target === 'mock') {
        const available = (await connection.list()).map(p => p.path).filter(p => p !== 'mock');
        throw new Error(`No board port is open or specified. Ask the user which port to use. Available: ${available.join(', ') || 'none'}`);
      }
      if (before.connected && target !== before.port) throw new Error(`The open port is ${before.port}, not ${target}`);
      reservations.claim(target,id);
      closeAfterAction = false;
      running = label; hub.blocked = `${label} in progress`; ws.status(status());
      const started = Date.now();
      try {
        if (before.connected) await connection.close();
        hub.record('system', `▶ ${label} · ${target} · ${cfg.projectDir}`);
        const lines:string[] = [];
        const {exitCode, timedOut} = await runAction(action, cfg.projectDir, {port:target, baud:before.baudRate}, text => {
          hub.record('system', text); lines.push(text); if (lines.length > 40) lines.shift();
        });
        const seconds = Math.round((Date.now() - started) / 1000);
        const ok = exitCode === 0 && !timedOut;
        hub.record('system', ok ? `✔ ${label} finished in ${seconds} s` : `✖ ${label} failed (${timedOut ? 'timed out' : `exit code ${exitCode}`}) after ${seconds} s`);
        if (before.connected && action.reopen && !closeAfterAction) {
          // The USB bridge may re-enumerate after the reset that follows flashing.
          for (let attempt = 1; ; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 700));
            if (closeAfterAction) break;
            try { await openPort(target, before.baudRate); break; }
            catch (error) { if (attempt === 5) throw new Error(`${label} ${ok ? 'finished' : 'failed'}, but could not reopen ${target}: ${String(error)}`); }
          }
        }
        return {ok, exitCode, timedOut, seconds, tail:lines.slice(-15)};
      } finally { running = ''; hub.blocked = ''; if(!connection.status().connected)reservations.release(id); ws.status(status()); }
    });
    const newMonitor=async()=>{
      const created=await createMonitor({projectDir:cfg.projectDir,baudRate:connection.status().baudRate,agent:agent ? structuredClone(agent):undefined,parentId:id});
      try {await created.launch();return {monitorId:created.id,parentMonitorId:id,projectDir:created.projectDir(),agent:created.status().agent};}
      catch(error) {await created.dispose();throw error;}
    };
    const ws = await startWebSocket(hub, token, cfg.wsPort, status(), {
      list:() => connection.list(), open:openPort, close:() => connection.close(),newMonitor,
      reset:() => connection.resetEsp32(),
      project:() => loadProject(cfg.projectDir), run:runProjectAction, setProject:dir => selectProject(dir),
      integrationInfo:() => ({available:httpMode,url:httpMcp?.url}),
      configureIntegrations:async options => {
        if (!httpMcp) throw new Error('Start G Monitor with npm start to configure the HTTP integration.');
        return {...await configureIntegrations(options,{root,url:httpMcp.url,token:httpToken}),available:true,url:httpMcp.url};
      },
      uiClosed:() => {
        if (running) closeAfterAction = true;
        return hub.runExclusive(async () => {
          if (connection.status().connected) await connection.close();
        },{cleanup:true}).then(()=>{if(seed && !disposed)void dispose();});
      },
      sendToAgent:async (text, scope, expectedBinding) => {
        if (!agent) throw new Error('Sin agente vinculado. Abrí el monitor desde el chat.');
        if (expectedBinding !== bindingId) throw new Error('Cambió el chat vinculado. Abrí el menú nuevamente antes de enviar.');
        if (agentSending) throw new Error('Ya hay un envío en curso.');
        const target = agent;
        const context = {projectDir:cfg.projectDir, port:connection.status().port || selection.port,monitorId:id};
        agentSending = true;
        try { return await sendToAgent(target,text,scope,context, (content,scope) => {
          if(target.type!=='claude_code') throw new Error('Destinatario Claude inválido.');
          return claudeMods.send(target.session_id,content,scope);
        }, (conversationId,content,scope)=>antigravityBridge.send(antigravityBridgeId,JSON.stringify({conversationId,text:content}),scope)); }
        finally { agentSending = false; }
      }
    });
    const sessionDir = await mkdtemp(join(tmpdir(), 'claude-serial-'));
    const sessionFile = join(sessionDir, 'session.json');
    await writeFile(sessionFile, JSON.stringify({protocolVersion:1,monitorId:id,parentMonitorId:seed?.parentId, wsUrl:`ws://127.0.0.1:${ws.port}`, token}), {mode:0o600});
    async function launchUi() {
      if(disposed) throw new Error('Este monitor ya fue cerrado.');
      if (ws.connected() || (child && child.exitCode === null && child.signalCode === null)) return {opened:false,alreadyRunning:true};
      if (!cfg.uiExecutable) throw new Error('Set SERIAL_UI_EXECUTABLE to the built Tauri executable');
      const launched = spawn(cfg.uiExecutable,[],{env:{...process.env,SERIAL_MONITOR_SESSION:sessionFile},stdio:'ignore',windowsHide:true});
      child = launched;
      launched.on('error',error => {hub.record('system',`UI launch failed: ${error.message}`); if (child === launched) child = undefined;});
      launched.on('exit',() => {if (child === launched) {child = undefined; ws.uiExited();}});
      await new Promise<void>((resolve,reject) => {launched.once('spawn',resolve);launched.once('error',reject);});
      return {opened:true};
    }
    const handlers=new Map<string,(args:any,extra:any)=>Promise<any>>();
    function createMcp() {
      const mcp = new McpServer({name:'g-monitor',version:'0.1.0'}, {
        instructions:'Each G Monitor window has its own log, project, serial owner and fixed agent binding. Use serial_list_monitors to find a window and pass its monitor_id on tools; omission targets the main monitor. serial_new_monitor inherits the selected parent window agent and project, with no selected COM and an empty log. Pass this chat project_dir and never guess a COM. Claude Code: use the g-monitor plugin open_monitor tool to bind this existing session. Codex Desktop: pass agent with this chat CODEX_THREAD_ID and CODEX_APP_TOOLS_PIPE_PATH. Antigravity App: use the current conversation_id supplied by the hook. Never create or fork a chat for delivery.'
      });
      function registerTool(name:string,definition:{description:string;inputSchema:z.ZodRawShape},handler:(args:any,extra:any)=>any) {
        const schema=z.object(definition.inputSchema);
        handlers.set(name,async(args,extra)=>handler(schema.parse(args),extra));
        mcp.registerTool(name,{...definition,inputSchema:{...definition.inputSchema,monitor_id:z.string().uuid().optional().describe('Target a monitor returned by serial_list_monitors or serial_new_monitor. Omit for the main monitor.')}},async(input,extra)=>{
          const {monitor_id,...args}=input;
          try {
            const target=monitor_id ? monitors.get(monitor_id as string):monitors.get(id);
            if(!target) throw new Error('El monitor indicado ya no está disponible. Consultá serial_list_monitors.');
            return await target.invoke(name,args,extra);
          } catch(error) {return {...result({error:error instanceof Error ? error.message : String(error)}),isError:true};}
        });
      }
      registerTool('serial_list_monitors',{
        description:'List independent monitor windows and their IDs, projects, ports and linked chats. Use monitor_id on other tools to target a child window.',inputSchema:{}
      },()=>result({monitors:[...monitors.values()].map(monitor=>({monitorId:monitor.id,parentMonitorId:monitor.parentId,projectDir:monitor.projectDir(),status:monitor.status()}))}));
      registerTool('serial_new_monitor',{
        description:'Open another independent monitor, inheriting a snapshot of this monitor\'s current agent/chat and project. Starts with an empty log and closed, unselected port. Later changes to the parent do not redirect the child. Use the returned monitorId as monitor_id on subsequent calls.',inputSchema:{}
      },()=>guarded(newMonitor));
      registerTool('serial_read', {
        description:'Read recent serial records on demand. Filter is a case-sensitive literal substring. Maximum 500 records; no unsolicited logs.',
        inputSchema:{lines:z.number().int().min(1).max(500).default(100), filter:z.string().max(512).optional()}
      }, ({lines, filter}) => {
        const candidates = hub.buffer.read(lines, filter);
        const records = [];
        let bytes = 0;
        for (let i = candidates.length - 1; i >= 0; i--) {
          const size = Buffer.byteLength(JSON.stringify(candidates[i]));
          if (bytes + size > 32768) break;
          records.unshift(candidates[i]); bytes += size;
        }
        return result({records, truncated:records.length < candidates.length, status:status()});
      });
      registerTool('serial_write', {
        description:'Write exact UTF-8 payload to serial. Include newline/CR explicitly if required. Serializes with manual UI writes.',
        inputSchema:{payload:z.string().min(1).max(4096)}
      }, ({payload}) => guarded(async () => { await hub.write(payload, 'claude'); return {ok:true}; }));
      registerTool('serial_wait_for', {
        description:'Wait for a literal substring in NEW hardware records only, for up to 60 seconds. Register wait before sending if immediate replies matter.',
        inputSchema:{pattern:z.string().min(1).max(512), timeout_ms:z.number().int().min(1).max(60000).default(5000)}
      }, ({pattern, timeout_ms}) => guarded(() => hub.waitFor(pattern, timeout_ms)));
      registerTool('serial_list_ports', {
        description:'List available serial ports (path, manufacturer) plus the simulated "mock" device, and the current connection status.', inputSchema:{}
      }, () => guarded(async () => ({ports:await connection.list(), status:status()})));
      registerTool('serial_open_port', {
        description:'Open a serial port (e.g. "COM21", or "mock" for the simulator). Optional data_bits (5–8), parity (none/even/odd), stop_bits (1/2); omitted format fields keep the last used values, initially 8N1. Fails if another port is open: call serial_close_port first. Shared with the UI window.',
        inputSchema:{port:z.string().min(1).max(256), baud_rate:z.number().int().min(50).max(4000000).default(cfg.baudRate), data_bits:serialFormatSchema.dataBits, parity:serialFormatSchema.parity, stop_bits:serialFormatSchema.stopBits}
      }, ({port, baud_rate, data_bits, parity, stop_bits}) => guarded(async () => { await hub.runExclusive(() => openPort(port, baud_rate,{dataBits:data_bits,parity,stopBits:stop_bits})); return {ok:true, status:status()}; }));
      registerTool('serial_close_port', {
        description:'Close the current serial port and release it for other tools (e.g. firmware upload). The daemon and UI keep running.', inputSchema:{}
      }, () => guarded(async () => { await hub.runExclusive(() => connection.close()); return {ok:true, status:status()}; }));
      registerTool('serial_reset_esp32', {
        description:'Restart the ESP32 firmware on the currently open port through a USB-UART auto-reset circuit. Keeps DTR false and pulses RTS for 100 ms, then leaves both false. Does not enter the flashing bootloader. Requires an open port; does not select or open another. Native USB and boards without auto-reset wiring may need a different sequence. Mock mode only logs a simulated reset.', inputSchema:{}
      }, () => guarded(async () => { await hub.runExclusive(() => connection.resetEsp32()); return {ok:true, status:status()}; }));
      registerTool('serial_list_actions', {
        description:`List the project actions (firmware/filesystem upload, scripts) for the project directory this session was started from. Defined in ${ACTIONS_FILE}, or PlatformIO defaults.`, inputSchema:{}
      }, () => guarded(async () => {
        const project = await loadProject(cfg.projectDir);
        return {...project, actions:project.actions.map(({label, command}) => ({label, command}))};
      }));
      registerTool('serial_run_action', {
        description:'Run a project action by label (e.g. "Upload firmware"). Uses the currently open port, or `port` if given; if neither, it fails listing the available ports — then ask the user which COM to use, never guess. Releases the port, runs the command in the project directory with its output in the log, then reopens it. Blocks TX meanwhile. May take minutes.',
        inputSchema:{label:z.string().min(1).max(40), port:z.string().min(1).max(256).optional()}
      }, ({label, port}) => guarded(() => runProjectAction(label, port)));
      registerTool('serial_open_ui', {
        description:'Open G Monitor for this chat project. Pass project_dir, configured port and optionally baud_rate. Codex Desktop: agent:{type:"codex",thread_id,app_tools_pipe} from CODEX_THREAD_ID and CODEX_APP_TOOLS_PIPE_PATH in this chat shell (optional host_id). Claude Code: use the g-monitor plugin open_monitor tool, or pass agent:{type:"claude_code",session_id} for the current registered mod session. Antigravity App: pass agent:{type:"antigravity",conversation_id} using ONLY the current conversation UUID supplied by the G Monitor hook. If missing, configure Antigravity and restart the App; never guess the ID. Never guess a COM or create a new chat. Reuses the window and preselects COM without opening it.',
        inputSchema:{project_dir:z.string().min(1).max(4096).optional(), port:z.string().trim().min(1).max(256).optional(), baud_rate:z.number().int().min(50).max(4000000).optional(), agent:agentSchema.optional()}
      }, ({project_dir, port, baud_rate, agent:explicitAgent}, extra) => guarded(async () => {
        const selectedAgent=explicitAgent ?? agentFromMetadata(extra?._meta,process.env);
        if(selectedAgent?.type==='claude_code' && !claudeMods.connected(selectedAgent.session_id)) throw new Error('El plugin de Claude no está conectado a este chat.');
        if(selectedAgent?.type==='antigravity' && !antigravityBridge.connected(antigravityBridgeId)) throw new Error('El puente de Antigravity App no está conectado. Configurá Antigravity, reiniciá la App y comprobá que el sidecar g-monitor esté habilitado.');
        await selectProject(project_dir, port, baud_rate);
        agent = selectedAgent;
        bindingId = randomUUID(); ws.status(status());
        const selected = {monitorId:id,projectDir:cfg.projectDir, selectedPort:connection.status().connected ? connection.status().port : selection.port, baudRate:connection.status().connected ? connection.status().baudRate : selection.baudRate, agent:status().agent};
        return {...await launchUi(),...selected};
      }));
      return mcp;
    }
    async function dispose() {
      if(disposed)return;
      disposed=true;
      const queued=hub.stop();
      await Promise.race([connection.close().catch(()=>{}),new Promise<void>(resolve=>setTimeout(resolve,1000))]);
      await Promise.race([queued,new Promise<void>(resolve=>setTimeout(resolve,1000))]);
      await ws.close();child?.kill();reservations.release(id);
      await rm(sessionDir,{recursive:true,force:true});monitors.delete(id);
    }
    const monitor:Monitor={id,parentId:seed?.parentId,sessionFile,status,projectDir:()=>cfg.projectDir,createMcp,launch:launchUi,dispose,
      invoke:async(name,args,extra)=>{
        if(disposed)throw new Error('Este monitor ya fue cerrado.');
        if(!handlers.size)createMcp();
        const handler=handlers.get(name);if(!handler)throw new Error('Herramienta desconocida.');
        return handler(args,extra);
      },
      detach:(type,sessionId)=>{
        if(agent?.type===type && (type!=='claude_code' || (agent.type==='claude_code' && agent.session_id===sessionId))) {
          agent=undefined;bindingId=randomUUID();ws.status(status());
        }
      }
    };
    monitors.set(id,monitor);
    try {if(cfg.path)await hub.runExclusive(()=>openPort(cfg.path,cfg.baudRate));}
    catch(error){console.error(`Open failed: ${String(error)}`);}
    return monitor;
  }
  const primary=await createMonitor();
  async function modRequest(path:string,body:unknown) {
    const identity=z.object({sessionId:z.string().uuid(),key:z.string().regex(/^[a-f0-9]{64}$/)});
    if(path.startsWith('/mod/antigravity/')) {
      if(path==='/mod/antigravity/register') {z.object({}).strict().parse(body);return antigravityBridge.register(antigravityBridgeId);}
      const input=identity.extend({messageId:z.string().uuid().optional(),error:z.string().max(1000).optional()}).strict().parse(body);
      if(input.sessionId!==antigravityBridgeId) throw new Error('Puente de Antigravity inválido.');
      if(path==='/mod/antigravity/poll') return antigravityBridge.poll(input.sessionId,input.key);
      if(path==='/mod/antigravity/heartbeat') {antigravityBridge.touch(input.sessionId,input.key);return {ok:true};}
      if(path==='/mod/antigravity/disconnect') return antigravityBridge.disconnect(input.sessionId,input.key);
      if(path==='/mod/antigravity/ack' && input.messageId) return antigravityBridge.acknowledge(input.sessionId,input.key,input.messageId,input.error);
      throw new Error('Operación de Antigravity desconocida.');
    }
    if(path==='/mod/heartbeat') {const input=identity.strict().parse(body);claudeMods.touch(input.sessionId,input.key);return {ok:true};}
    if(path==='/mod/register') {
      const input=z.object({sessionId:z.string().uuid()}).strict().parse(body);return claudeMods.register(input.sessionId);
    }
    if(path==='/mod/poll') {const input=identity.strict().parse(body);return claudeMods.poll(input.sessionId,input.key);}
    if(path==='/mod/disconnect') {const input=identity.strict().parse(body);return claudeMods.disconnect(input.sessionId,input.key);}
    if(path==='/mod/ack') {
      const input=identity.extend({messageId:z.string().uuid(),error:z.string().max(1000).optional()}).strict().parse(body);
      return claudeMods.acknowledge(input.sessionId,input.key,input.messageId,input.error);
    }
    if(path==='/mod/open') {
      const input=identity.extend({project_dir:z.string().min(1).max(4096),port:z.string().min(1).max(256).optional(),baud_rate:z.number().int().min(50).max(4000000).optional(),monitor_id:z.string().uuid().optional()}).strict().parse(body);
      // Validate the private route without taking a message out of its inbox.
      claudeMods.touch(input.sessionId,input.key);
      const monitor=input.monitor_id ? monitors.get(input.monitor_id):primary;
      if(!monitor)throw new Error('Monitor no disponible.');
      const response=await monitor.invoke('serial_open_ui',{project_dir:input.project_dir,port:input.port,baud_rate:input.baud_rate,agent:{type:'claude_code',session_id:input.sessionId}},undefined);
      const value=JSON.parse(response.content[0].text);if(response.isError)throw new Error(value.error);return value;
    }
    throw new Error('Operación de plugin desconocida.');
  }
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    claudeMods.close();
    antigravityBridge.close();
    await Promise.allSettled([...creations]);
    await Promise.allSettled([...monitors.values()].map(monitor=>monitor.dispose()));
    await httpMcp?.close(); await legacyMcp?.close().catch(() => {});
    process.exit(0);
  }
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  if (!httpMode) process.stdin.once('end', () => void shutdown());
  if (httpMode) {
    httpMcp = await startHttpMcp(primary.createMcp,httpToken,integer('SERIAL_HTTP_PORT',47831,0,65535),() => void shutdown(),modRequest);
    await writeFile(join(serviceDir,'service.json'),JSON.stringify({url:httpMcp.url,token:httpToken,sessionFile:primary.sessionFile,pid:process.pid}),{mode:0o600});
    console.error('G Monitor HTTP ready: ' + httpMcp.url);
  } else {legacyMcp = primary.createMcp(); await legacyMcp.connect(new StdioServerTransport());}
  if (httpMode && process.argv.includes('--open-ui')) await primary.launch();
  // stderr only: stdout belongs exclusively to MCP.
  console.error(`Serial monitor ready. Session file: ${primary.sessionFile}`);
}
main().catch(error => { console.error(error); process.exit(1); });
