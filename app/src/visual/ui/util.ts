// Small helpers for the UI primitives.

import type { Ref } from 'react';

/** Write a node into a user-supplied ref (object or callback). */
export function assignRef<T>(ref: Ref<T> | undefined, v: T | null): void {
  if (typeof ref === 'function') ref(v);
  else if (ref) (ref as { current: T | null }).current = v;
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

type Segmenter = { segment: (s: string) => Iterable<{ segment: string }> };
let seg: Segmenter | null | undefined;

/** User-perceived characters (emoji-safe). */
export function graphemes(s: string): string[] {
  if (seg === undefined) {
    const I = Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => Segmenter };
    seg = I.Segmenter ? new I.Segmenter('ru', { granularity: 'grapheme' }) : null;
  }
  if (!seg) return Array.from(s);
  return Array.from(seg.segment(s), (x) => x.segment);
}

/** First visible character of a name, uppercased (emoji stay as they are). */
export function initialOf(name: string): string {
  const g = graphemes(name.trim())[0] ?? '?';
  return g.toLocaleUpperCase('ru-RU');
}

/** Russian plural: plural(5, ['минута', 'минуты', 'минут']) → 'минут'. */
export function plural(n: number, forms: readonly [string, string, string]): string {
  const a = Math.abs(Math.trunc(n)) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b === 1) return forms[0];
  if (b > 1 && b < 5) return forms[1];
  return forms[2];
}

/** 12 345 with a thin no-break space, the Russian way. */
export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('ru-RU').replace(/\s/g, ' ');
}

/** m:ss */
export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.ceil(sec - 1e-6));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
