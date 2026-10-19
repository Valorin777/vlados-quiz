// The Lab's hero sculpture: a mercury mother drop with satellites on Lissajous orbits. They pass
// close, fuse (metaball necks), tear apart again and stretch along their velocity; the nearest one
// reaches for the pointer / finger; a tap throws a crown splash. Scene blobs on the page's liquid
// stage when the engine is live; CSS chrome spheres on the same paths at tier 0.

import { gsap } from 'gsap';
import { useEffect, useRef, useState } from 'react';
import { audio, onReducedMotion, reducedMotion, useLiquid, type Blob } from '../../visual';

interface DropDef {
  /** radius, fraction of min(w, h) */
  r: number;
  film: number;
  /** Lissajous amplitude (fraction of w / h) and angular speeds */
  ax: number;
  ay: number;
  wx: number;
  wy: number;
  ph: number;
}

const MOTHER = { x: 0.5, y: 0.53, r: 0.25 };
const DROPS: DropDef[] = [
  { r: 0.105, film: 0.9, ax: 0.36, ay: 0.3, wx: 0.53, wy: 0.81, ph: 0.3 },
  { r: 0.07, film: 0.75, ax: 0.41, ay: 0.36, wx: -0.37, wy: 0.59, ph: 2.1 },
  { r: 0.085, film: 0.6, ax: 0.3, ay: 0.38, wx: 0.71, wy: -0.43, ph: 4.0 },
  { r: 0.05, film: 0.95, ax: 0.44, ay: 0.24, wx: -0.62, wy: -0.97, ph: 1.2 },
  { r: 0.06, film: 0.5, ax: 0.22, ay: 0.4, wx: 0.9, wy: 0.44, ph: 5.1 },
  { r: 0.038, film: 0.85, ax: 0.46, ay: 0.42, wx: 0.31, wy: -0.66, ph: 3.3 },
];

interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export function HeroDrops({ className }: { className?: string }) {
  const { engine, ready } = useLiquid();
  const box = useRef<HTMLDivElement | null>(null);
  const dom = useRef<(HTMLSpanElement | null)[]>([]);
  const [rm, setRm] = useState(reducedMotion);
  const kick = useRef(0);
  const pointer = useRef<{ x: number; y: number; on: boolean }>({ x: 0, y: 0, on: false });

  useEffect(() => onReducedMotion(setRm), []);

  useEffect(() => {
    const el = box.current;
    if (!el || !ready) return;
    let visible = true;
    const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver(([e]) => (visible = !!e?.isIntersecting), { rootMargin: '80px' }) : null;
    io?.observe(el);

    const all = [{ ...DROPS[0], r: MOTHER.r } as DropDef, ...DROPS];
    const bodies: Body[] = all.map(() => ({ x: 0, y: 0, vx: 0, vy: 0 }));
    const blobs: (Blob | null)[] = engine
      ? all.map((d, i) => engine.circle(0, 0, 0, { film: i === 0 ? 0.42 : d.film, prio: 1, sc: 0 }))
      : [];
    // pour in: the mother first, satellites bead off it
    blobs.forEach((b, i) => b && gsap.to(b, { sc: 1, duration: rm ? 0.3 : 1.1, ease: rm ? 'power2.out' : 'elastic.out(1,0.5)', delay: 0.25 + i * 0.09 }));
    let t = 0;
    let last = performance.now();
    let first = true;

    const tick = () => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!visible || document.hidden) return;
      const calm = reducedMotion();
      t += dt * (calm ? 0.12 : 1) * (1 + kick.current * 2.5);
      kick.current *= Math.exp(-dt * 2.2);
      // box in stage units (engine) or its own px (tier 0)
      const r = engine ? engine.measure(el) : { x: el.clientWidth / 2, y: el.clientHeight / 2, w: el.clientWidth, h: el.clientHeight };
      const ox = r.x - r.w / 2;
      const oy = r.y - r.h / 2;
      const m = Math.min(r.w, r.h);
      const p = pointer.current;
      // pointer in the same space
      let px = 0;
      let py = 0;
      if (p.on) {
        if (engine) {
          const q = engine.toLocal(p.x, p.y);
          px = q.x;
          py = q.y;
        } else {
          const b = el.getBoundingClientRect();
          px = p.x - b.left;
          py = p.y - b.top;
        }
      }
      // who reaches for the pointer: the satellite nearest to it
      let reach = -1;
      if (p.on) {
        let best = Infinity;
        for (let i = 1; i < all.length; i++) {
          const bd = bodies[i] as Body;
          const d = Math.hypot(bd.x - px, bd.y - py);
          if (d < best) {
            best = d;
            reach = i;
          }
        }
      }
      all.forEach((d, i) => {
        const bd = bodies[i] as Body;
        let tx: number;
        let ty: number;
        let rad: number;
        if (i === 0) {
          const breathe = 1 + Math.sin(t * 1.3) * 0.035;
          tx = ox + r.w * MOTHER.x + Math.sin(t * 0.4) * m * 0.03;
          ty = oy + r.h * MOTHER.y + Math.cos(t * 0.53) * m * 0.025;
          rad = m * MOTHER.r * breathe;
        } else {
          tx = ox + r.w * (0.5 + d.ax * Math.cos(t * d.wx + d.ph));
          ty = oy + r.h * (0.53 + d.ay * Math.sin(t * d.wy + d.ph * 1.7));
          rad = m * d.r;
          if (i === reach) {
            tx = tx + (px - tx) * 0.8;
            ty = ty + (py - ty) * 0.8;
          }
        }
        if (first) {
          bd.x = tx;
          bd.y = ty;
        }
        // critically-underdamped spring: liquid lag and a little wobble
        const k = i === 0 ? 60 : 34;
        const c = calm ? 14 : i === reach ? 7 : 9;
        bd.vx += ((tx - bd.x) * k - bd.vx * c) * dt;
        bd.vy += ((ty - bd.y) * k - bd.vy * c) * dt;
        bd.x += bd.vx * dt;
        bd.y += bd.vy * dt;
        const b = blobs[i];
        if (b) {
          // stretch along the velocity, thinning a touch to keep the volume
          const sp = Math.hypot(bd.vx, bd.vy);
          const L = sp > 4 ? Math.min(sp * 0.035, rad * 1.3) : 0;
          const ux = sp > 4 ? bd.vx / sp : 0;
          const uy = sp > 4 ? bd.vy / sp : 0;
          b.x = bd.x;
          b.y = bd.y;
          b.ax = -ux * L * 0.5;
          b.ay = -uy * L * 0.5;
          b.bx = ux * L * 0.5;
          b.by = uy * L * 0.5;
          b.r = rad * (1 - (0.18 * L) / Math.max(rad, 1));
        } else {
          const s = dom.current[i];
          if (s) s.style.transform = `translate3d(${(bd.x - rad).toFixed(1)}px,${(bd.y - rad).toFixed(1)}px,0) scale(${((rad * 2) / 100).toFixed(3)})`;
        }
      });
      first = false;
    };
    tick();
    gsap.ticker.add(tick, false, true);
    return () => {
      gsap.ticker.remove(tick);
      io?.disconnect();
      if (engine) for (const b of blobs) if (b) engine.remove(b);
    };
  }, [engine, ready, rm]);

  const splash = (clientX: number, clientY: number) => {
    audio.unlock();
    audio.drop(0.55 + Math.random() * 0.3, 0.45);
    kick.current = 1;
    const el = box.current;
    if (!engine || !el) {
      audio.shine();
      return;
    }
    const r = engine.measure(el);
    const m = Math.min(r.w, r.h);
    const cx = r.x + r.w * (MOTHER.x - 0.5);
    const cy = r.y + r.h * (MOTHER.y - 0.5);
    const q = engine.toLocal(clientX, clientY);
    engine.ripple(q.x, q.y, 1.2);
    engine.splash(cx, cy, m * MOTHER.r, 9, true);
    engine.flash(0.18);
    audio.shine();
  };

  return (
    <div
      ref={box}
      className={`lab-sculpt${engine ? ' is-live' : ''}${className ? ` ${className}` : ''}`}
      role="button"
      tabIndex={0}
      aria-label="Ртутная капля — коснись, чтобы брызнуть"
      onPointerMove={(e) => {
        pointer.current = { x: e.clientX, y: e.clientY, on: e.pointerType === 'mouse' || e.buttons > 0 };
      }}
      onPointerDown={(e) => {
        pointer.current = { x: e.clientX, y: e.clientY, on: true };
      }}
      onPointerLeave={() => {
        pointer.current.on = false;
      }}
      onPointerUp={(e) => {
        if (e.pointerType !== 'mouse') pointer.current.on = false;
      }}
      onClick={(e) => splash(e.clientX, e.clientY)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        const b = e.currentTarget.getBoundingClientRect();
        splash(b.left + b.width / 2, b.top + b.height / 2);
      }}
    >
      {engine
        ? null
        : [MOTHER, ...DROPS].map((d, i) => (
            <span
              key={i}
              ref={(n) => {
                dom.current[i] = n;
              }}
              className="lab-drop lq lq-circle"
              aria-hidden="true"
            />
          ))}
    </div>
  );
}
