import { describe, expect, it } from 'vitest';
import { Budget, deviceClass, dprRange, ladder, nextLevel, quality, type DeviceClass, type Member } from './quality';

describe('liquid quality: resolution', () => {
  it('renders the TV and laptops at the device ratio, capped at 2, never below 1 px per CSS px', () => {
    expect(deviceClass('tv', false)).toBe('hi');
    expect(deviceClass('phone', true)).toBe('hi');
    expect(deviceClass('phone', false)).toBe('phone');
    expect(dprRange('hi', 3, 2)).toEqual({ base: 2, floor: 1 });
    expect(dprRange('hi', 3, 3)).toEqual({ base: 2, floor: 1 });
    expect(dprRange('hi', 2, 1)).toEqual({ base: 1, floor: 1 });
    expect(dprRange('hi', 1, 2)).toEqual({ base: 2, floor: 1 });
    expect(quality('hi', 3, 0, 2)).toEqual({ dpr: 2, low: false, cap: 72, fx: 18, fps: 60 });
    // a Retina MacBook: the TV frame and the phone frame of the rehearsal both at 2×
    expect(quality('hi', 2, 0, 2).dpr).toBe(2);
  });

  it('keeps the phone tiers: tier 2 at the device ratio (cap 2), tier 1 at 0.6', () => {
    expect(dprRange('phone', 2, 3)).toEqual({ base: 2, floor: 1 });
    expect(dprRange('phone', 1, 3)).toEqual({ base: 0.6, floor: 0.45 });
    expect(quality('phone', 1, 0, 3)).toMatchObject({ dpr: 0.6, low: true, cap: 12, fps: 30 });
  });

  it('never goes below the floor on any rung', () => {
    for (const [cls, tier] of [
      ['hi', 3],
      ['hi', 2],
      ['phone', 2],
      ['phone', 1],
    ] as [DeviceClass, 1 | 2 | 3][]) {
      for (const dev of [1, 1.5, 2, 3]) {
        const { floor, base } = dprRange(cls, tier, dev);
        for (let lv = 0; lv < ladder(cls, tier).length; lv++) {
          const q = quality(cls, tier, lv, dev);
          expect(q.dpr).toBeGreaterThanOrEqual(floor - 1e-9);
          expect(q.dpr).toBeLessThanOrEqual(base + 1e-9);
        }
      }
    }
  });

  it('lowers effects and blob counts before resolution, frame rate last (TV)', () => {
    const steps = ladder('hi', 3).map((_, lv) => quality('hi', 3, lv, 2));
    const firstRes = steps.findIndex((q) => q.dpr < 2);
    const firstFx = steps.findIndex((q) => q.low);
    const firstCap = steps.findIndex((q) => q.cap < 72);
    expect(firstFx).toBeGreaterThan(0);
    expect(firstCap).toBeGreaterThan(firstFx);
    expect(firstRes).toBeGreaterThan(firstCap);
    const last = steps[steps.length - 1];
    expect(last).toMatchObject({ dpr: 1, fps: 30 });
    // every step only ever lowers something
    for (let i = 1; i < steps.length; i++) {
      const a = steps[i - 1]!;
      const b = steps[i]!;
      expect(b.dpr).toBeLessThanOrEqual(a.dpr);
      expect(b.cap).toBeLessThanOrEqual(a.cap);
      expect(b.fps).toBeLessThanOrEqual(a.fps);
    }
  });

  it('skips rungs that change nothing (a 1× display has no resolution to give)', () => {
    const at1 = [0];
    for (let lv: number | null = 0; lv !== null; ) {
      lv = nextLevel('hi', 3, lv, 1, 1);
      if (lv !== null) at1.push(lv);
    }
    const qs = at1.map((lv) => quality('hi', 3, lv, 1));
    expect(qs.every((q) => q.dpr === 1)).toBe(true);
    // full → lite → fewer blobs → 30 fps: no no-op steps in between
    expect(qs.map((q) => `${q.low ? 'L' : 'F'}${q.cap}/${q.fps}`)).toEqual(['F72/60', 'L72/60', 'L54/60', 'L54/30']);
    expect(nextLevel('hi', 3, 0, -1, 1)).toBeNull();
    expect(nextLevel('hi', 3, at1[at1.length - 1]!, 1, 1)).toBeNull();
  });
});

// ------------------------------------------------------------------ the shared budget

class Fake implements Member {
  lv = 0;
  gpu: number | null = null;
  on = true;
  dropped = false;
  reports: [number, number | null][] = [];
  constructor(
    readonly name: string,
    readonly importance: number,
    private px: number,
    /** per level: does stepping down to it lower resolution? */
    private res: boolean[],
  ) {}
  pixels(): number {
    return this.px;
  }
  active(): boolean {
    return this.on && !this.dropped;
  }
  nextIsResolution(): boolean {
    return this.res[this.lv + 1] ?? true;
  }
  canDegrade(): boolean {
    return this.lv + 1 < this.res.length;
  }
  degrade(): boolean {
    if (!this.canDegrade()) return false;
    this.lv++;
    return true;
  }
  recover(): boolean {
    if (this.lv === 0) return false;
    this.lv--;
    return true;
  }
  takeGpu(): number | null {
    return this.gpu;
  }
  drop(): void {
    this.dropped = true;
  }
  report(f: number, g: number | null): void {
    this.reports.push([f, g]);
  }
}

function setup() {
  let t = 0;
  const b = new Budget({ now: () => t });
  // levels: 0 full, 1 lite (fx), 2 fewer blobs (fx), 3 and 4 resolution
  const tv = new Fake('tv', 3, 2075 * 1167, [false, false, false, true, true]);
  const phone = new Fake('phone', 2, 539 * 1167, [false, false, false, true, true]);
  b.add(tv);
  b.add(phone);
  return { b, tv, phone, tick: (ms: number) => (t += ms) };
}

describe('liquid quality: page-wide budget', () => {
  it('degrades effects on every stage before any resolution, the costliest first', () => {
    const { b, tv, phone, tick } = setup();
    tv.gpu = 10;
    phone.gpu = 4;
    const seq: string[] = [];
    for (let i = 0; i < 5; i++) {
      tick(1500);
      b.window(28);
      seq.push(`${tv.lv}${phone.lv}`);
    }
    // the TV (more pixels per importance) goes first; neither loses resolution before both lost effects
    expect(seq.slice(0, 4)).toEqual(['10', '20', '21', '22']);
    expect(seq[4]).toBe('32');
  });

  it('recovers step by step in reverse order, with hysteresis', () => {
    const { b, tv, phone, tick } = setup();
    for (let i = 0; i < 3; i++) {
      tick(1500);
      b.window(28);
    }
    expect([tv.lv, phone.lv]).toEqual([2, 1]);
    // fast windows right after a drop: nothing yet (backoff 8 s, three fast windows in a row)
    tick(1500);
    b.window(16.7);
    tick(1500);
    b.window(16.7);
    expect([tv.lv, phone.lv]).toEqual([2, 1]);
    for (let i = 0; i < 6; i++) {
      tick(1500);
      b.window(16.7);
    }
    // the last drop (the phone's) comes back first
    expect(phone.lv).toBe(0);
    expect(tv.lv).toBe(2);
    for (let i = 0; i < 12; i++) {
      tick(1500);
      b.window(16.7);
    }
    expect([tv.lv, phone.lv]).toEqual([0, 0]);
  });

  it('backs off longer when a recovery is followed by a drop', () => {
    const { b, tv, tick } = setup();
    tick(1500);
    b.window(28);
    expect(tv.lv).toBe(1);
    let recoveredAt = -1;
    for (let i = 0; i < 20 && recoveredAt < 0; i++) {
      tick(1500);
      b.window(16.7);
      if (tv.lv === 0) recoveredAt = i;
    }
    expect(recoveredAt).toBeGreaterThan(0);
    // slow again right after recovering: degrade, and the next recovery waits twice as long
    tick(1500);
    b.window(28);
    expect(tv.lv).toBe(1);
    let second = -1;
    for (let i = 0; i < 40 && second < 0; i++) {
      tick(1500);
      b.window(16.7);
      if (tv.lv === 0) second = i;
    }
    expect(second).toBeGreaterThan(recoveredAt + 3);
  });

  it('with GPU timers only degrades when the liquid draws are what makes frames late', () => {
    const { b, tv, phone, tick } = setup();
    tv.gpu = 2;
    phone.gpu = 1;
    for (let i = 0; i < 4; i++) {
      tick(1500);
      b.window(30);
    }
    // the page is slow elsewhere (3 ms of liquid in a 30 ms frame): the chrome stays crisp
    expect([tv.lv, phone.lv]).toEqual([0, 0]);
    tv.gpu = 10;
    phone.gpu = 4;
    tick(1500);
    b.window(30);
    expect(tv.lv + phone.lv).toBe(1);
    // a 30 Hz display with cheap draws: no reason to degrade either
    tv.gpu = 3;
    phone.gpu = 1;
    const before = tv.lv + phone.lv;
    tick(1500);
    b.window(33.4);
    expect(tv.lv + phone.lv).toBe(before);
  });

  it('without timers gives the quality back and holds when dropping does not help', () => {
    const { b, tv, phone, tick } = setup();
    const trace: string[] = [];
    for (let i = 0; i < 5; i++) {
      tick(1500);
      b.window(33.4);
      trace.push(b.last);
    }
    expect(trace).toEqual(['degrade 1', 'degrade 1', 'degrade 1', 'degrade 1', 'hold']);
    expect([tv.lv, phone.lv]).toEqual([0, 0]);
    // held: the same slow cadence does not start another round
    for (let i = 0; i < 10; i++) {
      tick(1500);
      b.window(33.4);
      expect(b.last).toBe('held');
    }
    expect([tv.lv, phone.lv]).toEqual([0, 0]);
  });

  it('drops the least important stage to CSS chrome only when nothing is left to lower', () => {
    const { b, tv, phone, tick } = setup();
    tv.gpu = 30;
    phone.gpu = 20;
    const trace: string[] = [];
    for (let i = 0; i < 6; i++) {
      tick(1500);
      b.window(60);
      trace.push(b.last);
    }
    // severe: two steps a window until both are at the bottom, then two hopeless windows
    expect(trace).toEqual(['degrade 2', 'degrade 2', 'degrade 2', 'degrade 2', 'floor', 'drop']);
    expect(phone.dropped).toBe(true);
    expect(b.members.has(phone)).toBe(false);
    expect(tv.lv).toBe(4);
    // that helped: the TV keeps its (lowest) liquid rung
    tv.gpu = 14;
    for (let i = 0; i < 4; i++) {
      tick(1500);
      b.window(26);
    }
    expect(tv.dropped).toBe(false);
  });

  it('ignores stages that did not draw (covered, paused, offscreen)', () => {
    const { b, tv, phone, tick } = setup();
    phone.on = false;
    for (let i = 0; i < 3; i++) {
      tick(1500);
      b.window(28);
    }
    expect(phone.lv).toBe(0);
    expect(tv.lv).toBe(3);
    expect(phone.reports.length).toBe(0);
    expect(tv.reports.length).toBe(3);
  });

  it('samples the interval after drawn frames only, in 90-frame windows', () => {
    const { b, tv, tick } = setup();
    let t = 0;
    for (let f = 1; f <= 200; f++) {
      t += 30;
      b.frame(f, t);
      b.frame(f, t); // a second stage in the same frame: counted once
      if (f % 2 === 0) b.drew();
    }
    tick(1);
    // drawn every other frame: ~100 intervals sampled → one window, slow (30 ms) → one step
    expect(tv.lv).toBe(1);
  });
});
