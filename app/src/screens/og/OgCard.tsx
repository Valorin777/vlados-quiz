// `#/og` — the 1200 × 630 link-preview card for the group chat (Telegram / WhatsApp / VK).
// Not linked anywhere: tools/og-image.mjs opens it in headless Chromium, waits for
// `html[data-og-ready]` and screenshots it into app/public/og-image.png. Real design system:
// chrome letters, a liquid mercury cluster (WebGL, CSS chrome on tier 0), engraved date pill.
// `?mode=light` renders the light version (dark by default).

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ChromeText, LiquidStage, setAppearanceOverride, useChromeBlob, useLiquid } from '../../visual';
import './og.css';

export const OG_W = 1200;
export const OG_H = 630;

interface Drop {
  x: number;
  y: number;
  r: number;
  film?: number;
}

// the mercury cluster on the right: a mother drop with satellites fused on by metaball necks
const DROPS: Drop[] = [
  { x: 1040, y: 258, r: 148, film: 0.28 },
  { x: 1142, y: 438, r: 58, film: 0.8 },
  { x: 1178, y: 536, r: 22 },
  { x: 918, y: 506, r: 30, film: 0.6 },
  { x: 862, y: 560, r: 12 },
  { x: 1160, y: 88, r: 26, film: 0.9 },
  { x: 896, y: 84, r: 11 },
];

function DropEl({ d }: { d: Drop }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useChromeBlob(ref, { shape: 'circle', film: d.film ?? 0.34, appear: 'instant', prio: 1 });
  const style: CSSProperties = { left: d.x - d.r, top: d.y - d.r, width: d.r * 2, height: d.r * 2 };
  return <span ref={ref} className="og-drop lq lq-circle" style={style} aria-hidden="true" />;
}

function DatePill() {
  const ref = useRef<HTMLDivElement | null>(null);
  useChromeBlob(ref, { shape: 'pill', film: 0.3, appear: 'instant', prio: 0 });
  return (
    <div ref={ref} className="og-pill lq">
      <span className="vx-eng">26.09</span>
      <i aria-hidden="true" />
      <span className="vx-eng">21:00</span>
    </div>
  );
}

/** Marks the page ready for the screenshot once fonts are in and the engine had time to settle. */
function Ready() {
  const { ready, tier } = useLiquid();
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    void document.fonts.ready.then(() => {
      setTimeout(() => {
        if (!alive) return;
        document.documentElement.dataset.ogReady = String(tier);
      }, 1200);
    });
    return () => {
      alive = false;
    };
  }, [ready, tier]);
  return null;
}

function useFit(): number {
  const calc = () => Math.min(1, innerWidth / OG_W, innerHeight / OG_H);
  const [s, setS] = useState(calc);
  useEffect(() => {
    const on = () => setS(calc());
    addEventListener('resize', on);
    return () => removeEventListener('resize', on);
  }, []);
  return s;
}

export function OgCard() {
  const q = new URLSearchParams(location.search);
  const mode = q.get('mode') === 'light' ? 'light' : 'dark';
  const s = useFit();
  useEffect(() => {
    setAppearanceOverride(mode);
    document.title = 'Кто лучше знает Владоса · 26.09 · 21:00';
    return () => setAppearanceOverride(null);
  }, [mode]);

  return (
    <div className="og-viewport vx">
      <LiquidStage contained profile="tv" designWidth={OG_W} tier={3} className="og-stage" style={{ width: OG_W * s, height: OG_H * s }}>
        <div className="og-surface" style={{ transform: `scale(${s})` }}>
          {DROPS.map((d, i) => (
            <DropEl key={i} d={d} />
          ))}
          <div className="og-copy">
            <p className="og-kick">кто лучше знает</p>
            <ChromeText as="h1" className="og-hero" sweep={false}>
              ВЛАДОСА
            </ChromeText>
            <div className="og-row">
              <DatePill />
              <p className="og-note">
                суббота · большая игра
                <br />
                в честь дня рождения
              </p>
            </div>
          </div>
          <p className="og-foot">
            вопросы — <b>на большом экране</b> · ответы — с телефона
          </p>
          <Ready />
        </div>
      </LiquidStage>
    </div>
  );
}
