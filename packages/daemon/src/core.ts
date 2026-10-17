import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

export type Source = 'hardware' | 'claude' | 'user' | 'system';
export interface RecordEntry { id: number; timestamp: string; source: Source; text: string; bytesHex?:string }
export class RingBuffer {
  private entries: Array<RecordEntry | undefined>;
  private count = 0;
  private next = 0;
  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Invalid buffer capacity');
    this.entries = new Array(capacity);
  }
  push(entry: RecordEntry) {
    this.entries[this.next] = entry;
    this.next = (this.next + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
  }
  clear() {
    this.entries.fill(undefined);
    this.count = 0;
    this.next = 0;
  }
  read(lines = 100, filter = ''): RecordEntry[] {
    const result: RecordEntry[] = [];
    for (let i = 0; i < this.count; i++) {
      const entry = this.entries[(this.next - this.count + i + this.capacity) % this.capacity]!;
      if (!filter || entry.text.includes(filter)) result.push(entry);
    }
    return result.slice(-Math.max(1, Math.min(lines, 500)));
  }
}

export class SerialHub extends EventEmitter {
  readonly buffer: RingBuffer;
  private sequence = 0;
  private queue: Promise<void> = Promise.resolve();
  private pendingWrites = 0;
  private stopped = false;
  private waiters = 0;
  // Set while a long exclusive task (firmware upload) owns the port: reject instead of queueing behind it.
  blocked = '';
  constructor(capacity: number, private send: (payload: string | Buffer) => Promise<void>) {
    super();
    this.setMaxListeners(100);
    this.buffer = new RingBuffer(capacity);
  }
  record(source: Source, text: string, bytesHex?:string) {
    const entry:RecordEntry = { id: ++this.sequence, timestamp: new Date().toISOString(), source, text: text.slice(0, 4096),
      ...(bytesHex !== undefined ? {bytesHex} : source !== 'system' ? {bytesHex:Buffer.from(text).toString('hex')} : {}) };
    this.buffer.push(entry);
    this.emit('record', entry);
    return entry;
  }
  write(payload: string | Buffer, source: 'claude' | 'user') {
    if (!payload.length || Buffer.byteLength(payload) > 4096) return Promise.reject(new Error('Payload must be 1–4096 bytes'));
    return this.runExclusive(async () => {
      await this.send(payload);
      this.record(source, payload.toString(), Buffer.isBuffer(payload) ? payload.toString('hex') : undefined);
    });
  }
  runExclusive<T>(action: () => Promise<T>, options:{cleanup?:boolean} = {}): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Daemon is stopping'));
    // Lifecycle cleanup must still enqueue behind an upload or a full TX queue.
    if (this.blocked && !options.cleanup) return Promise.reject(new Error(this.blocked));
    if (this.pendingWrites >= 64 && !options.cleanup) return Promise.reject(new Error('Write queue full'));
    this.pendingWrites++;
    const task = this.queue.then(async () => {
      if (this.stopped) throw new Error('Daemon is stopping');
      return await action();
    }).finally(() => { this.pendingWrites--; });
    this.queue = task.then(() => {}, () => {});
    return task;
  }
  waitFor(pattern: string, timeoutMs: number): Promise<{ matched: boolean; record?: RecordEntry; reason?: string }> {
    if (this.stopped) return Promise.resolve({ matched: false, reason: 'shutdown' });
    if (!pattern || pattern.length > 512 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Invalid wait parameters');
    if (this.waiters >= 32) throw new Error('Too many pending waits');
    this.waiters++;
    return new Promise(resolve => {
      const finish = (result: { matched: boolean; record?: RecordEntry; reason?: string }) => {
        clearTimeout(timer);
        this.off('record', listener);
        this.off('stop', stop);
        this.waiters--;
        resolve(result);
      };
      const listener = (record: RecordEntry) => {
        if (record.source === 'hardware' && record.text.includes(pattern)) finish({ matched: true, record });
      };
      const stop = () => finish({ matched: false, reason: 'shutdown' });
      const timer = setTimeout(() => finish({ matched: false, reason: 'timeout' }), timeoutMs);
      this.on('record', listener);
      this.on('stop', stop);
    });
  }
  async stop() { this.stopped = true; this.emit('stop'); await this.queue; }
}

// Bounds partial lines too, so a device without newline cannot grow memory indefinitely.
export class LineDecoder {
  private partial = '';
  constructor(private emit: (line: string) => void) {}
  feed(text: string) {
    for (const char of text) {
      if (char === '\n') { this.emit(this.partial.replace(/\r$/, '')); this.partial = ''; }
      else {
        this.partial += char;
        if (this.partial.length >= 4096) { this.emit(this.partial); this.partial = ''; }
      }
    }
  }
  flush() { if (this.partial) { this.emit(this.partial); this.partial = ''; } }
}

// Preserve wire bytes (including CR/LF and invalid UTF-8) alongside readable text.
// Flush idle data too: binary protocols need not include a newline.
export class SerialDataDecoder {
  private partial:number[] = [];
  private decoder = new StringDecoder('utf8');
  private timer?:NodeJS.Timeout;
  constructor(private emit:(text:string, bytesHex:string) => void, private idleMs = 30) {}
  feed(data:Buffer) {
    clearTimeout(this.timer);
    for (const byte of data) {
      this.partial.push(byte);
      if (byte === 10 || this.partial.length >= 4096) this.flush();
    }
    if (this.partial.length) this.timer = setTimeout(() => this.flush(),this.idleMs);
  }
  flush(final = false) {
    clearTimeout(this.timer); this.timer = undefined;
    const bytes = Buffer.from(this.partial); this.partial = [];
    const text = this.decoder.write(bytes) + (final ? this.decoder.end() : '');
    if (bytes.length || text) this.emit(text.replace(/\r?\n$/, ''),bytes.toString('hex'));
  }
}
