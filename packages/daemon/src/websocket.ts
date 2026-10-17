import { timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { SerialHub, type RecordEntry } from './core.js';
import { MAX_AGENT_TEXT_BYTES } from './agent.js';
import { parseSerialPayload } from './serial-payload.js';
import { serialFormatSchema } from './serial-format-schema.js';
import type { SerialFormat } from './serial-format.js';

const request = z.discriminatedUnion('type', [
  z.object({type:z.literal('write'), requestId:z.string().min(1).max(64), payload:z.string().min(1).max(12288), encoding:z.enum(['ascii','hex']).default('ascii'), appendNewline:z.boolean().default(false)}).strict(),
  z.object({type:z.literal('ping'), requestId:z.string().min(1).max(64)}).strict(),
  z.object({type:z.literal('ui_attached'), requestId:z.string().min(1).max(64)}).strict(),
  z.object({type:z.literal('integration_info'), requestId:z.string().min(1).max(64)}).strict(),
  z.object({type:z.literal('new_monitor'),requestId:z.string().min(1).max(64)}).strict(),
  z.object({type:z.literal('configure_integrations'), requestId:z.string().min(1).max(64),codex:z.boolean(),claude:z.boolean(),antigravity:z.boolean().default(false)}).strict(),
  z.object({type:z.literal('list_ports'), requestId:z.string().min(1).max(64)}).strict(),
  z.object({type:z.literal('open'), requestId:z.string().min(1).max(64), port:z.string().min(1).max(256), baudRate:z.number().int().min(50).max(4000000), ...serialFormatSchema}).strict(),
  z.object({type:z.literal('close'), requestId:z.string().min(1).max(64)}).strict(),
  z.object({type:z.literal('reset_esp32'), requestId:z.string().min(1).max(64)}).strict(),
  z.object({type:z.literal('project'), requestId:z.string().min(1).max(64)}).strict(),
  z.object({type:z.literal('set_project'), requestId:z.string().min(1).max(64), dir:z.string().min(1).max(4096)}).strict(),
  z.object({type:z.literal('send_to_agent'), requestId:z.string().min(1).max(64), text:z.string().min(1).max(MAX_AGENT_TEXT_BYTES), scope:z.enum(['selection','all']), bindingId:z.string().uuid()}).strict(),
  z.object({type:z.literal('run_action'), requestId:z.string().min(1).max(64), label:z.string().min(1).max(40), port:z.string().min(1).max(256).optional()}).strict()
]);
export interface PortControls {
  reset?:() => Promise<void>;
  list:() => Promise<unknown>; open:(path:string, baudRate:number, format?:Partial<SerialFormat>) => Promise<void>; close:() => Promise<void>;
  project?:() => Promise<unknown>; run?:(label:string, port?:string) => Promise<unknown>;
  setProject?:(dir:string) => Promise<unknown>;
  sendToAgent?:(text:string, scope:'selection'|'all', bindingId:string) => Promise<unknown>;
  uiClosed?:() => Promise<void>;
  integrationInfo?:() => object;
  configureIntegrations?:(options:{codex:boolean;claude:boolean;antigravity?:boolean}) => Promise<unknown>;
  newMonitor?:()=>Promise<object>;
}
export async function startWebSocket(hub: SerialHub, token: string, port: number, initialStatus: object, controls?:PortControls, uiReconnectMs = 2000) {
  let status = initialStatus;
  const uiSockets = new Set<WebSocket>();
  let uiCloseTimer:ReturnType<typeof setTimeout> | undefined;
  let uiReleaseRequested = false;
  let stopping = false;
  const releaseUiPort = () => {
    clearTimeout(uiCloseTimer); uiCloseTimer = undefined;
    if (stopping || uiReleaseRequested || !controls?.uiClosed) return;
    uiReleaseRequested = true;
    hub.buffer.clear();
    // Keep releasing hardware independent of whether a window can receive an ack.
    // Closing can flush pending RX or wait behind an upload. Discard those final
    // records too, so the next window starts with an empty history.
    void controls.uiClosed().finally(() => hub.buffer.clear()).catch(error => {
      uiReleaseRequested = false;
      hub.record('system',`Could not close the port after the window closed: ${String(error)}`);
    });
  };
  const wss = new WebSocketServer({host:'127.0.0.1', port, maxPayload:8 * 1024 * 1024, perMessageDeflate:false});
  await new Promise<void>((resolve, reject) => { wss.once('listening', resolve); wss.once('error', reject); });
  const send = (socket: WebSocket, message: object) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 256 * 1024) { socket.close(1013, 'Slow consumer; reconnect for snapshot'); return; }
    socket.send(JSON.stringify(message));
  };
  wss.on('connection', (socket, req) => {
    const supplied = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('token') ?? '';
    const left = Buffer.from(supplied); const right = Buffer.from(token);
    const origin = req.headers.origin;
    const allowedOrigin = !origin || ['http://localhost:1420','http://tauri.localhost','https://tauri.localhost','tauri://localhost'].includes(origin);
    if (!allowedOrigin || left.length !== right.length || !timingSafeEqual(left, right) || wss.clients.size > 8) {
      socket.close(1008, 'Unauthorized or client limit'); return;
    }
    socket.on('error', () => {});
    socket.on('close', () => {
      if (!uiSockets.delete(socket) || uiSockets.size || stopping || uiReleaseRequested) return;
      // A short transport interruption is not a window close. A reconnect cancels
      // this fallback; the launched UI process exiting releases the port immediately.
      uiCloseTimer = setTimeout(releaseUiPort,uiReconnectMs);
    });
    send(socket, {type:'snapshot', records:hub.buffer.read(500), status});
    socket.on('message', async (raw, binary) => {
      let requestId: string | undefined;
      try {
        if (binary) throw new Error('JSON text required');
        const parsed = JSON.parse(raw.toString());
        // Keep validation errors correlated with the client's pending operation.
        if (typeof parsed?.requestId === 'string' && parsed.requestId.length >= 1 && parsed.requestId.length <= 64) requestId=parsed.requestId;
        const data = request.parse(parsed); requestId = data.requestId;
        if (data.type !== 'send_to_agent' && Buffer.byteLength(raw.toString()) > (data.type === 'write' ? 16384 : 8192)) throw new Error('Request exceeds maximum size');
        if (data.type === 'ui_attached') {
          uiSockets.add(socket); uiReleaseRequested = false;
          clearTimeout(uiCloseTimer); uiCloseTimer = undefined;
        }
        if (data.type === 'write') {
          const bytes = parseSerialPayload(data.payload,data.encoding,data.appendNewline);
          await hub.write(data.encoding === 'hex' ? Buffer.from(bytes) : data.payload + (data.appendNewline ? '\n' : ''), 'user');
        }
        let ports:unknown;
        if (data.type === 'list_ports' || data.type === 'open' || data.type === 'close' || data.type === 'reset_esp32') {
          if (!controls) throw new Error('Port controls unavailable');
          if (data.type === 'list_ports') ports = await controls.list();
          if (data.type === 'open') await hub.runExclusive(() => controls.open(data.port,data.baudRate,{dataBits:data.dataBits,parity:data.parity,stopBits:data.stopBits}));
          if (data.type === 'close') await hub.runExclusive(() => controls.close());
          if (data.type === 'reset_esp32') {
            if (!controls.reset) throw new Error('ESP32 reset unavailable');
            await hub.runExclusive(() => controls.reset!());
          }
        }
        let project:unknown, action:unknown, delivery:unknown, integrations:unknown,monitor:unknown;
        if(data.type==='new_monitor') {
          if(!uiSockets.has(socket))throw new Error('Abrí un nuevo monitor desde la ventana existente.');
          if(!controls?.newMonitor)throw new Error('Este servicio no permite abrir otros monitores.');
          monitor=await controls.newMonitor();
        }
        if (data.type === 'integration_info') integrations=controls?.integrationInfo?.() ?? {available:false};
        if (data.type === 'configure_integrations') {
          if (!uiSockets.has(socket)) throw new Error('Configure the integration from the G Monitor window.');
          if (!controls?.configureIntegrations) throw new Error('Start G Monitor in HTTP mode to configure agents.');
          integrations=await controls.configureIntegrations({codex:data.codex,claude:data.claude,antigravity:data.antigravity});
        }
        if (data.type === 'send_to_agent') {
          if (!controls?.sendToAgent) throw new Error('Sin agente vinculado. Abrí el monitor desde el chat.');
          delivery = await controls.sendToAgent(data.text, data.scope, data.bindingId);
        }
        if (data.type === 'set_project') {
          if (!controls?.setProject) throw new Error('Project selection unavailable');
          project = await controls.setProject(data.dir);
        }
        if (data.type === 'project' || data.type === 'run_action') {
          if (!controls?.project || !controls.run) throw new Error('Project actions unavailable');
          if (data.type === 'project') project = await controls.project();
          if (data.type === 'run_action') action = await controls.run(data.label, data.port);
        }
        send(socket, {type:'result', requestId, ok:true, ...(ports ? {ports}: {}), ...(project ? {project}: {}), ...(action ? {action}: {}), ...(delivery ? {delivery}: {}), ...(integrations ? {integrations}: {}),...(monitor ? {monitor}:{})});
      } catch (error) { send(socket, {type:'result', requestId, ok:false, error:error instanceof Error ? error.message : 'Invalid request'}); }
    });
  });
  const broadcast = (message: object) => { for (const socket of wss.clients) send(socket, message); };
  const onRecord = (record: RecordEntry) => broadcast({type:'record', record});
  hub.on('record', onRecord);
  return {
    port:(wss.address() as {port:number}).port,
    connected:() => [...wss.clients].some(s => s.readyState === WebSocket.OPEN),
    status:(next:object) => {status = next; broadcast({type:'status', status});},
    project:(project:object) => broadcast({type:'project', project}),
    uiExited:releaseUiPort,
    close:async () => {
      stopping = true; clearTimeout(uiCloseTimer); uiSockets.clear();
      hub.off('record', onRecord);
      broadcast({type:'shutdown'});
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>(resolve => wss.close(() => resolve()));
    }
  };
}
