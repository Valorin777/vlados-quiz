// Quality policy of the liquid renderer: device class, render resolution, the degradation ladder
// and the frame budget shared by every liquid stage on the page (the rehearsal runs a TV, a phone
// and the panel's own stage at once). Pure logic, no WebGL: unit-tested in quality.test.ts.
//
// Resolution rules
//  * TV profile and any stage on a desktop/laptop (fine pointer): the real device pixel ratio,
//    capped at 2, never below 1 canvas pixel per CSS pixel. A Retina MacBook renders at 2×.
//  * phones keep their tiers: tier 2 renders at the device ratio (cap 2, floor 1), tier 1 (weak
//    Android, data saver) at 0.6 → 0.45 as before.
//
// The governor lowers effects first (grain, agitation normals), then blob/droplet counts, and the
// resolution only as a last resort; phones may finally fall back a tier, the TV halves its frame
// rate instead. It recovers step by step (last dropped, first restored) with growing back-off.
// When the GPU time is measurable (EXT_disjoint_timer_query) it decides on GPU time, so a 30 Hz
// refresh (Safari Low Power Mode, a headless browser) never costs resolution; without timers a
// drop that does not speed frames up is undone and the governor holds (capped / CPU-bound page).

import type { Profile, Tier } from './types';

export type DeviceClass = 'hi' | 'phone';

export interface TierCfg {
  /** max blobs drawn (uniform array size) */
  cap: number;
  /** frame-rate cap */
  fps: number;
  /** max live droplets */
  fx: number;
  /** cheap shader variant (no grain, no agitation normals) */
  low: boolean;
}

export const TIERS: Record<1 | 2 | 3, TierCfg> = {
  1: { cap: 12, fps: 30, fx: 4, low: true },
  2: { cap: 24, fps: 60, fx: 10, low: false },
  3: { cap: 72, fps: 60, fx: 18, low: false },
};

/** Desktop / laptop / iPad with a trackpad: renders at full resolution like the TV. */
export function finePointer(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches;
  } catch {
    return false;
  }
}

export function deviceClass(profile: Profile, fine: boolean): DeviceClass {
  return profile === 'tv' || fine ? 'hi' : 'phone';
}

/** Canvas pixels per on-screen CSS pixel: the best (base) and the lowest allowed (floor). */
export function dprRange(cls: DeviceClass, tier: 1 | 2 | 3, dev: number): { base: number; floor: number } {
  const d = Number.isFinite(dev) && dev > 0 ? dev : 1;
  if (cls === 'hi' || tier >= 2) return { base: Math.min(d, 2), floor: Math.min(d, 1) };
  return { base: Math.min(d, 0.6), floor: Math.min(d, 0.45) };
}

/** One rung of the ladder; dprK scales the base ratio (clamped to the floor). */
export interface Step {
  dprK: number;
  low: boolean;
  capK: number;
  fxK: number;
  fps: number;
}

const FULL: Step = { dprK: 1, low: false, capK: 1, fxK: 1, fps: 60 };
const LITE: Step = { ...FULL, low: true };
const FEW: Step = { ...LITE, capK: 0.75, fxK: 0.5 };

const HI_LADDER: Step[] = [
  FULL,
  LITE,
  FEW,
  { ...FEW, dprK: 0.85 },
  { ...FEW, dprK: 0.72 },
  { ...FEW, dprK: 0.6 },
  { ...FEW, dprK: 0 },
  // below one pixel per CSS pixel the TV would look like a phone photo of itself: fewer frames
  { ...FEW, dprK: 0, fps: 30 },
];
const PHONE_LADDER: Step[] = [FULL, LITE, FEW, { ...FEW, dprK: 0.8 }, { ...FEW, dprK: 0.65 }, { ...FEW, dprK: 0 }];
const PHONE_T1_LADDER: Step[] = [LITE, { ...LITE, dprK: 0.87 }, { ...LITE, dprK: 0 }];

export function ladder(cls: DeviceClass, tier: 1 | 2 | 3): Step[] {
  if (cls === 'hi') return HI_LADDER;
  return tier === 1 ? PHONE_T1_LADDER : PHONE_LADDER;
}

export interface Quality {
  dpr: number;
  low: boolean;
  cap: number;
  fx: number;
  fps: number;
}

export function quality(cls: DeviceClass, tier: 1 | 2 | 3, lv: number, dev: number): Quality {
  const steps = ladder(cls, tier);
  const st = steps[Math.max(0, Math.min(steps.length - 1, lv))] as Step;
  const cfg = TIERS[tier];
  const { base, floor } = dprRange(cls, tier, dev);
  const dpr = Math.max(floor, Math.min(base, base * st.dprK));
  return {
    dpr: Math.round(dpr * 1000) / 1000,
    low: cfg.low || st.low,
    // UI anchors are packed first (prio 0); fewer slots drop droplets and scene blobs first
    cap: Math.max(Math.min(cfg.cap, 12), Math.round(cfg.cap * st.capK)),
    fx: Math.max(2, Math.round(cfg.fx * st.fxK)),
    fps: Math.min(cfg.fps, st.fps),
  };
}

export function sameQuality(a: Quality, b: Quality): boolean {
  return Math.abs(a.dpr - b.dpr) < 1e-3 && a.low === b.low && a.cap === b.cap && a.fx === b.fx && a.fps === b.fps;
}

/** The next level from `lv` in direction `dir` that actually changes something (null: none). */
export function nextLevel(cls: DeviceClass, tier: 1 | 2 | 3, lv: number, dir: 1 | -1, dev: number): number | null {
  const steps = ladder(cls, tier);
  const cur = quality(cls, tier, lv, dev);
  for (let l = lv + dir; l >= 0 && l < steps.length; l += dir) {
    if (!sameQuality(quality(cls, tier, l, dev), cur)) return l;
  }
  return null;
}

// ------------------------------------------------------------------ shared frame budget

/** One liquid stage as the budget sees it. */
export interface Member {
  /** TV 3 · phone preview 2 · full-page stage 1: the least important degrades first */
  readonly importance: number;
  /** device pixels per frame right now (the cost proxy) */
  pixels(): number;
  /** drew during the current window (visible, not paused, not covered) */
  active(): boolean;
  /** the next degrade step lowers resolution (effects go first, across all stages) */
  nextIsResolution(): boolean;
  canDegrade(): boolean;
  degrade(): boolean;
  recover(): boolean;
  /** GPU ms per drawn frame over the window (null: no timer on this context); resets it */
  takeGpu(): number | null;
  /** hopeless: static CSS chrome (tier 0) */
  drop(): void;
  /** window result (frame ms, GPU ms) for stats */
  report(frameMs: number, gpuMs: number | null): void;
}

export interface BudgetOpts {
  now?: () => number;
}

/** Frame-interval thresholds (ms) without GPU timers. */
export const SLOW = 24;
export const FAST = 18.5;
/** With GPU timers: frames late beyond LATE and the liquid draws a real share of them (GPU ms). */
export const LATE = 20;
export const GPU_OVER = 12;
export const GPU_UNDER = 8;

export class Budget {
  readonly members = new Set<Member>();
  private readonly now: () => number;
  private hist: Member[] = [];
  private lastFrame = -1;
  private lastT = 0;
  private drewNow = false;
  private n = 0;
  private sum = 0;
  private fast = 0;
  private lastDrop = -Infinity;
  private lastRecover = -Infinity;
  private backoff = 8000;
  private probe: { before: number; steps: number } | null = null;
  private futile = 0;
  private holdUntil = -Infinity;
  private holdAvg = 0;
  private holdMs = 30_000;
  private hopeless = 0;
  /** last decision, for tests and the Lab */
  last = '';

  constructor(o: BudgetOpts = {}) {
    this.now = o.now ?? (() => performance.now());
  }

  add(m: Member): () => void {
    this.members.add(m);
    return () => {
      this.members.delete(m);
      this.hist = this.hist.filter((x) => x !== m);
    };
  }

  /** Once per animation frame (every member calls it; the first call of a frame counts). */
  frame(id: number, t: number): void {
    if (id === this.lastFrame) return;
    this.lastFrame = id;
    const dt = t - this.lastT;
    this.lastT = t;
    const drew = this.drewNow;
    this.drewNow = false;
    // the interval after a drawn frame: did that frame make it in time?
    if (drew && dt > 0 && dt < 250) this.sample(dt);
  }

  /** A member drew in the current frame. */
  drew(): void {
    this.drewNow = true;
  }

  /** Forget the running window (page hidden, tab switch): stale intervals would read as jank. */
  reset(): void {
    this.n = this.sum = 0;
    this.drewNow = false;
  }

  sample(ms: number): void {
    this.sum += ms;
    // a window is 90 frames (1.5 s at 60 fps) or 1.5 s of frames, whichever comes first: on a
    // struggling device (10–15 fps) a frame-count window would take 6–9 s per governor step
    if (++this.n < 90 && (this.sum < 1500 || this.n < 16)) return;
    const avg = this.sum / this.n;
    this.n = this.sum = 0;
    this.window(avg);
  }

  /** One governor decision from a window's average frame interval. */
  window(avg: number): void {
    const now = this.now();
    const act = [...this.members].filter((m) => m.active());
    let gpu: number | null = act.length ? 0 : null;
    for (const m of this.members) {
      const g = m.takeGpu();
      if (!act.includes(m)) continue;
      if (g === null || gpu === null) gpu = null;
      else gpu += g;
    }
    for (const m of act) m.report(avg, gpu);
    if (!act.length) return;
    const timed = gpu !== null;
    const g = gpu ?? 0;
    // timed: late frames count only when the liquid draws are a real share of them (≥ 40 % of the
    // interval, or GPU_OVER) — a page busy elsewhere keeps its crisp chrome
    const over = timed ? avg > LATE && g > Math.min(GPU_OVER, avg * 0.4) : avg > SLOW;
    const severe = timed ? over && g > 22 : avg > 40;
    // headroom: cheap draws, or frames on time with the draws well under GPU_OVER (a GPU that
    // clocks down when lightly loaded reads a few ms slower than it is)
    const under = timed ? g < GPU_UNDER || (avg < FAST && g < GPU_OVER * 0.75) : avg < FAST;

    // without timers: did the last drops speed frames up?
    if (!timed && this.probe) {
      if (avg < this.probe.before * 0.92) {
        this.probe = null;
        this.futile = 0;
      } else if (over) this.futile++;
    }

    if (over) {
      this.fast = 0;
      if (!timed && this.probe && this.futile >= 4) {
        // four drops, frames just as slow: the time goes elsewhere (a 30 Hz refresh, a busy
        // page) — give the quality back and hold
        for (let k = this.probe.steps; k > 0; k--) this.recoverLast();
        this.probe = null;
        this.futile = 0;
        this.holdUntil = now + this.holdMs;
        this.holdAvg = avg;
        this.holdMs = Math.min(this.holdMs * 2, 300_000);
        this.last = 'hold';
        return;
      }
      if (!timed && now < this.holdUntil && avg < this.holdAvg * 1.25) {
        this.last = 'held';
        return;
      }
      if (now - this.lastRecover < 10_000) this.backoff = Math.min(this.backoff * 2, 120_000);
      let steps = 0;
      for (let k = severe ? 2 : 1; k > 0; k--) if (this.degradeOne(act)) steps++;
      if (steps) {
        this.lastDrop = now;
        this.hopeless = 0;
        if (!timed) {
          this.probe ??= { before: avg, steps: 0 };
          this.probe.steps += steps;
        }
        this.last = `degrade ${steps}`;
        return;
      }
      // nothing left to lower
      if (avg > 45 && (timed ? g > GPU_OVER : now >= this.holdUntil) && ++this.hopeless >= 2) {
        this.hopeless = 0;
        const victim = act.reduce((a, b) => (b.importance < a.importance ? b : a));
        victim.drop();
        this.members.delete(victim);
        this.hist = this.hist.filter((x) => x !== victim);
        this.last = 'drop';
        return;
      }
      this.last = 'floor';
      return;
    }
    this.hopeless = 0;
    if (under) {
      if (!timed && avg < FAST) this.holdUntil = -Infinity;
      if (++this.fast >= 3 && now - this.lastDrop > this.backoff && now - this.lastRecover > 3000) {
        this.fast = 0;
        if (this.recoverLast()) {
          this.lastRecover = now;
          this.probe = null;
          this.futile = 0;
          this.last = 'recover';
          return;
        }
      }
      this.last = 'fast';
      return;
    }
    this.fast = 0;
    this.last = 'ok';
  }

  private degradeOne(act: Member[]): boolean {
    const can = act.filter((m) => m.canDegrade());
    if (!can.length) return false;
    const fx = can.filter((m) => !m.nextIsResolution());
    const pool = fx.length ? fx : can;
    const victim = pool.reduce((a, b) => (b.pixels() / b.importance > a.pixels() / a.importance ? b : a));
    if (!victim.degrade()) return false;
    this.hist.push(victim);
    return true;
  }

  private recoverLast(): boolean {
    while (this.hist.length) {
      const m = this.hist.pop() as Member;
      if (this.members.has(m) && m.recover()) return true;
    }
    return false;
  }
}

/** The page-wide budget every engine joins. */
export const budget = new Budget();
