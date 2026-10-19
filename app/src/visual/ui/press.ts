import { gsap } from 'gsap';
import { useCallback, useRef, type PointerEvent as RPointerEvent, type RefObject } from 'react';
import { audio } from '../audio';
import { useLiquid, type Blob } from '../liquid';
import { reducedMotion } from '../motion';

export interface PressHandlers {
  onPointerDown: (e: RPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: RPointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: RPointerEvent<HTMLElement>) => void;
  onPointerLeave: (e: RPointerEvent<HTMLElement>) => void;
}

/**
 * Liquid press feedback: the element sinks (and its blob brightens) under the finger, then
 * springs back with an elastic wobble and a ripple where it was released.
 */
export function usePress(
  ref: RefObject<HTMLElement | null>,
  blob: RefObject<Blob | null>,
  o: { disabled?: boolean; depth?: number; sound?: number | false } = {},
): PressHandlers {
  const { engine } = useLiquid();
  const down = useRef(false);
  const { disabled = false, depth = 0.955, sound = 1.1 } = o;

  const release = useCallback(
    (e: RPointerEvent<HTMLElement>, commit: boolean) => {
      if (!down.current) return;
      down.current = false;
      const el = ref.current;
      if (!el) return;
      gsap.to(el, {
        scale: 1,
        duration: reducedMotion() ? 0.2 : 0.8,
        ease: reducedMotion() ? 'power2.out' : 'elastic.out(1,0.45)',
        overwrite: 'auto',
      });
      const b = blob.current;
      if (b) gsap.to(b, { glow: 0, duration: 0.6, ease: 'power2.out', overwrite: 'auto' });
      if (commit) {
        if (engine) {
          const p = engine.toLocal(e.clientX, e.clientY);
          engine.ripple(p.x, p.y, 0.45);
        }
        if (sound !== false) audio.drop(sound, 0.28);
      }
    },
    [ref, blob, engine, sound],
  );

  return {
    onPointerDown: (e) => {
      if (disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
      down.current = true;
      const el = ref.current;
      if (el) gsap.to(el, { scale: depth, duration: 0.12, ease: 'power2.out', overwrite: 'auto' });
      const b = blob.current;
      if (b) gsap.to(b, { glow: 0.28, duration: 0.12, overwrite: 'auto' });
    },
    onPointerUp: (e) => release(e, true),
    onPointerCancel: (e) => release(e, false),
    onPointerLeave: (e) => release(e, false),
  };
}
