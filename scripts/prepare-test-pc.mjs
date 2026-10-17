import { cp,mkdir,writeFile,stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join,relative,dirname } from 'node:path';
import { root } from './service.mjs';
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Este paquete de prueba requiere Windows x64.');
const destination=join(root,'test-pc',`G-Monitor-test-${Date.now()}`);
await stat(join(root,'apps/desktop/src-tauri/target/release/serial-monitor.exe'));
await stat(join(root,'packages/daemon/dist/index.js'));
await mkdir(destination,{recursive:true});
for (const path of ['packages/daemon/dist','scripts','docs','plugins/claude-g-monitor','apps/desktop/src-tauri/target/release/serial-monitor.exe']) {
  const target=join(destination,path);await mkdir(dirname(target),{recursive:true});await cp(join(root,path),target,{recursive:true});
}
await cp(process.execPath,join(destination,'node.exe'));
const listing=execFileSync('cmd.exe',['/d','/s','/c','npm ls --omit=dev --parseable --all -w @serial-monitor/daemon'],{cwd:root,encoding:'utf8',windowsHide:true});
const modules=new Set();
for (const path of listing.split(/\r?\n/)) {
  if (!path.trim()) continue;
  const local=relative(join(root,'node_modules'),path.trim()).replaceAll('\\','/');
  if (!local || local.startsWith('..') || local.startsWith('@serial-monitor/')) continue;
  const parts=local.split('/');modules.add(parts[0].startsWith('@') ? parts.slice(0,2).join('/') : parts[0]);
}
for (const module of modules) {const target=join(destination,'node_modules',module);await mkdir(dirname(target),{recursive:true});await cp(join(root,'node_modules',module),target,{recursive:true,dereference:true});}
await writeFile(join(destination,'package.json'),JSON.stringify({name:'g-monitor-local-test',version:'0.1.0',private:true,type:'module'}));
await writeFile(join(destination,'Abrir-G-Monitor.cmd'),'@echo off\r\n"%~dp0node.exe" "%~dp0scripts\\start-service.mjs"\r\nif errorlevel 1 pause\r\n');
await writeFile(join(destination,'Detener-G-Monitor.cmd'),'@echo off\r\n"%~dp0node.exe" "%~dp0scripts\\stop-service.mjs"\r\nif errorlevel 1 pause\r\n');
await writeFile(join(destination,'LEEME.txt'),'\ufeff'+[
  'Paquete de prueba local, no release. Windows x64. Incluye Node; no requiere npm ni Rust en destino. La ventana requiere WebView2.',
  '1. Copiar TODA esta carpeta a una ubicación estable y escribible en la otra PC. No copiar .session de otra PC.',
  '2. Ejecutar Abrir-G-Monitor.cmd.',
  'Para otra ventana: botón + de la cabecera, antes del botón de agentes. Hereda el proyecto y el chat vinculado; tiene su propio log y empieza sin COM seleccionado.',
  'Cambiar el chat del padre no cambia el destinatario del hijo. Cada COM solo puede usarse en una ventana, también durante las grabaciones.',
  '',
  'ANTIGRAVITY',
  'Abrir el icono Agent settings de la cabecera > Antigravity App > Configure integration.',
  'Se configura Antigravity para el usuario de ESTA PC, con las credenciales locales del monitor. Conserva otros servidores y guarda un respaldo.',
  'Reiniciar Antigravity App. Comprobar en Customizations que el sidecar g-monitor esté habilitado. Pedir al MISMO chat que abra G Monitor mediante serial_open_ui con project_dir y su conversation_id actual indicado por el hook.',
  'Consultar los logs con serial_read y enviar comandos con serial_write. Enviar a agente usa el puente agentapi hacia ese chat existente. Abrir el monitor mediante terminal no vincula el chat.',
  'Si Windows rechaza el tamaño del mensaje, seleccionar un fragmento menor. La entrega real en App queda pendiente de validar. CLI e IDE tienen acceso MCP sin envío desde la ventana.',
  'No requiere npm, Rust ni copiar la configuración de otra PC.',
  '',
  'CLAUDE CODE',
  '3. Settings > Integración con agentes > Claude Code > Configurar integración.',
  '4. Sin CLI: cerrar y volver a abrir Claude Desktop. En Code elegir Local. /status debe mostrar Claude Code >= 2.1.286.',
  '5. + > Plugins > Add plugin: buscar g-monitor del marketplace g-monitor-local e instalar para tu usuario. Aceptar confianza si se solicita.',
  '6. Si ya estaba instalado: actualizar g-monitor en Manage plugins. Luego /reload-plugins en el chat.',
  '7. Pedir Abrí G Monitor para este proyecto. Abrir el COM correcto. Seleccionar texto > Enviar a agente: debe llegar a ESE chat.',
  '8. Cerrar y volver a abrir Claude y repetir. No se necesita un lanzador especial.',
  'Con Claude CLI >= 2.1.287 en PATH, el asistente intenta la instalación automática. Si falla, usar Desktop; el diagnóstico queda en el panel.',
  'Detalles: docs/hybrid-test.md. Después de configurar: .session/claude-plugin/INSTALAR-DESKTOP.txt.',
  'No usar Chat, Cowork, Cloud ni WSL para esta prueba. Detener-G-Monitor.cmd detiene el servicio.'
].join('\r\n')+'\r\n');
console.log(`Paquete de prueba listo: ${destination}\nCopiá toda esa carpeta a la otra PC. No contiene tokens ni configuración de esta PC.`);
