import { gsap } from 'gsap';
import { useLayoutEffect, useRef } from 'react';
import { APPEARANCE_OPTIONS, setAppearance, useAppearance, type AppearancePref } from '../appearance';
import { audio } from '../audio';
import { useChromeBlob } from '../liquid';
import { reducedMotion } from '../motion';
import { cx } from './util';

export interface ModeToggleProps {
  /** controlled value; default: this device's stored choice */
  value?: AppearancePref;
  /** controlled change; default: persist + apply (localStorage vlados.appearance, <html data-mode>) */
  onChange?: (v: AppearancePref) => void;
  size?: 's' | 'm';
  label?: string;
  /** false: icons only (the names stay for screen readers) */
  labels?: boolean;
  className?: string;
}

const ICONS: Record<AppearancePref, string> = {
  light: 'M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Z',
  dark: 'M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5Z',
  system: 'M12 4a8 8 0 1 1 0 16V4Z M12 4a8 8 0 1 0 0 16',
};

/**
 * Светлая / Тёмная / Авто. A liquid mercury thumb flows between segments (stretching across,
 * then pulling in); switching wipes the new mode in from the tap point.
 */
export function ModeToggle({ value, onChange, size = 'm', label = 'Тема', labels = true, className }: ModeToggleProps) {
  const store = useAppearance();
  const cur = value ?? store.pref;
  const track = useRef<HTMLDivElement | null>(null);
  const thumb = useRef<HTMLSpanElement | null>(null);
  const btns = useRef<(HTMLButtonElement | null)[]>([]);
  const blob = useChromeBlob(thumb, { shape: 'pill', film: 0.55 });
  const first = useRef(true);
  const idx = APPEARANCE_OPTIONS.findIndex((o) => o.value === cur);

  useLayoutEffect(() => {
    const t = thumb.current;
    const b = btns.current[idx];
    const tr = track.current;
    if (!t || !b || !tr) return;
    const x = b.offsetLeft;
    const w = b.offsetWidth;
    if (first.current || reducedMotion()) {
      first.current = false;
      gsap.set(t, { x, width: w });
      return;
    }
    const fromX = Number(gsap.getProperty(t, 'x')) || 0;
    const fromW = Number(gsap.getProperty(t, 'width')) || w;
    const left = Math.min(fromX, x);
    const right = Math.max(fromX + fromW, x + w);
    // stretch across both segments, then pull in to the target: surface tension
    gsap
      .timeline()
      .to(t, { x: left, width: right - left, duration: 0.18, ease: 'power2.in' })
      .to(t, { x, width: w, duration: 0.7, ease: 'elastic.out(1,0.6)' });
    if (blob.current) gsap.fromTo(blob.current, { glow: 0.35 }, { glow: 0, duration: 0.8 });
    // the thumb's width/x are layout for the next measure only; track resize handled by CSS
  }, [idx, blob]);

  useLayoutEffect(() => {
    const onResize = () => {
      const t = thumb.current;
      const b = btns.current[idx];
      if (t && b) gsap.set(t, { x: b.offsetLeft, width: b.offsetWidth });
    };
    addEventListener('resize', onResize);
    return () => removeEventListener('resize', onResize);
  }, [idx]);

  const pick = (v: AppearancePref, el: HTMLButtonElement | null) => {
    if (v === cur) return;
    audio.drop(v === 'dark' ? 0.7 : 1.2, 0.3);
    if (onChange) onChange(v);
    else {
      const r = el?.getBoundingClientRect();
      setAppearance(v, r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : undefined);
    }
  };

  return (
    <div ref={track} className={cx('vx-mode', `vx-mode-${size}`, !labels && 'vx-mode-icons', className)} role="radiogroup" aria-label={label}>
      <span ref={thumb} className="vx-mode-thumb lq" aria-hidden="true" />
      {APPEARANCE_OPTIONS.map((o, i) => (
        <button
          key={o.value}
          ref={(n) => {
            btns.current[i] = n;
          }}
          type="button"
          role="radio"
          aria-checked={o.value === cur}
          className={cx('vx-mode-opt', o.value === cur && 'is-on')}
          onClick={(e) => pick(o.value, e.currentTarget)}
          onKeyDown={(e) => {
            const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
            if (!d) return;
            e.preventDefault();
            const n = (i + d + APPEARANCE_OPTIONS.length) % APPEARANCE_OPTIONS.length;
            const opt = APPEARANCE_OPTIONS[n];
            const el = btns.current[n];
            if (opt) {
              pick(opt.value, el ?? null);
              el?.focus();
            }
          }}
          tabIndex={o.value === cur ? 0 : -1}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d={ICONS[o.value]} />
          </svg>
          <span className={labels ? undefined : 'vx-sr'}>{o.label}</span>
        </button>
      ))}
    </div>
  );
}
