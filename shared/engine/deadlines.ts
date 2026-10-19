// When the next timed transition is due (docs/architecture.md → State machine).
// The server keeps one timer to nextDeadline() plus a 1 s safety tick; reduce() uses the same
// function to decide whether a tick is due, so both always agree.

import { LIMITS } from '../defaults';
import type { GameState, Player, Settings } from '../types';
import { autoHoldMs } from './showTimings';
import { surpriseDueAt, surpriseWindowMs } from './surprise';

/** Active = not kicked and online, or seen within the last 15 s. */
export const isActive = (p: Player, now: number): boolean =>
  !p.kicked && (p.online || now - p.lastSeen <= LIMITS.activeWindowMs);

/**
 * Time at which an open round locks early because every active player (Vlados included) has
 * answered, or null. An offline player stops counting at lastSeen + 15 s, so the result does
 * not depend on "now": it is max(last answer, each offline straggler's inactive time) + delay.
 * Needs at least one answer so that an empty or fully disconnected room never auto-locks.
 */
export function allAnsweredAt(state: GameState, settings: Pick<Settings, 'allAnsweredDelayMs'>): number | null {
  if (state.phase !== 'open' || state.pause) return null;
  const round = state.rounds[state.cur];
  if (!round) return null;
  let last = Number.NEGATIVE_INFINITY;
  let any = false;
  for (const p of Object.values(state.players)) {
    if (p.kicked) continue;
    const a = round.answers[p.id];
    if (a) {
      any = true;
      last = Math.max(last, a.at);
    } else if (p.online) {
      return null;
    } else {
      last = Math.max(last, p.lastSeen + LIMITS.activeWindowMs);
    }
  }
  return any ? last + settings.allAnsweredDelayMs : null;
}

type DeadlineSettings = Pick<Settings, 'allAnsweredDelayMs' | 'lockMs' | 'autoAdvance'> & Partial<Pick<Settings, 'finaleVideo' | 'autopilot'>>;

/** Absolute time of the next automatic transition, or null when only a command can move the game. */
export function nextDeadline(state: GameState, settings: DeadlineSettings): number | null {
  if (state.pause) return null;
  const round = state.rounds[state.cur];
  switch (state.phase) {
    case 'lobby':
      return null;
    case 'intro':
      return round ? round.openAt : null;
    case 'open': {
      if (!round) return null;
      // a «Сюрприз» round: the interrupt, never an early lock (the video comes before the answer)
      const sp = surpriseDueAt(round);
      if (sp !== null) return sp;
      const all = allAnsweredAt(state, settings);
      return all === null ? round.endsAt : Math.min(round.endsAt, all);
    }
    case 'locked':
      if (round?.lockedAt === undefined) return null;
      // the «Сюрприз» stage: the fallback if the TV never reports the end of the video
      return round.surprise ? round.lockedAt + surpriseWindowMs(round.surprise.ms) : round.lockedAt + settings.lockMs;
    case 'reveal':
    case 'board':
    case 'final': {
      // «Автопилот» (engine/showTimings.ts): answer → board → next question → every final step with
      // the rehearsal's pace. Always, autopilot or not: a «Сюрприз» reveal → the final after
      // SURPRISE.toFinalMs, the mosaic → the video after the final after FINALE.autoMs; the video
      // step is the last one.
      const ms = autoHoldMs(state, round, settings);
      return ms === null ? null : state.phaseAt + ms;
    }
  }
}
