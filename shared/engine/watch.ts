// The «watch» stage of a question whose main media is a video: the TV plays the video with sound
// and the answer timer starts only after it ended (organizer: guests used to see «не успел» right
// after a long video, because the timer ran while it played). Videos play ONLY on the TV (organizer,
// 2026-09-23): phones never play them — they show «Смотри видео на большом экране» with a progress
// bar, then «Варианты появятся через 3…2…1», then the options with the full timer.
//
//   introAt ──intro──▶ startAt ──video on the TV──▶ end ──3-2-1──▶ openAt ──answers──▶ endsAt
//
// The stage lives inside phase 'intro' (answers are refused until openAt − 500 ms by the rules and
// by phase): a video round simply starts with openAt = introAt + introMs + window + beat, where the
// window is the video's length plus a tail — the fallback when nobody reports the end. When the
// TV reports 'ended' (or the organizer says «досмотрели»), the engine pulls openAt in to
// now + beat (event 'watchEnd'). The start of the video is always openAt − beat − window, so a
// pause (resume shifts openAt/endsAt) moves it too.
//
// The tail depends on whether a TV is on air when the round starts (the host passes it, see
// app/src/host): a TV reports the end itself, so its tail only covers a TV that never does (5 s);
// without a TV nobody reports it and nobody sees the video either — the answers open 1 s after the
// video would have ended.

import type { Id, Question } from '../types';

export const WATCH = {
  /** The 3-2-1 between the end of the video and the opening of the answers. */
  beatMs: 3_000,
  /** Fallback with a TV on air: the watch stage ends this long after the video should have ended. */
  tailMs: 5_000,
  /** Fallback without a TV (nobody reports the end): right after the video's length. */
  soloTailMs: 1_000,
  /** Window when the video's duration is unknown (older uploads, a failed probe). */
  unknownMs: 180_000,
  /** … and without a TV (nobody sees it; the organizer can still say «досмотрели»). */
  soloUnknownMs: 30_000,
  /** Longest window trusted from the metadata (a broken duration must not freeze the game). */
  maxMs: 15 * 60_000,
} as const;

/** What the watch stage needs to know about a media file (MediaAsset and the host's MediaInfo fit). */
export interface WatchMedia {
  kind: 'image' | 'video';
  durationS?: number;
  status?: string;
}

/**
 * Length of the video part of `q`'s watch stage in ms (from `startAtS` to the end): null when the
 * question's main media is not a (ready) video, undefined when its duration is unknown.
 */
export function watchVideoMs(q: Pick<Question, 'media'>, media: Readonly<Record<Id, WatchMedia | undefined>>): number | null | undefined {
  const qm = q.media;
  const m = qm ? media[qm.mediaId] : undefined;
  if (!qm || !m || m.kind !== 'video' || (m.status !== undefined && m.status !== 'ready')) return null;
  const d = m.durationS;
  if (typeof d !== 'number' || !Number.isFinite(d) || d <= 0) return undefined;
  return Math.min(WATCH.maxMs, Math.round(Math.max(0, d - Math.max(0, qm.startAtS ?? 0)) * 1000));
}

/**
 * Length of the watch window of `q` in ms (video from `startAtS` to its end + tail), or 0 when the
 * question's main media is not a (ready) video. `media` is keyed by media id; `tv` = a TV is on air
 * (it plays the video and reports its end) — without one the fallback is short.
 */
export function watchWindowMs(q: Pick<Question, 'media'>, media: Readonly<Record<Id, WatchMedia | undefined>>, tv = true): number {
  const v = watchVideoMs(q, media);
  if (v === null) return 0;
  if (v === undefined) return tv ? WATCH.unknownMs : WATCH.soloUnknownMs;
  return Math.min(WATCH.maxMs, v + (tv ? WATCH.tailMs : WATCH.soloTailMs));
}

/** Answers open this long after the round's intro starts (intro + watch window + beat). */
export const openDelayMs = (introMs: number, windowMs: number): number => introMs + (windowMs > 0 ? windowMs + WATCH.beatMs : 0);
