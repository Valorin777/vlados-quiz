// Types shared by the lazy liquid engine chunk and the always-loaded React glue.

/**
 * 0 static CSS chrome · 1 low (30 fps, 12 blobs; DPR .6 on phones) · 2 phone (24 blobs) · 3 TV (72 blobs).
 * Tiers 2–3, and every tier on a laptop/desktop, render at the device pixel ratio (≤ 2): quality.ts.
 */
export type Tier = 0 | 1 | 2 | 3;
export type Profile = 'phone' | 'tv';
export type Shape = 'circle' | 'pill' | 'box';
export type ColorMode = 'light' | 'dark';

/**
 * One metaball primitive. All lengths are design units (CSS px on phones; TV scenes can use a
 * fixed 1280-wide design space via `designWidth`). Every numeric field is safe to tween with GSAP.
 *   circle/pill: capsule from (x+ax, y+ay) to (x+bx, y+by) with radius r
 *   box:         rounded rect centred on (x, y), half-size hw × hh, corner radius cr
 */
export interface Blob {
  x: number;
  y: number;
  r: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** 1 → rounded box */
  box: number;
  hw: number;
  hh: number;
  cr: number;
  /** tarnish/oxide 0..1 (wrong answers, not-yet-answered players) */
  tar: number;
  /** white-hot glow 0..1 (pulses, correct answers) */
  glow: number;
  /** thin-film iridescence 0..1 */
  film: number;
  /** overall scale; 0 hides the blob (appear/disappear by tweening this) */
  sc: number;
  /** extra offset on top of x/y (drips, bumps) */
  dx: number;
  dy: number;
  /** 0 disables drawing without removing */
  on: number;
  /** draw priority when over the tier's blob cap: lower wins (0 UI anchors, 1 scene, 2 droplets) */
  prio: number;
}

export interface AnchorOptions {
  shape?: Shape;
  film?: number;
  tar?: number;
  glow?: number;
  /** corner radius for boxes (design units); defaults to the element's own border-radius */
  cr?: number;
  /** grow (+) or shrink (−) the blob relative to the element box, design units */
  pad?: number;
  /** 'pour' grows the blob in with a liquid overshoot; 'instant' shows it at full size */
  appear?: 'pour' | 'instant' | 'auto';
  prio?: number;
}

export interface EngineStats {
  tier: Tier;
  fps: number;
  /** mean frame interval over the last budget window (all stages on the page) */
  frameMs: number;
  /** GPU ms per frame of this stage (null: no timer query on this browser) */
  gpuMs: number | null;
  blobs: number;
  /** canvas pixels per on-screen CSS pixel */
  dpr: number;
  /** quality step within the tier (0 = full effects and resolution) */
  level: number;
  /** WebGL version (2 renders with per-tile blob lists) */
  gl: 1 | 2;
  mode: ColorMode;
  lost: boolean;
}

export interface EngineOptions {
  profile: Profile;
  /** Map a fixed design width (e.g. 1280) onto the canvas; default: 1 unit = 1 CSS px. */
  designWidth?: number;
  /** Rounded frame mask (design units), for contained stages like the Lab's device frames. */
  corner?: number;
  /** Start tier. The FPS governor never climbs above `maxTier`. */
  tier: Exclude<Tier, 0>;
  maxTier: Exclude<Tier, 0>;
  /** Element whose `data-mode` the engine follows (defaults to <html>). */
  modeSource?: Element;
  /** Tier changes (including drops to 0 on context loss / a hopeless device). */
  onTier?: (t: Tier) => void;
}

/** Global knobs that animate the whole liquid surface. Tween them with GSAP. */
export interface SceneProps {
  /** hurry: warm pulse on the ground, film heats up */
  heat: number;
  /** agitation: the surface boils (timer running out, suspense) */
  agit: number;
  /** full-screen additive flash, decays by itself */
  flash: number;
  /** metaball merge distance */
  k: number;
  /** bevel width of the chrome rim */
  bevel: number;
}
