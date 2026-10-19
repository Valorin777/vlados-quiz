// Pure scoring (docs/architecture.md → Scoring). Shared by the server, bots and the admin preview.

import type { AnswerPayload, Id, NumberQ, OrderingQ, Question, RoundResult, ScoringParams } from './types';
import { clamp } from './util';

export { defaultZeroAt } from './defaults';

export interface ScorableAnswer {
  p: AnswerPayload;
  elapsedMs: number;
}

export const timeLimitMs = (q: Pick<Question, 'timeLimitS'>): number => q.timeLimitS * 1000;

/** speed(w) = 1 − w·s, s = clamp(elapsed / T, 0, 1). */
export function speed(elapsedMs: number, limitMs: number, weight: number): number {
  const s = limitMs > 0 ? clamp(elapsedMs / limitMs, 0, 1) : 1;
  return 1 - weight * s;
}

/**
 * Elapsed time used for scoring: the client's own measurement is trusted only within
 * [serverElapsed − maxLatencyCreditMs, serverElapsed], and never beyond T.
 */
export function effectiveElapsed(clientMs: number, serverMs: number, limitMs: number, maxLatencyCreditMs: number): number {
  const hi = Math.max(0, serverMs);
  const lo = Math.max(0, hi - maxLatencyCreditMs);
  const e = Number.isFinite(clientMs) ? clamp(clientMs, lo, hi) : hi;
  return Math.round(Math.min(e, Math.max(0, limitMs)));
}

// ---------- Number ----------

/** Float slack so that e.g. 0.1 + 0.2 counts as exactly 0.3 and symmetric guesses tie. */
const numEps = (q: Pick<NumberQ, 'answer'>): number => 1e-9 * Math.max(1, Math.abs(q.answer));

export const numberError = (q: Pick<NumberQ, 'answer'>, v: number): number =>
  Number.isFinite(v) ? Math.abs(v - q.answer) : Number.POSITIVE_INFINITY;

/** acc = (1 − x)^curve, x = clamp((err − tol) / (zeroAt − tol), 0, 1). */
export function numberAccuracy(q: Pick<NumberQ, 'answer' | 'tolerance' | 'zeroAt'>, v: number, curve: number): number {
  const err = numberError(q, v);
  if (!Number.isFinite(err)) return 0;
  if (err <= q.tolerance + numEps(q)) return 1;
  if (q.zeroAt <= q.tolerance) return 0;
  const x = clamp((err - q.tolerance) / (q.zeroAt - q.tolerance), 0, 1);
  return (1 - x) ** curve;
}

/**
 * Who gets the "closest" bonus: every guest tied at the minimum guest error. Vlados does not
 * take part in deciding it; he is marked closest himself when he is at least as close as the best guest.
 */
export function closestIds(q: Pick<NumberQ, 'answer'>, answers: Readonly<Record<Id, ScorableAnswer>>, vladosId: Id | null): Set<Id> {
  const errs: [Id, number][] = [];
  for (const [id, a] of Object.entries(answers)) {
    if (a.p.t === 'number' && Number.isFinite(a.p.v)) errs.push([id, numberError(q, a.p.v)]);
  }
  let min = Number.POSITIVE_INFINITY;
  for (const [id, e] of errs) if (id !== vladosId && e < min) min = e;
  const eps = numEps(q);
  const out = new Set<Id>();
  // With no guest answers min is Infinity, so a lone Vlados is closest.
  for (const [id, e] of errs) if (e <= min + eps) out.add(id);
  return out;
}

// ---------- Ordering ----------

export function isPermutation(correct: readonly Id[], given: readonly Id[]): boolean {
  if (given.length !== correct.length) return false;
  const set = new Set(given);
  return set.size === given.length && correct.every((id) => set.has(id));
}

/** Pairs (i < j in the correct order) that keep their relative order in `given`. Null if not a permutation. */
export function correctPairs(correct: readonly Id[], given: readonly Id[]): number | null {
  if (!isPermutation(correct, given)) return null;
  const pos = new Map(given.map((id, i) => [id, i] as const));
  let n = 0;
  for (let i = 0; i < correct.length; i++) {
    for (let j = i + 1; j < correct.length; j++) {
      if ((pos.get(correct[i] as Id) as number) < (pos.get(correct[j] as Id) as number)) n++;
    }
  }
  return n;
}

export interface OrderingQuality {
  exact: boolean;
  /** Share of correctly ordered pairs, 0..1. */
  a: number;
  /** 1 when exact, else partialCap·a^gamma. */
  q: number;
}

export function orderingQuality(correct: readonly Id[], given: readonly Id[], params: ScoringParams['ordering']): OrderingQuality {
  const cp = correctPairs(correct, given);
  if (cp === null) return { exact: false, a: 0, q: 0 };
  const pairs = (correct.length * (correct.length - 1)) / 2;
  const a = pairs > 0 ? cp / pairs : 1;
  const exact = cp === pairs;
  return { exact, a, q: exact ? 1 : params.partialCap * a ** params.gamma };
}

export const correctOrder = (q: Pick<OrderingQ, 'items'>): Id[] => q.items.map((i) => i.id);

// ---------- Per answer / per round ----------

const ZERO: RoundResult = { points: 0, accuracy: 0, correct: false };

/** Score one answer. `closest` only matters for number questions (see closestIds). */
export function scoreAnswer(q: Question, a: ScorableAnswer, params: ScoringParams, closest = false): RoundResult {
  const T = timeLimitMs(q);
  const M = q.double ? 2 : 1;
  const B = params.base;
  switch (q.type) {
    case 'choice': {
      const correct = a.p.t === 'choice' && a.p.id === q.correctId;
      const points = correct ? Math.round(B * speed(a.elapsedMs, T, params.choice.speedWeight)) * M : 0;
      return { points, accuracy: correct ? 1 : 0, correct };
    }
    case 'number': {
      if (a.p.t !== 'number') return { ...ZERO, closest: false };
      const n = params.number;
      const acc = numberAccuracy(q, a.p.v, n.curve);
      const c = closest ? 1 : 0;
      const points = Math.round(B * (n.accuracyShare * acc * speed(a.elapsedMs, T, n.speedWeight) + n.closestShare * c)) * M;
      return { points, accuracy: n.accuracyShare * acc + n.closestShare * c, correct: acc >= 0.9 || closest, closest };
    }
    case 'ordering': {
      if (a.p.t !== 'ordering') return { ...ZERO };
      const o = orderingQuality(correctOrder(q), a.p.ids, params.ordering);
      const points = Math.round(B * o.q * speed(a.elapsedMs, T, params.ordering.speedWeight)) * M;
      return { points, accuracy: o.q, correct: o.exact };
    }
  }
}

/** Results for every given answer (callers filter out kicked / unknown players beforehand). */
export function scoreRound(
  q: Question,
  answers: Readonly<Record<Id, ScorableAnswer>>,
  vladosId: Id | null,
  params: ScoringParams,
): Record<Id, RoundResult> {
  const closest = q.type === 'number' ? closestIds(q, answers, vladosId) : null;
  const out: Record<Id, RoundResult> = {};
  for (const [id, a] of Object.entries(answers)) out[id] = scoreAnswer(q, a, params, closest?.has(id) ?? false);
  return out;
}
