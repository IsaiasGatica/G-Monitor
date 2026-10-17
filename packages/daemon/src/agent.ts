import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const MAX_AGENT_TEXT_BYTES = 1024 * 1024;
const codexAgentSchema = z.object({
  type:z.literal('codex'), thread_id:z.string().uuid(),
  app_tools_pipe:z.string().min(1).max(4096).refine(value => value.startsWith('\\\\.\\pipe\\codex-'), 'Expected a local Codex app tools pipe'),
  host_id:z.string().min(1).max(256).optional()
}).strict();
export const agentSchema = z.discriminatedUnion('type',[
  codexAgentSchema,
  z.object({type:z.literal('claude_code'),session_id:z.string().uuid()}).strict(),
  z.object({type:z.literal('antigravity'),conversation_id:z.string().uuid()}).strict()
]);
export type AgentTarget = z.infer<typeof agentSchema>;

// Local Codex app-tools framing, as used by the installed codex-app-tools plugin.
// A separate connection per request means a disconnected app cannot reuse stale responses.
export function appRequest(pipe:string, method:string, params:object, timeout = 15000):Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(pipe);
    let pending = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error('No se pudo confirmar la entrega. Comprobá el chat antes de volver a enviar.')), timeout);
    function finish(error?:Error, result?:unknown) {
      clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(result);
    }
    socket.once('error', () => finish(new Error('La conexión con Codex no está disponible. Volvé a abrir el monitor desde el chat.')));
    socket.once('end', () => finish(new Error('Codex cerró la conexión sin confirmar la entrega.')));
    socket.once('connect', () => {
      const body = Buffer.from(JSON.stringify({id:1, jsonrpc:'2.0', method, params}));
      if (body.length > 8 * 1024 * 1024) { finish(new Error('El mensaje es demasiado grande. Seleccioná un fragmento del log.')); return; }
      const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
      socket.write(Buffer.concat([header, body]));
    });
    socket.on('data', chunk => {
      pending = Buffer.concat([pending,chunk]);
      while (pending.length >= 4) {
        const length = pending.readUInt32LE(0);
        if (length > 8 * 1024 * 1024) { finish(new Error('Respuesta de Codex demasiado grande.')); return; }
        if (pending.length < length + 4) return;
        try {
          const response = JSON.parse(pending.subarray(4,length+4).toString('utf8'));
          pending = pending.subarray(length+4);
          if (response.id !== 1) continue;
          if (response.error) finish(new Error(response.error.message ?? 'Codex rechazó el envío.'));
          else if (response.jsonrpc === '2.0' && 'result' in response) finish(undefined,response.result);
          else finish(new Error('Respuesta de Codex inválida.'));
        } catch { finish(new Error('Respuesta de Codex inválida.')); }
        return;
      }
    });
  });
}

export function agentFromMetadata(meta:Record<string,unknown> | undefined, env:NodeJS.ProcessEnv):AgentTarget | undefined {
  let turn = meta?.['x-codex-turn-metadata'];
  if (typeof turn === 'string') { try { turn = JSON.parse(turn); } catch { turn = undefined; } }
  const nested = turn && typeof turn === 'object' ? (turn as Record<string,unknown>).thread_id : undefined;
  // A shared MCP daemon may have inherited another chat's environment. Never
  // use its startup CODEX_THREAD_ID as the destination of a later invocation.
  const thread_id = nested ?? meta?.['openai/threadId'] ?? meta?.['openai/thread_id'] ?? meta?.threadId ?? meta?.thread_id;
  const parsed = agentSchema.safeParse({type:'codex', thread_id, app_tools_pipe:env.CODEX_APP_TOOLS_PIPE_PATH, host_id:env.CODEX_APP_TOOLS_CALLER_HOST_ID});
  return parsed.success ? parsed.data : undefined;
}

export async function sendToAgent(target:AgentTarget, text:string, scope:'selection'|'all', context:{projectDir:string; port:string;monitorId?:string}, claudeSend?:(content:string, scope:'selection'|'all') => Promise<unknown>, antigravitySend?:(conversationId:string,content:string,scope:'selection'|'all')=>Promise<unknown>) {
  if (!text.trim()) throw new Error('No hay texto para enviar.');
  if (Buffer.byteLength(text,'utf8') > MAX_AGENT_TEXT_BYTES) throw new Error('El log supera 1 MiB. Seleccioná un fragmento para enviarlo completo.');
  const prompt = `Log enviado desde G Monitor · ${scope === 'selection' ? 'selección' : 'log completo'}\nProyecto: ${context.projectDir}\nPuerto: ${context.port || 'sin puerto'}${context.monitorId ? `\nMonitor: ${context.monitorId} (usar monitor_id para consultar esta ventana)` : ''}\n\n${text}`;
  if (target.type === 'antigravity') {
    if (!antigravitySend) throw new Error('El puente de Antigravity App no está disponible. Configurá Antigravity y reiniciá la App.');
    return antigravitySend(target.conversation_id,prompt,scope);
  }
  if (target.type === 'claude_code') {
    if (!claudeSend) throw new Error('El plugin de Claude Code no está disponible en esta sesión.');
    return await claudeSend(prompt,scope);
  }
  const catalog = await appRequest(target.app_tools_pipe, 'tools/list', {threadStartKind:'all'});
  const tool = catalog.tools?.find((tool:any) => tool.name === 'send_message_to_thread');
  if (!tool || typeof tool.namespace !== 'string') throw new Error('Esta versión de Codex no ofrece envío a chats existentes.');
  const result = await appRequest(target.app_tools_pipe, 'tools/call', {
    arguments:{threadId:target.thread_id, prompt, ...(target.host_id ? {hostId:target.host_id}: {})},
    callerSource:'codex', callId:`g-monitor-${randomUUID()}`, namespace:tool.namespace,
    threadId:target.thread_id, tool:tool.name, turnId:`g-monitor-${randomUUID()}`,
    ...(target.host_id ? {hostId:target.host_id}: {})
  });
  if (result.success !== true) {
    const detail = result.contentItems?.filter((item:any) => item.type === 'inputText').map((item:any) => item.text).join('\n');
    throw new Error(detail || 'Codex no confirmó la entrega al chat.');
  }
  return {threadId:target.thread_id};
}
