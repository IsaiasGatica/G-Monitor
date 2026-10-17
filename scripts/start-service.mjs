import { ensureService } from './service.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
if (process.argv.includes('--mock')) process.env.SERIAL_MOCK = 'true';
try {
  const service = await ensureService();
  if (!process.argv.includes('--no-ui')) {
    const client = new Client({name:'g-monitor-launcher',version:'0.1.0'});
    const transport = new StreamableHTTPClientTransport(new URL(service.url),{requestInit:{headers:{Authorization:`Bearer ${service.token}`}}});
    try {
      await client.connect(transport);
      const result = await client.callTool({name:'serial_open_ui',arguments:{}});
      if (result.isError) throw new Error(result.content[0].text);
    } finally {await transport.terminateSession().catch(() => {}); await client.close();}
  }
  console.log(`G Monitor disponible: ${service.url}. Cerrar la ventana libera el COM; el servidor sigue disponible.`);
} catch (error) {console.error(error.message);process.exitCode=1;}
