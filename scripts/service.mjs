import { readFile, writeFile, mkdir, open } from 'node:fs/promises';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
export const root = fileURLToPath(new URL('../',import.meta.url));
export const serviceDir = process.env.SERIAL_SERVICE_DIR || join(root,'.session');
async function availablePort(port) {
  const server=createServer();
  const selected=await new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(port,'127.0.0.1',()=>resolve(server.address().port));
  });
  await new Promise((resolve,reject)=>server.close(error=>error ? reject(error):resolve()));
  return selected;
}
export async function selectHttpPort(directory, explicit=process.env.SERIAL_HTTP_PORT) {
  if(explicit!==undefined) {
    if(!/^\d+$/.test(explicit) || Number(explicit)>65535) throw new Error('SERIAL_HTTP_PORT inválido.');
    return Number(explicit);
  }
  const file=join(directory,'http-port');
  try {
    const saved=(await readFile(file,'utf8')).trim();
    if(!/^\d+$/.test(saved) || Number(saved)<1 || Number(saved)>65535) throw new Error('El puerto guardado de G Monitor es inválido.');
    return Number(saved);
  } catch(error) {if(error.code!=='ENOENT') throw error;}
  let port;
  try {port=await availablePort(47831);} catch(error) {
    if(error.code!=='EADDRINUSE') throw error;
    port=await availablePort(0);
  }
  await mkdir(directory,{recursive:true});
  await writeFile(file,String(port));
  return port;
}
export async function ensureService() {
  async function running() {
    try {
      const service = JSON.parse(await readFile(join(serviceDir,'service.json'),'utf8'));
      const url = new URL(service.url);
      if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || url.pathname !== '/mcp' || !/^[a-f0-9]{64}$/.test(service.token)) return;
      const response = await fetch(new URL('/health',url),{headers:{Authorization:`Bearer ${service.token}`},signal:AbortSignal.timeout(800)});
      if (response.ok && (await response.json()).name === 'g-monitor') return service;
    } catch {}
  }
  const existing = await running(); if (existing) return existing;
  const daemon = join(root,'packages/daemon/dist/index.js');
  if (!existsSync(daemon)) throw new Error('Falta compilar el daemon: npm run build');
  await mkdir(serviceDir,{recursive:true});
  const port=await selectHttpPort(serviceDir);
  const log = await open(join(serviceDir,'service.log'),'a');
  const executable = join(root,'apps/desktop/src-tauri/target/release',process.platform === 'win32' ? 'serial-monitor.exe':'serial-monitor');
  const child = spawn(process.execPath,[daemon,'--http'],{cwd:root,detached:true,windowsHide:true,stdio:['ignore','ignore',log.fd],env:{...process.env,SERIAL_HTTP_PORT:String(port),SERIAL_WS_PORT:process.env.SERIAL_WS_PORT ?? '0',SERIAL_SERVICE_DIR:serviceDir,SERIAL_PORT:'',SERIAL_UI_EXECUTABLE:executable}});
  let exitCode;child.once('exit',code=>{exitCode=code ?? -1;});
  const started = new Promise((resolve,reject) => {child.once('spawn',resolve);child.once('error',reject);});
  try {await started; child.unref();} finally {await log.close();}
  for (let attempt=0;attempt<60;attempt++) {const service = await running(); if (service) return service;if(exitCode!==undefined) break;await new Promise(resolve => setTimeout(resolve,100));}
  let detail='';try {detail=(await readFile(join(serviceDir,'service.log'),'utf8')).trim().split(/\r?\n/).slice(-15).join('\n');} catch {}
  throw new Error(`No se pudo iniciar G Monitor en el puerto HTTP ${port}. Revisá ${join(serviceDir,'service.log')}.\n${detail}`);
}
