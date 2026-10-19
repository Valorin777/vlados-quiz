// The TV timer tube's geometry: ONE set of numbers for the drawn glass (SVG), the mercury bodies
// (the DOM elements the liquid engine measures every frame) and the scale. Everything is in the
// component's own px (the TV's 1280 design space), origin top-left of the tube box, so the glass,
// the mercury and the ticks can never drift apart at any scale (TV, rehearsal frame, lab).

export interface TubeMark {
  v: number;
  y: number;
  major: boolean;
}

export interface TubeGeo {
  /** box */
  W: number;
  H: number;
  /** axis of the tube and the bulb */
  cx: number;
  /** glass: tube outer half-width, outer top, wall thickness, bulb outer radius + centre, neck fillet */
  tw: number;
  top: number;
  gt: number;
  R: number;
  by: number;
  rf: number;
  /** mercury: column half-width, bulb radius (concentric with the glass bulb) */
  cw: number;
  rb: number;
  /** meniscus (top of the column) when full / at zero */
  yFull: number;
  y0: number;
  /** x where the scale's ticks start (right of the glass) */
  sx: number;
  /** glass outline (outer) and bore (inner surface) */
  outer: string;
  inner: string;
  marks: TubeMark[];
}

const f = (n: number): string => (Math.round(n * 100) / 100).toString();

/**
 * Closed outline: a tube of half-width `tw` with a round top at `top`, joined to a bulb of radius
 * `R` centred at (cx, by) through two concave fillets of radius `rf` (a smooth glass neck).
 */
export function glassPath(cx: number, top: number, tw: number, by: number, R: number, rf: number): string {
  // fillet centre: `rf` off the tube wall, `R + rf` from the bulb centre
  const dy = Math.sqrt(Math.max(0, (R + rf) ** 2 - (tw + rf) ** 2));
  const yc = by - dy;
  // where the fillet touches the bulb: on the line bulb centre → fillet centre, at distance R
  const k = R / (R + rf);
  const px = (tw + rf) * k;
  const py = by - dy * k;
  return [
    `M${f(cx - tw)} ${f(top + tw)}`,
    `A${f(tw)} ${f(tw)} 0 0 1 ${f(cx + tw)} ${f(top + tw)}`,
    `L${f(cx + tw)} ${f(yc)}`,
    `A${f(rf)} ${f(rf)} 0 0 0 ${f(cx + px)} ${f(py)}`,
    `A${f(R)} ${f(R)} 0 1 1 ${f(cx - px)} ${f(py)}`,
    `A${f(rf)} ${f(rf)} 0 0 0 ${f(cx - tw)} ${f(yc)}`,
    'Z',
  ].join(' ');
}

/** y of the neck (where the tube wall starts to curve into the bulb) */
export function neckY(g: Pick<TubeGeo, 'tw' | 'by' | 'R' | 'rf'>): number {
  return g.by - Math.sqrt(Math.max(0, (g.R + g.rf) ** 2 - (g.tw + g.rf) ** 2));
}

/**
 * Scale values: 0 … total in 3–5 even steps (60 → 60/45/30/15/0, 45 → 45/30/15/0, 30 → 30/20/10/0),
 * the limit itself always on top; minor ticks between.
 */
export function tubeMarks(total: number): { major: number[]; minor: number[] } {
  const T = Math.max(1, Math.round(total));
  const steps = [1, 2, 5, 10, 15, 20, 30, 60, 120, 300, 600];
  const fits = steps.filter((s) => T / s <= 5);
  const step = fits.find((s) => T % s === 0 && T / s >= 2) ?? fits[0] ?? Math.ceil(T / 5);
  const major: number[] = [];
  for (let v = 0; v < T; v += step) major.push(v);
  // the limit on top; an even step right under it that would crowd its label goes
  if (major.length > 1 && T - (major[major.length - 1] as number) < step * 0.5) major.pop();
  major.push(T);
  const sub = step % 3 === 0 && step / 3 >= 5 ? step / 3 : step % 2 === 0 ? step / 2 : step === 5 ? 1 : 0;
  const minor: number[] = [];
  if (sub > 0) for (let v = sub; v < T; v += sub) if (!major.includes(v)) minor.push(v);
  return { major, minor };
}

/** The whole tube for a box height `H` and a limit of `total` seconds. */
export function tubeGeo(H: number, total: number, marks?: readonly number[]): TubeGeo {
  const W = 150;
  const cx = 50;
  const tw = 24;
  const gt = 5;
  const R = 42;
  const rf = 10;
  const top = 2;
  const cw = 14;
  const rb = 34;
  const by = H - R - 2;
  const yFull = top + gt + 10;
  // zero sits a little above the bulb: at 0 s a short stub of the column still shows, like a
  // real thermometer at its lowest reading — and the "0" tick is where the meniscus stops
  const y0 = by - R - 10;
  const T = Math.max(1, total);
  const yAt = (v: number) => y0 - (y0 - yFull) * Math.max(0, Math.min(1, v / T));
  const m = marks ? { major: [...marks], minor: [] as number[] } : tubeMarks(T);
  return {
    W,
    H,
    cx,
    tw,
    top,
    gt,
    R,
    by,
    rf,
    cw,
    rb,
    yFull,
    y0,
    sx: cx + tw + 7,
    outer: glassPath(cx, top, tw, by, R, rf),
    inner: glassPath(cx, top + gt, tw - gt, by, R - gt, rf + gt),
    marks: [...m.major.map((v) => ({ v, y: yAt(v), major: true })), ...m.minor.map((v) => ({ v, y: yAt(v), major: false }))],
  };
}

/** Meniscus y for `k` = remaining / total (0…1). */
export function tubeLevel(g: TubeGeo, k: number): number {
  return g.y0 - (g.y0 - g.yFull) * Math.max(0, Math.min(1, k));
}
