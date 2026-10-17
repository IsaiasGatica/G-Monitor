import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ClaudeModDelivery} from './claude-mod.js';
test('private mod routes claim once and require receipt from the owner',async()=>{
  const mod=new ClaudeModDelivery(()=>{});const a=mod.register('a');const b=mod.register('b');
  try {
    const pending=mod.send('a','exact á','selection');
    assert.throws(()=>mod.poll('a',b.key));assert.equal(mod.poll('b',b.key).message,null);
    const message=mod.poll('a',a.key).message!;assert.equal(message.text,'exact á');
    assert.equal(mod.poll('a',a.key).message,null);
    assert.throws(()=>mod.acknowledge('b',b.key,message.id));
    mod.acknowledge('a',a.key,message.id);assert.equal((await pending as any).confirmed,true);
    assert.throws(()=>mod.acknowledge('a',a.key,message.id));
  } finally {mod.close();}
});
test('timeout and disconnect reject without automatic replay',async()=>{
  const detached:string[]=[];const mod=new ClaudeModDelivery(id=>detached.push(id),20,1000);const a=mod.register('a');
  try {
    const pending=mod.send('a','log','all');const message=mod.poll('a',a.key).message!;
    await assert.rejects(pending,/no confirmó/);assert.throws(()=>mod.acknowledge('a',a.key,message.id));
    const next=mod.send('a','log2','all');const rejected=assert.rejects(next,/desconectó/);
    mod.disconnect('a',a.key);await rejected;assert.deepEqual(detached,['a']);
  } finally {mod.close();}
});
