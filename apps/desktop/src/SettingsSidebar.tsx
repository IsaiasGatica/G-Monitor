import { useEffect, useRef } from 'react';
import { Icon } from './Icon';
import type { FontSizes } from './font-settings';
import { newKeyword, type Keyword } from './keyword-settings';
import { defaultTheme, type ThemeColors } from './theme-settings';
import {serialFormatLabel,type SerialFormat} from '../../../packages/daemon/src/serial-format';

export function SettingsSidebar({open, onClose, fontSizes, onFontSizesChange, keywords, onKeywordsChange, themeColors, onThemeColorsChange, trigger, onTriggerChange, serialFormat, onSerialFormatChange, serialDisabled}:{open:boolean; onClose:() => void; fontSizes:FontSizes; onFontSizesChange:(sizes:FontSizes) => void; keywords:Keyword[]; onKeywordsChange:(keywords:Keyword[]) => void; themeColors:ThemeColors; onThemeColorsChange:(colors:ThemeColors) => void; trigger:string; onTriggerChange:(trigger:string) => void; serialFormat:SerialFormat; onSerialFormatChange:(format:SerialFormat) => void; serialDisabled:boolean}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    else if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);

  return <dialog id="settings-sidebar" className="settings-sidebar" ref={dialog}
    aria-labelledby="settings-title" onClose={onClose}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <div className="settings-heading">
      <div><span className="eyebrow">Preferences</span><h2 id="settings-title">Settings</h2></div>
      <button className="window-control" autoFocus aria-label="Close settings" title="Close settings" onClick={onClose}><Icon name="close"/></button>
    </div>
    <div className="settings-content">
      <section className="serial-settings" aria-labelledby="serial-format-title">
        <h3 id="serial-format-title">Serial format <output>{serialFormatLabel(serialFormat)}</output></h3>
        <fieldset disabled={serialDisabled} aria-describedby="serial-format-help">
          <label>Data bits<select aria-label="Data bits" value={serialFormat.dataBits} onChange={event=>onSerialFormatChange({...serialFormat,dataBits:Number(event.target.value) as SerialFormat['dataBits']})}>
            {[5,6,7,8].map(bits=><option key={bits} value={bits}>{bits}</option>)}
          </select></label>
          <label>Parity<select aria-label="Parity" value={serialFormat.parity} onChange={event=>onSerialFormatChange({...serialFormat,parity:event.target.value as SerialFormat['parity']})}>
            <option value="none">None (N)</option><option value="even">Even (E)</option><option value="odd">Odd (O)</option>
          </select></label>
          <label>Stop bits<select aria-label="Stop bits" value={serialFormat.stopBits} onChange={event=>onSerialFormatChange({...serialFormat,stopBits:Number(event.target.value) as SerialFormat['stopBits']})}>
            {[1,2].map(bits=><option key={bits} value={bits}>{bits}</option>)}
          </select></label>
        </fieldset>
        <p id="serial-format-help">{serialDisabled ? 'Close the port and wait for pending operations to finish before changing the serial format.' : 'Applied when you click Open. Default: 8N1 (8 data bits, no parity, 1 stop bit). Options depend on your serial adapter.'}</p>
      </section>
      <section className="keyword-settings" aria-labelledby="keywords-title">
        <h3 id="keywords-title">Keywords</h3>
        <p>Highlight case-insensitive matches.</p>
        <div className="keyword-list">
          {keywords.map((keyword,index) => <div className="keyword-row" key={keyword.id}>
            <input aria-label={`Keyword ${index+1}`} placeholder="e.g. ERROR" maxLength={128} value={keyword.word} onChange={event => onKeywordsChange(keywords.map(row => row.id === keyword.id ? {...row, word:event.target.value} : row))}/>
            <input type="color" aria-label={`Keyword color ${index+1}`} title="Choose color" value={keyword.color} onChange={event => onKeywordsChange(keywords.map(row => row.id === keyword.id ? {...row, color:event.target.value} : row))}/>
            <button className="keyword-remove" aria-label={`Remove keyword ${index+1}`} title="Remove keyword" onClick={() => onKeywordsChange(keywords.filter(row => row.id !== keyword.id))}><Icon name="close"/></button>
          </div>)}
        </div>
        <button className="keyword-add" aria-label="Add keyword" title="Add keyword" onClick={() => onKeywordsChange([...keywords,newKeyword()])}>+</button>
      </section>
      <section className="trigger-settings" aria-labelledby="trigger-title">
        <h3 id="trigger-title">Trigger</h3>
        <label htmlFor="log-trigger">Pause when the log contains</label>
        <input id="log-trigger" type="text" placeholder="e.g. ERROR" value={trigger} onChange={event => onTriggerChange(event.target.value)} aria-describedby="trigger-help"/>
        <p id="trigger-help">Pause the view on new matching records, ignoring case. Leave empty to disable. Data keeps arriving while paused.</p>
      </section>
      <section className="appearance-settings" aria-labelledby="appearance-title">
        <h3 id="appearance-title">Appearance</h3>
      <div className="font-setting">
        <label htmlFor="app-font-size">App font size <output>{fontSizes.app} px</output></label>
        <input id="app-font-size" type="range" min="10" max="16" step="1" value={fontSizes.app} onChange={event => onFontSizesChange({...fontSizes, app:Number(event.target.value)})}/>
        <p>Adjust text in controls and menus.</p>
      </div>
      <div className="font-setting">
        <label htmlFor="log-font-size">Log font size <output>{fontSizes.log} px</output></label>
        <input id="log-font-size" type="range" min="10" max="24" step="1" value={fontSizes.log} onChange={event => onFontSizesChange({...fontSizes, log:Number(event.target.value)})}/>
        <p>Adjust records, timestamps, and labels.</p>
      </div>
      <button onClick={() => onFontSizesChange({app:12, log:11})}>Reset font sizes</button>
        <div className="theme-settings">
          <h4>Colors</h4>
          {([['background','Background'],['accent','Accent'],['text','Text']] as const).map(([key,label]) => <label className="theme-color-row" key={key}>
            <span>{label}</span>
            <output>{themeColors[key].toUpperCase()}</output>
            <input type="color" aria-label={`${label} color`} value={themeColors[key]} onChange={event => onThemeColorsChange({...themeColors,[key]:event.target.value})}/>
          </label>)}
          <p>Secondary backgrounds, borders, and muted colors adjust automatically.</p>
          <button onClick={() => onThemeColorsChange({...defaultTheme})}>Reset colors</button>
        </div>
      </section>
      <footer className="settings-footer">Isaias Gatica - Argentina - v0.1</footer>
    </div>
  </dialog>;
}
