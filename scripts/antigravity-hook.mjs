// Antigravity supplies the current identity to this hook; never infer it from
// the most recently modified conversation or another process's environment.
export function conversationContext(input) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input?.conversationId ?? '')) return {};
  if (!String(input.transcriptPath ?? '').replaceAll('\\','/').includes('/.gemini/antigravity/')) return {};
  return {injectSteps:[{ephemeralMessage:`G Monitor: the current Antigravity App conversation_id is ${input.conversationId}. When the user asks to open G Monitor, call serial_open_ui with the absolute project_dir and agent:{"type":"antigravity","conversation_id":"${input.conversationId}"}. This binds Send to agent to THIS existing conversation. Do not create a conversation, guess an ID or substitute another conversation. Do not open the monitor unless requested. If the bridge is unavailable, ask the user to configure Antigravity in G Monitor and restart Antigravity App.`}]};
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let data='';
  try {
    for await (const chunk of process.stdin) {data+=chunk;if(Buffer.byteLength(data)>1024*1024) throw new Error('Hook input too large');}
    process.stdout.write(JSON.stringify(conversationContext(JSON.parse(data))));
  } catch {process.stdout.write('{}');}
}
