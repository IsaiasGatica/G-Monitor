import { ensureService,root } from './service.mjs';
import { configureIntegrations } from '../packages/daemon/dist/integrations.js';
try {
  const service=await ensureService();
  const result=await configureIntegrations({codex:process.argv.includes('--codex'),claude:process.argv.includes('--claude'),antigravity:process.argv.includes('--antigravity')},{root,url:service.url,token:service.token});
  console.log(result.message); console.log(result.files.join('\n'));
} catch (error) {console.error(error.message);process.exitCode=1;}
