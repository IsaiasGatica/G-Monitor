import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSerialPayload } from './serial-payload.js';

test('HEX sends literal bytes, accepting spaced or compact byte pairs', () => {
  const expected = [0x01,0x03,0x00,0xff,0x80];
  assert.deepEqual([...parseSerialPayload('01 03 00 ff 80','hex')],expected);
  assert.deepEqual([...parseSerialPayload('010300FF80','hex')],expected);
  assert.deepEqual([...parseSerialPayload(' 01\t03\n00 FF 80 ','hex')],expected);
  assert.deepEqual([...parseSerialPayload('FF','hex',true)],[255,10]);
});

test('HEX rejects incomplete bytes and invalid characters instead of truncating them', () => {
  for (const input of ['', ' ', '0', '001', '0 1', 'GG', '0xFF', '01,03', '01-03']) {
    assert.throws(() => parseSerialPayload(input,'hex'),/complete HEX byte pairs/);
  }
});

test('ASCII preserves text encoding and limits count actual wire bytes including LF', () => {
  assert.deepEqual([...parseSerialPayload('é','ascii',true)],[195,169,10]);
  assert.equal(parseSerialPayload('FF'.repeat(4096),'hex').length,4096);
  assert.throws(() => parseSerialPayload('FF'.repeat(4096),'hex',true),/4096/);
  assert.throws(() => parseSerialPayload('FF'.repeat(4097),'hex'),/4096/);
  assert.throws(() => parseSerialPayload('é'.repeat(2049),'ascii'),/4096/);
  assert.throws(() => parseSerialPayload('','ascii'),/1–4096/);
});
