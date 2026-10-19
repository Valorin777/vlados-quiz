// Host-side data that is not part of the public game doc (docs/firebase.md → Host).
//
// games/{g}/private/totals (admin-only) is the host's durable memory: every round with its frozen
// question (correct answer included), timing, pause history and, once revealed, every counted
// answer with its frozen result. Together with games/{g} it is enough for a restarted host (or
// another admin page) to continue the game exactly where it was.
//
// games/{g}/private/host is the lease. It lives here and not in the public doc because it is
// renewed every few seconds, and every write to games/{g} is a read for every phone.

import type { AdminContentDoc, AnswerDoc, GameDoc, PlayerDoc, ReactionDoc, ServerMs } from '@shared/fbtypes';
import type { AnswerPayload, Id, Question, RoundSurprise } from '@shared/types';

/** Timing constants of the host (server milliseconds). */
export const HOST_TIMING = {
  /** Lease while a timed transition is pending (intro/open/locked, auto-advance). */
  leaseTtlMs: 15_000,
  leaseRenewMs: 5_000,
  /**
   * Lease while nothing is scheduled (lobby, waiting for the organizer). Slower renewals keep a TV
   * that is left open for a day far below the 20k writes/day limit.
   */
  idleLeaseTtlMs: 30_000,
  idleLeaseRenewMs: 20_000,
  /** The public `answered` count is pushed at most this often while a question is open (floor of pure.answeredPushGapMs). */
  answeredPushMs: 5_000,
  /** A changed player count alone is pushed at most this often (floor of pure.playersPushGapMs; every write costs each phone a read). */
  playersPushMs: 15_000,
  /** pub/next refreshes (settings edited, fresh lobby) at most this often. */
  refreshMs: 10_000,
  /**
   * Extra wait between the lock and the reveal. The rules accept answers until endsAt + 2 s; the
   * grace lets the last ones reach the host's listener before results are frozen.
   */
  revealGraceMs: 2_000,
  /** While an open question is paused the public endsAt is pushed this far out so answers stay accepted. */
  pauseHoldMs: 30 * 60_000,
  /** Safety tick of the driver loop. */
  loopMs: 1_000,
} as const;

/** Private doc names under games/{g}/private. */
export const PRIVATE_TOTALS = 'totals';
export const PRIVATE_LEASE = 'host';

/** A pause that ended: [s, e) in server ms, and how far it moved openAt/endsAt (0 if cleared by a lock/skip). */
export interface PauseRec {
  s: ServerMs;
  e: ServerMs;
  sh: number;
}

/** One counted answer with its frozen result (decoded form; stored as a PrivResultRow). */
export interface PrivResult {
  p: AnswerPayload;
  /** Server receive time of the answer. */
  at: ServerMs;
  /** Elapsed ms used for scoring (server time, pauses excluded, clamped to [0, T]). */
  e: number;
  /** Points. */
  pt: number;
  /** Accuracy 0..1. */
  ac: number;
  ok: boolean;
  cl?: boolean;
}

export interface PrivRound {
  /** Public round index (answer ids are `{i}_{uid}`). */
  i: number;
  qid: Id;
  /** Frozen copy of the question, WITH the correct answer. */
  q: Question;
  /** Ordering: the shared shuffled order. */
  shown?: Id[];
  introAt: ServerMs;
  openAt: ServerMs;
  /** The real end of the answer window (the public one is pushed out while paused). */
  endsAt: ServerMs;
  lockedAt?: ServerMs;
  revealedAt?: ServerMs;
  skipped?: boolean;
  /**
   * Video question: the watch stage's window (video + tail, ms), frozen when the round started,
   * and the video's own length (`videoMs`, from startAtS; absent when unknown). The video starts at
   * openAt − WATCH.beatMs − ms until the watch ends (shared/engine/watch.ts).
   */
  watch?: { ms: number; videoMs?: number };
  /**
   * A «Сюрприз» round (shared/engine/surprise.ts), frozen when it started: the interrupt comes
   * afterMs after openAt, the video is ms long. The stage runs from lockedAt.
   */
  surprise?: RoundSurprise;
  /**
   * «Автопилот»: how long the answer stays before the board (ms from the reveal), frozen when the
   * round started — only for a reveal with a photo / video (shared/engine/showTimings.ts).
   */
  revealHoldMs?: number;
  /** The TV reported the end of the reveal video this long after the reveal began (Round.revealEndMs). */
  revealEndMs?: number;
  pauses?: PauseRec[];
  /** Set once revealed: every counted answer (non-kicked players) with its result (see resultsOf()). */
  res?: Record<string, PrivResultRow>;
}

/**
 * How a result is stored: [points, accuracy, correct 0|1, closest 1|0|-1 (not a number question),
 * elapsed ms, answer server time, payload as JSON]. This doc holds every answer of the game, and
 * arrays keep it far below Firestore's 20,000-fields-per-document limit (maps would not).
 */
export type PrivResultRow = [pt: number, ac: number, ok: 0 | 1, cl: -1 | 0 | 1, e: number, at: ServerMs, p: string];

/** games/{g}/private/totals */
export interface TotalsDoc {
  v: 1;
  /** Bumped on every write. */
  rev: number;
  /** When the current phase started (auto-advance timers count from here). */
  phaseAt: ServerMs;
  /** Public index of rounds[0]; resetScores moves it on so answer ids are never reused. */
  iBase: number;
  rounds: PrivRound[];
  updatedAt: ServerMs;
}

/** games/{g}/private/host */
export interface LeaseDoc {
  session: string;
  until: ServerMs;
  /** e.g. 'tv', 'admin', 'bot'. */
  label: string;
  /** The TV: takes the lease over from a non-preferred holder. */
  preferred: boolean;
  uid: string;
  /** Last renewal (server ms). */
  at: ServerMs;
}

/** What the host needs to know about a media file to publish it (from media/{id}). */
export interface MediaInfo {
  kind: 'image' | 'video';
  posterId?: Id;
  /** Video length (media meta); drives the watch stage's fallback. */
  durationS?: number;
  /** Pixel size (media meta): screens reserve the frame before the file is decoded. */
  w?: number;
  h?: number;
}
export type MediaIndex = Readonly<Record<Id, MediaInfo>>;

/** Everything the pure host functions read (a consistent snapshot of the listeners). */
export interface HostInput {
  gameId: string;
  game: GameDoc;
  totals: TotalsDoc | null;
  players: Readonly<Record<string, PlayerDoc>>;
  /** Answers of the round on air (game.round.i); answers of other rounds are ignored. */
  answers: readonly AnswerDoc[];
}

/** The host's live model: what views are built from. */
export interface HostSnapshot extends Omit<HostInput, 'game'> {
  game: GameDoc | null;
  content: AdminContentDoc | null;
  media: MediaIndex;
  lease: LeaseDoc | null;
  /** Round the `answers` listener is attached to (null when none). */
  answersRound: number | null;
  /** Recent reactions, oldest first. */
  reactions: readonly (ReactionDoc & { id: string })[];
  session: string;
  label: string;
  health: HostHealth;
}

export type ListenerState = 'loading' | 'live' | 'cache' | 'error';

export interface HostHealth {
  /** Per listener: live = in sync with the server, cache = offline copy. */
  listeners: Record<'game' | 'totals' | 'lease' | 'players' | 'answers' | 'content' | 'reactions', ListenerState>;
  clock: { offsetMs: number; rttMs: number | null; syncedAt: number | null };
  /** This page holds the lease and runs the timed transitions. */
  leader: boolean;
  lastTickAt: ServerMs | null;
  lastWriteAt: ServerMs | null;
  lastError: { at: ServerMs; msg: string } | null;
  /** Transactions waiting in this page's queue. */
  pending: number;
  /** e.g. media of the next question that could not be resolved. */
  warnings: string[];
}
