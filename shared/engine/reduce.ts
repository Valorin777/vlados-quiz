// The game state machine (docs/architecture.md → State machine).
//
// reduce() is pure: it never mutates its input, reads no clock and draws no randomness (ids,
// tokens, codes and seeds arrive inside events). It returns the next state plus effects, which the
// server executes IN ORDER: save → ack → side effects → broadcast → schedule, so that an answer is
// acknowledged only after it is on disk. Overdue deadlines are applied before and after every event,
// so a late timer can never let an answer slip in after the reveal.

import { LIMITS } from '../defaults';
import type {
  AdminCmd,
  AnswerErr,
  AnswerOk,
  AvatarErr,
  AvatarOk,
  CmdErr,
  JoinErr,
  JoinOk,
  RecoverErr,
  Result,
  SettingsPatch,
} from '../protocol';
import { correctOrder, effectiveElapsed, isPermutation, timeLimitMs } from '../scoring';
import type { AnswerPayload, Content, GameState, Id, Phase, Player, Question, Round, Settings } from '../types';
import { hashSeed, nameKey, normalizeName } from '../util';
import { nextDeadline } from './deadlines';
import { lastFinalStep } from './finale';
import { computeRoundResults, isScored } from './results';
import { avatarPath, nextQuestion, roundSeed, shownOrder } from './select';
import { revealHoldMs } from './showTimings';
import { surpriseOf, surpriseRunning } from './surprise';
import { WATCH, openDelayMs, watchWindowMs } from './watch';

// ---------- Events & effects ----------

export type EngineEvent =
  | {
      t: 'cmd';
      cmd: AdminCmd;
      /** Who sent it (for logs). */
      by?: string;
      /** newGame only: id of the new game; derived from the old one when absent. */
      gameId?: Id;
    }
  /** Timer or 1 s safety tick: applies every overdue deadline. */
  | { t: 'tick' }
  /** Server start with a loaded snapshot (crash resume). */
  | { t: 'boot' }
  | { t: 'join'; id: Id; token: string; code: string; seed: number; name: string; avatar?: string; bot?: boolean }
  | { t: 'recover'; name: string; code: string }
  | { t: 'answer'; playerId: Id; round: number; p: AnswerPayload; elapsedMs: number; cid: string }
  | { t: 'presence'; playerId: Id; online: boolean }
  /** A new selfie file was stored for the player. */
  | { t: 'avatar'; playerId: Id; file: string }
  /**
   * The question's video has been watched (the TV reports 'ended', or the organizer says so):
   * the answers open after the 3-2-1 beat instead of at the fallback (see ./watch.ts).
   */
  | { t: 'watchEnd'; phaseRev: number }
  /**
   * The «Сюрприз» video has been watched (the TV reports 'ended', or the organizer says so): the
   * question's reveal comes now instead of at the fallback (see ./surprise.ts).
   */
  | { t: 'surpriseEnd'; phaseRev: number }
  /**
   * The reveal video has been watched (the TV reports 'ended'): the «Автопилот» moves on to the
   * board shortly after it instead of at the clock hold (see ./showTimings.ts → Round.revealEndMs).
   */
  | { t: 'revealMediaEnd'; phaseRev: number };

export type ViewName = 'pub' | 'tv' | 'admin';

export type EngineAck =
  | Result<{ phaseRev: number }, CmdErr>
  | Result<JoinOk, JoinErr>
  | Result<JoinOk, RecoverErr>
  | Result<AnswerOk, AnswerErr>
  | Result<AvatarOk, AvatarErr>;

export type Effect =
  | { k: 'save' }
  | { k: 'ack'; res: EngineAck }
  /** Rebuild and send these views; `me` = players whose MeView changed. */
  | { k: 'broadcast'; views: ViewName[]; me: Id[] | 'all' }
  /** Re-arm the single game timer (null = no deadline, keep only the safety tick). */
  | { k: 'schedule'; at: number | null }
  /** For the batched `answered` event to TV and admin. */
  | { k: 'answered'; id: Id }
  /** Tell the player's sockets they were kicked. */
  | { k: 'kick'; id: Id }
  | { k: 'deleteAvatar'; file: string }
  /** Apply to content settings (the engine does not own content). */
  | { k: 'settings'; patch: SettingsPatch }
  | { k: 'openTv' }
  | { k: 'bots'; n: number }
  /** Player `from` was folded into `into`; re-identify `from`'s sockets. */
  | { k: 'merged'; from: Id; into: Id }
  /** All players were wiped; sockets must rejoin. */
  | { k: 'newGame'; gameId: Id };

export interface ReduceResult {
  state: GameState;
  effects: Effect[];
}

export const initialState = (gameId: Id, now: number): GameState => ({
  gameId,
  rev: 0,
  phase: 'lobby',
  phaseRev: 0,
  phaseAt: now,
  players: {},
  vladosId: null,
  rounds: [],
  cur: -1,
  pause: null,
  finalStep: 0,
  tvBanner: null,
  savedAt: 0,
});

// ---------- Transaction ----------

const ALL_VIEWS: ViewName[] = ['pub', 'tv', 'admin'];

/** Collects the draft state and effects of one reduce() call. */
class Tx {
  private draft: GameState | null = null;
  private save = false;
  private views = new Set<ViewName>();
  private me: Set<Id> | 'all' = new Set();
  private ack: EngineAck | null = null;
  private side: Effect[] = [];
  alwaysSchedule = false;

  constructor(
    readonly orig: GameState,
    readonly now: number,
    readonly content: Content,
  ) {}

  get settings(): Settings {
    return this.content.settings;
  }

  /** Current state, for reading only. Mutate through w(). */
  get s(): GameState {
    return this.draft ?? this.orig;
  }

  /** Mutable draft (deep copy on first use). */
  w(): GameState {
    return (this.draft ??= structuredClone(this.orig));
  }

  persist(): void {
    this.save = true;
  }

  show(views: readonly ViewName[], me: readonly Id[] | 'all' = []): void {
    for (const v of views) this.views.add(v);
    if (me === 'all') this.me = 'all';
    else if (this.me !== 'all') for (const id of me) this.me.add(id);
  }

  /** Saved, and every view rebuilt. */
  everything(): void {
    this.persist();
    this.show(ALL_VIEWS, 'all');
  }

  reply(res: EngineAck): void {
    this.ack = res;
  }

  emit(e: Effect): void {
    this.side.push(e);
  }

  finish(): ReduceResult {
    const effects: Effect[] = [];
    if (this.draft) {
      this.draft.rev = this.orig.rev + 1;
      if (this.save) effects.push({ k: 'save' });
    }
    if (this.ack) effects.push({ k: 'ack', res: this.ack });
    effects.push(...this.side);
    if (this.draft) {
      const me = this.me === 'all' ? 'all' : [...this.me];
      if (this.views.size > 0 || me.length > 0) effects.push({ k: 'broadcast', views: ALL_VIEWS.filter((v) => this.views.has(v)), me });
    }
    const state = this.draft ?? this.orig;
    if (this.draft || this.alwaysSchedule) effects.push({ k: 'schedule', at: nextDeadline(state, this.settings) });
    return { state, effects };
  }
}

// ---------- Entry point ----------

export function reduce(state: GameState, event: EngineEvent, now: number, content: Content): ReduceResult {
  const tx = new Tx(state, now, content);
  if (event.t !== 'boot') catchUp(tx);
  switch (event.t) {
    case 'tick':
      tx.alwaysSchedule = true;
      break;
    case 'boot':
      onBoot(tx);
      break;
    case 'cmd':
      onCmd(tx, event.cmd, event.gameId);
      break;
    case 'join':
      onJoin(tx, event);
      break;
    case 'recover':
      onRecover(tx, event);
      break;
    case 'answer':
      onAnswer(tx, event);
      break;
    case 'presence':
      onPresence(tx, event);
      break;
    case 'avatar':
      onAvatar(tx, event);
      break;
    case 'watchEnd':
      onWatchEnd(tx, event);
      break;
    case 'surpriseEnd':
      onSurpriseEnd(tx, event);
      break;
    case 'revealMediaEnd':
      onRevealMediaEnd(tx, event);
      break;
  }
  catchUp(tx);
  return tx.finish();
}

// ---------- Transitions ----------

const LIVE_PHASES: ReadonlySet<Phase> = new Set<Phase>(['intro', 'open', 'locked']);

function setPhase(s: GameState, phase: Phase, now: number): void {
  s.phase = phase;
  s.phaseRev++;
  s.phaseAt = now;
}

/**
 * Freeze a question into a new round and show its intro. A video question gets the watch stage:
 * its answers open only after the video (fallback: its length + tail) and the 3-2-1 beat.
 */
function startRound(s: GameState, q: Question, now: number, content: Content): void {
  const index = s.rounds.length;
  const openAt = now + openDelayMs(content.settings.introMs, watchWindowMs(q, content.media, content.tvOnAir !== false));
  const round: Round = { qid: q.id, q: structuredClone(q), introAt: now, openAt, endsAt: openAt + timeLimitMs(q), answers: {} };
  if (q.type === 'ordering') round.shown = shownOrder(q, roundSeed(s.gameId, index, q.id));
  // a «Сюрприз» question: the interrupt's moment and the video's length are frozen now
  const sp = surpriseOf(q, content.media);
  if (sp) round.surprise = sp;
  // «Автопилот»: a reveal with a photo / video stays until it has been seen — frozen now, while the
  // media's kind and length are known (a text or a plain answer: from the frozen question itself)
  if (q.revealMedia && content.media[q.revealMedia.mediaId]) round.revealHoldMs = revealHoldMs(q, content.media);
  s.rounds.push(round);
  s.cur = index;
  s.pause = null;
  setPhase(s, 'intro', now);
}

function toFinal(s: GameState, now: number): void {
  s.pause = null;
  s.finalStep = 0;
  setPhase(s, 'final', now);
}

/** Intro of the next unplayed question, or the final when none is left. */
function goNext(s: GameState, now: number, content: Content): void {
  const q = nextQuestion(s, content);
  if (q) startRound(s, q, now, content);
  else toFinal(s, now);
}

function lock(s: GameState, now: number): void {
  const r = s.rounds[s.cur];
  if (r) r.lockedAt = now;
  s.pause = null;
  setPhase(s, 'locked', now);
}

/**
 * The «Сюрприз» interrupt (./surprise.ts): the round locks now and its answer window closes now
 * (endsAt pulled in: the rules refuse answers from answerLateMs after it on) — the TV's breakdown,
 * the black and the video run from lockedAt. A round without a surprise locks as usual.
 */
function lockOrSurprise(s: GameState, now: number): void {
  const r = s.rounds[s.cur];
  lock(s, now);
  if (r?.surprise) r.endsAt = Math.min(r.endsAt, now);
}

/** Leaving the reveal: the board — or, after a «Сюрприз» round, straight to the final (the quiz is over). */
function afterReveal(s: GameState, now: number): void {
  if (s.rounds[s.cur]?.surprise) toFinal(s, now);
  else setPhase(s, 'board', now);
}

function revealRound(s: GameState, now: number, settings: Settings): void {
  const r = s.rounds[s.cur];
  if (r) {
    r.results = computeRoundResults(r, s.players, s.vladosId, settings.scoring);
    r.revealedAt = now;
  }
  s.pause = null;
  setPhase(s, 'reveal', now);
}

function skipCurrent(s: GameState): void {
  const r = s.rounds[s.cur];
  if (!r) return;
  r.skipped = true;
  delete r.results;
}

/**
 * Continue after a pause. Intro/open: the round moves so the remaining time starts now
 * (pause.remainingMs counts down to endsAt; a video's start moves with openAt). A hold
 * («стоп-экран») may stop any phase: the lock grace and the auto-advance timers (phaseAt) move by
 * its length, so every timer has exactly the time it had left when the show stopped. Ending a
 * hold takes its text off the TV.
 */
function resume(s: GameState, now: number): void {
  const p = s.pause;
  const r = s.rounds[s.cur];
  if (p && r && (s.phase === 'intro' || s.phase === 'open')) {
    const delta = now + p.remainingMs - r.endsAt;
    r.openAt += delta;
    r.endsAt += delta;
  } else if (p) {
    const d = Math.max(0, now - p.at);
    if (s.phase === 'locked' && r?.lockedAt !== undefined) r.lockedAt += d;
    s.phaseAt += d;
  }
  if (p?.reason === 'hold') s.tvBanner = null;
  s.pause = null;
}

/**
 * «Стоп-экран»: the show stops in whatever phase it is (nextDeadline() is null while paused). The
 * remaining time is what the running timer had left: the intro/answer window (to endsAt, exactly
 * like a pause), else the next timed transition (lock grace, auto-advance), 0 when none.
 */
function holdShow(s: GameState, now: number, settings: Settings): void {
  const r = s.rounds[s.cur];
  let remainingMs = 0;
  if (r && (s.phase === 'intro' || s.phase === 'open')) remainingMs = Math.max(0, r.endsAt - now);
  else {
    const due = nextDeadline(s, settings);
    if (due !== null) remainingMs = Math.max(0, due - now);
  }
  s.pause = { at: now, remainingMs, reason: 'hold' };
}

/** Commands that move the show on: refused while the «стоп-экран» is on (release it first). */
const HOLD_BLOCKED: ReadonlySet<AdminCmd['type']> = new Set<AdminCmd['type']>(['start', 'advance', 'reveal', 'skip', 'pause', 'jumpTo', 'end', 'resetScores']);

function pauseRound(s: GameState, now: number, reason: NonNullable<GameState['pause']>['reason']): void {
  const r = s.rounds[s.cur];
  s.pause = { at: now, remainingMs: r ? Math.max(0, r.endsAt - now) : 0, reason };
}

/** Apply every overdue timed transition (bounded: at most a handful can chain). */
function catchUp(tx: Tx): void {
  for (let i = 0; i < 8; i++) {
    const due = nextDeadline(tx.s, tx.settings);
    if (due === null || due > tx.now) return;
    const s = tx.w();
    switch (s.phase) {
      case 'lobby':
        return;
      case 'intro':
        setPhase(s, 'open', tx.now);
        break;
      case 'open':
        lockOrSurprise(s, tx.now);
        break;
      case 'locked':
        revealRound(s, tx.now, tx.settings);
        break;
      case 'reveal':
        afterReveal(s, tx.now);
        break;
      case 'board':
        goNext(s, tx.now, tx.content);
        break;
      case 'final':
        s.finalStep++;
        setPhase(s, 'final', tx.now);
        break;
    }
    tx.everything();
  }
}

// ---------- Boot (crash resume) ----------

function onBoot(tx: Tx): void {
  const s = tx.w();
  // Sockets did not survive the restart; the last save is the best "last seen" we have.
  for (const p of Object.values(s.players)) {
    if (p.online) {
      p.online = false;
      p.lastSeen = Math.max(p.lastSeen, s.savedAt);
    }
  }
  const r = s.rounds[s.cur];
  switch (s.phase) {
    case 'intro':
    case 'open':
      if (r && !s.pause) {
        s.pause = {
          at: tx.now,
          remainingMs: Math.max(r.endsAt - s.savedAt, LIMITS.recoveredMinRemainingMs),
          reason: 'recovered',
        };
      }
      break;
    case 'locked':
      revealRound(s, tx.now, tx.settings);
      break;
    case 'reveal':
    case 'board':
    case 'final':
      // Restart auto-advance timers so reconnecting players do not miss the screen.
      s.phaseAt = tx.now;
      break;
    case 'lobby':
      break;
  }
  tx.everything();
}

// ---------- Admin commands ----------

function onCmd(tx: Tx, cmd: AdminCmd, newGameId: Id | undefined): void {
  const err = runCmd(tx, cmd, newGameId);
  if (err === null) catchUp(tx);
  tx.reply(err === null ? { ok: true, phaseRev: tx.s.phaseRev } : { ok: false, err });
}

function runCmd(tx: Tx, cmd: AdminCmd, newGameId: Id | undefined): CmdErr | null {
  const s0 = tx.s;
  const now = tx.now;
  if ('phaseRev' in cmd && cmd.phaseRev !== s0.phaseRev) return 'stale';
  if (s0.pause?.reason === 'hold' && HOLD_BLOCKED.has(cmd.type)) return 'invalid';

  switch (cmd.type) {
    case 'start': {
      if (s0.phase !== 'lobby') return 'invalid';
      const q = nextQuestion(s0, tx.content);
      if (!q) return 'invalid';
      startRound(tx.w(), q, now, tx.content);
      break;
    }
    case 'advance': {
      if (s0.phase === 'reveal') afterReveal(tx.w(), now);
      else if (s0.phase === 'board') goNext(tx.w(), now, tx.content);
      else if (s0.phase === 'final' && s0.finalStep < lastFinalStep(tx.settings)) {
        const s = tx.w();
        s.finalStep++;
        setPhase(s, 'final', now);
      } else return 'invalid';
      break;
    }
    case 'reveal': {
      // a «Сюрприз» round: «Показать ответ» starts the video now (the answer comes after it)
      if (s0.phase === 'open') lockOrSurprise(tx.w(), now);
      else if (s0.phase === 'locked') revealRound(tx.w(), now, tx.settings);
      else return 'invalid';
      break;
    }
    case 'skip': {
      if (!LIVE_PHASES.has(s0.phase)) return 'invalid';
      const s = tx.w();
      skipCurrent(s);
      goNext(s, now, tx.content);
      break;
    }
    case 'pause': {
      if ((s0.phase !== 'intro' && s0.phase !== 'open') || s0.pause) return 'invalid';
      pauseRound(tx.w(), now, 'admin');
      break;
    }
    case 'resume': {
      if (!s0.pause) return 'invalid';
      resume(tx.w(), now);
      break;
    }
    case 'hold': {
      const text = cmd.text.trim();
      if (!text) return 'invalid';
      const s = tx.w();
      s.tvBanner = text;
      // already stopped: an admin pause becomes the hold (same start and time left); a hold
      // only gets its new text
      if (!s0.pause) holdShow(s, now, tx.settings);
      else if (s0.pause.reason !== 'hold') s.pause = { ...s0.pause, reason: 'hold' };
      break;
    }
    case 'unhold': {
      if (s0.pause?.reason !== 'hold') {
        // released already (another admin page): only a leftover text goes
        if (s0.tvBanner === null) return null;
        tx.w().tvBanner = null;
        break;
      }
      resume(tx.w(), now);
      break;
    }
    case 'addTime': {
      if (s0.phase !== 'intro' && s0.phase !== 'open') return 'invalid';
      const s = tx.w();
      const r = s.rounds[s.cur];
      if (!r) return 'invalid';
      // Never before the question opens, never below zero remaining.
      let ms = Math.max(cmd.ms, r.openAt - r.endsAt);
      if (s.pause) {
        ms = Math.max(ms, -s.pause.remainingMs);
        s.pause.remainingMs += ms;
      }
      r.endsAt += ms;
      break;
    }
    case 'jumpTo': {
      const q = tx.content.questions.find((x) => x.id === cmd.qid);
      if (!q || s0.rounds.some((r) => r.qid === q.id && !r.skipped)) return 'invalid';
      const s = tx.w();
      if (LIVE_PHASES.has(s.phase)) skipCurrent(s);
      startRound(s, q, now, tx.content);
      break;
    }
    case 'end': {
      if (s0.phase === 'final') return 'invalid';
      const s = tx.w();
      if (LIVE_PHASES.has(s.phase)) skipCurrent(s);
      toFinal(s, now);
      break;
    }
    case 'resetScores': {
      const s = tx.w();
      s.rounds = [];
      s.cur = -1;
      s.pause = null;
      s.finalStep = 0;
      setPhase(s, 'lobby', now);
      break;
    }
    case 'newGame': {
      const s = tx.w();
      const gameId = newGameId ?? `g${hashSeed(`${s0.gameId}:${now}`).toString(36)}`;
      Object.assign(s, { gameId, players: {}, vladosId: null, rounds: [], cur: -1, pause: null, finalStep: 0, tvBanner: null });
      setPhase(s, 'lobby', now);
      tx.emit({ k: 'newGame', gameId });
      break;
    }
    case 'rescoreRound': {
      const r0 = s0.rounds[cmd.round];
      if (!r0 || !isScored(r0)) return 'invalid';
      const fresh = tx.content.questions.find((q) => q.id === r0.qid);
      if (!fresh || fresh.type !== r0.q.type) return 'invalid';
      // Answers reference item ids, so an ordering question must keep the same items.
      if (fresh.type === 'ordering' && r0.q.type === 'ordering' && !isPermutation(correctOrder(r0.q), correctOrder(fresh))) {
        return 'invalid';
      }
      const s = tx.w();
      const r = s.rounds[cmd.round] as Round;
      // Keep the time limit the round was actually played with.
      r.q = { ...structuredClone(fresh), timeLimitS: r0.q.timeLimitS };
      r.results = computeRoundResults(r, s.players, s.vladosId, tx.settings.scoring);
      break;
    }
    case 'kick':
    case 'unkick': {
      const p = s0.players[cmd.id];
      if (!p) return 'invalid';
      const kicked = cmd.type === 'kick';
      if (p.kicked === kicked) return null;
      (tx.w().players[cmd.id] as Player).kicked = kicked;
      if (kicked) tx.emit({ k: 'kick', id: cmd.id });
      break;
    }
    case 'removeAvatar': {
      const p = s0.players[cmd.id];
      if (!p) return 'invalid';
      if (!p.avatar) return null;
      delete (tx.w().players[cmd.id] as Player).avatar;
      tx.emit({ k: 'deleteAvatar', file: p.avatar });
      break;
    }
    case 'rename': {
      const name = normalizeName(cmd.name);
      if (!s0.players[cmd.id] || !name || nameTaken(s0, name, cmd.id)) return 'invalid';
      (tx.w().players[cmd.id] as Player).name = name;
      break;
    }
    case 'setVlados': {
      if (cmd.id !== null && !s0.players[cmd.id]) return 'invalid';
      tx.w().vladosId = cmd.id;
      break;
    }
    case 'merge':
      return merge(tx, cmd.from, cmd.into);
    case 'tvBanner': {
      tx.w().tvBanner = cmd.text?.trim() || null;
      tx.persist();
      tx.show(['tv', 'admin']);
      return null;
    }
    case 'qrMode':
      tx.emit({ k: 'settings', patch: { qrMode: cmd.mode } });
      return null;
    case 'openTv':
      tx.emit({ k: 'openTv' });
      return null;
    case 'bots':
      tx.emit({ k: 'bots', n: cmd.n });
      return null;
  }
  tx.everything();
  return null;
}

/** Fold a duplicate player into the original: answers `into` lacks move over, then `from` is removed. */
function merge(tx: Tx, from: Id, into: Id): CmdErr | null {
  const s0 = tx.s;
  const a0 = s0.players[from];
  const b0 = s0.players[into];
  if (from === into || !a0 || !b0) return 'invalid';
  const s = tx.w();
  for (const r of s.rounds) {
    const ans = r.answers[from];
    if (ans && !r.answers[into]) {
      r.answers[into] = ans;
      const res = r.results?.[from];
      if (r.results && res) r.results[into] = res;
    }
    delete r.answers[from];
    if (r.results) delete r.results[from];
  }
  const b = s.players[into] as Player;
  b.joinedAt = Math.min(a0.joinedAt, b0.joinedAt);
  b.lastSeen = Math.max(a0.lastSeen, b0.lastSeen);
  b.online = a0.online || b0.online;
  if (a0.avatar) {
    if (b.avatar) tx.emit({ k: 'deleteAvatar', file: a0.avatar });
    else b.avatar = a0.avatar;
  }
  if (s.vladosId === from) s.vladosId = into;
  delete s.players[from];
  tx.emit({ k: 'merged', from, into });
  tx.everything();
  return null;
}

// ---------- Watch stage ----------

/**
 * The video of the question on air ended: open the answers after the beat. Only during the watch
 * stage of an intro (not paused); a second report once the beat runs is a no-op. The caller checks
 * that the round has a watch stage at all (the host freezes its window, see app/src/host).
 */
function onWatchEnd(tx: Tx, ev: Extract<EngineEvent, { t: 'watchEnd' }>): void {
  const s0 = tx.s;
  const fail = (err: CmdErr) => tx.reply({ ok: false, err });
  if (ev.phaseRev !== s0.phaseRev) return fail('stale');
  const r0 = s0.rounds[s0.cur];
  if (s0.phase !== 'intro' || !r0 || s0.pause) return fail('invalid');
  const openAt = tx.now + WATCH.beatMs;
  if (openAt < r0.openAt) {
    const r = tx.w().rounds[s0.cur] as Round;
    const d = openAt - r.openAt;
    r.openAt += d;
    r.endsAt += d;
    tx.everything();
  }
  tx.reply({ ok: true, phaseRev: tx.s.phaseRev });
}

// ---------- «Сюрприз» ----------

/**
 * The surprise video ended (the TV's 'ended', «Досмотрели — к ответу», TV Space): the question's
 * reveal now. Only while the stage runs (not held); a second report finds the reveal: 'stale'.
 */
function onSurpriseEnd(tx: Tx, ev: Extract<EngineEvent, { t: 'surpriseEnd' }>): void {
  const s0 = tx.s;
  if (ev.phaseRev !== s0.phaseRev) return tx.reply({ ok: false, err: 'stale' });
  if (!surpriseRunning(s0) || s0.pause) return tx.reply({ ok: false, err: 'invalid' });
  revealRound(tx.w(), tx.now, tx.settings);
  tx.everything();
  tx.reply({ ok: true, phaseRev: tx.s.phaseRev });
}

// ---------- The reveal video ----------

/**
 * The reveal video ended on the TV: remember when (ms after the reveal began — a «стоп-экран»
 * shifts phaseAt, so the moment moves with it). The autopilot's hold out of the reveal then ends
 * SHOW.revealVideoEndedMs after it (autoHoldMs). Only during the reveal of a round whose reveal
 * media is a video (not a «Сюрприз» round, not held); the first report counts, a second is a no-op.
 * The phase does not change: phaseRev stays, the organizer's button keeps working.
 */
function onRevealMediaEnd(tx: Tx, ev: Extract<EngineEvent, { t: 'revealMediaEnd' }>): void {
  const s0 = tx.s;
  if (ev.phaseRev !== s0.phaseRev) return tx.reply({ ok: false, err: 'stale' });
  const r0 = s0.rounds[s0.cur];
  const rm = r0?.q.revealMedia;
  if (s0.phase !== 'reveal' || s0.pause || !r0 || r0.surprise || !rm || tx.content.media[rm.mediaId]?.kind !== 'video') return tx.reply({ ok: false, err: 'invalid' });
  if (r0.revealEndMs === undefined) {
    (tx.w().rounds[s0.cur] as Round).revealEndMs = Math.max(0, tx.now - s0.phaseAt);
    tx.persist();
    tx.show(['tv', 'admin']);
  }
  tx.reply({ ok: true, phaseRev: s0.phaseRev });
}

// ---------- Players ----------

function nameTaken(s: GameState, name: string, exceptId: Id | null): boolean {
  const key = nameKey(name);
  return Object.values(s.players).some((p) => p.id !== exceptId && nameKey(p.name) === key);
}

function onJoin(tx: Tx, ev: Extract<EngineEvent, { t: 'join' }>): void {
  const s0 = tx.s;
  const st = tx.settings;
  const fail = (err: JoinErr | 'server') => tx.reply({ ok: false, err });
  if (s0.phase === 'final' || (s0.phase !== 'lobby' && !st.lateJoin)) return fail('closed');
  const name = normalizeName(ev.name);
  if (!name) return fail('bad_name');
  if (nameTaken(s0, name, null)) return fail('name_taken');
  if (Object.values(s0.players).filter((p) => !p.kicked).length >= st.maxPlayers) return fail('full');
  if (s0.players[ev.id]) return fail('server');

  const p: Player = {
    id: ev.id,
    token: ev.token,
    code: ev.code,
    name,
    seed: ev.seed,
    joinedAt: tx.now,
    lastSeen: tx.now,
    online: true,
    kicked: false,
  };
  if (ev.avatar) p.avatar = ev.avatar;
  if (ev.bot) p.bot = true;
  tx.w().players[p.id] = p;
  tx.persist();
  tx.show(ALL_VIEWS, [p.id]);
  tx.reply({ ok: true, token: p.token, id: p.id, code: p.code });
}

/** «Я уже играл»: name + 4-digit code → the existing player's token. No state change. */
function onRecover(tx: Tx, ev: Extract<EngineEvent, { t: 'recover' }>): void {
  const name = normalizeName(ev.name);
  const key = name ? nameKey(name) : null;
  const p = key === null ? undefined : Object.values(tx.s.players).find((x) => x.code === ev.code && nameKey(x.name) === key);
  if (!p) tx.reply({ ok: false, err: 'not_found' });
  else if (p.kicked) tx.reply({ ok: false, err: 'kicked' });
  else tx.reply({ ok: true, token: p.token, id: p.id, code: p.code });
}

function onAvatar(tx: Tx, ev: Extract<EngineEvent, { t: 'avatar' }>): void {
  const p0 = tx.s.players[ev.playerId];
  if (!p0 || p0.kicked) return tx.reply({ ok: false, err: 'no_player' });
  (tx.w().players[ev.playerId] as Player).avatar = ev.file;
  if (p0.avatar && p0.avatar !== ev.file) tx.emit({ k: 'deleteAvatar', file: p0.avatar });
  tx.persist();
  // Phones only see selfies on the final podium.
  tx.show(tx.s.phase === 'final' ? ALL_VIEWS : ['tv', 'admin'], [ev.playerId]);
  tx.reply({ ok: true, avatar: avatarPath(ev.file) });
}

function onPresence(tx: Tx, ev: Extract<EngineEvent, { t: 'presence' }>): void {
  if (!tx.s.players[ev.playerId]) return;
  const p = tx.w().players[ev.playerId] as Player;
  p.online = ev.online;
  p.lastSeen = tx.now;
  // Presence is runtime-only (everyone is offline after a restart anyway): no save.
  tx.show(['tv', 'admin']);
  if (!ev.online) maybeAutoPause(tx);
}

/** >30% of online players dropping within 5 s during an open question → pause 'mass-disconnect'. */
function maybeAutoPause(tx: Tx): void {
  const s0 = tx.s;
  if (s0.phase !== 'open' || s0.pause || !tx.settings.autoPauseOnMassDisconnect) return;
  let online = 0;
  let dropped = 0;
  for (const p of Object.values(s0.players)) {
    if (p.kicked) continue;
    if (p.online) online++;
    else if (tx.now - p.lastSeen <= LIMITS.massDisconnectWindowMs) dropped++;
  }
  if (dropped >= LIMITS.massDisconnectMinCount && dropped > LIMITS.massDisconnectShare * (online + dropped)) {
    pauseRound(tx.w(), tx.now, 'mass-disconnect');
    tx.everything();
  }
}

// ---------- Answers ----------

function validPayload(q: Question, p: AnswerPayload): boolean {
  switch (q.type) {
    case 'choice':
      return p.t === 'choice' && q.options.some((o) => o.id === p.id);
    case 'number':
      return p.t === 'number' && Number.isFinite(p.v) && (q.min === undefined || p.v >= q.min) && (q.max === undefined || p.v <= q.max);
    case 'ordering':
      return p.t === 'ordering' && isPermutation(correctOrder(q), p.ids);
  }
}

/** Copy only the known fields of a payload. */
function cleanPayload(p: AnswerPayload): AnswerPayload {
  switch (p.t) {
    case 'choice':
      return { t: 'choice', id: p.id };
    case 'number':
      return { t: 'number', v: p.v };
    case 'ordering':
      return { t: 'ordering', ids: [...p.ids] };
  }
}

/** Server-measured time since the question opened (frozen while paused). */
function serverElapsedMs(s: GameState, r: Round, now: number): number {
  if (s.pause && s.phase === 'open') return r.endsAt - r.openAt - s.pause.remainingMs;
  return now - r.openAt;
}

function onAnswer(tx: Tx, ev: Extract<EngineEvent, { t: 'answer' }>): void {
  const s0 = tx.s;
  const fail = (err: AnswerErr) => tx.reply({ ok: false, err });
  const player = s0.players[ev.playerId];
  if (!player) return fail('invalid');
  const round = s0.rounds[ev.round];
  const prev = round?.answers[ev.playerId];
  // Outbox resend of an answer we already stored: idempotent, even after the round moved on.
  if (prev && prev.cid === ev.cid) return tx.reply({ ok: true, elapsedMs: prev.elapsedMs });
  if (player.kicked) return fail('kicked');
  if (!round || ev.round > s0.cur) return fail('not_open');
  if (ev.round < s0.cur) return fail('closed');
  if (s0.phase === 'lobby' || s0.phase === 'intro') return fail('not_open');
  if (s0.phase !== 'open' && s0.phase !== 'locked') return fail('closed');
  if (prev) return fail('dup');
  if (!validPayload(round.q, ev.p)) return fail('invalid');

  const elapsedMs = effectiveElapsed(
    ev.elapsedMs,
    serverElapsedMs(s0, round, tx.now),
    timeLimitMs(round.q),
    tx.settings.scoring.maxLatencyCreditMs,
  );
  const s = tx.w();
  (s.rounds[ev.round] as Round).answers[ev.playerId] = { p: cleanPayload(ev.p), elapsedMs, at: tx.now, cid: ev.cid };
  (s.players[ev.playerId] as Player).lastSeen = tx.now;
  tx.persist();
  tx.emit({ k: 'answered', id: ev.playerId });
  tx.show(ALL_VIEWS, [ev.playerId]);
  tx.reply({ ok: true, elapsedMs });
}
