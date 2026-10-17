import { CONNECTION } from './connection.js';

let route;
let registering;
let polling = false;
let submitting = false;
let endedSession;

async function request($, path, body) {
  if (!CONNECTION) throw new Error('Instalar el plugin desde el asistente de G Monitor.');
  const response = await $.http.fetch(CONNECTION.url.replace(/\/mcp$/, path), {
    method: 'POST', headers: { Authorization: `Bearer ${CONNECTION.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const result = JSON.parse(response.text);
  if (!response.ok) throw new Error(result.error || `G Monitor HTTP ${response.status}`);
  return result;
}
async function currentRoute($) {
  const sessionId = await $.session.id();
  endedSession = undefined;
  if (route?.sessionId === sessionId) return route;
  if (registering) return registering;
  registering = registerRoute($, sessionId);
  try { return await registering; } finally { registering = undefined; }
}
async function registerRoute($, sessionId) {
  if (!CONNECTION) throw new Error('Instalar el plugin desde G Monitor.');
  if (route) await request($, '/mod/disconnect', route).catch(() => {});
  route = undefined;
  const started = await $.process.run([CONNECTION.node, CONNECTION.startScript, '--no-ui']);
  if (started.exitCode !== 0) throw new Error(started.stderr || 'No se pudo iniciar G Monitor.');
  route = await request($, '/mod/register', { sessionId });
  await $.mcp.connect('serial-monitor');
  return route;
}
async function deliver($, owner, message) {
  submitting = true;
  try {
    // Resolves when this session starts the turn, including when it was busy.
    await $.prompt.submit({ text: message.text });
    await request($, '/mod/ack', { ...owner, messageId: message.id });
  } catch (error) {
    await request($, '/mod/ack', { ...owner, messageId: message.id, error: String(error).slice(0, 1000) }).catch(() => {});
  } finally { submitting = false; }
}
async function poll($) {
  if (polling || !CONNECTION) return;
  polling = true;
  try {
    if (endedSession === await $.session.id()) return;
    const owner = await currentRoute($);
    if (submitting) { await request($, '/mod/heartbeat', owner); return; }
    const result = await request($, '/mod/poll', owner);
    if (result.message && !submitting) void deliver($, owner, result.message);
  } catch { route = undefined; } finally { polling = false; }
}
export function register(on) {
  on('session.start', async ($, event, next) => {
    await $.tool.register({ name: 'open_monitor', description: 'Open G Monitor for this project and bind log delivery to this existing chat.',
      inputSchema: { type: 'object', properties: { project_dir: { type: 'string' }, port: { type: 'string' }, baud: { type: 'integer', minimum: 1 } }, additionalProperties: false } });
    $.clock.every(1000, async () => { await poll($); });
    try { await currentRoute($); } catch (error) { await $.ui.log(`G Monitor: ${String(error)}`); }
    return next(event);
  });
  on('tool.call', { tool: 'mcp__g-monitor__open_monitor' }, async ($, event) => {
    const owner = await currentRoute($);
    const result = await request($, '/mod/open', { ...owner, project_dir: event.project_dir || await $.session.cwd(),
      ...(event.port ? { port: event.port } : {}), ...(event.baud ? { baud_rate: event.baud } : {}) });
    return { result: JSON.stringify(result) };
  });
  on('session.end', async ($, event, next) => {
    endedSession = await $.session.id();
    const owner = route; route = undefined;
    if (owner) await request($, '/mod/disconnect', owner).catch(() => {});
    return next(event);
  });
}
