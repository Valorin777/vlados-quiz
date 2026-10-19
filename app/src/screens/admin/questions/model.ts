// Creating and copying questions (ids are Firestore-safe nanoids).

import { defaultZeroAt, LIMITS } from '@shared/defaults';
import type { ChoiceQ, Item, NumberQ, OrderingQ, QBase, Question, QuestionType } from '@shared/types';
import { newId } from '@shared/util';
import type { IconName } from '../ui/icons';

export const TIME_CHIPS = [15, 20, 30, 45, 60, 90] as const;

const item = (text = ''): Item => ({ id: newId(10), text });

export function newQuestion(type: QuestionType, timeLimitS: number): Question {
  const base = { id: newId(12), title: '', timeLimitS, double: false };
  switch (type) {
    case 'choice': {
      // No correct option yet: the readiness meter reminds the organizer to pick one.
      const q: ChoiceQ = { ...base, type, options: [item(), item(), item(), item()], correctId: '' };
      return q;
    }
    case 'number': {
      const q: NumberQ = { ...base, type, answer: 0, step: 1, tolerance: 0, zeroAt: 10 };
      return q;
    }
    case 'ordering': {
      const q: OrderingQ = { ...base, type, items: [item(), item(), item(), item()], firstLabel: 'Раньше', lastLabel: 'Позже' };
      return q;
    }
  }
}

/** A copy with fresh ids (question, options/items; the correct option follows its copy). */
export function duplicateQuestion(q: Question): Question {
  const copy = structuredClone(q);
  copy.id = newId(12);
  copy.title = q.title ? `${q.title} (копия)` : '';
  delete copy.disabled;
  if (copy.type === 'choice' && q.type === 'choice') {
    const map = new Map<string, string>();
    copy.options = copy.options.map((o) => {
      const id = newId(10);
      map.set(o.id, id);
      return { ...o, id };
    });
    copy.correctId = map.get(q.correctId) ?? '';
  } else if (copy.type === 'ordering') {
    copy.items = copy.items.map((it) => ({ ...it, id: newId(10) }));
  }
  return copy;
}

export const newItem = item;

export const canAddOption = (q: ChoiceQ): boolean => q.options.length < LIMITS.choiceOptions.max;
export const canRemoveOption = (q: ChoiceQ): boolean => q.options.length > LIMITS.choiceOptions.min;
export const canAddItem = (q: OrderingQ): boolean => q.items.length < LIMITS.orderingItems.max;
export const canRemoveItem = (q: OrderingQ): boolean => q.items.length > LIMITS.orderingItems.min;

/** A sensible zero point when the organizer has not tuned it. */
export const suggestZeroAt = (q: NumberQ): number => {
  const z = defaultZeroAt(q);
  return Math.max(q.tolerance + q.step, Math.round(z * 100) / 100);
};

// ---------------------------------------------------------------- question types

export const QUESTION_TYPES: readonly QuestionType[] = ['choice', 'number', 'ordering'];

/** How the questions tab names a type: tabs, the list and «Добавить вопрос». */
export const TYPE_UI: Record<QuestionType, { icon: IconName; label: string; line: string }> = {
  choice: { icon: 'choice', label: 'Выбор ответа', line: 'Один верный из 2–6 вариантов' },
  number: { icon: 'number', label: 'Угадай число', line: 'Кто ближе к числу — больше очков' },
  ordering: { icon: 'order', label: 'Расставь по порядку', line: 'Выстроить 3–6 пунктов правильно' },
};

/**
 * The last version of the question in each type it had during this editing session (`list`: the
 * latest one with options or items). Switching back restores what the other type could not hold:
 * the number, the options, the correct option, the labels.
 */
export type TypeMemory = { choice?: ChoiceQ; number?: NumberQ; ordering?: OrderingQ; list?: ChoiceQ | OrderingQ };

/** `memory` after leaving `q` for another type. */
export function remember(memory: TypeMemory, q: Question): TypeMemory {
  const copy = structuredClone(q);
  return copy.type === 'number' ? { ...memory, number: copy } : { ...memory, [copy.type]: copy, list: copy };
}

export interface Converted {
  q: Question;
  /** Filled-in things the new type cannot hold (for the undo toast), e.g. «4 варианта ответа». */
  dropped: string[];
  /** Number question whose answer is only a placeholder: the organizer has to type it. */
  needsAnswer: boolean;
  /** What was carried over in a less obvious way (toast), e.g. «Число 26 — верный вариант A». */
  note?: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const fmt = (n: number): string => String(n).replace('.', ',');
const filled = (it: Item): boolean => Boolean(it.text?.trim() || it.mediaId);
const copyItems = (items: readonly Item[]): Item[] => items.map((it) => ({ ...it }));
const countItems = (n: number, forms: [string, string, string]): string => {
  const m10 = n % 10;
  const m100 = n % 100;
  const f = m10 === 1 && m100 !== 11 ? forms[0] : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? forms[1] : forms[2];
  return `${n} ${f}`;
};

/** Everything but the type-specific fields (no undefined keys). */
function baseOf(q: Question): QBase {
  const b: QBase = { id: q.id, title: q.title, timeLimitS: q.timeLimitS, double: q.double };
  if (q.media) b.media = { ...q.media };
  if (q.revealMedia) b.revealMedia = { ...q.revealMedia };
  if (q.revealText !== undefined) b.revealText = q.revealText;
  if (q.notes !== undefined) b.notes = q.notes;
  if (q.disabled) b.disabled = true;
  if (q.surprise) b.surprise = { ...q.surprise };
  return b;
}

/**
 * «26», «1 500 м», «2,5 кг», «-3» → the number (and the unit if the rest is a short word).
 * Anything with more numbers in it («25–27 лет», «2 или 3») → null.
 */
export function numberIn(text: string | undefined): { value: number; decimals: number; unit?: string } | null {
  const m = /^\s*([-−]?\d{1,3}(?:\s\d{3})+|[-−]?\d+)(?:[.,](\d+))?\s*(.*)$/.exec(text ?? '');
  if (!m) return null;
  const rest = (m[3] ?? '').trim();
  if (/\d/.test(rest) || rest.length > 20) return null;
  const value = Number(`${m[1]!.replace(/\s/g, '').replace('−', '-')}.${m[2] ?? '0'}`);
  if (!Number.isFinite(value)) return null;
  return { value, decimals: m[2]?.length ?? 0, ...(rest ? { unit: rest } : {}) };
}

/** Defaults of a number question around `answer`. */
function numberFields(answer: number, decimals: number): Pick<NumberQ, 'answer' | 'step' | 'tolerance' | 'zeroAt'> {
  const step = decimals > 0 ? 10 ** -Math.min(decimals, 6) : 1;
  const zeroAt = Math.max(step, round2(defaultZeroAt({ answer, step })));
  return { answer, step, tolerance: 0, zeroAt };
}

const numberText = (q: NumberQ): string => `${fmt(q.answer)}${q.unit ? ` ${q.unit}` : ''}`;
/** One of the options already says the number (then switching away loses nothing visible). */
const holdsNumber = (items: readonly Item[], q: NumberQ): boolean => items.some((it) => numberIn(it.text)?.value === q.answer);
const hasNumber = (q: NumberQ): boolean => q.answer !== 0 || q.unit !== undefined || q.min !== undefined || q.max !== undefined;

/**
 * The same question as another type, keeping what fits: title, media, reveal, timer, notes;
 * choice options ↔ ordering items (texts, pictures and ids; the current option order becomes the
 * correct order, the first item becomes the correct option); a numeric correct option ↔ the number.
 * `memory` (earlier versions of this question) brings back what a previous switch dropped.
 */
export function convertQuestion(q: Question, to: QuestionType, memory: TypeMemory = {}): Converted {
  if (q.type === to) return { q, dropped: [], needsAnswer: false };
  const base = baseOf(q);
  const dropped: string[] = [];
  let note: string | undefined;

  if (to === 'number') {
    const items = q.type === 'choice' ? q.options : q.type === 'ordering' ? q.items : [];
    const remembered = memory.number && hasNumber(memory.number) ? memory.number : undefined;
    let fields: Omit<NumberQ, keyof QBase | 'type'>;
    let needsAnswer = false;
    const correct = q.type === 'choice' ? q.options.find((o) => o.id === q.correctId) : undefined;
    const parsed = numberIn(correct?.text);
    if (remembered) {
      const { answer, unit, min, max, step, tolerance, zeroAt } = remembered;
      fields = { answer, step, tolerance, zeroAt, ...(unit !== undefined ? { unit } : {}), ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
    } else if (parsed) {
      fields = { ...numberFields(parsed.value, parsed.decimals), ...(parsed.unit ? { unit: parsed.unit } : {}) };
      note = `Ответ ${fmt(parsed.value)}${parsed.unit ? ` ${parsed.unit}` : ''} взят из верного варианта — проверь`;
    } else {
      fields = numberFields(0, 0);
      needsAnswer = true;
    }
    // An option that says the answer is not lost: it is the answer now.
    const n = items.filter((it) => filled(it) && (needsAnswer || numberIn(it.text)?.value !== fields.answer)).length;
    if (n) dropped.push(q.type === 'choice' ? countItems(n, ['вариант ответа', 'варианта ответа', 'вариантов ответа']) : countItems(n, ['пункт', 'пункта', 'пунктов']));
    const out: NumberQ = { ...base, type: 'number', ...fields };
    return { q: out, dropped, needsAnswer, ...(note ? { note } : {}) };
  }

  if (to === 'choice') {
    let options: Item[] = [];
    let correctId = '';
    let min: number = LIMITS.choiceOptions.min;
    const from = q.type === 'ordering' ? q : q.type === 'number' ? memory.list : undefined;
    if (from) {
      options = copyItems(from.type === 'choice' ? from.options : from.items).slice(0, LIMITS.choiceOptions.max);
      const kept = memory.choice?.correctId;
      const first = options[0];
      if (kept && options.some((o) => o.id === kept)) correctId = kept;
      else if (from.type === 'ordering' && first && filled(first)) {
        correctId = first.id;
        note = 'Верным стал первый пункт — проверь';
      }
      if (q.type === 'number' && hasNumber(q) && !holdsNumber(options, q)) dropped.push(`число ${numberText(q)}`);
    } else if (q.type === 'number') {
      min = 3;
      if (hasNumber(q)) {
        const first = item(numberText(q).slice(0, 140));
        options.push(first);
        correctId = first.id;
        note = `Число ${first.text} — верный вариант A, допиши остальные`;
      }
    }
    while (options.length < min) options.push(item());
    const out: ChoiceQ = { ...base, type: 'choice', options, correctId };
    return { q: out, dropped, needsAnswer: false, ...(note ? { note } : {}) };
  }

  // → ordering
  const remembered = memory.ordering;
  let items: Item[];
  if (q.type === 'choice') {
    items = copyItems(q.options);
    if (q.options.filter(filled).length > 1) note = 'Порядок вариантов стал правильным порядком — проверь';
  } else if (q.type === 'number') {
    const from = memory.list;
    items = from ? copyItems(from.type === 'choice' ? from.options : from.items) : [];
    if (from?.type === 'choice' && from.options.filter(filled).length > 1) note = 'Порядок вариантов стал правильным порядком — проверь';
    if (hasNumber(q) && !holdsNumber(items, q)) dropped.push(`число ${numberText(q)}`);
  } else items = [];
  items = items.slice(0, LIMITS.orderingItems.max);
  while (items.length < LIMITS.orderingItems.min) items.push(item());
  const out: OrderingQ = {
    ...base,
    type: 'ordering',
    items,
    firstLabel: remembered?.firstLabel ?? 'Раньше',
    lastLabel: remembered?.lastLabel ?? 'Позже',
  };
  return { q: out, dropped, needsAnswer: false, ...(note ? { note } : {}) };
}
