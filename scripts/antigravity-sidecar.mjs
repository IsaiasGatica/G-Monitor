import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join,isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureService } from './service.mjs';

// Read the launcher's executable instead of running a .bat through a shell:
// serial logs can contain quotes, %, &, backticks and arbitrary shell text.
export async function agentApiCommand(home=homedir(),platform=process.platform) {
  if(platform!=='win32') return {executable:join(home,'.gemini/antigravity/bin/agentapi'),prefix:[]};
  const wrapper=await readFile(join(home,'.gemini/antigravity/bin/agentapi.bat'),'utf8');
  const match=wrapper.match(/^\s*@?"([^"\r\n]+\.exe)"\s+agentapi\s+%\*\s*$/im);
  if(!match || !isAbsolute(match[1])) throw new Error('No se pudo localizar agentapi de Antigravity App. Actualizá la App.');
  return {executable:match[1],prefix:['agentapi']};
}
export async function deliverAntigravityMessage(message,command,run=promisify(execFile),platform=process.platform) {
  if(!message || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(message.conversationId ?? '') || typeof message.text!=='string' || !message.text.trim() || message.text.includes('\0')) throw new Error('Mensaje de Antigravity inválido.');
  const args=[...command.prefix,'send-message',message.conversationId,message.text];
  if(platform==='win32' && args.reduce((sum,arg)=>sum+arg.length*2+3,command.executable.length)>28000) throw new Error('El mensaje supera el límite de agentapi en Windows. Seleccioná un fragmento más pequeño.');
  const {stdout}=await run(command.executable,args,{windowsHide:true,timeout:15000,maxBuffer:1024*1024,shell:false});
  // agentapi may return a JSON error with exit code zero (e.g. absent LS address).
  let response;
  try {response=JSON.parse(String(stdout).trim());} catch {throw new Error('agentapi no confirmó la entrega. Comprobá el chat antes de reenviar.');}
  if(response?.error || response?.success===false) throw new Error(typeof response.error==='string' ? response.error : 'Antigravity rechazó el mensaje.');
  if(!response || typeof response!=='object' || Array.isArray(response)) throw new Error('Respuesta de agentapi inválida. Comprobá el chat antes de reenviar.');
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function runSidecar() {
  let stopping=false;
  process.once('SIGTERM',()=>{stopping=true;});process.once('SIGINT',()=>{stopping=true;});
  while(!stopping) {
    let request,identity;
    try {
      const service=await ensureService();
      const command=await agentApiCommand();
      request=async (operation,body)=>{
        const response=await fetch(new URL(`/mod/antigravity/${operation}`,service.url),{method:'POST',headers:{Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
        if(!response.ok) throw new Error(`G Monitor: ${operation} HTTP ${response.status}`);
        return response.json();
      };
      identity=await request('register',{});
      while(!stopping) {
        const {message}=await request('poll',identity);
        if(message) {
          let error;
          try {await deliverAntigravityMessage(JSON.parse(message.text),command);}
          catch(cause) {error=String(cause.message ?? cause).slice(0,1000);}
          // Never replay after a timeout, a failed ack or a disconnected bridge.
          await request('ack',{...identity,messageId:message.id,...(error ? {error}: {})});
        }
        await sleep(500);
      }
    } catch(error) {console.error(`G Monitor bridge: ${error.message}`);if(!stopping) await sleep(2000);}
    finally {if(request && identity) await request('disconnect',identity).catch(()=>{});}
  }
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await runSidecar();
