// The liquid chrome renderer: one WebGL canvas per screen, a metaball scene, DOM anchoring,
// quality steps under the page-wide frame budget (quality.ts), idle throttling, pause when hidden,
// offscreen or covered, and context-loss fallback. Loaded lazily (after first paint) by
// LiquidStage; nothing else imports it statically.
//
// Crispness: the drawing buffer matches the canvas's on-screen size (after ancestor transforms)
// times the render ratio — the real device ratio on the TV and laptops (quality.ts) — and the
// shader anti-aliases over ~1 device pixel of that scale. WebGL2 renders with per-tile blob
// lists (tiles.ts), so full resolution stays affordable with 60+ blobs.

import { gsap } from 'gsap';
import { TAU, reducedMotion, rnd } from '../motion';
import { budget, deviceClass, finePointer, ladder, nextLevel, quality, TIERS, type DeviceClass, type Member, type Quality } from './quality';
import { VERT1, VERT2, fragSource } from './shader';
import { buildTiles, makeGrid, type TileGrid } from './tiles';
import type { AnchorOptions, Blob, ColorMode, EngineOptions, EngineStats, SceneProps, Shape, Tier } from './types';

export { TIERS } from './quality';

type GL = WebGLRenderingContext | WebGL2RenderingContext;

const U_NAMES = [
  'uFrame',
  'uDesign',
  'uCorner',
  'uTime',
  'uPx',
  'uK',
  'uBevel',
  'uHeat',
  'uAgit',
  'uFlash',
  'uCalm',
  'uMode',
  'uN',
  'uA',
  'uP',
  'uR',
  'uTiles',
  'uTile',
  'uSlots',
] as const;
type UName = (typeof U_NAMES)[number];

interface Prog {
  p: WebGLProgram;
  nb: number;
  tiles: boolean;
  u: Record<UName, WebGLUniformLocation | null>;
  A: Float32Array;
  P: Float32Array;
}

/** A program whose compile/link was started but not yet checked. */
interface Linking {
  p: WebGLProgram;
  v: WebGLShader;
  f: WebGLShader;
  nb: number;
  tiles: boolean;
}

interface Anchor {
  b: Blob;
  el: Element;
  shape: Shape;
  pad: number;
  cr: number | null;
  /** '' detached · 'off' CSS chrome shows · 'live' the canvas has drawn this blob (CSS fades out) */
  state: '' | 'live' | 'off';
  /** what the last pack() decided (drawn → 'live', over the blob cap → 'off'); applied on present */
  want: '' | 'live' | 'off';
}

interface Particle {
  b: Blob;
  vx: number;
  vy: number;
  g: number;
  k: number;
  px: number;
  py: number;
  damp: number;
  life: number;
  t: number;
  r0: number;
}

interface Follow {
  el: HTMLElement | SVGElement;
  b: Blob;
  ox: number;
  oy: number;
  last: string;
}

interface Ripple {
  x: number;
  y: number;
  t: number;
  s: number;
}

export interface DropletOptions {
  x: number;
  y: number;
  r: number;
  vx?: number;
  vy?: number;
  /** gravity, design units/s² */
  g?: number;
  /** spring back towards (px, py) */
  k?: number;
  px?: number;
  py?: number;
  damp?: number;
  life?: number;
  film?: number;
  glow?: number;
  tar?: number;
}

export interface LocalRect {
  /** centre */
  x: number;
  y: number;
  w: number;
  h: number;
}

const BLOB_DEFAULTS: Blob = {
  x: 0,
  y: 0,
  r: 0,
  ax: 0,
  ay: 0,
  bx: 0,
  by: 0,
  box: 0,
  hw: 0,
  hh: 0,
  cr: 20,
  tar: 0,
  glow: 0,
  film: 0.34,
  sc: 1,
  dx: 0,
  dy: 0,
  on: 1,
  prio: 1,
};

export function makeBlob(o: Partial<Blob> = {}): Blob {
  return { ...BLOB_DEFAULTS, ...o };
}

type VisCheck = (o?: { opacityProperty?: boolean; visibilityProperty?: boolean }) => boolean;

/** opacity: 0 / visibility: hidden on the element or an ancestor (style is already clean here). */
function hidden(el: Element): boolean {
  const check = (el as Element & { checkVisibility?: VisCheck }).checkVisibility;
  return typeof check === 'function' ? !check.call(el, { opacityProperty: true, visibilityProperty: true }) : false;
}

const devRatio = (): number => (typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1);

type TimerExt = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number; QUERY_RESULT_AVAILABLE_EXT?: number; QUERY_RESULT_EXT?: number } & Record<
  string,
  unknown
>;
type ExtFns = Record<string, ((...a: unknown[]) => unknown) | undefined>;

/**
 * GPU time of the draw (EXT_disjoint_timer_query): lets the budget tell "the GPU is busy" from
 * "the page refreshes at 30 Hz" (Low Power Mode, a background preview) or "the CPU is busy".
 */
class GpuTimer {
  private free: unknown[] = [];
  private pending: unknown[] = [];
  private sum = 0;
  private cnt = 0;
  private open = false;

  private constructor(
    private gl: GL,
    private gl2: boolean,
    private ext: TimerExt,
  ) {}

  static make(gl: GL, gl2: boolean): GpuTimer | null {
    try {
      const ext = gl.getExtension(gl2 ? 'EXT_disjoint_timer_query_webgl2' : 'EXT_disjoint_timer_query') as TimerExt | null;
      return ext ? new GpuTimer(gl, gl2, ext) : null;
    } catch {
      return null;
    }
  }

  private get fns(): ExtFns {
    return this.ext as unknown as ExtFns;
  }

  begin(): void {
    if (this.open || this.pending.length >= 4) return;
    const q = this.free.pop() ?? (this.gl2 ? (this.gl as WebGL2RenderingContext).createQuery() : this.fns.createQueryEXT?.call(this.ext));
    if (!q) return;
    if (this.gl2) (this.gl as WebGL2RenderingContext).beginQuery(this.ext.TIME_ELAPSED_EXT, q as WebGLQuery);
    else this.fns.beginQueryEXT?.call(this.ext, this.ext.TIME_ELAPSED_EXT, q);
    this.pending.push(q);
    this.open = true;
  }

  end(): void {
    if (!this.open) return;
    this.open = false;
    if (this.gl2) (this.gl as WebGL2RenderingContext).endQuery(this.ext.TIME_ELAPSED_EXT);
    else this.fns.endQueryEXT?.call(this.ext, this.ext.TIME_ELAPSED_EXT);
  }

  /** Collect finished queries (results show up a frame or two later). */
  poll(): void {
    const gl = this.gl;
    while (this.pending.length) {
      const q = this.pending[0];
      const avail = this.gl2
        ? (gl as WebGL2RenderingContext).getQueryParameter(q as WebGLQuery, (gl as WebGL2RenderingContext).QUERY_RESULT_AVAILABLE)
        : this.fns.getQueryObjectEXT?.call(this.ext, q, this.ext.QUERY_RESULT_AVAILABLE_EXT);
      if (!avail) break;
      this.pending.shift();
      const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
      const ns = this.gl2
        ? (gl as WebGL2RenderingContext).getQueryParameter(q as WebGLQuery, (gl as WebGL2RenderingContext).QUERY_RESULT)
        : this.fns.getQueryObjectEXT?.call(this.ext, q, this.ext.QUERY_RESULT_EXT);
      if (!disjoint && typeof ns === 'number' && ns > 0) {
        this.sum += ns / 1e6;
        this.cnt++;
      }
      this.free.push(q);
    }
  }

  /** Mean GPU ms per timed frame since the last call (null: nothing measured). */
  take(): number | null {
    const v = this.cnt ? this.sum / this.cnt : null;
    this.sum = this.cnt = 0;
    return v;
  }

  destroy(): void {
    for (const q of [...this.free, ...this.pending]) {
      if (this.gl2) (this.gl as WebGL2RenderingContext).deleteQuery(q as WebGLQuery);
      else this.fns.deleteQueryEXT?.call(this.ext, q);
    }
    this.free = [];
    this.pending = [];
  }
}

/** Alpha of a computed colour ('rgb(…)', 'rgba(…, a)', 'color(srgb … / a)', 'transparent'). */
export function cssAlpha(c: string): number {
  const s = c.trim();
  if (!s || s === 'transparent') return 0;
  const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(s);
  if (slash) return parseFloat(slash[1] as string) / (slash[2] ? 100 : 1);
  const rgba = /^rgba\(([^)]*)\)$/.exec(s);
  if (rgba) {
    const parts = (rgba[1] as string).split(',');
    if (parts.length === 4) return parseFloat(parts[3] as string);
  }
  return 1;
}

/**
 * Is the canvas entirely hidden under one opaque element (the rehearsal studio over the panel's
 * own full-page stage)? Conservative: one element that is not an ancestor of the canvas, fully
 * covers its visible part, is square-cornered, opaque and on top at the centre and all corners.
 */
function covered(canvas: HTMLCanvasElement, rect: DOMRect): boolean {
  if (typeof document.elementFromPoint !== 'function') return false;
  const l = Math.max(rect.left, 0);
  const t = Math.max(rect.top, 0);
  const r = Math.min(rect.right, innerWidth);
  const b = Math.min(rect.bottom, innerHeight);
  if (r - l < 8 || b - t < 8) return false;
  let cover: Element | null = null;
  for (let el = document.elementFromPoint((l + r) / 2, (t + b) / 2); el && !el.contains(canvas); el = el.parentElement) {
    const q = el.getBoundingClientRect();
    if (q.left > l + 0.5 || q.top > t + 0.5 || q.right < r - 0.5 || q.bottom < b - 0.5) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility !== 'visible' || cs.opacity !== '1' || cssAlpha(cs.backgroundColor) < 0.999) continue;
    if (
      parseFloat(cs.borderTopLeftRadius) ||
      parseFloat(cs.borderTopRightRadius) ||
      parseFloat(cs.borderBottomLeftRadius) ||
      parseFloat(cs.borderBottomRightRadius)
    )
      continue;
    cover = el;
    break;
  }
  if (!cover) return false;
  // a translucent ancestor (an overlay fading in or out) lets the canvas show through
  for (let el = cover.parentElement; el && !el.contains(canvas); el = el.parentElement) {
    if (getComputedStyle(el).opacity !== '1') return false;
  }
  for (const [x, y] of [
    [l + 2, t + 2],
    [r - 2, t + 2],
    [l + 2, b - 2],
    [r - 2, b - 2],
  ] as const) {
    const h = document.elementFromPoint(x, y);
    if (!h || !cover.contains(h)) return false;
  }
  return true;
}

export class LiquidEngine {
  readonly canvas: HTMLCanvasElement;
  readonly opts: EngineOptions;
  /** Tween these for global effects: heat, agit, flash, k, bevel. */
  readonly scene: SceneProps;
  /** Seconds since start (the shader clock). */
  time = 0;
  /** Current colour mode, animated 0 (dark) → 1 (light). */
  modeV = 0;

  private gl: GL | null = null;
  /** WebGL2: per-tile blob lists (tiles.ts); WebGL1 loops over every blob per pixel */
  private gl2 = false;
  private progs = new Map<string, Prog>();
  private warming = new Map<string, Linking>();
  /** when to pre-compile the degrade variants (0: done) */
  private warmAt = 0;
  private nbMax = 0;
  private buf: WebGLBuffer | null = null;
  private tileTex: WebGLTexture | null = null;
  private grid: TileGrid | null = null;
  /** grid shape of the texture as allocated ('' none) */
  private gridTex = '';
  private tilesK = -1;
  private tilesDirty = true;
  private timer: GpuTimer | null = null;
  private blobs: Blob[] = [];
  private anchors = new Map<Blob, Anchor>();
  private particles: Particle[] = [];
  private follows: Follow[] = [];
  private ripples: Ripple[] = [];
  private Rb = new Float32Array(16);
  private prevA = new Float32Array(0);
  private prevP = new Float32Array(0);
  private prevN = -1;

  private _tier: Tier;
  private manual = false;
  /** phone-class devices keep their tiers; the TV and laptops render at the device ratio */
  private readonly cls: DeviceClass;
  /** quality step within the tier (quality.ts ladder), moved by the page-wide budget */
  private lv = 0;
  private q: Quality;
  /** canvas pixels per on-screen CSS pixel in use */
  private dpr: number;
  private lost = false;
  private dead = false;
  private paused = false;
  private onScreen = true;
  /** hidden under an opaque element (probed a few times a second) */
  private occluded = false;
  private nextProbe = 0;
  private drewInWindow = false;
  private leave: (() => void) | null = null;
  private startedAt = performance.now();
  private last = performance.now();
  private lastRender = 0;
  private fpsCount = 0;
  private fpsT0 = performance.now();
  private statsListeners = new Set<(s: EngineStats) => void>();
  private _stats: EngineStats;
  private rect: DOMRect | null = null;
  /** CSS layout width of the canvas (before ancestor transforms) */
  private layoutW = 0;
  private unit = 1;
  private dw = 1;
  private dh = 1;
  private mode: ColorMode = 'dark';
  private modeObs: MutationObserver | null = null;
  private io: IntersectionObserver | null = null;
  private lastPackN = 0;
  /** the canvas currently shows a frame drawn for the present scene (false until the first draw,
   *  after a hide / context loss / tier 0): until then every anchor keeps its CSS chrome */
  private presented = false;

  constructor(canvas: HTMLCanvasElement, opts: EngineOptions) {
    this.canvas = canvas;
    this.opts = opts;
    this._tier = opts.tier;
    this.cls = deviceClass(opts.profile, finePointer());
    this.q = quality(this.cls, opts.tier, 0, devRatio());
    this.dpr = this.q.dpr;
    this.scene =
      opts.profile === 'tv'
        ? { heat: 0, agit: 0, flash: 0, k: 10, bevel: 32 }
        : { heat: 0, agit: 0, flash: 0, k: 8, bevel: 22 };
    if (!this.initGL() || !this.program(opts.tier)) {
      this.gl = null;
      throw new Error('liquid: WebGL unavailable');
    }
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
    const src = opts.modeSource ?? document.documentElement;
    const readMode = (): ColorMode => (src.getAttribute('data-mode') === 'light' ? 'light' : 'dark');
    this.mode = readMode();
    this.modeV = this.mode === 'light' ? 1 : 0;
    this.modeObs = new MutationObserver(() => {
      const instant = document.documentElement.classList.contains('vx-vt');
      this.setMode(readMode(), !instant);
    });
    this.modeObs.observe(src, { attributes: true, attributeFilter: ['data-mode'] });
    if (typeof IntersectionObserver === 'function') {
      this.io = new IntersectionObserver((es) => {
        const e = es[es.length - 1];
        if (e) this.onScreen = e.isIntersecting;
      });
      this.io.observe(canvas);
    }
    this._stats = { tier: this._tier, fps: 0, frameMs: 0, gpuMs: null, blobs: 0, dpr: this.dpr, level: 0, gl: this.gl2 ? 2 : 1, mode: this.mode, lost: false };
    this.member = this.makeMember();
    this.leave = budget.add(this.member);
    document.addEventListener('visibilitychange', this.onVisibility);
    gsap.ticker.add(this.tick);
    if (/[?&]lqdebug\b/.test(location.search)) {
      const w = window as unknown as { __lq?: Set<LiquidEngine> };
      (w.__lq ??= new Set()).add(this);
    }
  }

  // ------------------------------------------------------------------ GL

  private initGL(): boolean {
    const phone = this.opts.profile === 'phone';
    const attrs: WebGLContextAttributes = {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: phone ? 'low-power' : 'high-performance',
      failIfMajorPerformanceCaveat: phone,
    };
    let gl: GL | null = null;
    let gl2 = false;
    try {
      gl = this.canvas.getContext('webgl2', attrs) as WebGL2RenderingContext | null;
      gl2 = !!gl;
      if (!gl) gl = this.canvas.getContext('webgl', attrs) as WebGLRenderingContext | null;
    } catch {
      gl = null;
    }
    if (!gl) return false;
    const maxV = Number(gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS)) || 0;
    this.nbMax = Math.min(72, Math.floor((maxV - 24) / 2));
    if (this.nbMax < 12) return false;
    this.gl = gl;
    this.gl2 = gl2;
    this.progs.clear();
    this.warming.clear();
    this.warmAt = performance.now() + 2500;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.buf = buf;
    this.tileTex = null;
    this.gridTex = '';
    this.tilesDirty = true;
    if (gl2) {
      const g = gl as WebGL2RenderingContext;
      g.pixelStorei(g.UNPACK_ALIGNMENT, 1);
      const tex = g.createTexture();
      g.activeTexture(g.TEXTURE0);
      g.bindTexture(g.TEXTURE_2D, tex);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
      this.tileTex = tex;
    }
    this.timer?.destroy();
    this.timer = GpuTimer.make(gl, gl2);
    return true;
  }

  private progKey(tier: Exclude<Tier, 0>, low: boolean): { key: string; nb: number } {
    const nb = Math.min(TIERS[tier].cap, this.nbMax);
    return { key: `${nb}|${low ? 1 : 0}|${this.gl2 ? 1 : 0}`, nb };
  }

  /** Compile and link without waiting for the result (the driver works on it in the background). */
  private link(nb: number, low: boolean): Linking | null {
    const gl = this.gl;
    if (!gl) return null;
    const tiles = this.gl2;
    const v = gl.createShader(gl.VERTEX_SHADER);
    const f = gl.createShader(gl.FRAGMENT_SHADER);
    const p = gl.createProgram();
    if (!v || !f || !p) return null;
    gl.shaderSource(v, tiles ? VERT2 : VERT1);
    gl.shaderSource(f, fragSource({ nb, low, tiles }));
    gl.compileShader(v);
    gl.compileShader(f);
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.bindAttribLocation(p, 0, 'a');
    gl.linkProgram(p);
    return { p, v, f, nb, tiles };
  }

  /**
   * Start compiling the variants the governor may step to (the cheap shader; a phone's lower
   * tier) while nothing is struggling: a synchronous compile in the middle of a slow stretch is
   * a visible hitch.
   */
  private warm(): void {
    if (!this.gl || this._tier === 0) return;
    const t = this._tier as 1 | 2 | 3;
    const want: [Exclude<Tier, 0>, boolean][] = [[t, true]];
    if (this.cls === 'phone' && t > 1 && !this.manual) want.push([(t - 1) as 1 | 2, true]);
    for (const [tier, low] of want) {
      const { key, nb } = this.progKey(tier, low);
      if (this.progs.has(key) || this.warming.has(key)) continue;
      const w = this.link(nb, low);
      if (w) this.warming.set(key, w);
    }
  }

  private program(tier: Exclude<Tier, 0>, low = this.q.low): Prog | null {
    const gl = this.gl;
    if (!gl) return null;
    const { key, nb } = this.progKey(tier, low);
    const hit = this.progs.get(key);
    if (hit) return hit;
    const w = this.warming.get(key) ?? this.link(nb, low);
    this.warming.delete(key);
    if (!w) return null;
    const { p, tiles } = w;
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      for (const s of [w.v, w.f]) if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn('liquid shader:', gl.getShaderInfoLog(s));
      console.warn('liquid link:', gl.getProgramInfoLog(p));
      gl.deleteProgram(p);
      return null;
    }
    const u = {} as Record<UName, WebGLUniformLocation | null>;
    for (const n of U_NAMES) u[n] = gl.getUniformLocation(p, n);
    if (tiles) {
      gl.useProgram(p);
      gl.uniform1i(u.uTiles, 0);
    }
    const prog: Prog = { p, nb, tiles, u, A: new Float32Array(nb * 4), P: new Float32Array(nb * 4) };
    this.progs.set(key, prog);
    return prog;
  }

  private onLost = (e: Event): void => {
    e.preventDefault();
    this.lost = true;
    this.progs.clear();
    this.warming.clear();
    this.timer = null;
    this.gl = null;
    this.refreshLive();
    this.opts.onTier?.(0);
    this.emitStats();
  };

  private onRestored = (): void => {
    if (this.initGL() && this._tier > 0 && this.program(this._tier as 1 | 2 | 3)) {
      this.lost = false;
      this.refreshLive();
      this.opts.onTier?.(this._tier);
      this.emitStats();
    }
  };

  private onVisibility = (): void => {
    this.last = performance.now();
    budget.reset();
    // A hidden page draws nothing, yet it may still be painted (app switcher, a hidden preview
    // pane, a snapshot) while elements come and go: hand every body back to its CSS chrome and
    // take over again with the first frame after it is visible.
    if (document.hidden) this.unpresent();
  };

  // ------------------------------------------------------------------ public: state

  get tier(): Tier {
    return this.lost ? 0 : this._tier;
  }

  get live(): boolean {
    return !this.lost && !this.dead && this._tier > 0;
  }

  get stats(): EngineStats {
    return this._stats;
  }

  /** Units → CSS px factor (1 on phones; canvas width / designWidth on TV). */
  get scale(): number {
    return this.unit;
  }

  /** Design size of the canvas. */
  get size(): { w: number; h: number } {
    return { w: this.dw, h: this.dh };
  }

  onStats(fn: (s: EngineStats) => void): () => void {
    this.statsListeners.add(fn);
    return () => this.statsListeners.delete(fn);
  }

  /**
   * Force a tier (Lab / settings). `manual` pins it: the budget then only moves effects and
   * resolution within it. `setTier('auto')` hands control back to the governor.
   */
  setTier(t: Tier | 'auto'): void {
    if (t === 'auto') {
      this.manual = false;
      return;
    }
    this.manual = true;
    this.applyTier(t);
  }

  private applyTier(t: Tier, lv = 0): void {
    if (t !== 0 && !this.program(t, quality(this.cls, t, lv, devRatio()).low)) t = 0;
    const was = this._tier;
    this._tier = t;
    this.setLevel(lv);
    this.refreshLive();
    if (was !== t) this.opts.onTier?.(t);
    this.emitStats();
  }

  private setLevel(lv: number): void {
    this.lv = lv;
    if (this._tier === 0) return;
    this.q = quality(this.cls, this._tier as 1 | 2 | 3, lv, devRatio());
    this.dpr = this.q.dpr;
    while (this.particles.length > this.q.fx) this.killParticle(0);
    this.emitStats();
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.last = performance.now();
  }

  setMode(m: ColorMode, animate = true): void {
    if (m === this.mode) return;
    this.mode = m;
    const to = m === 'light' ? 1 : 0;
    gsap.killTweensOf(this, 'modeV');
    if (!animate || reducedMotion()) this.modeV = to;
    else {
      gsap.to(this, { modeV: to, duration: 0.9, ease: 'power2.inOut' });
      this.ripple(this.dw / 2, this.dh * 0.4, 1.1);
    }
    this.emitStats();
  }

  // ------------------------------------------------------------------ public: scene

  add(o: Partial<Blob> = {}): Blob {
    const b = makeBlob(o);
    this.blobs.push(b);
    return b;
  }

  circle(x: number, y: number, r: number, o: Partial<Blob> = {}): Blob {
    return this.add({ ...o, x, y, r });
  }

  /** Horizontal pill centred on (x, y): `half` is the half-length of the straight part. */
  pill(x: number, y: number, half: number, r: number, o: Partial<Blob> = {}): Blob {
    return this.add({ ...o, x, y, r, ax: -half, bx: half });
  }

  rbox(x: number, y: number, hw: number, hh: number, cr: number, o: Partial<Blob> = {}): Blob {
    return this.add({ ...o, x, y, hw, hh, cr, box: 1 });
  }

  remove(b: Blob): void {
    gsap.killTweensOf(b);
    const i = this.blobs.indexOf(b);
    if (i >= 0) this.blobs.splice(i, 1);
    this.anchors.delete(b);
    this.follows = this.follows.filter((f) => f.b !== b);
  }

  /** Remove every non-anchored blob and droplet (scene reset). */
  clearScene(): void {
    for (const b of this.blobs.slice()) if (!this.anchors.has(b)) this.remove(b);
    this.particles.length = 0;
    this.follows.length = 0;
    this.ripples.length = 0;
    this.scene.heat = this.scene.agit = this.scene.flash = 0;
  }

  /** Glue a blob to a DOM element (measured every frame; follows scroll, transforms, layout). */
  anchor(el: Element, o: AnchorOptions = {}): Blob {
    const livedFor = performance.now() - this.startedAt;
    const appear = o.appear === 'auto' || o.appear === undefined ? (livedFor > 400 ? 'pour' : 'instant') : o.appear;
    const b = this.add({
      film: o.film ?? 0.34,
      tar: o.tar ?? 0,
      glow: o.glow ?? 0,
      prio: o.prio ?? 0,
      box: o.shape === 'box' ? 1 : 0,
      sc: appear === 'pour' ? 0 : 1,
    });
    const a: Anchor = { b, el, shape: o.shape ?? 'pill', pad: o.pad ?? 0, cr: o.cr ?? null, state: '', want: '' };
    if (a.shape === 'box' && a.cr === null) {
      const r = parseFloat(getComputedStyle(el).borderTopLeftRadius);
      a.cr = Number.isFinite(r) ? r : 20;
    }
    this.anchors.set(b, a);
    this.measureAnchor(a);
    if (appear === 'pour') gsap.to(b, { sc: 1, duration: reducedMotion() ? 0.3 : 0.75, ease: reducedMotion() ? 'power2.out' : 'back.out(1.7)', delay: 0.04 });
    // CSS chrome until a frame with this blob is actually on screen (the engine may be hidden,
    // throttled or not drawing yet): never an empty, transparent body
    this.setLq(a, 'off');
    return b;
  }

  /** Detach from the element; the blob drains away at its last position unless `animate` is false. */
  release(b: Blob, animate = true): void {
    const a = this.anchors.get(b);
    if (a) {
      this.setLq(a, '');
      this.anchors.delete(b);
    }
    if (!animate || !this.live) {
      this.remove(b);
      return;
    }
    gsap.killTweensOf(b, 'sc');
    gsap.to(b, { sc: 0, duration: 0.28, ease: 'power2.in', onComplete: () => this.remove(b) });
  }

  /** Keep a DOM element (absolutely positioned at 0,0 in design space) centred on a blob. */
  follow(el: HTMLElement | SVGElement, b: Blob, ox = 0, oy = 0): () => void {
    const f: Follow = { el, b, ox, oy, last: '' };
    this.follows.push(f);
    return () => {
      this.follows = this.follows.filter((x) => x !== f);
    };
  }

  ripple(x: number, y: number, s = 1): void {
    if (reducedMotion()) s *= 0.4;
    this.ripples.push({ x, y, t: 0, s });
    if (this.ripples.length > 4) this.ripples.shift();
  }

  flash(v: number): void {
    this.scene.flash = Math.max(this.scene.flash, reducedMotion() ? v * 0.3 : v);
  }

  /** A ballistic / spring-pulled mercury droplet that stretches along its velocity. */
  droplet(o: DropletOptions): Blob | null {
    if (!this.live) return null;
    if (this.particles.length >= this.q.fx) return null;
    const b = this.add({ x: o.x, y: o.y, r: o.r, tar: o.tar ?? 0, glow: o.glow ?? 0, film: o.film ?? 0.5, prio: 2 });
    this.particles.push({
      b,
      vx: o.vx ?? 0,
      vy: o.vy ?? 0,
      g: o.g ?? 1400,
      k: o.k ?? 0,
      px: o.px ?? 0,
      py: o.py ?? 0,
      damp: o.damp ?? 0,
      life: o.life ?? 1,
      t: 0,
      r0: o.r,
    });
    return b;
  }

  /** Crown splash: droplets leap off a surface of radius R and get sucked back in. */
  splash(cx: number, cy: number, R: number, n: number, big = false): void {
    if (reducedMotion()) n = Math.min(n, 2);
    for (let k = 0; k < n; k++) {
      const an = rnd() * TAU;
      const sp = (big ? 1050 : 720) * (0.6 + rnd() * 0.6);
      this.droplet({
        x: cx + Math.cos(an) * R * 0.85,
        y: cy + Math.sin(an) * R * 0.85,
        vx: Math.cos(an) * sp,
        vy: Math.sin(an) * sp,
        r: (big ? 11 : 7) * (0.7 + rnd() * 0.6),
        g: 0,
        k: 24,
        px: cx,
        py: cy,
        damp: 1.6,
        life: 1.05 + rnd() * 0.35,
        film: 0.6,
      });
    }
  }

  /** Fountain: droplets thrown up that fall back under gravity. */
  fountain(
    cx: number,
    cy: number,
    w: number,
    n: number,
    o: { spread?: number; sp?: number; r?: number; g?: number; life?: number; film?: number; glow?: number; tar?: number } = {},
  ): void {
    if (reducedMotion()) n = Math.min(n, 3);
    for (let k = 0; k < n; k++) {
      const an = -Math.PI / 2 + (rnd() - 0.5) * (o.spread ?? 2.2);
      const sp = (o.sp ?? 620) * (0.65 + rnd() * 0.6);
      this.droplet({
        x: cx + (rnd() - 0.5) * w,
        y: cy,
        vx: Math.cos(an) * sp,
        vy: Math.sin(an) * sp,
        r: (o.r ?? 8) * (0.7 + rnd() * 0.6),
        g: o.g ?? 1500,
        life: (o.life ?? 1.2) + rnd() * 0.4,
        film: o.film ?? 0.8,
        glow: o.glow ?? 0,
        tar: o.tar ?? 0,
      });
    }
  }

  /** Element box in design units, centre-based. */
  measure(el: Element): LocalRect {
    const r = this.rect ?? this.canvas.getBoundingClientRect();
    const u = this.unitFor(r);
    const q = el.getBoundingClientRect();
    return { x: (q.left - r.left + q.width / 2) / u, y: (q.top - r.top + q.height / 2) / u, w: q.width / u, h: q.height / u };
  }

  /**
   * Test hook (`?lqdebug`): the anchors as drawn right now — shape and blob geometry in design
   * units — plus the quality in use. Playwright checks content against the blob outlines with it.
   */
  debug(): {
    tier: Tier;
    level: number;
    dpr: number;
    unit: number;
    presented: boolean;
    drawn: number;
    blobs: number;
    particles: number;
    follows: number;
    anchors: { el: Element; shape: Shape; state: string; b: Blob }[];
  } {
    return {
      tier: this._tier,
      level: this.lv,
      dpr: this.dpr,
      unit: this.unit,
      presented: this.presented,
      drawn: this.lastPackN,
      blobs: this.blobs.length,
      particles: this.particles.length,
      follows: this.follows.length,
      anchors: [...this.anchors.values()].map((a) => ({ el: a.el, shape: a.shape, state: a.state, b: { ...a.b } })),
    };
  }

  /** Viewport point → design units. */
  toLocal(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.rect ?? this.canvas.getBoundingClientRect();
    const u = this.unitFor(r);
    return { x: (clientX - r.left) / u, y: (clientY - r.top) / u };
  }

  destroy(): void {
    if (this.dead) return;
    this.dead = true;
    gsap.ticker.remove(this.tick);
    (window as unknown as { __lq?: Set<LiquidEngine> }).__lq?.delete(this);
    this.leave?.();
    this.leave = null;
    gsap.killTweensOf(this.blobs);
    gsap.killTweensOf(this);
    gsap.killTweensOf(this.scene);
    for (const a of this.anchors.values()) this.setLq(a, '');
    this.anchors.clear();
    this.modeObs?.disconnect();
    this.io?.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    const gl = this.gl;
    if (gl) {
      this.timer?.destroy();
      for (const p of this.progs.values()) gl.deleteProgram(p.p);
      for (const w of this.warming.values()) gl.deleteProgram(w.p);
      if (this.buf) gl.deleteBuffer(this.buf);
      if (this.tileTex) gl.deleteTexture(this.tileTex);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    this.timer = null;
    this.gl = null;
    this.statsListeners.clear();
  }

  // ------------------------------------------------------------------ frame

  /**
   * Design units → on-screen CSS px. TV: the canvas width over the design width. Otherwise one
   * unit is one CSS px of the canvas's own layout, so a phone screen inside a scaled preview
   * frame (the rehearsal) keeps its real proportions and followers line up with its blobs.
   */
  private unitFor(r: DOMRect): number {
    const dwOpt = this.opts.designWidth;
    if (dwOpt && r.width > 0) return r.width / dwOpt;
    const lw = this.layoutW || this.canvas.offsetWidth;
    return lw > 0 && r.width > 0 ? r.width / lw : 1;
  }

  private setLq(a: Anchor, s: Anchor['state']): void {
    if (a.state === s) return;
    a.state = s;
    if (s === '') a.el.removeAttribute('data-lq');
    else a.el.setAttribute('data-lq', s);
  }

  /** Back to CSS chrome until the next drawn frame (see `presented`). */
  private unpresent(): void {
    this.presented = false;
    this.canvas.style.visibility = 'hidden';
    for (const a of this.anchors.values()) {
      a.want = '';
      this.setLq(a, 'off');
    }
  }

  /** A frame is on the canvas: show it and let every body it contains drop its CSS chrome. */
  private present(): void {
    if (!this.presented) {
      this.presented = true;
      this.canvas.style.visibility = '';
    }
    for (const a of this.anchors.values()) if (a.want) this.setLq(a, a.want);
  }

  private refreshLive(): void {
    // not live (tier 0, context lost): CSS chrome now. Live again: the next drawn frame calls
    // present(). A tier change while presenting keeps the current frame (no CSS flash).
    if (!this.live) this.unpresent();
  }

  private measureAnchor(a: Anchor): boolean {
    const r = this.rect ?? this.canvas.getBoundingClientRect();
    const u = this.unitFor(r);
    const b = a.b;
    if (!a.el.isConnected) return false;
    const q = a.el.getBoundingClientRect();
    if (q.width < 0.5 || q.height < 0.5) return false;
    // an element faded out / hidden by a beat (opacity 0, visibility hidden) takes its blob with
    // it — otherwise the liquid body would float there on its own (podium avatars before they drop)
    if (hidden(a.el)) return false;
    // cull: entirely outside the canvas (scrolled away)
    if (q.right < r.left - 40 || q.left > r.right + 40 || q.bottom < r.top - 40 || q.top > r.bottom + 40) return false;
    const w = q.width / u + a.pad * 2;
    const h = q.height / u + a.pad * 2;
    b.x = (q.left - r.left) / u + q.width / u / 2;
    b.y = (q.top - r.top) / u + q.height / u / 2;
    if (a.shape === 'circle') {
      b.r = Math.min(w, h) / 2;
      b.ax = b.bx = b.ay = b.by = 0;
    } else if (a.shape === 'pill') {
      if (w >= h) {
        const hr = h / 2;
        b.r = hr;
        b.ax = -(w / 2 - hr);
        b.bx = w / 2 - hr;
        b.ay = b.by = 0;
      } else {
        const hr = w / 2;
        b.r = hr;
        b.ay = -(h / 2 - hr);
        b.by = h / 2 - hr;
        b.ax = b.bx = 0;
      }
    } else {
      b.hw = w / 2;
      b.hh = h / 2;
      b.cr = Math.min(a.cr ?? 20, b.hw, b.hh);
    }
    return true;
  }

  private killParticle(i: number): void {
    const p = this.particles[i];
    if (!p) return;
    this.particles.splice(i, 1);
    const j = this.blobs.indexOf(p.b);
    if (j >= 0) this.blobs.splice(j, 1);
  }

  private simulate(dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i] as Particle;
      const b = p.b;
      p.t += dt;
      if (p.k) {
        p.vx += (p.px - b.x) * p.k * dt;
        p.vy += (p.py - b.y) * p.k * dt;
      }
      if (p.damp) {
        const f = Math.exp(-p.damp * dt);
        p.vx *= f;
        p.vy *= f;
      }
      p.vy += p.g * dt;
      b.x += p.vx * dt;
      b.y += p.vy * dt;
      const sp = Math.hypot(p.vx, p.vy);
      const L = sp > 1 ? Math.min(sp * 0.022, b.r * 2.2) : 0;
      b.ax = sp > 1 ? (-p.vx / sp) * L : 0;
      b.ay = sp > 1 ? (-p.vy / sp) * L : 0;
      const u = p.t / p.life;
      b.r = p.r0 * (u < 0.65 ? 1 : Math.max(0, 1 - (u - 0.65) / 0.35));
      if (u >= 1 || b.y > this.dh + 140) this.killParticle(i);
    }
    for (const r of this.ripples) r.t += dt;
    this.ripples = this.ripples.filter((r) => r.t < 2.6);
    const s = this.scene;
    s.flash *= Math.exp(-dt * 3.2);
    if (s.flash < 0.002) s.flash = 0;
  }

  private pack(prog: Prog, cap: number): number {
    const A = prog.A;
    const P = prog.P;
    const nb = Math.min(prog.nb, cap);
    const pad = this.scene.k * 3 + 40;
    let n = 0;
    for (let prio = 0; prio <= 2; prio++) {
      for (const b of this.blobs) {
        const bp = b.prio <= 0 ? 0 : b.prio >= 2 ? 2 : Math.round(b.prio);
        if (bp !== prio || !b.on || b.sc <= 0.002) continue;
        const a = this.anchors.get(b);
        const x = b.x + b.dx;
        const y = b.y + b.dy;
        let ok = true;
        let ext = 0;
        if (b.box) {
          const hw = b.hw * b.sc;
          const hh = b.hh * b.sc;
          if (hw < 0.5 || hh < 0.5) ok = false;
          ext = Math.max(hw, hh);
        } else {
          const r = b.r * b.sc;
          if (r < 0.4) ok = false;
          ext = r + Math.max(Math.abs(b.ax), Math.abs(b.bx), Math.abs(b.ay), Math.abs(b.by)) * b.sc;
        }
        if (ok && (x + ext < -pad || x - ext > this.dw + pad || y + ext < -pad || y - ext > this.dh + pad)) ok = false;
        if (!ok) continue;
        if (n >= nb) {
          if (a) a.want = 'off';
          continue;
        }
        if (a) a.want = 'live';
        const i = n * 4;
        if (b.box) {
          const hw = b.hw * b.sc;
          const hh = b.hh * b.sc;
          A[i] = x;
          A[i + 1] = y;
          A[i + 2] = hw;
          A[i + 3] = hh;
          P[i] = -Math.max(0.5, Math.min(b.cr * b.sc, hw, hh));
        } else {
          A[i] = x + b.ax * b.sc;
          A[i + 1] = y + b.ay * b.sc;
          A[i + 2] = x + b.bx * b.sc;
          A[i + 3] = y + b.by * b.sc;
          P[i] = b.r * b.sc;
        }
        P[i + 1] = b.tar;
        P[i + 2] = b.glow;
        P[i + 3] = b.film;
        n++;
      }
    }
    return n;
  }

  /** Did the packed scene change since the last rendered frame? (idle throttling) */
  private changed(prog: Prog, n: number): boolean {
    const len = n * 4;
    let diff = n !== this.prevN;
    if (this.prevA.length < prog.A.length) {
      this.prevA = new Float32Array(prog.A.length);
      this.prevP = new Float32Array(prog.P.length);
      diff = true;
    }
    if (!diff) {
      for (let i = 0; i < len; i++) {
        if (Math.abs((prog.A[i] as number) - (this.prevA[i] as number)) > 0.05 || Math.abs((prog.P[i] as number) - (this.prevP[i] as number)) > 0.002) {
          diff = true;
          break;
        }
      }
    }
    if (diff) {
      this.prevA.set(prog.A.subarray(0, len));
      this.prevP.set(prog.P.subarray(0, len));
      this.prevN = n;
    }
    return diff;
  }

  private tick = (): void => {
    const now = performance.now();
    const dtm = now - this.last;
    this.last = now;
    if (this.dead) return;
    budget.frame(gsap.ticker.frame, now);
    if (this.paused || document.hidden || !this.onScreen || !this.live || !this.gl) return;
    this.timer?.poll();
    const dt = Math.min(dtm / 1000, 0.05);

    // reads: canvas + anchors
    const rect = this.canvas.getBoundingClientRect();
    this.rect = rect;
    this.layoutW = this.canvas.offsetWidth;
    if (now >= this.nextProbe) {
      const was = this.occluded;
      this.occluded = covered(this.canvas, rect);
      this.nextProbe = now + (this.occluded ? 100 : 500);
      // covered: CSS chrome underneath (nobody sees it) and no frames; uncovered: the next frame
      // takes over again, nothing stale shows in between
      if (this.occluded && !was) this.unpresent();
    }
    if (this.occluded) return;
    this.time += dt;
    this.unit = this.unitFor(rect);
    this.dw = Math.max(1, rect.width / this.unit);
    this.dh = Math.max(1, rect.height / this.unit);
    for (const a of this.anchors.values()) {
      if (!this.measureAnchor(a)) a.b.on = 0;
      else a.b.on = 1;
    }

    this.simulate(dt);

    // writes: followers
    for (const f of this.follows) {
      const b = f.b;
      const tr = `translate3d(${(b.x + b.dx + f.ox).toFixed(1)}px,${(b.y + b.dy + f.oy).toFixed(1)}px,0)`;
      if (tr !== f.last) {
        f.el.style.transform = tr;
        f.last = tr;
      }
    }

    const tier = this._tier as 1 | 2 | 3;
    // the device ratio can change (window moved to another display, browser zoom)
    this.q = quality(this.cls, tier, this.lv, devRatio());
    this.dpr = this.q.dpr;
    const prog = this.program(tier);
    if (!prog) {
      this.applyTier(0);
      return;
    }
    const n = this.pack(prog, this.q.cap);
    this.lastPackN = n;
    const s = this.scene;
    const moved = this.changed(prog, n);
    if (moved) this.tilesDirty = true;
    const busy =
      moved ||
      this.ripples.length > 0 ||
      this.particles.length > 0 ||
      s.flash > 0 ||
      s.agit > 0.001 ||
      s.heat > 0.001 ||
      (this.modeV > 0.001 && this.modeV < 0.999);
    const capMs = this.q.fps < 60 ? 1000 / this.q.fps - 4 : 0;
    const idleMs = this.opts.profile === 'phone' || tier === 1 ? 1000 / 30 - 4 : 0;
    const interval = Math.max(capMs, busy ? 0 : idleMs);
    if (now - this.lastRender < interval) return;
    this.lastRender = now;
    this.draw(prog, n);
    this.present();
    budget.drew();
    if (this.warmAt && now >= this.warmAt) {
      this.warmAt = 0;
      this.warm();
    }
    this.drewInWindow = true;
    this.fpsCount++;
    if (now - this.fpsT0 >= 1000) {
      this._stats = { ...this._stats, fps: Math.round((this.fpsCount * 1000) / (now - this.fpsT0)), blobs: n };
      this.fpsCount = 0;
      this.fpsT0 = now;
      this.emitStats();
    }
  };

  /** Rebuild and upload the per-tile blob lists (WebGL2) when the scene or the grid changed. */
  private tiles(gl: WebGL2RenderingContext, prog: Prog, n: number): TileGrid {
    const grid = makeGrid(this.dw, this.dh, this.grid);
    const shape = `${grid.tx * grid.slots}x${grid.ty}`;
    if (grid !== this.grid || this.tilesDirty || this.tilesK !== this.scene.k || shape !== this.gridTex) {
      this.grid = grid;
      buildTiles(grid, prog.A, prog.P, n, this.scene.k);
      this.tilesK = this.scene.k;
      this.tilesDirty = false;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tileTex);
      if (shape !== this.gridTex) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, grid.tx * grid.slots, grid.ty, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, grid.data);
        this.gridTex = shape;
      } else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, grid.tx * grid.slots, grid.ty, gl.RED_INTEGER, gl.UNSIGNED_BYTE, grid.data);
    }
    return grid;
  }

  private draw(prog: Prog, n: number): void {
    const gl = this.gl;
    const rect = this.rect;
    if (!gl || !rect) return;
    // the drawing buffer follows the canvas's on-screen size (after any ancestor scale)
    const W = Math.max(1, Math.round(rect.width * this.dpr));
    const H = Math.max(1, Math.round(rect.height * this.dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    const rm = reducedMotion();
    const s = this.scene;
    const Rb = this.Rb;
    Rb.fill(0);
    this.ripples.forEach((q, i) => {
      Rb[i * 4] = q.x;
      Rb[i * 4 + 1] = q.y;
      Rb[i * 4 + 2] = q.t;
      Rb[i * 4 + 3] = q.s;
    });
    const grid = prog.tiles ? this.tiles(gl as WebGL2RenderingContext, prog, n) : null;
    this.timer?.begin();
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(prog.p);
    const u = prog.u;
    gl.uniform4f(u.uFrame, 0, 0, W, H);
    gl.uniform2f(u.uDesign, this.dw, this.dh);
    gl.uniform1f(u.uCorner, this.opts.corner ?? 0);
    gl.uniform1f(u.uTime, this.time * (rm ? 0.4 : 1));
    gl.uniform1f(u.uPx, this.dw / W);
    gl.uniform1f(u.uK, s.k);
    gl.uniform1f(u.uBevel, s.bevel);
    gl.uniform1f(u.uHeat, s.heat);
    gl.uniform1f(u.uAgit, rm ? s.agit * 0.3 : s.agit);
    gl.uniform1f(u.uFlash, rm ? s.flash * 0.3 : s.flash);
    gl.uniform1f(u.uCalm, rm ? 0.35 : 1);
    gl.uniform1f(u.uMode, this.modeV);
    gl.uniform1i(u.uN, n);
    gl.uniform4fv(u.uA, prog.A);
    gl.uniform4fv(u.uP, prog.P);
    gl.uniform4fv(u.uR, Rb);
    if (grid) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tileTex);
      gl.uniform3f(u.uTile, grid.ts, grid.tx, grid.ty);
      gl.uniform1i(u.uSlots, grid.slots);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.timer?.end();
  }

  // ------------------------------------------------------------------ governor (quality.ts budget)

  private readonly member: Member;

  private makeMember(): Member {
    return {
    importance: this.opts.profile === 'tv' ? 3 : this.canvas.parentElement?.classList.contains('lq-contained') ? 2 : 1,
    pixels: () => this.canvas.width * this.canvas.height,
    active: () => this.drewInWindow && this.live,
    nextIsResolution: () => {
      if (this._tier === 0) return false;
      const t = this._tier as 1 | 2 | 3;
      const l = nextLevel(this.cls, t, this.lv, 1, devRatio());
      return l === null || quality(this.cls, t, l, devRatio()).dpr < this.q.dpr - 1e-3;
    },
    canDegrade: () => {
      if (this._tier === 0) return false;
      const t = this._tier as 1 | 2 | 3;
      return nextLevel(this.cls, t, this.lv, 1, devRatio()) !== null || (!this.manual && this.cls === 'phone' && t > 1);
    },
    degrade: () => this.stepDown(),
    recover: () => this.stepUp(),
    takeGpu: () => (this.timer ? this.timer.take() : null),
    drop: () => this.applyTier(0),
    report: (frameMs, gpuMs) => {
      this.drewInWindow = false;
      this._stats = { ...this._stats, frameMs: Math.round(frameMs * 10) / 10, gpuMs: gpuMs === null ? null : Math.round(gpuMs * 10) / 10 };
      this.emitStats();
    },
    };
  }

  private stepDown(): boolean {
    if (this._tier === 0) return false;
    const t = this._tier as 1 | 2 | 3;
    const l = nextLevel(this.cls, t, this.lv, 1, devRatio());
    if (l !== null) {
      this.setLevel(l);
      return true;
    }
    if (!this.manual && this.cls === 'phone' && t > 1) {
      this.applyTier((t - 1) as Tier, 0);
      return true;
    }
    return false;
  }

  private stepUp(): boolean {
    if (this._tier === 0) return false;
    const t = this._tier as 1 | 2 | 3;
    const l = nextLevel(this.cls, t, this.lv, -1, devRatio());
    if (l !== null) {
      this.setLevel(l);
      return true;
    }
    if (!this.manual && this.cls === 'phone' && t < this.opts.maxTier) {
      const up = (t + 1) as 2 | 3;
      this.applyTier(up, ladder(this.cls, up).length - 1);
      return true;
    }
    return false;
  }

  private emitStats(): void {
    this._stats = {
      ...this._stats,
      tier: this.tier,
      dpr: Math.round(this.dpr * 100) / 100,
      level: this.lv,
      gl: this.gl2 ? 2 : 1,
      mode: this.mode,
      lost: this.lost,
      blobs: this.lastPackN,
    };
    for (const fn of this.statsListeners) fn(this._stats);
  }
}
