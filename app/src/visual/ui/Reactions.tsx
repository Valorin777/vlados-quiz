import { gsap } from 'gsap';
import { useEffect, useRef, type CSSProperties } from 'react';
import { REACTIONS } from '@shared/defaults';
import { audio } from '../audio';
import { pulse } from '../beats';
import { useChromeBlob, useLiquid, type Blob } from '../liquid';
import { reducedMotion, rnd } from '../motion';
import { cx } from './util';

export const REACTION_EMOJI: readonly string[] = REACTIONS;
const LABELS = ['Огонь', 'Смешно', 'Шок', 'Аплодисменты', 'Люблю', 'Взрыв мозга', 'Праздник', 'Хм'];

// ------------------------------------------------------------------ phone bar

function RButton({ e, label, onTap, disabled }: { e: string; label: string; onTap: (el: HTMLButtonElement, b: Blob | null) => void; disabled: boolean }) {
  const el = useRef<HTMLButtonElement | null>(null);
  const blob = useChromeBlob(el, { shape: 'circle', film: 0.45 });
  return (
    <button
      ref={el}
      type="button"
      className="vx-rb lq lq-circle"
      aria-label={label}
      disabled={disabled}
      onClick={() => el.current && onTap(el.current, blob.current)}
    >
      <span aria-hidden="true">{e}</span>
    </button>
  );
}

export interface ReactionBarProps {
  /** index into `emojis` */
  onReact: (index: number) => void;
  emojis?: readonly string[];
  disabled?: boolean;
  label?: string;
  className?: string;
}

/** Row of chrome droplets with emoji; tapping squirts the emoji upward locally. */
export function ReactionBar({ onReact, emojis = REACTION_EMOJI, disabled = false, label = 'Кинуть реакцию на экран', className }: ReactionBarProps) {
  const fx = useRef<HTMLDivElement | null>(null);
  const { engine } = useLiquid();
  const tap = (i: number, btn: HTMLButtonElement, b: Blob | null) => {
    const e = emojis[i] ?? '';
    gsap.fromTo(btn, { scale: 0.72 }, { scale: 1, duration: reducedMotion() ? 0.2 : 0.8, ease: reducedMotion() ? 'power2.out' : 'elastic.out(1,0.55)' });
    pulse(b, 0.7, 0.7);
    audio.drop(1.2, 0.3);
    if (engine && b) engine.ripple(b.x, b.y, 0.35);
    const host = fx.current;
    if (host && !reducedMotion()) {
      const hr = host.getBoundingClientRect();
      const br = btn.getBoundingClientRect();
      const x = br.left - hr.left + br.width / 2 - 15;
      const y = br.top - hr.top;
      for (let k = 0; k < 3; k++) {
        const s = document.createElement('span');
        s.textContent = e;
        host.appendChild(s);
        gsap.fromTo(
          s,
          { x, y, scale: 0.5, opacity: 1 },
          { x: x + (k - 1) * 40 + (rnd() - 0.5) * 20, y: y - 180 - rnd() * 120, scale: 1.1, opacity: 0, duration: 1.3 + k * 0.15, ease: 'power2.out', onComplete: () => s.remove() },
        );
      }
    }
    onReact(i);
  };
  return (
    <div className={cx('vx-rbar-wrap', className)}>
      <p className="vx-field-label">{label}</p>
      <div className="vx-rbar" role="group" aria-label={label}>
        {emojis.map((e, i) => (
          <RButton key={i} e={e} label={LABELS[i] ?? e} disabled={disabled} onTap={(el, b) => tap(i, el, b)} />
        ))}
      </div>
      <div ref={fx} className="vx-rbar-fx" aria-hidden="true" />
    </div>
  );
}

// ------------------------------------------------------------------ TV layer

export interface ReactionItem {
  id: string;
  /** emoji index (into `emojis`) or the emoji itself */
  e: number | string;
  name?: string;
}

export interface ReactionLayerProps {
  /** recent reactions; every new `id` launches one flyer (older ids are ignored) */
  items: readonly ReactionItem[];
  emojis?: readonly string[];
  /** horizontal launch band, fractions of the layer width */
  from?: number;
  to?: number;
  /** concurrent flyers cap (extra reactions are dropped, newest win) */
  max?: number;
  className?: string;
  style?: CSSProperties;
}

/**
 * Emoji (with the sender's name) float up from the bottom with a sway and fade near the top; a
 * ripple rings out on the liquid where each one is launched. Imperative DOM for 25+/s bursts.
 */
export function ReactionLayer({ items, emojis = REACTION_EMOJI, from = 0.5, to = 0.98, max = 36, className, style }: ReactionLayerProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const seen = useRef<Set<string>>(new Set());
  const live = useRef(0);
  const { engine } = useLiquid();
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const fresh = items.filter((it) => !seen.current.has(it.id));
    for (const it of items) seen.current.add(it.id);
    if (seen.current.size > 2000) seen.current = new Set(items.map((i) => i.id));
    const W = el.clientWidth;
    const H = el.clientHeight;
    for (const it of fresh.slice(-12)) {
      if (live.current >= max) break;
      const e = typeof it.e === 'number' ? emojis[it.e] ?? '' : it.e;
      const node = document.createElement('div');
      node.className = 'vx-rx';
      const em = document.createElement('span');
      em.textContent = e;
      node.appendChild(em);
      if (it.name) {
        const nm = document.createElement('small');
        nm.textContent = it.name;
        node.appendChild(nm);
      }
      el.appendChild(node);
      live.current++;
      const x = W * (from + rnd() * (to - from));
      const rm = reducedMotion();
      const d = rm ? 2.2 : 3.4;
      const sway = (rnd() - 0.5) * 160;
      gsap.fromTo(node, { x: x - 30, y: H + 10, scale: 0.3, rotation: (rnd() - 0.5) * 30 }, {
        y: H * (0.1 + rnd() * 0.22),
        scale: 1,
        rotation: 0,
        duration: d,
        ease: 'power1.out',
        onComplete: () => {
          node.remove();
          live.current--;
        },
      });
      if (!rm) gsap.to(node, { x: x - 30 + sway, duration: d, ease: 'sine.inOut' });
      gsap.to(node, { opacity: 0, duration: 0.7, delay: d - 0.7 });
      if (engine && W > 0 && H > 0) {
        // layer-local px → design units (works for plain and CSS-scaled TV surfaces alike)
        const p = engine.measure(el);
        engine.ripple(p.x - p.w / 2 + x * (p.w / W), p.y + p.h / 2 - 20 * (p.h / H), 0.45);
      }
    }
  }, [items, emojis, from, to, max, engine]);
  return <div ref={host} className={cx('vx-rxlayer', className)} style={style} aria-hidden="true" />;
}
