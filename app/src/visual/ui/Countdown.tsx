import { useEffect, useRef, useState } from 'react';
import { Odometer } from './Odometer';
import { cx, plural } from './util';

export interface CountdownProps {
  /** start time (ms, same time base as `now`) */
  target: number;
  now?: () => number;
  /** hide the days column when zero */
  compact?: boolean;
  onDone?: () => void;
  className?: string;
}

const UNITS: { f: readonly [string, string, string]; s: number }[] = [
  { f: ['день', 'дня', 'дней'], s: 86400 },
  { f: ['час', 'часа', 'часов'], s: 3600 },
  { f: ['минута', 'минуты', 'минут'], s: 60 },
  { f: ['секунда', 'секунды', 'секунд'], s: 1 },
];

/** Pre-game countdown in rolling chrome digits: дни · часы · минуты · секунды. */
export function Countdown({ target, now = Date.now, compact = true, onDone, className }: CountdownProps) {
  const clock = useRef(now);
  clock.current = now;
  const [left, setLeft] = useState(() => Math.max(0, Math.floor((target - now()) / 1000)));
  const done = useRef(false);
  const cb = useRef(onDone);
  cb.current = onDone;

  useEffect(() => {
    let id = 0;
    const step = () => {
      const ms = target - clock.current();
      const s = Math.max(0, Math.floor(ms / 1000));
      setLeft(s);
      if (s === 0 && !done.current) {
        done.current = true;
        cb.current?.();
      }
      if (s > 0) done.current = false;
      // wake right after the next whole second
      id = window.setTimeout(step, Math.max(40, (ms % 1000) + 30));
    };
    step();
    return () => clearTimeout(id);
  }, [target]);

  let rest = left;
  const parts = UNITS.map((u) => {
    const v = Math.floor(rest / u.s);
    rest -= v * u.s;
    return { v, label: plural(v, u.f) };
  });
  const shown = compact && parts[0]?.v === 0 ? parts.slice(1) : parts;
  const text = shown.map((p) => `${p.v} ${p.label}`).join(' ');
  return (
    <div className={cx('vx-count', className)} role="timer" aria-label={`До начала: ${text}`}>
      {shown.map((p, i) => (
        <div className="vx-count-cell" key={i} aria-hidden="true">
          <Odometer value={p.v} pad={2} group={false} chrome className="vx-count-n" />
          <span className="vx-count-u">{p.label}</span>
        </div>
      ))}
    </div>
  );
}
