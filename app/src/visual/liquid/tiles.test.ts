import { describe, expect, it } from 'vitest';
import { GROUND_REACH, SKIP_K } from './shader';
import { ALL, blobSdf, buildTiles, makeGrid, SLOTS, tileSize } from './tiles';

// A JS replica of the shader's smooth union (shader.ts `blob()` + `D`): the distance field and the
// blended attribute a pixel ends up with, given the blob indices it visits.
function union(A: Float32Array, P: Float32Array, idx: Iterable<number>, px: number, py: number, k: number) {
  let m = 1e5;
  let s = 0;
  let at = 0;
  for (const i of idx) {
    const d = blobSdf(A, P, i, px, py);
    if (d - m > SKIP_K * k) continue;
    const v = P[i * 4 + 2] as number;
    if (d < m) {
      const sc = Math.exp((d - m) / k);
      s = s * sc + 1;
      at = at * sc + v;
      m = d;
    } else {
      const w = Math.exp((m - d) / k);
      s += w;
      at += v * w;
    }
  }
  return { D: m - k * Math.log(Math.max(s, 1)), at: at / Math.max(s, 1e-4) };
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** n packed blobs like engine.pack(): capsules (P.x ≥ 0) and rounded boxes (P.x < 0). */
function scene(n: number, dw: number, dh: number, seed: number, big = 1) {
  const r = rng(seed);
  const A = new Float32Array(n * 4);
  const P = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const x = r() * dw;
    const y = r() * dh;
    if (r() < 0.3) {
      const hw = 20 + r() * 260 * big;
      const hh = 14 + r() * 50 * big;
      A.set([x, y, hw, hh], o);
      P[o] = -Math.min(hw, hh, 6 + r() * 40);
    } else {
      const half = r() < 0.5 ? 0 : r() * 200;
      A.set([x - half, y, x + half, y], o);
      P[o] = 4 + r() * 40;
    }
    P[o + 2] = r();
  }
  return { A, P };
}

function tileList(g: ReturnType<typeof makeGrid>, px: number, py: number, n: number): number[] {
  const tx = Math.min(g.tx - 1, Math.max(0, Math.floor(px / g.ts)));
  const ty = Math.min(g.ty - 1, Math.max(0, Math.floor(py / g.ts)));
  const o = ty * g.tx * g.slots + tx * g.slots;
  const c = g.data[o] as number;
  if (c === ALL) return Array.from({ length: n }, (_, i) => i);
  return Array.from(g.data.subarray(o + 1, o + 1 + c));
}

describe('liquid tiles', () => {
  it('sizes tiles for ~1000 per surface, never below 24 units', () => {
    expect(tileSize(1280, 720)).toBe(31);
    expect(tileSize(390, 844)).toBe(24);
    expect(tileSize(10, 10)).toBe(24);
    const g = makeGrid(1280, 720);
    expect(g.tx * g.ts).toBeGreaterThanOrEqual(1280);
    expect(g.ty * g.ts).toBeGreaterThanOrEqual(720);
    expect(makeGrid(1280, 720, g)).toBe(g);
    expect(makeGrid(1400, 720, g)).not.toBe(g);
  });

  it('matches the shader SDF of capsules and rounded boxes', () => {
    const A = new Float32Array([0, 0, 100, 0, 200, 200, 50, 20]);
    const P = new Float32Array([10, 0, 0, 0, -8, 0, 0, 0]);
    expect(blobSdf(A, P, 0, 50, 30)).toBeCloseTo(20);
    expect(blobSdf(A, P, 0, -20, 0)).toBeCloseTo(10);
    expect(blobSdf(A, P, 1, 200, 250)).toBeCloseTo(30);
    expect(blobSdf(A, P, 1, 200, 200)).toBeCloseTo(-20);
  });

  // The per-tile lists must give every pixel the same surface and shading as looping over all
  // blobs: a blob left out of a tile may only be one the shader would have skipped anyway (or one
  // too far away to touch anything visible).
  for (const [n, dw, dh, k, seed, big] of [
    [60, 1280, 720, 10, 1, 1],
    [72, 1280, 720, 16, 2, 1],
    [24, 390, 844, 8, 3, 1],
    [40, 1280, 720, 4, 4, 1],
    // big cards and media frames: tiles deep inside a body must still list it
    [16, 390, 844, 8, 5, 4],
    [30, 1280, 720, 10, 6, 4],
  ] as const) {
    it(`renders like the full loop: ${n} blobs on ${dw}×${dh}, k=${k}${big > 1 ? ', big boxes' : ''}`, () => {
      const { A, P } = scene(n, dw, dh, seed, big);
      const g = makeGrid(dw, dh);
      buildTiles(g, A, P, n, k);
      const all = Array.from({ length: n }, (_, i) => i);
      const r = rng(seed + 100);
      let worst = 0;
      for (let s = 0; s < 6000; s++) {
        const px = r() * dw;
        const py = r() * dh;
        const full = union(A, P, all, px, py, k);
        const tiled = union(A, P, tileList(g, px, py, n), px, py, k);
        if (full.D > GROUND_REACH * 0.6) {
          // every ground effect is (nearly) gone here: the tiled field only has to stay out there too
          expect(tiled.D).toBeGreaterThan(GROUND_REACH * 0.6 - 2);
          continue;
        }
        worst = Math.max(worst, Math.abs(tiled.D - full.D));
        expect(Math.abs(tiled.at - full.at)).toBeLessThan(0.02);
      }
      // weights < e^-6 are dropped by both; what differs stays far below a device pixel
      expect(worst).toBeLessThan(0.05 * k);
    });
  }

  it('keeps lists short where blobs are sparse and counts references', () => {
    const { A, P } = scene(60, 1280, 720, 7);
    const g = makeGrid(1280, 720);
    buildTiles(g, A, P, 60, 10);
    expect(g.refs).toBeGreaterThan(0);
    expect(g.max).toBeLessThanOrEqual(60);
    // an empty scene lists nothing anywhere
    buildTiles(g, A, P, 0, 10);
    expect(g.refs).toBe(0);
    expect(g.max).toBe(0);
  });

  it('marks a tile ALL when more blobs touch it than it has slots', () => {
    const n = SLOTS + 8;
    const A = new Float32Array(n * 4);
    const P = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      A.set([100 + (i % 3), 100, 100 + (i % 3), 100], i * 4);
      P[i * 4] = 20;
    }
    const g = makeGrid(400, 400);
    buildTiles(g, A, P, n, 10);
    expect(g.overflow).toBeGreaterThan(0);
    const t = Math.floor(100 / g.ts);
    expect(g.data[t * g.tx * g.slots + t * g.slots]).toBe(ALL);
    expect(g.max).toBe(n);
  });
});
