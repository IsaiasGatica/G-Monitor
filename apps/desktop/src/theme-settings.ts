import { useLayoutEffect, useState } from 'react';

export type ThemeColors = {background:string; accent:string; text:string};
export const defaultTheme:ThemeColors = {background:'#000000', accent:'#da5c2c', text:'#eeeeee'};
const storageKey = 'serial-monitor.theme.axiom';
const validColor = (color:unknown):color is string => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color);
const rgb = (color:string) => [1,3,5].map(offset => parseInt(color.slice(offset,offset+2),16));
function mix(base:string, color:string, weight:number) {
  const a = rgb(base), b = rgb(color);
  return '#'+a.map((value,index) => Math.round(value+(b[index]-value)*weight).toString(16).padStart(2,'0')).join('');
}
function luminance(color:string) {
  const linear = rgb(color).map(value => {const s = value/255; return s <= .04045 ? s/12.92 : ((s+.055)/1.055)**2.4;});
  return linear[0]*.2126+linear[1]*.7152+linear[2]*.0722;
}
const contrastText = (color:string) => luminance(color) > .179 ? '#000000' : '#ffffff';

function load():ThemeColors {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    return Object.fromEntries(Object.entries(defaultTheme).map(([key,value]) => [key, validColor(saved?.[key]) ? saved[key] : value])) as ThemeColors;
  } catch { return {...defaultTheme}; }
}

export function useThemeColors() {
  const [colors, setColors] = useState(load);
  useLayoutEffect(() => {
    const {background, accent, text} = colors;
    const neutral = contrastText(background);
    const hover = mix(accent,background,.14);
    const palette:Record<string,string> = {
      'void':background,
      'carbon':mix(background,neutral,17/255),
      'graphite':mix(background,neutral,25/255),
      'iron':mix(background,neutral,32/255),
      'slate':mix(background,neutral,58/255),
      'steel':mix(background,text,96/238),
      'ash':mix(background,text,126/238),
      'fog':mix(background,text,180/238),
      'chalk':mix(background,text,217/238),
      'error-surface':mix(background,neutral,25/255),
      'ember':accent,
      'paper':text,
      'on-accent':text,
      'accent-hover':hover,
      'on-accent-hover':text,
      'backdrop':background+'99',
    };
    for (const [token,value] of Object.entries(palette)) document.documentElement.style.setProperty(`--color-${token}`,value);
    document.documentElement.style.colorScheme = luminance(background) > .179 ? 'light' : 'dark';
    try { localStorage.setItem(storageKey,JSON.stringify(colors)); } catch { /* Keep live theme controls available without storage. */ }
  }, [colors]);
  return [colors, setColors] as const;
}
