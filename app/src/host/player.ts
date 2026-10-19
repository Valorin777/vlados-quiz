// Player-side API (docs/firebase.md → Auth & roles, Firestore layout). Runs in the phone page and
// in Node bots: no DOM, the Firestore instance and the signed-in uid are passed in.
//
// A phone listens to ONE document, games/{g} (plus config/current, which changes only on newGame).
// Its own player doc is read once (start / join) and kept locally; kicks arrive via games/{g}.kicked.
// Writes: players/{uid} (join, rename, avatar, seenAt clock probes on reconnect),
// answers/{round}_{uid} (create-only, stamped with the server time) and reactions/{uid}_{bucket}.

import {
  FB_LIMITS,
  reactionBucket,
  type GameDoc,
  type PlayerDoc,
  type ServerMs,
} from '@shared/fbtypes';
import type { AnswerPayload } from '@shared/types';
import { randomSeed } from '@shared/util';
import { getDoc, getDocFromServer, onSnapshot, serverTimestamp, setDoc, updateDoc, type Firestore, type Unsubscribe } from 'firebase/firestore';
import { clock as sharedClock, playerClockProbe, startClockSync, type ClockProbe, type ClockSync, type ServerClock } from '../fb/clock';
import { fbRefs, newAnswerDoc, newPlayerDoc, newReactionDoc, toFirestorePatch, type FbRefs } from '../fb/refs';
import { answerPrecheck, answersLive, checkedName, isHeld, reactionAllowed, type AnswerError } from './pure';
import { buildPlayerView, type MyAnswer, type PlayerView, type PlayerViewInput } from './views';

export type JoinError = 'bad_name' | 'too_big' | 'closed' | 'no_game' | 'offline' | 'forbidden' | 'failed';
export type JoinResult = { ok: true } | { ok: false; error: JoinError };
export type AnswerResult = { ok: true } | { ok: false; error: AnswerError };
export type ReactError = 'disabled' | 'not_joined' | 'kicked' | 'throttled' | 'offline' | 'rejected';
export type ReactResult = { ok: true } | { ok: false; error: ReactError };
export type UpdateError = 'bad_name' | 'too_big' | 'not_joined' | 'kicked' | 'offline' | 'forbidden' | 'failed';
export type UpdateResult = { ok: true } | { ok: false; error: UpdateError };

export interface PlayerOptions {
  db: Firestore;
  /** The signed-in (anonymous) uid = player id. */
  uid: string;
  /** Defaults to the page-wide clock; bots pass one per player. */
  clock?: ServerClock;
  /** Play this game; default: config/current (and follow it when a new game starts). */
  gameId?: string;
  /** How long answer()/join() wait for the server before saying 'offline'. Default 10 s. */
  timeoutMs?: number;
  /** Re-measure the clock on reconnect (players/{uid}.seenAt). Default true. */
  syncClock?: boolean;
}

type Listener = (s: PlayerViewInput) => void;

const codeOf = (e: unknown): string => (typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : '');

const TIMEOUT = Symbol('timeout');

/** Slack on top of FB_LIMITS.playerWriteGapMs (the rules compare server times; ours are estimates). */
const OWNER_GAP_MARGIN_MS = 300;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const sameBytes = (a: Uint8Array, b: Uint8Array | undefined): boolean => !!b && a.length === b.length && a.every((x, i) => x === b[i]);

async function orTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<typeof TIMEOUT>((r) => (timer = setTimeout(() => r(TIMEOUT), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

export class PlayerSession {
  readonly uid: string;
  readonly clock: ServerClock;
  readonly refs: FbRefs;

  private readonly db: Firestore;
  private readonly opts: PlayerOptions;
  private readonly timeoutMs: number;
  private g: string | null = null;
  private game: GameDoc | null = null;
  private gameState: PlayerViewInput['gameState'] = 'loading';
  private me: PlayerDoc | null = null;
  private meLoaded = false;
  private answers: Record<number, MyAnswer> = {};
  private inflight = new Map<number, Promise<AnswerResult>>();
  private lastScore: PlayerViewInput['lastScore'] = null;
  private reactionsSent: ServerMs[] = [];
  /** The round this device already showed open (views: the stage never goes back to the intro). */
  private opened: { gameId: string | null; i: number } | null = null;
  private lastBucket = -1;
  private gameUnsub: Unsubscribe | null = null;
  private currentUnsub: Unsubscribe | null = null;
  private clockSync: ClockSync | null = null;
  private subs = new Set<Listener>();
  private epoch = 0;
  private stopped = true;
  /** Once per (re)connect: look up an answer this player already stored for the round on air. */
  private restorePending = false;
  /**
   * The rules accept an owner update of players/{uid} (rename, selfie, clock probe) only
   * FB_LIMITS.playerWriteGapMs after the previous one: they go through one queue, spaced.
   * Local Date.now() from which the next one is accepted.
   */
  private ownerReadyAt = 0;
  private ownerChain: Promise<unknown> = Promise.resolve();
  /**
   * The join write of this game, while it is in flight. join() is idempotent: a second call (a
   * retry, a double tap, a timed-out first try whose write the SDK still queues) waits for the
   * same write instead of creating the player again.
   */
  private joinRun: { epoch: number; name: string; avatar: Uint8Array | undefined; done: Promise<JoinResult> } | null = null;
  /** Wakes loadMe()'s retry wait early (the game snapshot just arrived from the server). */
  private wakeLoad: (() => void) | null = null;

  constructor(opts: PlayerOptions) {
    this.opts = opts;
    this.db = opts.db;
    this.uid = opts.uid;
    this.refs = fbRefs(opts.db);
    this.clock = opts.clock ?? sharedClock;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  get gameId(): string | null {
    return this.g;
  }

  /**
   * Finds the game and starts listening; this device's player (and answer) is restored in the
   * background — `view().screen` stays 'loading' until it is known (whenReady() waits for it).
   */
  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    let g = this.opts.gameId ?? null;
    if (!g) {
      try {
        g = (await getDoc(this.refs.configCurrent())).data()?.gameId ?? null;
      } catch {
        g = null;
      }
      this.currentUnsub = onSnapshot(
        this.refs.configCurrent(),
        (snap) => {
          const next = snap.data()?.gameId;
          if (next && next !== this.g && !this.stopped) void this.attach(next);
        },
        () => undefined,
      );
    }
    await this.attach(g ?? 'main');
  }

  stop(): void {
    this.stopped = true;
    this.wakeLoad?.();
    this.gameUnsub?.();
    this.currentUnsub?.();
    this.gameUnsub = this.currentUnsub = null;
    this.clockSync?.stop();
    this.clockSync = null;
  }

  subscribe(fn: Listener): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  snapshot(): PlayerViewInput {
    return {
      uid: this.uid,
      gameId: this.g,
      game: this.game,
      gameState: this.gameState,
      me: this.me,
      meLoaded: this.meLoaded,
      answers: this.answers,
      lastScore: this.lastScore,
      reactionsSent: this.reactionsSent,
      opened: this.opened,
    };
  }

  view(now: ServerMs = this.clock.now()): PlayerView {
    const v = buildPlayerView(this.snapshot(), now);
    if (v.question && (v.phase === 'open' || v.phase === 'locked') && (this.opened?.i !== v.question.i || this.opened.gameId !== v.gameId)) {
      this.opened = { gameId: v.gameId, i: v.question.i };
    }
    return v;
  }

  /** A join write is on its way (the page must not reload itself now). */
  get joining(): boolean {
    return this.joinRun !== null && this.joinRun.epoch === this.epoch;
  }

  /** Resolves once the game doc and the own player doc are known. */
  async whenReady(timeoutMs = 20_000): Promise<void> {
    const t0 = Date.now();
    while (this.gameState === 'loading' || !this.meLoaded) {
      if (Date.now() - t0 > timeoutMs) throw new Error('player: game did not load');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // ---------- Game ----------

  private async attach(g: string): Promise<void> {
    this.epoch++;
    const epoch = this.epoch;
    this.gameUnsub?.();
    this.clockSync?.stop();
    this.clockSync = null;
    this.g = g;
    this.game = null;
    this.gameState = 'loading';
    this.me = null;
    this.meLoaded = false;
    this.answers = {};
    this.inflight.clear();
    this.joinRun = null;
    this.lastScore = null;
    this.restorePending = true;
    this.changed();
    this.gameUnsub = onSnapshot(
      this.refs.game(g),
      { includeMetadataChanges: true },
      (snap) => {
        if (epoch !== this.epoch) return;
        this.game = snap.data() ?? null;
        this.gameState = !snap.exists() ? (snap.metadata.fromCache ? 'loading' : 'missing') : snap.metadata.fromCache ? 'cache' : 'live';
        this.noteScore();
        this.maybeRestore(epoch);
        // Connected: a player-doc read waiting to retry goes now.
        if (this.gameState === 'live' && !this.meLoaded) this.wakeLoad?.();
        this.changed();
      },
      () => {
        if (epoch !== this.epoch) return;
        this.gameState = 'error';
        this.changed();
      },
    );
    // Not awaited: it retries until the server answers (see loadMe); whenReady() waits for it.
    void this.loadMe(epoch);
  }

  /**
   * Reads the own player doc; if joined, re-measures the clock (bumps seenAt = reconnect).
   * Retries until the server answers: showing the join form because the read failed would make a
   * player who already joined type the name and take the selfie again (seen on slow networks,
   * where the first connect takes longer than a few retries). Until then the phone shows the loader.
   */
  private async loadMe(epoch: number): Promise<void> {
    const g = this.g as string;
    for (let attempt = 0; epoch === this.epoch && !this.stopped; attempt++) {
      try {
        // getDocFromServer fails at once while the SDK counts itself offline, but a request stuck
        // in flight can hang: bounded, then try again.
        const snap = await orTimeout(getDocFromServer(this.refs.player(g, this.uid)), 15_000);
        if (snap === TIMEOUT) throw new Error('player read timed out');
        if (epoch !== this.epoch) return;
        // A join that landed meanwhile knows better (this read may have started before it).
        if (!this.me) this.me = snap.data() ?? null;
        this.meLoaded = true;
        if (this.me) this.noteOwnerWrite(this.me.seenAt);
        this.changed();
        if (this.me && !this.me.kicked) this.startClock();
        this.maybeRestore(epoch);
        return;
      } catch {
        if (epoch !== this.epoch || this.stopped) return;
        await new Promise<void>((r) => {
          const done = () => {
            clearTimeout(t);
            if (this.wakeLoad === done) this.wakeLoad = null;
            r();
          };
          const t = setTimeout(done, Math.min(8_000, 500 * 2 ** attempt));
          this.wakeLoad = done;
        });
      }
    }
  }

  private startClock(): void {
    if (this.opts.syncClock === false || this.clockSync || !this.g) return;
    const base = playerClockProbe(this.refs, this.g, this.uid);
    const probe: ClockProbe = () =>
      this.ownerWrite(async () => {
        const r = await base();
        this.noteOwnerWrite(r.serverMs);
        return r;
      });
    this.clockSync = startClockSync(probe, this.clock);
  }

  /** Remembers an accepted owner write at server time `serverMs` (default: just now). */
  private noteOwnerWrite(serverMs?: number): void {
    const ago = serverMs === undefined ? 0 : Math.max(0, this.clock.now() - serverMs);
    this.ownerReadyAt = Math.max(this.ownerReadyAt, Date.now() - ago + FB_LIMITS.playerWriteGapMs + OWNER_GAP_MARGIN_MS);
  }

  /** Runs owner writes of players/{uid} one at a time, spaced as the rules require. */
  private ownerWrite<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.ownerChain.then(async () => {
      const wait = this.ownerReadyAt - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        return await fn();
      } finally {
        // A refused or timed-out write is counted too: waiting a little longer is harmless.
        this.noteOwnerWrite();
      }
    });
    this.ownerChain = run.catch(() => undefined);
    return run;
  }

  private maybeRestore(epoch: number): void {
    const game = this.game;
    if (!this.restorePending || !this.meLoaded || !game) return;
    this.restorePending = false;
    const r = game.round;
    if (this.me && r && ['open', 'locked', 'reveal', 'board'].includes(game.phase)) void this.restoreAnswer(r.i, epoch);
  }

  /** After a reload: did this player already answer round i (maybe on another device)? */
  private async restoreAnswer(i: number, epoch: number): Promise<void> {
    if (this.answers[i] || !this.g) return;
    try {
      const a = (await getDoc(this.refs.answer(this.g, i, this.uid))).data();
      if (a && epoch === this.epoch && !this.answers[i]) {
        this.answers = { ...this.answers, [i]: { round: i, p: a.p, status: 'accepted' } };
        this.changed();
      }
    } catch {
      // Offline: the player can still answer; a duplicate is refused and then recognised.
    }
  }

  private noteScore(): void {
    const g = this.game;
    const fin = g?.final?.me?.[this.uid];
    if (fin) {
      this.lastScore = { i: Number.MAX_SAFE_INTEGER, tot: fin.tot, rank: fin.rank };
      return;
    }
    const mine = g?.reveal?.me[this.uid];
    if (g?.reveal && mine && (!this.lastScore || g.reveal.i >= this.lastScore.i)) this.lastScore = { i: g.reveal.i, tot: mine.tot, rank: mine.rank };
  }

  private kickedNow(): boolean {
    return this.me?.kicked === true || (this.game?.kicked?.includes(this.uid) ?? false);
  }

  // ---------- Join & profile ----------

  /**
   * Joins the current game: creates players/{uid} (joinedAt/seenAt = server time) and uses that
   * write as the first clock sample. `avatarJpeg` ≤ 40 KB (256 px), `thumbJpeg` ≤ 6 KB (64 px).
   *
   * Idempotent: while a join write is in flight every call waits for that same write. As soon as
   * the server confirms it the view switches to the lobby (the stamped doc is read back after, for
   * the clock). 'offline' = no answer within `timeoutMs` yet — the write stays queued and the view
   * still flips to the lobby when it lands; calling join() again just keeps waiting for it. A
   * refused create whose doc exists (a resend after a lost ack, another tab) adopts that doc.
   */
  async join(name: string, avatarJpeg?: Uint8Array, thumbJpeg?: Uint8Array): Promise<JoinResult> {
    const g = this.g;
    const game = this.game;
    if (this.me) return { ok: true };
    if (!g || this.gameState === 'missing') return { ok: false, error: 'no_game' };
    if (!game) return { ok: false, error: this.gameState === 'loading' ? 'offline' : 'no_game' };
    const clean = checkedName(name);
    if (!clean) return { ok: false, error: 'bad_name' };
    if ((avatarJpeg && avatarJpeg.length > FB_LIMITS.avatarMaxBytes) || (thumbJpeg && thumbJpeg.length > FB_LIMITS.thumbMaxBytes)) {
      return { ok: false, error: 'too_big' };
    }
    let run = this.joinRun;
    if (!run || run.epoch !== this.epoch) {
      if (this.joinClosed(game)) return { ok: false, error: 'closed' };
      run = this.startJoin(g, clean, avatarJpeg, thumbJpeg);
    }
    const r = await orTimeout(run.done, this.timeoutMs);
    if (r === TIMEOUT) return { ok: false, error: 'offline' };
    // Changed the name or the photo while an earlier write was still on its way: apply on top.
    // (`this.me` was null above; the write may have set it since — read it afresh.)
    const me = this.snapshot().me;
    if (r.ok && me && run.epoch === this.epoch) {
      if (me.name !== clean) void this.rename(clean);
      if (avatarJpeg && thumbJpeg && !sameBytes(avatarJpeg, run.avatar)) void this.setAvatar(avatarJpeg, thumbJpeg);
    }
    return r;
  }

  /** Whether the rules would refuse a join right now (after the lobby, over the cap). */
  private joinClosed(game: GameDoc): boolean {
    if (game.phase === 'final' || (game.phase !== 'lobby' && game.pub?.lateJoin === false)) return true;
    // The rules refuse joins while the host's count is at the cap (see PubInfo.maxPlayers).
    const cap = Math.min(game.pub?.maxPlayers ?? FB_LIMITS.playersHardMax, FB_LIMITS.playersHardMax);
    return (game.players ?? 0) >= cap;
  }

  private startJoin(g: string, clean: string, avatar: Uint8Array | undefined, thumb: Uint8Array | undefined): NonNullable<PlayerSession['joinRun']> {
    const epoch = this.epoch;
    const ref = this.refs.player(g, this.uid);
    const seed = randomSeed();
    const doc = newPlayerDoc({ name: clean, seed, ...(avatar ? { avatar } : {}), ...(thumb ? { thumb } : {}) });
    const t0 = Date.now();
    const p0 = performance.now();
    const done = (async (): Promise<JoinResult> => {
      try {
        await setDoc(ref, doc);
      } catch (e) {
        if (epoch !== this.epoch) return { ok: false, error: 'failed' };
        if (codeOf(e) !== 'permission-denied') return { ok: false, error: 'failed' };
        // Refused: maybe already in (the create landed but its ack got lost and the resend hit the
        // existing doc; another tab) — then adopt that doc. Else the door closed meanwhile.
        const existing = await this.readOwn(ref, epoch);
        if (existing === undefined) return { ok: false, error: 'offline' };
        if (existing) {
          if (!this.me) this.me = existing;
          this.meLoaded = true;
          this.noteOwnerWrite(existing.seenAt);
          this.changed();
          return { ok: true };
        }
        return { ok: false, error: this.game && this.joinClosed(this.game) ? 'closed' : 'forbidden' };
      }
      const rttMs = performance.now() - p0;
      if (epoch !== this.epoch) return { ok: false, error: 'failed' };
      // The server stored it: the player is in. Show the lobby now with what we wrote; the
      // server-stamped times arrive with the read-back below.
      const est = this.clock.now();
      if (!this.me) this.me = { name: clean, seed, ...(avatar ? { avatar } : {}), ...(thumb ? { thumb } : {}), joinedAt: est, kicked: false, seenAt: est };
      this.meLoaded = true;
      this.noteOwnerWrite();
      this.changed();
      void this.readOwn(ref, epoch).then((me) => {
        if (!me || epoch !== this.epoch) return;
        // Keep the local name (a rename may have followed) and byte arrays (no avatar URL churn).
        const local = this.me;
        this.me = local ? { ...me, name: local.name, ...(local.avatar ? { avatar: local.avatar } : {}), ...(local.thumb ? { thumb: local.thumb } : {}) } : me;
        this.clock.offer({ serverMs: me.seenAt, t0, rttMs });
        this.noteOwnerWrite(me.seenAt);
        this.changed();
      });
      return { ok: true };
    })();
    const run = { epoch, name: clean, avatar, done };
    this.joinRun = run;
    void done.then(() => {
      // Settled: a failed run may be tried again with a fresh write; a successful one is `me` now.
      if (this.joinRun === run) this.joinRun = null;
    });
    return run;
  }

  /** The own player doc from the server (null = none), undefined when the server was not reached. */
  private async readOwn(ref: ReturnType<FbRefs['player']>, epoch: number): Promise<PlayerDoc | null | undefined> {
    for (let attempt = 0; attempt < 4 && epoch === this.epoch; attempt++) {
      try {
        const snap = await orTimeout(getDocFromServer(ref), 10_000);
        if (snap !== TIMEOUT) return snap.data() ?? null;
      } catch {
        // offline for the moment
      }
      await sleep(1_000 * (attempt + 1));
    }
    return undefined;
  }

  async rename(name: string): Promise<UpdateResult> {
    const clean = checkedName(name);
    if (!clean) return { ok: false, error: 'bad_name' };
    return this.updateMe({ name: clean });
  }

  /** Replaces the selfie (256 px JPEG ≤ 40 KB) and its thumb (64 px ≤ 6 KB). */
  async setAvatar(avatarJpeg: Uint8Array, thumbJpeg: Uint8Array): Promise<UpdateResult> {
    if (avatarJpeg.length > FB_LIMITS.avatarMaxBytes || thumbJpeg.length > FB_LIMITS.thumbMaxBytes) return { ok: false, error: 'too_big' };
    return this.updateMe({ avatar: avatarJpeg, thumb: thumbJpeg });
  }

  private async updateMe(patch: Partial<Pick<PlayerDoc, 'name' | 'avatar' | 'thumb'>>): Promise<UpdateResult> {
    const g = this.g;
    if (!g || !this.me) return { ok: false, error: 'not_joined' };
    if (this.kickedNow()) return { ok: false, error: 'kicked' };
    const send = () =>
      this.ownerWrite(() =>
        orTimeout(updateDoc(this.refs.player(g, this.uid), { ...toFirestorePatch(patch), seenAt: serverTimestamp() }), this.timeoutMs),
      );
    try {
      let done: void | typeof TIMEOUT;
      try {
        done = await send();
      } catch (e) {
        // Refused: maybe our estimate of the last write was off (clock not synced yet). Once more.
        if (codeOf(e) !== 'permission-denied' || this.kickedNow() || g !== this.g) throw e;
        this.noteOwnerWrite();
        done = await send();
      }
      if (done === TIMEOUT) return { ok: false, error: 'offline' };
      if (g === this.g && this.me) this.me = { ...this.me, ...patch };
      this.changed();
      return { ok: true };
    } catch (e) {
      const code = codeOf(e);
      return { ok: false, error: code === 'permission-denied' ? 'forbidden' : code === 'unavailable' ? 'offline' : 'failed' };
    }
  }

  // ---------- Answers ----------

  /**
   * Answers round `round` (RoundPub.i). Resolves {ok:true} once the server stored it, or an error:
   * 'late' (window closed), 'closed' (not open / other round), 'kicked', 'invalid', 'not_joined',
   * 'offline' (no server ack within the timeout — the write stays queued and `view().answer`
   * flips to accepted if it lands later).
   */
  answer(round: number, p: AnswerPayload): Promise<AnswerResult> {
    const running = this.inflight.get(round);
    if (running) return running;
    const have = this.answers[round];
    if (have?.status === 'accepted') return Promise.resolve({ ok: true });
    // Still queued from an earlier try that timed out: Firestore keeps retrying it.
    if (have?.status === 'sending') return Promise.resolve({ ok: false, error: 'offline' });
    // the options are up on this screen (openAt passed, see views.phoneGame): the server decides
    const r = this.game?.round;
    const shownOpen = r?.i === round && this.opened?.i === round && this.opened.gameId === this.g;
    const now = shownOpen && r ? Math.max(this.clock.now(), r.openAt) : this.clock.now();
    const pre = answerPrecheck(this.game, { uid: this.uid, joined: this.me !== null, kicked: this.kickedNow() }, round, p, now);
    if (pre) return Promise.resolve({ ok: false, error: pre });
    const run = this.sendAnswer(round, p).finally(() => this.inflight.delete(round));
    this.inflight.set(round, run);
    return run;
  }

  private setAnswer(a: MyAnswer): void {
    this.answers = { ...this.answers, [a.round]: a };
    this.changed();
  }

  private async sendAnswer(round: number, p: AnswerPayload): Promise<AnswerResult> {
    const g = this.g as string;
    const epoch = this.epoch;
    this.setAnswer({ round, p, status: 'sending' });
    const write = setDoc(this.refs.answer(g, round, this.uid), newAnswerDoc(this.uid, round, p));
    const settle = write.then(
      (): AnswerResult => ({ ok: true }),
      (e: unknown) => this.classifyAnswerError(g, round, e),
    );
    // Whatever happens later (a queued write landing after a timeout), keep the view right.
    void settle.then((r) => {
      if (epoch !== this.epoch) return;
      if (r.ok) this.setAnswer({ round, p: this.answers[round]?.p ?? p, status: 'accepted' });
      else this.setAnswer({ round, p, status: 'rejected', error: r.error });
    });
    const r = await orTimeout(settle, this.timeoutMs);
    return r === TIMEOUT ? { ok: false, error: 'offline' } : r;
  }

  private async classifyAnswerError(g: string, round: number, e: unknown): Promise<AnswerResult> {
    const code = codeOf(e);
    if (code === 'unavailable') return { ok: false, error: 'offline' };
    if (code !== 'permission-denied') return { ok: false, error: 'closed' };
    // Create-only: a refusal may just mean it is already stored (another tab, a resend).
    try {
      const stored = (await getDocFromServer(this.refs.answer(g, round, this.uid))).data();
      if (stored) {
        this.answers = { ...this.answers, [round]: { round, p: stored.p, status: 'accepted' } };
        return { ok: true };
      }
    } catch {
      // ignore
    }
    if (this.kickedNow()) return { ok: false, error: 'kicked' };
    const r = this.game?.round;
    const now = this.clock.now();
    if (!r || r.i !== round || !answersLive(this.game, now) || now > r.endsAt + FB_LIMITS.answerLateMs - 250) {
      return { ok: false, error: r && r.i === round && this.game?.phase === 'intro' && now < r.endsAt ? 'closed' : 'late' };
    }
    return { ok: false, error: 'closed' };
  }

  // ---------- Reactions ----------

  /** Sends reaction `e` (index into REACTIONS). Throttled to one per 3 s and 4 per minute (REACTION_LIMITS). */
  async react(e: number): Promise<ReactResult> {
    const g = this.g;
    if (!g || !this.me) return { ok: false, error: 'not_joined' };
    if (this.kickedNow()) return { ok: false, error: 'kicked' };
    // off while the «стоп-экран» is on: nothing may fly onto the TV (and no write burns quota)
    if (!this.game?.pub?.reactions || isHeld(this.game)) return { ok: false, error: 'disabled' };
    if (!Number.isInteger(e) || e < 0 || e > FB_LIMITS.reactionMax) return { ok: false, error: 'rejected' };
    const now = this.clock.now();
    if (!reactionAllowed(this.reactionsSent, now)) return { ok: false, error: 'throttled' };
    const current = reactionBucket(now);
    const bucket = Math.max(current, this.lastBucket + 1);
    if (bucket > current + 1) return { ok: false, error: 'throttled' };
    this.lastBucket = bucket;
    this.reactionsSent = [...this.reactionsSent.filter((t) => now - t < 60_000), now];
    this.changed();
    try {
      const done = await orTimeout(setDoc(this.refs.reaction(g, this.uid, bucket), newReactionDoc(this.uid, e)), this.timeoutMs);
      return done === TIMEOUT ? { ok: false, error: 'offline' } : { ok: true };
    } catch (err) {
      return { ok: false, error: codeOf(err) === 'unavailable' ? 'offline' : 'rejected' };
    }
  }

  // ---------- Plumbing ----------

  private changed(): void {
    const s = this.snapshot();
    for (const fn of this.subs) {
      try {
        fn(s);
      } catch {
        // a broken subscriber must not break the session
      }
    }
  }
}
