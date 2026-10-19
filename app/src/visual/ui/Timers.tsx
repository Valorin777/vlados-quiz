import { gsap } from 'gsap';
import { useEffect, useMemo, useRef, useState } from 'react';
import { audio } from '../audio';
import { useChromeBlob, useLiquid } from '../liquid';
import { reducedMotion } from '../motion';
import { neckY, tubeGeo, tubeLevel } from './tubeGeo';
import { cx, fmtClock } from './util';

export interface TimerProps {
  /** deadline in the `now()` time base (ms) */
  endsAt: number;
  /** full duration, seconds */
  total: number;
  /** clock (server-corrected in the app); default Date.now */
  now?: () => number;
  /** when set, the timer is frozen showing this many seconds (pause) */
  frozenAt?: number | null;
  /** seconds left when hurry mode starts */
  hurryAt?: number;
  /** tick sound every hurry second */
  sound?: boolean;
  /** let the timer heat up / agitate the whole liquid scene in hurry mode */
  driveScene?: boolean;
  onHurry?: (hurry: boolean) => void;
  onEnd?: () => void;
  className?: string;
}

interface Frame {
  rem: number;
  sec: number;
  hurry: boolean;
  ended: boolean;
}

/** Shared per-frame driver: calls `draw` with remaining time, fires hurry/end transitions. */
function useCountdown(p: TimerProps, draw: (f: Frame) => void): void {
  const { engine } = useLiquid();
  const props = useRef(p);
  props.current = p;
  const drawRef = useRef(draw);
  drawRef.current = draw;
  useEffect(() => {
    let lastSec = -1;
    let hurry = false;
    let ended = false;
    const tick = () => {
      const q = props.current;
      const now = (q.now ?? Date.now)();
      const rem = q.frozenAt != null ? q.frozenAt : Math.max(0, Math.min(q.total, (q.endsAt - now) / 1000));
      const sec = Math.ceil(rem - 1e-6);
      const h = rem > 0 && rem <= (q.hurryAt ?? 10);
      if (h !== hurry) {
        hurry = h;
        q.onHurry?.(h);
        if (q.driveScene && engine) gsap.to(engine.scene, { heat: h ? 1 : 0, agit: h ? 0.5 : 0, duration: h ? 0.8 : 1.4 });
        audio.setHurry(h);
      }
      if (sec !== lastSec) {
        if (hurry && lastSec > sec && q.frozenAt == null && q.sound) audio.tick(0.5);
        lastSec = sec;
      }
      const e = rem <= 0 && q.frozenAt == null;
      if (e && !ended) {
        ended = true;
        q.onEnd?.();
        if (q.sound) {
          audio.bell(98, 0.2, 2);
          audio.tick(0.7);
        }
      } else if (!e) ended = false;
      drawRef.current({ rem, sec, hurry, ended: e });
    };
    tick();
    gsap.ticker.add(tick);
    return () => {
      gsap.ticker.remove(tick);
      if (hurry && props.current.driveScene && engine) gsap.to(engine.scene, { heat: 0, agit: 0, duration: 0.6 });
    };
  }, [engine]);
}

// ------------------------------------------------------------------ phone bar

/** Phone timer: a mercury pill that drains left, with m:ss. Turns amber and boils at hurry. */
export function TimerBar(p: TimerProps & { label?: string }) {
  const fill = useRef<HTMLDivElement | null>(null);
  const secEl = useRef<HTMLElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const blob = useChromeBlob(fill, { shape: 'pill', film: 0.4 });
  const last = useRef({ sec: -1, hurry: false });
  useCountdown(p, ({ rem, sec, hurry }) => {
    const f = fill.current;
    if (f) f.style.transform = `scaleX(${Math.max(0.035, rem / Math.max(1, p.total)).toFixed(4)})`;
    if (sec !== last.current.sec && secEl.current) {
      secEl.current.textContent = fmtClock(rem);
      if (hurry && !reducedMotion()) gsap.fromTo(secEl.current, { scale: 1.3 }, { scale: 1, duration: 0.45, ease: 'power3.out' });
      last.current.sec = sec;
    }
    if (hurry !== last.current.hurry) {
      last.current.hurry = hurry;
      root.current?.classList.toggle('is-hot', hurry);
      if (blob.current) gsap.to(blob.current, { tar: hurry ? 0.3 : 0, duration: 0.8 });
    }
  });
  return (
    <div ref={root} className={cx('vx-tbar', p.className)} role="timer" aria-label="Оставшееся время">
      <div className="vx-tbar-track">
        <div ref={fill} className="vx-tbar-fill lq lq-band" />
      </div>
      <div className="vx-tbar-row">
        <span>{p.label ?? 'время'}</span>
        <b ref={secEl} className="vx-mono">
          {fmtClock(p.total)}
        </b>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ TV tube

export interface TimerTubeProps extends TimerProps {
  /** height of the whole thermometer in px, bulb included (default 520) */
  height?: number;
  /** tick labels (seconds) — default: 0 … total in 3–5 even steps */
  marks?: number[];
}

let tubeSeq = 0;

/**
 * TV timer: a glass thermometer; the chrome mercury sinks along the scale, the seconds ride the
 * meniscus. The glass (SVG) and the mercury (two DOM bodies the liquid engine measures every
 * frame) are laid out from the same numbers (`tubeGeo`), so the mercury always sits in the glass:
 * the column in the bore, the bulb concentric with the glass bulb, the meniscus on the ticks.
 */
export function TimerTube(p: TimerTubeProps) {
  const H = p.height ?? 520;
  const hurryAt = p.hurryAt ?? 10;
  const marksKey = p.marks?.join(',') ?? '';
  const g = useMemo(() => tubeGeo(H, p.total, p.marks), [H, p.total, marksKey]);
  const col = useRef<HTMLDivElement | null>(null);
  const bulb = useRef<HTMLDivElement | null>(null);
  const sec = useRef<HTMLDivElement | null>(null);
  const secN = useRef<HTMLElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const colBlob = useChromeBlob(col, { shape: 'pill', film: 0.32, appear: 'instant' });
  const bulbBlob = useChromeBlob(bulb, { shape: 'circle', film: 0.32, appear: 'instant' });
  const last = useRef({ sec: -1, hurry: false, ended: false });
  // the mercury rises to its level when the tube appears
  const rise = useRef({ p: reducedMotion() ? 1 : 0 });
  const [uid] = useState(() => `vx-tube-${++tubeSeq}`);
  useEffect(() => {
    const r = rise.current;
    if (r.p >= 1) return;
    const tw = gsap.to(r, { p: 1, duration: 1.2, ease: 'power2.out', delay: 0.45 });
    return () => {
      tw.kill();
      r.p = 1;
    };
  }, []);

  useCountdown(p, ({ rem, sec: s, hurry, ended }) => {
    const k = Math.max(0, Math.min(1, rem / Math.max(1, p.total))) * rise.current.p;
    const level = tubeLevel(g, k);
    if (col.current) {
      col.current.style.top = `${level.toFixed(2)}px`;
      col.current.style.height = `${(g.by - level).toFixed(2)}px`;
    }
    if (sec.current) sec.current.style.transform = `translate3d(0,${(level - 25).toFixed(2)}px,0)`;
    if (s !== last.current.sec && secN.current) {
      secN.current.textContent = String(s);
      if (hurry && !reducedMotion()) gsap.fromTo(secN.current, { scale: 1.35 }, { scale: 1, duration: 0.45, ease: 'power3.out' });
      // every hurry second the mercury flares white-hot and cools again
      if (hurry && p.frozenAt == null && last.current.sec > s) {
        const bodies = [colBlob.current, bulbBlob.current].filter(Boolean);
        if (bodies.length) gsap.fromTo(bodies, { glow: 0.32 }, { glow: 0.04, duration: 0.8, ease: 'power2.out', overwrite: 'auto' });
      }
      last.current.sec = s;
    }
    if (hurry !== last.current.hurry) {
      last.current.hurry = hurry;
      root.current?.classList.toggle('is-hot', hurry);
      const bodies = [colBlob.current, bulbBlob.current].filter(Boolean);
      if (bodies.length) gsap.to(bodies, { film: hurry ? 0.95 : 0.32, glow: hurry ? 0.04 : 0, duration: 0.8 });
    }
    if (ended && !last.current.ended && bulbBlob.current) {
      // a last shiver of the bulb — it stays inside its glass (34 × 1.06 < the 37 px bore)
      gsap.fromTo(bulbBlob.current, { sc: 1.06 }, { sc: 1, duration: 0.7, ease: 'elastic.out(1.2,0.25)' });
    }
    last.current.ended = ended;
  });

  const lv0 = tubeLevel(g, 0);
  const hot = hurryAt > 0 && hurryAt < p.total ? tubeLevel(g, hurryAt / Math.max(1, p.total)) : null;
  const neck = neckY(g);
  return (
    <div ref={root} className={cx('vx-tube', p.className)} style={{ width: g.W, height: H }} role="timer" aria-label="Оставшееся время">
      <svg className="vx-tube-glass" viewBox={`0 0 ${g.W} ${H}`} width={g.W} height={H} aria-hidden="true">
        <defs>
          <linearGradient id={`${uid}-wall`} x1="0" x2="1">
            <stop offset="0" stopColor="currentColor" stopOpacity=".34" />
            <stop offset=".2" stopColor="currentColor" stopOpacity=".5" />
            <stop offset=".5" stopColor="currentColor" stopOpacity=".1" />
            <stop offset=".8" stopColor="currentColor" stopOpacity=".2" />
            <stop offset="1" stopColor="currentColor" stopOpacity=".4" />
          </linearGradient>
          <radialGradient id={`${uid}-bore`} cx=".5" cy=".5" r=".5">
            <stop offset=".7" stopColor="currentColor" stopOpacity="0" />
            <stop offset="1" stopColor="currentColor" stopOpacity=".07" />
          </radialGradient>
        </defs>
        {/* the glass walls only (outer minus bore): the mercury behind the bore stays clear */}
        <path d={`${g.outer} ${g.inner}`} fillRule="evenodd" fill={`url(#${uid}-wall)`} className="vx-tube-wall" />
        <path d={g.inner} className="vx-tube-bore" />
        <path d={g.outer} className="vx-tube-outline" />
        {/* reflections on the glass, over the mercury */}
        <path d={`M${g.cx - g.tw + g.gt + 4} ${g.top + g.tw + 4}V${neck - 6}`} className="vx-tube-glint" />
        <path
          d={`M${g.cx - (g.R - 9) * Math.cos(0.5)} ${g.by - (g.R - 9) * Math.sin(0.5)}A${g.R - 9} ${g.R - 9} 0 0 0 ${g.cx - (g.R - 9) * Math.cos(-0.45)} ${g.by - (g.R - 9) * Math.sin(-0.45)}`}
          className="vx-tube-glint is-bulb"
        />
        {/* the scale: hurry zone, ticks, values */}
        {hot !== null ? <path d={`M${g.sx - 1} ${hot}V${lv0}`} className="vx-tube-hotzone" /> : null}
        {g.marks.map((m) => (
          <path key={`t${m.v}`} d={`M${g.sx} ${m.y.toFixed(2)}h${m.major ? 13 : 6}`} className={cx('vx-tube-tick', m.major && 'is-major')} />
        ))}
        {g.marks
          .filter((m) => m.major)
          .map((m) => (
            <text key={`l${m.v}`} x={g.sx + 19} y={m.y} dy=".35em" className="vx-tube-mark">
              {m.v}
            </text>
          ))}
      </svg>
      <div ref={col} className="vx-tube-col lq lq-band" style={{ left: g.cx - g.cw, width: g.cw * 2, top: g.yFull, height: g.by - g.yFull }} />
      <div ref={bulb} className="vx-tube-bulb lq lq-circle" style={{ left: g.cx - g.rb, top: g.by - g.rb, width: g.rb * 2, height: g.rb * 2 }} />
      <div ref={sec} className="vx-tube-sec vx-mono" style={{ right: g.W - (g.cx - g.tw - 14) }} aria-live="off">
        <b ref={secN}>{Math.round(p.total)}</b>
      </div>
    </div>
  );
}
