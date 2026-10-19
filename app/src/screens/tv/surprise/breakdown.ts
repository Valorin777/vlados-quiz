// «Сбой эфира»: the Liquid Chrome world breaking down on the TV (~2.6 s) before the «Сюрприз» video
// (shared/engine/surprise.ts). Imperative and self-contained: it takes over the stage on screen for
// its length and gives it back untouched.
//
//   0      freeze-frame hitch: the liquid engine and every GSAP choreography stop mid-motion, a
//          click, one hard jump of the picture
//   0.2 s  escalation: RGB channel split and chromatic aberration over the whole stage, horizontal
//          tearing slices sliding (the liquid AND the DOM tear along the same bands), datamosh
//          blocks, pixel-sort smears, screen shake, static; a bit-crushed buzz stutters and grows
//   1.5 s  meltdown: the chrome bodies spike and shatter into mercury beads flying outward,
//          inverted slices, a static blast
//   2.15 s CRT power-off: the picture collapses into a white-hot horizontal line, the line into a
//          dot, the dot goes out — pure black (the layer's black takes over at the end)
//
// The liquid is post-processed by a WebGL pass: a snapshot of the liquid canvas (taken right after
// the engine drew its frame) through a glitch shader, drawn over the frozen canvas and under the
// DOM. The DOM gets the same tears (static clones clipped to the same bands, with the snapshot
// under them), a drop-shadow channel split and the shake; noise, scanlines, flashes and the CRT
// line are drawn on the layer's own 2D canvas on top. Everything is driven by the clock (a late
// start joins mid-way), transform/opacity-only on the big layers, the filters stepped (~15 Hz).
// Reduced motion: a short freeze, soft static and a fade to black — no shake, no flashes.

import { gsap } from 'gsap';
import type { LiquidEngine } from '../../../visual';

export interface BreakdownOpts {
  /** .tv-stage (the liquid stage: its canvas and the surface). */
  stage: HTMLElement;
  /** .tv-live (the show's DOM: the scene, reactions, banners). */
  live: HTMLElement | null;
  /** The layer's own 2D canvas over everything (1280×720 design px). */
  fx: HTMLCanvasElement;
  engine: LiquidEngine | null;
  /** Already this far in (ms): a late start joins mid-way. */
  fromMs: number;
  /** Its length (SURPRISE.glitchMs). */
  durMs: number;
  reduced: boolean;
  /** Seed of the random tears (the same moment looks the same on every replay). */
  seed?: number;
}

export interface Breakdown {
  /** Gives the stage back (idempotent): transforms, filters, clones, the freeze. */
  stop(): void;
}

const W = 1280;
const H = 720;

// ------------------------------------------------------------------ randomness & easing

function mulberry(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const seg = (t: number, a: number, b: number): number => clamp01((t - a) / (b - a));
const easeIn = (x: number): number => x * x * x;

// ------------------------------------------------------------------ the liquid snapshot

/**
 * A copy of the liquid canvas taken in the ticker right after the engine drew (its drawing buffer
 * is only valid until the frame is presented). Null without an engine, or when nothing came out.
 */
function snapLiquid(canvas: HTMLCanvasElement | null, engine: LiquidEngine | null): Promise<HTMLCanvasElement | null> {
  if (!canvas || !engine || canvas.width < 16 || canvas.style.visibility === 'hidden') return Promise.resolve(null);
  return new Promise((done) => {
    let tries = 0;
    const fn = () => {
      tries++;
      const scale = Math.min(1, 1920 / canvas.width);
      const out = document.createElement('canvas');
      out.width = Math.max(16, Math.round(canvas.width * scale));
      out.height = Math.max(9, Math.round(canvas.height * scale));
      const ctx = out.getContext('2d');
      let ok = false;
      if (ctx) {
        try {
          ctx.drawImage(canvas, 0, 0, out.width, out.height);
          // a cleared buffer reads as transparent: probe a few pixels
          const probe = ctx.getImageData(Math.floor(out.width / 2), Math.floor(out.height / 2), 1, 1).data;
          const corner = ctx.getImageData(4, 4, 1, 1).data;
          ok = (probe[3] ?? 0) > 0 || (corner[3] ?? 0) > 0;
        } catch {
          ok = false;
        }
      }
      if (ok || tries >= 4) {
        gsap.ticker.remove(fn);
        done(ok ? out : null);
      } else engine.flash(0.001);
    };
    // appended after the engine's own tick: runs right after it drew this frame
    gsap.ticker.add(fn);
    engine.flash(0.001);
  });
}

// ------------------------------------------------------------------ the WebGL pass over the liquid

const VERT = `attribute vec2 a;varying vec2 v;void main(){v=vec2(a.x*.5+.5,.5-a.y*.5);gl_Position=vec4(a,0.,1.);}`;

// v: 0..1 with (0,0) at the top left. uBand: y0, y1 (v units), dx (v units), kind 0 shift · 1 inverted · 2 pixel-sorted
const FRAG = `precision mediump float;
varying vec2 v;
uniform sampler2D uTex;
uniform vec2 uRes;
uniform float uT,uSeed,uSplit,uBlock,uSort,uDrop,uSpike,uNoise,uInv,uBright,uScan;
uniform vec4 uBand[8];
float h2(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
float lum(vec3 c){return dot(c,vec3(.299,.587,.114));}
vec3 tex(vec2 uv){return texture2D(uTex,clamp(uv,vec2(.001),vec2(.999))).rgb;}
vec3 rgb(vec2 uv,float px){vec2 o=vec2(px/uRes.x,px*.18/uRes.y);return vec3(tex(uv+o).r,tex(uv).g,tex(uv-o).b);}
void main(){
  vec2 uv=v;
  float kind=-1.;
  for(int i=0;i<8;i++){vec4 b=uBand[i];if(uv.y>=b.x&&uv.y<b.y){uv.x+=b.z;kind=b.w;}}
  // datamosh: whole blocks copied from somewhere else
  vec2 cell=floor(uv*vec2(24.,13.5));
  if(h2(cell+uSeed)<uBlock*.42){uv+=(vec2(h2(cell+uSeed+3.1),h2(cell+uSeed+9.7))-.5)*vec2(.28,.1);}
  // the chrome spikes: pixels pulled along the brightness gradient, jagged by angle
  if(uSpike>0.){
    vec2 e=vec2(3./uRes.x,3./uRes.y);
    float gx=lum(tex(uv+vec2(e.x,0.)))-lum(tex(uv-vec2(e.x,0.)));
    float gy=lum(tex(uv+vec2(0.,e.y)))-lum(tex(uv-vec2(0.,e.y)));
    vec2 g=vec2(gx,gy);
    float ang=atan(uv.y-.5,(uv.x-.5)*1.78);
    float jag=pow(abs(sin(ang*23.+uSeed*6.)),6.)+.25*h2(floor(uv*90.)+uSeed);
    uv-=g*uSpike*.9*jag;
  }
  // meltdown: the picture bursts outward from the centre
  vec2 ctr=vec2(.5);
  uv=ctr+(uv-ctr)/(1.+uDrop*.55);
  vec3 c=rgb(uv,uSplit);
  // pixel sort: bright pixels smear down the sorted slices (and a little everywhere at the peak)
  float sortAmt=kind>1.5?1.:uSort*.35;
  if(sortAmt>0.){
    vec3 m=c;
    for(int k=1;k<8;k++){vec3 s=tex(uv-vec2(0.,float(k)*.018*sortAmt));if(lum(s)>lum(m))m=s;}
    c=mix(c,m,sortAmt);
  }
  // mercury beads: the bright bodies break into droplets
  if(uDrop>0.){
    vec2 asp=vec2(uRes.x/uRes.y,1.);
    float cs=mix(.07,.026,uDrop);
    vec2 q=uv*asp/cs;
    vec2 id=floor(q);
    vec2 f=fract(q)-.5+(vec2(h2(id+uSeed),h2(id+uSeed+5.))-.5)*.25*uDrop;
    vec3 cc=rgb((id+.5)*cs/asp,uSplit*.5);
    float L=lum(cc);
    float rad=.46*smoothstep(.18,.62,L)*(1.-.35*h2(id+1.7));
    float d=length(f);
    float bead=1.-smoothstep(rad-.05,rad+.02,d);
    float spec=pow(max(0.,1.-length(f-vec2(-.13,-.15))/max(rad*.7,.01)),4.);
    vec3 b=cc*(.75+.5*(1.-d/max(rad,.01)))+vec3(spec*.9);
    c=mix(c,mix(c*.25,b,bead),uDrop*smoothstep(.15,.5,L));
  }
  // inverted slices / flashes
  float inv=max(uInv,kind>.5&&kind<1.5?1.:0.);
  c=mix(c,vec3(1.)-c,inv);
  // static, scanlines, the CRT's white heat
  float n=h2(floor(v*uRes/2.)+fract(uT*61.)*97.);
  c=mix(c,vec3(n),uNoise);
  c*=1.-uScan*.35*step(.5,fract(v.y*uRes.y/3.));
  c=c*(1.+uBright)+uBright*.35;
  gl_FragColor=vec4(c,1.);
}`;

const UNIFORMS = ['uTex', 'uRes', 'uT', 'uSeed', 'uSplit', 'uBlock', 'uSort', 'uDrop', 'uSpike', 'uNoise', 'uInv', 'uBright', 'uScan', 'uBand'] as const;

interface GlPass {
  canvas: HTMLCanvasElement;
  draw(p: FrameParams, bands: Float32Array): void;
  destroy(): void;
}

function glPass(snap: HTMLCanvasElement, like: HTMLCanvasElement): GlPass | null {
  const canvas = document.createElement('canvas');
  canvas.className = 'tsu-gl';
  canvas.width = snap.width;
  canvas.height = snap.height;
  canvas.setAttribute('aria-hidden', 'true');
  let gl: WebGLRenderingContext | null = null;
  try {
    gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
  } catch {
    gl = null;
  }
  if (!gl) return null;
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn('surprise glitch shader:', gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  };
  const vs = sh(gl.VERTEX_SHADER, VERT);
  const fs = sh(gl.FRAGMENT_SHADER, FRAG);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.bindAttribLocation(prog, 0, 'a');
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn('surprise glitch link:', gl.getProgramInfoLog(prog));
    return null;
  }
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, snap);
  gl.useProgram(prog);
  const u = {} as Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>;
  for (const n of UNIFORMS) u[n] = gl.getUniformLocation(prog, n === 'uBand' ? 'uBand[0]' : n);
  gl.uniform1i(u.uTex, 0);
  // exactly over the liquid canvas (same box), under the DOM surface
  canvas.style.cssText = `position:absolute;inset:0;width:100%;height:100%;z-index:-1;pointer-events:none;display:block`;
  like.after(canvas);
  const g = gl;
  return {
    canvas,
    draw(p, bands) {
      g.viewport(0, 0, canvas.width, canvas.height);
      g.uniform2f(u.uRes, canvas.width, canvas.height);
      g.uniform1f(u.uT, p.t / 1000);
      g.uniform1f(u.uSeed, p.seed);
      g.uniform1f(u.uSplit, p.split * (canvas.width / W));
      g.uniform1f(u.uBlock, p.block);
      g.uniform1f(u.uSort, p.sort);
      g.uniform1f(u.uDrop, p.drop);
      g.uniform1f(u.uSpike, p.spike);
      g.uniform1f(u.uNoise, p.noise * 0.4);
      g.uniform1f(u.uInv, p.invert);
      g.uniform1f(u.uBright, p.bright);
      g.uniform1f(u.uScan, p.scan);
      g.uniform4fv(u.uBand, bands);
      g.drawArrays(g.TRIANGLES, 0, 3);
    },
    destroy() {
      canvas.remove();
      g.deleteTexture(tex);
      g.deleteBuffer(buf);
      g.deleteProgram(prog);
      g.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}

// ------------------------------------------------------------------ the timeline

interface FrameParams {
  t: number;
  /** New random state (tears, blocks) every step. */
  step: number;
  seed: number;
  split: number;
  block: number;
  sort: number;
  drop: number;
  spike: number;
  noise: number;
  invert: number;
  bright: number;
  scan: number;
  shake: number;
  /** CRT collapse: vertical and horizontal scale of the picture (1 = whole). */
  sy: number;
  sx: number;
}

interface Band {
  y0: number;
  y1: number;
  dx: number;
  kind: 0 | 1 | 2;
}

/** Key moments at the full length (2.6 s); scaled to `durMs`. */
const K = { hitch: 200, peak: 1500, blast: 1820, crt: 2150, line: 2300, dot: 2430, end: 2600 } as const;

const smooth = (x: number): number => x * x * (3 - 2 * x);

/** Per-step random draws (a step holds its tears, blocks and bursts for 45–70 ms: digital, not jittery). */
const stepRand = (step: number, k: number): number => {
  const x = Math.sin(step * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

function params(t: number): FrameParams {
  const esc = seg(t, K.hitch, K.peak);
  const melt = seg(t, K.peak - 50, K.crt);
  const blast = t >= K.blast && t < K.blast + 110 ? 1 : 0;
  const amt = t < K.hitch ? 0 : Math.min(1, 0.18 + 0.82 * Math.pow(esc, 1.35));
  const stepMs = t < K.peak ? 70 : 45;
  const step = Math.floor(t / stepMs);
  const flick = stepRand(step, 1);
  const burst = stepRand(step, 2);
  // static comes in bursts that grow denser, then the blast; the picture itself stays readable
  const noise = t >= K.crt ? 0 : blast ? 0.9 : t < 600 ? 0 : (burst > 0.86 - 0.2 * esc ? 0.1 + 0.22 * burst * amt : 0.02) + 0.1 * melt;
  return {
    t,
    step,
    seed: (step * 7.13) % 97,
    split: t < K.hitch ? 0 : (3 + 26 * amt + 16 * melt) * (0.5 + flick * 0.8),
    block: amt * 0.55 + melt * 0.45,
    sort: Math.max(0, esc - 0.35) * 0.7 + melt * 0.6,
    drop: smooth(seg(t, K.peak - 50, K.blast + 80)) * 0.96,
    spike: melt > 0 ? 0.02 + melt * 0.06 : amt > 0.6 ? 0.012 : 0,
    noise,
    invert: blast ? 0 : flick > 0.93 && t > 900 ? 1 : 0,
    bright: t >= K.crt ? 0.35 + 2.6 * seg(t, K.crt, K.line) : 0,
    scan: amt,
    shake: t < K.hitch ? 0 : amt * (1 + melt),
    sy: t < K.crt ? 1 : Math.max(0.006, 1 - easeIn(seg(t, K.crt, K.line)) * 0.994),
    sx: t < K.line ? 1 : Math.max(0.003, 1 - easeIn(seg(t, K.line, K.dot)) * 0.997),
  };
}

function bandsFor(p: FrameParams, R: () => number): Band[] {
  if (p.t < K.hitch || p.t >= K.crt) return [];
  const n = Math.min(8, Math.floor(1 + (p.split / 42) * 7 + R() * 2));
  const out: Band[] = [];
  for (let i = 0; i < n; i++) {
    const h = 0.012 + R() * (0.03 + 0.1 * p.block);
    const y0 = R() * (1 - h);
    const dir = R() < 0.5 ? -1 : 1;
    const dx = dir * (0.006 + R() * (0.03 + 0.16 * p.block));
    const k = R();
    out.push({ y0, y1: y0 + h, dx, kind: k < 0.12 ? 1 : k < 0.3 && p.sort > 0.2 ? 2 : 0 });
  }
  return out;
}

// ------------------------------------------------------------------ the DOM tears

interface Tears {
  root: HTMLElement;
  bands: { el: HTMLElement; inner: HTMLElement; last: string }[];
}

/**
 * Static copies of the scene (the snapshot under them), each seen through one band: a clipping
 * box (overflow hidden) moved to the band, the copy inside moved back by as much — both only
 * transforms and a height, so a tear never repaints the copy (a clip-path per step did).
 */
function domTears(live: HTMLElement | null, snap: HTMLCanvasElement | null, count: number): Tears | null {
  const scene = live?.querySelector('.tv-scene-wrap');
  if (!live || !scene) return null;
  const root = document.createElement('div');
  root.className = 'tsu-tears';
  root.setAttribute('aria-hidden', 'true');
  const bands: Tears['bands'] = [];
  let bgSrc: HTMLCanvasElement | null = null;
  if (snap) {
    bgSrc = document.createElement('canvas');
    bgSrc.width = Math.round(snap.width / 2);
    bgSrc.height = Math.round(snap.height / 2);
    bgSrc.getContext('2d')?.drawImage(snap, 0, 0, bgSrc.width, bgSrc.height);
  }
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.className = 'tsu-tear';
    const inner = document.createElement('div');
    inner.className = 'tsu-tear-in';
    if (bgSrc) {
      const bg = document.createElement('canvas');
      bg.width = bgSrc.width;
      bg.height = bgSrc.height;
      bg.getContext('2d')?.drawImage(bgSrc, 0, 0);
      bg.className = 'tsu-tear-bg';
      inner.appendChild(bg);
    }
    const copy = scene.cloneNode(true) as HTMLElement;
    // the crowd band is dozens of selfies: not worth copying into a sliver
    copy.querySelectorAll('video, audio, .tv-crowd').forEach((m) => m.remove());
    copy.removeAttribute('data-outro');
    // a still copy: no entrance replaying in it
    copy.style.animation = 'none';
    inner.appendChild(copy);
    el.appendChild(inner);
    el.style.visibility = 'hidden';
    root.appendChild(el);
    bands.push({ el, inner, last: '' });
  }
  live.after(root);
  return { root, bands };
}

// ------------------------------------------------------------------ the fx layer (noise, lines, CRT)

function noiseTiles(n: number, w: number, h: number, R: () => number): HTMLCanvasElement[] {
  const out: HTMLCanvasElement[] = [];
  for (let k = 0; k < n; k++) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) continue;
    const img = ctx.createImageData(w, h);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = R() * 255;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    out.push(c);
  }
  return out;
}

function drawFx(ctx: CanvasRenderingContext2D, p: FrameParams, tiles: HTMLCanvasElement[], R: () => number, reduced: boolean): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = false;
  // static
  if (p.noise > 0.01 && tiles.length) {
    ctx.globalAlpha = Math.min(0.9, p.noise * (reduced ? 0.8 : 1));
    const tile = tiles[p.step % tiles.length] as HTMLCanvasElement;
    const ox = Math.floor(R() * 40);
    ctx.drawImage(tile, -ox, -Math.floor(R() * 20), w + 40, h + 20);
    ctx.globalAlpha = 1;
  }
  if (reduced) return;
  // tracking lines and hot scan bars
  if (p.t > K.hitch && p.t < K.crt) {
    const lines = Math.floor(1 + p.scan * 5);
    for (let i = 0; i < lines; i++) {
      const y = Math.floor(R() * h);
      const hot = R();
      ctx.fillStyle = hot < 0.5 ? 'rgba(255,255,255,0.55)' : hot < 0.75 ? 'rgba(255,40,140,0.5)' : 'rgba(40,255,230,0.5)';
      ctx.fillRect(0, y, w, 1 + Math.floor(R() * 2.5 * p.scan));
    }
    // corrupted macroblocks
    const blocks = Math.floor(p.block * 9);
    ctx.globalCompositeOperation = 'difference';
    for (let i = 0; i < blocks; i++) {
      const bw = 8 + Math.floor(R() * 60);
      const bh = 4 + Math.floor(R() * 26);
      ctx.fillStyle = ['#ff2d8a', '#27ffd8', '#fff36b', '#6b7dff'][Math.floor(R() * 4)] as string;
      ctx.fillRect(Math.floor(R() * w), Math.floor(R() * h), bw, bh);
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  // the hitch: one white flash line as the frame freezes
  if (p.t > 90 && p.t < 150) {
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillRect(0, h * 0.42, w, 2);
  }
  // CRT: the collapsing picture goes white-hot, then a line, then a dot
  if (p.t >= K.crt) {
    const cy = h / 2;
    const cx = w / 2;
    if (p.t < K.dot) {
      const lh = Math.max(1.2, (h / 2) * p.sy);
      const lw = (w / 2) * p.sx;
      ctx.globalCompositeOperation = 'lighter';
      const heat = seg(p.t, K.crt, K.line);
      ctx.fillStyle = `rgba(255,255,255,${(0.08 + 0.92 * heat * heat).toFixed(3)})`;
      ctx.shadowColor = 'rgba(200,235,255,0.95)';
      ctx.shadowBlur = 18;
      ctx.fillRect(cx - lw, cy - lh, lw * 2, lh * 2);
      ctx.shadowBlur = 0;
      ctx.globalCompositeOperation = 'source-over';
    } else {
      const k = seg(p.t, K.dot, K.end);
      const r = Math.max(0.5, 5 * (1 - k * 0.7));
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 6);
      g.addColorStop(0, `rgba(255,255,255,${(1 - k).toFixed(3)})`);
      g.addColorStop(0.25, `rgba(210,240,255,${((1 - k) * 0.6).toFixed(3)})`);
      g.addColorStop(1, 'rgba(120,180,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(cx - r * 6, cy - r * 6, r * 12, r * 12);
    }
  }
}

// ------------------------------------------------------------------ run

let frozenGsap = false;

/** Freezes GSAP's global timeline for the breakdown (unless something else — the hold — froze it). */
function freezeGsap(on: boolean): void {
  if (on) {
    if (gsap.globalTimeline.paused()) return;
    gsap.globalTimeline.pause();
    frozenGsap = true;
  } else if (frozenGsap) {
    frozenGsap = false;
    // the «стоп-экран» came meanwhile: it keeps everything frozen (TvShow releases it)
    if (!document.querySelector('.tv-show.is-held')) gsap.globalTimeline.resume();
  }
}

/** DEV: `&gx=nofilter,notears,nogl,nofx` switches parts off (perf checks). */
function gxParts(): Set<string> {
  try {
    return new Set((new URLSearchParams(location.search).get('gx') ?? '').split(','));
  } catch {
    return new Set();
  }
}

export function runBreakdown(o: BreakdownOpts): Breakdown {
  const off = gxParts();
  const gxOff = (part: string): boolean => off.has(part);
  const k = o.durMs / K.end;
  const liquid = o.stage.querySelector<HTMLCanvasElement>(':scope > .lq-canvas');
  const engine = o.engine;
  const t0 = performance.now() - o.fromMs;
  const R = mulberry((o.seed ?? 2609) ^ 0x5a17);
  const fxCtx = o.fx.getContext('2d');
  o.fx.width = 640;
  o.fx.height = 360;
  const tiles = noiseTiles(4, o.reduced ? 160 : 320, o.reduced ? 90 : 180, mulberry(77));
  let stopped = false;
  let raf = 0;
  let gl: GlPass | null = null;
  let tears: Tears | null = null;
  let lastStep = -1;
  let bands: Band[] = [];
  let bandBuf = new Float32Array(32);
  let jolt = { x: 0, y: 0, skew: 0 };
  let splitCss = '';
  const pictures = (): HTMLElement[] => [o.live, liquid, gl?.canvas ?? null, tears?.root ?? null].filter((x): x is HTMLElement => x !== null);
  const scaleK = (): number => o.stage.getBoundingClientRect().width / W || 1;

  document.documentElement.classList.add('tv-sur-dark');
  freezeGsap(true);
  // the breakdown steps opacity itself (the show's fade transition would smear it)
  if (o.live) o.live.style.transition = 'none';
  if (engine && !o.reduced) {
    void snapLiquid(liquid, engine).then((snap) => {
      if (stopped) return;
      engine.pause();
      if (snap && liquid && !gxOff('nogl')) gl = glPass(snap, liquid);
      if (!gxOff('notears')) tears = domTears(o.live, snap, 3);
    });
  } else {
    engine?.pause();
    if (!o.reduced) tears = domTears(o.live, null, 3);
  }

  const frame = () => {
    if (stopped) return;
    const t = (performance.now() - t0) / k;
    if (t >= K.end) {
      // the last frame: black (the layer's own black takes over now)
      if (fxCtx) {
        fxCtx.globalCompositeOperation = 'source-over';
        fxCtx.globalAlpha = 1;
        fxCtx.fillStyle = '#000';
        fxCtx.fillRect(0, 0, o.fx.width, o.fx.height);
      }
      return;
    }
    if (o.reduced) {
      // a short freeze, soft static, then down to black
      const p = params(Math.min(t, K.peak));
      const fade = seg(t, 900, K.end);
      if (fxCtx) {
        drawFx(fxCtx, { ...p, noise: Math.min(0.45, 0.1 + 0.4 * seg(t, 150, 900)), step: Math.floor(t / 90) }, tiles, R, true);
        fxCtx.globalAlpha = fade;
        fxCtx.fillStyle = '#000';
        fxCtx.fillRect(0, 0, o.fx.width, o.fx.height);
        fxCtx.globalAlpha = 1;
      }
      raf = requestAnimationFrame(frame);
      return;
    }
    const p = params(t);
    if (p.step !== lastStep) {
      lastStep = p.step;
      bands = bandsFor(p, R);
      bandBuf = new Float32Array(32);
      bands.forEach((b, i) => bandBuf.set([b.y0, b.y1, b.dx, b.kind], i * 4));
      // the picture jolts: a new shake offset per step (the hitch: one hard jump at 120 ms)
      const s = p.shake;
      jolt =
        t >= 110 && t < 160
          ? { x: 18, y: -4, skew: 0 }
          : { x: (R() - 0.5) * 2 * (3 + 26 * s), y: (R() - 0.5) * 2 * (1 + 9 * s), skew: R() < 0.12 * s ? (R() - 0.5) * 6 : 0 };
      // the DOM's channel split: a filter is re-rasterised whenever it changes, so it moves in
      // coarse jumps (every third step, 4 px levels) while the liquid's split moves every frame
      if (p.step % 3 === 0 || p.invert) {
        const d = Math.round((p.split * 0.45) / 4) * 4;
        splitCss = d >= 4 && t < K.crt ? `drop-shadow(${d}px 0 0 rgba(255,24,96,0.8)) drop-shadow(${-d}px 0 0 rgba(0,236,255,0.8))${p.invert ? ' invert(1)' : ''}` : p.invert ? 'invert(1)' : '';
      }
      if (gxOff('nofilter')) splitCss = '';
      if (o.live && o.live.style.filter !== splitCss) o.live.style.filter = splitCss;
      // meltdown: the DOM flickers away and the liquid's beads take the picture over
      if (o.live) {
        const m = seg(t, K.peak, K.blast);
        o.live.style.opacity = m > 0 ? String(Math.max(0.08, 1 - 0.9 * m) * (stepRand(p.step, 3) > 0.25 ? 1 : 0.35)) : '';
      }
      // the DOM tears along the first bands of the liquid's
      if (tears) {
        tears.bands.forEach((tb, i) => {
          const b = bands[i];
          const key = b ? `${b.y0}|${b.y1}|${b.dx}` : '';
          if (key === tb.last) return;
          tb.last = key;
          if (!b) {
            tb.el.style.visibility = 'hidden';
            return;
          }
          const y = b.y0 * H;
          tb.el.style.visibility = 'visible';
          tb.el.style.height = `${((b.y1 - b.y0) * H).toFixed(1)}px`;
          tb.el.style.transform = `translate3d(${(b.dx * W).toFixed(1)}px,${y.toFixed(1)}px,0)`;
          tb.inner.style.transform = `translate3d(0,${(-y).toFixed(1)}px,0)`;
        });
      }
    }
    // shake + CRT collapse on every layer of the picture (design px inside the surface, device px outside)
    const sk = scaleK();
    for (const el of pictures()) {
      const inside = el === o.live || el === tears?.root;
      const m = inside ? 1 : sk;
      el.style.transformOrigin = inside ? `${W / 2}px ${H / 2}px` : '50% 50%';
      el.style.transform = `translate3d(${(jolt.x * m).toFixed(1)}px,${(jolt.y * m).toFixed(1)}px,0) skewX(${jolt.skew.toFixed(2)}deg) scale(${p.sx.toFixed(4)},${p.sy.toFixed(4)})`;
    }
    gl?.draw(p, bandBuf);
    if (fxCtx && !gxOff('nofx')) drawFx(fxCtx, p, tiles, R, false);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(raf);
      for (const el of pictures()) {
        el.style.transform = '';
        el.style.transformOrigin = '';
      }
      if (o.live) {
        o.live.style.filter = '';
        o.live.style.opacity = '';
        o.live.style.transition = '';
      }
      gl?.destroy();
      gl = null;
      tears?.root.remove();
      tears = null;
      fxCtx?.clearRect(0, 0, o.fx.width, o.fx.height);
      freezeGsap(false);
      engine?.resume();
    },
  };
}

/** Takes the TV's black back off the letterbox (the layer calls it when the surprise is over). */
export function releaseDark(): void {
  document.documentElement.classList.remove('tv-sur-dark');
}
