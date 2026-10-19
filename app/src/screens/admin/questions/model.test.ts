import { QuestionSchema } from '@shared/validate';
import type { ChoiceQ, NumberQ, OrderingQ, Question } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { convertQuestion, newQuestion, numberIn, QUESTION_TYPES, remember } from './model';

const base = {
  id: 'q1',
  title: 'Сколько лет Владосу?',
  timeLimitS: 30,
  double: true,
  notes: 'заметка',
  revealText: 'Вот столько!',
  media: { mediaId: 'm1', onPhones: true },
  revealMedia: { mediaId: 'm2', onPhones: false },
};

const choice = (): ChoiceQ => ({
  ...base,
  type: 'choice',
  options: [
    { id: 'a', text: '25' },
    { id: 'b', text: '26 лет' },
    { id: 'c', mediaId: 'img-c' },
    { id: 'd', text: '28' },
  ],
  correctId: 'b',
});

const ordering = (): OrderingQ => ({
  ...base,
  type: 'ordering',
  items: [
    { id: 'i1', text: 'Школа' },
    { id: 'i2', text: 'Универ', mediaId: 'img-u' },
    { id: 'i3', text: 'Работа' },
    { id: 'i4', text: 'Свадьба' },
  ],
  firstLabel: 'Раньше',
  lastLabel: 'Позже',
});

const number = (over: Partial<NumberQ> = {}): NumberQ => ({ ...base, type: 'number', answer: 26, unit: 'лет', min: 0, max: 100, step: 1, tolerance: 1, zeroAt: 8, ...over });

const baseOf = (q: Question) => ({
  id: q.id,
  title: q.title,
  timeLimitS: q.timeLimitS,
  double: q.double,
  notes: q.notes,
  revealText: q.revealText,
  media: q.media,
  revealMedia: q.revealMedia,
});
const valid = (q: Question) => QuestionSchema.safeParse(q).success;

describe('numberIn', () => {
  it('reads a number with an optional short unit', () => {
    expect(numberIn('26')).toEqual({ value: 26, decimals: 0 });
    expect(numberIn(' 26 лет ')).toEqual({ value: 26, decimals: 0, unit: 'лет' });
    expect(numberIn('2,5 кг')).toEqual({ value: 2.5, decimals: 1, unit: 'кг' });
    expect(numberIn('1 500 м')).toEqual({ value: 1500, decimals: 0, unit: 'м' });
    expect(numberIn('−3')).toEqual({ value: -3, decimals: 0 });
    expect(numberIn('0.25')).toEqual({ value: 0.25, decimals: 2 });
  });
  it('refuses text and ranges', () => {
    expect(numberIn(undefined)).toBeNull();
    expect(numberIn('')).toBeNull();
    expect(numberIn('Москва')).toBeNull();
    expect(numberIn('25–27 лет')).toBeNull();
    expect(numberIn('2 или 3')).toBeNull();
  });
});

describe('convertQuestion', () => {
  it('same type is a no-op', () => {
    const q = choice();
    expect(convertQuestion(q, 'choice')).toEqual({ q, dropped: [], needsAnswer: false });
  });

  it('keeps title, media, reveal, timer, notes and the id in every direction', () => {
    const samples: Question[] = [choice(), number(), ordering()];
    for (const q of samples) {
      for (const to of QUESTION_TYPES) {
        const r = convertQuestion(q, to);
        expect(r.q.type).toBe(to);
        expect(baseOf(r.q)).toEqual(baseOf(q));
        // no leftovers of the old type (the admin doc is written as is)
        const keys = Object.keys(r.q);
        if (to !== 'choice') expect(keys).not.toContain('options');
        if (to !== 'ordering') expect(keys).not.toContain('items');
        if (to !== 'number') expect(keys).not.toContain('answer');
      }
    }
  });

  it('choice → ordering: options become items in their current order', () => {
    const r = convertQuestion(choice(), 'ordering');
    const q = r.q as OrderingQ;
    expect(q.items).toEqual(choice().options);
    expect(q.firstLabel).toBe('Раньше');
    expect(r.dropped).toEqual([]);
    expect(r.note).toMatch(/порядк/);
    expect(valid(q)).toBe(true);
  });

  it('choice with 2 options → ordering gets a third (empty) item', () => {
    const c = choice();
    c.options = c.options.slice(0, 2);
    const q = convertQuestion(c, 'ordering').q as OrderingQ;
    expect(q.items).toHaveLength(3);
    expect(q.items.slice(0, 2)).toEqual(c.options);
    expect(q.items[2]?.text).toBe('');
  });

  it('ordering → choice: items become options, the first is correct', () => {
    const r = convertQuestion(ordering(), 'choice');
    const q = r.q as ChoiceQ;
    expect(q.options).toEqual(ordering().items);
    expect(q.correctId).toBe('i1');
    expect(r.dropped).toEqual([]);
    expect(valid(q)).toBe(true);
  });

  it('choice → number takes a numeric correct option (with its unit)', () => {
    const r = convertQuestion(choice(), 'number');
    const q = r.q as NumberQ;
    expect(q).toMatchObject({ answer: 26, unit: 'лет', step: 1, tolerance: 0 });
    expect(q.zeroAt).toBeGreaterThan(q.tolerance);
    expect(r.needsAnswer).toBe(false);
    expect(r.dropped).toEqual(['3 варианта ответа']); // «26 лет» is the answer now
    expect(valid(q)).toBe(true);
  });

  it('choice → number without a numeric answer asks for it', () => {
    const c = choice();
    c.correctId = 'c'; // a picture
    const r = convertQuestion(c, 'number');
    expect(r.q).toMatchObject({ type: 'number', answer: 0, step: 1, tolerance: 0, zeroAt: 10 });
    expect(r.needsAnswer).toBe(true);
    expect(r.dropped).toEqual(['4 варианта ответа']);
    const fresh = convertQuestion(newQuestion('choice', 30), 'number');
    expect(fresh.needsAnswer).toBe(true);
    expect(fresh.dropped).toEqual([]); // empty options are not «lost data»
  });

  it('decimal answers get a matching step', () => {
    const c = choice();
    c.options[1] = { id: 'b', text: '2,5' };
    const q = convertQuestion(c, 'number').q as NumberQ;
    expect(q.answer).toBe(2.5);
    expect(q.step).toBe(0.1);
    expect(valid(q)).toBe(true);
  });

  it('ordering → number drops the items and asks for the number', () => {
    const r = convertQuestion(ordering(), 'number');
    expect(r.dropped).toEqual(['4 пункта']);
    expect(r.needsAnswer).toBe(true);
  });

  it('number → choice: the number becomes option A (correct) + empty ones', () => {
    const r = convertQuestion(number(), 'choice');
    const q = r.q as ChoiceQ;
    expect(q.options).toHaveLength(3);
    expect(q.options[0]?.text).toBe('26 лет');
    expect(q.correctId).toBe(q.options[0]?.id);
    expect(q.options.slice(1).every((o) => o.text === '')).toBe(true);
    expect(new Set(q.options.map((o) => o.id)).size).toBe(3);
    expect(r.dropped).toEqual([]);
  });

  it('a fresh number question → choice / ordering: empty options, nothing to report', () => {
    const n = newQuestion('number', 30) as NumberQ;
    const c = convertQuestion(n, 'choice');
    expect((c.q as ChoiceQ).options).toHaveLength(3);
    expect((c.q as ChoiceQ).correctId).toBe('');
    const o = convertQuestion(n, 'ordering');
    expect((o.q as OrderingQ).items).toHaveLength(3);
    expect(o.dropped).toEqual([]);
  });

  it('number → ordering reports the dropped number', () => {
    const r = convertQuestion(number({ answer: 2.5, unit: 'кг' }), 'ordering');
    expect(r.dropped).toEqual(['число 2,5 кг']);
    expect((r.q as OrderingQ).items).toHaveLength(3);
  });

  it('switching back restores what the other type could not hold', () => {
    const c0 = choice();
    let memory = remember({}, c0);
    const n = convertQuestion(c0, 'number', memory).q as NumberQ;
    n.tolerance = 2;
    n.zeroAt = 12;
    memory = remember(memory, n);
    const c1 = convertQuestion(n, 'choice', memory);
    expect((c1.q as ChoiceQ).options).toEqual(c0.options);
    expect((c1.q as ChoiceQ).correctId).toBe('b');
    expect(c1.dropped).toEqual([]); // option B still says «26 лет»
    memory = remember(memory, c1.q);
    const n2 = convertQuestion(c1.q, 'number', memory);
    expect(n2.q).toMatchObject({ answer: 26, unit: 'лет', tolerance: 2, zeroAt: 12 });
    expect(n2.note).toBeUndefined();
  });

  it('choice → number → ordering → choice: the options survive the number', () => {
    const c0 = choice();
    let memory = remember({}, c0);
    const n = convertQuestion(c0, 'number', memory).q;
    memory = remember(memory, n);
    const o = convertQuestion(n, 'ordering', memory);
    expect((o.q as OrderingQ).items).toEqual(c0.options);
    expect(o.dropped).toEqual([]);
    const n5 = convertQuestion({ ...(n as NumberQ), answer: 5 }, 'ordering', memory);
    expect(n5.dropped).toEqual(['число 5 лет']);
    memory = remember(memory, o.q);
    const c1 = convertQuestion(o.q, 'choice', memory).q as ChoiceQ;
    expect(c1.options).toEqual(c0.options);
    expect(c1.correctId).toBe('b');
  });

  it('a placeholder number is not remembered as an answer', () => {
    const o0 = ordering();
    let memory = remember({}, o0);
    const n = convertQuestion(o0, 'number', memory);
    expect(n.needsAnswer).toBe(true);
    memory = remember(memory, n.q);
    const o1 = convertQuestion(n.q, 'ordering', memory);
    expect(o1.dropped).toEqual([]);
    expect((o1.q as OrderingQ).items).toEqual(o0.items);
    memory = remember(memory, o1.q);
    expect(convertQuestion(o1.q, 'number', memory).needsAnswer).toBe(true);
  });

  it('ordering with an empty first item → choice: no correct option yet', () => {
    const o = ordering();
    o.items[0] = { id: 'i1', text: '' };
    expect((convertQuestion(o, 'choice').q as ChoiceQ).correctId).toBe('');
  });

  it('choice → ordering → choice keeps the correct option and the labels', () => {
    const c0 = choice();
    let memory = remember({}, c0);
    const o = convertQuestion(c0, 'ordering', memory).q as OrderingQ;
    o.firstLabel = 'Меньше';
    memory = remember(memory, o);
    const c1 = convertQuestion(o, 'choice', memory);
    expect((c1.q as ChoiceQ).correctId).toBe('b');
    expect(c1.note).toBeUndefined();
    memory = remember(memory, c1.q);
    const o2 = convertQuestion(c1.q, 'ordering', memory).q as OrderingQ;
    expect(o2.firstLabel).toBe('Меньше');
  });

  it('does not touch the input and copies items', () => {
    const c = choice();
    const before = structuredClone(c);
    const q = convertQuestion(c, 'ordering').q as OrderingQ;
    q.items[0]!.text = 'changed';
    expect(c).toEqual(before);
  });

  it('keeps disabled, drops undefined optional fields', () => {
    const c = choice();
    c.disabled = true;
    delete c.notes;
    const q = convertQuestion(c, 'number').q;
    expect(q.disabled).toBe(true);
    expect('notes' in q).toBe(false);
  });
});
