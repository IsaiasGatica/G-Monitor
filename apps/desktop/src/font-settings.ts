import { useEffect, useState } from 'react';

const key = 'serial-monitor.font-sizes';
const defaults = { app: 12, log: 11 };
export type FontSizes = typeof defaults;

function load(): FontSizes {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? '{}');
    return {
      app: Number.isInteger(saved?.app) && saved.app >= 10 && saved.app <= 16 ? saved.app : defaults.app,
      log: Number.isInteger(saved?.log) && saved.log >= 10 && saved.log <= 24 ? saved.log : defaults.log,
    };
  } catch { return { ...defaults }; }
}

export function useFontSizes() {
  const [sizes, setSizes] = useState(load);
  useEffect(() => {
    document.documentElement.style.setProperty('--app-font-size', `${sizes.app}px`);
    document.documentElement.style.setProperty('--log-font-size', `${sizes.log}px`);
    try { localStorage.setItem(key, JSON.stringify(sizes)); } catch { /* Keep live controls available if storage is unavailable. */ }
  }, [sizes]);
  return [sizes, setSizes] as const;
}
