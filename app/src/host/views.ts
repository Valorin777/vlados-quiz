// View models for the screens (docs/firebase.md → view-model rule): screens render these as
// props and never touch Firestore. All builders are pure: (data, server now) → view, so Lab
// fixtures, screenshots and tests render exactly what the live game shows.
//
//   PlayerView ← public game doc + own player doc + my answers + clock      (phones)
//   TvView     ← + players, who answered, reactions, full reveal details    (TV)
//   AdminView  ← + live distribution, who has not answered, next question, rounds, lease/health

import { REACTIONS, defaultSettings, resolveTexts } from '@shared/defaults';
import type {
  BoardRow,
  FinalPub,
  FinalVlados,
  GameDoc,
  PlayerDoc,
  PodiumRow,
  PubInfo,
  PubMedia,
  RevealMe,
  RevealPub,
  RoundPub,
  ServerMs,
} from '@shared/fbtypes';
import { FINALE, finaleAutoAt, lastFinalStep } from '@shared/engine/finale';
import { autoHoldMs, autopilotOn } from '@shared/engine/showTimings';
import { SURPRISE, surpriseDueAt, surpriseLeadMs } from '@shared/engine/surprise';
import { WATCH } from '@shared/engine/watch';
import { correctOrder } from '@shared/scoring';
import type { AnswerPayload, Appearance, Id, PauseReason, Phase, Question, QuestionType, Settings, TextKey } from '@shared/types';
import { clamp } from '@shared/util';
import type { HostHealth, HostSnapshot, PrivResult, PrivRound } from './model';
import { REACTION_LIMITS, answerFits, hostContent, isHeld, numberDist, resultsOf, tvOnAir, type AnswerError, type HostCommandType } from './pure';

// ---------- Shared pieces ----------

export interface TimerView {
  /** 'intro': counting down to the opening; 'answer': to the end of the answer window. */
  kind: 'intro' | 'answer';
  /** Server time the countdown reaches zero (moves while paused). */
  endsAt: ServerMs;
  remainingMs: number;
  totalMs: number;
  /** 0 → 1 as the time runs out. */
  progress: number;
  paused: boolean;
}

/** The question on air, without its answer (RoundPub with the display number filled in). */
export type QuestionView = Omit<RoundPub, 'n'> & { n: number };

/**
 * The watch stage of a video question (phase 'intro', see shared/engine/watch.ts):
 * 'intro' the title splash before the video · 'play' the video runs on the TV (phones: «Смотри
 * видео на большом экране» + a progress bar, no timer, no options) · 'beat' the 3-2-1 before the
 * answers open («Варианты появятся через 3…2…1»).
 */
export interface WatchView {
  stage: 'intro' | 'play' | 'beat';
  /** Server time the TV starts the video (moves with pauses). */
  startAt: ServerMs;
  /** Where the video should be now, ms from its start (frozen while paused). */
  posMs: number;
  /** The watch window (video + tail), ms. */
  windowMs: number;
  /** The video's own length inside the window, ms (the window when unknown): the phones' progress bar. */
  videoMs: number;
  /** The video stage ends here at the latest (fallback); the answers open WATCH.beatMs later. */
  untilAt: ServerMs;
  /** Server time the answers open. */
  openAt: ServerMs;
}

export interface PauseView {
  reason: PauseReason;
  /** Frozen time left (of the intro in intro, of the answer window when open). */
  remainingMs: number;
}

/**
 * The organizer's «стоп-экран» (HostCommand 'hold'): the whole show stands still in any phase.
 * The TV shows only `text` (silence, no timer, no reactions); phones «Пауза — смотри на экран».
 * `pause` is set too (reason 'hold'), so every scene treats it as a pause.
 */
export interface HoldView {
  text: string;
  /** Server time the show stopped. */
  at: ServerMs;
}

/**
 * The video after the final (final step 6, shared/engine/finale.ts), by the server clock:
 * 'gather' the mosaic gathers into the mercury droplet until `startAt` · 'play' the video on the TV
 * (phones: «Смотри на экран»; ends at endAt + FINALE.tailMs) · 'after' the mosaic is back. The TV
 * plays its element to the end and uses `posMs` only to join mid-video after a reload.
 */
export interface FinaleView {
  stage: 'gather' | 'play' | 'after';
  /** Server time the video starts (moves with a hold). */
  startAt: ServerMs;
  /** Where the video should be now, ms (frozen while held). */
  posMs: number;
  videoMs: number;
  endAt: ServerMs;
  /** The uploaded video's media id; null: the built-in clip (app/public/finale.mp4). */
  videoId: Id | null;
  /** The uploaded video's poster (the built-in clip's is a file of the site). */
  posterId: Id | null;
  w: number;
  h: number;
}

export function finaleView(game: GameDoc | null | undefined, now: ServerMs): FinaleView | null {
  const v = game?.phase === 'final' && (game.final?.step ?? 0) >= FINALE.step ? game.final?.video : undefined;
  if (!game || !v) return null;
  const t = game.pause ? Math.min(now, game.pause.at) : now;
  const endAt = v.at + v.ms;
  const stage = t < v.at ? 'gather' : t < endAt + FINALE.tailMs ? 'play' : 'after';
  const custom = v.id ?? null;
  return {
    stage,
    startAt: v.at,
    posMs: clamp(t - v.at, 0, v.ms),
    videoMs: v.ms,
    endAt,
    videoId: custom,
    posterId: custom ? (v.poster ?? null) : null,
    w: v.w && v.h ? v.w : custom ? 16 : FINALE.builtin.w,
    h: v.w && v.h ? v.h : custom ? 9 : FINALE.builtin.h,
  };
}

/**
 * The «Сюрприз» interrupt on air (shared/engine/surprise.ts, `next.surprise` while the phase is
 * 'locked'), by the server clock: 'glitch' the TV's breakdown (phones: a short glitch of their own)
 * · 'black' pure black, silence · 'play' the video on the TV (phones: «Смотри на экран») · 'after'
 * it should have ended — the reveal is about to come. Frozen while the show is held.
 */
export interface SurpriseView {
  stage: 'glitch' | 'black' | 'play' | 'after';
  /** Server time the breakdown started. */
  at: ServerMs;
  /** Server time the video starts. */
  videoAt: ServerMs;
  /** Server time the video should end. */
  endAt: ServerMs;
  /** Where the stage is now, ms from `at` (frozen while held). */
  sinceMs: number;
  /** Where the video should be now, ms (frozen while held). */
  posMs: number;
  videoMs: number;
  /** The uploaded video's media id; null: the built-in one (app/public/surprise.mp4). */
  videoId: Id | null;
  posterId: Id | null;
  w: number;
  h: number;
}

export function surpriseView(game: GameDoc | null | undefined, now: ServerMs): SurpriseView | null {
  const sp = game?.phase === 'locked' ? game.next?.surprise : undefined;
  if (!game || !sp) return null;
  const t = game.pause ? Math.min(now, game.pause.at) : now;
  const videoAt = sp.at + surpriseLeadMs();
  const endAt = videoAt + sp.ms;
  const stage = t < sp.at + SURPRISE.glitchMs ? 'glitch' : t < videoAt ? 'black' : t < endAt + SURPRISE.tailMs ? 'play' : 'after';
  const custom = sp.id ?? null;
  return {
    stage,
    at: sp.at,
    videoAt,
    endAt,
    sinceMs: Math.max(0, t - sp.at),
    posMs: clamp(t - videoAt, 0, sp.ms),
    videoMs: sp.ms,
    videoId: custom,
    posterId: custom ? (sp.poster ?? null) : null,
    w: sp.w && sp.h ? sp.w : SURPRISE.builtin.w,
    h: sp.w && sp.h ? sp.h : SURPRISE.builtin.h,
  };
}

export const holdView = (game: GameDoc | null | undefined): HoldView | null =>
  game && isHeld(game) && game.pause ? { text: game.banner?.trim() ?? '', at: game.pause.at } : null;

const DEFAULT_TEXTS = resolveTexts(defaultSettings());

const textsOf = (pub: PubInfo | null | undefined): Record<TextKey, string> => ({ ...DEFAULT_TEXTS, ...(pub?.texts ?? {}) });

const ROUND_PHASES: ReadonlySet<Phase> = new Set<Phase>(['intro', 'open', 'locked', 'reveal', 'board']);

export function questionView(game: GameDoc | null): QuestionView | null {
  const r = game && ROUND_PHASES.has(game.phase) ? game.round : null;
  return r ? { ...r, n: r.n ?? r.i + 1 } : null;
}

/** The watch stage of the video question on air, or null (not a video round, or not in its intro). */
export function watchView(game: GameDoc | null, now: ServerMs): WatchView | null {
  const r = game?.round;
  const ms = r?.media?.watchMs;
  if (!game || !r || game.phase !== 'intro' || !ms || ms <= 0) return null;
  // While paused everything stands still at the pause (resume moves openAt, and the start with it).
  const t = game.pause ? Math.min(now, game.pause.at) : now;
  const untilAt = r.openAt - WATCH.beatMs;
  const startAt = untilAt - ms;
  const stage = t >= untilAt ? 'beat' : t >= startAt ? 'play' : 'intro';
  const v = r.media?.videoMs;
  const videoMs = typeof v === 'number' && v > 0 ? Math.min(v, ms) : ms;
  return { stage, startAt, posMs: clamp(t - startAt, 0, ms), windowMs: ms, videoMs, untilAt, openAt: r.openAt };
}

/**
 * Countdown of the intro / answer window, frozen while paused. A video question's intro counts
 * down to the video (splash), has no timer while the video plays, then counts the 3-2-1 beat.
 */
export function timerView(game: GameDoc | null, now: ServerMs): TimerView | null {
  const r = game?.round;
  if (!game || !r) return null;
  const p = game.pause ?? null;
  const progress = (remaining: number, total: number) => (total > 0 ? clamp(1 - remaining / total, 0, 1) : 1);
  if (game.phase === 'intro') {
    // pause.remainingMs counts down to endsAt; the intro part is what exceeds the answer window.
    const toOpen = p ? Math.max(0, p.remainingMs - (r.endsAt - r.openAt)) : Math.max(0, r.openAt - now);
    const w = watchView(game, now);
    let remaining = toOpen;
    let total = Math.max(0, r.openAt - r.introAt);
    if (w?.stage === 'play') return null;
    if (w?.stage === 'intro') {
      remaining = Math.max(0, toOpen - WATCH.beatMs - w.windowMs);
      total = Math.max(0, w.startAt - r.introAt);
    } else if (w?.stage === 'beat') total = WATCH.beatMs;
    return { kind: 'intro', endsAt: now + remaining, remainingMs: remaining, totalMs: total, progress: progress(remaining, total), paused: p !== null };
  }
  if (game.phase === 'open' || game.phase === 'locked') {
    if (p && game.phase === 'open') {
      // While paused the public endsAt is held open; the real total is elapsed-at-pause + remaining.
      const total = Math.max(0, p.at - r.openAt) + p.remainingMs;
      return { kind: 'answer', endsAt: now + p.remainingMs, remainingMs: p.remainingMs, totalMs: total, progress: progress(p.remainingMs, total), paused: true };
    }
    const total = Math.max(0, r.endsAt - r.openAt);
    const remaining = game.phase === 'locked' ? 0 : clamp(r.endsAt - now, 0, total);
    return { kind: 'answer', endsAt: r.endsAt, remainingMs: remaining, totalMs: total, progress: progress(remaining, total), paused: false };
  }
  return null;
}

const pauseView = (game: GameDoc | null, timer: TimerView | null, watch: WatchView | null): PauseView | null =>
  game?.pause ? { reason: game.pause.reason, remainingMs: timer?.remainingMs ?? (watch ? 0 : game.pause.remainingMs) } : null;

/**
 * Media the current question needs right now. Phones get an image only when it is shown on phones,
 * and for a video only its poster, whatever `onPhones` says: videos play ONLY on the TV, with
 * sound (organizer, 2026-09-23; 90 phones downloading it would also eat the egress budget). The TV
 * gets the question's media whatever `onPhones` says.
 */
function mediaNow(q: QuestionView | null, screen: 'phone' | 'tv'): Id[] {
  if (!q) return [];
  const ids = new Set<Id>();
  const m = q.media;
  if (m && m.kind === 'video') {
    if (screen === 'tv') ids.add(m.mediaId);
    if (m.posterId) ids.add(m.posterId);
  } else if (m && (screen === 'tv' || m.onPhones)) ids.add(m.mediaId);
  for (const it of [...(q.options ?? []), ...(q.items ?? [])]) if (it.mediaId) ids.add(it.mediaId);
  return [...ids];
}

// ---------- Player ----------

export interface MyAnswer {
  round: number;
  p: AnswerPayload;
  status: 'sending' | 'accepted' | 'rejected';
  error?: AnswerError;
}

/** What player.ts knows (PlayerSession.snapshot()). */
export interface PlayerViewInput {
  uid: string;
  gameId: string | null;
  game: GameDoc | null;
  /** 'missing': the game doc does not exist. */
  gameState: 'loading' | 'live' | 'cache' | 'missing' | 'error';
  /** Own player doc; null = not joined (once meLoaded). */
  me: PlayerDoc | null;
  meLoaded: boolean;
  answers: Readonly<Record<number, MyAnswer>>;
  /** Last total/rank this device saw (reveal.me or final.me). */
  lastScore: { i: number; tot: number; rank: number | null } | null;
  /** Server times of this device's recent reactions. */
  reactionsSent: readonly ServerMs[];
  /**
   * Round index (games/{g}.round.i) this device has already shown with its options open. The stage
   * of a round only moves forward on a phone: a server-clock estimate that steps back a little (a
   * better clock sample, the OS adjusting the time) right after openAt must not take the options
   * away again and replay their entrance (see phoneGame).
   */
  opened?: { gameId: string | null; i: number } | null;
}

export type PlayerScreen =
  | 'loading'
  | 'no_game'
  | 'join'
  | 'join_closed'
  | 'kicked'
  | 'lobby'
  | 'intro'
  | 'question'
  | 'answered'
  | 'time_up'
  | 'reveal'
  | 'board'
  | 'final';

export type Verdict = 'correct' | 'closest' | 'close' | 'wrong' | 'none';

export interface PlayerReveal {
  i: number;
  correct: RevealPub['correct'];
  dist: Record<string, number>;
  bin?: number;
  /** 0..1 */
  pct: number;
  count: number;
  /** undefined: no Vlados set; null: he did not answer. */
  vlados?: AnswerPayload | null;
  media?: PubMedia;
  text?: string;
  /** My line of reveal.me (null: joined after the round / Vlados-less entry). */
  mine: RevealMe | null;
  myAnswer: AnswerPayload | null;
  verdict: Verdict;
}

export interface PlayerView {
  screen: PlayerScreen;
  gameId: string | null;
  phase: Phase | null;
  phaseRev: number;
  now: ServerMs;
  /** false while the game doc comes from the offline cache. */
  online: boolean;
  pub: PubInfo | null;
  texts: Record<TextKey, string>;
  me: { uid: string; name: string; seed: number; avatar?: Uint8Array; thumb?: Uint8Array; isVlados: boolean } | null;
  kicked: boolean;
  question: QuestionView | null;
  /** Video question before its answers open: 'intro'/'play' → «смотри на экран», 'beat' → 3-2-1. */
  watch: WatchView | null;
  timer: TimerView | null;
  pause: PauseView | null;
  /** «Стоп-экран»: the screen underneath stays as it is (drafts kept) but answers and reactions are off. */
  hold: HoldView | null;
  /** My answer to the question on air. */
  answer: MyAnswer | null;
  canAnswer: boolean;
  /** `ranked`: guests in the ranking (everyone but Vlados, who plays out of competition). */
  counts: { answered: number; players: number; ranked?: number };
  reveal: PlayerReveal | null;
  board: { top: BoardRow[]; mine: RevealMe | null } | null;
  final: (FinalPub & { mine: { tot: number; rank: number | null } | null }) | null;
  /** The video after the final (TV only — the phone shows «Смотри на экран» and its poster). */
  finale: Omit<FinaleView, 'videoId'> | null;
  /**
   * The «Сюрприз» interrupt (TV only plays the video): a short glitch, black, then «Смотри на
   * экран» over the question's screen; answering is off (the phase is 'locked').
   */
  surprise: Omit<SurpriseView, 'videoId' | 'posterId'> | null;
  /** Last known total and rank (null before the first reveal). */
  score: { tot: number; rank: number | null } | null;
  /** Media ids to load now (question on air) and to prefetch (next question). */
  media: Id[];
  prefetch: Id[];
  reactions: { enabled: boolean; cooldownMs: number };
}

function verdictOf(mine: RevealMe | null, answered: boolean): Verdict {
  if (!mine || !answered) return 'none';
  if (mine.cl) return 'closest';
  if (mine.ok) return 'correct';
  if ((mine.acc ?? 0) >= 0.5) return 'close';
  return 'wrong';
}

function reactionCooldown(sent: readonly ServerMs[], now: ServerMs): number {
  const last = sent.length ? (sent[sent.length - 1] as number) : -Infinity;
  let wait = Math.max(0, last + REACTION_LIMITS.minGapMs - now);
  const recent = sent.filter((t) => now - t < 60_000);
  if (recent.length >= REACTION_LIMITS.perMinute) wait = Math.max(wait, (recent[0] as number) + 60_000 - now);
  return wait;
}

/**
 * The game as a phone plays it: the host switches intro → open at openAt, but a late host (a hidden
 * admin tab as the only host, a TV that lost its connection) must not keep the guests from
 * answering. Phones open by the clock — the options and the full timer appear exactly at openAt —
 * and the rules accept answers from then on (firestore.rules → windowOpen). Not while paused.
 */
export function phoneGame(game: GameDoc | null, now: ServerMs, openedI: number | null = null): GameDoc | null {
  const r = game?.round;
  if (!game || !r || game.phase !== 'intro' || game.pause) return game;
  // Once open on this device, a clock that steps back by less than OPEN_LATCH_MS keeps it open.
  const at = openedI === r.i ? r.openAt - OPEN_LATCH_MS : r.openAt;
  if (now < at) return game;
  return { ...game, phase: 'open' };
}

/** How far back a phone's clock may step after openAt without closing the options again. */
export const OPEN_LATCH_MS = 1_500;

export function buildPlayerView(inp: PlayerViewInput, now: ServerMs): PlayerView {
  const game = phoneGame(inp.game, now, inp.opened && inp.opened.gameId === inp.gameId ? inp.opened.i : null);
  const phase = game?.phase ?? null;
  const joined = inp.me !== null;
  const kicked = inp.me?.kicked === true || (game?.kicked?.includes(inp.uid) ?? false);
  const question = questionView(game);
  const timer = timerView(game, now);
  const watch = watchView(game, now);
  const answer = question ? (inp.answers[question.i] ?? null) : null;
  const isVlados = game?.vladosUid === inp.uid;

  const hold = holdView(game);
  const fin = finaleView(game, now);
  const phoneFinale = fin ? (({ videoId: _v, ...rest }) => rest)(fin) : null;
  const sv = surpriseView(game, now);
  const phoneSurprise = sv ? (({ videoId: _v, posterId: _p, ...rest }) => rest)(sv) : null;
  const open = phase === 'open' && (!!game?.pause || (timer?.remainingMs ?? 0) > 0);
  // the screen stays the question under the «стоп-экран»; only sending is off
  const canAnswerNow = joined && !kicked && open && (answer === null || answer.status === 'rejected');
  const canAnswer = canAnswerNow && hold === null;

  let reveal: PlayerReveal | null = null;
  const rv = game?.reveal;
  if (rv && (phase === 'reveal' || phase === 'board')) {
    const mine = rv.me[inp.uid] ?? null;
    const my = inp.answers[rv.i];
    const myAnswer = my && my.status !== 'rejected' ? my.p : null;
    reveal = {
      i: rv.i,
      correct: rv.correct,
      dist: rv.dist,
      pct: rv.pct,
      count: rv.count ?? Object.values(rv.dist).reduce((a, b) => a + b, 0),
      mine,
      myAnswer,
      // Answered on another device (or before a reload): reveal.me still knows.
      verdict: verdictOf(mine, myAnswer !== null || (mine !== null && (mine.pts > 0 || mine.ok))),
    };
    if (rv.bin !== undefined) reveal.bin = rv.bin;
    if (rv.vlados !== undefined) reveal.vlados = rv.vlados;
    if (rv.media) reveal.media = rv.media;
    if (rv.text !== undefined) reveal.text = rv.text;
  }

  const final = phase === 'final' && game?.final ? { ...game.final, mine: game.final.me?.[inp.uid] ?? null } : null;
  const fromReveal = rv?.me[inp.uid];
  const score = final?.mine
    ? { tot: final.mine.tot, rank: final.mine.rank }
    : fromReveal && (phase === 'reveal' || phase === 'board')
      ? { tot: fromReveal.tot, rank: fromReveal.rank }
      : inp.lastScore
        ? { tot: inp.lastScore.tot, rank: inp.lastScore.rank }
        : null;

  let screen: PlayerScreen;
  if (inp.gameState === 'missing') screen = 'no_game';
  else if (!game || !inp.meLoaded) screen = 'loading';
  else if (kicked) screen = 'kicked';
  else if (!joined) screen = phase === 'final' || (phase !== 'lobby' && game.pub?.lateJoin === false) ? 'join_closed' : 'join';
  else if (phase === 'lobby') screen = 'lobby';
  else if (phase === 'intro') screen = 'intro';
  else if (phase === 'open' || phase === 'locked') {
    if (answer && answer.status !== 'rejected') screen = 'answered';
    else screen = canAnswerNow ? 'question' : 'time_up';
  } else screen = phase as 'reveal' | 'board' | 'final';

  const me = inp.me
    ? {
        uid: inp.uid,
        name: inp.me.name,
        seed: inp.me.seed,
        isVlados,
        ...(inp.me.avatar ? { avatar: inp.me.avatar } : {}),
        ...(inp.me.thumb ? { thumb: inp.me.thumb } : {}),
      }
    : null;

  return {
    screen,
    gameId: inp.gameId,
    phase,
    phaseRev: game?.phaseRev ?? 0,
    now,
    online: inp.gameState === 'live',
    pub: game?.pub ?? null,
    texts: textsOf(game?.pub),
    me,
    kicked,
    question,
    watch,
    timer,
    pause: pauseView(game, timer, watch),
    hold,
    answer,
    canAnswer,
    counts: { answered: game?.answered ?? 0, players: game?.players ?? 0, ranked: Math.max(0, (game?.players ?? 0) - (game?.vladosUid ? 1 : 0)) },
    reveal,
    board: phase === 'board' && game?.board ? { top: game.board.top, mine: rv?.me[inp.uid] ?? null } : null,
    final,
    finale: phoneFinale,
    surprise: phoneSurprise,
    score,
    media: phase === 'intro' || phase === 'open' ? mediaNow(question, 'phone') : phoneFinale?.posterId ? [phoneFinale.posterId] : [],
    prefetch: game?.next?.media ?? [],
    reactions: {
      // (nobody sees them during the «Сюрприз»: the TV plays the video)
      enabled: (game?.pub?.reactions ?? false) && joined && !kicked && phase !== null && hold === null && phoneSurprise === null,
      cooldownMs: reactionCooldown(inp.reactionsSent, now),
    },
  };
}

// ---------- TV ----------

export interface TvPlayer {
  uid: string;
  name: string;
  seed: number;
  avatar?: Uint8Array;
  thumb?: Uint8Array;
  joinedAt: ServerMs;
  /** Answered the question on air. */
  answered: boolean;
  isVlados: boolean;
  kicked: boolean;
}

export interface TvAnswer {
  uid: string;
  name: string;
  p: AnswerPayload;
  /** Scoring time, ms. */
  e: number;
  pts: number;
  ok: boolean;
  isVlados: boolean;
}

export interface TvReaction {
  id: string;
  uid: string;
  name: string;
  e: number;
  emoji: string;
  at: ServerMs;
}

export interface TvView {
  gameId: string;
  phase: Phase | null;
  phaseRev: number;
  now: ServerMs;
  online: boolean;
  pub: PubInfo | null;
  texts: Record<TextKey, string>;
  question: QuestionView | null;
  /** Video question before its answers open (the TV plays the video in stage 'play'). */
  watch: WatchView | null;
  timer: TimerView | null;
  pause: PauseView | null;
  /** «Стоп-экран»: the TV shows only this text, silent and still (the scene waits underneath). */
  hold: HoldView | null;
  /** Players still in the game, in join order. */
  players: TvPlayer[];
  /** Live counts (not the throttled public ones). */
  counts: { players: number; answered: number };
  answeredIds: string[];
  /** Public reveal plus every counted answer (fastest first). */
  reveal: (RevealPub & { answers: TvAnswer[] }) | null;
  /** Top 10 with previous ranks. */
  board: BoardRow[] | null;
  /** Final screen; `mosaic` (everyone) from step 5. */
  final: (FinalPub & { mosaic: TvPlayer[] | null }) | null;
  /** The video after the final (step 6). */
  finale: FinaleView | null;
  /** The «Сюрприз» interrupt on air: breakdown, black, the video (the TV plays it). */
  surprise: SurpriseView | null;
  /** Reactions of the last minute, oldest first. */
  reactions: TvReaction[];
  banner: string | null;
  vladosUid: string | null;
  appearance: Appearance;
  sound: Settings['sound'];
  media: Id[];
  prefetch: Id[];
}

function tvPlayers(s: HostSnapshot, answered: ReadonlySet<string>): TvPlayer[] {
  const kicked = new Set(s.game?.kicked ?? []);
  return Object.entries(s.players)
    .map(([uid, p]): TvPlayer => {
      const row: TvPlayer = {
        uid,
        name: p.name,
        seed: p.seed,
        joinedAt: p.joinedAt,
        answered: answered.has(uid),
        isVlados: s.game?.vladosUid === uid,
        kicked: p.kicked || kicked.has(uid),
      };
      if (p.avatar) row.avatar = p.avatar;
      if (p.thumb) row.thumb = p.thumb;
      return row;
    })
    .sort((a, b) => a.joinedAt - b.joinedAt || (a.uid < b.uid ? -1 : 1));
}

/** Uids that answered the round on air (players still in the game only). */
function answeredSet(s: HostSnapshot): Set<string> {
  const i = s.game?.round?.i;
  const kicked = new Set(s.game?.kicked ?? []);
  const out = new Set<string>();
  if (i === undefined || s.answersRound !== i || !s.game || !ROUND_PHASES.has(s.game.phase)) return out;
  // Same filter as the host's count: a payload that does not fit the question is not an answer.
  const q = privRound(s, i)?.q;
  for (const a of s.answers) {
    if (a.round === i && s.players[a.uid] && !s.players[a.uid]?.kicked && !kicked.has(a.uid) && (!q || answerFits(q, a.p))) out.add(a.uid);
  }
  return out;
}

const privRound = (s: HostSnapshot, i: number | undefined): PrivRound | undefined =>
  i === undefined ? undefined : s.totals?.rounds.find((r) => r.i === i);

function tvAnswers(s: HostSnapshot, res: Readonly<Record<string, PrivResult>>): TvAnswer[] {
  return Object.entries(res)
    .map(([uid, x]) => ({ uid, name: s.players[uid]?.name ?? '', p: x.p, e: x.e, pts: x.pt, ok: x.ok, isVlados: s.game?.vladosUid === uid }))
    .sort((a, b) => a.e - b.e || (a.uid < b.uid ? -1 : 1));
}

export function buildTvView(s: HostSnapshot, now: ServerMs): TvView {
  const game = s.game;
  const phase = game?.phase ?? null;
  const settings = hostContent(s.content).settings;
  const answered = answeredSet(s);
  const all = tvPlayers(s, answered);
  const players = all.filter((p) => !p.kicked);
  const question = questionView(game);
  const timer = timerView(game, now);
  const watch = watchView(game, now);
  const finale = finaleView(game, now);
  const surprise = surpriseView(game, now);
  const rv = game?.reveal && (phase === 'reveal' || phase === 'board') ? game.reveal : null;
  const pr = rv ? privRound(s, rv.i) : undefined;
  const res = pr?.res ? resultsOf(pr) : undefined;
  const cutoff = now - 60_000;
  return {
    gameId: s.gameId,
    phase,
    phaseRev: game?.phaseRev ?? 0,
    now,
    online: s.health.listeners.game === 'live',
    pub: game?.pub ?? null,
    texts: textsOf(game?.pub),
    question,
    watch,
    timer,
    pause: pauseView(game, timer, watch),
    hold: holdView(game),
    players,
    counts: { players: players.length, answered: answered.size },
    answeredIds: [...answered],
    reveal: rv ? { ...rv, answers: res ? tvAnswers(s, res) : [] } : null,
    board: phase === 'board' ? (game?.board?.top ?? null) : null,
    final: phase === 'final' && game?.final ? { ...game.final, mosaic: game.final.step >= 5 ? players : null } : null,
    finale,
    surprise,
    reactions: s.reactions
      .filter((r) => r.at > cutoff)
      .map((r) => ({ id: r.id, uid: r.uid, name: s.players[r.uid]?.name ?? '', e: r.e, emoji: REACTIONS[r.e] ?? '', at: r.at })),
    banner: game?.banner ?? null,
    vladosUid: game?.vladosUid ?? null,
    appearance: settings.tvAppearance,
    sound: { ...settings.sound },
    media: finale
      ? ([finale.videoId, finale.posterId].filter((x) => x !== null) as Id[])
      : surprise?.videoId
        ? ([surprise.videoId, surprise.posterId].filter((x) => x !== null) as Id[])
        : mediaNow(question, 'tv'),
    prefetch: game?.next?.media ?? [],
  };
}

// ---------- Admin ----------

export type CorrectView =
  | { t: 'choice'; id: Id; text?: string }
  | { t: 'number'; v: number; tolerance: number; unit?: string }
  | { t: 'ordering'; ids: Id[] };

export type LiveDist =
  | { t: 'choice'; counts: Record<Id, number>; correctId: Id; total: number }
  | { t: 'number'; values: number[]; median: number | null; answer: number; dist: Record<string, number>; bin?: number; total: number }
  | { t: 'ordering'; exact: number; positionHits: number[]; total: number };

export interface AdminRound {
  i: number;
  /** Display number (skipped rounds have none). */
  n: number | null;
  qid: Id;
  title: string;
  type: QuestionType;
  skipped: boolean;
  revealed: boolean;
  answered: number;
}

export interface AdminQuestion {
  qid: Id;
  title: string;
  type: QuestionType;
  disabled: boolean;
  /** Has a round (skipped ones included). */
  played: boolean;
  /** Has a scored round: jumpTo refuses it. */
  scored: boolean;
}

export interface LeaseView {
  holder: { session: string; label: string; preferred: boolean; uid: string } | null;
  until: ServerMs | null;
  expiresInMs: number | null;
  /** This page holds the lease. */
  mine: boolean;
}

export interface AdminView extends TvView {
  /** Every player, kicked ones included. */
  allPlayers: TvPlayer[];
  /** Players still in the game that have not answered the open question. */
  notAnswered: TvPlayer[];
  /** The correct answer of the question on air (admins only). */
  correct: CorrectView | null;
  /** Answers so far, before the reveal (guests only; Vlados separately). */
  liveDist: LiveDist | null;
  vladosAnswer: AnswerPayload | null;
  next: { qid: Id; title: string; type: QuestionType } | null;
  rounds: AdminRound[];
  questions: AdminQuestion[];
  lease: LeaseView;
  /**
   * A TV page is on air (holds the lease). Without one nobody plays a question's video — phones
   * never do — and a video round starts with the short fallback (video + 1 s).
   */
  tvOnAir: boolean;
  health: HostHealth;
  /** Which commands make sense right now (buttons). */
  can: Record<HostCommandType, boolean>;
  /** The final's last step: 6 with the video after the final, 5 without (Settings.finaleVideo). */
  finalLast: number;
  /**
   * The mosaic («С днём рождения, Владос!», final step 5) with the video after the final on: the
   * host starts the video step by itself FINALE.autoMs after the mosaic came on — «Видео через N с»
   * (N = ceil(ms / 1000)). `ms` counts down with the clock; while the «стоп-экран» is on it stands
   * still (`held`, `at` null) and continues after the release. Null otherwise (another step, video
   * off). «▶ Финальное видео» still starts it earlier.
   */
  finaleVideoIn: FinaleCountdown | null;
  /**
   * The open question is a «Сюрприз» one: when the host interrupts it (the admin's countdown «видео
   * через N с»). `at` null while paused/held (frozen `ms`). Null otherwise — and on the phones and
   * the TV's public data nothing says it before it happens.
   */
  surpriseIn: { ms: number; at: ServerMs | null } | null;
  /** The reveal of a «Сюрприз» round: the final comes next (by itself ~10 s later), not the board. */
  revealToFinal: boolean;
  /** «Автопилот» (shared/engine/showTimings.ts): on or off, and what the host does next by itself. */
  autopilot: AutopilotView;
}

/**
 * The next step the host takes by itself out of the answer, the board or the final — «Таблица через
 * 6 с», «Вопрос 4 через 3 с», «3-е место через 4 с». 'board': the table; 'question': question `n`;
 * 'final': the final (after the last question's board, or a «Сюрприз» reveal); 'step': final step
 * `n` (1 3rd place, 2 2nd, 3 1st, 4 Vlados, 5 the mosaic, 6 the video after the final).
 */
export interface AutoStep {
  kind: 'board' | 'question' | 'final' | 'step';
  n: number | null;
  /** Time left (≥ 0; 0: due, the host is about to). */
  ms: number;
  /** Server time it is due; null while the «стоп-экран» holds it (`ms` frozen, continues after). */
  at: ServerMs | null;
  held: boolean;
}

export interface AutopilotView {
  /** Settings.autopilot (older settings without it: on). */
  on: boolean;
  /**
   * The timed step out of reveal / board / final: the autopilot's — or, switched off, an autoAdvance
   * number's, the final after a «Сюрприз», the video 5 s after the mosaic. Null: only the button.
   */
  next: AutoStep | null;
}

/**
 * The admin's view of the autopilot (AdminView.autopilot): the same hold the host's nextDeadline()
 * uses (autoHoldMs, from the stored phaseAt), so the countdown is the moment the host moves.
 * `nextN`: the number of the question the board goes on to (null: none left — the final).
 */
export function autopilotView(s: Pick<HostSnapshot, 'game' | 'totals' | 'content'>, now: ServerMs, nextN: number | null): AutopilotView {
  const settings = hostContent(s.content).settings;
  const on = autopilotOn(settings);
  const g = s.game;
  if (!g || !s.totals || (g.phase !== 'reveal' && g.phase !== 'board' && g.phase !== 'final')) return { on, next: null };
  const step = g.final?.step ?? 0;
  const pr = g.phase === 'final' ? undefined : privRound(s as HostSnapshot, g.round?.i);
  const hold = autoHoldMs({ phase: g.phase, finalStep: step }, pr, settings);
  if (hold === null) return { on, next: null };
  const what: Pick<AutoStep, 'kind' | 'n'> =
    g.phase === 'reveal'
      ? pr?.surprise
        ? { kind: 'final', n: null }
        : { kind: 'board', n: null }
      : g.phase === 'board'
        ? nextN !== null
          ? { kind: 'question', n: nextN }
          : { kind: 'final', n: null }
        : { kind: 'step', n: step + 1 };
  const at = s.totals.phaseAt + hold;
  if (g.pause) return { on, next: { ...what, ms: Math.max(0, at - g.pause.at), at: null, held: true } };
  return { on, next: { ...what, ms: Math.max(0, at - now), at, held: false } };
}

export interface FinaleCountdown {
  /** Time left until the host starts the video step (≥ 0; 0: due, the host is about to). */
  ms: number;
  /** Server time it is due; null while held (the countdown is frozen). */
  at: ServerMs | null;
  held: boolean;
}

/** The host's own countdown from the mosaic to the video after the final (see AdminView.finaleVideoIn). */
export function finaleCountdown(s: Pick<HostSnapshot, 'game' | 'totals' | 'content'>, now: ServerMs): FinaleCountdown | null {
  const g = s.game;
  if (!g || !s.totals) return null;
  const at = finaleAutoAt({ phase: g.phase, finalStep: g.final?.step ?? 0, phaseAt: s.totals.phaseAt }, hostContent(s.content).settings);
  if (at === null) return null;
  if (g.pause) return { ms: Math.max(0, at - g.pause.at), at: null, held: true };
  return { ms: Math.max(0, at - now), at, held: false };
}

/** The admin's countdown to the «Сюрприз» of the question on air (see AdminView.surpriseIn). */
export function surpriseCountdown(s: Pick<HostSnapshot, 'game' | 'totals'>, now: ServerMs): { ms: number; at: ServerMs | null } | null {
  const g = s.game;
  const r = g?.round ? privRound(s as HostSnapshot, g.round.i) : undefined;
  if (!g || !r?.surprise || (g.phase !== 'intro' && g.phase !== 'open')) return null;
  const at = surpriseDueAt(r);
  if (at === null) return null;
  if (g.pause) return { ms: Math.max(0, at - g.pause.at), at: null };
  return { ms: Math.max(0, at - now), at };
}

function correctView(q: Question): CorrectView {
  switch (q.type) {
    case 'choice': {
      const text = q.options.find((o) => o.id === q.correctId)?.text;
      return { t: 'choice', id: q.correctId, ...(text !== undefined ? { text } : {}) };
    }
    case 'number':
      return { t: 'number', v: q.answer, tolerance: q.tolerance, ...(q.unit !== undefined ? { unit: q.unit } : {}) };
    case 'ordering':
      return { t: 'ordering', ids: correctOrder(q) };
  }
}

const medianOf = (sorted: readonly number[]): number | null => {
  if (!sorted.length) return null;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[m] as number) : ((sorted[m - 1] as number) + (sorted[m] as number)) / 2;
};

function liveDist(q: Question, answers: readonly { p: AnswerPayload }[]): LiveDist {
  switch (q.type) {
    case 'choice': {
      const counts: Record<Id, number> = Object.fromEntries(q.options.map((o) => [o.id, 0]));
      for (const a of answers) if (a.p.t === 'choice' && a.p.id in counts) counts[a.p.id] = (counts[a.p.id] ?? 0) + 1;
      return { t: 'choice', counts, correctId: q.correctId, total: answers.length };
    }
    case 'number': {
      const values = answers.flatMap((a) => (a.p.t === 'number' && Number.isFinite(a.p.v) ? [a.p.v] : [])).sort((a, b) => a - b);
      const { dist, bin } = numberDist(values, q.step);
      return { t: 'number', values, median: medianOf(values), answer: q.answer, dist, ...(bin !== undefined ? { bin } : {}), total: answers.length };
    }
    case 'ordering': {
      const correct = correctOrder(q);
      const positionHits = correct.map(() => 0);
      let exact = 0;
      for (const a of answers) {
        if (a.p.t !== 'ordering') continue;
        const ids = a.p.ids;
        if (ids.length === correct.length && ids.every((id, k) => id === correct[k])) exact++;
        correct.forEach((id, k) => {
          if (ids[k] === id) positionHits[k] = (positionHits[k] ?? 0) + 1;
        });
      }
      return { t: 'ordering', exact, positionHits, total: answers.length };
    }
  }
}

function canMap(s: HostSnapshot, next: AdminView['next'], watch: WatchView | null): Record<HostCommandType, boolean> {
  const g = s.game;
  const phase = g?.phase;
  const paused = !!g?.pause;
  // «стоп-экран»: nothing moves the show on until it is released (the engine refuses it too)
  const held = isHeld(g);
  const scored = s.totals?.rounds.some((r) => r.res && !r.skipped) ?? false;
  return {
    start: phase === 'lobby' && next !== null && !held,
    advance: (phase === 'reveal' || phase === 'board' || (phase === 'final' && (g?.final?.step ?? 0) < lastFinalStep(hostContent(s.content).settings))) && !held,
    reveal: (phase === 'open' || phase === 'locked') && !held,
    skip: (phase === 'intro' || phase === 'open' || phase === 'locked') && !held,
    pause: (phase === 'intro' || phase === 'open') && !paused,
    resume: paused,
    addTime: (phase === 'intro' || phase === 'open') && !held,
    jumpTo: g !== null && !held,
    end: g !== null && phase !== 'final' && !held,
    resetScores: g !== null && !held,
    newGame: g !== null,
    rescoreRound: scored,
    kick: g !== null,
    unkick: g !== null,
    rename: g !== null,
    setVlados: g !== null,
    banner: g !== null,
    hold: g !== null,
    unhold: held,
    watchEnd: watch !== null && watch.stage !== 'beat' && !paused,
    surpriseEnd: phase === 'locked' && !!g?.next?.surprise && !paused,
    // the TV's own report of the reveal video's end (no button)
    revealMediaEnd: phase === 'reveal' && g?.reveal?.media?.kind === 'video' && !paused,
  };
}

export function buildAdminView(s: HostSnapshot, now: ServerMs): AdminView {
  const tv = buildTvView(s, now);
  const game = s.game;
  const content = hostContent(s.content);
  const answered = new Set(tv.answeredIds);
  const all = tvPlayers(s, answered);
  const live = game && (game.phase === 'open' || game.phase === 'locked');
  const current = privRound(s, game?.round?.i);
  const vlados = game?.vladosUid ?? null;
  // `answered` holds the players still in the game who answered the round on air.
  const guestAnswers = current && live ? s.answers.filter((a) => a.round === current.i && answered.has(a.uid) && a.uid !== vlados) : [];
  const vladosLive = current && vlados ? s.answers.find((a) => a.round === current.i && a.uid === vlados) : undefined;

  const rounds = s.totals?.rounds ?? [];
  const played = new Set(rounds.map((r) => r.qid));
  const scoredQids = new Set(rounds.filter((r) => r.res && !r.skipped).map((r) => r.qid));
  const nextQ = content.questions.find((q) => !q.disabled && !played.has(q.id)) ?? null;
  const next = nextQ ? { qid: nextQ.id, title: nextQ.title, type: nextQ.type } : null;
  let n = 0;
  const adminRounds = rounds.map((r): AdminRound => {
    const shown = r.skipped ? null : ++n;
    const count = r.res ? Object.keys(r.res).length : r.i === game?.round?.i ? answered.size : 0;
    return { i: r.i, n: shown, qid: r.qid, title: r.q.title, type: r.q.type, skipped: r.skipped === true, revealed: !!r.res, answered: count };
  });
  const lease = s.lease;
  return {
    ...tv,
    allPlayers: all,
    notAnswered: live ? tv.players.filter((p) => !answered.has(p.uid)) : [],
    correct: current && game && ROUND_PHASES.has(game.phase) ? correctView(current.q) : null,
    liveDist: current && live ? liveDist(current.q, guestAnswers) : null,
    vladosAnswer: vladosLive?.p ?? null,
    next,
    rounds: adminRounds,
    questions: content.questions.map((q) => ({
      qid: q.id,
      title: q.title,
      type: q.type,
      disabled: q.disabled === true,
      played: played.has(q.id),
      scored: scoredQids.has(q.id),
    })),
    lease: {
      holder: lease ? { session: lease.session, label: lease.label, preferred: lease.preferred, uid: lease.uid } : null,
      until: lease?.until ?? null,
      expiresInMs: lease ? lease.until - now : null,
      mine: lease?.session === s.session && lease.until > now,
    },
    tvOnAir: tvOnAir(lease, now),
    health: s.health,
    can: canMap(s, next, tv.watch),
    finalLast: lastFinalStep(content.settings),
    finaleVideoIn: finaleCountdown(s, now),
    surpriseIn: surpriseCountdown(s, now),
    revealToFinal: game?.phase === 'reveal' && !!current?.surprise,
    // `n` = the rounds played so far (not skipped): the board goes on to question n + 1
    autopilot: autopilotView(s, now, next ? n + 1 : null),
  };
}

/** Name of a reaction index (for screens that show text). */
export const reactionEmoji = (e: number): string => REACTIONS[e] ?? '';

export type { FinalVlados, PodiumRow };
