// The 16:9 stage: a 1280 × 720 design surface letterboxed into any window and scaled to fit
// (1920 × 1080 on the party TV = ×1.5). One liquid canvas exactly under the surface, so scene
// blobs, anchored chrome and beats all share the same design units.

import { useEffect, useState, type ReactNode } from 'react';
import { LiquidStage } from '../../visual';

export const W = 1280;
export const H = 720;

function useFit(): number {
  const calc = () => Math.max(0.1, Math.min(innerWidth / W, innerHeight / H));
  const [s, setS] = useState(calc);
  useEffect(() => {
    const on = () => setS(calc());
    addEventListener('resize', on);
    // Safari fullscreen changes the viewport after the event on some versions
    document.addEventListener('fullscreenchange', on);
    document.addEventListener('webkitfullscreenchange', on);
    return () => {
      removeEventListener('resize', on);
      document.removeEventListener('fullscreenchange', on);
      document.removeEventListener('webkitfullscreenchange', on);
    };
  }, []);
  return s;
}

export function TvStage({ children, overlay }: { children: ReactNode; overlay?: ReactNode }) {
  const s = useFit();
  return (
    <div className="tv-viewport vx">
      <LiquidStage contained profile="tv" designWidth={W} className="tv-stage" style={{ width: W * s, height: H * s }}>
        <div className="tv-surface" style={{ transform: `scale(${s})` }}>
          {children}
        </div>
      </LiquidStage>
      {overlay}
    </div>
  );
}

/** Element box in design units relative to the surface (works under the CSS scale). */
export function designRect(el: Element | null | undefined): { x: number; y: number; w: number; h: number; cx: number; cy: number } | null {
  if (!el) return null;
  const surface = el.closest('.tv-surface');
  if (!surface) return null;
  const sr = surface.getBoundingClientRect();
  const k = sr.width / W || 1;
  const r = el.getBoundingClientRect();
  const x = (r.left - sr.left) / k;
  const y = (r.top - sr.top) / k;
  const w = r.width / k;
  const h = r.height / k;
  return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
}
