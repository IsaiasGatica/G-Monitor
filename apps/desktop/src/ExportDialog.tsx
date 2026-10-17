import { useEffect, useRef, useState } from 'react';
import { annotationCount, formatLogTime, logRange, type Entry } from './log-format';
import { Icon } from './Icon';

export function ExportDialog({records, onCancel, onAccept}:{records:readonly Entry[]; onCancel:() => void; onAccept:(notes:string) => void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [notes, setNotes] = useState('');
  const range = logRange(records);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog className="export-dialog" ref={dialog} aria-labelledby="export-title" onCancel={onCancel} onClose={onCancel}>
    <form onSubmit={event => {event.preventDefault(); dialog.current?.close(); onAccept(notes);}}>
      <div className="export-heading"><h2 id="export-title">Export log</h2><button type="button" className="window-control" aria-label="Close export" onClick={onCancel}><Icon name="close"/></button></div>
      <div className="export-content">
        <dl className="export-summary">
          <div><dt>Records to export</dt><dd>{records.length}</dd></div>
          <div><dt>Annotations</dt><dd>{annotationCount(records)}</dd></div>
          <div><dt>From</dt><dd>{range ? formatLogTime(range.start) : 'No records'}</dd></div>
          <div><dt>To</dt><dd>{range ? formatLogTime(range.end) : 'No records'}</dd></div>
        </dl>
        <label className="export-notes" htmlFor="export-notes">Notes<textarea autoFocus id="export-notes" placeholder="Add observations about this capture…" value={notes} onChange={event => setNotes(event.target.value)}/></label>
        <p className="export-hint">Exports the records retained when this dialog was opened, including those hidden by filter or pause.</p>
      </div>
      <div className="export-actions"><button type="button" onClick={onCancel}>Cancel</button><button className="export-accept" type="submit">Save</button></div>
    </form>
  </dialog>;
}
