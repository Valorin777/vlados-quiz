// Text helpers for the phone screens (Russian copy, numbers the Russian way).

import type { PubItem } from '@shared/fbtypes';
import type { AnswerPayload } from '@shared/types';
import type { QuestionView } from '../../host/views';
import { plural } from '../../visual/ui/util';

const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 });

/** 12 345,5 — with a thin no-break space and a real minus. */
export const fmtNum = (v: number): string => nf.format(v).replace(/\s/g, ' ').replace('-', '−');

export const withUnit = (v: number, unit?: string): string => (unit ? `${fmtNum(v)} ${unit}` : fmtNum(v));

export const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

export function itemText(it: PubItem | undefined, index = -1): string {
  const t = it?.text?.trim();
  if (t) return t;
  if (it?.mediaId) return index >= 0 ? `картинка ${LETTERS[index] ?? index + 1}` : 'картинка';
  return '—';
}

export function itemsOf(q: QuestionView | null): PubItem[] {
  if (!q) return [];
  return (q.type === 'choice' ? q.options : q.type === 'ordering' ? q.items : undefined) ?? [];
}

/** A player's (or Vlados's) answer as short text. */
export function answerText(q: QuestionView | null, p: AnswerPayload): string {
  const items = itemsOf(q);
  const find = (id: string) => {
    const k = items.findIndex((it) => it.id === id);
    return itemText(items[k], k);
  };
  switch (p.t) {
    case 'choice':
      return find(p.id);
    case 'number':
      return withUnit(p.v, q?.number?.unit);
    case 'ordering':
      return p.ids.map(find).join(' → ');
  }
}

export function correctText(q: QuestionView | null, c: string | number | string[]): string {
  if (typeof c === 'number') return withUnit(c, q?.number?.unit);
  if (Array.isArray(c)) return answerText(q, { t: 'ordering', ids: c });
  return answerText(q, { t: 'choice', id: c });
}

export const pts = (n: number): string => `${fmtNum(n)} ${plural(n, ['очко', 'очка', 'очков'])}`;

export const players = (n: number): string => `${fmtNum(n)} ${plural(n, ['игрок', 'игрока', 'игроков'])}`;

/** «суббота · 26 сентября · 19:00» in Moscow time (the party's clock, whatever the phone says). */
export function partyDate(ms: number): string {
  try {
    const d = new Date(ms);
    const tz = { timeZone: 'Europe/Moscow' } as const;
    const wd = new Intl.DateTimeFormat('ru-RU', { ...tz, weekday: 'long' }).format(d);
    const day = new Intl.DateTimeFormat('ru-RU', { ...tz, day: 'numeric', month: 'long' }).format(d);
    const hm = new Intl.DateTimeFormat('ru-RU', { ...tz, hour: '2-digit', minute: '2-digit' }).format(d);
    return `${wd} · ${day} · ${hm}`;
  } catch {
    return '';
  }
}

/** Splits the title for the hero: «Кто лучше знает» + «ВЛАДОСА» (the last word goes chrome). */
export function splitTitle(title: string): { lead: string; hero: string } {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) return { lead: '', hero: (words[0] ?? '').toLocaleUpperCase('ru-RU') };
  const hero = words.pop() as string;
  return { lead: words.join(' '), hero: hero.replace(/[!?.…]+$/u, '').toLocaleUpperCase('ru-RU') };
}

/** Font size for a one-line chrome hero word on a phone (Unbounded 900 is wide). */
export function heroSize(word: string, max = 54): string {
  const n = Math.max(3, Array.from(word).length);
  return `min(${max}px, calc((min(100vw, 480px) - 48px) / ${(n * 1.02).toFixed(2)}))`;
}
