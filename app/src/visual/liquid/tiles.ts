// Per-tile blob lists for the WebGL2 shader. The canvas (in design units) is cut into square
// tiles; for every tile the CPU lists only the blobs that can change a pixel in it:
//   * a blob whose surface is farther than GROUND_REACH from the whole tile adds nothing (every
//     ground effect has faded to zero there, and the chrome surface is elsewhere);
//   * a blob more than SKIP_K·k beyond the tile's nearest surface weighs < e^-6 in the smooth
//     union: skipped (the shader applies the same cut per pixel).
// The shader then loops over a handful of blobs per pixel instead of all of them (60+ on the TV).
// Pure and allocation-free per frame: unit-tested in tiles.test.ts.

import { GROUND_REACH, SKIP_K } from './shader';

/** Texels per tile: [count, i0, i1, …]. A tile with more blobs is marked ALL (loops over every blob). */
export const SLOTS = 32;
export const ALL = 255;
/** extra slack (design units) for the surface wobble and ripples added after the union */
const MARGIN = 4;

export interface TileGrid {
  /** tile size, design units */
  ts: number;
  tx: number;
  ty: number;
  slots: number;
  /** R8UI texture data, (tx · slots) × ty texels, row-major */
  data: Uint8Array;
  /** scratch: per-tile upper bound of the distance to the nearest surface */
  near: Float32Array;
  /** tiles that overflowed to ALL in the last build */
  overflow: number;
  /** longest list in the last build */
  max: number;
  /** blob references in the last build (Σ list lengths) */
  refs: number;
}

/** Tile size for a design surface: ~1000 tiles, never below 24 units. */
export function tileSize(dw: number, dh: number): number {
  return Math.max(24, Math.ceil(Math.sqrt((Math.max(1, dw) * Math.max(1, dh)) / 1000)));
}

/** A grid for dw × dh (reuses `prev` when the shape is unchanged). */
export function makeGrid(dw: number, dh: number, prev?: TileGrid | null, slots = SLOTS): TileGrid {
  const ts = tileSize(dw, dh);
  const tx = Math.max(1, Math.ceil(dw / ts));
  const ty = Math.max(1, Math.ceil(dh / ts));
  if (prev && prev.ts === ts && prev.tx === tx && prev.ty === ty && prev.slots === slots) return prev;
  return { ts, tx, ty, slots, data: new Uint8Array(tx * slots * ty), near: new Float32Array(tx * ty), overflow: 0, max: 0, refs: 0 };
}

/** Signed distance from (px, py) to packed blob i (same shapes as the shader). */
export function blobSdf(A: Float32Array, P: Float32Array, i: number, px: number, py: number): number {
  const o = i * 4;
  const r = P[o] as number;
  const a0 = A[o] as number;
  const a1 = A[o + 1] as number;
  const a2 = A[o + 2] as number;
  const a3 = A[o + 3] as number;
  if (r >= 0) {
    const pax = px - a0;
    const pay = py - a1;
    const bax = a2 - a0;
    const bay = a3 - a1;
    const bb = Math.max(bax * bax + bay * bay, 1e-3);
    const h = Math.min(1, Math.max(0, (pax * bax + pay * bay) / bb));
    return Math.hypot(pax - bax * h, pay - bay * h) - r;
  }
  const rad = -r;
  const qx = Math.abs(px - a0) - a2 + rad;
  const qy = Math.abs(py - a1) - a3 + rad;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rad;
}

const BB = new Float32Array(4);

/** Axis-aligned bounds of packed blob i into BB (x0, y0, x1, y1). */
function bounds(A: Float32Array, P: Float32Array, i: number): Float32Array {
  const o = i * 4;
  const r = P[o] as number;
  const a0 = A[o] as number;
  const a1 = A[o + 1] as number;
  const a2 = A[o + 2] as number;
  const a3 = A[o + 3] as number;
  if (r >= 0) {
    BB[0] = Math.min(a0, a2) - r;
    BB[1] = Math.min(a1, a3) - r;
    BB[2] = Math.max(a0, a2) + r;
    BB[3] = Math.max(a1, a3) + r;
  } else {
    BB[0] = a0 - a2;
    BB[1] = a1 - a3;
    BB[2] = a0 + a2;
    BB[3] = a1 + a3;
  }
  return BB;
}

/**
 * Fill `g.data` with the blob list of every tile for the n packed blobs (A/P as uploaded to the
 * shader, design units) and the union softness k.
 */
export function buildTiles(g: TileGrid, A: Float32Array, P: Float32Array, n: number, k: number): void {
  const { ts, tx, ty, slots, data, near } = g;
  const reach = GROUND_REACH;
  const half = ts * Math.SQRT1_2;
  near.fill(Infinity);
  // pass 1: an upper bound of the nearest surface for every tile (sdf at the centre + half diagonal)
  for (let i = 0; i < n; i++) {
    const b = bounds(A, P, i);
    const x0 = Math.max(0, Math.floor(((b[0] as number) - reach) / ts));
    const x1 = Math.min(tx - 1, Math.floor(((b[2] as number) + reach) / ts));
    const y0 = Math.max(0, Math.floor(((b[1] as number) - reach) / ts));
    const y1 = Math.min(ty - 1, Math.floor(((b[3] as number) + reach) / ts));
    for (let y = y0; y <= y1; y++) {
      const cy = (y + 0.5) * ts;
      for (let x = x0; x <= x1; x++) {
        const d = blobSdf(A, P, i, (x + 0.5) * ts, cy) + half;
        const t = y * tx + x;
        if (d < (near[t] as number)) near[t] = d;
      }
    }
  }
  // pass 2: a blob joins a tile when it can come within reach of it and within the skip distance
  // of the tile's nearest surface
  const row = tx * slots;
  for (let y = 0; y < ty; y++) for (let x = 0; x < tx; x++) data[y * row + x * slots] = 0;
  let overflow = 0;
  let refs = 0;
  const skip = SKIP_K * k + MARGIN;
  for (let i = 0; i < n; i++) {
    const b = bounds(A, P, i);
    const bx0 = (b[0] as number);
    const by0 = (b[1] as number);
    const bx1 = (b[2] as number);
    const by1 = (b[3] as number);
    const x0 = Math.max(0, Math.floor((bx0 - reach) / ts));
    const x1 = Math.min(tx - 1, Math.floor((bx1 + reach) / ts));
    const y0 = Math.max(0, Math.floor((by0 - reach) / ts));
    const y1 = Math.min(ty - 1, Math.floor((by1 + reach) / ts));
    for (let y = y0; y <= y1; y++) {
      const ty0 = y * ts;
      const dy = Math.max(0, by0 - (ty0 + ts), ty0 - by1);
      for (let x = x0; x <= x1; x++) {
        const tx0 = x * ts;
        const dx = Math.max(0, bx0 - (tx0 + ts), tx0 - bx1);
        const t = y * tx + x;
        const lim = Math.min(reach, (near[t] as number) + skip);
        // outside the bounding box every pixel is at least `bb` away (unsigned); a tile that
        // overlaps it may lie inside the blob, where the distance is negative
        const bb = Math.hypot(dx, dy);
        if (bb > 0 && bb > lim) continue;
        // the SDF is 1-Lipschitz: nowhere in the tile is the blob nearer than at the centre less
        // half a diagonal (so the blob a deep-inside tile belongs to is always listed)
        const lb = Math.max(bb > 0 ? bb : -Infinity, blobSdf(A, P, i, (x + 0.5) * ts, (y + 0.5) * ts) - half);
        if (lb > lim) continue;
        const o = y * row + x * slots;
        const c = data[o] as number;
        if (c === ALL) continue;
        if (c >= slots - 1) {
          data[o] = ALL;
          overflow++;
          continue;
        }
        data[o + 1 + c] = i;
        data[o] = c + 1;
        refs++;
      }
    }
  }
  let max = 0;
  for (let y = 0; y < ty; y++)
    for (let x = 0; x < tx; x++) {
      const c = data[y * row + x * slots] as number;
      const v = c === ALL ? n : c;
      if (v > max) max = v;
    }
  g.overflow = overflow;
  g.max = max;
  g.refs = refs;
}
