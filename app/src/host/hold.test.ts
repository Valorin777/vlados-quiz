// «Стоп-экран» (HostCommand 'hold' / 'unhold'): the organizer's text on the TV and the whole show
// stopped in any phase — every timer frozen with its time left, no timed transition, no moving
// on — until it is released, when everything continues exactly where it stopped.

import { defaultSettings } from '@shared/defaults';
import { FB_LIMITS, type AnswerDoc, type GameDoc, type PlayerDoc } from '@shared/fbtypes';
import { WATCH } from '@shared/engine/watch';
import type { AnswerPayload, ChoiceQ, NumberQ, Settings } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { mainAction } from '../screens/tv/keys';
import { HOST_TIMING, type HostHealth, type HostSnapshot, type MediaIndex, type TotalsDoc } from './model';
import {
  answerPrecheck,
  emptyTotals,
  hostDeadline,
  hostEvent,
  initialGameDoc,
  isHeld,
  resultsOf,
  step,
  toEngineCmd,
  type HostCommand,
  type HostContent,
  type StepOut,
} from './pure';
import { buildAdminView, buildPlayerView, buildTvView, watchView } from './views';

const T0 = 1_800_000_000_000;
const INTRO = 4_000;
const LOCK = 1_500;
const REVEAL_WAIT = LOCK + HOST_TIMING.revealGraceMs;
const MIN = 60_000;

const Q1: ChoiceQ = {
  id: 'q1',
  type: 'choice',
  title: 'Цвет?',
  options: [
    { id: 'red', text: 'Красный' },
    { id: 'blue', text: 'Синий' },
  ],
  correctId: 'blue',
  timeLimitS: 20,
  double: false,
};
const Q2: NumberQ = { id: 'q2', type: 'number', title: 'Сколько?', answer: 10, min: 0, max: 100, step: 1, tolerance: 0, zeroAt: 10, timeLimitS: 20, double: false };
// a 13 s video played from 3 s: 10 s on the TV + the 5 s tail
const QV: ChoiceQ = { ...Q1, id: 'qv', title: 'Что в видео?', media: { mediaId: 'vid', onPhones: false, startAtS: 3 } };
const VMEDIA: MediaIndex = { vid: { kind: 'video', posterId: 'poster', durationS: 13 } };

const choice = (id: string): AnswerPayload => ({ t: 'choice', id });
const TEXT = '🎂 Несём торт — небольшая пауза';

function mkContent(patch: Partial<Settings> = {}, questions = [Q1, Q2]): HostContent {
  return { rev: 1, settings: { ...defaultSettings(), introMs: INTRO, lockMs: LOCK, allAnsweredDelayMs: 1_000, ...patch }, questions };
}

/** Firestore in memory, driven through step() like the driver (answers pass a mirror of the rules). */
class World {
  game: GameDoc;
  totals: TotalsDoc | null = emptyTotals(T0);
  players: Record<string, PlayerDoc> = {};
  answers: AnswerDoc[] = [];
  now = T0;

  constructor(
    public content: HostContent = mkContent(),
    public media: MediaIndex = {},
  ) {
    this.game = initialGameDoc(this.content.settings);
  }

  input() {
    const i = this.game.round?.i;
    return { gameId: 'g', game: this.game, totals: this.totals, players: this.players, answers: this.answers.filter((a) => a.round === i) };
  }
  private apply(out: StepOut): StepOut {
    if (out.changed) {
      this.game = out.game;
      this.totals = out.totals;
    }
    return out;
  }
  join(uid: string) {
    this.players[uid] = { name: uid.toUpperCase(), seed: 1, joinedAt: this.now, kicked: false, seenAt: this.now };
  }
  cmd(c: HostCommand, at = this.now): StepOut {
    this.now = at;
    const ev = hostEvent(c, this.totals);
    if (!ev) throw new Error(`not an engine command: ${c.type}`);
    return this.apply(step(this.input(), ev, at, { content: this.content, players: this.players, media: this.media }));
  }
  hold(text = TEXT, at = this.now): StepOut {
    return this.cmd({ type: 'hold', phaseRev: this.game.phaseRev, text }, at);
  }
  deadline(): number | null {
    return hostDeadline(this.input(), this.content);
  }
  /** Every timed transition due up to `t`, in order (the driver's timer). */
  until(t: number): void {
    for (let k = 0; k < 30; k++) {
      const d = this.deadline();
      if (d === null || d > t) break;
      this.now = Math.max(this.now, d);
      this.apply(step(this.input(), { t: 'tick' }, this.now, { content: this.content, players: this.players, media: this.media }));
    }
    this.now = Math.max(this.now, t);
  }
  /** A tick at `t` whatever is due (a host that keeps ticking through the hold). */
  tick(t: number): StepOut {
    this.now = t;
    return this.apply(step(this.input(), { t: 'tick' }, t, { content: this.content, players: this.players, media: this.media }));
  }
  answer(uid: string, p: AnswerPayload, at = this.now): boolean {
    const g = this.game;
    const r = g.round;
    if (!r || !(g.phase === 'open' || g.phase === 'locked' || (g.phase === 'intro' && !g.pause))) return false;
    if (at < r.openAt - FB_LIMITS.answerEarlyMs || at > r.endsAt + FB_LIMITS.answerLateMs) return false;
    this.answers.push({ uid, round: r.i, p, at });
    return true;
  }
  get round() {
    if (!this.game.round) throw new Error('no round');
    return this.game.round;
  }
}

const health: HostHealth = {
  listeners: { game: 'live', totals: 'live', lease: 'live', players: 'live', answers: 'live', content: 'live', reactions: 'live' },
  clock: { offsetMs: 0, rttMs: 20, syncedAt: T0 },
  leader: true,
  lastTickAt: null,
  lastWriteAt: null,
  lastError: null,
  pending: 0,
  warnings: [],
};

function snap(w: World): HostSnapshot {
  return {
    gameId: 'g',
    game: w.game,
    totals: w.totals,
    players: w.players,
    answers: w.answers.filter((a) => a.round === w.game.round?.i),
    answersRound: w.game.round?.i ?? null,
    content: { rev: 1, settings: w.content.settings, questions: w.content.questions, trash: [] },
    media: w.media,
    lease: { session: 's1', until: w.now + 10_000, label: 'tv', preferred: true, uid: 'admin', at: w.now },
    reactions: [],
    session: 's1',
    label: 'tv',
    health,
  };
}

const phoneOf = (w: World, uid: string) =>
  buildPlayerView({ uid, gameId: 'g', game: w.game, gameState: 'live', me: w.players[uid] ?? null, meLoaded: true, answers: {}, lastScore: null, reactionsSent: [] }, w.now);

/** Starts the first question and opens it. */
function openFirst(w: World): void {
  w.cmd({ type: 'start' });
  w.until(w.round.openAt);
  expect(w.game.phase).toBe('open');
}

describe('«стоп-экран»: hold during an open question', () => {
  it('freezes the answer timer, refuses moving on, and resumes with exactly the same time left', () => {
    const w = new World();
    for (const p of ['a', 'b', 'c']) w.join(p);
    openFirst(w);
    const open0 = w.round.openAt;
    const end0 = w.round.endsAt;
    expect(w.answer('a', choice('blue'), open0 + 2_000)).toBe(true);
    const rev = w.game.phaseRev;

    // one transaction: the text AND the pause (reason 'hold'); phaseRev stays
    const at = open0 + 6_000;
    expect(w.hold(TEXT, at)).toMatchObject({ ok: true, changed: true });
    expect(w.game).toMatchObject({ phase: 'open', phaseRev: rev, banner: TEXT, pause: { at, remainingMs: 14_000, reason: 'hold' } });
    expect(isHeld(w.game)).toBe(true);
    // nothing is due, however long it lasts (a host ticking through the hold finds nothing)
    expect(w.deadline()).toBeNull();
    expect(w.tick(at + 10 * MIN).changed).toBe(false);
    w.until(at + 30 * MIN);
    expect(w.game.phase).toBe('open');
    // nothing moves the show on while held
    for (const c of [
      { type: 'reveal', phaseRev: rev },
      { type: 'skip', phaseRev: rev },
      { type: 'pause' },
      { type: 'jumpTo', qid: 'q2' },
      { type: 'end' },
      { type: 'resetScores' },
    ] as HostCommand[]) {
      expect(w.cmd(c, at + 1_000)).toMatchObject({ ok: false, error: 'invalid' });
    }
    // phones: nothing is sent while held
    expect(answerPrecheck(w.game, { uid: 'b', joined: true, kicked: false }, w.round.i, choice('blue'), at + 1_000)).toBe('closed');

    // released 5 minutes later: the same 14 s are left, the window moved by exactly the hold
    const back = at + 5 * MIN;
    expect(w.cmd({ type: 'unhold' }, back)).toMatchObject({ ok: true, changed: true });
    expect(w.game).toMatchObject({ phase: 'open', phaseRev: rev, pause: null, banner: null });
    expect(w.round.openAt).toBe(open0 + 5 * MIN);
    expect(w.round.endsAt).toBe(end0 + 5 * MIN);
    expect(w.round.endsAt - back).toBe(14_000);
    expect(w.deadline()).toBe(back + 14_000);
    expect(w.totals?.rounds[0]?.pauses).toEqual([{ s: at, e: back, sh: 5 * MIN }]);

    // scoring: the hold never counts as answer time
    w.answer('c', choice('blue'), back + 4_000);
    w.until(w.round.endsAt + REVEAL_WAIT);
    expect(w.game.phase).toBe('reveal');
    const res = resultsOf(w.totals?.rounds[0] ?? {});
    expect(res.a?.e).toBe(2_000);
    expect(res.c?.e).toBe(10_000);
  });

  it('views: the TV and the phones see the hold; answers and reactions are off, the question stays underneath', () => {
    const w = new World();
    w.join('a');
    openFirst(w);
    w.now = w.round.openAt + 5_000;
    w.hold(TEXT);
    w.now += 42_000;
    const tv = buildTvView(snap(w), w.now);
    expect(tv.hold).toEqual({ text: TEXT, at: w.round.openAt + 5_000 });
    expect(tv.pause).toMatchObject({ reason: 'hold', remainingMs: 15_000 });
    expect(tv.timer).toMatchObject({ remainingMs: 15_000, paused: true });
    const ph = phoneOf(w, 'a');
    expect(ph.hold?.text).toBe(TEXT);
    expect(ph.screen).toBe('question'); // the screen underneath keeps its state (a typed number…)
    expect(ph.canAnswer).toBe(false);
    expect(ph.reactions.enabled).toBe(false);
    expect(ph.timer).toMatchObject({ remainingMs: 15_000, paused: true });
    const admin = buildAdminView(snap(w), w.now);
    expect(admin.can).toMatchObject({ unhold: true, hold: true, reveal: false, skip: false, advance: false, start: false, jumpTo: false, end: false, pause: false, addTime: false });
    // the TV's Space: release, but only on a second press
    expect(mainAction(admin)).toMatchObject({ cmd: { type: 'unhold' }, confirm: expect.any(String) });
    // released: back to normal everywhere
    w.cmd({ type: 'unhold' });
    const after = phoneOf(w, 'a');
    expect([after.hold, after.canAnswer, after.reactions.enabled]).toEqual([null, true, true]);
    expect(buildTvView(snap(w), w.now).hold).toBeNull();
  });
});

describe('«стоп-экран» in every phase', () => {
  it('the watch stage: the video stands at its frame and plays on from it after the hold', () => {
    const w = new World(mkContent({}, [QV, Q2]), VMEDIA);
    w.join('a');
    w.cmd({ type: 'start' });
    const at = T0 + INTRO + 6_000; // 6 s into the video
    w.until(at);
    expect(watchView(w.game, at)).toMatchObject({ stage: 'play', posMs: 6_000 });
    const open0 = w.round.openAt;
    w.hold(TEXT, at);
    // frozen at 6 s however long the parents' video takes
    expect(watchView(w.game, at + 7 * MIN)).toMatchObject({ stage: 'play', posMs: 6_000 });
    expect(w.cmd({ type: 'watchEnd', phaseRev: w.game.phaseRev }, at + MIN)).toMatchObject({ ok: false, error: 'invalid' });
    const back = at + 7 * MIN;
    w.cmd({ type: 'unhold' }, back);
    expect(w.round.openAt).toBe(open0 + 7 * MIN);
    expect(watchView(w.game, back)).toMatchObject({ stage: 'play', posMs: 6_000 });
    expect(watchView(w.game, back + 3_000)).toMatchObject({ stage: 'play', posMs: 9_000 });
    // the TV reports the end 4 s later: the answers open after the 3-2-1 with the full limit
    w.cmd({ type: 'watchEnd', phaseRev: w.game.phaseRev }, back + 4_000);
    expect(w.round.openAt).toBe(back + 4_000 + WATCH.beatMs);
  });

  it('the intro title: the opening moves by the hold', () => {
    const w = new World();
    w.cmd({ type: 'start' });
    w.hold(TEXT, T0 + 1_000);
    expect(w.game.pause).toMatchObject({ remainingMs: INTRO - 1_000 + 20_000 });
    w.until(T0 + 10 * MIN);
    expect(w.game.phase).toBe('intro');
    w.cmd({ type: 'unhold' }, T0 + 10 * MIN);
    expect(w.round.openAt).toBe(T0 + 10 * MIN + INTRO - 1_000);
    w.until(w.round.openAt);
    expect(w.game.phase).toBe('open');
  });

  it('locked: the grace before the reveal keeps its time left', () => {
    const w = new World();
    w.join('a');
    openFirst(w);
    w.until(w.round.endsAt);
    expect(w.game.phase).toBe('locked');
    const lockedAt = w.round.endsAt;
    const at = lockedAt + 1_000;
    w.hold(TEXT, at);
    expect(w.game.pause).toMatchObject({ remainingMs: REVEAL_WAIT - 1_000 });
    w.until(at + 3 * MIN);
    expect(w.game.phase).toBe('locked');
    w.cmd({ type: 'unhold' }, at + 3 * MIN);
    expect(w.totals?.rounds[0]?.lockedAt).toBe(lockedAt + 3 * MIN);
    expect(w.deadline()).toBe(at + 3 * MIN + REVEAL_WAIT - 1_000);
    w.until(at + 3 * MIN + REVEAL_WAIT);
    expect(w.game.phase).toBe('reveal');
  });

  it('reveal / board / final (autopilot off): auto-advance keeps its time left; no pause record on a scored round', () => {
    const w = new World(mkContent({ autopilot: false, autoAdvance: { revealToBoardS: 10, boardToNextS: null, finalStepS: 8 } }));
    w.join('a');
    w.join('b'); // b never answers: no early lock
    openFirst(w);
    w.answer('a', choice('blue'), w.round.openAt + 1_000);
    w.until(w.round.endsAt + REVEAL_WAIT);
    expect(w.game.phase).toBe('reveal');
    const revealAt = w.now;
    const at = revealAt + 4_000;
    w.hold(TEXT, at);
    expect(w.game.pause).toMatchObject({ remainingMs: 6_000, reason: 'hold' });
    expect(w.cmd({ type: 'advance', phaseRev: w.game.phaseRev }, at + 1_000)).toMatchObject({ ok: false, error: 'invalid' });
    w.until(at + 2 * MIN);
    expect(w.game.phase).toBe('reveal');
    w.cmd({ type: 'unhold' }, at + 2 * MIN);
    expect(w.deadline()).toBe(at + 2 * MIN + 6_000);
    expect(w.totals?.rounds[0]?.pauses).toBeUndefined();
    expect(w.game.reveal).not.toBeNull();
    w.until(at + 2 * MIN + 6_000);
    expect(w.game.phase).toBe('board');

    // the final: a step timer of 8 s, held 3 s into it
    w.cmd({ type: 'end' });
    expect(w.game.phase).toBe('final');
    const f0 = w.now;
    w.hold('Спасибо всем!', f0 + 3_000);
    expect(w.game.pause).toMatchObject({ remainingMs: 5_000 });
    w.until(f0 + 5 * MIN);
    expect(w.game.final?.step).toBe(0);
    w.cmd({ type: 'unhold' }, f0 + 5 * MIN);
    expect(w.deadline()).toBe(f0 + 5 * MIN + 5_000);
  });

  it('lobby: start waits for the release', () => {
    const w = new World();
    w.hold('📱 Кто ещё не в игре — наведите камеру на QR-код', T0);
    expect(w.game).toMatchObject({ phase: 'lobby', pause: { remainingMs: 0, reason: 'hold' } });
    expect(buildAdminView(snap(w), T0).can.start).toBe(false);
    expect(w.cmd({ type: 'start' })).toMatchObject({ ok: false, error: 'invalid' });
    w.cmd({ type: 'unhold' }, T0 + MIN);
    expect(w.game).toMatchObject({ phase: 'lobby', pause: null, banner: null });
    expect(w.cmd({ type: 'start' }).ok).toBe(true);
  });
});

describe('«стоп-экран»: the command', () => {
  it('phaseRev-guarded; text trimmed and checked; a second hold only changes the text', () => {
    const w = new World();
    w.join('a');
    openFirst(w);
    const at = w.round.openAt + 3_000;
    expect(w.cmd({ type: 'hold', phaseRev: w.game.phaseRev - 1, text: TEXT }, at)).toMatchObject({ ok: false, error: 'stale' });
    expect(w.game.pause).toBeNull();
    expect(toEngineCmd({ type: 'hold', phaseRev: 0, text: '   ' }, null)).toBeNull();
    expect(toEngineCmd({ type: 'hold', phaseRev: 0, text: 'x'.repeat(FB_LIMITS.bannerMax + 1) }, null)).toBeNull();
    expect(toEngineCmd({ type: 'hold', phaseRev: 3, text: '  Тост!  ' }, null)).toEqual({ type: 'hold', phaseRev: 3, text: 'Тост!' });
    w.hold('  Тост!  ', at);
    expect(w.game.banner).toBe('Тост!');
    // «Сменить текст»: the stop keeps its start and its time left
    w.hold('Общее фото', at + 20_000);
    expect(w.game).toMatchObject({ banner: 'Общее фото', pause: { at, remainingMs: 17_000, reason: 'hold' } });
  });

  it('over an admin pause: the same start and time left; the release covers both', () => {
    const w = new World();
    w.join('a');
    openFirst(w);
    const open0 = w.round.openAt;
    w.cmd({ type: 'pause' }, open0 + 5_000);
    w.hold(TEXT, open0 + 20_000);
    expect(w.game.pause).toEqual({ at: open0 + 5_000, remainingMs: 15_000, reason: 'hold' });
    w.cmd({ type: 'unhold' }, open0 + 65_000);
    expect(w.round.endsAt).toBe(open0 + 65_000 + 15_000);
    expect(w.totals?.rounds[0]?.pauses).toEqual([{ s: open0 + 5_000, e: open0 + 65_000, sh: 60_000 }]);
  });

  it("'resume' also ends a hold (text gone); 'unhold' without a hold is a no-op or clears a leftover text", () => {
    const w = new World();
    openFirst(w);
    w.hold(TEXT, w.round.openAt + 1_000);
    w.cmd({ type: 'resume' }, w.round.openAt + 9_000);
    expect(w.game).toMatchObject({ pause: null, banner: null });
    expect(w.cmd({ type: 'unhold' })).toMatchObject({ ok: true, changed: false });
    w.cmd({ type: 'banner', text: 'старая надпись' });
    expect(w.game.pause).toBeNull();
    expect(w.cmd({ type: 'unhold' })).toMatchObject({ ok: true, changed: true });
    expect(w.game.banner).toBeNull();
  });

  it('newGame ends it (a fresh lobby, no text)', () => {
    const w = new World();
    w.hold(TEXT, T0);
    w.cmd({ type: 'newGame' }, T0 + 1_000);
    expect(w.game).toMatchObject({ phase: 'lobby', pause: null, banner: null });
  });
});
