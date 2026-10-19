import { useRef, type ButtonHTMLAttributes, type ReactNode, type Ref, type RefObject } from 'react';
import { useChromeBlob, type Blob } from '../liquid';
import { usePress } from './press';
import { assignRef, cx } from './util';

export interface ChromeButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children: ReactNode;
  /** chrome: liquid pill · film: iridescent (special actions) · ghost: underlined text button */
  variant?: 'chrome' | 'film' | 'ghost';
  size?: 'l' | 'm' | 's';
  /** stretch to the container width */
  block?: boolean;
  loading?: boolean;
  icon?: ReactNode;
  /** liquid blob (default on for chrome/film) — turn off inside overlays */
  liquid?: boolean;
  ref?: Ref<HTMLButtonElement>;
  /** exposes the anchored blob (for beats) */
  blobRef?: RefObject<Blob | null>;
}

/** Liquid chrome pill button with press / release wobble and engraved label. */
export function ChromeButton({
  children,
  variant = 'chrome',
  size = 'l',
  block = false,
  loading = false,
  icon,
  liquid = true,
  disabled,
  className,
  ref,
  blobRef: exposed,
  type = 'button',
  onPointerDown,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
  ...rest
}: ChromeButtonProps) {
  const el = useRef<HTMLButtonElement | null>(null);
  const ghost = variant === 'ghost';
  const off = disabled || loading;
  const blob = useChromeBlob(el, {
    shape: 'pill',
    enabled: liquid && !ghost,
    film: variant === 'film' ? 0.95 : 0.34,
    tar: disabled ? 0.4 : 0,
    out: exposed,
  });
  const press = usePress(el, blob, { disabled: off || ghost, sound: ghost ? false : 1.1 });
  const setRef = (n: HTMLButtonElement | null) => {
    el.current = n;
    assignRef(ref, n);
  };
  return (
    <button
      ref={setRef}
      type={type}
      disabled={disabled}
      aria-busy={loading || undefined}
      className={cx(
        'vx-btn',
        `vx-btn-${size}`,
        ghost ? 'vx-btn-ghost' : 'lq',
        block && 'vx-btn-block',
        disabled && 'is-disabled',
        loading && 'is-loading',
        className,
      )}
      data-tone={variant === 'film' ? 'film' : disabled ? 'dim' : undefined}
      onPointerDown={(e) => {
        press.onPointerDown(e);
        onPointerDown?.(e);
      }}
      onPointerUp={(e) => {
        press.onPointerUp(e);
        onPointerUp?.(e);
      }}
      onPointerCancel={(e) => {
        press.onPointerCancel(e);
        onPointerCancel?.(e);
      }}
      onPointerLeave={(e) => {
        press.onPointerLeave(e);
        onPointerLeave?.(e);
      }}
      {...rest}
    >
      {icon ? <span className="vx-btn-icon">{icon}</span> : null}
      <span className={cx('vx-btn-label', !ghost && 'vx-eng')}>{children}</span>
      {loading ? (
        <span className="vx-btn-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      ) : null}
    </button>
  );
}
