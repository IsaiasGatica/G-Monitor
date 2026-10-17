import { useEffect, useRef, useState } from 'react';
import { agentMessageError } from './agent-message';
import { Icon } from './Icon';
import type { LogCapture } from './LogContextMenu';

export function AgentMessageDialog({capture, disabledReason, onCancel, onSend}:{capture:LogCapture; disabledReason:string; onCancel:() => void; onSend:(message:string) => void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [message, setMessage] = useState('');
  const validation = agentMessageError(message,capture.text);
  const lines = capture.text.replace(/\r?\n$/, '').split(/\r\n|\r|\n/).length;
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog className="export-dialog agent-message-dialog" ref={dialog} aria-labelledby="agent-message-title" onCancel={onCancel} onClose={onCancel}>
    <form onSubmit={event => {event.preventDefault(); if (!validation && !disabledReason) onSend(message);}}>
      <div className="export-heading"><h2 id="agent-message-title">Send to agent</h2><button type="button" className="window-control" aria-label="Close agent message" onClick={onCancel}><Icon name="close"/></button></div>
      <div className="export-content">
        <label className="export-notes" htmlFor="agent-message">Message to agent (optional)<textarea autoFocus id="agent-message" placeholder="What would you like the agent to review or do with this log?" maxLength={4000} value={message} onChange={event => setMessage(event.target.value)} aria-describedby="agent-message-help"/></label>
        <details className="agent-log-preview"><summary>Log information · {lines} {lines === 1 ? 'line' : 'lines'} · {capture.scope === 'selection' ? 'selection' : 'full log'}</summary><pre>{capture.text}</pre></details>
        <p className="export-hint" id="agent-message-help">Click Send to send this log snapshot to the linked chat. You can add a message if needed.</p>
        {(disabledReason || validation) && <p className="tx-error" role="status">{disabledReason || validation}</p>}
      </div>
      <div className="export-actions"><button type="button" onClick={onCancel}>Cancel</button><button className="export-accept" type="submit" disabled={!!validation || !!disabledReason}>Send <Icon name="send"/></button></div>
    </form>
  </dialog>;
}
