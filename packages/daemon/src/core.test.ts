import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineDecoder, RingBuffer, SerialDataDecoder, SerialHub } from './core.js';

test('ring evicts oldest records and filters before selecting tail', () => {
  const ring = new RingBuffer(3);
  for (let id = 1; id <= 5; id++) ring.push({id, timestamp:'', source:'hardware', text:id % 2 ? 'odd':'even'});
  assert.deepEqual(ring.read().map(r => r.id), [3,4,5]);
  assert.deepEqual(ring.read(1,'odd').map(r => r.id), [5]);
});

test('clearing history empties a wrapped ring and keeps record IDs increasing', async () => {
  const hub = new SerialHub(2,async () => {});
  for (let index = 0; index < 5; index++) hub.record('hardware',`old ${index}`);
  hub.buffer.clear();
  assert.deepEqual(hub.buffer.read(),[]);
  const next = hub.record('hardware','new capture');
  assert.equal(next.id,6);
  assert.deepEqual(hub.buffer.read(),[next]);
  await hub.stop();
});
test('Claude and operator writes never overlap; failed write does not poison queue', async () => {
  let active = 0; const sent:string[] = [];
  const hub = new SerialHub(10, async payload => {
    assert.equal(++active, 1);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--; if (payload === 'bad') throw new Error('unplugged'); sent.push(payload.toString());
  });
  const results = await Promise.allSettled([hub.write('a','claude'), hub.write('bad','user'), hub.write('b','user')]);
  assert.equal(results[1].status, 'rejected');
  assert.deepEqual(sent, ['a','b']);
  assert.deepEqual(hub.buffer.read().map(r => r.source), ['claude','user']);
});
test('wait only matches future hardware; timeout and shutdown clean up listeners', async () => {
  const hub = new SerialHub(10, async () => {});
  hub.record('hardware','READY');
  const wait = hub.waitFor('READY',1000);
  hub.record('claude','READY');
  hub.record('hardware','READY now');
  assert.equal((await wait).record?.text, 'READY now');
  assert.equal((await hub.waitFor('missing',5)).reason,'timeout');
  const stopped = hub.waitFor('missing',1000); await hub.stop();
  assert.equal((await stopped).reason,'shutdown');
  assert.equal(hub.listenerCount('record'),0);
  await assert.rejects(hub.write('late','user'));
});
test('line decoder handles CRLF, fragments and caps unterminated lines', () => {
  const output:string[] = []; const decoder = new LineDecoder(line => output.push(line));
  decoder.feed('hello\r'); decoder.feed('\nnext\n' + 'x'.repeat(5000)); decoder.flush();
  assert.deepEqual(output.map(x => x.length), [5,4,4096,904]);
});

test('serial decoder preserves all binary bytes, CRLF and fragmented UTF-8', () => {
  const records:{text:string; hex:string}[] = [];
  const decoder = new SerialDataDecoder((text,hex) => records.push({text,hex}));
  const bytes = Buffer.from([0x01,0x03,0x00,0xff,0x80,0x0d,0x0a,0xc3,0xa9]);
  decoder.feed(bytes.subarray(0,3)); decoder.feed(bytes.subarray(3,8)); decoder.feed(bytes.subarray(8)); decoder.flush(true);
  assert.equal(records.map(record => record.hex).join(''),bytes.toString('hex'));
  assert.equal(records[0].hex,'010300ff800d0a');
  assert.equal(records[1].text,'é');
});

test('serial decoder emits binary frames without newline on idle', async () => {
  let decoder:SerialDataDecoder;
  const result = new Promise<{text:string; hex:string}>(resolve => {
    decoder = new SerialDataDecoder((text,hex) => resolve({text,hex}),5);
    decoder.feed(Buffer.from([0,0x80,0xff]));
  });
  assert.equal((await result).hex,'0080ff');
  decoder!.flush(true);
});

test('serial decoder bounds long streams and flushes pending bytes on close', () => {
  const lengths:number[] = [];
  const decoder = new SerialDataDecoder((_text,hex) => lengths.push(hex.length / 2));
  decoder.feed(Buffer.alloc(9000,0xff)); decoder.flush(true);
  assert.deepEqual(lengths,[4096,4096,808]);
});

test('hub keeps original RX bytes and exact UTF-8 TX bytes', async () => {
  const hub = new SerialHub(10,async () => {});
  const rx = hub.record('hardware','�','ff');
  assert.equal(rx.bytesHex,'ff');
  await hub.write('é\n','user');
  assert.equal(hub.buffer.read().at(-1)?.bytesHex,'c3a90a');
  await hub.stop();
});
