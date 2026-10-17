import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLog, logMarkdown, recordText, type Entry } from '../src/log-format';

const rx:Entry = {id:1,timestamp:'2026-10-13T12:00:00.000Z',source:'hardware',text:'\u0001\u0003\u0000��',bytesHex:'010300ff800d0a',annotation:'Modbus frame'};

test('hex view uses original bytes including invalid UTF-8 and CRLF', () => {
  assert.equal(recordText(rx,'ascii'),rx.text);
  assert.equal(recordText(rx,'hex'),'01 03 00 FF 80 0D 0A');
  assert.equal(recordText(rx,'ascii'),rx.text);
});

test('system messages and notes remain readable in hexadecimal copies and exports', () => {
  const sys:Entry = {...rx,id:2,source:'system',text:'Port closed',annotation:undefined};
  const copied = formatLog([rx,sys],'hex');
  assert.match(copied,/01 03 00 FF 80 0D 0A/);
  assert.match(copied,/Note: Modbus frame/);
  assert.match(copied,/\[SYS\] Port closed/);
  assert.match(logMarkdown([rx],new Date(rx.timestamp),'','hex'),/01 03 00 FF 80 0D 0A/);
});

test('legacy records fall back to encoding their available text', () => {
  assert.equal(recordText({...rx,bytesHex:undefined,text:'A\n'},'hex'),'41 0A');
  assert.equal(recordText({...rx,bytesHex:'',text:''},'hex'),'');
});
