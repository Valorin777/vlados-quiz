import { describe, expect, it } from 'vitest';
import { DEFAULT_SCORING } from '../defaults';
import {
  closestIds,
  correctPairs,
  defaultZeroAt,
  effectiveElapsed,
  isPermutation,
  numberAccuracy,
  orderingQuality,
  scoreAnswer,
  scoreRound,
  speed,
  type ScorableAnswer,
} from '../scoring';
import type { AnswerPayload, ChoiceQ, NumberQ, OrderingQ } from '../types';

const P = DEFAULT_SCORING;
const T = 60_000;

const choiceQ = (over: Partial<ChoiceQ> = {}): ChoiceQ => ({
  id: 'c',
  type: 'choice',
  title: 'Выбор',
  options: [
    { id: 'a', text: 'А' },
    { id: 'b', text: 'Б' },
  ],
  correctId: 'a',
  timeLimitS: 60,
  double: false,
  ...over,
});

const numberQ = (over: Partial<NumberQ> = {}): NumberQ => ({
  id: 'n',
  type: 'number',
  title: 'Число',
  answer: 100,
  step: 1,
  tolerance: 0,
  zeroAt: 20,
  timeLimitS: 60,
  double: false,
  ...over,
});

const ids = (n: number) => Array.from({ length: n }, (_, i) => `i${i}`);
const orderingQ = (n: number, over: Partial<OrderingQ> = {}): OrderingQ => ({
  id: 'o',
  type: 'ordering',
  title: 'Порядок',
  items: ids(n).map((id) => ({ id, text: id })),
  firstLabel: 'Раньше',
  lastLabel: 'Позже',
  timeLimitS: 60,
  double: false,
  ...over,
});

const ans = (p: AnswerPayload, elapsedMs = 0): ScorableAnswer => ({ p, elapsedMs });
const num = (v: number, elapsedMs = 0) => ans({ t: 'number', v }, elapsedMs);
const ord = (list: string[], elapsedMs = 0) => ans({ t: 'ordering', ids: list }, elapsedMs);

describe('speed', () => {
  it('is 1 at 0 s and 1 − w at T, clamped outside', () => {
    expect(speed(0, T, 0.5)).toBe(1);
    expect(speed(T, T, 0.5)).toBe(0.5);
    expect(speed(T / 2, T, 0.5)).toBe(0.75);
    expect(speed(3 * T, T, 0.5)).toBe(0.5);
    expect(speed(-500, T, 0.5)).toBe(1);
    expect(speed(0, 0, 0.3)).toBeCloseTo(0.7);
  });
});

describe('effectiveElapsed', () => {
  const credit = 3000;
  it('trusts the client inside [server − credit, server]', () => {
    expect(effectiveElapsed(8000, 10_000, T, credit)).toBe(8000);
    expect(effectiveElapsed(7000, 10_000, T, credit)).toBe(7000);
    expect(effectiveElapsed(10_000, 10_000, T, credit)).toBe(10_000);
  });
  it('clamps a too-small client value to server − credit', () => {
    expect(effectiveElapsed(1000, 10_000, T, credit)).toBe(7000);
    expect(effectiveElapsed(-50, 10_000, T, credit)).toBe(7000);
  });
  it('clamps a too-large client value to the server value', () => {
    expect(effectiveElapsed(12_000, 10_000, T, credit)).toBe(10_000);
  });
  it('never exceeds T and never goes below 0', () => {
    expect(effectiveElapsed(T + 1500, T + 2000, T, credit)).toBe(T);
    expect(effectiveElapsed(T - 500, T + 2000, T, credit)).toBe(T - 500);
    expect(effectiveElapsed(0, 1000, T, credit)).toBe(0);
    expect(effectiveElapsed(100, -200, T, credit)).toBe(0);
  });
  it('falls back to the server value for garbage and rounds to ms', () => {
    expect(effectiveElapsed(Number.NaN, 5000, T, credit)).toBe(5000);
    expect(effectiveElapsed(4999.6, 5000, T, credit)).toBe(5000);
    expect(effectiveElapsed(4000.2, 5000, T, credit)).toBe(4000);
  });
  it('with zero credit uses the server time', () => {
    expect(effectiveElapsed(1000, 5000, T, 0)).toBe(5000);
  });
});

describe('choice', () => {
  const q = choiceQ();
  it('correct: 1000 at 0 s, 500 at T, 750 at T/2', () => {
    expect(scoreAnswer(q, ans({ t: 'choice', id: 'a' }, 0), P)).toEqual({ points: 1000, accuracy: 1, correct: true });
    expect(scoreAnswer(q, ans({ t: 'choice', id: 'a' }, T), P).points).toBe(500);
    expect(scoreAnswer(q, ans({ t: 'choice', id: 'a' }, T / 2), P).points).toBe(750);
    expect(scoreAnswer(q, ans({ t: 'choice', id: 'a' }, 10 * T), P).points).toBe(500);
  });
  it('rounds before doubling', () => {
    // 1000·(1 − 0.5·1/60000) = 999.99… → 1000; 1000·(1 − 0.5·0.333) = 833.33 → 833 → ×2 = 1666
    expect(scoreAnswer(q, ans({ t: 'choice', id: 'a' }, 1), P).points).toBe(1000);
    expect(scoreAnswer({ ...q, double: true }, ans({ t: 'choice', id: 'a' }, T / 3), P).points).toBe(1666);
  });
  it('×2 doubles both ends', () => {
    const d = { ...q, double: true };
    expect(scoreAnswer(d, ans({ t: 'choice', id: 'a' }, 0), P).points).toBe(2000);
    expect(scoreAnswer(d, ans({ t: 'choice', id: 'a' }, T), P).points).toBe(1000);
  });
  it('wrong or mistyped answers get 0', () => {
    expect(scoreAnswer(q, ans({ t: 'choice', id: 'b' }, 0), P)).toEqual({ points: 0, accuracy: 0, correct: false });
    expect(scoreAnswer(q, num(1), P)).toEqual({ points: 0, accuracy: 0, correct: false });
  });
  it('uses the configured base and speed weight', () => {
    const params = { ...P, base: 500, choice: { speedWeight: 0 } };
    expect(scoreAnswer(q, ans({ t: 'choice', id: 'a' }, T), params).points).toBe(500);
  });
});

describe('number accuracy', () => {
  it('is 1 within tolerance (boundary included) and 0 at or beyond zeroAt', () => {
    const q = numberQ({ tolerance: 5, zeroAt: 25 });
    expect(numberAccuracy(q, 100, 1.5)).toBe(1);
    expect(numberAccuracy(q, 105, 1.5)).toBe(1);
    expect(numberAccuracy(q, 95, 1.5)).toBe(1);
    expect(numberAccuracy(q, 125, 1.5)).toBe(0);
    expect(numberAccuracy(q, 75, 1.5)).toBe(0);
    expect(numberAccuracy(q, 1e9, 1.5)).toBe(0);
  });
  it('follows (1 − x)^curve in between', () => {
    const q = numberQ({ tolerance: 5, zeroAt: 25 });
    expect(numberAccuracy(q, 115, 1.5)).toBeCloseTo(0.5 ** 1.5, 12);
    expect(numberAccuracy(q, 85, 1)).toBeCloseTo(0.5, 12);
    expect(numberAccuracy(q, 110, 2)).toBeCloseTo(0.75 ** 2, 12);
  });
  it('handles negative answers and guesses', () => {
    const q = numberQ({ answer: -5, tolerance: 0, zeroAt: 4 });
    expect(numberAccuracy(q, -5, 1.5)).toBe(1);
    expect(numberAccuracy(q, -7, 1.5)).toBeCloseTo(0.5 ** 1.5, 12);
    expect(numberAccuracy(q, -3, 1.5)).toBeCloseTo(0.5 ** 1.5, 12);
    expect(numberAccuracy(q, -1, 1.5)).toBe(0);
    expect(numberAccuracy(q, 5, 1.5)).toBe(0);
  });
  it('treats float noise as exact', () => {
    expect(numberAccuracy(numberQ({ answer: 0.3, tolerance: 0, zeroAt: 1 }), 0.1 + 0.2, 1.5)).toBe(1);
  });
  it('guards zeroAt ≤ tolerance and non-finite guesses', () => {
    const q = numberQ({ tolerance: 5, zeroAt: 5 });
    expect(numberAccuracy(q, 104, 1.5)).toBe(1);
    expect(numberAccuracy(q, 106, 1.5)).toBe(0);
    expect(numberAccuracy(numberQ(), Number.NaN, 1.5)).toBe(0);
    expect(numberAccuracy(numberQ(), Number.POSITIVE_INFINITY, 1.5)).toBe(0);
  });
  it('default zeroAt: quarter of the range, else max(|answer|·0.3, step·10)', () => {
    expect(defaultZeroAt({ answer: 2015, min: 1995, max: 2027, step: 1 })).toBe(8);
    expect(defaultZeroAt({ answer: 100, step: 1 })).toBe(30);
    expect(defaultZeroAt({ answer: -100, step: 1 })).toBe(30);
    expect(defaultZeroAt({ answer: 3, step: 1 })).toBe(10);
    expect(defaultZeroAt({ answer: 0, step: 0.5 })).toBe(5);
    expect(defaultZeroAt({ answer: 5, min: 10, max: 10, step: 1 })).toBe(10);
  });
});

describe('number scoring', () => {
  const q = numberQ({ tolerance: 0, zeroAt: 20 });
  it('exact and closest: 1000 at 0 s; speed only scales the accuracy part', () => {
    expect(scoreAnswer(q, num(100, 0), P, true)).toEqual({ points: 1000, accuracy: 1, correct: true, closest: true });
    // 1000·(0.8·1·(1 − 0.2) + 0.2) = 840
    expect(scoreAnswer(q, num(100, T), P, true).points).toBe(840);
    // Not closest (someone tied elsewhere is impossible for exact, but the flag is what counts)
    expect(scoreAnswer(q, num(100, 0), P, false)).toEqual({ points: 800, accuracy: 0.8, correct: true, closest: false });
  });
  it('closest bonus alone is worth 200 (×2 = 400) even with zero accuracy', () => {
    expect(scoreAnswer(q, num(500, 0), P, true)).toEqual({ points: 200, accuracy: 0.2, correct: true, closest: true });
    expect(scoreAnswer({ ...q, double: true }, num(500, T), P, true).points).toBe(400);
    expect(scoreAnswer(q, num(500, 0), P, false)).toEqual({ points: 0, accuracy: 0, correct: false, closest: false });
  });
  it('matches the formula in between', () => {
    const acc = 0.5 ** 1.5;
    const expected = Math.round(1000 * (0.8 * acc * (1 - 0.2 * 0.25))) * 2;
    expect(scoreAnswer({ ...q, double: true }, num(110, T / 4), P).points).toBe(expected);
    expect(scoreAnswer(q, num(110, 0), P).accuracy).toBeCloseTo(0.8 * acc, 12);
  });
  it('correct means accuracy ≥ 0.9 or closest', () => {
    const wide = numberQ({ tolerance: 0, zeroAt: 100 });
    expect(numberAccuracy(wide, 106, 1.5)).toBeGreaterThanOrEqual(0.9);
    expect(scoreAnswer(wide, num(106), P).correct).toBe(true);
    expect(numberAccuracy(wide, 107, 1.5)).toBeLessThan(0.9);
    expect(scoreAnswer(wide, num(107), P).correct).toBe(false);
    expect(scoreAnswer(wide, num(107), P, true).correct).toBe(true);
  });
  it('mistyped payload gets 0 and closest false', () => {
    expect(scoreAnswer(q, ans({ t: 'choice', id: 'x' }), P)).toEqual({ points: 0, accuracy: 0, correct: false, closest: false });
  });
});

describe('closest', () => {
  const q = numberQ({ answer: 100 });
  it('all guests tied at the minimum error are closest', () => {
    const set = closestIds(q, { a: num(90), b: num(110), c: num(120), d: num(89) }, null);
    expect([...set].sort()).toEqual(['a', 'b']);
  });
  it('ties survive float noise (symmetric guesses)', () => {
    const qf = numberQ({ answer: 0.3 });
    expect([...closestIds(qf, { a: num(0.2), b: num(0.4) }, null)].sort()).toEqual(['a', 'b']);
  });
  it('Vlados does not decide the guests’ closest', () => {
    const set = closestIds(q, { v: num(100), a: num(110), b: num(130) }, 'v');
    expect(set.has('a')).toBe(true);
    expect(set.has('b')).toBe(false);
    // …but he is closest himself when at least as close as the best guest.
    expect(set.has('v')).toBe(true);
    expect(closestIds(q, { v: num(150), a: num(110) }, 'v').has('v')).toBe(false);
    expect(closestIds(q, { v: num(90), a: num(110) }, 'v').has('v')).toBe(true);
  });
  it('a lone Vlados answer is closest; no answers → nobody', () => {
    expect([...closestIds(q, { v: num(7) }, 'v')]).toEqual(['v']);
    expect(closestIds(q, {}, 'v').size).toBe(0);
  });
  it('ignores non-number payloads', () => {
    expect([...closestIds(q, { a: ans({ t: 'choice', id: 'x' }), b: num(1) }, null)]).toEqual(['b']);
  });
});

describe('ordering', () => {
  it('counts correctly ordered pairs', () => {
    expect(correctPairs(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(3);
    expect(correctPairs(['a', 'b', 'c'], ['b', 'a', 'c'])).toBe(2);
    expect(correctPairs(['a', 'b', 'c'], ['c', 'b', 'a'])).toBe(0);
    expect(correctPairs(['a', 'b', 'c', 'd'], ['b', 'a', 'd', 'c'])).toBe(4);
    expect(correctPairs(['a', 'b', 'c'], ['a', 'b'])).toBeNull();
  });

  it('isPermutation rejects duplicates, missing and foreign ids', () => {
    expect(isPermutation(['a', 'b', 'c'], ['c', 'a', 'b'])).toBe(true);
    expect(isPermutation(['a', 'b', 'c'], ['a', 'a', 'b'])).toBe(false);
    expect(isPermutation(['a', 'b', 'c'], ['a', 'b', 'x'])).toBe(false);
    expect(isPermutation(['a', 'b', 'c'], ['a', 'b', 'c', 'd'])).toBe(false);
  });

  for (let n = 3; n <= 6; n++) {
    describe(`n = ${n}`, () => {
      const q = orderingQ(n);
      const correct = ids(n);
      const pairs = (n * (n - 1)) / 2;

      it('exact: 1000 at 0 s, 700 at T, ×2', () => {
        expect(scoreAnswer(q, ord(correct, 0), P)).toEqual({ points: 1000, accuracy: 1, correct: true });
        expect(scoreAnswer(q, ord(correct, T), P).points).toBe(700);
        expect(scoreAnswer({ ...q, double: true }, ord(correct, 0), P).points).toBe(2000);
      });

      it('adjacent swap gets partialCap·a^gamma', () => {
        for (let k = 0; k < n - 1; k++) {
          const swapped = [...correct];
          [swapped[k], swapped[k + 1]] = [swapped[k + 1] as string, swapped[k] as string];
          const a = (pairs - 1) / pairs;
          const quality = 0.7 * a ** 2;
          const r = scoreAnswer(q, ord(swapped, 0), P);
          expect(r.correct).toBe(false);
          expect(r.accuracy).toBeCloseTo(quality, 12);
          expect(r.points).toBe(Math.round(1000 * quality));
        }
      });

      it('reversed gets 0', () => {
        expect(scoreAnswer(q, ord([...correct].reverse(), 0), P)).toEqual({ points: 0, accuracy: 0, correct: false });
      });

      it('invalid lists get 0', () => {
        expect(scoreAnswer(q, ord(correct.slice(1), 0), P).points).toBe(0);
        expect(scoreAnswer(q, ord([...correct.slice(1), correct[1] as string], 0), P).points).toBe(0);
      });
    });
  }

  it('n = 3 adjacent swap is exactly 311 points at 0 s', () => {
    expect(scoreAnswer(orderingQ(3), ord(['i1', 'i0', 'i2']), P).points).toBe(311);
    expect(orderingQuality(['a', 'b', 'c'], ['a', 'c', 'b'], P.ordering)).toEqual({ exact: false, a: 2 / 3, q: 0.7 * (2 / 3) ** 2 });
  });

  it('partial answers never beat an exact one, even when slower', () => {
    const q = orderingQ(6);
    const almost = ['i0', 'i1', 'i2', 'i3', 'i5', 'i4'];
    expect(scoreAnswer(q, ord(ids(6), T), P).points).toBeGreaterThan(scoreAnswer(q, ord(almost, 0), P).points);
  });
});

describe('scoreRound', () => {
  it('scores every answer and flags closest only for number questions', () => {
    const q = numberQ({ answer: 50, tolerance: 0, zeroAt: 10 });
    const res = scoreRound(q, { a: num(50, 0), b: num(55, 0), v: num(50, 0) }, 'v', P);
    expect(res.a).toEqual({ points: 1000, accuracy: 1, correct: true, closest: true });
    expect(res.b?.closest).toBe(false);
    expect(res.v?.closest).toBe(true);

    const c = scoreRound(choiceQ(), { a: ans({ t: 'choice', id: 'a' }), b: ans({ t: 'choice', id: 'b' }) }, null, P);
    expect(c.a).toEqual({ points: 1000, accuracy: 1, correct: true });
    expect(c.b).toEqual({ points: 0, accuracy: 0, correct: false });
    expect('closest' in (c.a ?? {})).toBe(false);
  });

  it('empty answers → empty results', () => {
    expect(scoreRound(choiceQ(), {}, null, P)).toEqual({});
  });
});
