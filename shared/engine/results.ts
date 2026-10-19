// Round results, standings and the Vlados comparison. Totals are always derived from
// rounds[].results, never stored (docs/architecture.md → Data model, Scoring).

import { scoreRound, type ScorableAnswer } from '../scoring';
import type { Id, Player, Round, RoundResult, ScoringParams } from '../types';
import type { PlayerChip, VladosComparison } from '../views';

/** Results for everyone who answered, except kicked and unknown players. */
export function computeRoundResults(
  round: Round,
  players: Readonly<Record<Id, Player>>,
  vladosId: Id | null,
  scoring: ScoringParams,
): Record<Id, RoundResult> {
  const eligible: Record<Id, ScorableAnswer> = {};
  for (const [id, a] of Object.entries(round.answers)) {
    const p = players[id];
    if (p && !p.kicked) eligible[id] = a;
  }
  return scoreRound(round.q, eligible, vladosId, scoring);
}

/** A round counts towards totals once revealed and not skipped. */
export const isScored = (r: Round): boolean => !r.skipped && r.results !== undefined;

export interface Standing {
  id: Id;
  score: number;
  /** Number of rounds answered correctly. */
  correct: number;
  /** Scored rounds with an answer. */
  answered: number;
  /** Sum of elapsed times; a scored round without an answer counts as the full time limit. */
  elapsedMs: number;
  accuracySum: number;
  joinedAt: number;
  /** 1-based; null for Vlados («вне конкурса»). */
  rank: number | null;
}

/** Score desc, correct count desc, total elapsed asc, joinedAt asc (id asc keeps it total). */
export function compareStandings(a: Standing, b: Standing): number {
  return (
    b.score - a.score ||
    b.correct - a.correct ||
    a.elapsedMs - b.elapsedMs ||
    a.joinedAt - b.joinedAt ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Every non-kicked player: ranked ones in rank order, then Vlados (rank null). */
export function computeStandings(rounds: readonly Round[], players: Readonly<Record<Id, Player>>, vladosId: Id | null): Standing[] {
  const scored = rounds.filter(isScored);
  const list: Standing[] = [];
  for (const p of Object.values(players)) {
    if (p.kicked) continue;
    const st: Standing = { id: p.id, score: 0, correct: 0, answered: 0, elapsedMs: 0, accuracySum: 0, joinedAt: p.joinedAt, rank: null };
    for (const r of scored) {
      const res = r.results?.[p.id];
      const a = r.answers[p.id];
      if (res && a) {
        st.score += res.points;
        st.accuracySum += res.accuracy;
        if (res.correct) st.correct++;
        st.answered++;
        st.elapsedMs += a.elapsedMs;
      } else {
        st.elapsedMs += r.q.timeLimitS * 1000;
      }
    }
    list.push(st);
  }
  const ranked = list.filter((s) => s.id !== vladosId).sort(compareStandings);
  ranked.forEach((s, i) => (s.rank = i + 1));
  return [...ranked, ...list.filter((s) => s.id === vladosId)];
}

export const standingsById = (list: readonly Standing[]): Map<Id, Standing> => new Map(list.map((s) => [s.id, s]));

export const scoredCount = (rounds: readonly Round[]): number => rounds.filter(isScored).length;

/** Index of the most recent scored round, -1 if none. */
export function lastScoredIndex(rounds: readonly Round[]): number {
  for (let i = rounds.length - 1; i >= 0; i--) if (isScored(rounds[i] as Round)) return i;
  return -1;
}

/** Standings as they were before round `index` (null when no earlier round was scored). */
export function standingsBefore(
  rounds: readonly Round[],
  index: number,
  players: Readonly<Record<Id, Player>>,
  vladosId: Id | null,
): Map<Id, Standing> | null {
  const earlier = index > 0 ? rounds.slice(0, index) : [];
  return earlier.some(isScored) ? standingsById(computeStandings(earlier, players, vladosId)) : null;
}

export const basicChip = (p: Player): PlayerChip => ({ id: p.id, name: p.name, seed: p.seed });

/**
 * Vlados's mean accuracy vs the mean accuracy of guests who answered at least half of the scored
 * rounds, and vs the best such guest. Unanswered rounds count as accuracy 0 for everyone.
 */
export function vladosComparison(
  rounds: readonly Round[],
  players: Readonly<Record<Id, Player>>,
  vladosId: Id | null,
  toChip: (p: Player) => PlayerChip = basicChip,
): VladosComparison | null {
  const vlados = vladosId ? players[vladosId] : undefined;
  if (!vlados || vlados.kicked) return null;
  const n = scoredCount(rounds);
  const mean = (s: Standing) => (n > 0 ? s.accuracySum / n : 0);
  const standings = computeStandings(rounds, players, vladosId);
  const guests = standings.filter((s) => s.rank !== null && s.answered * 2 >= n);
  const vSt = standings.find((s) => s.id === vladosId);
  const vladosAccuracy = vSt ? mean(vSt) : 0;
  const guestsAccuracy = guests.length > 0 ? guests.reduce((sum, s) => sum + mean(s), 0) / guests.length : 0;
  // Standings are in rank order, so the first guest with the top accuracy wins ties.
  let best: Standing | null = null;
  for (const g of guests) if (!best || mean(g) > mean(best)) best = g;
  const bestPlayer = best ? players[best.id] : undefined;
  const bestAcc = best ? mean(best) : 0;
  const verdict = !best || vladosAccuracy >= bestAcc ? 'best' : vladosAccuracy >= guestsAccuracy ? 'middle' : 'worst';
  return {
    player: toChip(vlados),
    vladosAccuracy,
    guestsAccuracy,
    bestGuest: bestPlayer ? { ...toChip(bestPlayer), accuracy: bestAcc } : null,
    verdict,
  };
}
