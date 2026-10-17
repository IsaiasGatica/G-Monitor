import { useEffect, useRef } from 'react';
import { Icon } from './Icon';
import { IntegrationSettings, type IntegrationInfo } from './IntegrationSettings';

export function AgentsSidebar({open, onClose, integrations, integrationBusy, onConfigure}:{open:boolean; onClose:() => void; integrations:IntegrationInfo|undefined; integrationBusy:boolean; onConfigure:(options:{codex:boolean; claude:boolean; antigravity?:boolean}) => void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    else if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);

  return <dialog id="agents-sidebar" className="settings-sidebar agents-sidebar" ref={dialog}
    aria-labelledby="agents-title" onClose={onClose}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <div className="settings-heading">
      <div><span className="eyebrow">Integrations</span><h2 id="agents-title">Agents</h2></div>
      <button className="window-control" autoFocus aria-label="Close agent settings" title="Close agent settings" onClick={onClose}><Icon name="close"/></button>
    </div>
    <div className="settings-content">
      <IntegrationSettings info={integrations} busy={integrationBusy} onConfigure={onConfigure}/>
    </div>
  </dialog>;
}
