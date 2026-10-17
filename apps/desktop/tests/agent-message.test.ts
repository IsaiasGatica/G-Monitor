import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentMessageError, formatAgentMessage, MAX_AGENT_MESSAGE_BYTES } from '../src/agent-message';

test('message and captured log are separated without changing log bytes or whitespace', () => {
  const log = ' [12:00:00] [RX] 01 03 FF\r\n note `literal` $(literal)\n';
  assert.equal(formatAgentMessage('  Revisá esta trama  ',log),`Mensaje para agente:\nRevisá esta trama\n\nInformación del log:\n${log}`);
  assert.equal(agentMessageError('Revisá esta trama',log),'');
});

test('captured log can be sent without an additional message', () => {
  const log = ' [RX] 01 03 FF\r\n';
  for (const message of ['', ' \n']) {
    assert.equal(agentMessageError(message,log),'');
    assert.equal(formatAgentMessage(message,log),`Información del log:\n${log}`);
  }
  assert.match(agentMessageError(' \n',' \r\n'),/There is no content/);
});

test('combined UTF-8 size is validated with and without a message', () => {
  for (const message of ['á', '']) {
    const headerBytes = new TextEncoder().encode(formatAgentMessage(message,'')).length;
    const log = 'x'.repeat(MAX_AGENT_MESSAGE_BYTES - headerBytes);
    assert.equal(agentMessageError(message,log),'');
    assert.match(agentMessageError(message,log+'x'),/exceed 1 MiB/);
  }
});
