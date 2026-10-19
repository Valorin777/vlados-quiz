// Unit tests for the pure host logic. A tiny in-memory "Firestore" (game doc, private/totals,
// players, answers) is driven through step() exactly like the driver does; answers go through a
// mirror of the security rules (phase, round, window, kicked, create-only).

import { DEFAULT_SCORING, defaultSettings } from '@shared/defaults';
import { FB_LIMITS, type AnswerDoc, type GameDoc, type PlayerDoc, type RoundPub } from '@shared/fbtypes';
import { roundSeed, shownOrder } from '@shared/engine/select';
import { WATCH } from '@shared/engine/watch';
import { correctOrder, scoreAnswer } from '@shared/scoring';
import type { AnswerPayload, ChoiceQ, NumberQ, OrderingQ, Question, Settings } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { HOST_TIMING, type HostInput, type LeaseDoc, type MediaIndex, type TotalsDoc } from './model';
import {
  answerPrecheck,
  checkedName,
  computeReveal,
  answeredPushGapMs,
  countsPushDue,
  emptyTotals,
  hostContent,
  hostDeadline,
  hostEvent,
  initialGameDoc,
  leaseAction,
  leaseHeld,
  liveCounts,
  newLease,
  normalizeSettings,
  numberDist,
  publicRound,
  refreshedGame,
  playersPushGapMs,
  reactionAllowed,
  referencedMediaIds,
  packResult,
  resultsOf,
  serverElapsedMs,
  unpackResult,
  step,
  stripUndefined,
  toEngineCmd,
  toEngineState,
  validAnswerPayload,
  type HostCommand,
  type HostContent,
  type StepOut,
} from './pure';

// ---------- Fixtures ----------

const T0 = 1_800_000_000_000;
const INTRO = 4000;
const LOCK = 1500;
const DELAY = 1200;
const REVEAL_WAIT = LOCK + HOST_TIMING.revealGraceMs;

const Q1: ChoiceQ = {
  id: 'q1',
  type: 'choice',
  title: 'Какой цвет любит Владос?',
  options: [
    { id: 'red', text: 'Красный' },
    { id: 'blue', text: 'Синий' },
    { id: 'green', text: 'Зелёный', mediaId: 'img-green' },
  ],
  correctId: 'blue',
  revealText: 'Конечно синий',
  notes: 'ЗАМЕТКА-АДМИНА',
  media: { mediaId: 'img-q1', onPhones: false },
  revealMedia: { mediaId: 'img-reveal', onPhones: true },
  timeLimitS: 20,
  double: false,
};

const Q2: NumberQ = {
  id: 'q2',
  type: 'number',
  title: 'Сколько весит торт?',
  answer: 100,
  unit: 'г',
  min: 0,
  max: 1000,
  step: 1,
  tolerance: 5,
  zeroAt: 50,
  timeLimitS: 30,
  double: true,
};

const Q3: OrderingQ = {
  id: 'q3',
  type: 'ordering',
  title: 'Расставь по порядку',
  items: [
    { id: 'a', text: 'Первое' },
    { id: 'b', text: 'Второе' },
    { id: 'c', text: 'Третье' },
    { id: 'd', text: 'Четвёртое' },
  ],
  firstLabel: 'Раньше',
  lastLabel: 'Позже',
  timeLimitS: 30,
  double: false,
};

const QX: ChoiceQ = { ...Q1, id: 'qx', title: 'Выключен', disabled: true };

/** The driver passes a fresh random seed per transaction; tests pin one. */
const SHUFFLE_SEED = 0x5eed1234;

const MEDIA: MediaIndex = {
  'img-q1': { kind: 'image' },
  'vid-1': { kind: 'video', posterId: 'img-poster' },
  'img-reveal': { kind: 'image' },
};

function content(patch: Partial<Settings> = {}, questions: Question[] = [Q1, Q2, Q3, QX]): HostContent {
  const settings: Settings = { ...defaultSettings(), introMs: INTRO, lockMs: LOCK, allAnsweredDelayMs: DELAY, ...patch };
  return { rev: 1, settings, questions };
}

// ---------- Simulated Firestore ----------

class Sim {
  gameId = 'g1';
  game: GameDoc;
  totals: TotalsDoc | null;
  players: Record<string, PlayerDoc> = {};
  answers: AnswerDoc[] = [];
  now = T0;
  writes = 0;
  last: StepOut | null = null;
  /** A TV holds the lease (the driver passes tvOnAir(lease)); false → short watch fallback. */
  tv = true;

  constructor(
    public content: HostContent = hostContentFor(),
    public media: MediaIndex = MEDIA,
  ) {
    this.game = initialGameDoc(this.content.settings);
    this.totals = emptyTotals(T0);
  }

  input(): HostInput {
    const i = this.game.round?.i;
    return { gameId: this.gameId, game: this.game, totals: this.totals, players: this.players, answers: this.answers.filter((a) => a.round === i) };
  }

  join(uid: string, name = uid, at = this.now): void {
    this.players[uid] = { name, seed: 7, joinedAt: at, kicked: false, seenAt: at };
  }

  private apply(out: StepOut): StepOut {
    this.last = out;
    if (!out.changed) return out;
    this.writes++;
    this.game = out.game;
    this.totals = out.totals;
    for (const k of out.kicked) (this.players[k.uid] as PlayerDoc).kicked = k.kicked;
    if (out.newGame) {
      this.gameId = out.gameId;
      this.players = {};
      this.answers = [];
    }
    return out;
  }

  cmd(c: HostCommand, at = this.now, newGameId?: string): StepOut {
    this.now = at;
    const ev = hostEvent(c, this.totals);
    if (!ev) throw new Error(`not an engine command: ${c.type}`);
    return this.apply(
      step(this.input(), ev, at, { content: this.content, players: this.players, media: this.media, shuffleSeed: SHUFFLE_SEED, tv: this.tv, ...(newGameId ? { newGameId } : {}) }),
    );
  }

  tick(at = this.now): StepOut {
    this.now = at;
    return this.apply(step(this.input(), { t: 'tick' }, at, { content: this.content, players: this.players, media: this.media, shuffleSeed: SHUFFLE_SEED, tv: this.tv }));
  }

  deadline(): number | null {
    return hostDeadline(this.input(), this.content);
  }

  /** Runs every timed transition due up to `t`, in order, like the driver's timer. */
  runUntil(t: number): void {
    for (let i = 0; i < 50; i++) {
      const d = this.deadline();
      if (d === null || d > t) break;
      this.tick(Math.max(d, this.now));
    }
    this.now = Math.max(this.now, t);
  }

  /** Mirror of the answer rules; returns null when the write would be accepted. */
  answer(uid: string, p: AnswerPayload, at = this.now, round = this.game.round?.i ?? -1): string | null {
    const g = this.game;
    const me = this.players[uid];
    if (!me || me.kicked) return 'denied:player';
    // open / locked, or an intro past its openAt (a late host: phones open by the clock), not paused
    if (!(g.phase === 'open' || g.phase === 'locked' || (g.phase === 'intro' && !g.pause)) || !g.round || g.round.i !== round) return 'denied:phase';
    if (at < g.round.openAt - FB_LIMITS.answerEarlyMs || at > g.round.endsAt + FB_LIMITS.answerLateMs) return 'denied:window';
    if (this.answers.some((a) => a.round === round && a.uid === uid)) return 'denied:exists';
    this.answers.push({ uid, round, p, at });
    return null;
  }

  get round(): RoundPub {
    if (!this.game.round) throw new Error('no round on air');
    return this.game.round;
  }
}

function hostContentFor(patch: Partial<Settings> = {}, questions?: Question[]): HostContent {
  return content(patch, questions);
}

const choice = (id: string): AnswerPayload => ({ t: 'choice', id });
const num = (v: number): AnswerPayload => ({ t: 'number', v });
const order = (...ids: string[]): AnswerPayload => ({ t: 'ordering', ids });

const pts = (q: Question, p: AnswerPayload, elapsedMs: number, closest = false) => scoreAnswer(q, { p, elapsedMs }, DEFAULT_SCORING, closest).points;

/** Decoded results of the first round. */
const res0 = (sim: Sim) => resultsOf(sim.totals?.rounds[0] ?? {});

/** Starts the first question and opens it. */
function openFirst(sim: Sim): void {
  sim.cmd({ type: 'start' });
  sim.runUntil(sim.round.openAt);
  expect(sim.game.phase).toBe('open');
}

// ---------- publicRound ----------

describe('publicRound', () => {
  it('builds the round without any correct answer', () => {
    const r = publicRound(Q1, 3, 10, T0, { introMs: INTRO }, { media: MEDIA });
    expect(r).toMatchObject({ i: 3, n: 4, total: 10, qid: 'q1', type: 'choice', introAt: T0, openAt: T0 + INTRO, endsAt: T0 + INTRO + 20_000 });
    expect(r.options).toEqual([
      { id: 'red', text: 'Красный' },
      { id: 'blue', text: 'Синий' },
      { id: 'green', text: 'Зелёный', mediaId: 'img-green' },
    ]);
    expect(r.media).toEqual({ mediaId: 'img-q1', kind: 'image', onPhones: false });
    const json = JSON.stringify(r);
    for (const secret of ['correctId', 'Конечно синий', 'ЗАМЕТКА', 'revealMedia', 'img-reveal']) expect(json).not.toContain(secret);

    const n = publicRound(Q2, 0, 1, T0, { introMs: INTRO });
    expect(n.number).toEqual({ step: 1, min: 0, max: 1000, unit: 'г' });
    expect(JSON.stringify(n)).not.toMatch(/answer|tolerance|zeroAt|"100"/);
    expect(n.endsAt - n.openAt).toBe(30_000);
  });

  it('omits media whose file is unknown (never publishes a broken reference)', () => {
    expect(publicRound(Q1, 0, 1, T0, { introMs: 0 }).media).toBeUndefined();
  });

  it('ordering: deterministic shuffle that is never the correct order (n ≥ 3)', () => {
    for (const n of [3, 4, 5, 6]) {
      const q: OrderingQ = { ...Q3, items: Q3.items.concat({ id: 'e' }, { id: 'f' }).slice(0, n) };
      const correct = correctOrder(q).join();
      const seen = new Set<string>();
      for (let i = 0; i < 200; i++) {
        const r = publicRound({ ...q, id: `q-${i % 7}` }, i, 10, T0, { introMs: 0 });
        const ids = (r.items ?? []).map((it) => it.id);
        expect(ids.join()).not.toBe(correct);
        expect([...ids].sort()).toEqual(correctOrder(q).sort());
        expect(r).not.toHaveProperty('options');
        seen.add(ids.join());
      }
      expect(seen.size).toBeGreaterThan(1);
    }
    const a = publicRound(Q3, 2, 5, T0, { introMs: 0 });
    const b = publicRound(Q3, 2, 5, T0 + 99, { introMs: 0 });
    expect(a.items).toEqual(b.items);
    expect(a).toMatchObject({ firstLabel: 'Раньше', lastLabel: 'Позже' });
    // An explicit shared order is used as is.
    expect(publicRound(Q3, 0, 1, T0, { introMs: 0 }, { shown: ['d', 'c', 'b', 'a'] }).items?.map((x) => x.id)).toEqual(['d', 'c', 'b', 'a']);
  });
});

// ---------- Elapsed time from server times ----------

describe('serverElapsedMs', () => {
  const r = { openAt: T0 };
  it('is at − openAt clamped to [0, T]', () => {
    expect(serverElapsedMs(T0 + 1234, r, null, 20_000)).toBe(1234);
    expect(serverElapsedMs(T0 - 400, r, null, 20_000)).toBe(0);
    expect(serverElapsedMs(T0 + 21_500, r, null, 20_000)).toBe(20_000);
  });

  it('freezes during a pause and adds back the shift of later resumes', () => {
    // Opened at T0; paused at +6 s for 30 s → openAt moved to T0 + 30 s.
    const paused = { openAt: T0 + 30_000, pauses: [{ s: T0 + 6_000, e: T0 + 36_000, sh: 30_000 }] };
    expect(serverElapsedMs(T0 + 2_000, paused, null, 60_000)).toBe(2_000); // before the pause
    expect(serverElapsedMs(T0 + 20_000, paused, null, 60_000)).toBe(6_000); // during: frozen
    expect(serverElapsedMs(T0 + 40_000, paused, null, 60_000)).toBe(10_000); // after: 6 s + 4 s
    // Ongoing pause (not resumed yet): frozen at its start.
    expect(serverElapsedMs(T0 + 9_000, r, { at: T0 + 6_000 }, 60_000)).toBe(6_000);
    // Two pauses.
    const two = {
      openAt: T0 + 15_000,
      pauses: [
        { s: T0 + 5_000, e: T0 + 10_000, sh: 5_000 },
        { s: T0 + 20_000, e: T0 + 30_000, sh: 10_000 },
      ],
    };
    expect(serverElapsedMs(T0 + 1_000, two, null, 60_000)).toBe(1_000);
    expect(serverElapsedMs(T0 + 12_000, two, null, 60_000)).toBe(7_000);
    expect(serverElapsedMs(T0 + 25_000, two, null, 60_000)).toBe(15_000);
    expect(serverElapsedMs(T0 + 31_000, two, null, 60_000)).toBe(16_000);
    // A pause cleared by a lock (no shift): answers inside it are frozen, later ones are not.
    const cleared = { openAt: T0, pauses: [{ s: T0 + 5_000, e: T0 + 8_000, sh: 0 }] };
    expect(serverElapsedMs(T0 + 6_000, cleared, null, 60_000)).toBe(5_000);
    expect(serverElapsedMs(T0 + 9_000, cleared, null, 60_000)).toBe(9_000);
  });
});

// ---------- Full game through step() ----------

describe('state machine on the docs', () => {
  it('lobby → intro → open → locked → reveal → board → … → final, one write per transition', () => {
    const sim = new Sim();
    sim.join('p1');
    sim.join('p2');
    expect(sim.game.phase).toBe('lobby');
    expect(sim.deadline()).toBeNull();
    expect(sim.tick().changed).toBe(false);

    const start = sim.cmd({ type: 'start' });
    expect(start.ok).toBe(true);
    expect(sim.game).toMatchObject({ phase: 'intro', phaseRev: 1, answered: 0, players: 2, reveal: null, next: null });
    expect(sim.round).toMatchObject({ i: 0, n: 1, total: 3, qid: 'q1', introAt: T0, openAt: T0 + INTRO, endsAt: T0 + INTRO + 20_000 });
    expect(sim.totals?.rounds[0]).toMatchObject({ i: 0, qid: 'q1', q: { correctId: 'blue' } });
    expect(JSON.stringify(sim.game)).not.toContain('correctId');
    // Answers are refused by the rules during the intro (before openAt − 0.5 s).
    expect(sim.answer('p1', choice('blue'), T0 + 1000)).toBe('denied:window');

    expect(sim.deadline()).toBe(T0 + INTRO);
    sim.runUntil(T0 + INTRO);
    expect(sim.game).toMatchObject({ phase: 'open', phaseRev: 2 });
    expect(sim.answer('p1', choice('blue'), T0 + INTRO + 5_000)).toBeNull();
    expect(sim.answer('p1', choice('red'), T0 + INTRO + 6_000)).toBe('denied:exists');
    expect(liveCounts(sim.input())).toEqual({ answered: 1, players: 2 });

    const endsAt = sim.round.endsAt;
    expect(sim.deadline()).toBe(endsAt);
    sim.runUntil(endsAt);
    expect(sim.game).toMatchObject({ phase: 'locked', phaseRev: 3, reveal: null });
    // Latency grace: still accepted by the rules while locked, up to endsAt + 2 s.
    expect(sim.answer('p2', choice('red'), endsAt + 1_500)).toBeNull();
    expect(sim.deadline()).toBe(endsAt + REVEAL_WAIT);
    sim.runUntil(endsAt + REVEAL_WAIT);
    expect(sim.game.phase).toBe('reveal');
    const reveal = sim.game.reveal;
    expect(reveal).toMatchObject({ i: 0, correct: 'blue', dist: { red: 1, blue: 1, green: 0 }, pct: 0.5, count: 2, text: 'Конечно синий' });
    expect(reveal?.media).toEqual({ mediaId: 'img-reveal', kind: 'image', onPhones: true });
    const p1pts = pts(Q1, choice('blue'), 5_000);
    expect(reveal?.me.p1).toEqual({ pts: p1pts, tot: p1pts, rank: 1, prev: null, ok: true });
    expect(reveal?.me.p2).toEqual({ pts: 0, tot: 0, rank: 2, prev: null, ok: false });
    expect(res0(sim).p1).toMatchObject({ e: 5_000, pt: p1pts, ok: true, p: choice('blue') });
    expect(sim.game.next).toEqual({ media: [] });

    sim.cmd({ type: 'advance', phaseRev: sim.game.phaseRev });
    expect(sim.game.phase).toBe('board');
    expect(sim.game.reveal?.i).toBe(0); // phones still see their result on the board
    expect(sim.game.board?.top).toEqual([
      { uid: 'p1', name: 'p1', score: p1pts, rank: 1, prev: null, delta: p1pts },
      { uid: 'p2', name: 'p2', score: 0, rank: 2, prev: null, delta: 0 },
    ]);

    sim.cmd({ type: 'advance', phaseRev: sim.game.phaseRev });
    expect(sim.game).toMatchObject({ phase: 'intro', board: null, reveal: null, answered: 0 });
    expect(sim.round).toMatchObject({ i: 1, n: 2, total: 3, qid: 'q2', number: { min: 0, max: 1000, step: 1, unit: 'г' } });

    // Play the rest without answers; the disabled question is never played.
    for (const qid of ['q2', 'q3']) {
      expect(sim.round.qid).toBe(qid);
      sim.runUntil(sim.round.endsAt + REVEAL_WAIT);
      expect(sim.game.phase).toBe('reveal');
      sim.cmd({ type: 'advance', phaseRev: sim.game.phaseRev });
      sim.cmd({ type: 'advance', phaseRev: sim.game.phaseRev });
    }
    expect(sim.game).toMatchObject({ phase: 'final', round: null, reveal: null, board: null, next: null });
    expect(sim.game.final?.step).toBe(0);
    expect(sim.game.final?.podium).toEqual([]);
    for (let stepN = 1; stepN <= 6; stepN++) {
      sim.cmd({ type: 'advance', phaseRev: sim.game.phaseRev });
      expect(sim.game.final?.step).toBe(stepN);
    }
    expect(sim.cmd({ type: 'advance', phaseRev: sim.game.phaseRev })).toMatchObject({ ok: false, error: 'invalid' });
  });

  it('refuses stale and invalid commands without writing', () => {
    const sim = new Sim();
    sim.join('p1');
    expect(sim.cmd({ type: 'advance', phaseRev: 0 })).toMatchObject({ ok: false, error: 'invalid' });
    sim.cmd({ type: 'start' });
    const writes = sim.writes;
    expect(sim.cmd({ type: 'reveal', phaseRev: 0 })).toMatchObject({ ok: false, error: 'stale', changed: false });
    expect(sim.cmd({ type: 'start' })).toMatchObject({ ok: false, error: 'invalid' });
    expect(sim.cmd({ type: 'resume' })).toMatchObject({ ok: false, error: 'invalid' });
    expect(sim.writes).toBe(writes);
    // A double tap: the second one is stale.
    sim.runUntil(sim.round.openAt);
    const rev = sim.game.phaseRev;
    expect(sim.cmd({ type: 'reveal', phaseRev: rev }).ok).toBe(true);
    expect(sim.cmd({ type: 'reveal', phaseRev: rev })).toMatchObject({ ok: false, error: 'stale' });
    // Commands for unknown targets.
    expect(toEngineCmd({ type: 'rescoreRound', round: 99 }, sim.totals)).toBeNull();
    expect(sim.cmd({ type: 'kick', uid: 'nobody' })).toMatchObject({ ok: false, error: 'invalid' });
    expect(sim.cmd({ type: 'setVlados', uid: 'nobody' })).toMatchObject({ ok: false, error: 'invalid' });
    expect(sim.cmd({ type: 'jumpTo', qid: 'nope' })).toMatchObject({ ok: false, error: 'invalid' });
  });

  it('ticks are idempotent: a second host running the same tick writes nothing', () => {
    const sim = new Sim();
    sim.join('p1');
    sim.cmd({ type: 'start' });
    const before = sim.input();
    const a = step(before, { t: 'tick' }, T0 + INTRO, { content: sim.content, players: sim.players, media: {} });
    expect(a.changed).toBe(true);
    const after: HostInput = { ...before, game: a.game, totals: a.totals };
    const b = step(after, { t: 'tick' }, T0 + INTRO + 10, { content: sim.content, players: sim.players, media: {} });
    expect(b.changed).toBe(false);
    // A tick far past several deadlines catches up in one write (intro → open → locked); the
    // reveal still waits lockMs + grace from that late lock, so the last answers can arrive.
    const lateAt = T0 + INTRO + 20_000 + REVEAL_WAIT;
    const late = step(before, { t: 'tick' }, lateAt, { content: sim.content, players: sim.players, media: {} });
    expect(late.game.phase).toBe('locked');
    expect(late.totals.rounds[0]?.lockedAt).toBe(lateAt);
    const revealed = step({ ...before, game: late.game, totals: late.totals }, { t: 'tick' }, lateAt + REVEAL_WAIT, {
      content: sim.content,
      players: sim.players,
      media: {},
    });
    expect(revealed.game.phase).toBe('reveal');
  });

  it('scores with server times; early answers count as 0 ms, answers after endsAt as T', () => {
    const sim = new Sim();
    for (const p of ['p1', 'p2', 'p3', 'p4', 'p5']) sim.join(p);
    sim.cmd({ type: 'start' });
    sim.runUntil(T0 + INTRO - 300);
    // The window opens 500 ms early on the server side (the intro too: phones open by the clock); 0 ms.
    expect(sim.answer('p1', choice('blue'), T0 + INTRO - 300)).toBeNull();
    sim.runUntil(T0 + INTRO);
    const open = sim.round.openAt;
    expect(sim.answer('p1', choice('blue'), open)).toBe('denied:exists');
    expect(sim.answer('p2', choice('blue'), open + 10_000)).toBeNull();
    expect(sim.answer('p3', choice('green'), open + 1_000)).toBeNull();
    sim.runUntil(sim.round.endsAt);
    expect(sim.answer('p4', choice('blue'), sim.round.endsAt + 1_999)).toBeNull();
    expect(sim.answer('p5', choice('blue'), sim.round.endsAt + 2_001)).toBe('denied:window');
    sim.runUntil(sim.round.endsAt + REVEAL_WAIT);
    const me = sim.game.reveal?.me ?? {};
    expect(me.p1?.pts).toBe(1000);
    expect(me.p2?.pts).toBe(pts(Q1, choice('blue'), 10_000));
    expect(me.p2?.pts).toBe(750);
    expect(me.p3).toMatchObject({ pts: 0, ok: false });
    expect(me.p4?.pts).toBe(500); // elapsed clamped to T
    expect(res0(sim).p4?.e).toBe(20_000);
    expect([me.p1, me.p2, me.p4, me.p3, me.p5].map((m) => m?.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it('late answers are ignored: nothing that arrives after the reveal changes results', () => {
    const sim = new Sim();
    sim.join('p1');
    sim.join('p2');
    openFirst(sim);
    sim.answer('p1', choice('blue'), sim.round.openAt + 2_000);
    sim.runUntil(sim.round.endsAt + REVEAL_WAIT);
    const frozen = structuredClone(sim.game.reveal);
    const totals = structuredClone(sim.totals);
    // p2's answer reached the server in time but the host's listener only delivers it now.
    sim.answers.push({ uid: 'p2', round: 0, p: choice('blue'), at: sim.round.endsAt + 1_000 });
    expect(sim.tick(sim.now + 5_000).changed).toBe(false);
    sim.cmd({ type: 'advance', phaseRev: sim.game.phaseRev });
    expect(sim.game.reveal).toEqual(frozen);
    expect(sim.totals?.rounds).toEqual(totals?.rounds);
    expect(sim.game.board?.top.find((r) => r.uid === 'p2')?.score).toBe(0);
    // The rules refuse the write outright once the phase moved on.
    expect(sim.answer('p2', choice('blue'))).toBe('denied:phase');
  });

  it('locks early when every player still in the game answered (after allAnsweredDelayMs)', () => {
    const sim = new Sim();
    sim.join('p1');
    sim.join('p2');
    sim.join('kicked');
    openFirst(sim);
    sim.cmd({ type: 'kick', uid: 'kicked' });
    const open = sim.round.openAt;
    sim.answer('p1', choice('blue'), open + 1_000);
    expect(sim.deadline()).toBe(sim.round.endsAt); // p2 still thinking
    sim.answer('p2', choice('red'), open + 3_000);
    expect(sim.deadline()).toBe(open + 3_000 + DELAY);
    sim.runUntil(open + 3_000 + DELAY);
    expect(sim.game.phase).toBe('locked');
    expect(sim.totals?.rounds[0]?.lockedAt).toBe(open + 3_000 + DELAY);
    sim.runUntil(open + 3_000 + DELAY + REVEAL_WAIT);
    expect(sim.game.phase).toBe('reveal');
    // A late joiner may still write inside the window, but the round is already frozen.
    sim.join('late');
    expect(sim.answer('late', choice('blue'))).toBe('denied:phase');
    expect(sim.game.reveal?.me.late).toBeUndefined();
  });

  it('no early lock without answers, and a kicked player never blocks it', () => {
    const sim = new Sim();
    openFirst(sim);
    expect(sim.deadline()).toBe(sim.round.endsAt);
    sim.join('p1');
    sim.join('p2');
    sim.answer('p1', choice('blue'), sim.round.openAt + 500);
    expect(sim.deadline()).toBe(sim.round.endsAt);
    sim.cmd({ type: 'kick', uid: 'p2' });
    expect(sim.deadline()).toBe(sim.round.openAt + 500 + DELAY);
  });

  it('pause / resume: frozen countdown, answers keep their active time, public window held open', () => {
    const sim = new Sim();
    for (const p of ['a', 'b', 'c']) sim.join(p);
    openFirst(sim);
    const open0 = sim.round.openAt; // T0 + 4 s
    const end0 = sim.round.endsAt; // + 20 s
    sim.answer('a', choice('blue'), open0 + 2_000);
    expect(sim.cmd({ type: 'pause' }, open0 + 6_000).ok).toBe(true);
    expect(sim.game.pause).toEqual({ at: open0 + 6_000, remainingMs: 14_000, reason: 'admin' });
    expect(sim.game.phaseRev).toBe(2); // pause keeps phaseRev
    // The public endsAt is pushed out so an answer during the pause is not refused by the rules…
    expect(sim.round.endsAt).toBe(open0 + 6_000 + 14_000 + HOST_TIMING.pauseHoldMs);
    expect(sim.deadline()).toBeNull();
    expect(sim.cmd({ type: 'pause' }).ok).toBe(false);
    // …and it gets the frozen time (this one is after the original endsAt + 2 s).
    expect(sim.answer('b', choice('blue'), end0 + 5_000)).toBeNull();
    expect(toEngineState(sim.input()).rounds[0]?.answers.b?.elapsedMs).toBe(6_000);
    // Resume 30 s after the pause started: openAt/endsAt move by 30 s.
    sim.cmd({ type: 'resume' }, open0 + 36_000);
    expect(sim.game.pause).toBeNull();
    expect(sim.round.openAt).toBe(open0 + 30_000);
    expect(sim.round.endsAt).toBe(end0 + 30_000);
    expect(sim.totals?.rounds[0]?.pauses).toEqual([{ s: open0 + 6_000, e: open0 + 36_000, sh: 30_000 }]);
    sim.answer('c', choice('blue'), open0 + 40_000); // 6 s before the pause + 4 s after
    sim.runUntil(sim.round.endsAt + REVEAL_WAIT);
    const res = res0(sim);
    expect([res.a?.e, res.b?.e, res.c?.e]).toEqual([2_000, 6_000, 10_000]);
    expect(sim.game.reveal?.me.c?.pts).toBe(pts(Q1, choice('blue'), 10_000));
  });

  it('pause during the intro shifts the opening; addTime works open and paused', () => {
    const sim = new Sim();
    sim.cmd({ type: 'start' });
    sim.cmd({ type: 'pause' }, T0 + 1_000);
    expect(sim.game.pause?.remainingMs).toBe(INTRO + 20_000 - 1_000);
    expect(sim.round.endsAt).toBe(T0 + INTRO + 20_000); // intro: not held open
    sim.cmd({ type: 'addTime', ms: 5_000 }, T0 + 2_000);
    expect(sim.game.pause?.remainingMs).toBe(INTRO + 20_000 - 1_000 + 5_000);
    sim.cmd({ type: 'resume' }, T0 + 10_000);
    expect(sim.round.openAt).toBe(T0 + INTRO + 9_000);
    expect(sim.round.endsAt).toBe(T0 + INTRO + 9_000 + 25_000);
    sim.runUntil(sim.round.openAt);
    expect(sim.game.phase).toBe('open');
    const end = sim.round.endsAt;
    sim.cmd({ type: 'addTime', ms: 10_000 });
    expect(sim.round.endsAt).toBe(end + 10_000);
    // Never below the opening: a huge negative addTime ends the question now.
    sim.cmd({ type: 'addTime', ms: -10_000_000 });
    expect(sim.round.endsAt).toBe(sim.round.openAt);
    sim.tick();
    expect(sim.game.phase).toBe('locked');
    expect(sim.cmd({ type: 'addTime', ms: 1_000 }).ok).toBe(false);
  });

  it('reveal during a pause locks at once; answers inside the pause keep the frozen time', () => {
    const sim = new Sim();
    sim.join('a');
    sim.join('b');
    openFirst(sim);
    const open = sim.round.openAt;
    sim.cmd({ type: 'pause' }, open + 5_000);
    sim.answer('a', choice('blue'), open + 8_000);
    sim.cmd({ type: 'reveal', phaseRev: sim.game.phaseRev }, open + 9_000);
    expect(sim.game).toMatchObject({ phase: 'locked', pause: null });
    expect(sim.totals?.rounds[0]?.pauses).toEqual([{ s: open + 5_000, e: open + 9_000, sh: 0 }]);
    expect(sim.answer('b', choice('blue'), open + 9_500)).toBeNull();
    sim.cmd({ type: 'reveal', phaseRev: sim.game.phaseRev }, open + 10_000);
    expect(sim.game.phase).toBe('reveal');
    expect(res0(sim).a?.e).toBe(5_000);
    expect(res0(sim).b?.e).toBe(9_500);
  });

  it('skip marks the round skipped (no points) and moves on; the number stays consecutive', () => {
    const sim = new Sim();
    sim.join('p1');
    openFirst(sim);
    sim.answer('p1', choice('blue'), sim.round.openAt + 1_000);
    sim.cmd({ type: 'skip', phaseRev: sim.game.phaseRev });
    expect(sim.game.phase).toBe('intro');
    expect(sim.round).toMatchObject({ i: 1, n: 1, total: 2, qid: 'q2' });
    expect(sim.totals?.rounds[0]).toMatchObject({ skipped: true });
    expect(sim.totals?.rounds[0]?.res).toBeUndefined();
    expect(sim.cmd({ type: 'skip', phaseRev: sim.game.phaseRev }).ok).toBe(true);
    expect(sim.round.qid).toBe('q3');
    sim.cmd({ type: 'skip', phaseRev: sim.game.phaseRev });
    expect(sim.game.phase).toBe('final');
    expect(sim.game.final?.step).toBe(0);
    expect(sim.cmd({ type: 'skip', phaseRev: sim.game.phaseRev })).toMatchObject({ ok: false, error: 'invalid' });
  });

  it('jumpTo plays any question (skipping the one on air), end goes to the final', () => {
    const sim = new Sim();
    sim.join('p1');
    sim.cmd({ type: 'jumpTo', qid: 'q3' });
    expect(sim.round).toMatchObject({ i: 0, qid: 'q3', type: 'ordering' });
    expect(correctOrder(Q3)).not.toEqual(sim.round.items?.map((x) => x.id));
    sim.runUntil(sim.round.openAt);
    sim.cmd({ type: 'jumpTo', qid: 'qx' }); // disabled questions can be jumped to
    expect(sim.round).toMatchObject({ i: 1, qid: 'qx' });
    expect(sim.totals?.rounds[0]?.skipped).toBe(true);
    // A skipped question may be played again.
    sim.cmd({ type: 'jumpTo', qid: 'q3' });
    expect(sim.round).toMatchObject({ i: 2, qid: 'q3' });
    sim.runUntil(sim.round.endsAt + REVEAL_WAIT);
    expect(sim.game.phase).toBe('reveal');
    expect(sim.cmd({ type: 'jumpTo', qid: 'q3' })).toMatchObject({ ok: false, error: 'invalid' }); // scored already
    sim.cmd({ type: 'end' });
    expect(sim.game.phase).toBe('final');
    expect(sim.totals?.rounds.map((r) => r.skipped === true)).toEqual([true, true, false]);
    expect(sim.cmd({ type: 'end' }).ok).toBe(false);
  });

  it('end during a question skips it', () => {
    const sim = new Sim();
    openFirst(sim);
    sim.cmd({ type: 'end' });
    expect(sim.game.phase).toBe('final');
    expect(sim.totals?.rounds[0]?.skipped).toBe(true);
  });

  it('resetScores keeps players, clears rounds and never reuses an answer id', () => {
    const sim = new Sim();
    sim.join('p1');
    openFirst(sim);
    sim.answer('p1', choice('blue'), sim.round.openAt + 1_000);
    sim.runUntil(sim.round.endsAt + REVEAL_WAIT);
    expect(sim.game.reveal?.me.p1?.tot).toBeGreaterThan(0);
    sim.cmd({ type: 'resetScores' });
    expect(sim.game).toMatchObject({ phase: 'lobby', round: null, reveal: null, players: 1 });
    expect(sim.totals).toMatchObject({ iBase: 1, rounds: [] });
    sim.cmd({ type: 'start' });
    expect(sim.round).toMatchObject({ i: 1, n: 1, qid: 'q1' });
    sim.runUntil(sim.round.openAt);
    // The old answer doc (round 0) is still in Firestore but belongs to another round.
    expect(liveCounts(sim.input()).answered).toBe(0);
    expect(sim.answer('p1', choice('red'), sim.round.openAt + 1_000)).toBeNull();
    sim.runUntil(sim.round.endsAt + REVEAL_WAIT);
    expect(sim.game.reveal?.me.p1).toMatchObject({ pts: 0, tot: 0 });
  });

  it('newGame starts a fresh game id with no players', () => {
    const sim = new Sim();
    sim.join('p1');
    openFirst(sim);
    sim.cmd({ type: 'setVlados', uid: 'p1' });
    const out = sim.cmd({ type: 'newGame' }, sim.now, 'g2');
    expect(out).toMatchObject({ ok: true, newGame: true, gameId: 'g2' });
    expect(sim.game).toMatchObject({ phase: 'lobby', players: 0, vladosUid: null, round: null, banner: null });
    expect(sim.totals).toMatchObject({ iBase: 0, rounds: [] });
    sim.cmd({ type: 'start' });
    expect(sim.round).toMatchObject({ i: 0, qid: 'q1' });
  });

  it('rescoreRound re-freezes the question from content and recomputes that round only', () => {
    const sim = new Sim();
    sim.join('p1');
    sim.join('p2');
    openFirst(sim);
    sim.answer('p1', choice('blue'), sim.round.openAt + 2_000);
    sim.answer('p2', choice('red'), sim.round.openAt + 4_000);
    sim.runUntil(sim.round.endsAt + REVEAL_WAIT);
    expect(sim.game.reveal?.me.p2?.pts).toBe(0);
    // The organizer typed the wrong key: red was right. (A longer time limit is ignored.)
    sim.content = { ...sim.content, rev: 2, questions: [{ ...Q1, correctId: 'red', timeLimitS: 99 }, Q2, Q3, QX] };
    const i = sim.totals?.rounds[0]?.i ?? -1;
    expect(sim.cmd({ type: 'rescoreRound', round: i }).ok).toBe(true);
    expect(sim.totals?.rounds[0]?.q).toMatchObject({ correctId: 'red', timeLimitS: 20 });
    expect(sim.game.reveal).toMatchObject({ correct: 'red', pct: 0.5 });
    expect(sim.game.reveal?.me.p2).toMatchObject({ pts: pts({ ...Q1, correctId: 'red' }, choice('red'), 4_000), ok: true, rank: 1 });
    expect(sim.game.reveal?.me.p2?.pts).toBe(900);
    expect(sim.game.reveal?.me.p1).toMatchObject({ pts: 0, rank: 2 });
    // Not before it was scored; not for a changed question type.
    sim.cmd({ type: 'advance', phaseRev: sim.game.phaseRev });
    sim.cmd({ type: 'advance', phaseRev: sim.game.phaseRev });
    expect(sim.cmd({ type: 'rescoreRound', round: 1 })).toMatchObject({ ok: false, error: 'invalid' });
    sim.content = { ...sim.content, questions: [{ ...Q2, id: 'q1' } as Question, Q2, Q3] };
    expect(sim.cmd({ type: 'rescoreRound', round: 0 })).toMatchObject({ ok: false, error: 'invalid' });
  });

  it('kick / unkick update the player docs and the public list; kicked answers do not count', () => {
    const sim = new Sim();
    sim.join('p1');
    sim.join('p2');
    openFirst(sim);
    sim.answer('p1', choice('blue'), sim.round.openAt + 1_000);
    const out = sim.cmd({ type: 'kick', uid: 'p1' });
    expect(out.kicked).toEqual([{ uid: 'p1', kicked: true }]);
    expect(sim.game).toMatchObject({ kicked: ['p1'], players: 1, answered: 0 });
    expect(sim.cmd({ type: 'kick', uid: 'p1' })).toMatchObject({ ok: true, changed: false });
    sim.runUntil(sim.round.endsAt + REVEAL_WAIT);
    expect(sim.game.reveal).toMatchObject({ count: 0, dist: { blue: 0 } });
    expect(sim.game.reveal?.me.p1).toBeUndefined();
    sim.cmd({ type: 'unkick', uid: 'p1' });
    expect(sim.players.p1?.kicked).toBe(false);
    expect(sim.game.kicked).toBeUndefined();
    // Frozen results stay as they were (the answer was not counted).
    expect(sim.game.reveal?.me.p1).toMatchObject({ pts: 0, tot: 0 });
  });

  it('banner: trimmed, cleared by empty text, limited to bannerMax', () => {
    const sim = new Sim();
    sim.cmd({ type: 'banner', text: '  Торт через 5 минут  ' });
    expect(sim.game.banner).toBe('Торт через 5 минут');
    sim.cmd({ type: 'banner', text: '   ' });
    expect(sim.game.banner).toBeNull();
    expect(toEngineCmd({ type: 'banner', text: 'x'.repeat(FB_LIMITS.bannerMax + 1) }, null)).toBeNull();
    expect(toEngineCmd({ type: 'rename', uid: 'p', name: 'x' }, null)).toBeNull();
  });

  it('autopilot off, auto-advance: reveal → board → next question → final steps', () => {
    const sim = new Sim(content({ autopilot: false, autoAdvance: { revealToBoardS: 8, boardToNextS: 6, finalStepS: 4 } }, [Q1]));
    sim.join('p1');
    openFirst(sim);
    sim.runUntil(sim.round.endsAt + REVEAL_WAIT);
    const revealAt = sim.now;
    expect(sim.deadline()).toBe(revealAt + 8_000);
    sim.runUntil(revealAt + 8_000);
    expect(sim.game.phase).toBe('board');
    sim.runUntil(revealAt + 14_000);
    expect(sim.game.phase).toBe('final');
    sim.runUntil(revealAt + 14_000 + 5 * 4_000);
    expect(sim.game.final?.step).toBe(5);
    // the mosaic starts the video after the final 5 s in (not finalStepS); its end moves nothing
    sim.runUntil(revealAt + 14_000 + 5 * 4_000 + 5_000);
    expect(sim.game.final?.step).toBe(6);
    expect(sim.game.final?.video).toMatchObject({ at: revealAt + 14_000 + 5 * 4_000 + 5_000 + 2_800 });
    expect(sim.deadline()).toBeNull();
  });
});

// ---------- Vlados, number and ordering reveals, final ----------

describe('reveal details', () => {
  it('Vlados: out of competition, excluded from pct/dist/closest, his answer shown', () => {
    const sim = new Sim(content({}, [Q2]));
    for (const p of ['vlad', 'g1', 'g2', 'g3']) sim.join(p);
    sim.cmd({ type: 'setVlados', uid: 'vlad' });
    expect(sim.game.vladosUid).toBe('vlad');
    openFirst(sim);
    const open = sim.round.openAt;
    sim.answer('vlad', num(100), open + 1_000); // exact
    sim.answer('g1', num(120), open + 2_000);
    sim.answer('g2', num(80), open + 3_000); // tied closest guest with g1
    sim.answer('g3', num(400), open + 4_000);
    sim.runUntil(open + 4_000 + DELAY + REVEAL_WAIT);
    const r = sim.game.reveal;
    expect(r).toMatchObject({ correct: 100, vlados: num(100), count: 3, dist: { '80': 1, '120': 1, '400': 1 } });
    expect(r?.bin).toBeUndefined();
    expect(r?.me.vlad).toMatchObject({ rank: null, prev: null, ok: true, cl: true });
    expect(r?.me.g1).toMatchObject({ cl: true, ok: true, rank: 1 });
    expect(r?.me.g2).toMatchObject({ cl: true, ok: true, rank: 2 });
    expect(r?.me.g3).toMatchObject({ ok: false, rank: 3 });
    expect(r?.me.g3?.cl).toBeUndefined();
    expect(r?.pct).toBeCloseTo(2 / 3, 4);
    // Double question: the closest bonus (0.2) counts, accuracy share by distance.
    expect(r?.me.g1?.pts).toBe(pts(Q2, num(120), 2_000, true));
    expect(r?.me.g1?.acc).toBeGreaterThan(0);
    sim.cmd({ type: 'advance', phaseRev: sim.game.phaseRev });
    expect(sim.game.board?.top.map((x) => x.uid)).toEqual(['g1', 'g2', 'g3']);
  });

  it('ordering: dist counts items in the right place; exact order is correct', () => {
    const sim = new Sim(content({}, [Q3]));
    for (const p of ['a', 'b', 'c']) sim.join(p);
    openFirst(sim);
    const open = sim.round.openAt;
    sim.answer('a', order('a', 'b', 'c', 'd'), open + 3_000);
    sim.answer('b', order('b', 'a', 'c', 'd'), open + 3_000);
    sim.answer('c', order('d', 'c', 'b', 'a'), open + 3_000);
    sim.runUntil(sim.deadline() ?? 0);
    sim.runUntil(sim.deadline() ?? 0);
    const r = sim.game.reveal;
    expect(r).toMatchObject({ correct: ['a', 'b', 'c', 'd'], dist: { '0': 1, '1': 0, '2': 1, '3': 0, '4': 1 }, count: 3 });
    expect(r?.pct).toBeCloseTo(1 / 3, 4);
    expect(r?.me.a).toMatchObject({ ok: true, pts: pts(Q3, order('a', 'b', 'c', 'd'), 3_000) });
    expect(r?.me.b?.acc).toBeCloseTo(0.7 * (5 / 6) ** 2, 2);
    expect(r?.me.c).toMatchObject({ ok: false, pts: 0 });
  });

  it('prev ranks and deltas across rounds; the final reveals the podium step by step', () => {
    const sim = new Sim(content({}, [Q1, { ...Q1, id: 'q1b' }]));
    for (const p of ['a', 'b', 'c', 'd', 'v']) sim.join(p);
    sim.players.a = { ...(sim.players.a as PlayerDoc), thumb: new Uint8Array([1, 2, 3]) };
    sim.cmd({ type: 'setVlados', uid: 'v' });
    openFirst(sim);
    let open = sim.round.openAt;
    sim.answer('a', choice('blue'), open + 1_000);
    sim.answer('b', choice('blue'), open + 2_000);
    sim.answer('c', choice('red'), open + 3_000);
    sim.answer('v', choice('blue'), open + 500);
    sim.runUntil(sim.round.endsAt + REVEAL_WAIT);
    sim.cmd({ type: 'advance', phaseRev: sim.game.phaseRev });
    sim.cmd({ type: 'advance', phaseRev: sim.game.phaseRev });
    sim.runUntil(sim.round.openAt);
    open = sim.round.openAt;
    sim.answer('c', choice('blue'), open);
    sim.answer('b', choice('blue'), open + 100);
    sim.answer('v', choice('red'), open + 100);
    sim.runUntil(sim.round.endsAt + REVEAL_WAIT);
    const me = sim.game.reveal?.me ?? {};
    // Round 1: a 975, b 950, c 0. Round 2: c 1000, b 998 → b 1948, c 1000, a 975.
    expect(me.b).toMatchObject({ prev: 2, rank: 1, tot: 1948 });
    expect(me.c).toMatchObject({ prev: 3, rank: 2, pts: 1000 });
    expect(me.a).toMatchObject({ prev: 1, rank: 3, pts: 0 });
    expect(me.v).toMatchObject({ rank: null, prev: null });
    sim.cmd({ type: 'advance', phaseRev: sim.game.phaseRev });
    expect(sim.game.board?.top.map((r) => [r.uid, r.rank, r.prev, r.delta])).toEqual([
      ['b', 1, 2, pts(Q1, choice('blue'), 100)],
      ['c', 2, 3, 1000],
      ['a', 3, 1, 0],
      ['d', 4, 4, 0],
    ]);
    sim.cmd({ type: 'advance', phaseRev: sim.game.phaseRev });
    expect(sim.game.phase).toBe('final');
    const podiumAt = (stepN: number) => {
      while ((sim.game.final?.step ?? 0) < stepN) sim.cmd({ type: 'advance', phaseRev: sim.game.phaseRev });
      return sim.game.final;
    };
    expect(podiumAt(0)).toMatchObject({ step: 0, podium: [], vlados: null });
    expect(podiumAt(0)?.me).toBeUndefined();
    expect(podiumAt(1)?.podium.map((r) => [r.uid, r.rank])).toEqual([['a', 3]]);
    expect(podiumAt(2)?.podium.map((r) => r.rank)).toEqual([2, 3]);
    const f3 = podiumAt(3);
    expect(f3?.podium.map((r) => r.uid)).toEqual(['b', 'c', 'a']);
    expect(f3?.podium[2]?.thumb).toEqual(new Uint8Array([1, 2, 3]));
    expect(f3?.podium[0]?.thumb).toBeUndefined();
    expect(f3?.me?.d).toEqual({ tot: 0, rank: 4 });
    expect(f3?.me?.v).toMatchObject({ rank: null });
    const f4 = podiumAt(4);
    // Vlados 1 of 2; guests who answered ≥ half: a 0.5, b 1, c 0.5 (d never answered).
    expect(f4?.vlados).toEqual({
      uid: 'v',
      name: 'v',
      verdict: 'worst',
      vladosAccuracy: 0.5,
      guestsAccuracy: 0.67,
      best: { uid: 'b', name: 'b', accuracy: 1 },
    });
  });
});

describe('computeReveal (standalone)', () => {
  const players: Record<string, PlayerDoc> = Object.fromEntries(
    ['a', 'b', 'c', 'v'].map((uid, k) => [uid, { name: uid.toUpperCase(), seed: k, joinedAt: T0 + k, kicked: false, seenAt: T0 }]),
  );

  it('scores raw answers with server times and builds reveal, board, podium, Vlados', () => {
    const out = computeReveal({
      i: 4,
      q: Q1,
      answers: [
        { uid: 'a', p: choice('blue'), at: T0 + 4_000 },
        { uid: 'b', p: choice('blue'), at: T0 + 30_000 },
        { uid: 'c', p: choice('green'), at: T0 + 1_000 },
        { uid: 'v', p: choice('blue'), at: T0 },
        { uid: 'ghost', p: choice('blue'), at: T0 },
      ],
      players,
      vladosUid: 'v',
      scoring: DEFAULT_SCORING,
      openAt: T0,
      media: MEDIA,
    });
    expect(out.reveal).toMatchObject({ i: 4, correct: 'blue', dist: { red: 0, blue: 2, green: 1 }, count: 3, vlados: choice('blue') });
    expect(out.reveal.pct).toBeCloseTo(2 / 3, 4);
    expect(out.res.a).toMatchObject({ e: 4_000, pt: 900 });
    expect(out.res.b).toMatchObject({ e: 20_000, pt: 500 });
    expect(out.res.ghost).toBeUndefined(); // not a player
    expect(out.board.top.map((r) => r.uid)).toEqual(['a', 'b', 'c']);
    expect(out.podium.map((r) => [r.uid, r.rank, r.name])).toEqual([
      ['a', 1, 'A'],
      ['b', 2, 'B'],
      ['c', 3, 'C'],
    ]);
    expect(out.vlados).toMatchObject({ uid: 'v', verdict: 'best' });
    expect(out.totals.v).toEqual({ tot: 1000, rank: null });
  });

  it('adds history, time limit override, pauses and kicked players', () => {
    const first = computeReveal({ i: 0, q: Q1, answers: [{ uid: 'c', p: choice('blue'), at: T0 }], players, vladosUid: null, scoring: DEFAULT_SCORING, openAt: T0 });
    const rows = Object.fromEntries(Object.entries(first.res).map(([uid, x]) => [uid, packResult(x)]));
    const history = [{ i: 0, qid: 'q1', q: Q1, introAt: T0, openAt: T0, endsAt: T0 + 20_000, res: rows }];
    const out = computeReveal({
      i: 1,
      q: Q1,
      timeLimitS: 10,
      answers: [
        { uid: 'a', p: choice('blue'), at: T0 + 5_000 },
        { uid: 'b', p: choice('blue'), at: T0 + 5_000 },
      ],
      pauses: [{ s: T0 + 1_000, e: T0 + 4_000, sh: 3_000 }],
      players,
      kicked: ['b'],
      vladosUid: null,
      scoring: DEFAULT_SCORING,
      openAt: T0 + 3_000,
      history,
    });
    // Opened at T0, paused 1 s → 4 s (openAt moved to T0 + 3 s): 1 s before + 1 s after the pause.
    expect(out.res.a?.e).toBe(2_000);
    expect(out.res.a?.pt).toBe(900);
    expect(out.res.b).toBeUndefined();
    expect(out.reveal.me.c).toMatchObject({ prev: 1, rank: 1, tot: 1000, pts: 0 });
    expect(out.reveal.me.a).toMatchObject({ rank: 2, tot: 900 });
    expect(out.vlados).toBeNull();
  });
});

describe('numberDist', () => {
  it('exact values when few, nice buckets otherwise', () => {
    expect(numberDist([3, 1, 3, 2.5], 0.5)).toEqual({ dist: { '1': 1, '2.5': 1, '3': 2 } });
    const many = Array.from({ length: 40 }, (_, k) => 1990 + k);
    const { dist, bin } = numberDist(many, 1);
    expect(bin).toBe(5);
    expect(Object.keys(dist)[0]).toBe('1990');
    expect(Object.values(dist).reduce((a, b) => a + b, 0)).toBe(40);
    expect(Object.keys(dist).length).toBeLessThanOrEqual(10);
    expect(numberDist([], 1)).toEqual({ dist: {} });
    const floats = numberDist(Array.from({ length: 12 }, (_, k) => k * 0.1), 0.1);
    expect(floats.bin).toBeCloseTo(0.2, 10);
    expect(Object.keys(floats.dist).every((k) => !/0000/.test(k))).toBe(true);
  });
});

// ---------- Lease, counts, player-side checks ----------

describe('lease', () => {
  const me = { session: 's1', preferred: false, label: 'admin', uid: 'u1' };
  const other = (until: number, preferred = false): LeaseDoc => ({ session: 's2', until, label: 'x', preferred, uid: 'u2', at: 0 });

  it('acquire when free or expired, renew my own in time, take over only as the preferred TV', () => {
    expect(leaseAction(null, me, T0, true)).toBe('acquire');
    expect(leaseAction(other(T0), me, T0, true)).toBe('acquire');
    expect(leaseAction(other(T0 + 1), me, T0, true)).toBe('none');
    expect(leaseAction(other(T0 + 1), { ...me, preferred: true }, T0, true)).toBe('takeover');
    expect(leaseAction(other(T0 + 1, true), { ...me, preferred: true }, T0, true)).toBe('none');
    const mine = newLease(me, T0, true);
    expect(mine.until).toBe(T0 + HOST_TIMING.leaseTtlMs);
    expect(leaseAction(mine, me, T0 + 1_000, true)).toBe('none');
    expect(leaseAction(mine, me, T0 + HOST_TIMING.leaseRenewMs, true)).toBe('renew');
    const idle = newLease(me, T0, false);
    expect(idle.until).toBe(T0 + HOST_TIMING.idleLeaseTtlMs);
    expect(leaseAction(idle, me, T0 + HOST_TIMING.leaseRenewMs, false)).toBe('none');
    expect(leaseAction(idle, me, T0 + HOST_TIMING.idleLeaseRenewMs, false)).toBe('renew');
    expect(leaseHeld(mine, 's1', T0 + 1)).toBe(true);
    expect(leaseHeld(mine, 's1', mine.until)).toBe(false);
    expect(leaseHeld(mine, 's2', T0)).toBe(false);
  });
});

describe('counts push throttle', () => {
  const g = (patch: Partial<GameDoc>): GameDoc => ({ ...initialGameDoc(defaultSettings()), ...patch });
  it('answered ≤ every 5 s while open, players ≤ every 15 s, only when changed', () => {
    const open = g({ phase: 'open', answered: 3, players: 10 });
    expect(countsPushDue(open, { answered: 3, players: 10 }, 0, T0)).toBe(false);
    expect(countsPushDue(open, { answered: 4, players: 10 }, T0 - 4_999, T0)).toBe(false);
    expect(countsPushDue(open, { answered: 4, players: 10 }, T0 - 5_000, T0)).toBe(true);
    expect(countsPushDue({ ...open, pause: { at: 0, remainingMs: 1, reason: 'admin' } }, { answered: 4, players: 10 }, 0, T0)).toBe(false);
    const lobby = g({ players: 10 });
    expect(countsPushDue(lobby, { answered: 0, players: 11 }, T0 - 14_999, T0)).toBe(false);
    expect(countsPushDue(lobby, { answered: 0, players: 11 }, T0 - 15_000, T0)).toBe(true);
    expect(countsPushDue(g({ phase: 'locked', answered: 1 }), { answered: 2, players: 0 }, 0, T0)).toBe(false);
  });

  // Every push is one read on every phone: 95 phones × 15 questions × one push per 5 s of a 60 s
  // question alone would be 17k reads (tools/swarm.mjs extrapolation). The gaps grow with the time
  // limit and the crowd so a question costs each phone at most 3 answered pushes.
  it('answered pushes: at most 3 per question and slower for a big crowd', () => {
    expect(answeredPushGapMs(10_000, 5)).toBe(5_000);
    expect(answeredPushGapMs(60_000, 5)).toBe(20_000);
    expect(answeredPushGapMs(10_000, 95)).toBe(9_500);
    for (const [limit, players] of [[20_000, 10], [60_000, 95], [120_000, 150], [30_000, 500]] as const) {
      expect(Math.floor(limit / answeredPushGapMs(limit, players))).toBeLessThanOrEqual(3);
    }
    const open = g({ phase: 'open', answered: 3, players: 95, round: { ...g({}).round, timeLimitS: 60 } as GameDoc['round'] });
    expect(countsPushDue(open, { answered: 4, players: 95 }, T0 - 19_999, T0)).toBe(false);
    expect(countsPushDue(open, { answered: 4, players: 95 }, T0 - 20_000, T0)).toBe(true);
  });

  it('player-count pushes: ≥ 15 s, 1 s per player (≤ 1 phone read/s in total), ≤ 90 s', () => {
    expect(playersPushGapMs(3)).toBe(15_000);
    expect(playersPushGapMs(50)).toBe(50_000);
    expect(playersPushGapMs(80)).toBe(80_000);
    expect(playersPushGapMs(400)).toBe(90_000);
    const lobby = g({ players: 79 });
    expect(countsPushDue(lobby, { answered: 0, players: 80 }, T0 - 79_999, T0)).toBe(false);
    expect(countsPushDue(lobby, { answered: 0, players: 80 }, T0 - 80_000, T0)).toBe(true);
  });
});

describe('player-side checks', () => {
  const sim = new Sim();
  sim.join('p1');
  sim.cmd({ type: 'start' });
  const intro = sim.game;
  sim.runUntil(sim.round.openAt);
  const open = sim.game;
  const r = open.round as RoundPub;
  const joined = { uid: 'p1', joined: true, kicked: false };

  it('answerPrecheck mirrors the rules', () => {
    expect(answerPrecheck(open, joined, 0, choice('blue'), r.openAt + 1)).toBeNull();
    expect(answerPrecheck(open, { ...joined, joined: false }, 0, choice('blue'), r.openAt)).toBe('not_joined');
    expect(answerPrecheck(open, { ...joined, kicked: true }, 0, choice('blue'), r.openAt)).toBe('kicked');
    expect(answerPrecheck({ ...open, kicked: ['p1'] }, joined, 0, choice('blue'), r.openAt)).toBe('kicked');
    expect(answerPrecheck(intro, joined, 0, choice('blue'), r.openAt - FB_LIMITS.answerEarlyMs - 1)).toBe('closed');
    // a late host: still 'intro' at openAt — open by the clock, like the rules (not while paused)
    expect(answerPrecheck(intro, joined, 0, choice('blue'), r.openAt)).toBeNull();
    expect(answerPrecheck({ ...intro, pause: { at: r.openAt - 100, remainingMs: 20_000, reason: 'admin' } }, joined, 0, choice('blue'), r.openAt)).toBe('closed');
    expect(answerPrecheck(open, joined, 1, choice('blue'), r.openAt)).toBe('closed');
    expect(answerPrecheck({ ...open, round: { ...r, i: 3 } }, joined, 0, choice('blue'), r.openAt)).toBe('late');
    expect(answerPrecheck({ ...open, phase: 'reveal' }, joined, 0, choice('blue'), r.openAt)).toBe('late');
    expect(answerPrecheck(open, joined, 0, choice('blue'), r.endsAt + FB_LIMITS.answerLateMs + 1)).toBe('late');
    expect(answerPrecheck(open, joined, 0, choice('blue'), r.openAt - FB_LIMITS.answerEarlyMs - 1)).toBe('closed');
    expect(answerPrecheck(open, joined, 0, choice('pink'), r.openAt)).toBe('invalid');
    expect(answerPrecheck(null, joined, 0, choice('blue'), r.openAt)).toBe('offline');
    expect(answerPrecheck({ ...open, phase: 'lobby', round: null }, joined, 0, choice('blue'), r.openAt)).toBe('closed');
  });

  it('validAnswerPayload per question type', () => {
    const numR = publicRound(Q2, 0, 1, T0, { introMs: 0 });
    expect(validAnswerPayload(numR, num(0))).toBe(true);
    expect(validAnswerPayload(numR, num(1001))).toBe(false);
    expect(validAnswerPayload(numR, num(Number.NaN))).toBe(false);
    expect(validAnswerPayload(numR, choice('x'))).toBe(false);
    const ordR = publicRound(Q3, 0, 1, T0, { introMs: 0 });
    expect(validAnswerPayload(ordR, order('d', 'c', 'b', 'a'))).toBe(true);
    expect(validAnswerPayload(ordR, order('a', 'a', 'b', 'c'))).toBe(false);
    expect(validAnswerPayload(ordR, order('a', 'b', 'c'))).toBe(false);
  });

  // Each reaction is a write and a TV read: 95 guests at 10/min could burn the 20k writes/day in
  // 20 minutes and the answers would start failing. 4/min keeps a whole evening of it bounded.
  it('reactionAllowed: one per 3 s, four per minute', () => {
    expect(reactionAllowed([], T0)).toBe(true);
    expect(reactionAllowed([T0 - 2_999], T0)).toBe(false);
    expect(reactionAllowed([T0 - 3_000], T0)).toBe(true);
    const four = Array.from({ length: 4 }, (_, k) => T0 - 9_000 + k * 3_000);
    expect(reactionAllowed(four, T0 + 3_000)).toBe(false);
    expect(reactionAllowed(four, T0 + 51_001)).toBe(true);
  });

  it('checkedName: normalized and within the UTF-16 limit', () => {
    expect(checkedName('  Вася   Пупкин ')).toBe('Вася Пупкин');
    expect(checkedName('')).toBeNull();
    expect(checkedName('🎉'.repeat(11))).toBeNull();
  });
});

describe('private/totals rows', () => {
  it('pack / unpack results losslessly (arrays, not maps)', () => {
    const x = { p: order('b', 'a'), at: T0, e: 1234, pt: 567, ac: 0.35, ok: false };
    expect(packResult(x)).toEqual([567, 0.35, 0, -1, 1234, T0, '{"t":"ordering","ids":["b","a"]}']);
    expect(unpackResult(packResult(x))).toEqual(x);
    const y = { p: num(3.5), at: T0, e: 0, pt: 1000, ac: 1, ok: true, cl: true };
    expect(unpackResult(packResult(y))).toEqual(y);
    expect(unpackResult([0, 0, 0, 0, 0, 0, 'garbage']).p).toEqual({ t: 'choice', id: '' });
  });
});

describe('document sizes (95 players, 25 questions)', () => {
  it('private/totals stays far below 1 MiB and 20k fields; the public doc stays small', () => {
    const qs: Question[] = Array.from({ length: 25 }, (_, k) =>
      k % 3 === 0 ? { ...Q3, id: `o${k}` } : k % 3 === 1 ? { ...Q2, id: `n${k}` } : { ...Q1, id: `c${k}`, media: undefined as never },
    );
    const sim = new Sim(content({ autoAdvance: { revealToBoardS: 1, boardToNextS: 1, finalStepS: null } }, qs));
    const uids = Array.from({ length: 95 }, (_, k) => `uid${String(k).padStart(25, 'x')}`);
    for (const u of uids) sim.join(u, `Игрок ${u.slice(-3)}`);
    sim.cmd({ type: 'start' });
    let maxGame = 0;
    for (let guard = 0; guard < 200 && sim.game.phase !== 'final'; guard++) {
      if (sim.game.phase === 'open') {
        const r = sim.round;
        uids.forEach((u, k) => {
          const p = r.type === 'choice' ? choice(k % 2 ? 'blue' : 'red') : r.type === 'number' ? num(k) : order('b', 'a', 'c', 'd');
          sim.answer(u, p, r.openAt + 100 * k);
        });
      }
      maxGame = Math.max(maxGame, JSON.stringify(sim.game).length);
      sim.runUntil(sim.deadline() ?? sim.now);
    }
    expect(sim.game.phase).toBe('final');
    const fields = (v: unknown): number =>
      Array.isArray(v) ? v.reduce((n: number, x) => n + fields(x), 0) : v && typeof v === 'object' ? Object.values(v).reduce((n: number, x) => n + 1 + fields(x), 0) : 0;
    const totalsJson = JSON.stringify(sim.totals).length;
    expect(sim.totals?.rounds).toHaveLength(25);
    expect(Object.keys(sim.totals?.rounds[24]?.res ?? {})).toHaveLength(95);
    expect(totalsJson).toBeLessThan(500_000);
    expect(fields(sim.totals)).toBeLessThan(6_000);
    expect(maxGame).toBeLessThan(40_000);
  });
});

describe('docs hygiene', () => {
  it('stripUndefined keeps bytes and nested values, drops undefined', () => {
    const bytes = new Uint8Array([1]);
    expect(stripUndefined({ a: 1, b: undefined, c: { d: undefined, e: [1, { f: undefined }] }, g: bytes, h: null })).toEqual({
      a: 1,
      c: { e: [1, {}] },
      g: bytes,
      h: null,
    });
    expect(stripUndefined({ g: bytes }).g).toBe(bytes);
  });

  it('projected docs never contain undefined and never a correct answer before the reveal', () => {
    const sim = new Sim();
    sim.join('p1');
    const hasUndefined = (v: unknown): boolean =>
      v === undefined || (typeof v === 'object' && v !== null && !(v instanceof Uint8Array) && Object.values(v).some(hasUndefined));
    sim.cmd({ type: 'start' });
    for (let k = 0; k < 12 && sim.game.phase !== 'final'; k++) {
      expect(hasUndefined(sim.game)).toBe(false);
      expect(hasUndefined(sim.totals)).toBe(false);
      if (['intro', 'open', 'locked'].includes(sim.game.phase)) {
        expect(sim.game.reveal).toBeNull();
        expect(JSON.stringify(sim.game.round)).not.toMatch(/correctId|"answer"|tolerance|zeroAt/);
      }
      const d = sim.deadline();
      if (d !== null) sim.runUntil(d);
      else sim.cmd({ type: 'advance', phaseRev: sim.game.phaseRev });
    }
  });

  it('settings from older docs are completed with defaults', () => {
    const s = normalizeSettings({ title: 'X', autoAdvance: { revealToBoardS: 5 }, scoring: { number: { curve: 2 } } });
    expect(s.title).toBe('X');
    expect(s.autoAdvance).toEqual({ revealToBoardS: 5, boardToNextS: null, finalStepS: null });
    expect(s.scoring.number).toEqual({ ...DEFAULT_SCORING.number, curve: 2 });
    expect(s.scoring.base).toBe(1000);
    expect(hostContent(null)).toMatchObject({ rev: 0, questions: [] });
    expect(initialGameDoc(s).pub).toMatchObject({ title: 'X', reactions: true, lateJoin: true, themeDefault: 'system' });
    expect(initialGameDoc(s).pub.texts.joinTitle).toBeTruthy();
  });
});

describe('adversarial guests (review 2026-09-23)', () => {
  const QV: ChoiceQ = { ...Q1, id: 'qv', media: { mediaId: 'vid-1', onPhones: true } };

  it('phones never get a video id to prefetch — only its poster', () => {
    const sim = new Sim(content({}, [QV, Q2]));
    const fresh = refreshedGame(sim.input(), { content: sim.content, media: MEDIA });
    expect(fresh?.next?.media).toContain('img-poster');
    expect(fresh?.next?.media).toContain('img-green');
    expect(fresh?.next?.media).not.toContain('vid-1');
  });

  it('publishes maxPlayers so the rules can refuse joins into a full game', () => {
    expect(initialGameDoc({ ...defaultSettings(), maxPlayers: 42 }).pub).toMatchObject({ maxPlayers: 42 });
  });

  it('drops answers whose payload does not fit the frozen question (devtools writes)', () => {
    const sim = new Sim(content({}, [Q1]));
    for (const u of ['a', 'b', 'c']) sim.join(u);
    openFirst(sim);
    expect(sim.answer('a', choice('zzz'))).toBeNull();
    expect(sim.answer('b', { t: 'number', v: 5 } as AnswerPayload)).toBeNull();
    expect(sim.answer('c', choice('blue'))).toBeNull();
    expect(liveCounts(sim.input()).answered).toBe(1);
    sim.runUntil(sim.round.endsAt + REVEAL_WAIT);
    expect(sim.game.reveal).toMatchObject({ count: 1, dist: { red: 0, blue: 1, green: 0 } });
    expect(Object.keys(res0(sim))).toEqual(['c']);
    expect(sim.game.reveal?.me.a).toMatchObject({ pts: 0, ok: false });
  });

  it('number answers outside [min, max] or not finite never reach the histogram', () => {
    const sim = new Sim(content({}, [Q2]));
    for (const u of ['a', 'b', 'c', 'd', 'e']) sim.join(u);
    openFirst(sim);
    sim.answer('a', num(1e308));
    sim.answer('b', num(Number.NaN));
    sim.answer('c', num(-1e308));
    sim.answer('d', num(Number.POSITIVE_INFINITY));
    sim.answer('e', num(100));
    sim.runUntil(sim.round.endsAt + REVEAL_WAIT);
    const r = sim.game.reveal;
    expect(r?.count).toBe(1);
    expect(r?.dist).toEqual({ '100': 1 });
    for (const v of Object.values(r?.me ?? {})) expect(Number.isFinite(v.tot)).toBe(true);
  });

  it('the shown ordering cannot be un-shuffled from public data (gameId, round, qid + the bundle)', () => {
    const sim = new Sim(content({}, [Q3]));
    sim.join('a');
    sim.cmd({ type: 'start' });
    const r = sim.round;
    const shown = (r.items ?? []).map((it) => it.id);
    // A guest's attempt: replay the engine's seeded shuffle on indices, then invert it.
    const idx = shownOrder({ ...Q3, items: Q3.items.map((_, k) => ({ id: String(k) })) }, roundSeed(sim.gameId, r.i, r.qid)).map(Number);
    const guess: string[] = [];
    idx.forEach((from, to) => (guess[from] = shown[to] as string));
    expect(guess).not.toEqual(correctOrder(Q3));
    expect(shown).not.toEqual(correctOrder(Q3));
    expect([...shown].sort()).toEqual([...correctOrder(Q3)].sort());
    // Persisted: the private round and later projections keep the same order.
    expect(sim.totals?.rounds[0]?.shown).toEqual(shown);
    sim.runUntil(sim.round.openAt);
    expect((sim.round.items ?? []).map((it) => it.id)).toEqual(shown);
  });

  it('media of a frozen round stays resolvable after its question is deleted from content (host restart / standby)', () => {
    const sim = new Sim(content({}, [Q1, Q2]));
    sim.join('a');
    sim.cmd({ type: 'start' });
    const ids = referencedMediaIds({ questions: [Q2], settings: { lobbyBgMediaId: 'img-bg' } }, sim.totals);
    expect(ids).toEqual(expect.arrayContaining(['img-q1', 'img-reveal', 'img-bg']));
    expect(referencedMediaIds(null, null)).toEqual([]);
  });

  it('ordering answers must be a permutation of the items (no maps, no duplicates)', () => {
    const sim = new Sim(content({}, [Q3]));
    for (const u of ['a', 'b', 'c', 'd']) sim.join(u);
    openFirst(sim);
    const shown = (sim.round.items ?? []).map((it) => it.id);
    sim.answer('a', { t: 'ordering', ids: [{}, {}, {}, {}] } as never);
    sim.answer('b', order('a', 'a', 'b', 'c'));
    sim.answer('c', order('a', 'b'));
    sim.answer('d', order(...shown));
    sim.runUntil(sim.round.endsAt + REVEAL_WAIT);
    expect(sim.game.reveal?.count).toBe(1);
    expect(Object.keys(res0(sim))).toEqual(['d']);
    expect(JSON.stringify(sim.totals)).not.toContain('{}');
  });
});

describe('watch stage: the answer timer starts after the video (organizer, 2026-09-23)', () => {
  // A 13 s video played from 3 s: 10 s on the TV + 5 s tail before the fallback.
  const VMEDIA: MediaIndex = { ...MEDIA, 'vid-1': { kind: 'video', posterId: 'img-poster', durationS: 13 } };
  const QV: ChoiceQ = { ...Q1, id: 'qv', media: { mediaId: 'vid-1', onPhones: false, startAtS: 3 } };
  const WIN = 10_000 + WATCH.tailMs;
  const FALLBACK_OPEN = T0 + INTRO + WIN + WATCH.beatMs;
  const me = { uid: 'p1', joined: true, kicked: false };

  function videoGame(questions: Question[] = [QV, Q2], media: MediaIndex = VMEDIA): Sim {
    const sim = new Sim(content({}, questions), media);
    sim.join('p1');
    sim.join('p2');
    sim.cmd({ type: 'start' });
    return sim;
  }

  it('no answers while the video plays; without a report the fallback opens them after video + tail + beat', () => {
    const sim = videoGame();
    expect(sim.game.phase).toBe('intro');
    expect(sim.round).toMatchObject({ introAt: T0, openAt: FALLBACK_OPEN, endsAt: FALLBACK_OPEN + 20_000 });
    expect(sim.round.media).toEqual({ mediaId: 'vid-1', kind: 'video', onPhones: false, startAtS: 3, posterId: 'img-poster', watchMs: WIN, videoMs: 10_000 });
    expect(sim.totals?.rounds[0]?.watch).toEqual({ ms: WIN, videoMs: 10_000 });
    // the video plays: the rules (openAt) and the phone's precheck refuse answers
    sim.runUntil(T0 + INTRO + 9_000);
    expect(sim.game.phase).toBe('intro');
    expect(sim.answer('p1', choice('blue'))).toBe('denied:window');
    expect(answerPrecheck(sim.game, me, 0, choice('blue'), sim.now)).toBe('closed');
    expect(sim.deadline()).toBe(FALLBACK_OPEN);
    sim.runUntil(FALLBACK_OPEN);
    expect(sim.game.phase).toBe('open');
    expect(sim.round.endsAt).toBe(FALLBACK_OPEN + 20_000);
  });

  it("the TV reports 'ended': answers open after the 3-2-1, the full limit counts from there, scores use the new openAt", () => {
    const sim = videoGame();
    const ended = T0 + INTRO + 10_400;
    sim.runUntil(ended);
    const rev = sim.game.phaseRev;
    expect(sim.cmd({ type: 'watchEnd', phaseRev: rev }, ended)).toMatchObject({ ok: true, changed: true });
    const openAt = ended + WATCH.beatMs;
    expect(sim.game).toMatchObject({ phase: 'intro', phaseRev: rev });
    expect(sim.round).toMatchObject({ openAt, endsAt: openAt + 20_000 });
    expect(sim.totals?.rounds[0]).toMatchObject({ openAt, endsAt: openAt + 20_000, watch: { ms: WIN, videoMs: 10_000 } });
    // the admin's «досмотрели» / the TV's Space right after: nothing more to do
    expect(sim.cmd({ type: 'watchEnd', phaseRev: rev }, ended + 400)).toMatchObject({ ok: true, changed: false });
    expect(sim.round.openAt).toBe(openAt);
    // the beat: still closed
    expect(sim.answer('p1', choice('blue'), openAt - 1_000)).toBe('denied:window');
    expect(sim.deadline()).toBe(openAt);
    sim.runUntil(openAt);
    expect(sim.game.phase).toBe('open');
    expect(sim.answer('p1', choice('blue'), openAt + 4_000)).toBeNull();
    // 19 s after the opening: with the old timer (running during the video) this was «не успел»
    expect(answerPrecheck(sim.game, { ...me, uid: 'p2' }, 0, choice('red'), openAt + 19_000)).toBeNull();
    expect(sim.answer('p2', choice('red'), openAt + 19_000)).toBeNull();
    sim.runUntil(openAt + 20_000 + REVEAL_WAIT);
    expect(sim.game.phase).toBe('reveal');
    expect(res0(sim).p1).toMatchObject({ e: 4_000, pt: pts(QV, choice('blue'), 4_000), ok: true });
    expect(res0(sim).p2).toMatchObject({ e: 19_000, ok: false });
  });

  it('a report before the video started (organizer: «старт» during the title) and stale / wrong reports', () => {
    const sim = videoGame();
    const rev = sim.game.phaseRev;
    expect(sim.cmd({ type: 'watchEnd', phaseRev: rev + 1 }, T0 + 1_000)).toMatchObject({ ok: false, error: 'stale' });
    expect(sim.cmd({ type: 'watchEnd', phaseRev: rev }, T0 + 1_000)).toMatchObject({ ok: true, changed: true });
    expect(sim.round.openAt).toBe(T0 + 1_000 + WATCH.beatMs);
    sim.runUntil(sim.round.openAt);
    expect(sim.game.phase).toBe('open');
    // open already: a late 'ended' (TV lagging) changes nothing
    expect(sim.cmd({ type: 'watchEnd', phaseRev: rev }, sim.now + 100)).toMatchObject({ ok: false, error: 'stale' });
    expect(sim.cmd({ type: 'watchEnd', phaseRev: sim.game.phaseRev }, sim.now + 100)).toMatchObject({ ok: false, error: 'invalid' });
  });

  it('pause during the video: no deadline, no report accepted; resume moves the video start, fallback and opening', () => {
    const sim = videoGame();
    const pauseAt = T0 + INTRO + 6_000;
    sim.cmd({ type: 'pause' }, pauseAt);
    expect(sim.deadline()).toBeNull();
    expect(sim.cmd({ type: 'watchEnd', phaseRev: sim.game.phaseRev }, pauseAt + 1_000)).toMatchObject({ ok: false, error: 'invalid' });
    sim.cmd({ type: 'resume' }, pauseAt + 60_000);
    expect(sim.round).toMatchObject({ openAt: FALLBACK_OPEN + 60_000, endsAt: FALLBACK_OPEN + 60_000 + 20_000 });
    // the pause does not count as answer time
    const ended = pauseAt + 60_000 + 4_000;
    sim.cmd({ type: 'watchEnd', phaseRev: sim.game.phaseRev }, ended);
    const openAt = ended + WATCH.beatMs;
    expect(sim.round).toMatchObject({ openAt, endsAt: openAt + 20_000 });
    sim.runUntil(openAt);
    sim.answer('p1', choice('blue'), openAt + 2_000);
    sim.runUntil(openAt + 20_000 + REVEAL_WAIT);
    expect(res0(sim).p1).toMatchObject({ e: 2_000 });
  });

  it('skip and +time during the video; jumpTo a video question gets the watch stage too', () => {
    const sim = videoGame();
    sim.cmd({ type: 'addTime', ms: 15_000 }, T0 + INTRO + 2_000);
    expect(sim.round).toMatchObject({ openAt: FALLBACK_OPEN, endsAt: FALLBACK_OPEN + 35_000 });
    sim.cmd({ type: 'watchEnd', phaseRev: sim.game.phaseRev }, T0 + INTRO + 5_000);
    expect(sim.round.endsAt - sim.round.openAt).toBe(35_000);
    sim.cmd({ type: 'skip', phaseRev: sim.game.phaseRev }, T0 + INTRO + 6_000);
    expect(sim.game.phase).toBe('intro');
    expect(sim.round).toMatchObject({ qid: 'q2', openAt: T0 + 2 * INTRO + 6_000 });
    expect(sim.round.media).toBeUndefined();
    expect(sim.totals?.rounds[0]).toMatchObject({ skipped: true, watch: { ms: WIN } });
    expect(sim.totals?.rounds[1]?.watch).toBeUndefined();
    // a report for the skipped video must not touch the number question
    expect(sim.cmd({ type: 'watchEnd', phaseRev: sim.game.phaseRev }, T0 + 2 * INTRO + 6_500)).toMatchObject({ ok: false, error: 'invalid' });

    const j = new Sim(content({}, [Q2, QV]), VMEDIA);
    j.join('p1');
    const at = T0 + 30_000;
    j.cmd({ type: 'jumpTo', qid: 'qv' }, at);
    expect(j.round).toMatchObject({ qid: 'qv', openAt: at + INTRO + WIN + WATCH.beatMs });
    expect(j.totals?.rounds[0]?.watch).toEqual({ ms: WIN, videoMs: 10_000 });
  });

  it('unknown duration → 3-minute window; image and media-less rounds keep the plain intro', () => {
    const noDur = videoGame([QV], MEDIA);
    expect(noDur.round.openAt).toBe(T0 + INTRO + WATCH.unknownMs + WATCH.beatMs);
    expect(noDur.round.media?.watchMs).toBe(WATCH.unknownMs);
    expect(noDur.round.media?.videoMs).toBeUndefined();
    const img = videoGame([Q1]);
    expect(img.round).toMatchObject({ openAt: T0 + INTRO });
    expect(img.round.media?.watchMs).toBeUndefined();
    expect(img.totals?.rounds[0]?.watch).toBeUndefined();
    expect(img.cmd({ type: 'watchEnd', phaseRev: img.game.phaseRev })).toMatchObject({ ok: false, error: 'invalid' });
    // the host must know the file to publish it: an unresolved video gets no watch stage (and no media)
    const unresolved = videoGame([QV], {});
    expect(unresolved.round).toMatchObject({ openAt: T0 + INTRO });
    expect(unresolved.round.media).toBeUndefined();
  });

  it('publicRound (preview, bots) builds the same watch stage as the host', () => {
    const r = publicRound(QV, 0, 1, T0, { introMs: INTRO }, { media: VMEDIA });
    expect(r).toMatchObject({ openAt: FALLBACK_OPEN, endsAt: FALLBACK_OPEN + 20_000, media: { watchMs: WIN, videoMs: 10_000 } });
    const solo = publicRound(QV, 0, 1, T0, { introMs: INTRO }, { media: VMEDIA, tv: false });
    expect(solo.media).toMatchObject({ watchMs: 10_000 + WATCH.soloTailMs, videoMs: 10_000 });
  });

  it('no TV on air (the admin page is the only host): the fallback is the video + 1 s, not + 5 s', () => {
    const sim = new Sim(content({}, [QV, Q2]), VMEDIA);
    sim.tv = false;
    sim.join('p1');
    sim.cmd({ type: 'start' });
    const win = 10_000 + WATCH.soloTailMs;
    expect(sim.round).toMatchObject({ openAt: T0 + INTRO + win + WATCH.beatMs, media: { watchMs: win, videoMs: 10_000 } });
    expect(sim.totals?.rounds[0]?.watch).toEqual({ ms: win, videoMs: 10_000 });
    // a TV connecting mid-round changes nothing for this round; the next video round gets the long tail
    sim.tv = true;
    sim.runUntil(sim.round.openAt);
    expect(sim.game.phase).toBe('open');
    // unknown duration without a TV: 30 s, not 3 minutes
    const noDur = new Sim(content({}, [QV]), MEDIA);
    noDur.tv = false;
    noDur.join('p1');
    noDur.cmd({ type: 'start' });
    expect(noDur.round.media?.watchMs).toBe(WATCH.soloUnknownMs);
  });

  it('a late host (hidden admin tab): answers from openAt count while the doc still says intro, scored from openAt', () => {
    const sim = new Sim(content({}, [QV, Q2]), VMEDIA);
    sim.tv = false;
    sim.join('p1');
    sim.join('p2');
    sim.cmd({ type: 'start' });
    const { openAt, endsAt } = sim.round;
    // the host sleeps through openAt: the doc stays 'intro', the phones open by the clock
    sim.now = openAt + 3_000;
    expect(sim.game.phase).toBe('intro');
    expect(answerPrecheck(sim.game, me, 0, choice('blue'), sim.now)).toBeNull();
    expect(sim.answer('p1', choice('blue'))).toBeNull();
    expect(sim.answer('p2', choice('red'), openAt + 9_000)).toBeNull();
    // it wakes up after the end of the answer window: intro → open → locked in one tick, then the reveal
    sim.tick(endsAt + 5_000);
    expect(sim.game.phase).toBe('locked');
    sim.runUntil(sim.now + REVEAL_WAIT);
    expect(sim.game.phase).toBe('reveal');
    expect(res0(sim).p1).toMatchObject({ e: 3_000, pt: pts(QV, choice('blue'), 3_000), ok: true });
    expect(res0(sim).p2).toMatchObject({ e: 9_000, ok: false });
    expect(sim.game.reveal?.count).toBe(2);
  });
});
