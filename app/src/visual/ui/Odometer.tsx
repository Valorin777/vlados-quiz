import type { CSSProperties } from 'react';
import { cx, fmtInt } from './util';

export interface OdometerProps {
  value: number;
  /** left-pad with zeros to this many digits (clocks) */
  pad?: number;
  /** thousands grouping with a thin space (default: on for ≥ 4 digits) */
  group?: boolean;
  /** chrome letters */
  chrome?: boolean;
  className?: string;
  style?: CSSProperties;
  /** accessible text (default: the formatted number) */
  label?: string;
}

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/**
 * Rolling digits: each column is a 0–9 strip that slides with an overshoot when the value
 * changes. Columns are keyed from the right, so 99 → 100 grows a new column on the left.
 */
export function Odometer({ value, pad = 0, group = true, chrome = false, className, style, label }: OdometerProps) {
  const v = Math.round(value);
  const neg = v < 0;
  const raw = String(Math.abs(v)).padStart(pad, '0');
  const cells: { k: string; d: number | null; ch?: string }[] = [];
  const n = raw.length;
  for (let i = 0; i < n; i++) {
    const fromRight = n - 1 - i;
    cells.push({ k: `d${fromRight}`, d: Number(raw[i]) });
    if (group && n >= 4 && fromRight > 0 && fromRight % 3 === 0) cells.push({ k: `s${fromRight}`, d: null, ch: ' ' });
  }
  const text = label ?? (pad ? raw : fmtInt(v));
  return (
    <span className={cx('vx-odo', className)} style={style} role="img" aria-label={text}>
      {neg ? <span className={cx('vx-odo-sign', chrome && 'vx-chr')}>−</span> : null}
      {cells.map((c) =>
        c.d === null ? (
          <span key={c.k} className="vx-odo-sep">
            {c.ch}
          </span>
        ) : (
          <span key={c.k} className="vx-odo-d" aria-hidden="true">
            <span className="vx-odo-st" style={{ transform: `translateY(${-c.d * 1.1}em)` }}>
              {DIGITS.map((d) => (
                <span key={d} className={chrome ? 'vx-chr' : undefined}>
                  {d}
                </span>
              ))}
            </span>
          </span>
        ),
      )}
    </span>
  );
}
