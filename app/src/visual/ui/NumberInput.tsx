import { gsap } from 'gsap';
import { useId, useRef, type CSSProperties, type PointerEvent as RPointerEvent } from 'react';
import { audio } from '../audio';
import { pulse, shake } from '../beats';
import { useChromeBlob, useLiquid } from '../liquid';
import { reducedMotion } from '../motion';
import { ChromeButton } from './ChromeButton';
import { cx, fmtInt } from './util';

export interface NumberInputProps {
  value: number | null;
  onChange: (v: number | null) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  /** "Ответить" — omit to hide the submit button */
  onSubmit?: (v: number) => void;
  submitLabel?: string;
  disabled?: boolean;
  label?: string;
  className?: string;
}

/** Years and small numbers stay ungrouped ("2015"); big ones get thin spaces ("12 500"). */
const fmt = (n: number): string => (Math.abs(n) >= 10000 ? fmtInt(n) : String(n)).replace('-', '−');

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '±', '0', '⌫'] as const;

const clampStep = (v: number, min: number, max: number, step: number): number => {
  const s = Math.round((v - min) / step) * step + min;
  return Math.min(max, Math.max(min, Number(s.toFixed(6))));
};

/**
 * Number guess: a chrome read-out, a big glass keypad (typing digits) and a mercury slider
 * (dragging) — both edit the same value. Submit clamps to [min, max].
 */
export function NumberInput({ value, onChange, min, max, step = 1, unit, onSubmit, submitLabel = 'Ответить', disabled = false, label = 'Твой ответ', className }: NumberInputProps) {
  const id = useId();
  const plate = useRef<HTMLDivElement | null>(null);
  const readout = useRef<HTMLOutputElement | null>(null);
  const plateBlob = useChromeBlob(plate, { shape: 'box', film: 0.28, cr: 22 });
  const { engine } = useLiquid();
  const digits = value === null ? '' : String(value);
  const out = value !== null && (value < min || value > max);
  const neg = min < 0;
  const span = max - min || 1;
  const p = value === null ? 0.5 : Math.min(1, Math.max(0, (value - min) / span));

  const bump = () => {
    if (readout.current && !reducedMotion()) gsap.fromTo(readout.current, { scale: 1.06 }, { scale: 1, duration: 0.5, ease: 'elastic.out(1,0.5)' });
    pulse(plateBlob.current, 0.22, 0.4);
  };

  const press = (k: (typeof KEYS)[number], pt?: { x: number; y: number }) => {
    if (disabled) return;
    let s = digits;
    if (k === '⌫') s = s.slice(0, -1);
    else if (k === '±') {
      if (!neg) return;
      s = s.startsWith('-') ? s.slice(1) : `-${s || ''}`;
    } else {
      if (s.replace('-', '').length >= Math.max(String(Math.abs(max)).length, String(Math.abs(min)).length) + 1) {
        shake(readout.current);
        return;
      }
      s = s === '0' ? k : s === '-0' ? `-${k}` : s + k;
    }
    const n = s === '' || s === '-' ? null : Number(s);
    onChange(n === null || Number.isNaN(n) ? null : n);
    audio.drop(1.2 + (k === '⌫' ? -0.4 : Number(k) * 0.04 || 0), 0.18);
    if (engine && pt) {
      const q = engine.toLocal(pt.x, pt.y);
      engine.ripple(q.x, q.y, 0.35);
    }
    bump();
  };

  const submit = () => {
    if (value === null || !onSubmit) {
      shake(readout.current);
      return;
    }
    const v = clampStep(value, min, max, step);
    if (v !== value) onChange(v);
    onSubmit(v);
  };

  return (
    <div className={cx('vx-numin', disabled && 'is-disabled', className)}>
      <div ref={plate} className="vx-numin-plate lq">
        <span className="vx-numin-label vx-eng" id={`${id}-l`}>
          {label}
        </span>
        <output ref={readout} className={cx('vx-numin-value vx-eng', out && 'is-out')} aria-labelledby={`${id}-l`} aria-live="polite">
          {value === null ? <span className="vx-numin-empty">—</span> : fmt(value)}
          {unit ? <small>{unit}</small> : null}
        </output>
        <span className="vx-numin-range vx-eng vx-mono">
          {fmt(min)} – {fmt(max)}
        </span>
      </div>

      <input
        className="vx-slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value ?? Math.round((min + max) / 2 / step) * step}
        disabled={disabled}
        aria-label={`${label}: ползунок`}
        style={{ '--p': p } as CSSProperties}
        onChange={(e) => {
          const v = Number(e.currentTarget.value);
          if (v !== value) {
            onChange(v);
            audio.tick(0.08);
          }
        }}
        onPointerUp={bump}
      />

      <div className="vx-keypad" role="group" aria-label="Цифры">
        {KEYS.map((k) => (
          <button
            key={k}
            type="button"
            className={cx('vx-key', (k === '±' || k === '⌫') && 'is-fn')}
            disabled={disabled || (k === '±' && !neg)}
            aria-label={k === '⌫' ? 'Стереть' : k === '±' ? 'Сменить знак' : k}
            onPointerDown={(e: RPointerEvent<HTMLButtonElement>) => press(k, { x: e.clientX, y: e.clientY })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                press(k);
              }
            }}
          >
            {k === '⌫' ? (
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 5h11a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9l-6-7z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                <path d="m12 9 6 6m0-6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            ) : (
              k
            )}
          </button>
        ))}
      </div>
      {onSubmit ? (
        <ChromeButton block onClick={submit} disabled={disabled || value === null}>
          {submitLabel}
        </ChromeButton>
      ) : null}
    </div>
  );
}
