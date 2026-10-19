// React glue for the liquid engine (always in the main bundle, ~2 KB). The engine itself is
// dynamically imported after first paint; until then (and on tier 0) every chrome element shows
// its CSS chrome, so the first paint is instant and never blank.

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { gsap } from 'gsap';
import type { LiquidEngine } from './engine';
import type { AnchorOptions, Blob, EngineStats, Profile, Shape, Tier } from './types';

export type { LiquidEngine } from './engine';

// ------------------------------------------------------------------ tier selection

const TIER_KEY = 'vlados.lq.tier';

/** Stored override from the Lab ('auto' when none). `?lq=0..3` in the URL wins for testing. */
export function savedTier(): Tier | 'auto' {
  try {
    const q = new URLSearchParams(location.search).get('lq') ?? new URLSearchParams(location.hash.split('?')[1] ?? '').get('lq');
    const v = q ?? localStorage.getItem(TIER_KEY);
    if (v === '0' || v === '1' || v === '2' || v === '3') return Number(v) as Tier;
  } catch {
    /* ignore */
  }
  return 'auto';
}

export function saveTier(t: Tier | 'auto'): void {
  try {
    if (t === 'auto') localStorage.removeItem(TIER_KEY);
    else localStorage.setItem(TIER_KEY, String(t));
  } catch {
    /* ignore */
  }
}

/** Device heuristic: TV → 3; phones → 2, low-memory / data-saver Android → 1. */
export function autoTier(profile: Profile): Exclude<Tier, 0> {
  if (profile === 'tv') return 3;
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  if (nav.connection?.saveData) return 1;
  if ((nav.deviceMemory ?? 8) <= 2) return 1;
  if (/Android/i.test(nav.userAgent) && (nav.hardwareConcurrency ?? 8) <= 4) return 1;
  return 2;
}

// ------------------------------------------------------------------ context

export interface LiquidCtx {
  engine: LiquidEngine | null;
  /** Rendering tier right now (0 until the engine is loaded, or when it fell back). */
  tier: Tier;
  profile: Profile;
  /** the engine finished loading (or definitively won't): safe to start entrance choreography */
  ready: boolean;
}

const Ctx = createContext<LiquidCtx>({ engine: null, tier: 0, profile: 'phone', ready: true });

export const useLiquid = (): LiquidCtx => useContext(Ctx);

// ------------------------------------------------------------------ stage

export interface LiquidStageProps {
  profile?: Profile;
  /** Map this many design units onto the canvas width (TV: 1280). Default: 1 unit = 1 CSS px. */
  designWidth?: number;
  /** Fill the parent instead of the viewport (Lab device frames). The parent must be sized. */
  contained?: boolean;
  /** Rounded mask for contained stages, design units. */
  corner?: number;
  /** Force a tier ('auto' = heuristic + governor). Default: stored Lab choice or 'auto'. */
  tier?: Tier | 'auto';
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  onStats?: (s: EngineStats) => void;
  /** Called once the engine is ready (or null when it could not start). */
  onEngine?: (e: LiquidEngine | null) => void;
}

function afterFirstPaint(fn: () => void): () => void {
  let raf = 0;
  let to = 0;
  let idle = 0;
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  raf = requestAnimationFrame(() => {
    to = window.setTimeout(() => {
      if (w.requestIdleCallback) idle = w.requestIdleCallback(fn, { timeout: 900 });
      else fn();
    }, 0);
  });
  return () => {
    cancelAnimationFrame(raf);
    clearTimeout(to);
    if (idle && w.cancelIdleCallback) w.cancelIdleCallback(idle);
  };
}

/**
 * One liquid canvas per screen. Everything rendered inside can anchor chrome blobs with
 * `useChromeBlob`. Keep wrappers inside the stage transparent: the canvas paints the ground.
 */
export function LiquidStage({
  profile = 'phone',
  designWidth,
  contained = false,
  corner,
  tier: forced,
  className,
  style,
  children,
  onStats,
  onEngine,
}: LiquidStageProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [engine, setEngine] = useState<LiquidEngine | null>(null);
  const [tier, setTier] = useState<Tier>(0);
  const [ready, setReady] = useState(false);
  const want = forced ?? savedTier();
  const cbs = useRef({ onStats, onEngine });
  cbs.current = { onStats, onEngine };

  useEffect(() => {
    if (want === 0) {
      setReady(true);
      cbs.current.onEngine?.(null);
      return;
    }
    let alive = true;
    let made: LiquidEngine | null = null;
    const cancel = afterFirstPaint(() => {
      import('./engine')
        .then(({ LiquidEngine: E }) => {
          const canvas = canvasRef.current;
          const stage = stageRef.current;
          if (!alive || !canvas || !stage) return;
          const auto = autoTier(profile);
          const start = want === 'auto' ? auto : want;
          const modeSource = stage.parentElement?.closest('[data-mode]') ?? document.documentElement;
          try {
            made = new E(canvas, {
              profile,
              designWidth,
              corner,
              tier: start,
              maxTier: want === 'auto' ? auto : Math.max(auto, start) as 1 | 2 | 3,
              modeSource,
              onTier: (t) => alive && setTier(t),
            });
          } catch {
            made = null;
          }
          if (made && want !== 'auto') made.setTier(want);
          setEngine(made);
          setTier(made ? made.tier : 0);
          setReady(true);
          cbs.current.onEngine?.(made);
        })
        .catch(() => {
          if (!alive) return;
          setReady(true);
          cbs.current.onEngine?.(null);
        });
    });
    return () => {
      alive = false;
      cancel();
      if (made) {
        made.destroy();
        cbs.current.onEngine?.(null);
      }
      setEngine(null);
      setTier(0);
      setReady(false);
    };
    // The engine is rebuilt only when the stage's identity-defining props change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, designWidth, corner, want === 0]);

  // Tier switches after start (Lab switcher) without rebuilding the engine.
  useEffect(() => {
    if (engine && want !== 0) engine.setTier(want);
  }, [engine, want]);

  useEffect(() => {
    if (!engine) return;
    return engine.onStats((s) => cbs.current.onStats?.(s));
  }, [engine]);

  const value = useMemo<LiquidCtx>(() => ({ engine: tier > 0 ? engine : null, tier, profile, ready }), [engine, tier, profile, ready]);

  return (
    <Ctx.Provider value={value}>
      <div
        ref={stageRef}
        className={`lq-stage${contained ? ' lq-contained' : ''}${className ? ` ${className}` : ''}`}
        data-tier={tier}
        data-profile={profile}
        style={style}
      >
        <canvas ref={canvasRef} className="lq-canvas" aria-hidden="true" />
        {children}
      </div>
    </Ctx.Provider>
  );
}

/**
 * Turns liquid anchoring off below this point: overlays (sheets, toasts, popovers) float over
 * other content, so a transparent element with a blob behind it would show that content
 * through. Primitives inside render their CSS chrome instead.
 */
export function LiquidOff({ children }: { children?: ReactNode }) {
  const ctx = useLiquid();
  const value = useMemo<LiquidCtx>(() => ({ ...ctx, engine: null }), [ctx]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// ------------------------------------------------------------------ hooks

export interface ChromeBlobOptions extends AnchorOptions {
  shape?: Shape;
  /** false detaches (the element shows its CSS chrome again) */
  enabled?: boolean;
  /** also mirror the live blob into this ref (components expose it as `blobRef`) */
  out?: RefObject<Blob | null>;
}

/**
 * Keep a liquid chrome blob glued to an element (measured every frame). Changes to film / tar /
 * glow are tweened. Returns a ref to the live blob (null on tier 0) for beats to animate.
 * The element should carry the `lq` class (+ `lq-circle` / `lq-box`) for its CSS fallback.
 */
export function useChromeBlob(ref: RefObject<Element | null>, opts: ChromeBlobOptions = {}): RefObject<Blob | null> {
  const { engine } = useLiquid();
  const blobRef = useRef<Blob | null>(null);
  const { shape = 'pill', enabled = true, film = 0.34, tar = 0, glow = 0, cr, pad, appear, prio, out } = opts;
  const latest = useRef({ film, tar, glow });
  const shown = useRef({ film, tar, glow });
  latest.current = { film, tar, glow };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!engine || !el || !enabled) return;
    const v = latest.current;
    const b = engine.anchor(el, { shape, film: v.film, tar: v.tar, glow: v.glow, cr, pad, appear, prio });
    shown.current = { ...v };
    blobRef.current = b;
    if (out) (out as { current: Blob | null }).current = b;
    return () => {
      blobRef.current = null;
      if (out && out.current === b) (out as { current: Blob | null }).current = null;
      engine.release(b);
    };
  }, [engine, enabled, shape, cr, pad, appear, prio, ref, out]);

  useEffect(() => {
    const b = blobRef.current;
    if (!b) return;
    const to: Record<string, number> = {};
    if (film !== shown.current.film) to.film = film;
    if (tar !== shown.current.tar) to.tar = tar;
    if (glow !== shown.current.glow) to.glow = glow;
    shown.current = { film, tar, glow };
    if (Object.keys(to).length) gsap.to(b, { ...to, duration: 0.6, ease: 'power2.out' });
  }, [film, tar, glow]);

  return blobRef;
}

/** Keep an element (absolutely positioned at 0,0 in the stage) centred on a blob. */
export function useFollow(ref: RefObject<HTMLElement | SVGElement | null>, blob: Blob | null, ox = 0, oy = 0): void {
  const { engine } = useLiquid();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!engine || !el || !blob) return;
    return engine.follow(el, blob, ox, oy);
  }, [engine, blob, ox, oy, ref]);
}
