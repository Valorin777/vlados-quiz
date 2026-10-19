// A picture full screen (tap the reveal photo on the phone): the whole photo on a blurred copy of
// itself; a tap anywhere, the × or Esc closes it. Portalled to <body> (never inside a transformed
// or liquid subtree).

import { gsap } from 'gsap';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ease } from '../motion';
import { FitImage } from './FitImage';

export interface LightboxProps {
  src: string | null | undefined;
  alt?: string;
  open: boolean;
  onClose: () => void;
}

export function Lightbox({ src, alt = '', open, onClose }: LightboxProps) {
  const box = useRef<HTMLDivElement | null>(null);
  const closeBtn = useRef<HTMLButtonElement | null>(null);
  const closing = useRef(false);
  const cb = useRef(onClose);
  cb.current = onClose;

  const close = () => {
    const el = box.current;
    if (!el || closing.current) return;
    closing.current = true;
    gsap.to(el, { opacity: 0, duration: 0.2, ease: 'power1.in', onComplete: () => cb.current() });
  };

  useEffect(() => {
    if (!open) return;
    closing.current = false;
    const el = box.current;
    const back = document.activeElement as HTMLElement | null;
    if (el) {
      gsap.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 0.25, ease: 'power1.out' });
      const pic = el.querySelector('.vx-lightbox-pic');
      if (pic) gsap.fromTo(pic, { scale: 0.88 }, { scale: 1, duration: 0.55, ease: ease.back });
    }
    closeBtn.current?.focus({ preventScroll: true });
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    addEventListener('keydown', onKey);
    return () => {
      removeEventListener('keydown', onKey);
      back?.focus?.({ preventScroll: true });
    };
  }, [open]);

  if (!open || !src || typeof document === 'undefined') return null;
  return createPortal(
    <div ref={box} className="vx-lightbox" role="dialog" aria-modal="true" aria-label={alt || 'Фото на весь экран'} onClick={close}>
      <div className="vx-lightbox-pic">
        <FitImage src={src} alt={alt} fit="fill" className="vx-lightbox-img" />
      </div>
      <button
        ref={closeBtn}
        type="button"
        className="vx-lightbox-x"
        aria-label="Закрыть"
        onClick={(e) => {
          e.stopPropagation();
          close();
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </div>,
    document.body,
  );
}
