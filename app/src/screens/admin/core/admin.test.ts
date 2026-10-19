import { defaultSettings, seedContent } from '@shared/defaults';
import type { ChoiceQ, NumberQ, OrderingQ } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { fmtDuration, fmtNum, isoToMskInput, mskInputToIso, parseNum } from './format';
import { isTemplate, mediaIdsOf, readiness, SHOW_OVERHEAD_S, TALK_PER_QUESTION_S } from './readiness';
import { standingsCsv, type RoundStat, type StandingRow } from './results';
import { bytesKey } from './media';
import { seedDoc } from './seed';

const choice = (patch: Partial<ChoiceQ> = {}): ChoiceQ => ({
  id: 'c1',
  type: 'choice',
  title: 'Любимый цвет Владоса?',
  options: [
    { id: 'a', text: 'Синий' },
    { id: 'b', text: 'Красный' },
  ],
  correctId: 'a',
  timeLimitS: 30,
  double: false,
  ...patch,
});

const num: NumberQ = { id: 'n1', type: 'number', title: 'Рост?', answer: 180, step: 1, tolerance: 2, zeroAt: 20, timeLimitS: 20, double: false };
const ord: OrderingQ = {
  id: 'o1',
  type: 'ordering',
  title: 'По порядку',
  items: [
    { id: 'x', text: '1' },
    { id: 'y', text: '2' },
    { id: 'z', text: '3' },
  ],
  firstLabel: 'Раньше',
  lastLabel: 'Позже',
  timeLimitS: 45,
  double: false,
};

describe('readiness', () => {
  const settings = { introMs: 4000 };

  it('counts enabled questions and estimates the show length', () => {
    const r = readiness([choice(), num, { ...ord, disabled: true }], settings, () => true);
    expect(r.active).toBe(2);
    expect(r.total).toBe(3);
    expect(r.durationS).toBe(SHOW_OVERHEAD_S + (4 + 30 + TALK_PER_QUESTION_S) + (4 + 20 + TALK_PER_QUESTION_S));
    expect(r.problems).toEqual([]);
    expect(r.score).toBe(1);
  });

  it('flags a missing correct answer, empty options and missing media', () => {
    const q = choice({ correctId: 'nope', options: [{ id: 'a', text: 'Да' }, { id: 'b', text: '' }], media: { mediaId: 'm1', onPhones: true } });
    const r = readiness([q], settings, (id) => (id === 'm1' ? false : true));
    const texts = r.problems.map((p) => p.text);
    expect(texts).toContain('Не выбран правильный ответ');
    expect(texts).toContain('Пустой вариант ответа');
    expect(texts).toContain('Файл не найден — загрузи заново');
    expect(r.byQid.c1).toBe('block');
    expect(r.score).toBe(0);
  });

  it('does not report media that is still being checked', () => {
    const r = readiness([choice({ media: { mediaId: 'm1', onPhones: true } })], settings, () => undefined);
    expect(r.problems).toEqual([]);
  });

  it('warns about untouched templates and an empty game', () => {
    const seed = seedContent();
    const r = readiness(seed.questions, seed.settings, () => true);
    expect(r.problems.every((p) => p.level === 'warn')).toBe(true);
    expect(r.problems).toHaveLength(6);
    expect(isTemplate(seed.questions[0]!)).toBe(true);
    expect(readiness([], settings, () => true).problems[0]?.text).toBe('Нет ни одного включённого вопроса');
  });

  it('lists every media id of a question', () => {
    const q = choice({ media: { mediaId: 'm', onPhones: false }, revealMedia: { mediaId: 'r', onPhones: true }, options: [{ id: 'a', mediaId: 'o1' }, { id: 'b', text: 'x' }] });
    expect(mediaIdsOf(q)).toEqual(['m', 'r', 'o1']);
  });
});

describe('seed', () => {
  it('templates or an empty game, never with a media map (the rules refuse unknown keys)', () => {
    const full = seedDoc(true, 5);
    expect(full.questions).toHaveLength(6);
    expect(Object.keys(full).sort()).toEqual(['questions', 'rev', 'settings', 'trash', 'updatedAt']);
    expect(seedDoc(false).questions).toEqual([]);
    expect(full.settings).toEqual(defaultSettings());
  });
});

describe('format', () => {
  it('Moscow date input round trip', () => {
    expect(isoToMskInput('2026-09-26T19:00:00+03:00')).toBe('2026-09-26T19:00');
    expect(isoToMskInput('2026-09-26T16:00:00Z')).toBe('2026-09-26T19:00');
    expect(mskInputToIso('2026-09-26T19:30')).toBe('2026-09-26T19:30:00+03:00');
    expect(mskInputToIso('2026-09-26')).toBeNull();
  });

  it('numbers with a comma', () => {
    expect(parseNum('1,5')).toBe(1.5);
    expect(parseNum(' −3 ')).toBe(-3);
    expect(parseNum('')).toBeUndefined();
    expect(parseNum('abc')).toBeNaN();
    expect(fmtNum(2.5)).toBe('2,5');
    expect(fmtNum(undefined)).toBe('');
  });

  it('durations', () => {
    expect(fmtDuration(30)).toBe('1\u00a0мин');
    expect(fmtDuration(18 * 60)).toBe('18\u00a0мин');
    expect(fmtDuration(65 * 60)).toBe('1\u00a0ч 05\u00a0мин');
  });
});

describe('csv', () => {
  it('BOM, semicolons, quoting, Vlados out of competition', () => {
    const rounds: RoundStat[] = [
      { i: 0, n: 1, qid: 'q', title: 'Цвет; любимый', type: 'choice', skipped: false, revealed: true, answered: 2, correct: 1, correctPct: 0.5, avgPoints: 400, fastestMs: 1000, fastestName: 'Аня' },
      { i: 1, n: null, qid: 'q2', title: 'Пропущен', type: 'number', skipped: true, revealed: false, answered: 0, correct: 0, correctPct: 0, avgPoints: 0, fastestMs: null, fastestName: null },
    ];
    const rows: StandingRow[] = [
      { uid: 'a', name: 'Аня "Звезда"', score: 800, correct: 1, answered: 1, rank: 1, isVlados: false, perRound: { 0: 800 } },
      { uid: 'v', name: 'Владос', score: 950, correct: 1, answered: 1, rank: null, isVlados: true, perRound: { 0: 950 } },
    ];
    const csv = standingsCsv(rows, rounds);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const lines = csv.slice(1).trimEnd().split('\r\n');
    expect(lines[0]).toBe('Место;Имя;Очки;Верных;Ответов;"В1: Цвет; любимый"');
    expect(lines[1]).toBe('1;"Аня ""Звезда""";800;1;1;800');
    expect(lines[2]).toBe('вне конкурса;Владос;950;1;1;950');
  });
});

describe('selfie URLs', () => {
  it('the same picture in a new array (every Firestore players snapshot) keeps its key', () => {
    const a = new Uint8Array(6000).map((_, i) => (i * 31) & 255);
    const b = a.slice();
    expect(bytesKey(b)).toBe(bytesKey(a));
    const c = a.slice(); // (keys are memoized per array: selfie bytes are never mutated)
    c[4321] = (c[4321] as number) ^ 1;
    expect(bytesKey(c)).not.toBe(bytesKey(a));
    expect(bytesKey(a.subarray(0, 5999))).not.toBe(bytesKey(a));
    expect(bytesKey(new Uint8Array([1, 2]))).not.toBe(bytesKey(new Uint8Array([2, 1])));
  });
});
