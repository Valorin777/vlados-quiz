import { useRef, type CSSProperties, type ReactNode, type Ref, type RefObject } from 'react';
import { useChromeBlob, type Blob, type Shape } from '../liquid';
import { assignRef, cx } from './util';

export interface ChromeBlockProps {
  children?: ReactNode;
  /** box (rounded rect), pill or circle */
  shape?: Shape;
  /** corner radius for boxes (px) */
  radius?: number;
  film?: number;
  tar?: number;
  glow?: number;
  /** CSS fallback tone */
  tone?: 'chrome' | 'band' | 'film' | 'tarnish';
  liquid?: boolean;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<HTMLDivElement>;
  blobRef?: RefObject<Blob | null>;
  role?: string;
  'aria-label'?: string;
  'aria-live'?: 'polite' | 'assertive' | 'off';
}

/**
 * A chrome surface (plate, block, orb, podium step) with engraved content on top. Liquid when
 * the engine runs, CSS chrome otherwise. Content inside should use `.vx-eng` text.
 */
export function ChromeBlock({
  children,
  shape = 'box',
  radius = 24,
  film = 0.35,
  tar = 0,
  glow = 0,
  tone = 'chrome',
  liquid = true,
  className,
  style,
  ref,
  blobRef,
  ...aria
}: ChromeBlockProps) {
  const el = useRef<HTMLDivElement | null>(null);
  useChromeBlob(el, { shape, film, tar, glow, cr: shape === 'box' ? radius : undefined, enabled: liquid, out: blobRef });
  return (
    <div
      ref={(n) => {
        el.current = n;
        assignRef(ref, n);
      }}
      className={cx('vx-block lq', shape === 'circle' && 'lq-circle', tone === 'band' && 'lq-band', className)}
      data-tone={tone === 'film' || tone === 'tarnish' ? tone : tar > 0.5 ? 'tarnish' : undefined}
      style={{ borderRadius: shape === 'box' ? radius : 999, ...style }}
      {...aria}
    >
      {children}
    </div>
  );
}
