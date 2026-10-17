import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PortReservations} from './port-reservations.js';

test('COM reservations exclude other windows, survive repeated claims during upload and release only their owner',()=>{
  const ports=new PortReservations();
  ports.claim('COM21','parent');ports.claim('COM21','parent');ports.claim('COM22','child');
  assert.throws(()=>ports.claim('COM21','child'),{message:'El puerto COM21 está ocupado por otro monitor'});
  if(process.platform==='win32') {
    assert.throws(()=>ports.claim('com21','child'),/ocupado/);
    assert.throws(()=>ports.claim('\\\\.\\COM21','child'),/ocupado/);
  }
  ports.release('child');assert.throws(()=>ports.claim('COM21','child'),/ocupado/);
  ports.release('parent');ports.claim('COM21','child');
  ports.claim('mock','parent');ports.claim('mock','child');
});
