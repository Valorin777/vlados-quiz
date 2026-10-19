import { gsap } from 'gsap';
import { useEffect, useRef, type ReactNode, type Ref, type RefObject } from 'react';
import { igniteCorrect, meltWrong } from '../beats';
import { useChromeBlob, useLiquid, type Blob } from '../liquid';
import { AvatarStack } from './Avatar';
import { usePress } from './press';
import { assignRef, cx } from './util';

export type OptionState = 'idle' | 'locked' | 'selected' | 'correct' | 'wrong' | 'melting';

export interface OptionTileProps {
  label: ReactNode;
  state?: OptionState;
  /** A / B / C / D key shown on the left (TV + phone parity) */
  keyLabel?: string;
  /** how many picked it (reveal) */
  count?: number;
  /** who picked it (reveal), newest first */
  people?: readonly { id: string; name: string; src?: string | null }[];
  onSelect?: () => void;
  disabled?: boolean;
  /** optional picture above the text */
  media?: ReactNode;
  liquid?: boolean;
  /**
   * Corner radius (px): the tile is a rounded box instead of a pill. A one-line tile (height ≤ 2r)
   * looks exactly like the pill; a tile whose label wraps keeps straight sides and its text on
   * the flat of the chrome instead of on the rim of a fat capsule (the phone uses 30).
   */
  radius?: number;
  ref?: Ref<HTMLButtonElement>;
  blobRef?: RefObject<Blob | null>;
  className?: string;
}

const LOOK: Record<OptionState, { film: number; tar: number; glow: number }> = {
  idle: { film: 0.34, tar: 0, glow: 0 },
  locked: { film: 0.12, tar: 0.22, glow: 0 },
  selected: { film: 0.75, tar: 0, glow: 0.22 },
  correct: { film: 0.9, tar: 0, glow: 0.12 },
  wrong: { film: 0.2, tar: 1, glow: 0 },
  melting: { film: 0.2, tar: 1, glow: 0 },
};

/**
 * An answer option. States: idle → selected (mine) / locked (time up) → correct (ignites) /
 * wrong / melting (tarnishes and drips on entry). Reveal shows count + who picked it.
 */
export function OptionTile({
  label,
  state = 'idle',
  keyLabel,
  count,
  people,
  onSelect,
  disabled,
  media,
  liquid = true,
  radius,
  ref,
  blobRef,
  className,
}: OptionTileProps) {
  const el = useRef<HTMLButtonElement | null>(null);
  const labelRef = useRef<HTMLSpanElement | null>(null);
  const { engine } = useLiquid();
  const look = LOOK[state];
  const inner = useRef<Blob | null>(null);
  const blob = useChromeBlob(el, { shape: radius ? 'box' : 'pill', cr: radius, film: look.film, tar: look.tar, glow: look.glow, enabled: liquid, out: blobRef ?? inner });
  const interactive = state === 'idle' && !disabled && !!onSelect;
  const press = usePress(el, blob, { disabled: !interactive, sound: 0.95 });
  const prev = useRef<OptionState>(state);

  useEffect(() => {
    const was = prev.current;
    prev.current = state;
    if (was === state) return;
    const node = el.current;
    let tl: gsap.core.Timeline | null = null;
    if (state === 'melting') tl = meltWrong(engine, blob.current, { mode: 'sag', el: node, drips: 3 });
    else if (state === 'correct' && was !== 'correct') tl = igniteCorrect(engine, blob.current, { label: labelRef.current, width: node ? node.offsetWidth * 0.8 : 200 });
    else if (state === 'selected' && node) gsap.fromTo(node, { scale: 1.06 }, { scale: 1, duration: 0.8, ease: 'elastic.out(1,0.5)' });
    else if (state === 'idle' && node) gsap.set(node, { clearProps: 'transform' });
    return () => {
      tl?.progress(1);
    };
  }, [state, engine, blob]);

  const metal = state === 'wrong' || state === 'melting' ? 'tarnish' : state === 'correct' ? 'film' : state === 'locked' ? 'dim' : undefined;
  const hasMeta = count !== undefined || (people && people.length > 0);
  return (
    <button
      ref={(n) => {
        el.current = n;
        assignRef(ref, n);
      }}
      type="button"
      className={cx('vx-opt lq', `is-${state}`, hasMeta && 'has-meta', media ? 'has-media' : null, className)}
      data-tone={metal}
      style={radius ? { borderRadius: radius } : undefined}
      aria-pressed={state === 'selected' || undefined}
      aria-disabled={!interactive || undefined}
      disabled={disabled}
      onClick={interactive ? onSelect : undefined}
      {...press}
    >
      {keyLabel ? <span className="vx-opt-key vx-mono">{keyLabel}</span> : null}
      {media ? <span className="vx-opt-media">{media}</span> : null}
      <span ref={labelRef} className="vx-opt-label">
        {label}
      </span>
      {hasMeta ? (
        <span className="vx-opt-meta">
          {people && people.length ? <AvatarStack people={people} max={3} size={22} /> : null}
          {count !== undefined ? <b className="vx-opt-count vx-mono">{count}</b> : null}
        </span>
      ) : null}
      {state === 'correct' ? <span className="vx-sr">— правильный ответ</span> : null}
      {state === 'selected' ? <span className="vx-sr">— твой выбор</span> : null}
    </button>
  );
}
