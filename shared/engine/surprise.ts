// The «Сюрприз» interrupt (organizer, 2026-09-25): on the last question («Кто лучше всех поздравил
// Владоса») — right while its options are on screen, strictly BEFORE everyone has answered and
// BEFORE the answer — the broadcast «breaks down» on the TV, the screen goes pure black for 2 s and
// a video plays (the built-in one: the congratulations from the party, app/public/surprise.mp4).
// When it ends, the question's normal reveal comes, and ~10 s later the final: after the video the
// quiz is over.
//
//   openAt ──answers──▶ S = min(endsAt, openAt + afterMs)
//          ──glitch (glitchMs)──▶ ──black (blackMs)──▶ videoAt ──video (ms)──▶ end ──▶ reveal ──toFinalMs──▶ final
//
// The stage is phase 'locked' of a round that carries `surprise` (Round.surprise, frozen when the
// round started): at S the engine locks the round with lockedAt = S and pulls endsAt in to S, so
// the rules refuse every answer that arrives more than answerLateMs after the interrupt (answers
// already on their way still count, with their own speed — scoring uses the time limit, not
// endsAt). The all-answered early lock is off for such a round: the video always comes first.
// Everything after S is derived from lockedAt, so a restarted host keeps the moment and a
// «стоп-экран» (its release shifts lockedAt) freezes and continues it: the video plays on from the
// same frame.
//
// The stage ends when the TV reports the video's end (event 'surpriseEnd', phaseRev-guarded, also
// the organizer's «Досмотрели — к ответу» / TV Space), or at the fallback videoAt + ms + tailMs —
// then the normal reveal of the question. From a surprise round's reveal the show goes straight to
// the final (no board, no further questions), toFinalMs later or on 'advance'.

import type { Id, Question, Round } from '../types';

export const SURPRISE = {
  /** app/public/surprise.mp4 (+ surprise-poster.jpg, its first frame): 576×1024, H.264 + AAC, 263.6 s. */
  builtin: { file: 'surprise.mp4', poster: 'surprise-poster.jpg', ms: 263_597, w: 576, h: 1024 },
  /** The TV's «сбой эфира» (the breakdown) before the black. */
  glitchMs: 2_600,
  /** Pure black, total silence, before the video. */
  blackMs: 2_000,
  /**
   * The stage ends at the latest this long after the video should have ended (a TV that never
   * reports it): generous, so a video that started a little late (buffering, a busy page) is never
   * cut before its last seconds — the TV reports its real end.
   */
  tailMs: 12_000,
  /** From a surprise round's reveal to the final. */
  toFinalMs: 10_000,
  /**
   * «Через сколько секунд после появления вариантов»: default (4 s, as the demo showed it —
   * organizer, 2026-09-26) and minimum. A question keeps its own value.
   */
  afterDefaultS: 4,
  afterMinS: 2,
  /** An uploaded video without a known length. */
  unknownMs: 5 * 60_000,
  /** Longest length trusted from the metadata. */
  maxMs: 15 * 60_000,
} as const;

/** What the stage needs to know about a media file (MediaAsset and the host's MediaInfo fit). */
export interface SurpriseMedia {
  kind: 'image' | 'video';
  durationS?: number;
}

type Media = Readonly<Record<Id, SurpriseMedia | undefined>>;

/** The uploaded video a question's surprise plays, or null: the built-in one. */
export function surpriseCustomId(s: Question['surprise'] | undefined, media: Media): Id | null {
  if (s?.src !== 'custom' || !s.mediaId) return null;
  return media[s.mediaId]?.kind === 'video' ? s.mediaId : null;
}

/** Length of an uploaded surprise video in ms from its metadata (unknownMs when it has none). */
export function surpriseMsOf(durationS: number | null | undefined): number {
  if (typeof durationS !== 'number' || !Number.isFinite(durationS) || durationS <= 0) return SURPRISE.unknownMs;
  return Math.min(SURPRISE.maxMs, Math.max(1_000, Math.round(durationS * 1000)));
}

/**
 * From openAt to the interrupt, ms: afterS (default 4 s) clamped to [2 s, time limit − 1 s] —
 * the options are always on screen for a moment, and the interrupt always comes before the time
 * runs out (the editor asks for the same).
 */
export function surpriseAfterMs(afterS: number | undefined, timeLimitS: number): number {
  const s = typeof afterS === 'number' && Number.isFinite(afterS) ? afterS : SURPRISE.afterDefaultS;
  const min = SURPRISE.afterMinS * 1000;
  const max = Math.max(min, Math.round(timeLimitS * 1000) - 1_000);
  return Math.min(max, Math.max(min, Math.round(s * 1000)));
}

/** The frozen surprise of a round starting with question `q` (null: not a surprise question). */
export function surpriseOf(q: Pick<Question, 'surprise' | 'timeLimitS'>, media: Media): NonNullable<Round['surprise']> | null {
  const s = q.surprise;
  if (!s?.on) return null;
  const custom = surpriseCustomId(s, media);
  const ms = custom ? surpriseMsOf(media[custom]?.durationS) : SURPRISE.builtin.ms;
  return { afterMs: surpriseAfterMs(s.afterS, q.timeLimitS), ms };
}

/** When the interrupt comes (server ms): whichever is first, openAt + afterMs or the end of the answer time. */
export const surpriseDueAt = (r: Pick<Round, 'openAt' | 'endsAt' | 'surprise'>): number | null =>
  r.surprise ? Math.min(r.endsAt, r.openAt + r.surprise.afterMs) : null;

/** The video starts this long after the interrupt (the breakdown, then the black). */
export const surpriseLeadMs = (): number => SURPRISE.glitchMs + SURPRISE.blackMs;

/** The latest the stage may last (from its start): lead + video + tail — the host reveals then. */
export const surpriseWindowMs = (ms: number): number => surpriseLeadMs() + ms + SURPRISE.tailMs;

/** The stage is on air: a surprise round locked by its interrupt. */
export const surpriseRunning = (s: { phase: string; rounds: readonly Round[]; cur: number }): boolean => {
  const r = s.rounds[s.cur];
  return s.phase === 'locked' && !!r?.surprise && r.lockedAt !== undefined;
};
