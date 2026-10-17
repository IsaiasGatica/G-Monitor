import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('portable installation chooses a free HTTP port when default is occupied and preserves it',async()=>{
  const {selectHttpPort}=await import('../../../scripts/service.mjs');
  const dir=await mkdtemp(join(tmpdir(),'g-monitor-port-'));
  const occupied=createServer();let ownsPort=false;
  try {
    try {await new Promise<void>((resolve,reject)=>{occupied.once('error',reject);occupied.listen(47831,'127.0.0.1',resolve);});ownsPort=true;}
    catch(error:any){if(error.code!=='EADDRINUSE') throw error;}
    const port=await selectHttpPort(dir);
    assert.notEqual(port,47831);assert.ok(port>0 && port<=65535);
    assert.equal(await readFile(join(dir,'http-port'),'utf8'),String(port));
    assert.equal(await selectHttpPort(dir),port);
    assert.equal(await selectHttpPort(dir,'0'),0);
    assert.equal(await selectHttpPort(dir,'47831'),47831);
    await assert.rejects(selectHttpPort(dir,'70000'),/inválido/);
  } finally {if(ownsPort) await new Promise<void>(resolve=>occupied.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
