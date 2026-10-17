import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

export async function startHttpMcp(createMcp:(clientName?:string) => McpServer, token:string, port:number, stop?:() => void,modRequest?:(path:string,body:unknown)=>Promise<object>) {
  const sessions = new Map<string,{transport:StreamableHTTPServerTransport; mcp:McpServer}>();
  const http = createServer(async (req,res) => {
    try {
      const host = req.headers.host ?? '';
      const expectedHost = `127.0.0.1:${(http.address() as {port:number}).port}`;
      if (host !== expectedHost || (req.headers.origin && req.headers.origin !== `http://${expectedHost}`)) {res.writeHead(403).end(); return;}
      const supplied = Buffer.from(req.headers.authorization ?? ''); const expected = Buffer.from(`Bearer ${token}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied,expected)) {res.writeHead(401).end(); return;}
      if (req.url === '/health' && req.method === 'GET') {res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({name:'g-monitor',protocol:1})); return;}
      if (req.url === '/stop' && req.method === 'POST' && stop) {res.writeHead(202).end();setImmediate(stop);return;}
      if(req.url?.startsWith('/mod/') && req.method==='POST' && modRequest) {
        const chunks:Buffer[]=[];let size=0;
        for await(const chunk of req) {size+=chunk.length;if(size>2*1024*1024){res.writeHead(413).end();return;}chunks.push(chunk);}
        try {const value=await modRequest(req.url,JSON.parse(Buffer.concat(chunks).toString('utf8')));res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));}
        catch(error) {res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:error instanceof Error ? error.message:'Invalid mod request'}));}
        return;
      }
      if (req.url !== '/mcp') {res.writeHead(404).end(); return;}
      const id = req.headers['mcp-session-id'];
      if (typeof id === 'string') {
        const session = sessions.get(id);
        if (!session) {res.writeHead(404).end(); return;}
        await session.transport.handleRequest(req,res); return;
      }
      if (req.method !== 'POST') {res.writeHead(400).end(); return;}
      const chunks:Buffer[] = []; let size = 0;
      for await (const chunk of req) {size += chunk.length; if (size > 2 * 1024 * 1024) {res.writeHead(413).end(); return;} chunks.push(chunk);}
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!isInitializeRequest(body)) {res.writeHead(400).end(); return;}
      if (sessions.size >= 32) {res.writeHead(503).end(); return;}
      const mcp = createMcp(body.params.clientInfo.name);
      const transport = new StreamableHTTPServerTransport({sessionIdGenerator:randomUUID,onsessioninitialized:sessionId => {sessions.set(sessionId,{mcp,transport});}});
      await mcp.connect(transport);
      const original = transport.onclose;
      transport.onclose = () => {if (transport.sessionId) sessions.delete(transport.sessionId); original?.();};
      await transport.handleRequest(req,res,body);
      if (!transport.sessionId) await mcp.close();
    } catch {if (!res.headersSent) res.writeHead(400); res.end();}
  });
  http.headersTimeout = 10000; http.requestTimeout = 0;
  http.listen(port,'127.0.0.1');
  await new Promise<void>((resolve,reject) => {http.once('listening',resolve);http.once('error',reject);});
  return {url:`http://127.0.0.1:${(http.address() as {port:number}).port}/mcp`,close:async () => {
    await Promise.allSettled([...sessions.values()].map(session => session.mcp.close())); sessions.clear();
    http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));
  }};
}
