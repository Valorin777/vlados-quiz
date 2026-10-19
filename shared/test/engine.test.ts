import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../defaults';
import { allAnsweredAt, isActive, nextDeadline } from '../engine/deadlines';
import { FINALE } from '../engine/finale';
import { initialState, reduce, type Effect, type EngineAck, type EngineEvent } from '../engine/reduce';
import { computeRoundResults, computeStandings, vladosComparison } from '../engine/results';
import {
  adminView,
  meView,
  meViews,
  nextQuestion,
  pubView,
  roundSeed,
  shownOrder,
  tvView,
  type ViewCtx,
} from '../engine/select';
import type { AdminCmd } from '../protocol';
import type {
  AnswerPayload,
  ChoiceQ,
  Content,
  GameState,
  MediaAsset,
  NumberQ,
  OrderingQ,
  Player,
  Round,
  RoundResult,
} from '../types';

// ---------- Fixtures ----------

const T0 = 1_800_000_000_000;
const INTRO = 4000;
const LOCK = 1500;
const DELAY = 1200;

const Q1: ChoiceQ = {
  id: 'q1',
  type: 'choice',
  title: 'Какой цвет любит Владос?',
  options: [
    { id: 'red', text: 'Красный' },
    { id: 'blue', text: 'Синий' },
    { id: 'green', text: 'Зелёный' },
  ],
  correctId: 'blue',
  revealText: 'СЕКРЕТ-РАСКРЫТИЯ',
  notes: 'ЗАМЕТКА-АДМИНА',
  timeLimitS: 20,
  double: false,
};

const Q2: NumberQ = {
  id: 'q2',
  type: 'number',
  title: 'Сколько весит торт?',
  answer: 1337.5,
  unit: 'г',
  min: 0,
  max: 5000,
  step: 0.5,
  tolerance: 2.5,
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
  timeLimitS: 40,
  double: false,
};

const Q4: ChoiceQ = {
  id: 'q4',
  type: 'choice',
  title: 'Отключённый вопрос',
  options: [
    { id: 'x', text: 'X' },
    { id: 'y', text: 'Y' },
  ],
  correctId: 'x',
  timeLimitS: 10,
  double: false,
  disabled: true,
};

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

function mkContent(edit?: (c: Content) => void): Content {
  const c: Content = { rev: 7, settings: defaultSettings(), questions: structuredClone([Q1, Q2, Q3, Q4]), trash: [], media: {} };
  edit?.(c);
  return deepFreeze(c);
}

const media = (id: string, status: MediaAsset['status'] = 'ready'): MediaAsset => ({
  id,
  kind: 'image',
  files: { sm: `${id}.sm.webp`, lg: `${id}.lg.webp` },
  w: 800,
  h: 600,
  bytes: 1000,
  status,
  cdn: 'live',
  createdAt: 1,
});

const ch = (id: string): AnswerPayload => ({ t: 'choice', id });
const num = (v: number): AnswerPayload => ({ t: 'number', v });
const ord = (...ids: string[]): AnswerPayload => ({ t: 'ordering', ids });
const kinds = (fx: Effect[]) => fx.map((e) => e.k);

/**
 * Drives reduce() like the server does. Every state is deep-frozen before it is passed in, so any
 * mutation of the input by the reducer throws and fails the test.
 */
class Game {
  state: GameState;
  effects: Effect[] = [];
  now = T0;
  private n = 0;

  constructor(public content: Content = mkContent()) {
    this.state = deepFreeze(initialState('g1', T0));
  }

  send(ev: EngineEvent, at = this.now) {
    this.now = at;
    const r = reduce(this.state, ev, at, this.content);
    this.state = deepFreeze(r.state);
    this.effects = r.effects;
    return r;
  }

  get ack(): EngineAck {
    const e = this.effects.find((x) => x.k === 'ack');
    if (!e || e.k !== 'ack') throw new Error('no ack');
    return e.res;
  }

  get phase() {
    return this.state.phase;
  }

  get round(): Round {
    const r = this.state.rounds[this.state.cur];
    if (!r) throw new Error('no round');
    return r;
  }

  get settings() {
    return this.content.settings;
  }

  cmd(cmd: AdminCmd, at = this.now): EngineAck {
    this.send({ t: 'cmd', cmd }, at);
    return this.ack;
  }

  tick(at: number) {
    return this.send({ t: 'tick' }, at);
  }

  start(at = this.now) {
    return this.cmd({ type: 'start' }, at);
  }

  advance(at = this.now) {
    return this.cmd({ type: 'advance', phaseRev: this.state.phaseRev }, at);
  }

  revealCmd(at = this.now) {
    return this.cmd({ type: 'reveal', phaseRev: this.state.phaseRev }, at);
  }

  skip(at = this.now) {
    return this.cmd({ type: 'skip', phaseRev: this.state.phaseRev }, at);
  }

  join(name: string, at = this.now, extra: { avatar?: string; bot?: boolean } = {}): string {
    const id = `p${++this.n}`;
    this.send({ t: 'join', id, token: `tok-${id}`, code: String(1000 + this.n), seed: this.n, name, ...extra }, at);
    return id;
  }

  answer(playerId: string, p: AnswerPayload, o: { at?: number; elapsedMs?: number; cid?: string; round?: number } = {}): EngineAck {
    const at = o.at ?? this.now;
    const round = o.round ?? this.state.cur;
    const openAt = this.state.rounds[round]?.openAt ?? at;
    this.send({ t: 'answer', playerId, round, p, elapsedMs: o.elapsedMs ?? at - openAt, cid: o.cid ?? `${playerId}:${round}` }, at);
    return this.ack;
  }

  presence(playerId: string, online: boolean, at = this.now) {
    return this.send({ t: 'presence', playerId, online }, at);
  }

  /** Test-only state surgery (e.g. savedAt written by the store). */
  edit(fn: (s: GameState) => void) {
    const s = structuredClone(this.state);
    fn(s);
    this.state = deepFreeze(s);
  }
}

/** From intro/open: open the round, answer 1 s apart, reveal via the admin button + lockMs. */
function reveal(g: Game, answers: [string, AnswerPayload][] = []) {
  if (g.phase === 'intro') g.tick(g.round.openAt);
  let t = g.now;
  for (const [id, p] of answers) {
    t += 1000;
    expect(g.answer(id, p, { at: t })).toMatchObject({ ok: true });
  }
  expect(g.revealCmd(t + 100)).toMatchObject({ ok: true });
  expect(g.phase).toBe('locked');
  g.tick(g.now + LOCK);
  expect(g.phase).toBe('reveal');
}

function crowd(n: number, content?: Content) {
  const g = new Game(content);
  const ids = Array.from({ length: n }, (_, i) => g.join(`Игрок ${i + 1}`, T0 - 1000 + i));
  return { g, ids };
}

// ---------- Join & recover ----------

describe('join & recover', () => {
  it('adds an online player in the lobby', () => {
    const g = new Game();
    const id = g.join('  Аня  ', T0 + 5);
    expect(g.ack).toEqual({ ok: true, token: 'tok-p1', id: 'p1', code: '1001' });
    expect(g.state.players[id]).toEqual({
      id: 'p1',
      token: 'tok-p1',
      code: '1001',
      name: 'Аня',
      seed: 1,
      joinedAt: T0 + 5,
      lastSeen: T0 + 5,
      online: true,
      kicked: false,
    });
    expect(kinds(g.effects)).toEqual(['save', 'ack', 'broadcast', 'schedule']);
    expect(g.effects).toContainEqual({ k: 'broadcast', views: ['pub', 'tv', 'admin'], me: ['p1'] });
    expect(g.state.rev).toBe(1);
  });

  it('keeps avatar and bot flags', () => {
    const g = new Game();
    const id = g.join('Бот', T0, { avatar: 'p1.jpg', bot: true });
    expect(g.state.players[id]).toMatchObject({ avatar: 'p1.jpg', bot: true });
  });

  it('rejects bad and taken names (case-, ё- and space-insensitive) without touching state', () => {
    const g = new Game();
    g.join('Алёна Ким');
    const before = g.state;
    for (const [name, err] of [
      ['   ', 'bad_name'],
      ['x'.repeat(21), 'bad_name'],
      ['алена  ким', 'name_taken'],
      ['АЛЁНАКИМ', 'name_taken'],
    ] as const) {
      g.join(name);
      expect(g.ack).toEqual({ ok: false, err });
      expect(g.state).toBe(before);
      expect(kinds(g.effects)).toEqual(['ack']);
    }
  });

  it('is full at maxPlayers; kicked players do not count', () => {
    const g = new Game(mkContent((c) => (c.settings.maxPlayers = 2)));
    const a = g.join('A');
    g.join('B');
    g.join('C');
    expect(g.ack).toEqual({ ok: false, err: 'full' });
    g.cmd({ type: 'kick', id: a });
    g.join('C');
    expect(g.ack).toMatchObject({ ok: true });
  });

  it('is closed after the start unless lateJoin, and always in the final', () => {
    const closed = new Game(mkContent((c) => (c.settings.lateJoin = false)));
    closed.join('A');
    closed.start(T0);
    closed.join('B');
    expect(closed.ack).toEqual({ ok: false, err: 'closed' });

    const open = new Game();
    open.join('A');
    open.start(T0);
    open.join('B');
    expect(open.ack).toMatchObject({ ok: true });
    open.cmd({ type: 'end' });
    open.join('C');
    expect(open.ack).toEqual({ ok: false, err: 'closed' });
  });

  it('refuses a duplicate id as a server error', () => {
    const g = new Game();
    g.send({ t: 'join', id: 'x', token: 't', code: '1111', seed: 1, name: 'A' });
    g.send({ t: 'join', id: 'x', token: 't2', code: '2222', seed: 2, name: 'B' });
    expect(g.ack).toEqual({ ok: false, err: 'server' });
    expect(Object.keys(g.state.players)).toEqual(['x']);
  });

  it('recover finds a player by name variant + code and changes nothing', () => {
    const g = new Game();
    const id = g.join('Вася Пупкин');
    const before = g.state;
    g.send({ t: 'recover', name: '  вася   пупкин ', code: '1001' });
    expect(g.ack).toEqual({ ok: true, token: 'tok-p1', id, code: '1001' });
    expect(g.state).toBe(before);
    expect(kinds(g.effects)).toEqual(['ack']);

    g.send({ t: 'recover', name: 'Вася Пупкин', code: '9999' });
    expect(g.ack).toEqual({ ok: false, err: 'not_found' });
    g.send({ t: 'recover', name: '', code: '1001' });
    expect(g.ack).toEqual({ ok: false, err: 'not_found' });
    g.cmd({ type: 'kick', id });
    g.send({ t: 'recover', name: 'Вася Пупкин', code: '1001' });
    expect(g.ack).toEqual({ ok: false, err: 'kicked' });
  });
});

// ---------- Transitions ----------

describe('transitions', () => {
  it('walks lobby → intro → open → locked → reveal → board → next … → final → steps', () => {
    const g = new Game();
    g.join('Аня', T0 - 100);
    expect(g.start(T0)).toEqual({ ok: true, phaseRev: 1 });
    expect(g.state).toMatchObject({ phase: 'intro', phaseRev: 1, phaseAt: T0, cur: 0 });
    expect(g.round).toMatchObject({ qid: 'q1', introAt: T0, openAt: T0 + INTRO, endsAt: T0 + INTRO + 20_000, answers: {} });
    // Frozen copy, not a reference into content.
    expect(g.round.q).toEqual(Q1);
    expect(g.round.q).not.toBe(g.content.questions[0]);

    const s = g.state;
    g.tick(T0 + INTRO - 1);
    expect(g.state).toBe(s);
    expect(g.effects).toEqual([{ k: 'schedule', at: T0 + INTRO }]);

    g.tick(T0 + INTRO);
    expect(g.state).toMatchObject({ phase: 'open', phaseRev: 2, phaseAt: T0 + INTRO });
    g.tick(T0 + INTRO + 19_999);
    expect(g.phase).toBe('open');
    g.tick(T0 + INTRO + 20_000);
    expect(g.state).toMatchObject({ phase: 'locked', phaseRev: 3 });
    expect(g.round.lockedAt).toBe(T0 + INTRO + 20_000);
    g.tick(T0 + INTRO + 20_000 + LOCK - 1);
    expect(g.phase).toBe('locked');
    g.tick(T0 + INTRO + 20_000 + LOCK);
    expect(g.state).toMatchObject({ phase: 'reveal', phaseRev: 4 });
    expect(g.round.results).toEqual({});
    expect(g.round.revealedAt).toBe(T0 + INTRO + 20_000 + LOCK);

    expect(g.advance()).toEqual({ ok: true, phaseRev: 5 });
    expect(g.phase).toBe('board');
    g.advance();
    expect(g.state).toMatchObject({ phase: 'intro', phaseRev: 6, cur: 1 });
    expect(g.round.qid).toBe('q2');

    reveal(g);
    g.advance();
    g.advance();
    expect(g.round.qid).toBe('q3');
    reveal(g);
    g.advance();
    // q4 is disabled → no next question → final.
    g.advance();
    expect(g.state).toMatchObject({ phase: 'final', finalStep: 0 });
    // … 5 the mosaic, 6 the video after the final (built-in by default) — the last one
    for (let step = 1; step <= 6; step++) {
      const rev = g.state.phaseRev;
      expect(g.advance()).toEqual({ ok: true, phaseRev: rev + 1 });
      expect(g.state.finalStep).toBe(step);
    }
    expect(g.advance()).toEqual({ ok: false, err: 'invalid' });
    expect(g.state.rounds.map((r) => r.qid)).toEqual(['q1', 'q2', 'q3']);
  });

  it('a late tick chains every overdue transition', () => {
    const g = new Game();
    g.start(T0);
    g.tick(T0 + 100_000);
    expect(g.state).toMatchObject({ phase: 'locked', phaseRev: 3 });
    expect(g.round.lockedAt).toBe(T0 + 100_000);
  });

  it('start: only in the lobby, needs an enabled question, skips disabled ones', () => {
    const g = new Game(mkContent((c) => (c.questions = [structuredClone(Q4), structuredClone(Q2)])));
    g.start(T0);
    expect(g.round.qid).toBe('q2');
    expect(g.start()).toEqual({ ok: false, err: 'invalid' });

    const empty = new Game(mkContent((c) => (c.questions = [structuredClone(Q4)])));
    expect(empty.start(T0)).toEqual({ ok: false, err: 'invalid' });
    expect(empty.phase).toBe('lobby');
  });

  it('reveal command: open → locked, locked → reveal; invalid elsewhere', () => {
    const g = new Game();
    g.join('A');
    expect(g.revealCmd()).toEqual({ ok: false, err: 'invalid' });
    g.start(T0);
    expect(g.revealCmd()).toEqual({ ok: false, err: 'invalid' });
    g.tick(T0 + INTRO);
    g.revealCmd(T0 + 5000);
    expect(g.state).toMatchObject({ phase: 'locked' });
    expect(g.round.lockedAt).toBe(T0 + 5000);
    g.revealCmd(T0 + 5001);
    expect(g.phase).toBe('reveal');
    expect(g.round.revealedAt).toBe(T0 + 5001);
    expect(g.revealCmd()).toEqual({ ok: false, err: 'invalid' });
  });

  it('advance is invalid outside reveal, board and final', () => {
    const g = new Game();
    expect(g.advance()).toEqual({ ok: false, err: 'invalid' });
    g.start(T0);
    expect(g.advance()).toEqual({ ok: false, err: 'invalid' });
    g.tick(T0 + INTRO);
    expect(g.advance()).toEqual({ ok: false, err: 'invalid' });
    g.revealCmd();
    expect(g.advance()).toEqual({ ok: false, err: 'invalid' });
  });

  it('auto-advance (autopilot off): reveal → board → next, and final steps', () => {
    const g = new Game(mkContent((c) => Object.assign(c.settings, { autopilot: false, autoAdvance: { revealToBoardS: 3, boardToNextS: 4, finalStepS: 2 } })));
    g.join('A');
    g.start(T0);
    reveal(g);
    const r = g.now;
    expect(nextDeadline(g.state, g.settings)).toBe(r + 3000);
    g.tick(r + 2999);
    expect(g.phase).toBe('reveal');
    g.tick(r + 3000);
    expect(g.phase).toBe('board');
    g.tick(r + 7000);
    expect(g.state).toMatchObject({ phase: 'intro', cur: 1 });

    g.cmd({ type: 'end' }, r + 8000);
    for (let step = 1; step <= 5; step++) {
      g.tick(r + 8000 + step * 2000);
      expect(g.state.finalStep).toBe(step);
    }
    // the mosaic → the video after the final: FINALE.autoMs after the mosaic, whatever finalStepS says
    const mosaic = r + 8000 + 5 * 2000;
    expect(nextDeadline(g.state, g.settings)).toBe(mosaic + FINALE.autoMs);
    g.tick(mosaic + 2000);
    expect(g.state.finalStep).toBe(5);
    g.tick(mosaic + FINALE.autoMs);
    expect(g.state.finalStep).toBe(6);
    expect(nextDeadline(g.state, g.settings)).toBeNull();
    const s = g.state;
    g.tick(r + 60_000);
    expect(g.state).toBe(s);
  });
});

// ---------- Stale phaseRev ----------

describe('stale phaseRev', () => {
  it('a double tap gets stale and changes nothing', () => {
    const g = new Game();
    g.join('A');
    g.start(T0);
    g.tick(T0 + INTRO);
    const rev = g.state.phaseRev;
    expect(g.cmd({ type: 'reveal', phaseRev: rev }, T0 + 5000)).toEqual({ ok: true, phaseRev: rev + 1 });
    const s = g.state;
    expect(g.cmd({ type: 'reveal', phaseRev: rev }, T0 + 5001)).toEqual({ ok: false, err: 'stale' });
    expect(g.state).toBe(s);
    expect(kinds(g.effects)).toEqual(['ack']);
    expect(g.cmd({ type: 'skip', phaseRev: rev })).toEqual({ ok: false, err: 'stale' });
    expect(g.cmd({ type: 'advance', phaseRev: rev + 5 })).toEqual({ ok: false, err: 'stale' });
  });

  it('a timer transition makes a pending command stale, even without a tick', () => {
    const g = new Game();
    g.start(T0);
    g.tick(T0 + INTRO);
    const rev = g.state.phaseRev;
    // Timer is late: the command itself applies the overdue lock first.
    expect(g.cmd({ type: 'skip', phaseRev: rev }, T0 + INTRO + 20_000)).toEqual({ ok: false, err: 'stale' });
    expect(g.phase).toBe('locked');
  });
});

// ---------- Answers ----------

describe('answers', () => {
  it('rejected in lobby and intro, accepted in open and locked, rejected after reveal', () => {
    const g = new Game();
    const [a, b, c] = [g.join('A'), g.join('B'), g.join('C')];
    expect(g.answer(a, ch('blue'), { round: 0 })).toEqual({ ok: false, err: 'not_open' });
    g.start(T0);
    expect(g.answer(a, ch('blue'), { at: T0 + 1000 })).toEqual({ ok: false, err: 'not_open' });
    g.tick(T0 + INTRO);
    expect(g.answer(a, ch('blue'), { at: T0 + INTRO + 2000 })).toEqual({ ok: true, elapsedMs: 2000 });
    g.revealCmd(T0 + INTRO + 3000);
    expect(g.phase).toBe('locked');
    expect(g.answer(b, ch('red'), { at: T0 + INTRO + 3500 })).toMatchObject({ ok: true });
    g.tick(T0 + INTRO + 3000 + LOCK);
    expect(g.phase).toBe('reveal');
    expect(g.round.results?.[b]).toBeDefined();
    expect(g.answer(c, ch('blue'))).toEqual({ ok: false, err: 'closed' });
    g.advance();
    expect(g.answer(c, ch('blue'))).toEqual({ ok: false, err: 'closed' });
    g.advance();
    // Next round: the old one is closed, the new one not open yet, a future one neither.
    expect(g.answer(c, ch('blue'), { round: 0, cid: 'late' })).toEqual({ ok: false, err: 'closed' });
    expect(g.answer(c, num(1), { round: 1 })).toEqual({ ok: false, err: 'not_open' });
    expect(g.answer(c, num(1), { round: 7 })).toEqual({ ok: false, err: 'not_open' });
  });

  it('dedups by cid (idempotent, even after reveal) and by (player, round)', () => {
    const g = new Game();
    const a = g.join('A');
    g.join('B');
    g.start(T0);
    g.tick(T0 + INTRO);
    expect(g.answer(a, ch('blue'), { at: T0 + INTRO + 4000, cid: 'c1' })).toEqual({ ok: true, elapsedMs: 4000 });
    const s = g.state;
    expect(g.answer(a, ch('blue'), { at: T0 + INTRO + 9000, cid: 'c1' })).toEqual({ ok: true, elapsedMs: 4000 });
    expect(g.state).toBe(s);
    expect(kinds(g.effects)).toEqual(['ack']);
    expect(g.answer(a, ch('red'), { at: T0 + INTRO + 9000, cid: 'c2' })).toEqual({ ok: false, err: 'dup' });
    expect(g.round.answers[a]?.p).toEqual(ch('blue'));
    g.revealCmd();
    g.tick(g.now + LOCK);
    expect(g.answer(a, ch('blue'), { cid: 'c1' })).toEqual({ ok: true, elapsedMs: 4000 });
  });

  it('validates the payload against the frozen question', () => {
    const g = new Game();
    const a = g.join('A');
    g.start(T0);
    g.tick(T0 + INTRO);
    expect(g.answer(a, ch('purple'))).toEqual({ ok: false, err: 'invalid' });
    expect(g.answer(a, num(3))).toEqual({ ok: false, err: 'invalid' });
    g.skip();
    g.tick(g.round.openAt);
    expect(g.round.qid).toBe('q2');
    expect(g.answer(a, num(5001))).toEqual({ ok: false, err: 'invalid' });
    expect(g.answer(a, num(-1))).toEqual({ ok: false, err: 'invalid' });
    expect(g.answer(a, num(Number.NaN))).toEqual({ ok: false, err: 'invalid' });
    expect(g.answer(a, num(5000))).toMatchObject({ ok: true });
    g.skip();
    g.tick(g.round.openAt);
    expect(g.answer(a, ord('a', 'b', 'c'))).toEqual({ ok: false, err: 'invalid' });
    expect(g.answer(a, ord('a', 'b', 'c', 'c'))).toEqual({ ok: false, err: 'invalid' });
    expect(g.answer(a, ord('a', 'b', 'c', 'z'))).toEqual({ ok: false, err: 'invalid' });
    expect(g.answer(a, ord('d', 'c', 'b', 'a'))).toMatchObject({ ok: true });
  });

  it('stores only known payload fields', () => {
    const g = new Game();
    const a = g.join('A');
    g.start(T0);
    g.tick(T0 + INTRO);
    g.answer(a, { t: 'choice', id: 'blue', extra: 'x' } as AnswerPayload);
    expect(g.round.answers[a]?.p).toEqual({ t: 'choice', id: 'blue' });
  });

  it('kicked and unknown players are refused', () => {
    const g = new Game();
    const a = g.join('A');
    g.start(T0);
    g.tick(T0 + INTRO);
    expect(g.answer('ghost', ch('blue'))).toEqual({ ok: false, err: 'invalid' });
    g.cmd({ type: 'kick', id: a });
    expect(g.answer(a, ch('blue'))).toEqual({ ok: false, err: 'kicked' });
  });

  it('clamps the client elapsed time to [server − 3 s, server] and to T', () => {
    const g = new Game();
    const ids = ['A', 'B', 'C', 'D', 'E'].map((n) => g.join(n));
    g.start(T0);
    const open = T0 + INTRO;
    g.tick(open);
    const [a, b, c, d, e] = ids as [string, string, string, string, string];
    expect(g.answer(a, ch('blue'), { at: open + 10_000, elapsedMs: 1000 })).toEqual({ ok: true, elapsedMs: 7000 });
    expect(g.answer(b, ch('blue'), { at: open + 10_000, elapsedMs: 9000 })).toEqual({ ok: true, elapsedMs: 9000 });
    expect(g.answer(c, ch('blue'), { at: open + 10_000, elapsedMs: 12_000 })).toEqual({ ok: true, elapsedMs: 10_000 });
    g.tick(open + 20_000);
    expect(g.phase).toBe('locked');
    // Latency grace during locked: server says 21 s, so at most 3 s of credit, never past T.
    expect(g.answer(d, ch('blue'), { at: open + 21_000, elapsedMs: 17_500 })).toEqual({ ok: true, elapsedMs: 18_000 });
    expect(g.answer(e, ch('blue'), { at: open + 21_000, elapsedMs: 30_000 })).toEqual({ ok: true, elapsedMs: 20_000 });
    g.tick(open + 20_000 + LOCK);
    expect(g.round.results?.[a]?.points).toBe(Math.round(1000 * (1 - 0.5 * 7000 / 20_000)));
    expect(g.round.results?.[e]?.points).toBe(500);
  });

  it('a late joiner can answer the open question; time counts from the question open', () => {
    const g = new Game();
    g.join('A', T0 - 1);
    g.start(T0);
    g.tick(T0 + INTRO);
    const late = g.join('Опоздавший', T0 + INTRO + 5000);
    expect(g.ack).toMatchObject({ ok: true });
    expect(g.answer(late, ch('blue'), { at: T0 + INTRO + 6000 })).toEqual({ ok: true, elapsedMs: 6000 });
  });
});

// ---------- All answered ----------

describe('all answered → early lock', () => {
  it('locks allAnsweredDelayMs after the last active answer', () => {
    const { g, ids } = crowd(3);
    const [a, b, c] = ids as [string, string, string];
    g.start(T0);
    g.tick(T0 + INTRO);
    g.answer(a, ch('blue'), { at: T0 + 9000 });
    g.answer(b, ch('red'), { at: T0 + 10_000 });
    expect(nextDeadline(g.state, g.settings)).toBe(g.round.endsAt);
    g.answer(c, ch('blue'), { at: T0 + 11_000 });
    expect(allAnsweredAt(g.state, g.settings)).toBe(T0 + 11_000 + DELAY);
    expect(g.effects).toContainEqual({ k: 'schedule', at: T0 + 11_000 + DELAY });
    g.tick(T0 + 11_000 + DELAY - 1);
    expect(g.phase).toBe('open');
    g.tick(T0 + 11_000 + DELAY);
    expect(g.phase).toBe('locked');
    expect(g.round.lockedAt).toBe(T0 + 11_000 + DELAY);
  });

  it('kicked players do not block; kicking the last straggler schedules the lock', () => {
    const { g, ids } = crowd(3);
    const [a, b, c] = ids as [string, string, string];
    g.start(T0);
    g.tick(T0 + INTRO);
    g.answer(a, ch('blue'), { at: T0 + 9000 });
    g.answer(b, ch('blue'), { at: T0 + 10_000 });
    g.cmd({ type: 'kick', id: c }, T0 + 10_500);
    expect(g.effects).toContainEqual({ k: 'schedule', at: T0 + 10_000 + DELAY });
    g.tick(T0 + 10_000 + DELAY);
    expect(g.phase).toBe('locked');
  });

  it('a kick long after the last answer locks at once', () => {
    const { g, ids } = crowd(2);
    const [a, b] = ids as [string, string];
    g.start(T0);
    g.tick(T0 + INTRO);
    g.answer(a, ch('blue'), { at: T0 + 5000 });
    g.cmd({ type: 'kick', id: b }, T0 + 15_000);
    expect(g.phase).toBe('locked');
  });

  it('an offline player counts for 15 s after last seen, then stops blocking', () => {
    const { g, ids } = crowd(3);
    const [a, b, c] = ids as [string, string, string];
    g.start(T0);
    g.tick(T0 + INTRO);
    g.presence(c, false, T0 + 4500);
    g.answer(a, ch('blue'), { at: T0 + 9000 });
    g.answer(b, ch('blue'), { at: T0 + 10_000 });
    const lockAt = T0 + 4500 + 15_000 + DELAY;
    expect(nextDeadline(g.state, g.settings)).toBe(lockAt);
    g.tick(lockAt - 1);
    expect(g.phase).toBe('open');
    g.tick(lockAt);
    expect(g.phase).toBe('locked');
  });

  it('a player gone long ago does not delay the lock; coming back online blocks it again', () => {
    const { g, ids } = crowd(3);
    const [a, b, c] = ids as [string, string, string];
    g.presence(c, false, T0 - 60_000 + 3000);
    g.start(T0);
    g.tick(T0 + INTRO);
    g.answer(a, ch('blue'), { at: T0 + 9000 });
    g.answer(b, ch('blue'), { at: T0 + 10_000 });
    expect(nextDeadline(g.state, g.settings)).toBe(T0 + 10_000 + DELAY);
    g.presence(c, true, T0 + 10_500);
    expect(nextDeadline(g.state, g.settings)).toBe(g.round.endsAt);
  });

  it('Vlados counts as an active player', () => {
    const { g, ids } = crowd(3);
    const [a, b, v] = ids as [string, string, string];
    g.cmd({ type: 'setVlados', id: v });
    g.start(T0);
    g.tick(T0 + INTRO);
    g.answer(a, ch('blue'), { at: T0 + 9000 });
    g.answer(b, ch('blue'), { at: T0 + 10_000 });
    expect(nextDeadline(g.state, g.settings)).toBe(g.round.endsAt);
    g.answer(v, ch('red'), { at: T0 + 12_000 });
    expect(nextDeadline(g.state, g.settings)).toBe(T0 + 12_000 + DELAY);
  });

  it('a late joiner blocks the early lock until they answer', () => {
    const { g, ids } = crowd(2);
    const [a, b] = ids as [string, string];
    g.start(T0);
    g.tick(T0 + INTRO);
    g.answer(a, ch('blue'), { at: T0 + 9000 });
    g.answer(b, ch('blue'), { at: T0 + 10_000 });
    const late = g.join('Поздний', T0 + 10_500);
    expect(nextDeadline(g.state, g.settings)).toBe(g.round.endsAt);
    g.answer(late, ch('red'), { at: T0 + 12_000 });
    expect(nextDeadline(g.state, g.settings)).toBe(T0 + 12_000 + DELAY);
  });

  it('never auto-locks without answers (empty or fully disconnected room) or while paused', () => {
    const { g, ids } = crowd(2);
    g.start(T0);
    g.tick(T0 + INTRO);
    for (const id of ids) g.presence(id, false, T0 + 5000);
    expect(allAnsweredAt(g.state, g.settings)).toBeNull();
    expect(nextDeadline(g.state, g.settings)).toBe(g.round.endsAt);

    const h = crowd(1).g;
    h.start(T0);
    h.tick(T0 + INTRO);
    h.cmd({ type: 'pause' }, T0 + 5000);
    h.answer('p1', ch('blue'), { at: T0 + 6000 });
    expect(allAnsweredAt(h.state, h.settings)).toBeNull();
  });

  it('isActive: kicked never, online always, offline for 15 s', () => {
    const p: Player = { id: 'x', token: 't', code: '1', name: 'x', seed: 1, joinedAt: 0, lastSeen: 1000, online: false, kicked: false };
    expect(isActive(p, 16_000)).toBe(true);
    expect(isActive(p, 16_001)).toBe(false);
    expect(isActive({ ...p, online: true }, 1e9)).toBe(true);
    expect(isActive({ ...p, online: true, kicked: true }, 1000)).toBe(false);
  });
});

// ---------- Pause / resume / addTime ----------

describe('pause, resume, addTime', () => {
  /** Three players, so two answers never trigger the all-answered lock. */
  function openGame() {
    const { g, ids } = crowd(3);
    g.start(T0);
    g.tick(T0 + INTRO);
    return { g, ids: ids as [string, string, string] };
  }

  it('pause freezes the clock; resume shifts openAt and endsAt by the pause length', () => {
    const { g, ids } = openGame();
    const rev = g.state.phaseRev;
    expect(g.cmd({ type: 'pause' }, T0 + 10_000)).toEqual({ ok: true, phaseRev: rev });
    expect(g.state.pause).toEqual({ at: T0 + 10_000, remainingMs: 14_000, reason: 'admin' });
    expect(nextDeadline(g.state, g.settings)).toBeNull();
    g.tick(T0 + 30_000);
    expect(g.phase).toBe('open');
    // Answering while paused: elapsed is frozen at 6 s.
    expect(g.answer(ids[0], ch('blue'), { at: T0 + 30_000, elapsedMs: 50_000 })).toEqual({ ok: true, elapsedMs: 6000 });
    expect(g.answer(ids[1], ch('blue'), { at: T0 + 30_000, elapsedMs: 4000 })).toEqual({ ok: true, elapsedMs: 4000 });
    g.cmd({ type: 'resume' }, T0 + 40_000);
    expect(g.state.pause).toBeNull();
    expect(g.round).toMatchObject({ openAt: T0 + INTRO + 30_000, endsAt: T0 + 54_000 });
    expect(g.state.phaseRev).toBe(rev);
  });

  it('if everyone answered during the pause, the round locks on resume', () => {
    const { g, ids } = openGame();
    g.cmd({ type: 'pause' }, T0 + 10_000);
    for (const id of ids) g.answer(id, ch('blue'), { at: T0 + 20_000 });
    expect(g.phase).toBe('open');
    g.cmd({ type: 'resume' }, T0 + 40_000);
    expect(g.phase).toBe('locked');
  });

  it('after resume the round runs its remaining time', () => {
    const { g } = openGame();
    g.cmd({ type: 'pause' }, T0 + 10_000);
    g.cmd({ type: 'resume' }, T0 + 40_000);
    g.tick(T0 + 53_999);
    expect(g.phase).toBe('open');
    g.tick(T0 + 54_000);
    expect(g.phase).toBe('locked');
  });

  it('pause during intro delays the opening', () => {
    const { g } = crowd(1);
    g.start(T0);
    g.cmd({ type: 'pause' }, T0 + 1000);
    expect(g.state.pause?.remainingMs).toBe(23_000);
    g.tick(T0 + 9000);
    expect(g.phase).toBe('intro');
    g.cmd({ type: 'resume' }, T0 + 11_000);
    expect(g.round).toMatchObject({ openAt: T0 + 14_000, endsAt: T0 + 34_000 });
    g.tick(T0 + 13_999);
    expect(g.phase).toBe('intro');
    g.tick(T0 + 14_000);
    expect(g.phase).toBe('open');
  });

  it('pause / resume are invalid where they make no sense', () => {
    const g = new Game();
    expect(g.cmd({ type: 'pause' })).toEqual({ ok: false, err: 'invalid' });
    expect(g.cmd({ type: 'resume' })).toEqual({ ok: false, err: 'invalid' });
    g.start(T0);
    g.tick(T0 + INTRO);
    g.cmd({ type: 'pause' });
    expect(g.cmd({ type: 'pause' })).toEqual({ ok: false, err: 'invalid' });
    g.cmd({ type: 'resume' });
    g.revealCmd();
    expect(g.cmd({ type: 'pause' })).toEqual({ ok: false, err: 'invalid' });
    g.tick(g.now + LOCK);
    expect(g.cmd({ type: 'pause' })).toEqual({ ok: false, err: 'invalid' });
  });

  it('reveal and skip while paused clear the pause', () => {
    const { g } = openGame();
    g.cmd({ type: 'pause' }, T0 + 10_000);
    g.revealCmd(T0 + 11_000);
    expect(g.state).toMatchObject({ phase: 'locked', pause: null });

    const h = openGame().g;
    h.cmd({ type: 'pause' }, T0 + 10_000);
    h.skip(T0 + 11_000);
    expect(h.state).toMatchObject({ phase: 'intro', pause: null, cur: 1 });
  });

  it('addTime extends endsAt in open and intro, and the remaining time while paused', () => {
    const { g } = openGame();
    expect(g.cmd({ type: 'addTime', ms: 15_000 }, T0 + 10_000)).toMatchObject({ ok: true });
    expect(g.round).toMatchObject({ openAt: T0 + INTRO, endsAt: T0 + 39_000 });
    g.tick(T0 + 38_999);
    expect(g.phase).toBe('open');

    const intro = crowd(1).g;
    intro.start(T0);
    intro.cmd({ type: 'addTime', ms: 5000 }, T0 + 1000);
    expect(intro.round).toMatchObject({ openAt: T0 + INTRO, endsAt: T0 + 29_000 });

    const paused = openGame().g;
    paused.cmd({ type: 'pause' }, T0 + 10_000);
    paused.cmd({ type: 'addTime', ms: 15_000 }, T0 + 20_000);
    expect(paused.state.pause?.remainingMs).toBe(29_000);
    paused.cmd({ type: 'resume' }, T0 + 50_000);
    expect(paused.round).toMatchObject({ openAt: T0 + 44_000, endsAt: T0 + 79_000 });
  });

  it('negative addTime never goes before the opening nor below zero remaining', () => {
    const { g } = openGame();
    g.cmd({ type: 'addTime', ms: -100_000 }, T0 + 10_000);
    expect(g.round.endsAt).toBe(T0 + INTRO);
    // The deadline is already past, so the round locks right away.
    expect(g.phase).toBe('locked');

    const p = openGame().g;
    p.cmd({ type: 'pause' }, T0 + 10_000);
    p.cmd({ type: 'addTime', ms: -20_000 });
    expect(p.state.pause?.remainingMs).toBe(0);
    expect(p.round.endsAt).toBe(T0 + 10_000);
    p.cmd({ type: 'resume' }, T0 + 20_000);
    expect(p.phase).toBe('locked');
  });

  it('addTime is invalid outside intro/open', () => {
    const { g } = openGame();
    g.revealCmd();
    expect(g.cmd({ type: 'addTime', ms: 15_000 })).toEqual({ ok: false, err: 'invalid' });
  });
});

// ---------- Skip / jumpTo / end ----------

describe('skip, jumpTo, end', () => {
  it('skip from intro, open or locked goes to the next question; the round scores nothing', () => {
    for (const where of ['intro', 'open', 'locked'] as const) {
      const g = new Game();
      const a = g.join('A');
      g.start(T0);
      if (where !== 'intro') {
        g.tick(T0 + INTRO);
        g.answer(a, ch('blue'), { at: T0 + INTRO + 1000 });
      }
      if (where === 'locked') g.revealCmd();
      expect(g.phase).toBe(where);
      const rev = g.state.phaseRev;
      expect(g.skip()).toEqual({ ok: true, phaseRev: rev + 1 });
      expect(g.state).toMatchObject({ phase: 'intro', cur: 1 });
      expect(g.state.rounds[0]).toMatchObject({ skipped: true });
      expect(g.state.rounds[0]?.results).toBeUndefined();
      expect(g.round.qid).toBe('q2');
      expect(computeStandings(g.state.rounds, g.state.players, null)[0]?.score).toBe(0);
    }
  });

  it('skip is invalid in reveal/board; skipping the last question ends the game', () => {
    const g = new Game();
    g.start(T0);
    reveal(g);
    expect(g.skip()).toEqual({ ok: false, err: 'invalid' });
    g.advance();
    expect(g.skip()).toEqual({ ok: false, err: 'invalid' });
    g.advance();
    g.skip();
    expect(g.round.qid).toBe('q3');
    g.skip();
    expect(g.state).toMatchObject({ phase: 'final', finalStep: 0 });
    // A skipped question is never picked as "next" again.
    expect(nextQuestion(g.state, g.content)).toBeNull();
  });

  it('jumpTo starts any unplayed question; the live round is skipped', () => {
    const g = new Game();
    g.join('A');
    expect(g.cmd({ type: 'jumpTo', qid: 'q3' }, T0)).toMatchObject({ ok: true });
    expect(g.state).toMatchObject({ phase: 'intro', cur: 0 });
    expect(g.round.qid).toBe('q3');
    g.tick(T0 + INTRO);
    g.cmd({ type: 'jumpTo', qid: 'q2' });
    expect(g.state.rounds[0]?.skipped).toBe(true);
    expect(g.round.qid).toBe('q2');
    reveal(g);
    // Played (scored) questions cannot be replayed; skipped ones can; unknown ids are invalid.
    expect(g.cmd({ type: 'jumpTo', qid: 'q2' })).toEqual({ ok: false, err: 'invalid' });
    expect(g.cmd({ type: 'jumpTo', qid: 'nope' })).toEqual({ ok: false, err: 'invalid' });
    g.cmd({ type: 'jumpTo', qid: 'q3' });
    expect(g.state.rounds.map((r) => r.qid)).toEqual(['q3', 'q2', 'q3']);
    expect(g.state.rounds[1]?.results).toBeDefined();
    // "Next" continues with the first unplayed question in content order.
    expect(nextQuestion(g.state, g.content)?.id).toBe('q1');
  });

  it('jumpTo can start a disabled question and works from the final', () => {
    const g = new Game();
    g.cmd({ type: 'end' }, T0);
    g.cmd({ type: 'jumpTo', qid: 'q4' });
    expect(g.state).toMatchObject({ phase: 'intro' });
    expect(g.round.qid).toBe('q4');
  });

  it('end: from a live round (skipped), from the board (kept), from the lobby; not twice', () => {
    const g = new Game();
    const a = g.join('A');
    g.start(T0);
    g.tick(T0 + INTRO);
    g.answer(a, ch('blue'));
    g.cmd({ type: 'end' });
    expect(g.state).toMatchObject({ phase: 'final', finalStep: 0, pause: null });
    expect(g.state.rounds[0]?.skipped).toBe(true);
    expect(g.cmd({ type: 'end' })).toEqual({ ok: false, err: 'invalid' });

    const h = new Game();
    const b = h.join('B');
    h.start(T0);
    reveal(h, [[b, ch('blue')]]);
    h.advance();
    h.cmd({ type: 'end' });
    expect(h.phase).toBe('final');
    expect(h.state.rounds[0]?.results?.[b]?.correct).toBe(true);

    const l = new Game();
    l.cmd({ type: 'end' });
    expect(l.phase).toBe('final');
  });
});

// ---------- Reset / new game ----------

describe('resetScores and newGame', () => {
  it('resetScores returns to the lobby, keeps players and Vlados, wipes rounds', () => {
    const g = new Game();
    const a = g.join('A');
    const v = g.join('V');
    g.cmd({ type: 'setVlados', id: v });
    g.start(T0);
    reveal(g, [[a, ch('blue')]]);
    const rev = g.state.phaseRev;
    expect(g.cmd({ type: 'resetScores' })).toEqual({ ok: true, phaseRev: rev + 1 });
    expect(g.state).toMatchObject({ phase: 'lobby', rounds: [], cur: -1, pause: null, finalStep: 0, gameId: 'g1', vladosId: v });
    expect(Object.keys(g.state.players)).toEqual([a, v]);
    expect(computeStandings(g.state.rounds, g.state.players, v)[0]?.score).toBe(0);
    g.start();
    expect(g.round.qid).toBe('q1');
  });

  it('newGame wipes players and gets a new id', () => {
    const g = new Game();
    const a = g.join('A');
    g.cmd({ type: 'setVlados', id: a });
    g.cmd({ type: 'tvBanner', text: 'Привет' });
    g.start(T0);
    g.send({ t: 'cmd', cmd: { type: 'newGame' }, gameId: 'g2' }, T0 + 5000);
    expect(g.ack).toMatchObject({ ok: true });
    expect(g.state).toMatchObject({
      gameId: 'g2',
      phase: 'lobby',
      players: {},
      vladosId: null,
      rounds: [],
      cur: -1,
      tvBanner: null,
      phaseAt: T0 + 5000,
    });
    expect(g.effects).toContainEqual({ k: 'newGame', gameId: 'g2' });

    // Without an explicit id one is derived deterministically.
    const h = new Game();
    h.cmd({ type: 'newGame' }, T0);
    const derived = h.state.gameId;
    expect(derived).not.toBe('g1');
    const k = new Game();
    k.cmd({ type: 'newGame' }, T0);
    expect(k.state.gameId).toBe(derived);
  });
});

// ---------- Crash resume ----------

describe('crash resume (boot)', () => {
  function openWithAnswers() {
    const { g, ids } = crowd(2);
    g.start(T0);
    g.tick(T0 + INTRO);
    return { g, ids: ids as [string, string] };
  }

  it('open → paused "recovered" with endsAt − savedAt remaining; everyone offline', () => {
    const { g, ids } = openWithAnswers();
    g.edit((s) => (s.savedAt = T0 + 10_000));
    const rev = g.state.phaseRev;
    g.send({ t: 'boot' }, T0 + 60_000);
    expect(g.state.pause).toEqual({ at: T0 + 60_000, remainingMs: 14_000, reason: 'recovered' });
    expect(g.state).toMatchObject({ phase: 'open', phaseRev: rev });
    for (const id of ids) expect(g.state.players[id]).toMatchObject({ online: false, lastSeen: T0 + 10_000 });
    expect(kinds(g.effects)).toEqual(['save', 'broadcast', 'schedule']);
    expect(g.effects).toContainEqual({ k: 'schedule', at: null });

    g.cmd({ type: 'resume' }, T0 + 70_000);
    expect(g.round).toMatchObject({ openAt: T0 + 64_000, endsAt: T0 + 84_000 });
    expect(g.answer(ids[0], ch('blue'), { at: T0 + 70_000 })).toEqual({ ok: true, elapsedMs: 6000 });
  });

  it('remaining is at least 10 s, even if the deadline passed before the crash', () => {
    for (const savedAt of [T0 + 20_000, T0 + 30_000]) {
      const { g } = openWithAnswers();
      g.edit((s) => (s.savedAt = savedAt));
      g.send({ t: 'boot' }, T0 + 90_000);
      expect(g.state).toMatchObject({ phase: 'open', pause: { remainingMs: 10_000, reason: 'recovered' } });
    }
  });

  it('intro → paused, and the intro continues after resume', () => {
    const { g } = crowd(1);
    g.start(T0);
    g.edit((s) => (s.savedAt = T0 + 1000));
    g.send({ t: 'boot' }, T0 + 50_000);
    expect(g.state).toMatchObject({ phase: 'intro', pause: { remainingMs: 23_000, reason: 'recovered' } });
    g.cmd({ type: 'resume' }, T0 + 60_000);
    expect(g.round).toMatchObject({ openAt: T0 + 63_000, endsAt: T0 + 83_000 });
  });

  it('locked → results computed and revealed', () => {
    const { g, ids } = openWithAnswers();
    g.answer(ids[0], ch('blue'), { at: T0 + INTRO + 1000 });
    g.revealCmd(T0 + INTRO + 2000);
    g.edit((s) => (s.savedAt = T0 + INTRO + 2000));
    g.send({ t: 'boot' }, T0 + 99_000);
    expect(g.state).toMatchObject({ phase: 'reveal', pause: null });
    expect(g.round.revealedAt).toBe(T0 + 99_000);
    expect(g.round.results?.[ids[0]]).toMatchObject({ correct: true, points: 975 });
  });

  it('reveal/board/final restart their auto-advance timer; lobby only drops presence', () => {
    const g = new Game(mkContent((c) => Object.assign(c.settings, { autopilot: false, autoAdvance: { ...c.settings.autoAdvance, boardToNextS: 5 } })));
    g.join('A');
    g.start(T0);
    reveal(g);
    g.advance();
    g.send({ t: 'boot' }, T0 + 500_000);
    expect(g.state).toMatchObject({ phase: 'board', phaseAt: T0 + 500_000 });
    expect(nextDeadline(g.state, g.settings)).toBe(T0 + 505_000);

    const l = new Game();
    const a = l.join('A');
    l.send({ t: 'boot' }, T0 + 1000);
    expect(l.state).toMatchObject({ phase: 'lobby', pause: null });
    expect(l.state.players[a]?.online).toBe(false);
  });

  it('an admin pause survives the restart unchanged', () => {
    const { g } = openWithAnswers();
    g.cmd({ type: 'pause' }, T0 + 10_000);
    g.edit((s) => (s.savedAt = T0 + 12_000));
    g.send({ t: 'boot' }, T0 + 60_000);
    expect(g.state.pause).toEqual({ at: T0 + 10_000, remainingMs: 14_000, reason: 'admin' });
  });
});

// ---------- Mass disconnect ----------

describe('auto-pause on mass disconnect', () => {
  it('pauses when more than 30 % of online players drop within 5 s', () => {
    const { g, ids } = crowd(10);
    g.start(T0);
    g.tick(T0 + INTRO);
    g.presence(ids[0] as string, false, T0 + 10_000);
    g.presence(ids[1] as string, false, T0 + 10_500);
    g.presence(ids[2] as string, false, T0 + 11_000);
    expect(g.state.pause).toBeNull(); // 3 of 10 = 30 %, not more
    const rev = g.state.phaseRev;
    g.presence(ids[3] as string, false, T0 + 11_500);
    expect(g.state.pause).toEqual({ at: T0 + 11_500, remainingMs: 12_500, reason: 'mass-disconnect' });
    expect(g.state.phaseRev).toBe(rev);
    expect(kinds(g.effects)).toContain('save');
  });

  it('drops spread over more than 5 s do not pause', () => {
    const { g, ids } = crowd(10);
    g.cmd({ type: 'jumpTo', qid: 'q3' }, T0); // 40 s question
    g.tick(T0 + INTRO);
    for (let i = 0; i < 6; i++) g.presence(ids[i] as string, false, T0 + 5000 + i * 6000);
    expect(g.state.pause).toBeNull();
  });

  it('needs at least 3 drops (tiny test games)', () => {
    const { g, ids } = crowd(3);
    g.start(T0);
    g.tick(T0 + INTRO);
    g.presence(ids[0] as string, false, T0 + 10_000);
    g.presence(ids[1] as string, false, T0 + 10_100);
    expect(g.state.pause).toBeNull();
  });

  it('ignores kicked players when computing the share', () => {
    const { g, ids } = crowd(10);
    for (const id of ids.slice(5)) g.cmd({ type: 'kick', id });
    g.start(T0);
    g.tick(T0 + INTRO);
    for (const id of ids.slice(0, 3)) g.presence(id, false, T0 + 10_000);
    expect(g.state.pause?.reason).toBe('mass-disconnect');
  });

  it('only during open, and only when enabled', () => {
    const intro = crowd(10);
    intro.g.start(T0);
    for (const id of intro.ids.slice(0, 5)) intro.g.presence(id, false, T0 + 1000);
    expect(intro.g.state.pause).toBeNull();

    const off = crowd(10, mkContent((c) => (c.settings.autoPauseOnMassDisconnect = false)));
    off.g.start(T0);
    off.g.tick(T0 + INTRO);
    for (const id of off.ids.slice(0, 5)) off.g.presence(id, false, T0 + 10_000);
    expect(off.g.state.pause).toBeNull();
  });

  it('presence alone is not saved and only refreshes TV/admin', () => {
    const { g, ids } = crowd(2);
    g.presence(ids[0] as string, false, T0 + 1);
    expect(g.state.players[ids[0] as string]).toMatchObject({ online: false, lastSeen: T0 + 1 });
    expect(kinds(g.effects)).toEqual(['broadcast', 'schedule']);
    expect(g.effects[0]).toEqual({ k: 'broadcast', views: ['tv', 'admin'], me: [] });
    const s = g.state;
    g.presence('ghost', true);
    expect(g.state).toBe(s);
  });
});

// ---------- Player admin ----------

describe('player admin commands', () => {
  it('kick / unkick', () => {
    const g = new Game();
    const a = g.join('A');
    expect(g.cmd({ type: 'kick', id: a })).toMatchObject({ ok: true });
    expect(g.state.players[a]?.kicked).toBe(true);
    expect(g.effects).toContainEqual({ k: 'kick', id: a });
    const s = g.state;
    expect(g.cmd({ type: 'kick', id: a })).toMatchObject({ ok: true });
    expect(g.state).toBe(s);
    g.cmd({ type: 'unkick', id: a });
    expect(g.state.players[a]?.kicked).toBe(false);
    expect(g.cmd({ type: 'kick', id: 'ghost' })).toEqual({ ok: false, err: 'invalid' });
  });

  it('rename normalizes and keeps names unique', () => {
    const g = new Game();
    const a = g.join('Аня');
    const b = g.join('Боря');
    expect(g.cmd({ type: 'rename', id: b, name: '  аня ' })).toEqual({ ok: false, err: 'invalid' });
    expect(g.cmd({ type: 'rename', id: b, name: '' })).toEqual({ ok: false, err: 'invalid' });
    expect(g.cmd({ type: 'rename', id: 'ghost', name: 'X' })).toEqual({ ok: false, err: 'invalid' });
    g.cmd({ type: 'rename', id: a, name: 'АНЯ' });
    expect(g.state.players[a]?.name).toBe('АНЯ');
    g.cmd({ type: 'rename', id: b, name: '  Борис   Б ' });
    expect(g.state.players[b]?.name).toBe('Борис Б');
  });

  it('setVlados', () => {
    const g = new Game();
    const a = g.join('A');
    g.cmd({ type: 'setVlados', id: a });
    expect(g.state.vladosId).toBe(a);
    g.cmd({ type: 'setVlados', id: null });
    expect(g.state.vladosId).toBeNull();
    expect(g.cmd({ type: 'setVlados', id: 'ghost' })).toEqual({ ok: false, err: 'invalid' });
  });

  it('merge folds a duplicate into the original', () => {
    const g = new Game();
    const a = g.join('Аня', T0 - 200, { avatar: 'a.jpg' });
    const b = g.join('Аня 2', T0 - 100, { avatar: 'b.jpg' });
    g.cmd({ type: 'setVlados', id: b });
    g.start(T0);
    reveal(g, [
      [a, ch('blue')],
      [b, ch('red')],
    ]);
    g.advance();
    g.advance();
    reveal(g, [[b, num(1337.5)]]);
    const bAnswer = g.round.answers[b];
    const bResult = g.round.results?.[b];
    expect(g.cmd({ type: 'merge', from: b, into: a })).toMatchObject({ ok: true });
    expect(g.state.players[b]).toBeUndefined();
    expect(g.state.vladosId).toBe(a);
    // Round 0: both answered → the original's answer stays. Round 1: moved over.
    expect(g.state.rounds[0]?.answers[a]?.p).toEqual(ch('blue'));
    expect(g.state.rounds[0]?.answers[b]).toBeUndefined();
    expect(g.state.rounds[1]?.answers[a]).toEqual(bAnswer);
    expect(g.state.rounds[1]?.results?.[a]).toEqual(bResult);
    expect(g.state.players[a]).toMatchObject({ joinedAt: T0 - 200, avatar: 'a.jpg' });
    expect(g.effects).toContainEqual({ k: 'merged', from: b, into: a });
    expect(g.effects).toContainEqual({ k: 'deleteAvatar', file: 'b.jpg' });
    expect(g.cmd({ type: 'merge', from: a, into: a })).toEqual({ ok: false, err: 'invalid' });
    expect(g.cmd({ type: 'merge', from: 'ghost', into: a })).toEqual({ ok: false, err: 'invalid' });
  });

  it('removeAvatar and the avatar event', () => {
    const g = new Game();
    const a = g.join('A', T0, { avatar: 'old.jpg' });
    g.send({ t: 'avatar', playerId: a, file: 'new.jpg' });
    expect(g.ack).toEqual({ ok: true, avatar: '/avatars/new.jpg' });
    expect(g.effects).toContainEqual({ k: 'deleteAvatar', file: 'old.jpg' });
    expect(g.effects).toContainEqual({ k: 'broadcast', views: ['tv', 'admin'], me: [a] });
    g.send({ t: 'avatar', playerId: 'ghost', file: 'x.jpg' });
    expect(g.ack).toEqual({ ok: false, err: 'no_player' });

    g.cmd({ type: 'removeAvatar', id: a });
    expect(g.state.players[a]?.avatar).toBeUndefined();
    expect(g.effects).toContainEqual({ k: 'deleteAvatar', file: 'new.jpg' });
    const s = g.state;
    expect(g.cmd({ type: 'removeAvatar', id: a })).toMatchObject({ ok: true });
    expect(g.state).toBe(s);

    g.cmd({ type: 'kick', id: a });
    g.send({ t: 'avatar', playerId: a, file: 'y.jpg' });
    expect(g.ack).toEqual({ ok: false, err: 'no_player' });
  });

  it('tvBanner, qrMode, openTv and bots', () => {
    const g = new Game();
    g.cmd({ type: 'tvBanner', text: '  Торт через 5 минут  ' });
    expect(g.state.tvBanner).toBe('Торт через 5 минут');
    expect(g.effects).toContainEqual({ k: 'broadcast', views: ['tv', 'admin'], me: [] });
    g.cmd({ type: 'tvBanner', text: '   ' });
    expect(g.state.tvBanner).toBeNull();

    const s = g.state;
    g.cmd({ type: 'qrMode', mode: 'lan' });
    expect(g.effects).toContainEqual({ k: 'settings', patch: { qrMode: 'lan' } });
    g.cmd({ type: 'openTv' });
    expect(g.effects).toContainEqual({ k: 'openTv' });
    expect(g.cmd({ type: 'bots', n: 20 })).toEqual({ ok: true, phaseRev: 0 });
    expect(g.effects).toContainEqual({ k: 'bots', n: 20 });
    expect(g.state).toBe(s);
  });
});

// ---------- Rescore ----------

describe('rescoreRound', () => {
  it('re-freezes the fixed question from content and recomputes, keeping the played time limit', () => {
    const g = new Game();
    const a = g.join('A');
    const b = g.join('B');
    g.start(T0);
    reveal(g, [
      [a, ch('red')],
      [b, ch('blue')],
    ]);
    expect(g.round.results?.[a]?.correct).toBe(false);
    g.content = mkContent((c) => {
      const q = c.questions[0] as ChoiceQ;
      q.correctId = 'red';
      q.timeLimitS = 99;
    });
    expect(g.cmd({ type: 'rescoreRound', round: 0 })).toMatchObject({ ok: true });
    expect(g.round.q).toMatchObject({ correctId: 'red', timeLimitS: 20 });
    expect(g.round.results?.[a]).toEqual({ points: 975, accuracy: 1, correct: true });
    expect(g.round.results?.[b]?.correct).toBe(false);
  });

  it('refuses unplayed, skipped, missing and incompatible rounds', () => {
    const g = new Game();
    g.start(T0);
    expect(g.cmd({ type: 'rescoreRound', round: 0 })).toEqual({ ok: false, err: 'invalid' });
    g.skip();
    expect(g.cmd({ type: 'rescoreRound', round: 0 })).toEqual({ ok: false, err: 'invalid' });
    expect(g.cmd({ type: 'rescoreRound', round: 9 })).toEqual({ ok: false, err: 'invalid' });
    reveal(g);
    g.content = mkContent((c) => (c.questions[1] = { ...structuredClone(Q1), id: 'q2' }));
    expect(g.cmd({ type: 'rescoreRound', round: 1 })).toEqual({ ok: false, err: 'invalid' });
  });

  it('ordering: a corrected order rescored, changed items refused', () => {
    const g = new Game();
    const a = g.join('A');
    g.cmd({ type: 'jumpTo', qid: 'q3' }, T0);
    reveal(g, [[a, ord('b', 'a', 'c', 'd')]]);
    expect(g.round.results?.[a]?.correct).toBe(false);
    g.content = mkContent((c) => {
      const q = c.questions[2] as OrderingQ;
      q.items = [q.items[1], q.items[0], q.items[2], q.items[3]] as OrderingQ['items'];
    });
    g.cmd({ type: 'rescoreRound', round: 0 });
    expect(g.round.results?.[a]?.correct).toBe(true);
    g.content = mkContent((c) => ((c.questions[2] as OrderingQ).items[3] = { id: 'e', text: 'Новое' }));
    expect(g.cmd({ type: 'rescoreRound', round: 0 })).toEqual({ ok: false, err: 'invalid' });
  });
});

// ---------- Deadlines ----------

describe('nextDeadline', () => {
  it('per phase (autopilot off: the autoAdvance numbers)', () => {
    const g = new Game(mkContent((c) => Object.assign(c.settings, { autopilot: false, autoAdvance: { revealToBoardS: 10, boardToNextS: null, finalStepS: 3 } })));
    g.join('A');
    expect(nextDeadline(g.state, g.settings)).toBeNull();
    g.start(T0);
    expect(nextDeadline(g.state, g.settings)).toBe(T0 + INTRO);
    g.tick(T0 + INTRO);
    expect(nextDeadline(g.state, g.settings)).toBe(T0 + INTRO + 20_000);
    g.revealCmd(T0 + 5000);
    expect(nextDeadline(g.state, g.settings)).toBe(T0 + 5000 + LOCK);
    g.tick(T0 + 5000 + LOCK);
    expect(nextDeadline(g.state, g.settings)).toBe(T0 + 5000 + LOCK + 10_000);
    g.advance();
    expect(nextDeadline(g.state, g.settings)).toBeNull();
    g.cmd({ type: 'end' }, T0 + 20_000);
    expect(nextDeadline(g.state, g.settings)).toBe(T0 + 23_000);
  });
});

// ---------- Results & ranking ----------

const player = (id: string, joinedAt: number, over: Partial<Player> = {}): Player => ({
  id,
  token: `t-${id}`,
  code: '0000',
  name: id.toUpperCase(),
  seed: joinedAt,
  joinedAt,
  lastSeen: joinedAt,
  online: true,
  kicked: false,
  ...over,
});

type Row = [points: number, correct: boolean, elapsedMs: number, accuracy?: number];

function scoredRound(qid: string, rows: Record<string, Row>, over: Partial<Round> = {}): Round {
  const answers: Round['answers'] = {};
  const results: Record<string, RoundResult> = {};
  for (const [id, [points, correct, elapsedMs, accuracy]] of Object.entries(rows)) {
    answers[id] = { p: ch('x'), elapsedMs, at: 0, cid: `${qid}-${id}` };
    results[id] = { points, correct, accuracy: accuracy ?? (correct ? 1 : 0) };
  }
  return { qid, q: { ...Q1, id: qid }, introAt: 0, openAt: 0, endsAt: 20_000, answers, results, ...over };
}

describe('standings', () => {
  const players = Object.fromEntries(
    [
      player('a', 1),
      player('b', 2),
      player('c', 3),
      player('d', 4),
      player('e', 5),
      player('f', 0),
      player('v', 6),
      player('k', 7, { kicked: true }),
    ].map((p) => [p.id, p]),
  );
  const rounds = [
    scoredRound('r1', { a: [1000, true, 5000], b: [1000, true, 3000], c: [500, true, 1000], d: [0, false, 100], v: [2000, true, 0], k: [3000, true, 0] }),
    scoredRound('r2', { a: [0, false, 5000], b: [0, false, 5000], c: [500, true, 1000], d: [1000, true, 100] }),
    scoredRound('r3', { e: [5000, true, 0] }, { skipped: true }),
    { ...scoredRound('r4', { f: [5000, true, 0] }), results: undefined },
  ];

  it('score desc, correct desc, total elapsed asc, joinedAt asc; Vlados unranked; kicked excluded', () => {
    const st = computeStandings(rounds, players, 'v');
    expect(st.map((s) => [s.id, s.rank])).toEqual([
      ['c', 1],
      ['d', 2],
      ['b', 3],
      ['a', 4],
      ['f', 5],
      ['e', 6],
      ['v', null],
    ]);
    expect(st.find((s) => s.id === 'a')).toMatchObject({ score: 1000, correct: 1, answered: 2, elapsedMs: 10_000 });
    // Unanswered scored rounds count as the full time limit; skipped / unrevealed rounds do not count.
    expect(st.find((s) => s.id === 'e')).toMatchObject({ score: 0, answered: 0, elapsedMs: 40_000 });
    expect(st.find((s) => s.id === 'v')).toMatchObject({ score: 2000, rank: null });
    expect(st.some((s) => s.id === 'k')).toBe(false);
  });

  it('without Vlados everyone is ranked', () => {
    const st = computeStandings(rounds, players, null);
    expect(st[0]).toMatchObject({ id: 'v', rank: 1 });
  });

  it('computeRoundResults skips kicked and unknown players', () => {
    const round: Round = {
      qid: 'q1',
      q: Q1,
      introAt: 0,
      openAt: 0,
      endsAt: 20_000,
      answers: {
        a: { p: ch('blue'), elapsedMs: 0, at: 0, cid: '1' },
        k: { p: ch('blue'), elapsedMs: 0, at: 0, cid: '2' },
        ghost: { p: ch('blue'), elapsedMs: 0, at: 0, cid: '3' },
      },
    };
    expect(Object.keys(computeRoundResults(round, players, null, defaultSettings().scoring))).toEqual(['a']);
  });
});

describe('Vlados', () => {
  it('is excluded from deciding the closest guess and from ranks', () => {
    const g = new Game();
    const [a, b, v] = [g.join('A'), g.join('B'), g.join('Владос')];
    g.cmd({ type: 'setVlados', id: v });
    g.cmd({ type: 'jumpTo', qid: 'q2' }, T0);
    reveal(g, [
      [a, num(1300)],
      [b, num(1400)],
      [v, num(1337.5)],
    ]);
    const res = g.round.results ?? {};
    expect(res[a]?.closest).toBe(true);
    expect(res[b]?.closest).toBe(false);
    expect(res[v]).toMatchObject({ closest: true, correct: true });
    const me = meView(g.state, v);
    expect(me).toMatchObject({ isVlados: true, rank: null, gapToNext: null, rankedCount: 2 });
    expect(me?.last).toMatchObject({ rankBefore: null, rankAfter: null });
    expect(meView(g.state, a)?.rank).toBe(1);
  });

  function comparison(vAcc: number) {
    const players = Object.fromEntries([player('a', 1), player('b', 2), player('c', 3), player('v', 4)].map((p) => [p.id, p]));
    const rounds = [
      scoredRound('r1', { v: [0, true, 0, vAcc], a: [0, true, 0, 1], c: [0, true, 0, 0.8] }),
      scoredRound('r2', { v: [0, true, 0, vAcc], a: [0, true, 0, 0.5] }),
    ];
    return vladosComparison(rounds, players, 'v');
  }

  it('compares with guests who answered at least half the rounds and with the best guest', () => {
    const best = comparison(1);
    expect(best).toMatchObject({ vladosAccuracy: 1, verdict: 'best', bestGuest: { id: 'a', accuracy: 0.75 } });
    // b answered nothing → excluded; c answered 1 of 2 → included with 0.4.
    expect(best?.guestsAccuracy).toBeCloseTo((0.75 + 0.4) / 2, 12);
    expect(comparison(0.75)?.verdict).toBe('best');
    expect(comparison(0.6)?.verdict).toBe('middle');
    expect(comparison(0.5)?.verdict).toBe('worst');
  });

  it('null without (or with a kicked) Vlados; "best" when no guest qualifies', () => {
    const players = { v: player('v', 1), a: player('a', 2) };
    const rounds = [scoredRound('r1', { v: [0, false, 0, 0.3] })];
    expect(vladosComparison(rounds, players, null)).toBeNull();
    expect(vladosComparison(rounds, { ...players, v: player('v', 1, { kicked: true }) }, 'v')).toBeNull();
    expect(vladosComparison(rounds, players, 'v')).toMatchObject({ guestsAccuracy: 0, bestGuest: null, verdict: 'best' });
  });
});

// ---------- Views ----------

const CTX: ViewCtx = { cdnBase: 'https://cdn.example/vlados', urls: { direct: 'https://direct.example', pages: 'https://pages.example', lan: null } };

describe('views: no answer leaks before reveal', () => {
  const LEAKS = ['correctId', 'tolerance', 'zeroAt', 'revealText', 'СЕКРЕТ-РАСКРЫТИЯ', 'ЗАМЕТКА-АДМИНА', 'notes', '1337.5'];
  const clean = (v: unknown) => {
    const json = JSON.stringify(v);
    for (const bad of LEAKS) expect(json, bad).not.toContain(bad);
  };

  it('choice: public question is whitelisted in intro, open and locked (pub, tv, me)', () => {
    const g = new Game();
    const [a, b] = [g.join('A'), g.join('B')];
    g.start(T0);
    for (const step of ['intro', 'open', 'locked'] as const) {
      if (step === 'open') {
        g.tick(T0 + INTRO);
        g.answer(a, ch('blue'));
      }
      if (step === 'locked') g.revealCmd();
      expect(g.phase).toBe(step);
      const pub = pubView(g.state, g.content, CTX);
      expect(pub.round?.q).toEqual({
        id: 'q1',
        title: Q1.title,
        double: false,
        timeLimitS: 20,
        type: 'choice',
        options: Q1.options,
      });
      expect(pub.reveal).toBeNull();
      clean(pub);
      const tv = tvView(g.state, g.content, CTX);
      expect(tv.answers).toBeNull();
      expect(tv.reveal).toBeNull();
      clean(tv);
      clean(meView(g.state, b));
    }
    // The answered flag is public, the choice is not.
    const tv = tvView(g.state, g.content, CTX);
    expect(tv.players.find((p) => p.id === a)?.answered).toBe(true);
    expect(JSON.stringify(meView(g.state, b))).not.toContain('"blue"');
  });

  it('number: no answer, tolerance or zeroAt', () => {
    const g = new Game();
    g.join('A');
    g.cmd({ type: 'jumpTo', qid: 'q2' }, T0);
    g.tick(T0 + INTRO);
    const pub = pubView(g.state, g.content);
    expect(pub.round?.q).toEqual({ id: 'q2', title: Q2.title, double: true, timeLimitS: 30, type: 'number', step: 0.5, unit: 'г', min: 0, max: 5000 });
    clean(pub);
    clean(tvView(g.state, g.content));
  });

  it('ordering: items in the shared shuffled order, never the correct one', () => {
    const g = new Game();
    g.cmd({ type: 'jumpTo', qid: 'q3' }, T0);
    const shown = g.round.shown;
    expect(shown).toBeDefined();
    expect([...(shown ?? [])].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(shown).not.toEqual(['a', 'b', 'c', 'd']);
    g.tick(T0 + INTRO);
    const q = pubView(g.state, g.content).round?.q;
    expect(q?.type === 'ordering' && q.items.map((i) => i.id)).toEqual(shown);
    expect(q).toMatchObject({ firstLabel: 'Раньше', lastLabel: 'Позже' });
  });

  it('the shuffle is deterministic per round seed and never the identity for n = 3..6', () => {
    for (let n = 3; n <= 6; n++) {
      const q: OrderingQ = { ...Q3, items: Array.from({ length: n }, (_, i) => ({ id: `i${i}`, text: `${i}` })) };
      const correct = q.items.map((i) => i.id);
      for (let k = 0; k < 300; k++) {
        const seed = roundSeed(`game-${k}`, k % 7, q.id);
        const order = shownOrder(q, seed);
        expect(order).not.toEqual(correct);
        expect([...order].sort()).toEqual([...correct].sort());
        expect(shownOrder(q, seed)).toEqual(order);
      }
    }
  });

  it('every engine-started ordering round is shuffled, same game → same order', () => {
    const orders = new Set<string>();
    for (let k = 0; k < 50; k++) {
      const g = new Game();
      g.edit((s) => (s.gameId = `game-${k}`));
      g.cmd({ type: 'jumpTo', qid: 'q3' }, T0);
      expect(g.round.shown).not.toEqual(['a', 'b', 'c', 'd']);
      orders.add(JSON.stringify(g.round.shown));
      const h = new Game();
      h.edit((s) => (s.gameId = `game-${k}`));
      h.cmd({ type: 'jumpTo', qid: 'q3' }, T0 + 999);
      expect(h.round.shown).toEqual(g.round.shown);
    }
    expect(orders.size).toBeGreaterThan(5);
  });
});

describe('views: reveal, board, final', () => {
  /** A, B, C guests + Vlados; Q1 answered: A blue (1 s), B red (2 s), C blue (3 s), V green (4 s). */
  function afterQ1() {
    const g = new Game(mkContent((c) => (c.settings.vladosLabel = 'Влад')));
    const a = g.join('Аня', T0 - 40, { avatar: 'a.jpg' });
    const b = g.join('Боря', T0 - 30, { avatar: 'b.jpg' });
    const c = g.join('Вика', T0 - 20);
    const v = g.join('Владос', T0 - 10, { avatar: 'v.jpg' });
    g.cmd({ type: 'setVlados', id: v });
    g.start(T0);
    reveal(g, [
      [a, ch('blue')],
      [b, ch('red')],
      [c, ch('blue')],
      [v, ch('green')],
    ]);
    return { g, a, b, c, v };
  }

  it('reveal: correct answer, guests-only distribution, Vlados answer, reveal text', () => {
    const { g, v } = afterQ1();
    const pub = pubView(g.state, g.content, CTX);
    expect(pub.reveal).toEqual({
      qid: 'q1',
      correct: { t: 'choice', id: 'blue' },
      distribution: { t: 'choice', counts: { red: 1, blue: 2, green: 0 } },
      pctCorrect: 67,
      answeredCount: 3,
      vlados: {
        player: { id: v, name: 'Владос', seed: 4 },
        answer: ch('green'),
        result: { points: 0, accuracy: 0, correct: false },
      },
      revealText: 'СЕКРЕТ-РАСКРЫТИЯ',
    });
    expect(pub.answeredCount).toBe(4);
    // TV sees every answer (sorted by time) and selfies.
    const tv = tvView(g.state, g.content, CTX);
    expect(tv.answers?.map((x) => [x.id, x.points, x.correct])).toEqual([
      ['p1', 975, true],
      ['p2', 0, false],
      ['p3', 925, true],
      ['p4', 0, false],
    ]);
    expect(tv.reveal?.vlados?.player.avatar).toBe('/avatars/v.jpg');
    expect(pub.reveal?.vlados?.player.avatar).toBeUndefined();
  });

  it('number and ordering distributions', () => {
    const g = new Game();
    const [a, b, c] = [g.join('A'), g.join('B'), g.join('C')];
    g.cmd({ type: 'jumpTo', qid: 'q2' }, T0);
    reveal(g, [
      [a, num(1300)],
      [b, num(1400)],
      [c, num(1340)],
    ]);
    expect(pubView(g.state, g.content).reveal?.distribution).toEqual({
      t: 'number',
      values: [1300, 1340, 1400],
      median: 1340,
      closest: { v: 1340, players: [{ id: c, name: 'C', seed: 3 }] },
    });
    expect(pubView(g.state, g.content).reveal?.correct).toEqual({ t: 'number', v: 1337.5, unit: 'г', tolerance: 2.5 });

    g.advance();
    g.cmd({ type: 'jumpTo', qid: 'q3' });
    reveal(g, [
      [a, ord('a', 'b', 'c', 'd')],
      [b, ord('b', 'a', 'c', 'd')],
    ]);
    const r = pubView(g.state, g.content).reveal;
    expect(r?.distribution).toEqual({ t: 'ordering', exactCount: 1, positionHits: [1, 1, 2, 2] });
    expect(r?.correct).toEqual({ t: 'ordering', ids: ['a', 'b', 'c', 'd'] });
    expect(r?.pctCorrect).toBe(50);
  });

  it('board: top 5 for phones (sigils), top 10 with selfies for TV, ranks move', () => {
    const { g, a, b, c } = afterQ1();
    g.advance();
    const pub = pubView(g.state, g.content, CTX);
    expect(pub.board).toEqual([
      { id: a, name: 'Аня', seed: 1, score: 975, rank: 1, prevRank: null, delta: 975, correctCount: 1 },
      { id: c, name: 'Вика', seed: 3, score: 925, rank: 2, prevRank: null, delta: 925, correctCount: 1 },
      { id: b, name: 'Боря', seed: 2, score: 0, rank: 3, prevRank: null, delta: 0, correctCount: 0 },
    ]);
    expect(pub.reveal).not.toBeNull();
    const tv = tvView(g.state, g.content, CTX);
    expect(tv.top10?.[0]).toMatchObject({ id: a, avatar: '/avatars/a.jpg' });

    // Round 2 (number, ×2): B nails it and overtakes.
    g.advance();
    reveal(g, [[b, num(1337.5)]]);
    g.advance();
    const board = pubView(g.state, g.content).board ?? [];
    expect(board[0]).toMatchObject({ id: b, rank: 1, prevRank: 3 });
    expect(board[0]?.delta).toBeGreaterThan(1000);
    expect(board[1]).toMatchObject({ id: a, rank: 2, prevRank: 1, delta: 0 });
  });

  it('final: podium revealed 3 → 2 → 1 with selfies, Vlados at step 4, mosaic at 5', () => {
    const { g, a, b, c, v } = afterQ1();
    g.advance();
    g.cmd({ type: 'end' });
    const podium = () => pubView(g.state, g.content).final?.podium.map((e) => e.id);
    expect(podium()).toEqual([]);
    g.advance();
    expect(podium()).toEqual([b]);
    g.advance();
    expect(podium()).toEqual([c, b]);
    g.advance();
    expect(podium()).toEqual([a, c, b]);
    expect(pubView(g.state, g.content).final?.podium[0]?.avatar).toBe('/avatars/a.jpg');
    expect(pubView(g.state, g.content).final?.vlados).toBeNull();
    g.advance();
    expect(pubView(g.state, g.content).final?.vlados).toMatchObject({ player: { id: v }, vladosAccuracy: 0, verdict: 'worst' });
    expect(tvView(g.state, g.content).mosaic).toBeNull();
    g.advance();
    expect(tvView(g.state, g.content).mosaic?.map((p) => p.id)).toEqual([a, b, c, v]);
    expect(pubView(g.state, g.content).round).toBeNull();
    expect(pubView(g.state, g.content).prefetch).toEqual([]);
  });

  it('meView: score, rank, gap, last round with rank change, own answer', () => {
    const { g, a, b, c } = afterQ1();
    expect(meView(g.state, c)).toMatchObject({
      id: c,
      name: 'Вика',
      code: '1003',
      isVlados: false,
      score: 925,
      rank: 2,
      gapToNext: 50,
      rankedCount: 3,
      answer: { round: 0, p: ch('blue'), elapsedMs: 3000 },
      last: { round: 0, qid: 'q1', points: 925, correct: true, accuracy: 1, rankBefore: null, rankAfter: 2 },
      kicked: false,
    });
    expect(meView(g.state, a)).toMatchObject({ rank: 1, gapToNext: null, avatar: '/avatars/a.jpg' });
    g.advance();
    g.advance();
    reveal(g, [[b, num(1337.5)]]);
    expect(meView(g.state, b)?.last).toMatchObject({ round: 1, rankBefore: 3, rankAfter: 1 });
    expect(meView(g.state, a)?.answer).toBeNull();
    expect(meViews(g.state)).toEqual(Object.fromEntries(Object.keys(g.state.players).map((id) => [id, meView(g.state, id)])));
    expect(meView(g.state, 'ghost')).toBeNull();
  });

  it('meView before any scored round: no rank; late joiners get no "last"', () => {
    const g = new Game();
    const a = g.join('A');
    expect(meView(g.state, a)).toMatchObject({ rank: null, gapToNext: null, last: null, answer: null });
    g.start(T0);
    reveal(g);
    const late = g.join('Поздний', g.now + 1);
    expect(meView(g.state, late)?.last).toBeNull();
    expect(meView(g.state, a)?.last).toMatchObject({ points: 0, correct: false });
  });

  it('view rev combines game and content revs; kicked players vanish from public lists', () => {
    const { g, b } = afterQ1();
    expect(pubView(g.state, g.content).rev).toBe(g.state.rev + 7);
    expect(meView(g.state, b)?.rev).toBe(g.state.rev);
    g.cmd({ type: 'kick', id: b });
    g.advance();
    expect(pubView(g.state, g.content).board?.some((e) => e.id === b)).toBe(false);
    expect(tvView(g.state, g.content).players.some((p) => p.id === b)).toBe(false);
    expect(adminView(g.state, g.content).allPlayers.find((p) => p.id === b)).toMatchObject({ kicked: true, code: '1002' });
    expect(pubView(g.state, g.content).playerCount).toBe(3);
    expect(meView(g.state, b)).toMatchObject({ kicked: true, rank: null });
  });
});

describe('views: brand, round counter, prefetch, TV and admin', () => {
  it('brand texts are resolved with the Vlados label', () => {
    const g = new Game(mkContent((c) => (c.settings.vladosLabel = 'Влад')));
    const brand = pubView(g.state, g.content).brand;
    expect(brand.texts.vladosTitle).toBe('А знает ли Влад себя?');
    expect(brand).toMatchObject({ title: g.settings.title, vladosLabel: 'Влад', reactions: true, lateJoin: true });
  });

  it('round index/total ignore skipped rounds', () => {
    const g = new Game();
    g.start(T0);
    expect(pubView(g.state, g.content).round).toMatchObject({ index: 0, total: 3, qid: 'q1', timeLimitS: 20, double: false });
    g.skip();
    expect(pubView(g.state, g.content).round).toMatchObject({ index: 0, total: 2, qid: 'q2', double: true });
    reveal(g);
    expect(pubView(g.state, g.content).round?.lockedAt).toBeDefined();
    g.advance();
    g.advance();
    expect(pubView(g.state, g.content).round).toMatchObject({ index: 1, total: 2, qid: 'q3' });
  });

  it('prefetches ready media of the next question; question media is resolved', () => {
    const content = mkContent((c) => {
      c.media = { m1: media('m1'), m2: media('m2', 'processing'), m3: media('m3') };
      (c.questions[1] as NumberQ).media = { mediaId: 'm1', onPhones: true };
      const q3 = c.questions[2] as OrderingQ;
      q3.items[0] = { ...q3.items[0], id: 'a', mediaId: 'm2' };
      q3.items[1] = { ...q3.items[1], id: 'b', mediaId: 'm3' };
    });
    const g = new Game(content);
    const ref = (id: string) => ({ id, kind: 'image', files: { sm: `${id}.sm.webp`, lg: `${id}.lg.webp` }, w: 800, h: 600 });
    expect(pubView(g.state, g.content).prefetch).toEqual([]);
    g.start(T0);
    expect(pubView(g.state, g.content).prefetch).toEqual([ref('m1')]);
    g.skip();
    g.tick(g.round.openAt);
    const pub = pubView(g.state, g.content, CTX);
    expect(pub.prefetch).toEqual([ref('m3')]);
    expect(pub.round?.q.media).toEqual({ media: ref('m1'), onPhones: true });
    expect(pub.cdnBase).toBe(CTX.cdnBase);
  });

  it('TV: appearance from settings, join info with fallback, banner, sound', () => {
    const g = new Game(
      mkContent((c) => {
        c.settings.tvAppearance = 'light';
        c.settings.qrMode = 'lan';
        c.settings.wifi = { ssid: 'Party', password: 'cake' };
      }),
    );
    const a = g.join('A');
    g.cmd({ type: 'tvBanner', text: 'Торт!' });
    const tv = tvView(g.state, g.content, CTX);
    expect(tv.appearance).toBe('light');
    expect(tv.join).toEqual({
      qrMode: 'lan',
      qrUrl: 'https://direct.example',
      direct: 'https://direct.example',
      pages: 'https://pages.example',
      lan: null,
      wifi: { ssid: 'Party', password: 'cake' },
    });
    expect(tv.banner).toBe('Торт!');
    expect(tv.sound).toEqual(g.settings.sound);
    expect(tv.players).toEqual([{ id: a, name: 'A', seed: 1, answered: false, online: true, isVlados: false, joinedAt: T0 }]);
    expect(tvView(new Game().state, mkContent()).appearance).toBe('dark');
  });

  it('admin: live answers before reveal, next question, round summaries', () => {
    const g = new Game();
    const [a, b] = [g.join('A'), g.join('B', T0, { bot: true })];
    g.start(T0);
    g.tick(T0 + INTRO);
    g.answer(a, ch('red'), { at: T0 + INTRO + 500 });
    const adm = adminView(g.state, g.content, CTX);
    expect(adm.liveAnswers[a]).toMatchObject({ p: ch('red'), elapsedMs: 500 });
    expect(adm.next).toEqual({ qid: 'q2', title: Q2.title, type: 'number' });
    expect(adm.rounds).toEqual([{ index: 0, qid: 'q1', title: Q1.title, skipped: false, answered: 1 }]);
    expect(adm.allPlayers.find((p) => p.id === b)).toMatchObject({ bot: true, kicked: false });
    expect(adm.phaseRev).toBe(g.state.phaseRev);
  });
});

// ---------- Effects & purity ----------

describe('effects and purity', () => {
  it('answer: save → ack → answered → broadcast → schedule', () => {
    const g = new Game();
    const a = g.join('A');
    g.join('B');
    g.start(T0);
    g.tick(T0 + INTRO);
    g.answer(a, ch('blue'));
    expect(kinds(g.effects)).toEqual(['save', 'ack', 'answered', 'broadcast', 'schedule']);
    expect(g.effects[2]).toEqual({ k: 'answered', id: a });
    expect(g.effects[3]).toEqual({ k: 'broadcast', views: ['pub', 'tv', 'admin'], me: [a] });
  });

  it('phase changes broadcast everything to everyone', () => {
    const g = new Game();
    g.start(T0);
    expect(g.effects).toEqual([
      { k: 'save' },
      { k: 'ack', res: { ok: true, phaseRev: 1 } },
      { k: 'broadcast', views: ['pub', 'tv', 'admin'], me: 'all' },
      { k: 'schedule', at: T0 + INTRO },
    ]);
  });

  it('rev increases by one per state-changing event', () => {
    const g = new Game();
    g.join('A');
    g.join('B');
    g.start(T0);
    expect(g.state.rev).toBe(3);
    g.tick(T0 + 100_000); // intro → open → locked in one event
    expect(g.state.rev).toBe(4);
  });

  it('is deterministic: the same events give the same states and effects', () => {
    const script = (): [GameState, Effect[]] => {
      const g = new Game();
      const [a, b] = [g.join('A'), g.join('B')];
      g.cmd({ type: 'setVlados', id: b });
      g.cmd({ type: 'jumpTo', qid: 'q3' }, T0);
      reveal(g, [
        [a, ord('a', 'c', 'b', 'd')],
        [b, ord('a', 'b', 'c', 'd')],
      ]);
      g.advance();
      g.advance();
      g.presence(a, false);
      g.cmd({ type: 'end' });
      return [g.state, g.effects];
    };
    expect(script()).toEqual(script());
  });
});
