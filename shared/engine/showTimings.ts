// «Автопилот» (organizer, 2026-09-26: «всё должно быть автоматизировано, чтобы я мог просто
// контролировать; тайминг точно такой, как в демке»): the host itself moves the show on from the
// answer to the board, to the next question and through the whole final, with exactly the pace of
// «Прогнать игру» (app/src/host/rehearsal.ts plays through the same function). The organizer only
// presses «Начать игру»; the big button of «Эфир» shows what comes next and when, and pressing it
// just does that step now.
//
// ONE source of truth for the show's pace — the live host (nextDeadline → the lease holder's tick)
// and the rehearsal simulator use it both:
//
//   question  intro (Settings.introMs) → answers (the timer / everybody answered) → lock
//             (lockMs + the host's grace) → the answer (reveal)                    — the engine
//   reveal    SHOW.revealMs, longer with a text / a photo / a video (revealHoldMs, frozen when the
//             round starts: Round.revealHoldMs; a video: 2 s after the TV reported its end,
//             Round.revealEndMs, the clock hold as the fallback)                  ──▶ board
//   board     SHOW.boardMs                                                          ──▶ next question / final
//   final     drumroll → 3rd → 2nd → 1st → Vlados → mosaic: SHOW.finalStepMs[step]
//             mosaic → the video after the final: FINALE.autoMs (always, engine/finale.ts)
//   «Сюрприз» its reveal → the final: SURPRISE.toFinalMs (always, engine/surprise.ts)
//
// Every hold counts from the stored phaseAt, so a restarted host or a page that took the lease over
// keeps the moment (late: at once, once — phaseRev-guarded transactions), and a «стоп-экран» (its
// release shifts phaseAt) freezes the countdown and continues it with the time it had left.
// Settings.autopilot: undefined (every settings doc written before it existed) = ON; false = the
// organizer moves every step himself (and the optional Settings.autoAdvance numbers apply).

import type { Id, Phase, Question, Round, Settings } from '../types';
import { FINALE, lastFinalStep } from './finale';
import { SURPRISE } from './surprise';

export const SHOW = {
  /** The answer on screen (no text, no picture). */
  revealMs: 9_000,
  /** … with the text after the answer (it comes ~7 s in, after the room's numbers): time to read it. */
  revealTextMs: 12_000,
  /** … with a photo (it flies in ~10 s in, after the numbers). */
  revealPictureMs: 16_000,
  /** … with a video: it starts ~9 s in (after the right answer lights up) and plays to its end. */
  revealVideoLeadMs: 9_000,
  /** … and the board comes this long after the video should have ended. */
  revealVideoTailMs: 4_000,
  /**
   * … or this long after the TV reported the video's end ('revealMediaEnd'), whichever is first —
   * never before revealMs.
   */
  revealVideoEndedMs: 2_000,
  /** A reveal video without a known length. */
  revealVideoUnknownMs: 30_000,
  /** Longest reveal video trusted from the metadata. */
  revealVideoMaxMs: 10 * 60_000,
  /** The board («Кто лидирует»), then the next question's intro (or the final). */
  boardMs: 7_000,
  /**
   * The final, per step on screen → the next one: 0 the drumroll → 3rd place, 1 → 2nd, 2 → 1st,
   * 3 → Vlados vs friends, 4 → the mosaic «С днём рождения». The mosaic (5) goes on to the video
   * after the final FINALE.autoMs later (or is the last step when the video is off).
   */
  finalStepMs: [4_000, 4_500, 4_500, 7_000, 9_000] as readonly number[],
} as const;

/** The autopilot is on: true unless the organizer switched it off (undefined — older settings — is on). */
export const autopilotOn = (s: Partial<Settings> | null | undefined): boolean => s?.autopilot !== false;

/** What the reveal hold needs to know about a media file (MediaAsset and the host's MediaInfo fit). */
export interface ShowMedia {
  kind: 'image' | 'video';
  durationS?: number;
}

/**
 * How long the answer of `q` stays on screen before the board (ms from the reveal): long enough for
 * its text, its photo, its whole video. Frozen into the round when it starts (Round.revealHoldMs),
 * so a host that restarts mid-reveal (the media index still loading) keeps the same moment. A
 * reveal media that is not resolved is not shown at all (the reveal's base time then).
 */
export function revealHoldMs(q: Pick<Question, 'revealText' | 'revealMedia'>, media: Readonly<Record<Id, ShowMedia | undefined>>): number {
  const rm = q.revealMedia;
  const m = rm ? media[rm.mediaId] : undefined;
  if (rm && m?.kind === 'video') {
    const d = m.durationS;
    const ms = typeof d === 'number' && Number.isFinite(d) && d > 0 ? Math.max(1_000, (d - Math.max(0, rm.startAtS ?? 0)) * 1000) : SHOW.revealVideoUnknownMs;
    return Math.max(SHOW.revealMs, Math.round(SHOW.revealVideoLeadMs + Math.min(ms, SHOW.revealVideoMaxMs) + SHOW.revealVideoTailMs));
  }
  if (rm && m?.kind === 'image') return SHOW.revealPictureMs;
  return q.revealText?.trim() ? SHOW.revealTextMs : SHOW.revealMs;
}

/**
 * The autopilot's hold out of a reveal (ms after phaseAt): the frozen hold (`holdMs`) — or, once
 * the TV reported the reveal video's end `endMs` after the reveal began, SHOW.revealVideoEndedMs
 * after that, but never before the plain SHOW.revealMs and never after the frozen hold (the clock
 * stays the fallback: a TV that reports late or never changes nothing).
 */
export function revealAfterEndMs(holdMs: number, endMs: number | undefined): number {
  if (typeof endMs !== 'number' || !Number.isFinite(endMs)) return holdMs;
  return Math.min(holdMs, Math.max(SHOW.revealMs, Math.round(endMs) + SHOW.revealVideoEndedMs));
}

/** How long final step `step` stays before the next one (autopilot). */
export const finalStepHoldMs = (step: number): number => SHOW.finalStepMs[Math.max(0, Math.min(step, SHOW.finalStepMs.length - 1))] as number;

type HoldSettings = Pick<Settings, 'autoAdvance'> & Partial<Pick<Settings, 'finaleVideo' | 'autopilot'>>;

/**
 * The timed step out of the answer, the board or the final: ms after phaseAt, or null when only a
 * command moves the show on (the autopilot is off and no autoAdvance number is set, the last final
 * step, the lobby and the question phases — their timers are the engine's). The same for the host
 * (nextDeadline) and the organizer's countdown («Таблица через 6 с»).
 */
export function autoHoldMs(
  s: { phase: Phase; finalStep: number },
  round: Pick<Round, 'surprise' | 'revealHoldMs' | 'revealEndMs' | 'q'> | undefined,
  settings: HoldSettings,
): number | null {
  const on = autopilotOn(settings);
  const sec = (x: number | null | undefined): number | null => (typeof x === 'number' ? x * 1000 : null);
  switch (s.phase) {
    case 'reveal':
      // after a «Сюрприз» round the quiz is over: the final comes by itself (autopilot or not)
      if (round?.surprise) return SURPRISE.toFinalMs;
      // a reveal video: 2 s after the TV reported its end (the clock hold is the fallback)
      if (on) return revealAfterEndMs(round?.revealHoldMs ?? (round ? revealHoldMs(round.q, {}) : SHOW.revealMs), round?.revealEndMs);
      return sec(settings.autoAdvance.revealToBoardS);
    case 'board':
      return on ? SHOW.boardMs : sec(settings.autoAdvance.boardToNextS);
    case 'final':
      // the video after the final (engine/finale.ts) is the last step: its end moves nothing
      if (s.finalStep >= lastFinalStep(settings)) return null;
      // the mosaic → the video: exactly FINALE.autoMs after the mosaic came on (autopilot or not)
      if (s.finalStep === FINALE.step - 1) return FINALE.autoMs;
      return on ? finalStepHoldMs(s.finalStep) : sec(settings.autoAdvance.finalStepS);
    default:
      return null;
  }
}
