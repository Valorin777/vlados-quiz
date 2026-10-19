// GSAP choreography from the prototype, as reusable beats. Each beat takes elements and/or blobs
// and returns a timeline (kill it to stop). All beats degrade under reduced motion (shorter,
// no overshoot, fewer droplets) and work without the engine (tier 0: DOM parts only).
//
// Anchored blobs (useChromeBlob) are re-measured from their element every frame, so on those
// only dx, dy, sc, tar, glow and film are free to animate — move the ELEMENT to move the blob.
// Scene blobs (engine.add/circle/pill/rbox) can animate every field.

import { gsap } from 'gsap';
import { Flip } from 'gsap/Flip';
import { audio } from './audio';
import type { Blob, LiquidEngine } from './liquid';
import { TAU, clamp, dur, ease, lerp, reducedMotion, rnd } from './motion';

gsap.registerPlugin(Flip);

type Timeline = gsap.core.Timeline;
type Targets = Element | Element[] | null | undefined;

const list = (t: Targets): Element[] => (t ? (Array.isArray(t) ? t.filter(Boolean) : [t]) : []);

/** Split children rendered by <ChromeText split> (".ch" chars or ".wi" words), else the element itself. */
function glyphs(t: Targets): Element[] {
  const out: Element[] = [];
  for (const el of list(t)) {
    const parts = el.querySelectorAll('.ch, .wi');
    if (parts.length) out.push(...Array.from(parts));
    else out.push(el);
  }
  return out;
}

/** Momentary glow pulse on a blob. */
export function pulse(b: Blob | null | undefined, v = 0.6, d = 0.8): gsap.core.Tween | null {
  if (!b) return null;
  return gsap.fromTo(b, { glow: v }, { glow: 0, duration: dur(d), ease: 'power2.out', overwrite: 'auto' });
}

// ------------------------------------------------------------------ letters

/** Letters (or words) rise out of a slot with a stretched overshoot — the hero title beat. */
export function riseLetters(targets: Targets, o: { delay?: number; stagger?: number } = {}): Timeline {
  const els = glyphs(targets);
  const tl = gsap.timeline({ delay: o.delay ?? 0 });
  if (!els.length) return tl;
  if (reducedMotion()) {
    tl.fromTo(els, { opacity: 0, yPercent: 30 }, { opacity: 1, yPercent: 0, duration: 0.4, stagger: 0.02 });
    return tl;
  }
  tl.fromTo(
    els,
    { yPercent: 118, scaleY: 1.7, skewX: -10, opacity: 1 },
    { yPercent: 0, scaleY: 1, skewX: 0, duration: 1, ease: 'back.out(1.9)', stagger: o.stagger ?? 0.05 },
  );
  return tl;
}

/** Soft staggered fade-up for supporting copy. */
export function fadeUp(targets: Targets, o: { delay?: number; stagger?: number; y?: number } = {}): Timeline {
  const els = list(targets);
  return gsap
    .timeline({ delay: o.delay ?? 0 })
    .fromTo(els, { opacity: 0, y: o.y ?? 14 }, { opacity: 1, y: 0, duration: dur(0.6), stagger: o.stagger ?? 0.06, ease: 'power3.out' });
}

/** Elements pop in with a liquid elastic settle (buttons, fields, reaction chips). */
export function popIn(targets: Targets, o: { delay?: number; stagger?: number; from?: number } = {}): Timeline {
  return gsap
    .timeline({ delay: o.delay ?? 0 })
    .fromTo(list(targets), { scale: o.from ?? 0 }, { scale: 1, duration: dur(1.1), ease: ease.elastic, stagger: o.stagger ?? 0.1 });
}

/** Horizontal "no" shake (validation error). */
export function shake(target: Targets): gsap.core.Tween {
  return gsap.fromTo(list(target), { x: -10 }, { x: 0, duration: dur(0.6), ease: reducedMotion() ? 'power2.out' : 'elastic.out(1,0.3)' });
}

// ------------------------------------------------------------------ join

export interface JoinSplashOptions {
  /** the pool / core the guest falls into (scene blob or anchored) */
  core: Blob;
  /** where the droplet enters from (design units); default: above the core */
  from?: { x: number; y: number };
  /** the joining player is "you": bigger splash, flash, shine */
  big?: boolean;
  /** radius of the flying droplet */
  r?: number;
  onLand?: () => void;
}

/**
 * A mercury droplet arcs into the core with a comet tail, lands with a crown splash, ripple and
 * a wobble of the core. Without an engine only `onLand` fires (after the same delay).
 */
export function joinSplash(engine: LiquidEngine | null, o: JoinSplashOptions): Timeline {
  const tl = gsap.timeline();
  const T = dur(0.62);
  if (!engine) {
    tl.call(() => o.onLand?.(), undefined, T);
    return tl;
  }
  const c = o.core;
  const cx = () => c.x + c.dx;
  const cy = () => c.y + c.dy;
  const from = o.from ?? { x: cx() + (rnd() - 0.5) * 80, y: cy() - 260 };
  const r0 = o.r ?? (o.big ? 18 : 11);
  const d = engine.add({ x: from.x, y: from.y, r: r0, film: 0.6, prio: 1 });
  const p = { u: 0 };
  let px = from.x;
  let py = from.y;
  tl.to(p, {
    u: 1,
    duration: T,
    ease: 'power2.in',
    onUpdate: () => {
      const u = p.u;
      const x = lerp(from.x, cx(), u);
      const y = lerp(from.y, cy(), u) - Math.sin(u * Math.PI) * 60;
      const vx = x - px;
      const vy = y - py;
      const sp = Math.hypot(vx, vy);
      const L = sp > 0.5 ? Math.min(sp * (reducedMotion() ? 0.3 : 1.4), r0 * 2.4) : 0;
      d.x = x;
      d.y = y;
      d.ax = sp > 0.5 ? (-vx / sp) * L : 0;
      d.ay = sp > 0.5 ? (-vy / sp) * L : 0;
      d.r = lerp(r0, r0 * 0.7, u);
      px = x;
      py = y;
    },
  });
  tl.call(
    () => {
      const R = c.box ? Math.min(c.hw, c.hh) * c.sc : c.r * c.sc;
      engine.ripple(cx(), cy(), o.big ? 1.5 : 0.7);
      engine.splash(cx(), cy(), R, o.big ? 12 : 5, o.big);
      if (o.big) {
        engine.flash(0.3);
        audio.shine();
      }
      audio.drop(0.8 + rnd() * 0.5, 0.3);
      audio.ping(1 + rnd() * 0.5);
      o.onLand?.();
    },
    undefined,
    T,
  );
  tl.to(d, { r: 0, ax: 0, ay: 0, duration: 0.18, ease: 'power2.in', onComplete: () => engine.remove(d) }, T);
  tl.fromTo(c, { glow: o.big ? 1 : 0.35 }, { glow: 0, duration: dur(o.big ? 1.6 : 0.8), ease: 'power2.out' }, T);
  tl.fromTo(c, { sc: o.big ? 1.12 : 1.05 }, { sc: 1, duration: dur(0.9), ease: ease.elastic }, T);
  return tl;
}

/** A droplet falls into an (anchored) pool from above — the phone lobby's "someone joined". */
export function poolDrop(engine: LiquidEngine | null, pool: Blob | null, big = false): Timeline {
  const tl = gsap.timeline();
  if (!engine || !pool) return tl;
  const x = pool.x + (rnd() - 0.5) * pool.r * 0.8;
  const top = pool.y - pool.r - 70 - rnd() * 30;
  const d = engine.add({ x, y: top, r: 0, film: 0.65, prio: 1 });
  tl.to(d, { r: big ? 13 : 6 + rnd() * 3, duration: 0.12 }, 0);
  tl.to(d, { y: pool.y - pool.r * 0.3, duration: dur(0.5), ease: 'power2.in' }, 0);
  tl.to(d, { ay: -24, duration: 0.3, ease: 'power1.out' }, 0);
  tl.to(d, { r: 0, ay: 0, duration: 0.22, ease: 'power2.in', onComplete: () => engine.remove(d) }, dur(0.46));
  tl.call(
    () => {
      pulse(pool, big ? 0.8 : 0.3, 0.7);
      engine.ripple(pool.x, pool.y, big ? 0.9 : 0.3);
      audio.drop(0.9 + rnd() * 0.4, 0.25);
    },
    undefined,
    dur(0.46),
  );
  tl.fromTo(pool, { sc: big ? 1.1 : 1.04 }, { sc: 1, duration: dur(0.8), ease: ease.elastic }, dur(0.46));
  return tl;
}

// ------------------------------------------------------------------ answer

export interface AnswerCommitOptions {
  /** all option elements (buttons), in order */
  options: HTMLElement[];
  picked: number;
  /** blobs anchored to the options (glow on the picked one) */
  blobs?: (Blob | null | undefined)[];
  /** the "Ответ принят" orb (or a getter, if it mounts in `onMorph`); it grows out of the picked option */
  orb?: HTMLElement | null | (() => HTMLElement | null);
  /** fires when the orb should become visible (swap views here) */
  onMorph?: () => void;
}

/**
 * The picked option swells and glows, the others collapse into it like mercury beads, then the
 * orb blooms from the picked position with an elastic settle. Anchored blobs follow the moving
 * elements, so the liquid merges by itself.
 */
export function answerCommit(engine: LiquidEngine | null, o: AnswerCommitOptions): Timeline {
  const tl = gsap.timeline();
  const pickedEl = o.options[o.picked];
  if (!pickedEl) return tl;
  const pr = pickedEl.getBoundingClientRect();
  const pc = { x: pr.left + pr.width / 2, y: pr.top + pr.height / 2 };
  audio.drop(0.9, 0.45);
  audio.bell(330, 0.07, 1);
  tl.to(pickedEl, { scale: 1.06, duration: dur(0.35), ease: ease.back }, 0);
  pulse(o.blobs?.[o.picked], 0.6, 0.8);
  o.options.forEach((el, j) => {
    if (j === o.picked) return;
    const r = el.getBoundingClientRect();
    const label = el.querySelector('.vx-opt-label, .vx-opt-meta');
    if (label) tl.to(el.querySelectorAll('.vx-opt-label, .vx-opt-meta, .vx-opt-key'), { opacity: 0, duration: 0.18 }, 0);
    tl.to(
      el,
      {
        x: pc.x - (r.left + r.width / 2),
        y: pc.y - (r.top + r.height / 2),
        scale: 0.3,
        duration: dur(0.6),
        ease: 'power3.in',
      },
      0.08 + Math.abs(j - o.picked) * 0.06,
    );
  });
  const T = dur(0.72);
  tl.call(() => o.onMorph?.(), undefined, T);
  if (o.orb) {
    const get = o.orb;
    tl.add(() => {
      const orb = typeof get === 'function' ? get() : get;
      if (!orb) return;
      const r = orb.getBoundingClientRect();
      gsap.fromTo(
        orb,
        { x: pc.x - (r.left + r.width / 2), y: pc.y - (r.top + r.height / 2), scale: 0.3 },
        { x: 0, y: 0, scale: 1, duration: dur(1.1), ease: ease.elastic },
      );
      if (engine) {
        const c = engine.toLocal(pc.x, pc.y);
        engine.ripple(c.x, c.y, 0.8);
      }
    }, T);
  }
  return tl;
}

// ------------------------------------------------------------------ reveal

export interface MeltOptions {
  /** 'away' melts the blob off the bottom (TV options); 'sag' tarnishes + drips but stays */
  mode?: 'away' | 'sag';
  /** the option's label element: it smears and fades */
  label?: Element | null;
  /** element the blob is anchored to (sag mode moves it); omit for scene blobs */
  el?: HTMLElement | null;
  drips?: number;
  delay?: number;
}

/** Wrong answer: tarnish → sag → drip → (fall away). */
export function meltWrong(engine: LiquidEngine | null, b: Blob | null | undefined, o: MeltOptions = {}): Timeline {
  const tl = gsap.timeline({ delay: o.delay ?? 0 });
  const mode = o.mode ?? 'away';
  const rm = reducedMotion();
  tl.call(() => audio.melt(0.35), undefined, 0.35);
  if (b) tl.to(b, { tar: 1, film: 0.2, duration: dur(0.8), ease: 'power1.in' }, 0);
  if (o.el) tl.to(o.el, { y: rm ? 2 : 6, scaleY: rm ? 1 : 0.96, duration: dur(0.9), ease: 'sine.in' }, 0.4);
  if (o.label && mode === 'away') {
    tl.to(o.label, { y: 70, scaleY: 1.8, opacity: 0, filter: 'blur(5px)', duration: dur(0.9), ease: 'power2.in' }, 0.5);
  }
  if (b && mode === 'away') {
    const scene = !o.el;
    if (scene) {
      tl.to(b, { ay: 34, by: 34, duration: dur(0.55), ease: 'sine.in' }, 0.4);
      tl.to(b, { ax: -30, bx: 30, r: Math.max(8, b.r * 0.65), duration: dur(0.95), ease: 'power2.in' }, 0.6);
    }
    tl.to(b, { dy: 520, duration: dur(1.25), ease: 'power3.in' }, 0.75);
    tl.to(b, { sc: 0, duration: 0.35 }, 1.7);
  }
  if (engine && b) {
    const n = rm ? 1 : o.drips ?? (mode === 'away' ? 2 : 3);
    tl.call(
      () => {
        const x0 = b.x + b.dx;
        const y0 = b.y + b.dy;
        const half = b.box ? b.hw : Math.abs(b.bx - b.ax) / 2 + b.r;
        const bottom = y0 + (b.box ? b.hh : b.r) - 4;
        for (let k = 0; k < n; k++) {
          const x = x0 + (n === 1 ? 0 : lerp(-half * 0.6, half * 0.6, k / (n - 1))) + (rnd() - 0.5) * 12;
          drip(engine, x, bottom, { delay: k * 0.15, r: 6 + rnd() * 5 });
        }
      },
      undefined,
      0.7,
    );
  }
  return tl;
}

/** One hanging mercury drip that stretches and falls off the screen (tarnished by default). */
export function drip(engine: LiquidEngine, x: number, y: number, o: { r?: number; delay?: number; tar?: number } = {}): Timeline {
  const r = o.r ?? 9;
  const d = engine.add({ x, y, r: 0, tar: o.tar ?? 1, film: 0.2, prio: 1 });
  const tl = gsap.timeline({ delay: o.delay ?? 0, onComplete: () => engine.remove(d) });
  tl.to(d, { r, duration: 0.25, ease: 'power2.out' });
  tl.to(d, { by: 40 + rnd() * 30, duration: dur(0.8) + rnd() * 0.6, ease: 'sine.in' }, 0);
  tl.to(d, { y: engine.size.h + 80, duration: 1.1, ease: 'power2.in' }, dur(0.9) + rnd() * 0.3);
  return tl;
}

export interface IgniteOptions {
  label?: Element | null;
  /** width of the fountain base (design units) */
  width?: number;
  fountain?: boolean;
  delay?: number;
}

/** Correct answer: white flash, ripple, fountain of bright droplets, glow + iridescent film. */
export function igniteCorrect(engine: LiquidEngine | null, b: Blob | null | undefined, o: IgniteOptions = {}): Timeline {
  const tl = gsap.timeline({ delay: o.delay ?? 0 });
  tl.call(() => audio.shine(), undefined, 0);
  if (o.label) tl.fromTo(o.label, { scale: 1 }, { scale: 1.08, duration: dur(0.25), yoyo: true, repeat: 1, ease: 'power2.out' }, 0);
  if (!b) return tl;
  tl.to(b, { glow: 1, film: 0.75, duration: 0.12 }, 0);
  tl.to(b, { glow: 0.1, duration: dur(1.8), ease: 'power2.out' }, 0.15);
  tl.fromTo(b, { sc: 1 }, { sc: 1.08, duration: 0.2, yoyo: true, repeat: 1, ease: 'power2.out' }, 0);
  if (engine) {
    tl.call(
      () => {
        const x = b.x + b.dx;
        const y = b.y + b.dy;
        const top = y - (b.box ? b.hh : b.r);
        engine.flash(0.55);
        engine.ripple(x, y, 1.8);
        if (o.fountain !== false) {
          const w = o.width ?? (b.box ? b.hw * 1.6 : Math.abs(b.bx - b.ax) + b.r);
          engine.fountain(x, top + 4, w, 12, { sp: 680, r: 8.5, glow: 0.35 });
        }
      },
      undefined,
      0,
    );
  }
  return tl;
}

// ------------------------------------------------------------------ leaderboard

/**
 * FLIP reorder: capture positions, run `mutate` (must update the DOM synchronously — in React
 * wrap the state update in `flushSync`), then animate every row from where it was.
 */
export function flipReorder(
  targets: Element[] | string,
  mutate: () => void,
  o: { duration?: number; stagger?: number; onEnter?: (els: Element[]) => void } = {},
): Timeline {
  const state = Flip.getState(targets);
  mutate();
  return Flip.from(state, {
    duration: dur(o.duration ?? 1.1),
    ease: 'power3.inOut',
    stagger: o.stagger ?? 0.03,
    absolute: false,
    nested: true,
    onEnter: (els: Element[]) => {
      if (o.onEnter) o.onEnter(els);
      else gsap.fromTo(els, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: dur(0.5) });
    },
  }) as Timeline;
}

/**
 * The leaderboard beat: rows glide to their new ranks (FLIP), rank-change badges pop, the
 * viewer's own row glows. `deltas` are the `.vx-delta` badge elements to pop.
 */
export function boardReorder(o: {
  rows: Element[] | string;
  mutate: () => void;
  badges?: () => Element[];
  mine?: Blob | null;
}): Timeline {
  const tl = gsap.timeline();
  audio.drop(0.6, 0.45);
  audio.drop(0.9, 0.35, 0.15);
  tl.add(flipReorder(o.rows, o.mutate), 0);
  const badges = o.badges?.() ?? [];
  if (badges.length) tl.fromTo(badges, { scale: 0.3, opacity: 0 }, { scale: 1, opacity: 1, duration: dur(0.5), ease: ease.back, stagger: 0.02 }, 0.05);
  if (o.mine) tl.add(pulse(o.mine, 0.7, 1.1) ?? gsap.timeline(), dur(1.1));
  return tl;
}

// ------------------------------------------------------------------ podium

export interface PodiumColumn {
  /** centre x (design units) */
  x: number;
  /** column height above the floor */
  height: number;
  /**
   * DOM column, bottom-aligned on the floor (an anchored ChromeBlock): its height is animated,
   * so it also works on tier 0. Without it the column is a scene blob.
   */
  el?: HTMLElement | null;
  /** element riding the column top (name/score plate); translated to (x, top) in design units */
  label?: HTMLElement | null;
  /** DOM avatar already placed on the column top: it drops in with a bounce */
  avatarEl?: HTMLElement | null;
  /** or a scene blob avatar (x/y/r are driven) */
  avatar?: Blob | null;
  avatarR?: number;
}

export interface PodiumOptions {
  /** floor line (design units, y) */
  baseY: number;
  /** column half-width for scene-blob columns */
  halfWidth?: number;
  /** order of appearance by index into `cols` (default 3rd, 2nd, 1st: [2, 1, 0]) */
  order?: number[];
  /** a liquid floor slab (scene blob) */
  floor?: boolean;
  /** seconds between columns */
  gap?: number;
  onReveal?: (index: number) => void;
  /** fires at the climax (champion column erupts) */
  onClimax?: () => void;
}

/**
 * Podium: a mercury floor, columns grow one by one (3 → 2 → 1) with an overshoot, avatars bounce
 * onto them, and the champion's column erupts in a mercury fountain with a boom.
 * Returns the created scene blobs so the caller can remove them.
 */
export function podiumRise(engine: LiquidEngine | null, cols: PodiumColumn[], o: PodiumOptions): { tl: Timeline; blobs: Blob[] } {
  const tl = gsap.timeline();
  const blobs: Blob[] = [];
  const order = o.order ?? [2, 1, 0];
  const hw = o.halfWidth ?? 112;
  const base = o.baseY;
  const rm = reducedMotion();
  const gap = o.gap ?? 0.7;
  if (engine && o.floor !== false) {
    const floor = engine.rbox(engine.size.w / 2, base + 40, engine.size.w * 0.62, 0, 30, { film: 0.3 });
    blobs.push(floor);
    tl.to(floor, { hh: 56, duration: dur(1.2), ease: ease.elastic }, 0);
  }
  const state = cols.map((c) => {
    const s = { top: base, b: null as Blob | null };
    if (!c.el && engine) {
      s.b = engine.rbox(c.x, base, hw, 0, 20, { film: 0.34 });
      blobs.push(s.b);
    }
    if (c.el) c.el.style.height = '0px';
    if (c.label) gsap.set(c.label, { opacity: 0 });
    if (c.avatarEl) gsap.set(c.avatarEl, { opacity: 0 });
    return s;
  });
  const sync = () => {
    cols.forEach((c, k) => {
      const s = state[k];
      if (!s) return;
      const h = Math.max(0, base - s.top);
      if (c.el) c.el.style.height = `${h.toFixed(1)}px`;
      if (s.b) {
        s.b.y = base - h / 2 + 20;
        s.b.hh = h / 2 + 20;
      }
      if (c.label) c.label.style.transform = `translate3d(${c.x}px,${s.top.toFixed(1)}px,0)`;
    });
  };
  sync();
  tl.eventCallback('onUpdate', sync);
  let t = 0.5;
  order.forEach((k, step) => {
    const c = cols[k];
    const s = state[k];
    if (!c || !s) return;
    tl.call(() => audio.rise(0.55), undefined, t - 0.1);
    tl.to(s, { top: base - c.height, duration: rm ? 0.6 : 1, ease: rm ? 'power2.out' : 'back.out(1.5)' }, t);
    if (c.label) tl.to(c.label, { opacity: 1, duration: 0.5 }, t + 0.45);
    if (c.avatarEl) {
      tl.set(c.avatarEl, { opacity: 1 }, t + 0.46);
      tl.fromTo(c.avatarEl, { y: -base }, { y: 0, duration: dur(0.8), ease: ease.bounce, immediateRender: false }, t + 0.46);
    } else if (c.avatar && engine) {
      const a = c.avatar;
      const r = c.avatarR ?? 32;
      tl.call(() => Object.assign(a, { x: c.x, y: -60, r, tar: 0, glow: 0, sc: 1, ay: 0, by: 0, ax: 0, bx: 0, dx: 0, dy: 0 }), undefined, t + 0.45);
      tl.to(a, { y: base - c.height - r + 4, duration: dur(0.8), ease: ease.bounce }, t + 0.46);
    }
    tl.call(
      () => {
        audio.drop(0.6 - step * 0.08, 0.5);
        audio.bell([196, 247, 294][step] ?? 294, 0.12, 1.8);
        engine?.ripple(c.x, base - c.height, 0.8);
        o.onReveal?.(k);
      },
      undefined,
      t + 0.8,
    );
    t += gap;
  });
  const ci = order[order.length - 1] ?? 0;
  const champ = cols[ci];
  if (champ) {
    tl.call(
      () => {
        audio.boom();
        o.onClimax?.();
        if (!engine) return;
        const top = base - champ.height;
        engine.flash(0.55);
        engine.ripple(champ.x, top, 1.8);
        const sb = state[ci]?.b;
        if (sb) pulse(sb, 1, 2.2);
        if (champ.avatar) pulse(champ.avatar, 1, 2);
        mercuryFountain(engine, champ.x, top - 20, { n: 9 });
      },
      undefined,
      t + 0.35,
    );
  }
  return { tl, blobs };
}

/** Big celebratory eruption of mercury droplets. */
export function mercuryFountain(engine: LiquidEngine, x: number, y: number, o: { n?: number; width?: number } = {}): void {
  engine.fountain(x, y, o.width ?? 120, o.n ?? 9, { sp: 780, r: 11, spread: 1.6, g: 1500, life: 1.6, film: 0.6, glow: 0.2 });
}

// ------------------------------------------------------------------ numbers

/** Tween a number and report rounded values (drives <Odometer> / score counters). */
export function countTo(
  from: number,
  to: number,
  onValue: (v: number) => void,
  o: { duration?: number; step?: number; delay?: number } = {},
): gsap.core.Tween {
  const s = { v: from };
  const step = o.step ?? 1;
  return gsap.to(s, {
    v: to,
    duration: dur(o.duration ?? 1),
    delay: o.delay ?? 0,
    ease: 'power2.out',
    onUpdate: () => onValue(Math.round(s.v / step) * step),
  });
}

// ------------------------------------------------------------------ helpers for scenes

/** Place n points on a tilted ellipse ring (lobby constellation). */
export function orbitSlot(i: number, n: number, t: number, o: { cx: number; cy: number; rx: number; ry: number; tilt?: number; speed?: number; phase?: number }): { x: number; y: number; depth: number } {
  const th = (i / Math.max(1, n)) * TAU + t * (o.speed ?? 0.16) + (o.phase ?? 0);
  const X = Math.cos(th) * o.rx;
  const Y = Math.sin(th) * o.ry;
  const a = o.tilt ?? -0.17;
  return {
    x: o.cx + X * Math.cos(a) - Y * Math.sin(a),
    y: o.cy + X * Math.sin(a) + Y * Math.cos(a),
    depth: clamp((Math.sin(th) + 1) / 2, 0, 1),
  };
}
