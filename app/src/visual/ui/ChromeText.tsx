import type { CSSProperties, JSX, Ref } from 'react';
import { cx, graphemes } from './util';

export type TextSize = 'hero' | 'h1' | 'h2' | 'h3' | 'inherit';

export interface ChromeTextProps {
  children: string;
  as?: keyof JSX.IntrinsicElements & ('h1' | 'h2' | 'h3' | 'p' | 'span' | 'div' | 'strong');
  size?: TextSize;
  /** Render per-letter / per-word spans (for riseLetters) — each glyph gets its own chrome. */
  split?: 'chars' | 'words' | false;
  /** The moving iridescent reflection (default on). */
  sweep?: boolean;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<HTMLElement>;
  id?: string;
}

/** Chrome letters: vertical chrome gradient + a travelling thin-film reflection. */
export function ChromeText({ children, as = 'span', size = 'inherit', split = false, sweep = true, className, style, ref, id }: ChromeTextProps) {
  const Tag = as as 'span';
  const sizeCls = size === 'inherit' ? null : `vx-${size}`;
  const chr = cx('vx-chr', !sweep && 'vx-still');
  if (!split) {
    return (
      <Tag ref={ref as Ref<HTMLSpanElement>} id={id} className={cx(sizeCls, chr, className)} style={style}>
        {children}
      </Tag>
    );
  }
  const words = children.trim().split(/\s+/);
  let i = 0;
  return (
    <Tag ref={ref as Ref<HTMLSpanElement>} id={id} className={cx(sizeCls, 'vx-split', className)} style={style} aria-label={children}>
      {words.map((w, wi) => (
        <span key={wi} aria-hidden="true">
          {wi > 0 ? ' ' : null}
          {split === 'words' ? (
            <span className="w">
              <span className={cx('wi', chr)} style={{ '--i': wi } as CSSProperties}>
                {w}
              </span>
            </span>
          ) : (
            <span className="wd">
              {graphemes(w).map((g, gi) => (
                <span className="w" key={gi}>
                  <span className={cx('ch', chr)} style={{ '--i': i++ } as CSSProperties}>
                    {g}
                  </span>
                </span>
              ))}
            </span>
          )}
        </span>
      ))}
    </Tag>
  );
}
