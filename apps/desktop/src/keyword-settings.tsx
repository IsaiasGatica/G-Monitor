import { useEffect, useMemo, useState } from 'react';

export type Keyword = {id:string; word:string; color:string};
const storageKey = 'serial-monitor.keywords';
export const newKeyword = ():Keyword => ({id:crypto.randomUUID(), word:'', color:'#eeeeee'});

function load():Keyword[] {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (Array.isArray(saved)) return saved.filter(item => typeof item?.word === 'string' && /^#[0-9a-f]{6}$/i.test(item?.color))
      .map(item => ({...newKeyword(), word:item.word.slice(0,128), color:item.color}));
  } catch { /* Start with an empty row if storage is unavailable or invalid. */ }
  return [newKeyword()];
}

export function useKeywords() {
  const [keywords, setKeywords] = useState(load);
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(keywords)); } catch { /* Live highlighting still works without storage. */ }
  }, [keywords]);
  // Prefer the longest match when configured words overlap. Treat keywords as literal text.
  const highlight = useMemo(() => {
    const rules = keywords.filter(rule => rule.word.trim()).slice().sort((a,b) => b.word.length - a.word.length);
    if (!rules.length) return (text:string) => text;
    const matcher = new RegExp(rules.map(rule => `(${rule.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`).join('|'), 'giu');
    return (text:string) => {
      const parts:(string | React.JSX.Element)[] = [];
      let start = 0;
      for (const match of text.matchAll(matcher)) {
        const index = match.index!;
        if (index > start) parts.push(text.slice(start,index));
        const rule = rules[match.findIndex((value,group) => group > 0 && value !== undefined) - 1];
        parts.push(<span className="keyword-highlight" style={{color:rule.color}} key={index}>{match[0]}</span>);
        start = index + match[0].length;
      }
      if (start < text.length) parts.push(text.slice(start));
      return parts;
    };
  }, [keywords]);
  return {keywords, setKeywords, highlight};
}
