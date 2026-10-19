// «Сюрприз» (shared/engine/surprise.ts): a question interrupted by a video while its options are on
// screen — strictly before everyone answered and before the answer — then its reveal, then the
// final. Driven through step() like the driver, with the rules mirrored for answers.

import { defaultSettings } from '@shared/defaults';
import { SURPRISE, surpriseAfterMs, surpriseOf } from '@shared/engine/surprise';
import { FB_LIMITS, type AnswerDoc, type GameDoc, type PlayerDoc } from '@shared/fbtypes';
import type { AnswerPayload, ChoiceQ, NumberQ, Settings } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { heroAction } from '../screens/admin/core/live';
import { mainAction } from '../screens/tv/keys';
import { HOST_TIMING, type HostHealth, type HostSnapshot, type MediaIndex, type TotalsDoc } from './model';
import {
  emptyTotals,
  hostDeadline,
  hostEvent,
  initialGameDoc,
  referencedMediaIds,
  refreshedGame,
  resultsOf,
  step,
  toEngineState,
  type HostCommand,
  type HostContent,
  type StepOut,
} from './pure';
import { ME_UID, simulate } from './rehearsal';
import { buildAdminView, buildPlayerView, buildTvView, surpriseView } from './views';

const T0 = 1_800_000_000_000;
const INTRO = 4_000;
const LOCK = 1_500;
const MIN = 60_000;
const LEAD = SURPRISE.glitchMs + SURPRISE.blackMs;
const VIDEO = SURPRISE.builtin.ms;

const QS: ChoiceQ = {
  id: 'qs',
  type: 'choice',
  title: 'Кто лучше всех поздравил Владоса?',
  options: [
    { id: 'mom', text: 'Мама' },
    { id: 'dad', text: 'Папа' },
    { id: 'bro', text: 'Брат' },
  ],
  correctId: 'mom',
  timeLimitS: 30,
  double: false,
  surprise: { on: true, src: 'builtin', afterS: 5 },
};
const { surprise: _noSurprise, ...PLAIN } = QS;
const Q1: ChoiceQ = { ...PLAIN, id: 'q1', title: 'Цвет?' };
const Q2: NumberQ = { id: 'q2', type: 'number', title: 'Сколько?', answer: 10, min: 0, max: 100, step: 1, tolerance: 0, zeroAt: 10, timeLimitS: 20, double: false };

const choice = (id: string): AnswerPayload => ({ t: 'choice', id });

function mkContent(questions = [QS, Q2], patch: Partial<Settings> = {}): HostContent {
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
  tick(t: number): StepOut {
    this.now = t;
    return this.apply(step(this.input(), { t: 'tick' }, t, { content: this.content, players: this.players, media: this.media }));
  }
  /** An answer through a mirror of the rules (firestore.rules → windowOpen). */
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

const phoneOf = (w: World, uid: string, at = w.now) =>
  buildPlayerView({ uid, gameId: 'g', game: w.game, gameState: 'live', me: w.players[uid] ?? null, meLoaded: true, answers: {}, lastScore: null, reactionsSent: [] }, at);

/** 3 guests, the surprise question started and opened. */
function openSurprise(w = new World()): World {
  for (const p of ['a', 'b', 'c']) w.join(p);
  w.cmd({ type: 'start' });
  w.until(w.round.openAt);
  expect(w.game.phase).toBe('open');
  return w;
}

describe('«Сюрприз»: the interrupt', () => {
  it('comes afterS after the options appear — even when everybody has answered (no early lock)', () => {
    const w = openSurprise();
    const openAt = w.round.openAt;
    const S = openAt + 5_000;
    // nothing about it is public before it happens
    expect(w.game.next?.surprise).toBeUndefined();
    expect(Object.keys(w.round)).not.toContain('surprise');
    expect(w.answer('a', choice('mom'), openAt + 1_200)).toBe(true);
    expect(w.answer('b', choice('dad'), openAt + 1_800)).toBe(true);
    expect(w.answer('c', choice('mom'), openAt + 2_500)).toBe(true);
    // everybody answered: a normal question would lock at 2.5 s + 1 s — this one waits for the video
    expect(w.deadline()).toBe(S);
    const rev = w.game.phaseRev;
    w.until(S - 1);
    expect(w.game.phase).toBe('open');
    w.until(S);
    expect(w.game).toMatchObject({ phase: 'locked', phaseRev: rev + 1, reveal: null });
    expect(w.round.endsAt).toBe(S);
    expect(w.game.next?.surprise).toEqual({ at: S, ms: VIDEO, w: SURPRISE.builtin.w, h: SURPRISE.builtin.h });
    expect(w.totals?.rounds[0]).toMatchObject({ lockedAt: S, endsAt: S, surprise: { afterMs: 5_000, ms: VIDEO } });
    // the reveal waits for the whole video (fallback: lead + video + tail), never the normal lock grace
    expect(w.deadline()).toBe(S + LEAD + VIDEO + SURPRISE.tailMs);
    w.until(S + LEAD + VIDEO);
    expect(w.game.phase).toBe('locked');
  });

  it('answers sent before it count with their own speed; the rules refuse the late ones', () => {
    const w = openSurprise();
    const openAt = w.round.openAt;
    const S = openAt + 5_000;
    expect(w.answer('a', choice('mom'), openAt + 2_000)).toBe(true);
    w.until(S);
    // on its way when the TV broke down (lands 0.8 s later): accepted, like the normal grace
    expect(w.answer('b', choice('dad'), S + 800)).toBe(true);
    // after the interrupt (the phones show the glitch, the answer window is closed)
    expect(w.answer('c', choice('mom'), S + FB_LIMITS.answerLateMs + 1)).toBe(false);
    expect(w.answer('c', choice('mom'), S + 60_000)).toBe(false);
    // a phone does not even offer the options
    expect(phoneOf(w, 'c', S + 500)).toMatchObject({ canAnswer: false, screen: 'time_up' });
    const r = w.cmd({ type: 'surpriseEnd', phaseRev: w.game.phaseRev }, S + LEAD + VIDEO);
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(w.game.phase).toBe('reveal');
    const res = resultsOf(w.totals!.rounds[0]!);
    expect(Object.keys(res).sort()).toEqual(['a', 'b']);
    expect(res.a).toMatchObject({ e: 2_000, ok: true });
    expect(res.b).toMatchObject({ e: 5_800, ok: false });
    expect(w.game.reveal?.me.c).toMatchObject({ pts: 0, ok: false });
    expect(phoneOf(w, 'c').reveal?.verdict).toBe('none');
  });

  it('the TV reports the end once: a second report is stale; the fallback reveals when nobody does', () => {
    const w = openSurprise();
    const S = w.round.openAt + 5_000;
    w.until(S);
    const rev = w.game.phaseRev;
    expect(w.cmd({ type: 'surpriseEnd', phaseRev: rev - 1 }, S + 10_000)).toMatchObject({ ok: false, error: 'stale' });
    expect(w.cmd({ type: 'surpriseEnd', phaseRev: rev }, S + LEAD + 60_000)).toMatchObject({ ok: true });
    expect(w.cmd({ type: 'surpriseEnd', phaseRev: rev }, S + LEAD + 60_100)).toMatchObject({ ok: false, error: 'stale' });

    const v = openSurprise();
    const S2 = v.round.openAt + 5_000;
    v.until(S2 + LEAD + VIDEO + SURPRISE.tailMs);
    expect(v.game.phase).toBe('reveal');
  });

  it('only while the stage runs: not in an open question, not in a normal locked one', () => {
    const w = openSurprise(new World(mkContent([Q1, QS])));
    expect(w.cmd({ type: 'surpriseEnd', phaseRev: w.game.phaseRev })).toMatchObject({ ok: false, error: 'invalid' });
    w.cmd({ type: 'reveal', phaseRev: w.game.phaseRev });
    expect(w.game.phase).toBe('locked');
    expect(w.game.next?.surprise).toBeUndefined();
    expect(w.cmd({ type: 'surpriseEnd', phaseRev: w.game.phaseRev })).toMatchObject({ ok: false, error: 'invalid' });
    // a normal question still locks early when everybody answered
    w.until(w.now + LOCK + HOST_TIMING.revealGraceMs);
    expect(w.game.phase).toBe('reveal');
  });

  it('«Показать ответ» during the question starts the video now (the answer still comes after it)', () => {
    const w = openSurprise();
    const at = w.round.openAt + 1_000;
    w.cmd({ type: 'reveal', phaseRev: w.game.phaseRev }, at);
    expect(w.game.phase).toBe('locked');
    expect(w.game.next?.surprise?.at).toBe(at);
    // pressed again: «Досмотрели — к ответу»
    w.cmd({ type: 'reveal', phaseRev: w.game.phaseRev }, at + 20_000);
    expect(w.game.phase).toBe('reveal');
  });

  it('the time runs out first (afterS ≥ the limit): it still comes before the end of the answer time', () => {
    expect(surpriseAfterMs(40, 30)).toBe(29_000);
    expect(surpriseAfterMs(1, 30)).toBe(2_000);
    // the default: 4 s after the options appear (as the demo showed it)
    expect(surpriseAfterMs(undefined, 30)).toBe(4_000);
    const w = openSurprise();
    // «−время» at the admin: the end moves before the interrupt — the interrupt moves with it
    w.cmd({ type: 'addTime', ms: -27_000 });
    const endsAt = w.round.endsAt;
    expect(w.deadline()).toBe(endsAt);
    w.until(endsAt);
    expect(w.game.phase).toBe('locked');
    expect(w.game.next?.surprise?.at).toBe(endsAt);
  });
});

describe('«Сюрприз»: after the video the quiz is over', () => {
  it('reveal → the final ~10 s later by itself (no board, the remaining questions are not played)', () => {
    const w = openSurprise(new World(mkContent([QS, Q2])));
    const S = w.round.openAt + 5_000;
    w.until(S);
    w.cmd({ type: 'surpriseEnd', phaseRev: w.game.phaseRev }, S + LEAD + VIDEO);
    const revealAt = w.now;
    expect(w.deadline()).toBe(revealAt + SURPRISE.toFinalMs);
    w.until(revealAt + SURPRISE.toFinalMs - 1);
    expect(w.game.phase).toBe('reveal');
    w.until(revealAt + SURPRISE.toFinalMs);
    expect(w.game).toMatchObject({ phase: 'final', final: { step: 0 }, board: null });
    expect(w.totals?.rounds.map((r) => r.qid)).toEqual(['qs']);
  });

  it('«Дальше» at the reveal goes to the final too', () => {
    const w = openSurprise(new World(mkContent([QS, Q2])));
    w.until(w.round.openAt + 5_000);
    w.cmd({ type: 'surpriseEnd', phaseRev: w.game.phaseRev }, w.now + 30_000);
    w.cmd({ type: 'advance', phaseRev: w.game.phaseRev }, w.now + 2_000);
    expect(w.game.phase).toBe('final');
  });

  it('«Пропустить» during the video skips the question like any other (the next one starts)', () => {
    const w = openSurprise(new World(mkContent([QS, Q2])));
    w.until(w.round.openAt + 5_000);
    w.cmd({ type: 'skip', phaseRev: w.game.phaseRev }, w.now + 10_000);
    expect(w.game).toMatchObject({ phase: 'intro', round: { qid: 'q2' } });
    expect(w.game.next?.surprise).toBeUndefined();
  });
});

describe('«Сюрприз»: restart-safe, pause and «стоп-экран»', () => {
  it('exactly once: a second host ticking at the same moment changes nothing; a late host starts it when it wakes up', () => {
    const w = openSurprise();
    const S = w.round.openAt + 5_000;
    w.tick(S);
    const rev = w.game.phaseRev;
    expect(w.tick(S + 50).changed).toBe(false);
    expect(w.game.phaseRev).toBe(rev);

    // a restarted host reads the same deadline from the stored docs
    const docs = { game: structuredClone(w.game), totals: structuredClone(w.totals) };
    const v = new World();
    Object.assign(v, docs, { players: w.players, answers: w.answers, now: S + 100 });
    expect(v.deadline()).toBe(w.deadline());
    expect(toEngineState(v.input()).rounds[0]?.surprise).toEqual({ afterMs: 5_000, ms: VIDEO });

    // the host slept through the moment (a hidden tab): the stage starts when it ticks, from then
    const late = openSurprise();
    const S3 = late.round.openAt + 5_000;
    expect(late.answer('a', choice('mom'), S3 + 3_000)).toBe(true);
    late.tick(S3 + 7_000);
    expect(late.game.phase).toBe('locked');
    expect(late.game.next?.surprise?.at).toBe(S3 + 7_000);
    expect(late.round.endsAt).toBe(S3 + 7_000);
  });

  it('an admin pause before it moves the interrupt by the pause', () => {
    const w = openSurprise();
    const openAt = w.round.openAt;
    w.cmd({ type: 'pause' }, openAt + 3_000);
    expect(w.deadline()).toBeNull();
    w.cmd({ type: 'resume' }, openAt + 3_000 + MIN);
    expect(w.deadline()).toBe(openAt + 5_000 + MIN);
  });

  it('«стоп-экран» during the video freezes it; released, it plays on from the same frame', () => {
    const w = openSurprise();
    const S = w.round.openAt + 5_000;
    w.until(S);
    const at = S + LEAD + 60_000;
    const before = surpriseView(w.game, at);
    expect(before).toMatchObject({ stage: 'play', posMs: 60_000 });
    w.cmd({ type: 'hold', phaseRev: w.game.phaseRev, text: 'Пауза' }, at);
    expect(w.deadline()).toBeNull();
    // nothing moves while held: the view stands still, the TV's report is refused
    expect(surpriseView(w.game, at + 5 * MIN)).toMatchObject({ stage: 'play', posMs: 60_000 });
    expect(w.cmd({ type: 'surpriseEnd', phaseRev: w.game.phaseRev }, at + MIN)).toMatchObject({ ok: false, error: 'invalid' });
    w.until(at + 10 * MIN);
    expect(w.game.phase).toBe('locked');
    w.cmd({ type: 'unhold' }, at + 10 * MIN);
    expect(w.game.next?.surprise?.at).toBe(S + 10 * MIN);
    expect(surpriseView(w.game, at + 10 * MIN)).toMatchObject({ stage: 'play', posMs: 60_000 });
    expect(w.deadline()).toBe(S + 10 * MIN + LEAD + VIDEO + SURPRISE.tailMs);
  });
});

describe('«Сюрприз»: the public stage is written only by transactions', () => {
  it('a page refreshing pub/next between the game and totals snapshots never moves or drops it', () => {
    const w = openSurprise();
    const S = w.round.openAt + 5_000;
    w.until(S);
    const held = { game: structuredClone(w.game), totals: structuredClone(w.totals) };
    w.cmd({ type: 'hold', phaseRev: w.game.phaseRev, text: 'Пауза' }, S + LEAD + 30_000);
    const holdTotals = structuredClone(w.totals);
    w.cmd({ type: 'unhold' }, S + LEAD + 60_000);
    const ctx = { content: w.content, media: w.media };
    // the new game doc (released: the stage moved by 30 s) with the totals of before the release
    const stale = { gameId: 'g', game: w.game, totals: holdTotals, players: w.players, answers: [] };
    expect(w.game.next?.surprise?.at).toBe(S + 30_000);
    expect(refreshedGame(stale, ctx)).toBeNull();
    // the surprise doc with totals from before the interrupt (the round still open in them)
    const early = { gameId: 'g', game: w.game, totals: held.totals && { ...held.totals, rounds: held.totals.rounds.map((r) => ({ ...r, lockedAt: undefined as never })) }, players: w.players, answers: [] };
    const r = refreshedGame(early, ctx);
    expect(r === null || r.next?.surprise?.at === S + 30_000).toBe(true);
    // before it runs, a refresh never adds it either
    const v = openSurprise();
    const docBefore = structuredClone(v.game);
    v.until(v.round.openAt + 5_000);
    expect(refreshedGame({ gameId: 'g', game: docBefore, totals: v.totals, players: v.players, answers: [] }, { content: v.content, media: v.media })?.next?.surprise).toBeUndefined();
  });
});

describe('«Сюрприз»: views', () => {
  it('TV, phone and admin follow the stage by the clock', () => {
    const w = openSurprise();
    const S = w.round.openAt + 5_000;
    // admin: the countdown to it (only admins see it coming)
    const adm0 = buildAdminView(snap(w), w.round.openAt + 1_000);
    expect(adm0.surpriseIn).toEqual({ ms: 4_000, at: S });
    expect(heroAction(adm0).label).toMatch(/Сюрприз/);
    expect(buildTvView(snap(w), w.now).surprise).toBeNull();
    w.until(S);
    const stages = [
      [S + 100, 'glitch'],
      [S + SURPRISE.glitchMs + 100, 'black'],
      [S + LEAD + 100, 'play'],
      [S + LEAD + VIDEO + 100, 'play'],
      [S + LEAD + VIDEO + SURPRISE.tailMs + 100, 'after'],
    ] as const;
    for (const [t, stage] of stages) {
      expect(buildTvView(snap(w), t).surprise?.stage).toBe(stage);
      expect(phoneOf(w, 'a', t).surprise?.stage).toBe(stage);
    }
    const tv = buildTvView(snap(w), S + LEAD + 1_000);
    expect(tv.surprise).toMatchObject({ videoId: null, posterId: null, posMs: 1_000, videoMs: VIDEO, w: 576, h: 1024 });
    const phone = phoneOf(w, 'a', S + LEAD + 1_000);
    expect(phone.canAnswer).toBe(false);
    expect(phone.reactions.enabled).toBe(false);
    expect(phone.surprise).not.toHaveProperty('videoId');
    // the TV's Space and the admin's big button: «Досмотрели — к ответу» (twice while most of it is ahead)
    const adm = buildAdminView(snap(w), S + LEAD + 1_000);
    expect(adm.can.surpriseEnd).toBe(true);
    expect(mainAction(adm)).toMatchObject({ cmd: { type: 'surpriseEnd', phaseRev: w.game.phaseRev } });
    expect(mainAction(adm)?.confirm).toBeTruthy();
    expect(mainAction(buildAdminView(snap(w), S + LEAD + VIDEO - 2_000))?.confirm).toBeUndefined();
    expect(heroAction(adm)).toMatchObject({ label: 'Досмотрели — к ответу', cmd: { type: 'surpriseEnd' } });
    w.cmd({ type: 'surpriseEnd', phaseRev: w.game.phaseRev }, S + LEAD + VIDEO);
    expect(buildTvView(snap(w), w.now).surprise).toBeNull();
    expect(buildAdminView(snap(w), w.now).can.surpriseEnd).toBe(false);
  });

  it('an uploaded video: its length, poster and size (the built-in one when it is missing)', () => {
    const media: MediaIndex = { sv: { kind: 'video', durationS: 42.5, posterId: 'sp', w: 1080, h: 1920 } };
    const qc: ChoiceQ = { ...QS, surprise: { on: true, src: 'custom', mediaId: 'sv', afterS: 5 } };
    expect(surpriseOf(qc, media)).toEqual({ afterMs: 5_000, ms: 42_500 });
    expect(surpriseOf(qc, {})).toEqual({ afterMs: 5_000, ms: VIDEO });
    expect(surpriseOf({ ...qc, surprise: { ...qc.surprise!, on: false } }, media)).toBeNull();
    expect(referencedMediaIds({ questions: [qc] }, null)).toContain('sv');
    const w = openSurprise(new World(mkContent([qc]), media));
    w.until(w.round.openAt + 5_000);
    expect(w.game.next?.surprise).toMatchObject({ ms: 42_500, id: 'sv', poster: 'sp', w: 1080, h: 1920 });
    const tv = buildTvView(snap(w), w.now + 100);
    expect(tv.surprise).toMatchObject({ videoId: 'sv', posterId: 'sp' });
    expect(tv.media).toEqual(['sv', 'sp']);
  });
});

describe('«Сюрприз»: the rehearsal', () => {
  it('plays the whole sequence: interrupt, the video to its end, the reveal, then straight to the final', () => {
    const tl = simulate({ content: { rev: 1, settings: mkContent().settings, questions: [Q2, QS] } });
    const r = tl.rounds.find((x) => x.qid === 'qs')!;
    expect(r.lockedAt).not.toBeNull();
    const S = r.lockedAt!;
    expect(S).toBe(r.openAt + 5_000);
    // the TV reported the end of the video
    expect(r.revealAt).toBe(S + LEAD + VIDEO);
    expect(r.boardAt).toBeNull();
    expect(tl.finalAt).toBe(r.revealAt! + SURPRISE.toFinalMs);
    // answers that came after the interrupt were refused
    const late = tl.answers.filter((a) => a.round === r.i && a.at > S + FB_LIMITS.answerLateMs);
    expect(late).toEqual([]);
    const counted = Object.keys(resultsOf(tl.frames[tl.frames.length - 1]!.totals.rounds.find((x) => x.qid === 'qs')!));
    expect(counted.length).toBe(tl.answers.filter((a) => a.round === r.i).length);
    // → skips: the interrupt is a mark of its own, then the answer
    expect(tl.marks.some((m) => m.at === S)).toBe(true);
    expect(tl.marks.some((m) => m.at === r.revealAt)).toBe(true);
    expect(tl.guests.some((g) => g.uid === ME_UID)).toBe(true);
  });
});
