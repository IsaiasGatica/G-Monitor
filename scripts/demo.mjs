import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const hardware = process.argv.includes('--hardware');
const executable = join(root, 'apps/desktop/src-tauri/target/release', process.platform === 'win32' ? 'serial-monitor.exe' : 'serial-monitor');
const daemonFile = join(root, 'packages/daemon/dist/index.js');
if (!existsSync(executable) || !existsSync(daemonFile)) {
  console.error('Primero ejecutá npm run build y npm run build:desktop.');
  process.exit(1);
}
const daemon = spawn(process.execPath, [daemonFile], {
  env: { ...process.env, SERIAL_MOCK: hardware ? 'false' : 'true', SERIAL_PORT: '', SERIAL_WS_PORT: '0' },
  stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
});
let gui;
let closing = false;
let forceExit;
const startup = setTimeout(() => { console.error('El daemon no inició a tiempo.'); stop(); }, 15000);
function stop() {
  if (closing) return;
  closing = true;
  clearTimeout(startup);
  gui?.kill();
  daemon.stdin.end();
  forceExit = setTimeout(() => daemon.kill(), 3000);
}
let stderr = '';
daemon.stdout.resume(); // stdout is reserved for MCP, unused in this visual demo.
daemon.stderr.on('data', chunk => {
  process.stderr.write(chunk);
  stderr = (stderr + chunk.toString()).slice(-8192);
  const match = stderr.match(/Session file: (.+)\r?\n/);
  if (!match || gui || closing) return;
  clearTimeout(startup);
  gui = spawn(executable, [], {
    env: { ...process.env, SERIAL_MONITOR_SESSION: match[1].trim() },
    stdio: 'ignore', windowsHide: true
  });
  gui.on('error', error => { console.error(error.message); stop(); });
  gui.on('exit', stop);
  console.log(hardware ? 'Monitor abierto. Seleccioná un COM y pulsá Abrir.' : 'Monitor abierto en modo simulado. Cerrá la ventana para terminar la demo.');
});
daemon.on('error', error => { console.error(error.message); stop(); process.exitCode = 1; });
daemon.on('exit', code => {
  clearTimeout(startup); clearTimeout(forceExit); gui?.kill();
  if (code) process.exitCode = code;
});
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
