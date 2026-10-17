import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProject, runAction, type ProjectAction } from './project.js';

async function withDir(fn:(dir:string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'serial-project-'));
  try { await fn(dir); } finally { await rm(dir, {recursive:true, force:true}); }
}
// Mimics build_and_upload.py: lists ports as "[i] COMx - desc" and asks for the index.
const PROMPT_SCRIPT = `
const ports = ['COM1','COM21','COM3'];
ports.forEach((p,i) => console.log('  [' + i + '] ' + p + ' - device'));
process.stdout.write('Select port number to use: ');
let input = '';
process.stdin.on('data', d => input += d).on('end', () => {
  const choice = input.trim() ? ports[Number(input.trim())] : undefined;
  if (!choice) { console.log('EOF'); process.exit(3); }
  console.log('Flashing ' + choice); process.exit(0);
});`;
const action = (command:string, extra:Partial<ProjectAction> = {}):ProjectAction => ({label:'Test', command, reopen:true, timeout_s:10, ...extra});

test('PlatformIO projects get default actions; build_and_upload.py replaces uploadfs', async () => {
  await withDir(async dir => {
    assert.equal((await loadProject(dir)).source, 'none');
    await writeFile(join(dir, 'platformio.ini'), '[env]');
    let project = await loadProject(dir);
    assert.deepEqual(project.actions.map(a => a.label), ['Upload firmware', 'Upload filesystem']);
    assert.match(project.actions[1].command, /uploadfs/);
    await writeFile(join(dir, 'build_and_upload.py'), '');
    project = await loadProject(dir);
    assert.equal(project.actions[1].command, 'python build_and_upload.py');
    assert.equal(project.actions[1].stdin, '{port_index}\n');
    await writeFile(join(dir, '.serial-monitor.json'), JSON.stringify({actions:[{label:'Mio', command:'echo {port}'}]}));
    project = await loadProject(dir);
    assert.equal(project.source, 'file');
    assert.deepEqual(project.actions.map(a => a.label), ['Mio']);
    await writeFile(join(dir, '.serial-monitor.json'), '{"actions":[{"label":1}]}');
    assert.match((await loadProject(dir)).error ?? '', /invalid/);
  });
});
test('interactive script receives the index of the selected port', {timeout:15000}, async () => {
  await withDir(async dir => {
    await writeFile(join(dir, 'prompt.cjs'), PROMPT_SCRIPT);
    const lines:string[] = [];
    const result = await runAction(action(`"${process.execPath}" prompt.cjs`, {stdin:'{port_index}\n'}), dir, {port:'COM21', baud:115200}, l => lines.push(l));
    assert.equal(result.exitCode, 0);
    assert.ok(lines.includes('Flashing COM21'), lines.join('\n'));
    // An unlisted port must end stdin instead of hanging until the timeout.
    const missing:string[] = [];
    const failed = await runAction(action(`"${process.execPath}" prompt.cjs`, {stdin:'{port_index}\n'}), dir, {port:'COM9', baud:115200}, l => missing.push(l));
    assert.equal(failed.exitCode, 3);
    assert.equal(failed.timedOut, false);
  });
});
test('placeholders expand and non-interactive commands get EOF on stdin', {timeout:15000}, async () => {
  await withDir(async dir => {
    const lines:string[] = [];
    const result = await runAction(action(`"${process.execPath}" -e "console.log(process.argv[1]); process.stdin.resume().on('end',()=>console.log('closed'))" {port}@{baud}`), dir, {port:'COM21', baud:9600}, l => lines.push(l));
    assert.equal(result.exitCode, 0);
    assert.deepEqual(lines, ['COM21@9600', 'closed']);
  });
});
