import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { LiquidStage, useLiquid, type LiquidEngine, type Tier } from '../../../visual';

/** Run `fn` once the frame's engine is settled and again on every replay; cleans up on change. */
export function useReplay(run: number, fn: (engine: LiquidEngine | null) => gsap.core.Animation | (() => void) | void, extra: unknown[] = []): void {
  const { engine, ready } = useLiquid();
  useEffect(() => {
    if (!ready) return;
    const r = fn(engine);
    return () => {
      if (typeof r === 'function') r();
      else r?.kill();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, ready, engine, ...extra]);
}

const SIZE = { phone: { w: 390, h: 844, corner: 54 }, tv: { w: 1280, h: 720, corner: 18 } } as const;

export interface DeviceFrameProps {
  kind: 'phone' | 'tv';
  scale: number;
  /** force a colour mode inside this frame (both-modes view); default follows the page */
  mode?: 'light' | 'dark';
  tier: Tier | 'auto';
  caption?: ReactNode;
  /** a control next to the caption (full screen) */
  action?: ReactNode;
  children?: ReactNode;
}

/** A device bezel with its own liquid canvas at the device's design resolution. */
export function DeviceFrame({ kind, scale, mode, tier, caption, action, children }: DeviceFrameProps) {
  const { w: W, h: H, corner } = SIZE[kind];
  return (
    <figure className={`lab-dev lab-dev-${kind}`}>
      <div className="lab-dev-box" style={{ width: W * scale, height: H * scale, '--s': scale } as CSSProperties}>
        <div className="lab-dev-screen" data-mode={mode} style={{ width: W, height: H, transform: `scale(${scale})` }}>
          <LiquidStage contained profile={kind} designWidth={W} corner={corner} tier={tier} className="lab-dev-stage">
            {children}
          </LiquidStage>
          {kind === 'phone' ? <i className="lab-island" aria-hidden="true" /> : null}
        </div>
      </div>
      {caption || action ? (
        <figcaption className="lab-dev-cap">
          <span className="vx-kick">{caption}</span>
          {action}
        </figcaption>
      ) : null}
    </figure>
  );
}

function useViewport(): { w: number; h: number } {
  const [v, setV] = useState(() => ({ w: innerWidth, h: innerHeight }));
  useEffect(() => {
    const on = () => setV({ w: innerWidth, h: innerHeight });
    addEventListener('resize', on);
    return () => removeEventListener('resize', on);
  }, []);
  return v;
}

export interface SoloFrameProps {
  kind: 'phone' | 'tv';
  tier: Tier | 'auto';
  label: string;
  onClose: () => void;
  onReplay: () => void;
  onNext: () => void;
  children?: ReactNode;
}

/**
 * One device full screen, as a guest / the room would see it. On a phone-sized viewport the phone
 * scene fills the screen edge to edge (its own liquid stage, one canvas — like the real app); on
 * larger screens it sits in a bezel scaled to fit. The TV is letterboxed at 16:9.
 */
export function SoloFrame({ kind, tier, label, onClose, onReplay, onNext, children }: SoloFrameProps) {
  const { w, h } = useViewport();
  const close = useRef<HTMLButtonElement | null>(null);
  const back = useRef<Element | null>(null);
  const bare = kind === 'phone' && w <= 540;
  const { w: W, h: H, corner } = SIZE[kind];
  const bar = 64;
  const scale = kind === 'phone' ? Math.min(1, (h - bar - 40) / H, (w - 32) / W) : Math.min((w - 24) / W, (h - bar - 24) / H);

  useEffect(() => {
    back.current = document.activeElement;
    close.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    addEventListener('keydown', onKey);
    return () => {
      removeEventListener('keydown', onKey);
      (back.current as HTMLElement | null)?.focus?.({ preventScroll: true });
    };
  }, [onClose]);

  return (
    <div className={`lab-solo lab-solo-${kind}${bare ? ' is-bare' : ''}`} role="dialog" aria-modal="true" aria-label={label}>
      <div className="lab-solo-stage">
        {bare ? (
          <LiquidStage contained profile="phone" tier={tier} className="lab-solo-fill">
            {children}
          </LiquidStage>
        ) : (
          <div className={`lab-dev lab-dev-${kind}`}>
            <div className="lab-dev-box" style={{ width: W * scale, height: H * scale, '--s': scale } as CSSProperties}>
              <div className="lab-dev-screen" style={{ width: W, height: H, transform: `scale(${scale})` }}>
                <LiquidStage contained profile={kind} designWidth={W} corner={corner} tier={tier} className="lab-dev-stage">
                  {children}
                </LiquidStage>
                {kind === 'phone' ? <i className="lab-island" aria-hidden="true" /> : null}
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="lab-solo-bar">
        <span className="vx-kick lab-solo-l">{label}</span>
        <button type="button" className="lab-solo-b" onClick={onReplay}>
          ↻ <span>повторить</span>
        </button>
        <button type="button" className="lab-solo-b" onClick={onNext}>
          <span>дальше</span> →
        </button>
        <button ref={close} type="button" className="lab-solo-b is-x" onClick={onClose} aria-label="Закрыть полноэкранный показ">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
