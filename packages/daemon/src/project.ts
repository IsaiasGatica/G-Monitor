import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { LineDecoder } from './core.js';

export const ACTIONS_FILE = '.serial-monitor.json';
const actionsFile = z.object({actions:z.array(z.object({
  label:z.string().min(1).max(40),
  command:z.string().min(1).max(2048),
  // Answers for interactive scripts. {port_index} waits until the script lists "[N] COMx".
  stdin:z.string().max(1024).optional(),
  // false keeps the port closed afterwards (e.g. a script that monitors it by itself).
  reopen:z.boolean().default(true),
  timeout_s:z.number().int().min(1).max(3600).default(600)
}).strict()).max(12)});
export type ProjectAction = z.infer<typeof actionsFile>['actions'][number];
export interface ProjectInfo { dir:string; source:'file' | 'default' | 'none'; actions:ProjectAction[]; error?:string }
export interface Placeholders { port:string; baud:number }

// The VS Code extension does not put PlatformIO on PATH for processes it does not own.
function pioCommand() {
  const local = join(homedir(), '.platformio', 'penv', process.platform === 'win32' ? 'Scripts/pio.exe' : 'bin/pio');
  return existsSync(local) ? `"${local}"` : 'pio';
}
// Two-filesystem projects ship this script; it asks for the port index interactively.
const FS_SCRIPT = 'build_and_upload.py';

// Re-read on every request so editing the file applies without restarting Claude Code.
export async function loadProject(dir:string):Promise<ProjectInfo> {
  const file = join(dir, ACTIONS_FILE);
  if (existsSync(file)) {
    try { return {dir, source:'file', actions:actionsFile.parse(JSON.parse(await readFile(file, 'utf8'))).actions}; }
    catch (error) { return {dir, source:'file', actions:[], error:`${ACTIONS_FILE} invalid: ${error instanceof Error ? error.message : String(error)}`}; }
  }
  if (!existsSync(join(dir, 'platformio.ini'))) return {dir, source:'none', actions:[]};
  return {dir, source:'default', actions:[
    {label:'Upload firmware', command:'{pio} run -t upload --upload-port {port}', reopen:true, timeout_s:600},
    existsSync(join(dir, FS_SCRIPT))
      ? {label:'Upload filesystem', command:`python ${FS_SCRIPT}`, stdin:'{port_index}\n', reopen:true, timeout_s:600}
      : {label:'Upload filesystem', command:'{pio} run -t uploadfs --upload-port {port}', reopen:true, timeout_s:600}
  ]};
}

export function expand(template:string, values:Placeholders) {
  return template.replaceAll('{pio}', pioCommand()).replaceAll('{port}', values.port).replaceAll('{baud}', String(values.baud));
}

const escapeRegExp = (text:string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Runs through the shell so scripts (.py/.bat wrappers, npm, make…) work as typed in the file.
export function runAction(action:ProjectAction, cwd:string, values:Placeholders, line:(text:string) => void) {
  return new Promise<{exitCode:number | null; timedOut:boolean}>((resolve, reject) => {
    const child = spawn(expand(action.command, values), {cwd, shell:true, windowsHide:true, stdio:['pipe','pipe','pipe'],
      env:{...process.env, PYTHONUNBUFFERED:'1', PYTHONIOENCODING:'utf-8'}});
    child.stdin.on('error', () => {});
    let answer = action.stdin === undefined ? undefined : expand(action.stdin, values);
    const reply = (text:string) => { child.stdin.end(text); answer = undefined; };
    // Without {port_index} the answer is known upfront; EOF also unblocks any unexpected prompt.
    if (answer === undefined || !answer.includes('{port_index}')) reply(answer ?? '');
    const listed = new RegExp(`\\[(\\d+)\\]\\s+${escapeRegExp(values.port)}\\b`);
    const out = new LineDecoder(text => {
      const clean = text.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
      if (!clean) return;
      line(clean);
      const match = answer && clean.match(listed);
      if (answer && match) reply(answer.replaceAll('{port_index}', match[1]));
    });
    const interactive = action.stdin !== undefined;
    const feed = (text:string) => {
      out.feed(text.replaceAll('\r', '\n'));
      // A prompt has no newline: log it as its own line instead of gluing it to the next output.
      if (interactive && !/\n\s*$/.test(text)) out.flush();
      // Output stopped at a prompt before the port was listed: EOF makes the script exit instead of hanging.
      if (answer && !/\n\s*$/.test(text) && text.trim()) {
        line(`The script requested input, but ${values.port} was not in its port list.`);
        reply('');
      }
    };
    child.stdout.setEncoding('utf8').on('data', feed);
    child.stderr.setEncoding('utf8').on('data', feed);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, action.timeout_s * 1000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', exitCode => { clearTimeout(timer); out.flush(); resolve({exitCode, timedOut}); });
  });
}
function killTree(pid?:number) {
  if (!pid) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {windowsHide:true, stdio:'ignore'});
  else process.kill(pid, 'SIGKILL');
}
