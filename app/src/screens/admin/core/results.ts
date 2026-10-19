// Standings and per-question statistics for «Итоги» (pure: built from the Host snapshot with the
// same engine functions the game uses, so the numbers match the TV exactly).

import { computeStandings } from '@shared/engine/results';
import type { HostSnapshot, PrivRound } from '../../../host';
import { resultsOf, toEngineState } from '../../../host/pure';

export interface StandingRow {
  uid: string;
  name: string;
  score: number;
  correct: number;
  answered: number;
  /** null: Vlados («вне конкурса») */
  rank: number | null;
  isVlados: boolean;
  /** Points per scored round, keyed by round index i. */
  perRound: Record<number, number>;
}

export interface RoundStat {
  i: number;
  /** Display number (null: skipped). */
  n: number | null;
  qid: string;
  title: string;
  type: PrivRound['q']['type'];
  skipped: boolean;
  revealed: boolean;
  answered: number;
  correct: number;
  /** 0..1 among guests who answered */
  correctPct: number;
  avgPoints: number;
  /** Fastest correct answer, ms */
  fastestMs: number | null;
  fastestName: string | null;
}

export function standings(s: HostSnapshot): StandingRow[] {
  if (!s.game) return [];
  const state = toEngineState({ gameId: s.gameId, game: s.game, totals: s.totals, players: s.players, answers: [] });
  const vlados = state.vladosId;
  const rounds = s.totals?.rounds ?? [];
  const per: Record<string, Record<number, number>> = {};
  for (const r of rounds) {
    if (!r.res || r.skipped) continue;
    for (const [uid, x] of Object.entries(resultsOf(r))) (per[uid] ??= {})[r.i] = x.pt;
  }
  return computeStandings(state.rounds, state.players, vlados).map((st) => ({
    uid: st.id,
    name: s.players[st.id]?.name ?? '—',
    score: st.score,
    correct: st.correct,
    answered: st.answered,
    rank: st.rank,
    isVlados: st.id === vlados,
    perRound: per[st.id] ?? {},
  }));
}

export function roundStats(s: HostSnapshot): RoundStat[] {
  const vlados = s.game?.vladosUid ?? null;
  let n = 0;
  return (s.totals?.rounds ?? []).map((r) => {
    const res = Object.entries(resultsOf(r)).filter(([uid]) => uid !== vlados);
    const correct = res.filter(([, x]) => x.ok);
    const fastest = correct.sort((a, b) => a[1].e - b[1].e)[0];
    return {
      i: r.i,
      n: r.skipped ? null : ++n,
      qid: r.qid,
      title: r.q.title,
      type: r.q.type,
      skipped: r.skipped === true,
      revealed: !!r.res,
      answered: res.length,
      correct: correct.length,
      correctPct: res.length ? correct.length / res.length : 0,
      avgPoints: res.length ? Math.round(res.reduce((a, [, x]) => a + x.pt, 0) / res.length) : 0,
      fastestMs: fastest ? fastest[1].e : null,
      fastestName: fastest ? (s.players[fastest[0]]?.name ?? null) : null,
    };
  });
}

const csvCell = (v: string | number): string => {
  const t = String(v);
  return /[;"\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

/** Excel-friendly CSV: UTF-8 BOM, `;` separators (Russian locale), CRLF. */
export function standingsCsv(rows: readonly StandingRow[], rounds: readonly RoundStat[]): string {
  const scored = rounds.filter((r) => r.revealed && !r.skipped);
  const head = ['Место', 'Имя', 'Очки', 'Верных', 'Ответов', ...scored.map((r) => `В${r.n}: ${r.title}`)];
  const lines = [head, ...rows.map((r) => [r.rank ?? 'вне конкурса', r.name, r.score, r.correct, r.answered, ...scored.map((q) => r.perRound[q.i] ?? '')])];
  return '\uFEFF' + lines.map((l) => l.map(csvCell).join(';')).join('\r\n') + '\r\n';
}
