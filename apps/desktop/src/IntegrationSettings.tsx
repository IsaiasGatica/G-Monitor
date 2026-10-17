import { useState } from 'react';
export type IntegrationInfo = {available:boolean;url?:string;message?:string;files?:string[];claudePlugin?:{marketplacePath:string;pluginId:string;status:'manual'|'installed'|'pending';diagnostic?:string}};
export function IntegrationSettings({info,busy,onConfigure}:{info:IntegrationInfo|undefined;busy:boolean;onConfigure:(options:{codex:boolean;claude:boolean;antigravity?:boolean}) => void}) {
  const [codex,setCodex]=useState(false);const [claude,setClaude]=useState(false);
  const [antigravity,setAntigravity]=useState(false);
  return <section className="integration-settings" aria-labelledby="integration-title">
    <h3 id="integration-title">Agent integration</h3>
    <p>{info?.available ? 'Set up your agent once to use G Monitor from your chats.' : 'Start G Monitor with npm start to configure agents over HTTP.'}</p>
    {info?.url && <code>{info.url}</code>}
    <label><input type="checkbox" checked={codex} onChange={event => setCodex(event.target.checked)} disabled={busy}/> Codex Desktop</label>
    <label><input type="checkbox" checked={claude} onChange={event => setClaude(event.target.checked)} disabled={busy}/> Claude Code</label>
    <label><input type="checkbox" checked={antigravity} onChange={event => setAntigravity(event.target.checked)} disabled={busy}/> Antigravity App</label>
    {antigravity && <p>Configures MCP and the bridge for Send to agent. Restart Antigravity App after configuring, check that the g-monitor sidecar is enabled, then ask the same chat to open G Monitor again. CLI and IDE support MCP only. Delivery in a real App session still needs validation.</p>}
    <p>Updates the G Monitor integration and its skill. Saves backups of the previous configuration.</p>
    <button disabled={!info?.available || busy || (!codex && !claude && !antigravity)} onClick={() => onConfigure({codex,claude,antigravity})}>{busy ? 'Configuring…':'Configure integration'}</button>
    {info?.message && <p role="status">{info.message}</p>}
    {info?.claudePlugin && <div>
      <p>Plugin: <code>{info.claudePlugin.pluginId}</code></p>
      <p>Local marketplace: <code>{info.claudePlugin.marketplacePath}</code></p>
      {info.claudePlugin.diagnostic && <details><summary>CLI installation diagnostic</summary><p>{info.claudePlugin.diagnostic}</p></details>}
    </div>}
    {info?.files && <details><summary>Configured files</summary>{info.files.map(file => <div key={file}><code>{file}</code></div>)}</details>}
    <p>Claude Desktop: Code → Local, Claude Code 2.1.286 or later (check /status). Install from + → Plugins → Add plugin. CLI is optional (2.1.287 or later). After installation, run /reload-plugins in your chat.</p>
  </section>;
}
