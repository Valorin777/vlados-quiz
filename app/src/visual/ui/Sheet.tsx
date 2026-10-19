import { gsap } from 'gsap';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { LiquidOff } from '../liquid';
import { reducedMotion } from '../motion';
import { cx } from './util';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children?: ReactNode;
  /** bottom sheet (phones) or centred modal (TV/admin/desktop) */
  variant?: 'sheet' | 'modal';
  /** hide the close button (still closes on Escape / backdrop unless `persistent`) */
  hideClose?: boolean;
  persistent?: boolean;
  className?: string;
}

const FOCUSABLE = 'button:not([disabled]),[href],input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])';

/**
 * Milk-glass / smoked-glass overlay. Liquid anchoring is off inside (it floats over content), so
 * primitives render their CSS chrome. Escape and the backdrop close it; focus is trapped and
 * restored.
 */
export function Sheet({ open, onClose, title, children, variant = 'sheet', hideClose = false, persistent = false, className }: SheetProps) {
  const [present, setPresent] = useState(open);
  const panel = useRef<HTMLDivElement | null>(null);
  const scrim = useRef<HTMLDivElement | null>(null);
  const restore = useRef<Element | null>(null);
  const tid = useId();
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (open) setPresent(true);
  }, [open]);

  useLayoutEffect(() => {
    const p = panel.current;
    const s = scrim.current;
    if (!present || !p || !s) return;
    gsap.killTweensOf([p, s]);
    const rm = reducedMotion();
    if (open) {
      restore.current = document.activeElement;
      gsap.fromTo(s, { opacity: 0 }, { opacity: 1, duration: 0.3 });
      if (variant === 'sheet') gsap.fromTo(p, { yPercent: 105 }, { yPercent: 0, duration: rm ? 0.25 : 0.75, ease: rm ? 'power2.out' : 'elastic.out(1,0.8)' });
      else gsap.fromTo(p, { scale: 0.86, opacity: 0 }, { scale: 1, opacity: 1, duration: rm ? 0.2 : 0.6, ease: rm ? 'power2.out' : 'back.out(1.6)' });
      const f = p.querySelector<HTMLElement>(FOCUSABLE);
      (f ?? p).focus({ preventScroll: true });
    } else {
      gsap.to(s, { opacity: 0, duration: 0.25 });
      gsap.to(p, {
        ...(variant === 'sheet' ? { yPercent: 105 } : { scale: 0.9, opacity: 0 }),
        duration: 0.28,
        ease: 'power2.in',
        onComplete: () => {
          setPresent(false);
          if (restore.current instanceof HTMLElement) restore.current.focus({ preventScroll: true });
        },
      });
    }
  }, [open, present, variant]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !persistent) {
        e.stopPropagation();
        close.current();
      } else if (e.key === 'Tab' && panel.current) {
        const f = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
        const first = f[0];
        const last = f[f.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, persistent]);

  if (!present) return null;
  return (
    <div className={cx('vx-overlay', `is-${variant}`)}>
      <div ref={scrim} className="vx-scrim" onClick={persistent ? undefined : () => close.current()} />
      <div
        ref={panel}
        className={cx('vx-sheet', className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? tid : undefined}
        tabIndex={-1}
      >
        {variant === 'sheet' ? <i className="vx-sheet-grip" aria-hidden="true" /> : null}
        {title || !hideClose ? (
          <div className="vx-sheet-head">
            {title ? (
              <h2 id={tid} className="vx-h3">
                {title}
              </h2>
            ) : (
              <span />
            )}
            {!hideClose ? (
              <button type="button" className="vx-sheet-x" aria-label="Закрыть" onClick={() => close.current()}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m6 6 12 12M18 6 6 18" />
                </svg>
              </button>
            ) : null}
          </div>
        ) : null}
        <LiquidOff>
          <div className="vx-sheet-body">{children}</div>
        </LiquidOff>
      </div>
    </div>
  );
}

/** Centred variant. */
export function Modal(p: Omit<SheetProps, 'variant'>) {
  return <Sheet {...p} variant="modal" />;
}
