export type Entry = {id:number; timestamp:string; source:'hardware'|'claude'|'user'|'system'; text:string; bytesHex?:string; pauseAfter?:number; annotation?:string};
export type DisplayMode = 'ascii' | 'hex';
export function recordText(record:Entry, mode:DisplayMode = 'ascii') {
  if (mode === 'ascii' || record.source === 'system' || record.pauseAfter !== undefined) return record.text;
  // Older snapshots only contain text; new records always carry original bytes.
  const hex = record.bytesHex ?? Array.from(new TextEncoder().encode(record.text),byte => byte.toString(16).padStart(2,'0')).join('');
  return hex.toUpperCase().match(/.{2}/g)?.join(' ') ?? '';
}
export const sourceLabels = {hardware:'RX', claude:'CLAUDE', user:'TX', system:'SYS'};

export function compareEntries(a:Entry, b:Entry) {
  return (a.pauseAfter ?? a.id) - (b.pauseAfter ?? b.id) ||
    Number(a.pauseAfter !== undefined) - Number(b.pauseAfter !== undefined) || b.id - a.id;
}

export function mergeAnnotatedEntries(records:readonly Entry[], annotated:readonly Entry[]) {
  const entries = new Map(records.map(record => [record.id,record]));
  for (const record of annotated) entries.set(record.id, {...(entries.get(record.id) ?? record), annotation:record.annotation});
  return [...entries.values()].sort(compareEntries);
}

export const annotationCount = (records:readonly Entry[]) => records.filter(record => record.annotation?.trim()).length;

export function formatLog(records:readonly Entry[], mode:DisplayMode = 'ascii') {
  return records.map(record => {
    const line = `[${record.timestamp}] [${sourceLabels[record.source]}] ${recordText(record,mode).replace(/\r?\n$/, '')}`;
    const note = record.annotation?.trim();
    return note ? `${line}\n${note.split(/\r?\n/).map((text,index) => `    ${index === 0 ? '↳ Note: ' : '        '}${text}`).join('\n')}` : line;
  }).join('\n');
}

export function logRange(records:readonly Entry[]) {
  let first = Infinity, last = -Infinity;
  for (const record of records) {
    const time = Date.parse(record.timestamp);
    if (Number.isFinite(time)) {first = Math.min(first,time); last = Math.max(last,time);}
  }
  return first === Infinity ? null : {start:new Date(first), end:new Date(last)};
}

export function formatLogTime(date:Date) {
  return date.toLocaleString('en-GB', {year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23', timeZoneName:'short'});
}

export function logMarkdown(records:readonly Entry[], exportedAt:Date, notes = '', mode:DisplayMode = 'ascii') {
  const text = formatLog(records,mode);
  const range = logRange(records);
  const rangeHeader = range ? `From: ${formatLogTime(range.start)}\n\nTo: ${formatLogTime(range.end)}` : 'No records.';
  // Firmware text may contain Markdown fences; keep every log line inside one code block.
  let longestFence = 2;
  for (const match of text.matchAll(/`+/g)) longestFence = Math.max(longestFence,match[0].length);
  const fence = '`'.repeat(longestFence + 1);
  return `# Serial monitor log\n\nExported: ${exportedAt.toISOString()}\n\nRecords: ${records.length}\n\nAnnotations: ${annotationCount(records)}\n\n## Time range\n\n${rangeHeader}\n\n## Notes\n\n${notes.trim() || 'No notes.'}\n\n## Records\n\n${fence}text\n${text}\n${fence}\n`;
}
