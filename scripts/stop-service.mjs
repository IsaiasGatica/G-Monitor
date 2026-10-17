import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceDir } from './service.mjs';
try {
  const service=JSON.parse(await readFile(join(serviceDir,'service.json'),'utf8'));
  const url=new URL(service.url);
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('Dirección de servicio inválida.');
  const response=await fetch(new URL('/stop',url),{method:'POST',headers:{Authorization:`Bearer ${service.token}`},signal:AbortSignal.timeout(3000)});
  if (!response.ok) throw new Error(`El servidor respondió ${response.status}`);
  console.log('Servidor G Monitor detenido.');
} catch (error) {console.error(error.message);process.exitCode=1;}
