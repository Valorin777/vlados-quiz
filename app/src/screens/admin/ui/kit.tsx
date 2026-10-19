// Dense, calm building blocks of the organizer's panel, in the liquid-chrome language: glass cards,
// sunken fields, chrome chips/knobs (CSS chrome: the panel keeps the liquid for its hero actions).

import { gsap } from 'gsap';
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { LiquidOff, audio, cx, reducedMotion } from '../../../visual';
import { fmtNum, parseNum } from '../core/format';
import { Icon, type IconName } from './icons';

// ---------------------------------------------------------------- layout

export function Card({
  title,
  kicker,
  icon,
  actions,
  children,
  className,
  id,
  tone,
  style,
}: {
  title?: ReactNode;
  kicker?: ReactNode;
  icon?: IconName;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  id?: string;
  tone?: 'danger' | 'accent' | 'quiet';
  style?: CSSProperties;
}) {
  return (
    <section id={id} className={cx('ad-card', tone && `is-${tone}`, className)} style={style}>
      {title || kicker || actions ? (
        <header className="ad-card-head">
          {icon ? (
            <span className="ad-card-ico">
              <Icon name={icon} size={18} />
            </span>
          ) : null}
          <div className="ad-card-titles">
            {kicker ? <p className="vx-kick">{kicker}</p> : null}
            {title ? <h3 className="ad-card-title">{title}</h3> : null}
          </div>
          {actions ? <div className="ad-card-actions">{actions}</div> : null}
        </header>
      ) : null}
      {/* glass hides the canvas: primitives inside a card draw their CSS chrome */}
      <LiquidOff>{children}</LiquidOff>
    </section>
  );
}

export function PageHead({
  kicker,
  title,
  sub,
  actions,
  compact = false,
}: {
  kicker?: ReactNode;
  title: string;
  sub?: ReactNode;
  actions?: ReactNode;
  /** phones: hide the title (the dock already says where you are) */
  compact?: boolean;
}) {
  return (
    <header className={cx('ad-page-head', compact && 'is-compact')}>
      <div className="ad-page-titles">
        {kicker ? <p className="vx-kick">{kicker}</p> : null}
        <h1 className="ad-page-title vx-chr">{title}</h1>
        {sub ? <p className="ad-page-sub">{sub}</p> : null}
      </div>
      {actions ? <div className="ad-page-actions">{actions}</div> : null}
    </header>
  );
}

/** Id of the control a Field's label points at (inputs below pick it up). */
const FieldId = createContext<string | undefined>(undefined);

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
  aside,
  className,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
  aside?: ReactNode;
  className?: string;
}) {
  const auto = useId();
  const id = htmlFor ?? auto;
  return (
    <div className={cx('ad-field', error ? 'has-error' : null, className)}>
      {label || aside ? (
        <div className="ad-field-top">
          {label ? (
            <label className="ad-label" htmlFor={id}>
              {label}
            </label>
          ) : (
            <span />
          )}
          {aside}
        </div>
      ) : null}
      <FieldId.Provider value={id}>{children}</FieldId.Provider>
      {error ? <p className="ad-hint is-error">{error}</p> : hint ? <p className="ad-hint">{hint}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------- inputs

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: string;
  onChange: (v: string) => void;
  icon?: IconName;
  suffix?: ReactNode;
};

export function TextInput({ value, onChange, icon, suffix, className, id, ...rest }: InputProps) {
  const fid = useContext(FieldId);
  return (
    <div className={cx('ad-input', icon && 'has-icon', className)}>
      {icon ? <Icon name={icon} size={17} className="ad-input-ico" /> : null}
      <input id={id ?? fid} value={value} onChange={(e) => onChange(e.currentTarget.value)} {...rest} />
      {suffix ? <span className="ad-input-suffix">{suffix}</span> : null}
    </div>
  );
}

export function TextArea({
  value,
  onChange,
  minRows = 2,
  className,
  id,
  ...rest
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & { value: string; onChange: (v: string) => void; minRows?: number }) {
  const fid = useContext(FieldId);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);
  return (
    <div className={cx('ad-input ad-textarea', className)}>
      <textarea ref={ref} id={id ?? fid} rows={minRows} value={value} onChange={(e) => onChange(e.currentTarget.value)} {...rest} />
    </div>
  );
}

/**
 * Number field that accepts "1,5" and keeps what is typed while it is incomplete. `onChange`
 * gets a finite number, or undefined for an empty field (when `optional`).
 */
export function NumInput({
  value,
  onChange,
  optional = false,
  suffix,
  min,
  max,
  placeholder,
  id,
  className,
  integer = false,
  ariaLabel,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  optional?: boolean;
  suffix?: ReactNode;
  min?: number;
  max?: number;
  placeholder?: string;
  id?: string;
  className?: string;
  integer?: boolean;
  ariaLabel?: string;
}) {
  const fid = useContext(FieldId);
  const [raw, setRaw] = useState(fmtNum(value));
  const [bad, setBad] = useState(false);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setRaw(fmtNum(value));
  }, [value]);
  const commit = (s: string) => {
    const n = parseNum(s);
    if (n === undefined) {
      setBad(!optional);
      if (optional) onChange(undefined);
      return;
    }
    if (Number.isNaN(n) || (integer && !Number.isInteger(n)) || (min !== undefined && n < min) || (max !== undefined && n > max)) {
      setBad(true);
      return;
    }
    setBad(false);
    onChange(n);
  };
  return (
    <div className={cx('ad-input ad-num', bad && 'is-bad', className)}>
      <input
        id={id ?? fid}
        inputMode="decimal"
        value={raw}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-invalid={bad || undefined}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          if (!bad) setRaw(fmtNum(value));
        }}
        onChange={(e) => {
          setRaw(e.currentTarget.value);
          commit(e.currentTarget.value);
        }}
      />
      {suffix ? <span className="ad-input-suffix">{suffix}</span> : null}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cx('ad-toggle-row', disabled && 'is-disabled', className)}>
      {label ? (
        <label className="ad-toggle-text" htmlFor={id}>
          <span className="ad-toggle-label">{label}</span>
          {hint ? <span className="ad-hint">{hint}</span> : null}
        </label>
      ) : null}
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        className={cx('ad-toggle', checked && 'is-on')}
        onClick={() => {
          audio.drop(checked ? 0.8 : 1.3, 0.18);
          onChange(!checked);
        }}
      >
        <i className="ad-toggle-knob" />
      </button>
    </div>
  );
}

export interface ChipOption<T extends string | number> {
  value: T;
  label: ReactNode;
  title?: string;
  icon?: IconName;
}

/** Single choice as a row of pills; the picked one turns chrome. */
export function Chips<T extends string | number>({
  options,
  value,
  onChange,
  label,
  className,
  size = 'm',
}: {
  options: readonly ChipOption<T>[];
  value: T | null;
  onChange: (v: T) => void;
  label?: string;
  className?: string;
  size?: 's' | 'm';
}) {
  return (
    <div className={cx('ad-chips', size === 's' && 'is-s', className)} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          className={cx('ad-chip', o.value === value && 'is-on')}
          onClick={() => {
            if (o.value !== value) audio.drop(1.2, 0.14);
            onChange(o.value);
          }}
        >
          {o.icon ? <Icon name={o.icon} size={16} /> : null}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- buttons

export function Btn({
  children,
  icon,
  tone = 'plain',
  size = 'm',
  className,
  type = 'button',
  busy,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: IconName;
  tone?: 'plain' | 'chrome' | 'accent' | 'danger' | 'ghost';
  size?: 's' | 'm' | 'l';
  busy?: boolean;
}) {
  return (
    <button type={type} className={cx('ad-btn', `is-${tone}`, `is-${size}`, tone === 'chrome' && 'lq', busy && 'is-busy', className)} aria-busy={busy || undefined} {...rest}>
      {icon ? <Icon name={icon} size={size === 's' ? 15 : 18} /> : null}
      {children ? <span className={tone === 'chrome' ? 'vx-eng' : undefined}>{children}</span> : null}
    </button>
  );
}

export function IconBtn({
  icon,
  label,
  tone = 'plain',
  className,
  size = 'm',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; tone?: 'plain' | 'danger' | 'accent'; size?: 's' | 'm' }) {
  return (
    <button type="button" className={cx('ad-ibtn', `is-${tone}`, `is-${size}`, className)} aria-label={label} title={label} {...rest}>
      <Icon name={icon} size={size === 's' ? 16 : 19} />
    </button>
  );
}

/**
 * Press and hold to confirm (dangerous actions): a chrome fill sweeps across while held; letting
 * go early cancels. Keyboard: hold Enter / Space.
 */
export function HoldButton({
  children,
  onConfirm,
  holdMs = 1400,
  icon,
  tone = 'danger',
  disabled,
  className,
  size = 'm',
}: {
  children: ReactNode;
  onConfirm: () => void;
  holdMs?: number;
  icon?: IconName;
  tone?: 'danger' | 'plain' | 'accent';
  disabled?: boolean;
  className?: string;
  size?: 's' | 'm' | 'l';
}) {
  const fill = useRef<HTMLSpanElement | null>(null);
  const tween = useRef<gsap.core.Tween | null>(null);
  // The confirm runs on a timer, not on the animation: it fires even when frames are throttled.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [holding, setHolding] = useState(false);
  const start = () => {
    if (disabled || timer.current) return;
    setHolding(true);
    audio.drop(0.7, 0.12);
    tween.current = gsap.fromTo(fill.current, { scaleX: 0 }, { scaleX: 1, duration: holdMs / 1000, ease: 'none' });
    timer.current = setTimeout(() => {
      timer.current = null;
      tween.current?.kill();
      tween.current = null;
      setHolding(false);
      audio.drop(1.6, 0.3);
      gsap.fromTo(fill.current, { scaleX: 1 }, { scaleX: 0, duration: 0.5, delay: 0.2, ease: 'power2.out' });
      onConfirm();
    }, holdMs);
  };
  const cancel = () => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    tween.current?.kill();
    tween.current = null;
    setHolding(false);
    gsap.to(fill.current, { scaleX: 0, duration: reducedMotion() ? 0.1 : 0.35, ease: 'power2.out' });
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      tween.current?.kill();
    },
    [],
  );
  return (
    <button
      type="button"
      disabled={disabled}
      className={cx('ad-btn ad-hold', `is-${tone}`, `is-${size}`, holding && 'is-holding', className)}
      onPointerDown={(e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        start();
      }}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
          e.preventDefault();
          start();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === 'Enter' || e.key === ' ') cancel();
      }}
    >
      <span ref={fill} className="ad-hold-fill" aria-hidden="true" />
      {icon ? <Icon name={icon} size={size === 's' ? 15 : 18} /> : null}
      <span>{children}</span>
      <span className="ad-hold-tip">{holding ? 'держи…' : 'удерживай'}</span>
    </button>
  );
}

// ---------------------------------------------------------------- status

export function Meter({ value, tone = 'film', label }: { value: number; tone?: 'film' | 'hot' | 'chrome'; label?: string }) {
  return (
    <div className={cx('ad-meter', `is-${tone}`)} role="meter" aria-valuemin={0} aria-valuemax={1} aria-valuenow={value} aria-label={label}>
      <i style={{ transform: `scaleX(${Math.max(0, Math.min(1, value))})` }} />
    </div>
  );
}

export function Dot({ tone }: { tone: 'good' | 'warn' | 'bad' | 'idle' }) {
  return <i className={cx('ad-dot', `is-${tone}`)} aria-hidden="true" />;
}

export function Empty({ icon, title, text, children }: { icon: IconName; title: ReactNode; text?: ReactNode; children?: ReactNode }) {
  return (
    <div className="ad-empty">
      <span className="ad-empty-ico lq lq-circle">
        <Icon name={icon} size={26} />
      </span>
      <p className="ad-empty-title">{title}</p>
      {text ? <p className="ad-hint">{text}</p> : null}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- undo bar (one at a time)

interface UndoItem {
  id: number;
  text: string;
  undo: () => void;
}
let undoItem: UndoItem | null = null;
let undoSeq = 0;
const undoSubs = new Set<() => void>();
const undoEmit = () => undoSubs.forEach((f) => f());

/** «Удалено · Вернуть» for ~7 s. */
export function showUndo(text: string, undo: () => void): void {
  undoItem = { id: ++undoSeq, text, undo };
  undoEmit();
}

export function UndoBar() {
  const item = useSyncExternalStore(
    (f) => {
      undoSubs.add(f);
      return () => undoSubs.delete(f);
    },
    () => undoItem,
    () => undoItem,
  );
  const el = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!item) return;
    if (el.current && !reducedMotion()) gsap.fromTo(el.current, { y: 40, opacity: 0, scaleX: 0.7 }, { y: 0, opacity: 1, scaleX: 1, duration: 0.7, ease: 'elastic.out(1,0.7)' });
    const t = setTimeout(() => {
      if (undoItem?.id === item.id) {
        undoItem = null;
        undoEmit();
      }
    }, 7000);
    return () => clearTimeout(t);
  }, [item]);
  if (!item) return null;
  return (
    <div ref={el} className="ad-undo" role="status">
      <span>{item.text}</span>
      <button
        type="button"
        className="ad-undo-btn"
        onClick={() => {
          item.undo();
          undoItem = null;
          undoEmit();
        }}
      >
        <Icon name="undo" size={16} />
        Вернуть
      </button>
    </div>
  );
}
