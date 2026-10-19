import { useRef, type CSSProperties, type Ref, type RefObject } from 'react';
import { useChromeBlob, type Blob } from '../liquid';
import { assignRef, cx, initialOf } from './util';

export type AvatarSize = 'xs' | 's' | 'm' | 'l' | 'xl' | number;
const SIZES: Record<Exclude<AvatarSize, number>, number> = { xs: 24, s: 32, m: 48, l: 80, xl: 112 };

export interface AvatarProps {
  name: string;
  /** selfie URL (object URL / data URL); otherwise the engraved initial */
  src?: string | null;
  size?: AvatarSize;
  /** anchor a liquid blob (use for the few hero avatars, not for crowds) */
  liquid?: boolean;
  /** highlight ring (the viewer themself) */
  you?: boolean;
  /** tarnish 0..1 (e.g. hasn't answered yet) */
  tar?: number;
  film?: number;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<HTMLDivElement>;
  blobRef?: RefObject<Blob | null>;
  /** decorative (name is shown next to it) */
  decorative?: boolean;
}

/** Chrome sphere with a selfie inset or an engraved initial. */
export function Avatar({ name, src, size = 'm', liquid = false, you = false, tar = 0, film = 0.45, className, style, ref, blobRef, decorative = false }: AvatarProps) {
  const px = typeof size === 'number' ? size : SIZES[size];
  const el = useRef<HTMLDivElement | null>(null);
  useChromeBlob(el, { shape: 'circle', film, tar, enabled: liquid, out: blobRef });
  return (
    <div
      ref={(n) => {
        el.current = n;
        assignRef(ref, n);
      }}
      className={cx('vx-av lq lq-circle', you && 'is-you', className)}
      data-tone={tar > 0.5 ? 'tarnish' : undefined}
      style={{ '--av': `${px}px`, ...style } as CSSProperties}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : name}
      aria-hidden={decorative || undefined}
    >
      {src ? <img src={src} alt="" draggable={false} /> : <b className="vx-eng">{initialOf(name)}</b>}
    </div>
  );
}

export interface AvatarStackProps {
  people: readonly { id: string; name: string; src?: string | null }[];
  max?: number;
  size?: number;
  className?: string;
}

/** Overlapping mini avatars (+N) — who picked this option. CSS chrome only (crowds). */
export function AvatarStack({ people, max = 4, size = 24, className }: AvatarStackProps) {
  const shown = people.slice(0, max);
  const more = people.length - shown.length;
  return (
    <span className={cx('vx-avstack', className)} style={{ '--av': `${size}px` } as CSSProperties} aria-hidden="true">
      {shown.map((p) => (
        <Avatar key={p.id} name={p.name} src={p.src} size={size} decorative />
      ))}
      {more > 0 ? <span className="vx-avstack-more">+{more}</span> : null}
    </span>
  );
}
