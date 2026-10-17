import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import './style.css';
import { annotationCount, compareEntries, formatLog, logMarkdown, mergeAnnotatedEntries, recordText, type DisplayMode, type Entry } from './log-format';
import { SettingsSidebar } from './SettingsSidebar';
import { AgentsSidebar } from './AgentsSidebar';
import { Icon } from './Icon';
import { useFontSizes } from './font-settings';
import { useKeywords } from './keyword-settings';
import { useThemeColors } from './theme-settings';
import { matchesTrigger, useTrigger } from './trigger-settings';
import { ExportDialog } from './ExportDialog';
import { AgentMessageDialog } from './AgentMessageDialog';
import { agentMessageError, formatAgentMessage } from './agent-message';
import { LogRecord } from './LogRecord';
import { MonitorTypewriter } from './MonitorTypewriter';
import { LogContextMenu, type LogCapture } from './LogContextMenu';
import type { IntegrationInfo } from './IntegrationSettings';
import { parseSerialPayload, type TxEncoding } from '../../../packages/daemon/src/serial-payload';
import { useSerialSettings } from './serial-settings';
import {serialFormatLabel,type SerialFormat} from '../../../packages/daemon/src/serial-format';

type Session = {protocolVersion:number; wsUrl:string; token:string};
type Status = {monitorId?:string;parentMonitorId?:string;port:string; baudRate:number; serialFormat?:SerialFormat; connected:boolean; mock:boolean; busy:boolean; action?:string; agent?:{type:'codex'|'claude_code'|'antigravity'; threadId?:string; bindingId:string}|null; selection?:{port:string; baudRate:number; revision:number}};
type PortInfo = {path:string; manufacturer?:string};
type Project = {dir:string; source:'file'|'default'|'none'; actions:{label:string; command:string}[]; error?:string};
type ActionResult = {ok:boolean; exitCode:number|null; timedOut:boolean; seconds:number};

function App() {
  const [themeColors, setThemeColors] = useThemeColors();
  const {keywords, setKeywords, highlight} = useKeywords();
  const [fontSizes, setFontSizes] = useFontSizes();
  const [trigger, setTrigger] = useTrigger();
  const triggerRef = useRef(trigger);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [integrations,setIntegrations]=useState<IntegrationInfo>();
  const [integrationBusy,setIntegrationBusy]=useState(false);
  const integrationPending=useRef<string|null>(null);
  const [newMonitorBusy,setNewMonitorBusy]=useState(false);
  const newMonitorPending=useRef<string|null>(null);
  const [records, setRecords] = useState<Entry[]>([]);
  const [annotated, setAnnotated] = useState<Map<number,Entry>>(() => new Map());
  const [editingRecord, setEditingRecord] = useState<Entry | null>(null);
  const editingNote = useRef(false);
  const displayedRecords = useMemo(() => {
    const merged = mergeAnnotatedEntries(records,[...annotated.values()]);
    // Keep a draft's anchor visible even if it leaves the ring before the user saves.
    if (editingRecord && !merged.some(record => record.id === editingRecord.id)) merged.push(editingRecord);
    return merged.sort(compareEntries);
  }, [records, annotated, editingRecord]);
  const [status, setStatus] = useState<Status>();
  const [online, setOnline] = useState(false);
  const [error, setError] = useState('');
  const [paused, setPaused] = useState(false);
  const [pauseTrigger, setPauseTrigger] = useState('');
  const [filter, setFilter] = useState('');
  const [displayMode, setDisplayMode] = useState<DisplayMode>('ascii');
  const [payload, setPayload] = useState('');
  const [newline, setNewline] = useState(true);
  const [txEncoding, setTxEncoding] = useState<TxEncoding>('ascii');
  const [hexNewline, setHexNewline] = useState(false);
  const appendLF = txEncoding === 'hex' ? hexNewline : newline;
  const txError = useMemo(() => {
    if (!payload) return '';
    try { parseSerialPayload(payload,txEncoding,appendLF); return ''; }
    catch (error) { return String((error as Error).message); }
  }, [payload,txEncoding,appendLF]);
  const [sending, setSending] = useState(false);
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [selectedPort, setSelectedPort] = useState('');
  const launchSelection = useRef<Status['selection']>(undefined);
  const [baudRate, setBaudRate] = useState(115200);
  const [serialFormat,setSerialFormat] = useSerialSettings();
  const [portBusy, setPortBusy] = useState(false);
  const portPending = useRef<{id:string; timer:ReturnType<typeof setTimeout>} | null>(null);
  const [project, setProject] = useState<Project>();
  const [selectingFolder, setSelectingFolder] = useState(false);
  // Uploads can take minutes, so these requests have no client timeout; the daemon enforces timeout_s.
  const projectPending = useRef<{id:string; label?:string} | null>(null);
  const [runningLabel, setRunningLabel] = useState('');
  const [copying, setCopying] = useState(false);
  const [logMenu, setLogMenu] = useState<LogCapture | null>(null);
  const [agentDraft, setAgentDraft] = useState<LogCapture | null>(null);
  const menuOpen = useRef(false);
  const [agentNotice, setAgentNotice] = useState('');
  const [agentSending, setAgentSending] = useState(false);
  const agentPending = useRef<{id:string; timer:ReturnType<typeof setTimeout>} | null>(null);
  const [copyLabel, setCopyLabel] = useState('Copy all');
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [exporting, setExporting] = useState(false);
  const [exportDraft, setExportDraft] = useState<Entry[] | null>(null);
  const exportMode = useRef<DisplayMode>('ascii');
  const [exportLabel, setExportLabel] = useState('Export');
  const [exportPath, setExportPath] = useState('');
  const exportTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const socket = useRef<WebSocket | null>(null);
  const pending = useRef<{id:string; timer:ReturnType<typeof setTimeout>} | null>(null);
  const logViewport = useRef<HTMLDivElement>(null);
  const followLog = useRef(true);
  const [showGoToEnd, setShowGoToEnd] = useState(false);
  const pausedRef = useRef(false);
  const live = useRef<Entry[]>([]);
  const pauseId = useRef(0);
  const clearedThrough = useRef(0);
  const hasSnapshot = useRef(false);
  useEffect(() => {
    if (!agentNotice || agentSending) return;
    const timer = setTimeout(() => setAgentNotice(''),5000);
    return () => clearTimeout(timer);
  }, [agentNotice,agentSending]);
  useEffect(() => () => { clearTimeout(copyTimer.current); clearTimeout(exportTimer.current); }, []);
  useEffect(() => {
    let disposed = false;
    let retry:ReturnType<typeof setTimeout> | undefined;
    let frame:number | undefined;
    let current:WebSocket | undefined;
    const render = () => {
      if (frame !== undefined || pausedRef.current) return;
      frame = requestAnimationFrame(() => { frame = undefined; if (!disposed && !pausedRef.current) setRecords([...live.current]); });
    };
    const clearPending = () => {
      integrationPending.current=null;setIntegrationBusy(false);
      if (agentPending.current) {
        clearTimeout(agentPending.current.timer); agentPending.current = null; setAgentSending(false);
        setError('Se perdió la conexión durante el envío. Comprobá el chat antes de volver a enviar.');
      }
      if (pending.current) clearTimeout(pending.current.timer); pending.current = null; setSending(false);
      if (portPending.current) clearTimeout(portPending.current.timer); portPending.current = null; setPortBusy(false);
      projectPending.current = null; setRunningLabel('');
    };
    const receiveStatus = (next:Status) => {
      if(next.monitorId) void getCurrentWindow().setTitle(`G Monitor · ${next.monitorId.slice(0,8)}`).catch(()=>{});
      if (next.selection && next.selection.revision !== launchSelection.current?.revision) {
        launchSelection.current = next.selection;
        if (!next.connected) { setSelectedPort(next.selection.port); setBaudRate(next.selection.baudRate); }
      }
      setStatus(next);
    };
    async function connect() {
      try {
        const session = await invoke<Session>('session');
        if (disposed) return;
        current = new WebSocket(`${session.wsUrl}/?token=${encodeURIComponent(session.token)}`);
        socket.current = current;
        current.onopen = () => {
          current!.send(JSON.stringify({type:'ui_attached',requestId:crypto.randomUUID()}));
          current!.send(JSON.stringify({type:'integration_info',requestId:crypto.randomUUID()}));
          setOnline(true); setError('');
        };
        current.onmessage = event => {
          const msg = JSON.parse(event.data);
          if (msg.type === 'snapshot') {
            hasSnapshot.current = true;
            const incoming:Entry[] = msg.records.filter((record:Entry) => record.id > clearedThrough.current);
            // UI pause markers stay between the same daemon records after reconnecting.
            const markers = live.current.filter(record => record.pauseAfter !== undefined && record.pauseAfter >= (incoming[0]?.id ?? 1) - 1);
            live.current = [...incoming, ...markers].sort(compareEntries).slice(-2000);
            receiveStatus(msg.status); render(); control('list_ports'); projectRequest();
          }
          if (msg.type === 'record' && msg.record.id > clearedThrough.current) {
            live.current = [...live.current, msg.record].slice(-2000);
            if (!pausedRef.current && matchesTrigger(msg.record.text, triggerRef.current)) pause(triggerRef.current);
            render();
          }
          if (msg.type === 'status') receiveStatus(msg.status);
          if (msg.type === 'project') setProject(msg.project);
          if (msg.type === 'result' && msg.integrations) setIntegrations(msg.integrations);
          if (msg.type === 'result' && integrationPending.current === msg.requestId) {
            integrationPending.current=null;setIntegrationBusy(false);
            if (!msg.ok) setError(msg.error ?? 'No se pudo configurar la integración.');
          }
          if (msg.type === 'result' && agentPending.current && agentPending.current.id === msg.requestId) {
            clearTimeout(agentPending.current.timer); agentPending.current = null; setAgentSending(false);
            if (msg.ok) setAgentNotice('Enviado al chat vinculado ✓');
            else {setAgentNotice(''); setError(msg.error ?? 'No se pudo enviar al chat.');}
          }
          if (msg.type === 'result' && pending.current && pending.current.id === msg.requestId) {
            clearTimeout(pending.current.timer); pending.current = null; setSending(false);
            if (!msg.ok) setError(msg.error ?? 'Could not send');
          }
          if (msg.type === 'result' && portPending.current && portPending.current.id === msg.requestId) {
            clearTimeout(portPending.current.timer); portPending.current = null; setPortBusy(false);
            if (!msg.ok) setError(msg.error ?? 'Could not change the port');
            else if (msg.ports) {
              setPorts(msg.ports);
              // A configured COM may be temporarily disconnected; keep it rather than pick another board.
              setSelectedPort(current => current && (msg.ports.some((port:PortInfo) => port.path === current) || current === launchSelection.current?.port) ? current : '');
            }
          }
          if (msg.type === 'result' && projectPending.current && projectPending.current.id === msg.requestId) {
            const label = projectPending.current.label;
            projectPending.current = null; setRunningLabel('');
            if (!msg.ok) setError(msg.error ?? 'Could not run the action');
            if (msg.project) setProject(msg.project);
            const result:ActionResult | undefined = msg.action;
            if (label && result && !result.ok) setError(`${label} failed (${result.timedOut ? 'timed out' : `exit code ${result.exitCode}`}). Check the log.`);
          }
          if(msg.type==='result' && msg.requestId===newMonitorPending.current) {
            newMonitorPending.current=null;setNewMonitorBusy(false);
            if(!msg.ok)setError(msg.error ?? 'Could not open another monitor');
          }
          if (msg.type === 'shutdown') void getCurrentWindow().close();
        };
        current.onclose = event => {
          newMonitorPending.current=null;setNewMonitorBusy(false);
          setOnline(false); clearPending();
          if (!disposed) {
            if (event.code === 1008) { setError('Session rejected. Open the window through serial_open_ui.'); return; }
            setError('Daemon disconnected. Retrying…'); retry = setTimeout(() => void connect(), 1500);
          }
        };
        current.onerror = () => setError('Could not connect to the daemon');
      } catch (err) { if (!disposed) setError(String(err)); }
    }
    void connect();
    return () => { disposed = true; clearTimeout(retry); if (frame !== undefined) cancelAnimationFrame(frame); current?.close(); clearPending(); };
  }, []);
  function updateLogViewport() {
    const viewport = logViewport.current;
    if (!viewport) return;
    if (followLog.current && !pausedRef.current && !editingNote.current && !menuOpen.current) viewport.scrollTop = viewport.scrollHeight;
    setShowGoToEnd(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 4);
  }
  function configureAgents(options:{codex:boolean;claude:boolean;antigravity?:boolean}) {
    if (integrationPending.current || socket.current?.readyState !== WebSocket.OPEN) return;
    const id=crypto.randomUUID();integrationPending.current=id;setIntegrationBusy(true);setError('');
    socket.current.send(JSON.stringify({type:'configure_integrations',requestId:id,...options}));
  }
  function openNewMonitor() {
    if(newMonitorPending.current || socket.current?.readyState!==WebSocket.OPEN)return;
    const id=crypto.randomUUID();newMonitorPending.current=id;setNewMonitorBusy(true);setError('');
    socket.current.send(JSON.stringify({type:'new_monitor',requestId:id}));
  }
  useLayoutEffect(updateLogViewport, [displayedRecords, paused, filter, fontSizes, displayMode]);
  useEffect(() => {
    const observer = new ResizeObserver(updateLogViewport);
    if (logViewport.current) observer.observe(logViewport.current);
    return () => observer.disconnect();
  }, []);
  function handleLogScroll() {
    const viewport = logViewport.current;
    if (!viewport) return;
    const atEnd = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 4;
    followLog.current = atEnd && !editingNote.current;
    setShowGoToEnd(!atEnd);
  }
  function goToEnd() {
    followLog.current = true;
    const viewport = logViewport.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
    setShowGoToEnd(false);
  }
  useEffect(() => {
    if (status?.connected) { setSelectedPort(status.port); setBaudRate(status.baudRate); if(status.serialFormat) setSerialFormat(status.serialFormat); }
  }, [status]);
  function control(type:'list_ports'|'open'|'close'|'reset_esp32') {
    if (portPending.current || socket.current?.readyState !== WebSocket.OPEN) return;
    const id = crypto.randomUUID(); setError(''); setPortBusy(true);
    portPending.current = {id, timer:setTimeout(() => {
      portPending.current = null; setPortBusy(false); setError('The port operation did not respond. Check its status before retrying.');
    },15000)};
    socket.current.send(JSON.stringify({type, requestId:id, ...(type === 'open' ? {port:selectedPort,baudRate,...serialFormat}: {})}));
  }
  const busyAction = runningLabel || status?.action || '';
  // The port in use, or the one chosen in the selector when closed: never a fixed COM.
  const actionPort = status?.connected ? status.port : selectedPort;
  function projectRequest(label?:string, dir?:string) {
    if (projectPending.current || socket.current?.readyState !== WebSocket.OPEN) return;
    const id = crypto.randomUUID(); setError('');
    projectPending.current = {id, label};
    if (label) { setRunningLabel(label); followLog.current = true; }
    socket.current.send(JSON.stringify(dir ? {type:'set_project', requestId:id, dir} : label ? {type:'run_action', requestId:id, label, port:actionPort} : {type:'project', requestId:id}));
  }
  async function chooseProjectFolder() {
    if (selectingFolder || projectPending.current || !online || busyAction || status?.busy) return;
    setSelectingFolder(true); setError('');
    try {
      const dir = await invoke<string | null>('select_project_folder', {currentDir:project?.dir ?? null});
      if (dir) {
        if (socket.current?.readyState !== WebSocket.OPEN) throw new Error('Daemon disconnected. Try selecting the folder again once connected.');
        projectRequest(undefined, dir);
      }
    } catch (err) {
      setError(`Could not select the project folder: ${String(err)}`);
    } finally { setSelectingFolder(false); }
  }
  function updateTrigger(value:string) {
    triggerRef.current = value;
    setTrigger(value);
  }
  function pause(matchedTrigger = '') {
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
    setPauseTrigger(pausedRef.current ? matchedTrigger : '');
    if (pausedRef.current) {
      const after = live.current.reduce((latest,record) => Math.max(latest,record.id), clearedThrough.current);
      live.current = [...live.current, {id:--pauseId.current, timestamp:new Date().toISOString(), source:'system' as const, text:'──── Paused ────', pauseAfter:after}].slice(-2000);
    }
    setRecords([...live.current]);
  }
  function clearLog() {
    finishNoteEdit();
    setAnnotated(new Map());
    followLog.current = true;
    setShowGoToEnd(false);
    clearedThrough.current = live.current.reduce((latest,record) => Math.max(latest,record.id), clearedThrough.current);
    live.current = [];
    setRecords([]);
  }
  function editNote(record:Entry) {
    editingNote.current = true;
    followLog.current = false;
    setEditingRecord(record);
  }
  function finishNoteEdit() {
    editingNote.current = false;
    setEditingRecord(null);
  }
  function saveNote(text:string) {
    if (!editingRecord || !text.trim()) return;
    const record = {...editingRecord, annotation:text.trim()};
    setAnnotated(current => new Map(current).set(record.id,record));
    finishNoteEdit();
  }
  function removeNote(id:number) {
    setAnnotated(current => {const next = new Map(current); next.delete(id); return next;});
  }
  function logSnapshot() {
    return mergeAnnotatedEntries(live.current,[...annotated.values()]);
  }
  function closeLogMenu() { menuOpen.current = false; setLogMenu(null); }
  function openLogMenu(event:React.MouseEvent<HTMLDivElement>) {
    // Keep the native editing menu in note inputs.
    if ((event.target as HTMLElement).closest('textarea,input,button')) return;
    event.preventDefault();
    const selection = window.getSelection();
    const withinLog = selection && !selection.isCollapsed && selection.anchorNode && selection.focusNode && event.currentTarget.contains(selection.anchorNode) && event.currentTarget.contains(selection.focusNode);
    const selected = withinLog ? selection.toString() : '';
    menuOpen.current = true;
    setLogMenu({x:event.clientX,y:event.clientY,text:selected || formatLog(logSnapshot(),displayMode),scope:selected ? 'selection':'all',bindingId:status?.agent?.bindingId,threadId:status?.agent?.threadId,agentType:status?.agent?.type});
  }
  async function copyCapturedLog() {
    if (!logMenu) return;
    const text = logMenu.text; closeLogMenu();
    try { await writeText(text); setAgentNotice('Copiado ✓'); }
    catch (err) {setError(`No se pudo copiar: ${String(err)}`);}
  }
  function sendCapturedLog() {
    if (!logMenu || !logMenu.bindingId || agentPending.current || socket.current?.readyState !== WebSocket.OPEN) return;
    const capture = logMenu; closeLogMenu(); setAgentDraft(capture);
  }
  function sendAgentMessage(message:string) {
    if (!agentDraft || agentPending.current || socket.current?.readyState !== WebSocket.OPEN) return;
    if (!agentDraft.bindingId || agentDraft.bindingId !== status?.agent?.bindingId) {setError('Cambió el chat vinculado. Volvé a seleccionar el log.'); return;}
    const validation = agentMessageError(message,agentDraft.text);
    if (validation) {setError(validation); return;}
    const capture = agentDraft;
    const text = formatAgentMessage(message,capture.text);
    setAgentDraft(null); setError(''); setAgentNotice('Enviando al chat vinculado…'); setAgentSending(true);
    const id = crypto.randomUUID();
    agentPending.current = {id,timer:setTimeout(() => {
      agentPending.current = null; setAgentSending(false); setAgentNotice('');
      setError('No se pudo confirmar la entrega. Comprobá el chat antes de volver a enviar.');
    },35000)};
    socket.current.send(JSON.stringify({type:'send_to_agent',requestId:id,text,scope:capture.scope,bindingId:capture.bindingId}));
  }
  async function copyAll() {
    if (copying) return;
    clearTimeout(copyTimer.current);
    const snapshot = logSnapshot();
    if (!snapshot.length) {
      setCopyLabel('No records');
      copyTimer.current = setTimeout(() => setCopyLabel('Copy all'), 2500);
      return;
    }
    const text = formatLog(snapshot,displayMode);
    setCopying(true);
    try {
      await writeText(text);
      setCopyLabel(`Copied (${snapshot.length})`);
    } catch (err) {
      setCopyLabel('Copy all');
      setError(`Could not copy to clipboard: ${String(err)}`);
    } finally {
      setCopying(false);
      copyTimer.current = setTimeout(() => setCopyLabel('Copy all'), 2500);
    }
  }
  function exportAll() {
    if (exporting || exportDraft !== null) return;
    exportMode.current = displayMode;
    setExportDraft(logSnapshot());
  }
  async function saveExport(notes:string) {
    if (exporting || exportDraft === null) return;
    clearTimeout(exportTimer.current);
    // Keep the reviewed snapshot stable while RX continues and the user chooses a file.
    const snapshot = exportDraft;
    setExportDraft(null);
    const now = new Date();
    const content = logMarkdown(snapshot,now,notes,exportMode.current);
    const part = (number:number) => String(number).padStart(2,'0');
    const defaultName = `serial-log-${now.getFullYear()}-${part(now.getMonth()+1)}-${part(now.getDate())}_${part(now.getHours())}-${part(now.getMinutes())}-${part(now.getSeconds())}.md`;
    setExporting(true); setExportLabel('Export');
    try {
      const path = await invoke<string | null>('export_log',{content,defaultName});
      if (path) { setExportPath(path); setExportLabel('Exported ✓'); }
    } catch (err) {
      setError(`Could not export the log: ${String(err)}`);
    } finally {
      setExporting(false);
      exportTimer.current = setTimeout(() => setExportLabel('Export'),3000);
    }
  }
  function send(event:React.FormEvent) {
    event.preventDefault();
    if (!payload || txError || socket.current?.readyState !== WebSocket.OPEN || sending || !status?.connected || busyAction) return;
    const id = crypto.randomUUID();
    setError(''); setSending(true);
    pending.current = {id, timer:setTimeout(() => { pending.current = null; setSending(false); setError('TX was not acknowledged: check the log before sending again.'); }, 10000)};
    socket.current.send(JSON.stringify({type:'write', requestId:id, payload, encoding:txEncoding, appendNewline:appendLF}));
  }
  return <main>
    <header className="app-header">
      <div className="brand" onMouseDown={event => {if(event.button === 0) void getCurrentWindow().startDragging();}}><span className="brand-mark"><Icon name="terminal"/></span><div><strong>G Monitor</strong><span className="brand-caption">SERIAL MONITOR - DEBUG</span></div></div>
      <button className="window-control" title={newMonitorBusy ? 'Abriendo monitor…':'Nuevo monitor'} aria-label="Nuevo monitor" aria-busy={newMonitorBusy} disabled={!online || newMonitorBusy} onClick={openNewMonitor}><Icon name="plus"/></button>
      <button className="window-control" title="Agent settings" aria-label="Agent settings" aria-haspopup="dialog" aria-controls="agents-sidebar" aria-expanded={agentsOpen} onClick={() => {setSettingsOpen(false); setAgentsOpen(true);}}><Icon name="robot"/></button>
      <button className="window-control" title="Settings" aria-label="Settings" aria-haspopup="dialog" aria-controls="settings-sidebar" aria-expanded={settingsOpen} onClick={() => {setAgentsOpen(false); setSettingsOpen(true);}}><Icon name="settings"/></button>
      <button className="window-control" title="Minimize" aria-label="Minimize" onClick={() => void getCurrentWindow().minimize()}><Icon name="minus"/></button>
      <button className="window-control" title="Close window" aria-label="Close window" onClick={() => void getCurrentWindow().close()}><Icon name="close"/></button>
    </header>
    <SettingsSidebar open={settingsOpen} onClose={() => setSettingsOpen(false)} fontSizes={fontSizes} onFontSizesChange={setFontSizes} keywords={keywords} onKeywordsChange={setKeywords} themeColors={themeColors} onThemeColorsChange={setThemeColors} trigger={trigger} onTriggerChange={updateTrigger} serialFormat={serialFormat} onSerialFormatChange={setSerialFormat} serialDisabled={!!status?.connected || portBusy || !!status?.busy || !!busyAction}/>
    <AgentsSidebar open={agentsOpen} onClose={() => setAgentsOpen(false)} integrations={integrations} integrationBusy={integrationBusy} onConfigure={configureAgents}/>
    {exportDraft !== null && <ExportDialog records={exportDraft} onCancel={() => setExportDraft(null)} onAccept={notes => void saveExport(notes)}/>}
    <section className="port-controls">
      <label className="field port-field"><span>Serial port</span><select aria-label="COM port" value={selectedPort} onChange={e => setSelectedPort(e.target.value)} disabled={!online || status?.connected || portBusy || status?.busy}>
        <option value="" disabled>Select COM…</option>
        {ports.map(port => <option key={port.path} value={port.path}>{port.path === 'mock' ? 'Simulated' : port.path}{port.path !== 'mock' && port.manufacturer ? ` · ${port.manufacturer}`:''}</option>)}
        {selectedPort && !ports.some(port => port.path === selectedPort) && <option value={selectedPort}>{selectedPort} · unavailable</option>}
      </select></label>
      <button aria-label="Refresh COM ports" title="Refresh available ports" onClick={() => control('list_ports')} disabled={!online || portBusy || status?.busy}><Icon name="refresh"/></button>
      <label className="field baud-field"><span>Baud rate</span><input type="number" aria-label="Baud rate" title="Baud rate" min={50} max={4000000} value={baudRate} onChange={e => setBaudRate(Number(e.target.value))} disabled={status?.connected || portBusy || status?.busy}/></label>
      <button onClick={() => control('open')} disabled={!online || !selectedPort || status?.connected || portBusy || status?.busy || !!busyAction || !Number.isInteger(baudRate) || baudRate < 50 || baudRate > 4000000}>Open</button>
      <button onClick={() => control('close')} disabled={!online || !status?.connected || portBusy || status?.busy || !!busyAction}>Close</button>
      <button onClick={() => control('reset_esp32')} title="Restart ESP32 firmware through USB-UART auto-reset" disabled={!online || !status?.connected || portBusy || status?.busy || !!busyAction}>Reset</button>
    </section>
    <section className="project-bar" aria-label="Project actions">
      <span className="project-path" title={project?.dir}>
        <button className="project-folder" aria-label="Choose project folder" title="Choose project folder" onClick={() => void chooseProjectFolder()} disabled={!online || selectingFolder || !!busyAction || portBusy || status?.busy}><Icon name="folder"/></button>
        <span>{project ? project.dir.split(/[\\/]/).filter(Boolean).pop() ?? project.dir : 'Choose project folder'}</span>
      </span>
      {project && <div className="project-actions">
        {project.actions.map(action => <button key={action.label} title={actionPort && actionPort !== 'mock' ? `${action.command}\nUses ${actionPort}: releases it, runs in ${project.dir}, then reopens it` : 'Select the board COM port'} onClick={() => projectRequest(action.label)} disabled={!online || !!busyAction || portBusy || status?.busy || !actionPort || actionPort === 'mock'}><Icon name="upload"/>{busyAction === action.label ? 'Uploading…' : action.label}{actionPort && actionPort !== 'mock' && <span className="action-port">{actionPort}</span>}</button>)}
        {!project.actions.length && <span className="project-hint">{project.error ?? 'No build or upload configuration files found'}</span>}
        <button aria-label="Reload project actions" title="Reload actions (.serial-monitor.json)" onClick={() => projectRequest()} disabled={!online || !!busyAction}><Icon name="refresh"/></button>
      </div>}
    </section>
    <section className="terminal-window" aria-label="Serial console">
    <section className="toolbar"><div className="terminal-title"><span className={`dot ${online && status?.connected ? 'connected':''}`}/><span>{status?.port ? `${status.port} / ${status.baudRate}${status.mock ? ' / simulated':''}` : 'serial / no port'}</span></div><div className="toolbar-actions"><button onClick={clearLog} title="Clear this window’s log and notes and continue receiving new records"><Icon name="trash"/>Clear</button><button onClick={() => void exportAll()} disabled={exporting} title={exportPath ? `Last file: ${exportPath}` : 'Save the latest 2000 records and all annotated records as Markdown'}><Icon name="download"/>{exporting ? 'Saving…':exportLabel}</button><button onClick={() => void copyAll()} disabled={copying} title="Copy the latest 2000 records and annotated records, including those hidden by pause or filter"><Icon name="copy"/>{copying ? 'Copying…':copyLabel}</button><button onClick={() => pause()}><Icon name={paused ? 'play':'pause'}/>{paused ? 'Resume':'Pause'}</button></div></section>
    <section className="filters"><label className="search-field"><Icon name="search"/><input aria-label="Filter records" placeholder="Filter records…" value={filter} onChange={e => setFilter(e.target.value)}/></label><div className="display-modes" role="group" aria-label="Log display format"><button aria-pressed={displayMode === 'ascii'} title="View data as text" onClick={() => setDisplayMode('ascii')}>ASCII</button><button aria-pressed={displayMode === 'hex'} title="View original bytes in hexadecimal" onClick={() => setDisplayMode('hex')}>HEXA</button></div></section>
    <div className="log-stage">
    <div className="logs" aria-label="Serial records" ref={logViewport} onScroll={() => {handleLogScroll(); closeLogMenu();}} onContextMenu={openLogMenu}>
      {!displayedRecords.length && <div className="empty"><Icon name="terminal"/>{status?.connected ? <strong>Waiting for data</strong> : <MonitorTypewriter/>}<p>{status?.connected ? 'Device records will appear here.' : hasSnapshot.current ? 'Open a port to receive records or send commands.' : 'Connecting to the serial monitor…'}</p></div>}
      {displayedRecords.filter(r => r.pauseAfter !== undefined || r.id === editingRecord?.id || recordText(r,displayMode).includes(displayMode === 'hex' ? filter.toUpperCase() : filter) || r.annotation?.includes(filter)).map(r => r.pauseAfter !== undefined ? <div className="record pause-marker" key={r.id}><time>{new Date(r.timestamp).toLocaleTimeString()}</time><pre>{r.text}</pre></div> : <LogRecord key={r.id} record={r} displayMode={displayMode} editing={editingRecord?.id === r.id} highlight={highlight} onEdit={() => editNote(r)} onSave={saveNote} onCancel={finishNoteEdit} onRemove={() => removeNote(r.id)}/>)}
    </div>
    {showGoToEnd && <button className="go-to-end" onClick={goToEnd} title="Jump to the latest record and follow incoming data"><Icon name="down"/>Jump to latest</button>}
    </div>
    {paused && <div className="notice">{pauseTrigger ? `View paused by trigger: “${pauseTrigger}”` : 'View paused'} · receiving data · latest 2000 records and annotated records</div>}
    </section>
    {logMenu && <LogContextMenu capture={logMenu} onClose={closeLogMenu} onCopy={() => void copyCapturedLog()} onSend={sendCapturedLog}
      sendDisabled={!logMenu.text.trim() ? 'No hay texto para enviar' : !online ? 'Monitor desconectado' : !logMenu.bindingId ? 'Sin agente vinculado' : logMenu.bindingId !== status?.agent?.bindingId ? 'Cambió el chat vinculado' : agentSending ? 'Envío en curso' : new TextEncoder().encode(logMenu.text).length > 1024*1024 ? 'Supera 1 MiB: seleccioná un fragmento' : ''}/>}
    {agentDraft && <AgentMessageDialog capture={agentDraft} onCancel={() => setAgentDraft(null)} onSend={sendAgentMessage}
      disabledReason={!online ? 'Monitor disconnected' : agentDraft.bindingId !== status?.agent?.bindingId ? 'The linked chat has changed. Cancel and select the log again.' : agentSending ? 'Sending in progress' : ''}/>}
    {agentNotice && <div className="notice" role="status">{agentNotice}</div>}
    {error && <div className="error" role="alert">{error}</div>}
    <form className="tx-form" onSubmit={send}>
      <label className="tx-input"><span>TX ›</span><input aria-label={txEncoding === 'hex' ? 'Serial HEX bytes' : 'Serial command'} aria-invalid={!!txError} aria-describedby={txError ? 'tx-error' : undefined} placeholder={txEncoding === 'hex' ? 'HEX bytes, e.g. 01 03 00 FF…' : 'Send a command to the device…'} value={payload} onChange={e => setPayload(e.target.value)} maxLength={txEncoding === 'hex' ? 12288 : 4096}/></label>
      <div className="display-modes" role="group" aria-label="Transmit format"><button type="button" aria-pressed={txEncoding === 'ascii'} title="Send text" onClick={() => setTxEncoding('ascii')}>ASCII</button><button type="button" aria-pressed={txEncoding === 'hex'} title="Send hexadecimal bytes" onClick={() => setTxEncoding('hex')}>HEX</button></div>
      <button className="send-button" disabled={!online || !status?.connected || sending || !payload || !!txError || !!busyAction}>{sending ? 'Sending…':'Send'}<span aria-hidden="true">→</span></button>
      {txError && <p id="tx-error" className="tx-error" role="status">{txError}</p>}
    </form>
    <footer><label><input type="checkbox" checked={appendLF} onChange={e => txEncoding === 'hex' ? setHexNewline(e.target.checked) : setNewline(e.target.checked)}/> Append LF (↵)</label><span className="footer-status">{online ? status?.connected ? 'Port open':'Port closed':'Disconnected'} · {serialFormatLabel(serialFormat)} · {displayedRecords.length} records · {annotationCount(displayedRecords)} notes</span></footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
