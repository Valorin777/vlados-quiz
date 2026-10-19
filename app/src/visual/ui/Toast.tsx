import { gsap } from 'gsap';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { audio } from '../audio';
import { reducedMotion } from '../motion';
import { cx } from './util';

export type ToastTone = 'info' | 'good' | 'bad';

interface ToastItem {
  id: number;
  text: string;
  tone: ToastTone;
  ms: number;
}

let items: ToastItem[] = [];
let seq = 0;
const subs = new Set<() => void>();
const emit = () => {
  for (const f of subs) f();
};

/** Show a short message at the top. Returns a function that dismisses it early. */
export function toast(text: string, o: { tone?: ToastTone; ms?: number } = {}): () => void {
  const id = ++seq;
  items = [...items.slice(-2), { id, text, tone: o.tone ?? 'info', ms: o.ms ?? 3200 }];
  emit();
  return () => dismissToast(id);
}

export function dismissToast(id: number): void {
  items = items.filter((t) => t.id !== id);
  emit();
}

function Item({ t }: { t: ToastItem }) {
  const el = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = el.current;
    if (node) {
      if (reducedMotion()) gsap.fromTo(node, { opacity: 0 }, { opacity: 1, duration: 0.2 });
      else gsap.fromTo(node, { y: -80, scaleX: 0.6, scaleY: 1.4 }, { y: 0, scaleX: 1, scaleY: 1, duration: 0.9, ease: 'elastic.out(1,0.6)' });
    }
    audio.drop(t.tone === 'bad' ? 0.6 : 1.25, 0.25);
    const id = setTimeout(() => {
      if (!node) return dismissToast(t.id);
      gsap.to(node, { y: -60, opacity: 0, scaleY: 0.7, duration: 0.3, ease: 'power2.in', onComplete: () => dismissToast(t.id) });
    }, t.ms);
    return () => clearTimeout(id);
  }, [t]);
  return (
    <div ref={el} className={cx('vx-toast lq', `is-${t.tone}`)} data-tone={t.tone === 'bad' ? 'tarnish' : t.tone === 'good' ? 'film' : undefined} role="status" onClick={() => dismissToast(t.id)}>
      <i className="vx-toast-bead" aria-hidden="true" />
      <span className={t.tone === 'bad' ? 'vx-toast-t is-bad' : 'vx-toast-t vx-eng'}>{t.text}</span>
    </div>
  );
}

/** Mount once per screen (inside the `.vx` root). Toasts are CSS chrome (they float over content). */
export function ToastHost() {
  const list = useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => items,
    () => items,
  );
  return (
    <div className="vx-toasts" aria-live="polite">
      {list.map((t) => (
        <Item key={t.id} t={t} />
      ))}
    </div>
  );
}
