export function integer(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be ${min}–${max}`);
  return value;
}
function flag(name: string) {
  const value = process.env[name] ?? 'false';
  if (value !== 'true' && value !== 'false') throw new Error(`${name} must be true or false`);
  return value === 'true';
}
export function config() {
  const mock = flag('SERIAL_MOCK');
  const path = process.env.SERIAL_PORT;
  return { mock, path: mock ? 'mock' : (path ?? ''), baudRate: integer('SERIAL_BAUD', 115200, 50, 4000000),
    wsPort: integer('SERIAL_WS_PORT', 0, 0, 65535), capacity: integer('SERIAL_BUFFER_SIZE', 2000, 1, 10000),
    dtr: flag('SERIAL_DTR'), rts: flag('SERIAL_RTS'), uiExecutable: process.env.SERIAL_UI_EXECUTABLE,
    // Claude Code starts stdio MCP servers in the folder it was opened from.
    projectDir: process.env.SERIAL_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd() };
}
