import { useState, type ReactNode } from 'react';
import { recordText, sourceLabels, type DisplayMode, type Entry } from './log-format';
import { Icon } from './Icon';

function NoteEditor({initial, onSave, onCancel}:{initial:string; onSave:(text:string) => void; onCancel:() => void}) {
  const [text, setText] = useState(initial);
  function save() { if (text.trim()) onSave(text.trim()); }
  return <form className="inline-note-editor" onSubmit={event => {event.preventDefault(); save();}} onKeyDown={event => {
    if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); onCancel();}
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {event.preventDefault(); save();}
  }}>
    <label>Record note<textarea autoFocus aria-label="Record note" placeholder="What would you like to note about this log?" value={text} onChange={event => setText(event.target.value)}/></label>
    <div className="inline-note-actions"><span>Ctrl + Enter to save · Esc to cancel</span><button type="button" onClick={onCancel}>Cancel</button><button type="submit" disabled={!text.trim()}>Save note</button></div>
  </form>;
}

export function LogRecord({record, displayMode, editing, highlight, onEdit, onSave, onCancel, onRemove}:{record:Entry; displayMode:DisplayMode; editing:boolean; highlight:(text:string) => ReactNode; onEdit:() => void; onSave:(text:string) => void; onCancel:() => void; onRemove:() => void}) {
  return <div className="log-entry" data-record-id={record.id}>
    <div className={`record ${record.source}`}>
      <time>{new Date(record.timestamp).toLocaleTimeString()}</time><span className="source">{sourceLabels[record.source]}</span>
      <span className="note-action-slot">{!editing && !record.annotation && <button className="add-note" aria-label={`Add note to record ${record.id}`} title="Add note" onClick={onEdit}><Icon name="note"/></button>}</span>
      <pre>{highlight(recordText(record,displayMode))}</pre>
    </div>
    {editing ? <NoteEditor initial={record.annotation ?? ''} onSave={onSave} onCancel={onCancel}/> : record.annotation && <div className="inline-note">
      <div className="inline-note-heading"><span><Icon name="comment"/>Note</span><div><button onClick={onEdit} aria-label={`Edit note for record ${record.id}`}>Edit</button><button onClick={onRemove} aria-label={`Delete note for record ${record.id}`} title="Delete note"><Icon name="trash"/></button></div></div>
      <pre>{record.annotation}</pre>
    </div>}
  </div>;
}
