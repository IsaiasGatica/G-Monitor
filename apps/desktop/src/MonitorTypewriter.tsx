import { useEffect, useState } from 'react';

const PHRASES = ['G Monitor', 'Greatest? Monitor', 'Gentle? Monitor', 'Gorgeous Monitor', 'G Monitor'];
const GORGEOUS = 'Gorgeous Monitor';

function createTimeline() {
  let seed = 31;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const typeDelay = (ch: string) => 0.06 + random() * 0.09
    + (ch === ' ' ? 0.05 + random() * 0.08 : 0) + (random() < 0.05 ? 0.3 : 0);
  const events = [{ time: 0, text: PHRASES[0] }];
  let time = 0;
  let text = PHRASES[0];
  const key = (next: string, delay: number) => {
    time += delay;
    text = next;
    events.push({ time, text });
  };
  for (let i = 1; i < PHRASES.length; i++) {
    time += PHRASES[i - 1] === GORGEOUS ? 3.2 : 2.2;
    const length = text.length - 1;
    for (let k = 0; k < length; k++) {
      key(text.slice(0, -1), k === 0 ? 0 : k === 1 ? 0.18 : 0.045);
    }
    time += 0.5;
    for (const ch of PHRASES[i].slice(1)) key(text + ch, typeDelay(ch));
  }
  return { events, period: time + 3.2 };
}

const timeline = createTimeline();

export function MonitorTypewriter() {
  const [frame, setFrame] = useState({ text: PHRASES[0], cursor: false });
  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let animation = 0;
    let start = performance.now();
    let lastFrame = -100;
    const animate = (stamp: number) => {
      if (stamp - lastFrame >= 50) {
        lastFrame = stamp;
        const now = ((stamp - start) / 1000) % timeline.period;
        let event = timeline.events[0];
        for (const candidate of timeline.events) {
          if (candidate.time > now) break;
          event = candidate;
        }
        const idle = now - event.time;
        const cursor = idle < 0.45 || (idle - 0.45) % 1.06 > 0.53;
        setFrame(previous => previous.text === event.text && previous.cursor === cursor
          ? previous : { text: event.text, cursor });
      }
      animation = requestAnimationFrame(animate);
    };
    const updateMotion = () => {
      cancelAnimationFrame(animation);
      setFrame({ text: PHRASES[0], cursor: false });
      if (!reducedMotion.matches) {
        start = performance.now();
        lastFrame = -100;
        animation = requestAnimationFrame(animate);
      }
    };
    updateMotion();
    reducedMotion.addEventListener('change', updateMotion);
    return () => {
      cancelAnimationFrame(animation);
      reducedMotion.removeEventListener('change', updateMotion);
    };
  }, []);

  return <strong className="monitor-typewriter" aria-label="G Monitor">
    <span className={frame.text === GORGEOUS ? 'monitor-typed sparkling' : 'monitor-typed'} aria-hidden="true">{frame.text}</span>
    <span className="monitor-cursor" aria-hidden="true" style={{ visibility: frame.cursor ? 'visible' : 'hidden' }}>▌</span>
  </strong>;
}
