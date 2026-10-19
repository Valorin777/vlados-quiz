import { gsap } from 'gsap';
import { useEffect, useId, useRef, type InputHTMLAttributes, type Ref } from 'react';
import { audio } from '../audio';
import { pulse, shake } from '../beats';
import { useChromeBlob } from '../liquid';
import { assignRef, cx } from './util';

export interface ChromeFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onSubmit' | 'size'> {
  value: string;
  onChange: (v: string) => void;
  /** Enter pressed */
  onSubmit?: () => void;
  label?: string;
  hint?: string;
  /** shown under the field (announced politely); a change shakes the field */
  error?: string | null;
  liquid?: boolean;
  ref?: Ref<HTMLInputElement>;
}

/** Text input inside a liquid chrome pill; engraved centred text, glints on every keystroke. */
export function ChromeField({
  value,
  onChange,
  onSubmit,
  label,
  hint,
  error,
  liquid = true,
  id,
  className,
  ref,
  onKeyDown,
  ...rest
}: ChromeFieldProps) {
  const auto = useId();
  const fid = id ?? `vx-f-${auto}`;
  const shell = useRef<HTMLDivElement | null>(null);
  const blob = useChromeBlob(shell, { shape: 'pill', enabled: liquid, tar: error ? 0.18 : 0 });
  const lastErr = useRef<string | null | undefined>(error);

  useEffect(() => {
    if (error && error !== lastErr.current && shell.current) {
      shake(shell.current);
      if (blob.current) gsap.fromTo(blob.current, { tar: 0.6 }, { tar: 0.18, duration: 0.9 });
    }
    lastErr.current = error;
  }, [error, blob]);

  const describedBy = [error ? `${fid}-err` : null, hint ? `${fid}-hint` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cx('vx-fieldwrap', className)}>
      {label ? (
        <label className="vx-field-label" htmlFor={fid}>
          {label}
        </label>
      ) : null}
      <div ref={shell} className={cx('vx-field lq', error && 'has-error')} data-tone={error ? 'dim' : undefined}>
        <input
          ref={(n) => assignRef(ref, n)}
          id={fid}
          className="vx-field-input vx-eng"
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(e) => {
            onChange(e.currentTarget.value);
            pulse(blob.current, 0.3, 0.35);
            audio.drop(1.5 + Math.random() * 0.3, 0.1);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && onSubmit) {
              e.preventDefault();
              onSubmit();
            }
            onKeyDown?.(e);
          }}
          {...rest}
        />
      </div>
      <p className="vx-field-msg" id={error ? `${fid}-err` : `${fid}-hint`} aria-live="polite">
        {error || hint || ' '}
      </p>
    </div>
  );
}
