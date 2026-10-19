// The video after the final (organizer, 2026-09-23: after the final and the winners, play the video
// from the party folder — beautifully, with its own soundtrack). One more final step after the
// selfie mosaic:
//
//   step 5  mosaic + «С днём рождения, Владос!»
//     ──by itself exactly autoMs (5 s) after step 5 began (whatever autoAdvance says), or earlier
//       by advance (the organizer's «▶ Финальное видео» / TV Space)──▶
//   step 6  the mosaic gathers into a mercury droplet (leadMs) → the video plays on the TV with its
//           own sound (ms) → the mosaic and «С днём рождения» come back with confetti
//
// Step 6 is the last one: nothing moves the game on after it. The TV follows its <video> element
// ('ended'); the phones follow the clock (they never play it): «Смотри на экран» from the step's start until
// at + ms + tailMs, then their final screen again. `at` is the step's start + leadMs, so the hold
// («стоп-экран» shifts phaseAt when released) moves it with the video, which stood still meanwhile.
//
// Settings.finaleVideo: 'builtin' — the clip that ships with the site (app/public/finale.mp4, the
// organizer's video, byte-identical to assets/finale-original.mp4), 'custom' — an uploaded video
// (Settings.finaleMediaId; the built-in one when it is missing), 'off' — the final ends at step 5.

import { LIMITS } from '../defaults';
import type { Id, Phase, Settings } from '../types';

export const FINALE = {
  /** The final step that plays the video (the one after the mosaic). */
  step: LIMITS.finalSteps + 1,
  /** app/public/finale.mp4 (+ finale-poster.jpg, its first frame): 464×848, H.264 + AAC, 14.93 s. */
  builtin: { file: 'finale.mp4', poster: 'finale-poster.jpg', ms: 14_933, w: 464, h: 848 },
  /**
   * Organizer, 2026-09-23: the video starts exactly 5 s after «С днём рождения, Владос!» appears,
   * only on the TV. The host moves the mosaic (step 5) on to the video step this long after step 5
   * began — a timed transition of its own, whatever autoAdvance.finalStepS says; «▶ Финальное
   * видео» / TV Space can start it earlier. See finaleAutoAt().
   */
  autoMs: 5_000,
  /** From the step's start: the mosaic gathers into the droplet and opens into the frame. */
  leadMs: 2_800,
  /** Phones go back to their final screen this long after the video should have ended. */
  tailMs: 1_500,
  /** An uploaded video without a known length (older upload, failed probe). */
  unknownMs: 60_000,
  /** Longest length trusted from the metadata. */
  maxMs: 10 * 60_000,
} as const;

type FinaleSettings = Partial<Pick<Settings, 'finaleVideo' | 'finaleMediaId'>> | null | undefined;

/** The final has the video step (anything but 'off'; older settings without the field: built-in). */
export const finaleOn = (s: FinaleSettings): boolean => (s?.finaleVideo ?? 'builtin') !== 'off';

/** The last final step: 6 with the video after the final, 5 without. */
export const lastFinalStep = (s: FinaleSettings): number => (finaleOn(s) ? FINALE.step : LIMITS.finalSteps);

/**
 * When the host itself moves the mosaic on to the video after the final: step 5's start + autoMs;
 * null in any other step or when the video is off («Не показывать»). Derived from stored state
 * (phaseAt), so a restarted host or a page that took the lease over keeps the same moment, and a
 * «стоп-экран» (released: phaseAt moves by its length) continues the countdown with the time it had
 * left. The pause itself is nextDeadline()'s business (null while stopped).
 */
export function finaleAutoAt(s: { phase: Phase; finalStep: number; phaseAt: number }, settings: FinaleSettings): number | null {
  return s.phase === 'final' && s.finalStep === FINALE.step - 1 && finaleOn(settings) ? s.phaseAt + FINALE.autoMs : null;
}

/** The uploaded video to play ('custom' with a file), or null: the built-in clip (or none when off). */
export const finaleCustomId = (s: FinaleSettings): Id | null => (s?.finaleVideo === 'custom' && s.finaleMediaId ? s.finaleMediaId : null);

/** Length of an uploaded finale video in ms from its metadata (unknownMs when it has none). */
export function finaleMsOf(durationS: number | null | undefined): number {
  if (typeof durationS !== 'number' || !Number.isFinite(durationS) || durationS <= 0) return FINALE.unknownMs;
  return Math.min(FINALE.maxMs, Math.max(1_000, Math.round(durationS * 1000)));
}
