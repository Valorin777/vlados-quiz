import { gsap } from 'gsap';
import { useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { audio } from '../audio';
import { joinSplash } from '../beats';
import { useChromeBlob, useLiquid, type Blob } from '../liquid';
import { TAU, backOut, clamp, lerp, reducedMotion, rnd } from '../motion';
import { cx, initialOf } from './util';

export interface OrbitPlayer {
  id: string;
  name: string;
  src?: string | null;
}

export interface AvatarOrbitProps {
  /** players in join order; new ids fly in */
  players: readonly OrbitPlayer[];
  /** highlighted player (bigger, iridescent) */
  highlightId?: string | null;
  /** content in the core (e.g. the joined count) */
  children?: ReactNode;
  /** a new player landed in the core */
  onLand?: (p: OrbitPlayer) => void;
  className?: string;
  style?: CSSProperties;
}

const RINGS = [
  { cap: 14, f: 0.44, speed: 0.16, size: 44, phase: 0 },
  { cap: 26, f: 0.64, speed: -0.09, size: 38, phase: 0.11 },
  { cap: 38, f: 0.82, speed: 0.06, size: 32, phase: 0.3 },
  { cap: 60, f: 0.97, speed: -0.045, size: 28, phase: 0.5 },
];
const AV = 44; // element box; scaled per ring/depth

interface Meta {
  el: HTMLDivElement | null;
  mode: 'join' | 'orbit';
  t0: number;
  from: { x: number; y: number };
  launched: boolean;
  landed: boolean;
  /** last written styles: only touch the DOM when they change (40+ avatars per frame on TV) */
  tr: string;
  op: string;
  z: string;
}

const fresh = (): Meta => ({ el: null, mode: 'orbit', t0: 0, from: { x: 0, y: 0 }, launched: true, landed: true, tr: '', op: '', z: '' });

function slot(i: number, n: number, t: number, W: number, H: number): { x: number; y: number; s: number } {
  let k = i;
  let r = 0;
  let before = 0;
  while (r < RINGS.length - 1 && k >= (RINGS[r] as (typeof RINGS)[number]).cap) {
    k -= (RINGS[r] as (typeof RINGS)[number]).cap;
    before += (RINGS[r] as (typeof RINGS)[number]).cap;
    r++;
  }
  const ring = RINGS[r] as (typeof RINGS)[number];
  const inRing = Math.max(1, Math.min(ring.cap, n - before));
  const th = (k / inRing) * TAU + t * ring.speed + ring.phase;
  const X = Math.cos(th) * (W / 2) * ring.f;
  const Y = Math.sin(th) * (H / 2) * ring.f * 0.92;
  const a = -0.17;
  const depth = (Math.sin(th) + 1) / 2;
  return {
    x: W / 2 + X * Math.cos(a) - Y * Math.sin(a),
    y: H / 2 + X * Math.sin(a) + Y * Math.cos(a),
    s: (ring.size / AV) * (0.84 + 0.24 * depth),
  };
}

function OrbitSat({ set }: { set: (el: HTMLDivElement | null) => void }) {
  const el = useRef<HTMLDivElement | null>(null);
  useChromeBlob(el, { shape: 'circle', film: 0.6, prio: 0 });
  return (
    <div
      ref={(n) => {
        el.current = n;
        set(n);
      }}
      className="vx-orbit-sat lq lq-circle"
      aria-hidden="true"
    />
  );
}

function OrbitAvatar({ p, hi, setEl }: { p: OrbitPlayer; hi: boolean; setEl: (id: string, el: HTMLDivElement | null) => void }) {
  const el = useRef<HTMLDivElement | null>(null);
  useChromeBlob(el, { shape: 'circle', film: hi ? 0.9 : 0.3, prio: 1, appear: 'instant' });
  return (
    <div
      ref={(n) => {
        el.current = n;
        setEl(p.id, n);
      }}
      className={cx('vx-orbit-av lq lq-circle', hi && 'is-hi')}
      data-tone={hi ? 'film' : undefined}
      title={p.name}
    >
      {p.src ? <img src={p.src} alt="" draggable={false} /> : <b className="vx-eng">{initialOf(p.name)}</b>}
    </div>
  );
}

/**
 * TV lobby constellation: a mercury core that swells with every guest, satellites, and rings of
 * chrome avatars orbiting on a tilted ellipse. New guests arc in as comets, splash into the core
 * and swing out to their slot.
 */
export function AvatarOrbit({ players, highlightId, children, onLand, className, style }: AvatarOrbitProps) {
  const { engine } = useLiquid();
  const box = useRef<HTMLDivElement | null>(null);
  const core = useRef<HTMLDivElement | null>(null);
  const sats = useRef<(HTMLDivElement | null)[]>([]);
  const coreBlob = useRef<Blob | null>(null);
  useChromeBlob(core, { shape: 'circle', film: 0.42, out: coreBlob, prio: 0 });
  const meta = useRef(new Map<string, Meta>());
  const known = useRef<Set<string> | null>(null);
  const order = useRef<OrbitPlayer[]>([]);
  order.current = players.slice();
  const land = useRef(onLand);
  land.current = onLand;

  const setEl = (id: string, el: HTMLDivElement | null) => {
    const m = meta.current.get(id);
    if (m) m.el = el;
    else meta.current.set(id, { ...fresh(), el });
  };

  // detect arrivals (the first render's players are already in orbit)
  useLayoutEffect(() => {
    const first = known.current === null;
    const set = known.current ?? new Set<string>();
    const W = box.current?.clientWidth ?? 800;
    const H = box.current?.clientHeight ?? 600;
    for (const p of players) {
      if (set.has(p.id)) continue;
      set.add(p.id);
      const m = meta.current.get(p.id) ?? fresh();
      if (!first) {
        const an = (rnd() - 0.5) * Math.PI * 1.1;
        m.mode = 'join';
        m.t0 = performance.now();
        m.launched = false;
        m.landed = false;
        m.from = { x: W / 2 + Math.cos(an) * W * 0.75, y: H / 2 + Math.sin(an) * H * 0.7 };
      }
      meta.current.set(p.id, m);
    }
    for (const id of Array.from(set)) if (!players.some((p) => p.id === id)) set.delete(id);
    known.current = set;
  }, [players]);

  // core size follows the crowd
  useEffect(() => {
    const c = core.current;
    const b = box.current;
    if (!c || !b) return;
    const m = Math.min(b.clientWidth, b.clientHeight);
    const d = clamp(m * 0.26 + players.length * 0.9, m * 0.24, m * 0.42);
    gsap.to(c, { width: d, height: d, duration: 1.1, ease: reducedMotion() ? 'power2.out' : 'elastic.out(1,0.5)' });
  }, [players.length]);

  // box size, cached: reading clientWidth in the tick would force a layout every frame
  const size = useRef({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const b = box.current;
    if (!b) return;
    size.current = { w: b.clientWidth, h: b.clientHeight };
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(() => {
      size.current = { w: b.clientWidth, h: b.clientHeight };
    });
    ro.observe(b);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const tick = () => {
      const b = box.current;
      if (!b) return;
      const W = size.current.w;
      const H = size.current.h;
      if (!W || !H) return;
      // all reads before any write (the core's size is tweened inline by GSAP)
      const c = core.current;
      const R = c ? (parseFloat(c.style.width) || c.offsetWidth) / 2 : 60;
      const rm = reducedMotion();
      const now = performance.now();
      const t = rm ? 0 : now / 1000;
      const list = order.current;
      const n = list.length;
      const JOIN = rm ? 700 : 1300;
      list.forEach((p, i) => {
        const m = meta.current.get(p.id);
        const el = m?.el;
        if (!m || !el) return;
        const s = slot(i, n, t, W, H);
        let x = s.x;
        let y = s.y;
        let sc = s.s * (p.id === highlightId ? 1.25 : 1);
        let op = 1;
        if (m.mode === 'join') {
          const u = (now - m.t0) / JOIN;
          if (u < 0.46) {
            if (engine && coreBlob.current) {
              // in flight: a comet droplet drawn by the engine; the avatar waits inside the core
              x = W / 2;
              y = H / 2;
              sc = 0.001;
              if (!m.launched) {
                m.launched = true;
                m.landed = true;
                const r = engine.measure(b);
                const u2 = r.w / Math.max(1, W);
                joinSplash(engine, {
                  core: coreBlob.current,
                  from: { x: r.x - r.w / 2 + m.from.x * u2, y: r.y - r.h / 2 + m.from.y * u2 },
                  big: p.id === highlightId,
                  onLand: () => land.current?.(p),
                });
              }
            } else {
              op = clamp(u / 0.2, 0, 1);
              const k = Math.pow(u / 0.46, 2);
              x = lerp(m.from.x, W / 2, k);
              y = lerp(m.from.y, H / 2, k) - Math.sin(k * Math.PI) * 70;
              sc = lerp(0.6, 0.3, k);
            }
          } else {
            if (!m.landed) {
              m.landed = true;
              audio.drop(0.9, 0.3);
              land.current?.(p);
            }
            const k = backOut(clamp((u - 0.46) / 0.54, 0, 1));
            x = lerp(W / 2, s.x, k);
            y = lerp(H / 2, s.y, k);
            sc = lerp(0.3, sc, clamp(k, 0, 1.2));
            if (u >= 1) m.mode = 'orbit';
          }
        }
        const tr = `translate3d(${(x - AV / 2).toFixed(1)}px,${(y - AV / 2).toFixed(1)}px,0) scale(${sc.toFixed(3)})`;
        const o = op.toFixed(2);
        const z = String(Math.round(sc * 20));
        if (tr !== m.tr) el.style.transform = m.tr = tr;
        if (o !== m.op) el.style.opacity = m.op = o;
        if (z !== m.z) el.style.zIndex = m.z = z;
      });
      // satellites circling the core
      sats.current.forEach((sEl, k) => {
        if (!sEl) return;
        const a = t * (k ? -0.7 : 0.95) + k * 2.2;
        const rr = R * 0.78;
        sEl.style.transform = `translate3d(${(W / 2 + Math.cos(a) * rr - 20).toFixed(1)}px,${(H / 2 + Math.sin(a) * rr * 0.85 - 20).toFixed(1)}px,0) scale(${((R * (k ? 0.34 : 0.4)) / 20).toFixed(3)})`;
      });
    };
    tick();
    // prioritized: positions are written before the liquid engine measures them this frame
    gsap.ticker.add(tick, false, true);
    return () => gsap.ticker.remove(tick);
  }, [engine, highlightId]);

  return (
    <div ref={box} className={cx('vx-orbit', className)} style={style}>
      <OrbitSat set={(n) => (sats.current[0] = n)} />
      <OrbitSat set={(n) => (sats.current[1] = n)} />
      <div ref={core} className="vx-orbit-core lq lq-circle">
        {children}
      </div>
      {players.map((p) => (
        <OrbitAvatar key={p.id} p={p} hi={p.id === highlightId} setEl={setEl} />
      ))}
    </div>
  );
}
