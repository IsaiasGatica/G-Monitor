import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

export type LogCapture = {x:number; y:number; text:string; scope:'selection'|'all'; bindingId?:string; threadId?:string; agentType?:'codex'|'claude_code'|'antigravity'};
export function LogContextMenu({capture, sendDisabled, onCopy, onSend, onClose}:{capture:LogCapture; sendDisabled:string; onCopy:() => void; onSend:() => void; onClose:() => void}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({x:capture.x,y:capture.y});
  useLayoutEffect(() => {
    const bounds = menu.current!.getBoundingClientRect();
    setPosition({x:Math.max(8,Math.min(capture.x,window.innerWidth-bounds.width-8)),y:Math.max(8,Math.min(capture.y,window.innerHeight-bounds.height-8))});
  }, [capture,sendDisabled]);
  useLayoutEffect(() => {
    const focusTarget = menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? menu.current;
    focusTarget?.focus({preventScroll:true});
  }, [capture]);
  useEffect(() => {
    const outside = (event:PointerEvent) => { if (!menu.current?.contains(event.target as Node)) onClose(); };
    const close = () => onClose();
    document.addEventListener('pointerdown',outside);
    window.addEventListener('resize',close); window.addEventListener('blur',close);
    return () => {document.removeEventListener('pointerdown',outside); window.removeEventListener('resize',close); window.removeEventListener('blur',close);};
  }, [onClose]);
  return <div ref={menu} className="log-context-menu" role="menu" tabIndex={-1} aria-label="Acciones del log" style={{left:position.x,top:position.y}}
    onPointerDown={event => event.preventDefault()} onContextMenu={event => event.preventDefault()} onKeyDown={event => {
      if (event.key === 'Escape' || event.key === 'Tab') {if (event.key === 'Escape') event.preventDefault(); onClose(); return;}
      if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
        event.preventDefault();
        const buttons = Array.from(menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length-1 : (current+(event.key === 'ArrowDown' ? 1 : -1)+buttons.length)%buttons.length;
        buttons[index]?.focus();
      }
    }}>
    <div className="log-context-caption">{capture.scope === 'selection' ? 'Texto seleccionado' : 'Todo el log conservado'}</div>
    <button role="menuitem" disabled={!capture.text.trim()} onClick={onCopy}><Icon name="copy"/>Copiar</button>
    <button role="menuitem" disabled={!!sendDisabled} title={sendDisabled || (capture.agentType === 'claude_code' ? 'Enviar a la sesión actual de Claude Code' : `Enviar al chat ${capture.agentType==='antigravity' ? 'de Antigravity ' : ''}${capture.threadId}`)} onClick={onSend}><Icon name="send"/>Enviar a agente</button>
    {sendDisabled && <div className="log-context-caption">{sendDisabled}</div>}
  </div>;
}
