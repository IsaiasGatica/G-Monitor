import { useEffect, useState } from 'react';

const storageKey = 'serial-monitor.trigger';

function load():string {
  try { return localStorage.getItem(storageKey) ?? ''; }
  catch { return ''; }
}

export function useTrigger() {
  const [trigger, setTrigger] = useState(load);
  useEffect(() => {
    try { localStorage.setItem(storageKey, trigger); }
    catch { /* The trigger still works if storage is unavailable. */ }
  }, [trigger]);
  return [trigger, setTrigger] as const;
}

export function matchesTrigger(text:string, trigger:string):boolean {
  return Boolean(trigger.trim()) && text.toLowerCase().includes(trigger.toLowerCase());
}
