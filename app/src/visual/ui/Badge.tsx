import { useRef, type ReactNode } from 'react';
import { useChromeBlob } from '../liquid';
import { cx } from './util';

export interface BadgeProps {
  children: ReactNode;
  /** film: iridescent (×2 double points) · chrome · hot (amber, urgency) · quiet (outline) */
  tone?: 'film' | 'chrome' | 'hot' | 'quiet';
  size?: 's' | 'm' | 'l';
  /** liquid blob (film/chrome only) */
  liquid?: boolean;
  className?: string;
  title?: string;
}

/** Small pill label: "×2", "ты", "Владос", status chips. */
export function Badge({ children, tone = 'film', size = 'm', liquid = false, className, title }: BadgeProps) {
  const el = useRef<HTMLSpanElement | null>(null);
  const metal = tone === 'film' || tone === 'chrome';
  useChromeBlob(el, { shape: 'pill', film: tone === 'film' ? 1 : 0.34, enabled: liquid && metal });
  return (
    <span
      ref={el}
      title={title}
      className={cx('vx-badge', `vx-badge-${size}`, `vx-badge-${tone}`, metal && 'lq', className)}
      data-tone={tone === 'film' ? 'film' : undefined}
    >
      <span className={metal ? 'vx-eng' : undefined}>{children}</span>
    </span>
  );
}
