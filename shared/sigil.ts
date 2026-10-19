// Deterministic generated avatar ("sigil") from a player's seed. No DOM: returns a spec, unit-space
// shapes (x,y in [-1, 1], y down) that any renderer can draw, and an SVG string helper.
// Every sigil has a palette for both color modes, designed separately (not an inversion).

import type { ColorMode } from './types';
import { rng } from './util';

export type SigilKind = 'star' | 'rosette' | 'orbit' | 'shard' | 'lattice';
export const SIGIL_KINDS: readonly SigilKind[] = ['star', 'rosette', 'orbit', 'shard', 'lattice'];

export interface SigilColors {
  bg: string;
  fg: string;
  accent: string;
}

export interface SigilSpec {
  v: 1;
  seed: number;
  kind: SigilKind;
  /** Rotational symmetry, 3..8. */
  n: number;
  /** Radians. */
  rotation: number;
  /** Inner radius ratio, 0.3..0.6. */
  inner: number;
  /** Line width relative to the unit radius, 0.05..0.11. */
  stroke: number;
  /** Radians between layers, -0.5..0.5. */
  twist: number;
  /** 1..3 */
  layers: number;
  /** Accent dots on outer vertices. */
  dots: boolean;
  /** Irregular radii for 'shard' (length 2n), 0.5..0.9. */
  jitter: number[];
  hues: [number, number, number];
  colors: Record<ColorMode, SigilColors>;
}

export type SigilPaint = 'bg' | 'fg' | 'accent';

export type SigilShape =
  | { t: 'poly'; pts: [number, number][]; closed: boolean; fill: SigilPaint | null; stroke: SigilPaint | null; width: number }
  | { t: 'circle'; cx: number; cy: number; r: number; fill: SigilPaint | null; stroke: SigilPaint | null; width: number };

// ---------- Spec ----------

export function sigilSpec(seed: number): SigilSpec {
  const r = rng(seed ^ 0x5eed5);
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(r() * arr.length)] as T;
  const range = (lo: number, hi: number) => lo + r() * (hi - lo);

  const kind = pick(SIGIL_KINDS);
  const n = 3 + Math.floor(r() * 6);
  const h0 = Math.floor(r() * 360);
  const h1 = (h0 + 100 + Math.floor(r() * 80)) % 360;
  const h2 = (h1 + 90 + Math.floor(r() * 90)) % 360;

  return {
    v: 1,
    seed,
    kind,
    n,
    rotation: range(0, (2 * Math.PI) / n),
    inner: range(0.3, 0.6),
    stroke: range(0.05, 0.11),
    twist: range(-0.5, 0.5),
    layers: 1 + Math.floor(r() * 3),
    dots: r() < 0.5,
    jitter: Array.from({ length: 2 * n }, () => range(0.5, 0.9)),
    hues: [h0, h1, h2],
    colors: {
      dark: { bg: hslHex(h0, 0.45, 0.16), fg: hslHex(h1, 0.85, 0.64), accent: hslHex(h2, 0.95, 0.7) },
      light: { bg: hslHex(h0, 0.75, 0.92), fg: hslHex(h1, 0.7, 0.4), accent: hslHex(h2, 0.8, 0.48) },
    },
  };
}

// ---------- Geometry ----------

const R = 0.78;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
const polar = (radius: number, a: number): [number, number] => [round3(radius * Math.cos(a)), round3(radius * Math.sin(a))];

function ring(count: number, radius: (i: number) => number, rot: number): [number, number][] {
  return Array.from({ length: count }, (_, i) => polar(radius(i), rot + (i * 2 * Math.PI) / count));
}

/** Shapes in paint order, starting with the background disc. */
export function sigilShapes(s: SigilSpec): SigilShape[] {
  const w = round3(s.stroke);
  const out: SigilShape[] = [{ t: 'circle', cx: 0, cy: 0, r: 1, fill: 'bg', stroke: null, width: 0 }];
  const outer = ring(s.n, () => R, s.rotation);

  switch (s.kind) {
    case 'star': {
      for (let l = 0; l < s.layers; l++) {
        const scale = 1 - l * 0.3;
        const pts = ring(2 * s.n, (i) => (i % 2 ? R * s.inner : R) * scale, s.rotation + l * s.twist);
        out.push(l === 0
          ? { t: 'poly', pts, closed: true, fill: 'fg', stroke: null, width: 0 }
          : { t: 'poly', pts, closed: true, fill: null, stroke: l % 2 ? 'accent' : 'bg', width: w });
      }
      break;
    }
    case 'rosette': {
      const petalR = R * (0.35 + 0.15 * s.inner);
      for (const [cx, cy] of ring(s.n, () => R - petalR, s.rotation)) {
        out.push({ t: 'circle', cx, cy, r: round3(petalR), fill: null, stroke: 'fg', width: w });
      }
      out.push({ t: 'circle', cx: 0, cy: 0, r: round3(R * s.inner * 0.5), fill: 'accent', stroke: null, width: 0 });
      break;
    }
    case 'orbit': {
      for (let l = 0; l < s.layers; l++) {
        out.push({ t: 'circle', cx: 0, cy: 0, r: round3(R * (1 - l * 0.28)), fill: null, stroke: 'fg', width: w });
      }
      for (let i = 0; i < s.n; i++) {
        const radius = R * (1 - (i % s.layers) * 0.28);
        const [cx, cy] = polar(radius, s.rotation + i * s.twist * 2 + (i * 2 * Math.PI) / s.n);
        out.push({ t: 'circle', cx, cy, r: round3(w * 1.4), fill: 'accent', stroke: null, width: 0 });
      }
      out.push({ t: 'circle', cx: 0, cy: 0, r: round3(R * s.inner * 0.45), fill: 'fg', stroke: null, width: 0 });
      break;
    }
    case 'shard': {
      const pts = ring(2 * s.n, (i) => R * (s.jitter[i] ?? 0.7) / 0.9, s.rotation);
      out.push({ t: 'poly', pts, closed: true, fill: 'fg', stroke: null, width: 0 });
      const innerPts = ring(s.n, (i) => R * s.inner * (s.jitter[i] ?? 0.7), s.rotation + s.twist);
      out.push({ t: 'poly', pts: innerPts, closed: true, fill: 'accent', stroke: null, width: 0 });
      break;
    }
    case 'lattice': {
      out.push({ t: 'poly', pts: outer, closed: true, fill: null, stroke: 'fg', width: w });
      // Star polygon {n/k}: connect every k-th vertex.
      const k = s.n >= 5 ? 2 : 1;
      for (let i = 0; i < s.n; i++) {
        const a = outer[i];
        const b = outer[(i + k) % s.n];
        if (a && b) out.push({ t: 'poly', pts: [a, b], closed: false, fill: null, stroke: 'fg', width: round3(w * 0.6) });
      }
      out.push({ t: 'poly', pts: ring(s.n, () => R * s.inner * 0.6, s.rotation + s.twist), closed: true, fill: 'accent', stroke: null, width: 0 });
      break;
    }
  }

  if (s.dots) {
    for (const [cx, cy] of outer) out.push({ t: 'circle', cx, cy, r: round3(w * 1.1), fill: 'accent', stroke: null, width: 0 });
  }
  return out;
}

/** Standalone SVG markup (use as `data:image/svg+xml,` + encodeURIComponent(svg)). */
export function sigilSvg(s: SigilSpec, mode: ColorMode, size = 96): string {
  const c = s.colors[mode];
  const paint = (p: SigilPaint | null) => (p ? c[p] : 'none');
  const body = sigilShapes(s)
    .map((sh) => {
      const common = `fill="${paint(sh.fill)}" stroke="${paint(sh.stroke)}" stroke-width="${sh.width}" stroke-linejoin="round" stroke-linecap="round"`;
      if (sh.t === 'circle') return `<circle cx="${sh.cx}" cy="${sh.cy}" r="${sh.r}" ${common}/>`;
      const pts = sh.pts.map(([x, y]) => `${x},${y}`).join(' ');
      return sh.closed ? `<polygon points="${pts}" ${common}/>` : `<polyline points="${pts}" ${common}/>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="-1 -1 2 2">${body}</svg>`;
}

// ---------- Color ----------

/** HSL (h in degrees, s/l in 0..1) → #rrggbb. */
export function hslHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
