import { readFile, writeFile, mkdir, copyFile, rename, cp, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export function updateCodexConfig(text:string, url:string, token:string) {
  // Replace only this server and its subtables. Keep all unrelated TOML intact.
  if (/^\s*mcp_servers\s*=/m.test(text)) throw new Error('The MCP configuration uses an inline table. Configure serial-monitor manually to preserve it.');
  const target = /^\s*\[\s*mcp_servers\.(?:serial-monitor|"serial-monitor"|'serial-monitor')(?:\.[^\]]+)?\s*\]\s*(?:#.*)?$/;
  let omit=false;
  let multiline:string|undefined;
  const preserved = text.split(/\r?\n/).filter(line => {
    if (!multiline && /^\s*\[/.test(line)) omit=target.test(line);
    const keep=!omit;
    // TOML multiline instruction strings can contain text resembling table headers.
    for (const delimiter of ['"""',"'''"]) {
      const count=line.split(delimiter).length-1;
      if (count%2 && (!multiline || multiline===delimiter)) multiline=multiline ? undefined : delimiter;
    }
    return keep;
  }).join('\n').trimEnd();
  return `${preserved}\n\n[mcp_servers.serial-monitor]\nurl = ${JSON.stringify(url)}\nhttp_headers = { Authorization = ${JSON.stringify(`Bearer ${token}`)} }\n`;
}
async function save(path:string,content:string) {
  await mkdir(dirname(path),{recursive:true});
  try {await copyFile(path,`${path}.g-monitor-${Date.now()}-${randomUUID()}.bak`);} catch (error:any) {if (error.code !== 'ENOENT') throw error;}
  const temporary=`${path}.${randomUUID()}.tmp`;
  await writeFile(temporary,content,{mode:0o600}); await rename(temporary,path);
}
async function optionalText(path:string) {try {return await readFile(path,'utf8');} catch (error:any) {if (error.code === 'ENOENT') return ''; throw error;}}
function objectSetting(value:unknown, name:string):Record<string,any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid Claude setting: ${name}.`);
  return value as Record<string,any>;
}
export type IntegrationOptions = {codex:boolean; claude:boolean; antigravity?:boolean};
function antigravityObject(text:string,name:string):Record<string,any> {
  const value:unknown=JSON.parse(text.replace(/^\uFEFF/,'') || '{}');
  if(!value || typeof value!=='object' || Array.isArray(value)) throw new Error(`Invalid Antigravity ${name}.`);
  return value as Record<string,any>;
}
export function updateAntigravityConfig(text:string, url:string, token:string) {
  const config:unknown=JSON.parse(text.replace(/^\uFEFF/,'') || '{}');
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid Antigravity configuration.');
  const value=config as Record<string,unknown>;
  const servers=value.mcpServers === undefined ? {} : value.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('Invalid Antigravity mcpServers.');
  return JSON.stringify({...value,mcpServers:{...servers,'serial-monitor':{serverUrl:url,headers:{Authorization:`Bearer ${token}`}}}},null,2)+'\n';
}
export async function configureIntegrations(options:IntegrationOptions, context:{root:string; url:string; token:string; node?:string; home?:string; codexHome?:string; installPlugin?:boolean}) {
  if (!options.codex && !options.claude && !options.antigravity) throw new Error('Select at least one agent.');
  const home=context.home ?? homedir(); const node=context.node ?? process.execPath;
  const skill=(await readFile(join(context.root,'docs/skills/g-monitor/SKILL.md'),'utf8')).replaceAll('{{G_MONITOR_ROOT}}',context.root.replaceAll('\\','/'));
  const files:string[]=[];
  // Parse/prepare all configurations before writing anything.
  const antigravityPath=join(home,'.gemini/config/mcp_config.json');
  const antigravityText=options.antigravity ? updateAntigravityConfig(await optionalText(antigravityPath),context.url,context.token) : '';
  const antigravityHooksPath=join(home,'.gemini/config/hooks.json');
  const antigravitySettingsPath=join(home,'.gemini/config/config.json');
  let antigravityHooks:Record<string,any>={},antigravitySettings:Record<string,any>={};
  if(options.antigravity) {
    antigravityHooks=antigravityObject(await optionalText(antigravityHooksPath),'hooks.json');
    antigravitySettings=antigravityObject(await optionalText(antigravitySettingsPath),'config.json');
    const sidecars=antigravitySettings.sidecars ?? {};
    if(typeof sidecars!=='object' || Array.isArray(sidecars)) throw new Error('Invalid Antigravity sidecars.');
    antigravitySettings={...antigravitySettings,sidecars:{...sidecars,'g-monitor':{...sidecars['g-monitor'],enabled:true}}};
    // Only this integration's hook is replaced; other tools' hooks stay intact.
    antigravityHooks['g-monitor-send']={enabled:true,PreInvocation:[{type:'command',command:`"${node}" "${join(context.root,'scripts/antigravity-hook.mjs')}"`,timeout:5}]};
  }
  const codexPath=join(context.codexHome ?? process.env.CODEX_HOME ?? join(home,'.codex'),'config.toml');
  const codexText=options.codex ? updateCodexConfig(await optionalText(codexPath),context.url,context.token) : '';
  const claudePath=join(home,'.claude.json');
  const settingsPath=join(home,'.claude/settings.json');
  const marketplace=join(context.root,'.session/claude-plugin');
  let claude:any;
  let settings:Record<string,any>={};
  let claudePlugin:{marketplacePath:string;pluginId:string;status:'manual'|'installed'|'pending';diagnostic?:string}|undefined;
  if (options.claude) {
    settings=objectSetting(JSON.parse(await optionalText(settingsPath) || '{}'),'settings.json');
    const marketplaces=objectSetting(settings.extraKnownMarketplaces ?? {},'extraKnownMarketplaces');
    const existing=marketplaces['g-monitor-local'];
    if (existing && existing.source?.source !== 'directory') throw new Error('g-monitor-local already belongs to another source. Remove or rename that marketplace in Claude before configuring G Monitor.');
    settings={...settings,extraKnownMarketplaces:{...marketplaces,'g-monitor-local':{...existing,source:{source:'directory',path:marketplace}}}};
    claude=JSON.parse(await optionalText(claudePath) || '{}');
    if (!claude || typeof claude !== 'object' || Array.isArray(claude)) throw new Error('Invalid Claude configuration.');
    claude.mcpServers={...claude.mcpServers};
    const previous=claude.mcpServers['serial-monitor'];
    if(previous?.url?.startsWith('http://127.0.0.1:') || previous?.args?.some((arg:unknown)=>typeof arg==='string' && /[\\/]daemon[\\/]dist[\\/]index\.js$/.test(arg))) delete claude.mcpServers['serial-monitor'];
    const old=claude.mcpServers['serial-monitor-channel'];
    if(old?.args?.some((arg:unknown)=>typeof arg==='string' && /[\\/]claude-bridge\.mjs$/.test(arg))) delete claude.mcpServers['serial-monitor-channel'];
  }
  if (options.codex) {await save(codexPath,codexText);files.push(codexPath);const path=join(home,'.agents/skills/g-monitor/SKILL.md');await save(path,skill);files.push(path);}
  let message='Integration configured. Reconnect MCP in the same chat.';
  if (options.claude) {
    await save(claudePath,JSON.stringify(claude,null,2)+'\n');files.push(claudePath);
    const path=join(home,'.claude/skills/g-monitor/SKILL.md');const oldSkill=await optionalText(path);
    if(oldSkill.includes('name: g-monitor') && oldSkill.includes('serial-monitor-channel')) {
      await copyFile(path,`${path}.g-monitor-${Date.now()}-${randomUUID()}.bak`);await unlink(path);
    }
  }
  if (options.claude) {
    const plugin=join(marketplace,'plugins/g-monitor');
    await mkdir(plugin,{recursive:true});await cp(join(context.root,'plugins/claude-g-monitor'),plugin,{recursive:true});
    const manifest=JSON.parse(await readFile(join(plugin,'.claude-plugin/plugin.json'),'utf8'));
    manifest.version=`0.1.0-test.${Date.now()}`;
    manifest.mcpServers={'serial-monitor':{type:'http',url:context.url,headers:{Authorization:`Bearer ${context.token}`}}};
    await save(join(plugin,'.claude-plugin/plugin.json'),JSON.stringify(manifest,null,2));
    await save(join(plugin,'hooks/connection.js'),`export const CONNECTION = ${JSON.stringify({url:context.url,token:context.token,node,startScript:join(context.root,'scripts/start-service.mjs')})};\n`);
    await mkdir(join(marketplace,'.claude-plugin'),{recursive:true});
    await save(join(marketplace,'.claude-plugin/marketplace.json'),JSON.stringify({name:'g-monitor-local',owner:{name:'GLAB'},plugins:[{name:'g-monitor',source:'./plugins/g-monitor',description:'G Monitor para el chat actual'}]},null,2));
    const installer=join(marketplace,'Instalar-plugin.ps1');
    await save(installer,'\ufeff'+await readFile(join(context.root,'scripts/install-claude-plugin.ps1'),'utf8'));
    files.push(installer);
    await save(settingsPath,JSON.stringify(settings,null,2)+'\n');files.push(settingsPath);
    claudePlugin={marketplacePath:marketplace,pluginId:'g-monitor@g-monitor-local',status:'manual'};
    const desktopInstructions='Marketplace local preparado. Cerrá y volvé a abrir Claude Desktop. En Code (Local): + > Plugins > Add plugin, buscá g-monitor de g-monitor-local e instalalo para tu usuario. Si ya estaba instalado, actualizalo desde Manage plugins. Luego ejecutá /reload-plugins en el chat. No requiere Claude CLI.';
    const instructions=join(marketplace,'INSTALAR-DESKTOP.txt');
    await save(instructions,'\ufeff'+[
      'G Monitor — instalación desde Claude Desktop', '', desktopInstructions, '',
      'En Code, /status debe mostrar Claude Code 2.1.286 o posterior. Actualizá Desktop si es anterior.',
      `Marketplace local: ${marketplace}`, 'Plugin: g-monitor@g-monitor-local',
      'Si no aparece, revisá que el marketplace g-monitor-local esté habilitado en el administrador de plugins.',
      'Aceptá la confirmación de confianza si Claude la muestra. No usar Chat, Cowork, Cloud ni WSL para esta prueba.',
      'Pedí: Abrí G Monitor para este proyecto. Seleccioná el COM, abrilo y enviá una selección al agente.',
      'Si cambiás de ubicación el paquete: configurá otra vez y actualizá el plugin en Desktop antes de recargar.',
      'No compartas .session ni la configuración generada: contienen las credenciales de esta PC.'
    ].join('\r\n')+'\r\n');files.push(instructions);
    const oldLauncher=join(context.root,'Claude-con-G-Monitor.cmd');
    if((await optionalText(oldLauncher)).includes('--dangerously-load-development-channels server:serial-monitor-channel')) await unlink(oldLauncher);
    message=desktopInstructions;
    if(context.installPlugin!==false && !context.home) {
      try {await promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',installer],{windowsHide:true,timeout:60000});claudePlugin.status='installed';message='Plugin instalado con Claude CLI. Ejecutá /reload-plugins en tu chat existente. También está disponible en Claude Desktop > Code > Plugins.';}
      catch(error:any) {
        if(error.code!==20) {claudePlugin.status='pending';claudePlugin.diagnostic=String(error.stderr || error.stdout || error.message).slice(0,1500);}
        message=desktopInstructions;
      }
    }
  }
  if (options.antigravity) {
    await save(antigravityPath,antigravityText);files.push(antigravityPath);
    const sidecarPath=join(home,'.gemini/config/sidecars/g-monitor/sidecar.json');
    await save(sidecarPath,JSON.stringify({command:node,args:[join(context.root,'scripts/antigravity-sidecar.mjs')],restart_policy:'on-failure',description:'Deliver G Monitor selections to the existing bound Antigravity App conversation.',display_name:'G Monitor'},null,2)+'\n');files.push(sidecarPath);
    await save(antigravityHooksPath,JSON.stringify(antigravityHooks,null,2)+'\n');files.push(antigravityHooksPath);
    await save(antigravitySettingsPath,JSON.stringify(antigravitySettings,null,2)+'\n');files.push(antigravitySettingsPath);
    message+=(options.codex || options.claude ? ' ' : '\n')+'Antigravity App: MCP, conversation hook and g-monitor sidecar configured. Restart Antigravity App, check that g-monitor is enabled in Customizations, then ask the SAME chat to open G Monitor again. Send to agent will target that existing conversation. CLI/IDE support MCP only. Real App delivery still requires validation.';
  }
  return {files,message,...(claudePlugin ? {claudePlugin} : {})};
}

