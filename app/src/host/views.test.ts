// View-model tests: the docs are produced by the real pure host (step()), the views are what the
// screens will render.

import { defaultSettings } from '@shared/defaults';
import type { AnswerDoc, GameDoc, PlayerDoc } from '@shared/fbtypes';
import type { AnswerPayload, ChoiceQ, NumberQ, Settings } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { WATCH } from '@shared/engine/watch';
import { HOST_TIMING, type HostHealth, type HostSnapshot, type MediaIndex, type TotalsDoc } from './model';
import { emptyTotals, hostDeadline, hostEvent, initialGameDoc, publicRound, refreshedGame, step, type HostCommand, type HostContent } from './pure';
import { OPEN_LATCH_MS, buildAdminView, buildPlayerView, buildTvView, timerView, watchView, type MyAnswer, type PlayerViewInput } from './views';

const T0 = 1_800_000_000_000;
const INTRO = 4_000;
const WAIT = 1_500 + HOST_TIMING.revealGraceMs;

const Q1: ChoiceQ = {
  id: 'q1',
  type: 'choice',
  title: 'Цвет?',
  options: [
    { id: 'red', text: 'Красный' },
    { id: 'blue', text: 'Синий', mediaId: 'img-blue' },
  ],
  correctId: 'blue',
  timeLimitS: 20,
  double: false,
};
const Q2: NumberQ = { id: 'q2', type: 'number', title: 'Сколько?', answer: 10, min: 0, max: 100, step: 1, tolerance: 0, zeroAt: 10, timeLimitS: 20, double: false };

const settings: Settings = { ...defaultSettings(), introMs: INTRO, lockMs: 1_500, allAnsweredDelayMs: 1_000 };
const CONTENT: HostContent = { rev: 1, settings, questions: [Q1, Q2] };

/** Minimal game world driven through step(). */
class World {
  game: GameDoc = initialGameDoc(settings);
  totals: TotalsDoc | null = emptyTotals(T0);
  players: Record<string, PlayerDoc> = {};
  answers: AnswerDoc[] = [];
  now = T0;

  constructor(
    public content: HostContent = CONTENT,
    public media: MediaIndex = {},
  ) {}

  input() {
    const i = this.game.round?.i;
    return { gameId: 'g', game: this.game, totals: this.totals, players: this.players, answers: this.answers.filter((a) => a.round === i) };
  }
  private apply(out: ReturnType<typeof step>) {
    if (!out.changed) return;
    this.game = out.game;
    this.totals = out.totals;
    for (const k of out.kicked) (this.players[k.uid] as PlayerDoc).kicked = k.kicked;
  }
  join(uid: string, extra: Partial<PlayerDoc> = {}) {
    this.players[uid] = { name: uid.toUpperCase(), seed: 1, joinedAt: this.now, kicked: false, seenAt: this.now, ...extra };
  }
  cmd(c: HostCommand) {
    const ev = hostEvent(c, this.totals);
    if (!ev) throw new Error('bad cmd');
    const out = step(this.input(), ev, this.now, { content: this.content, players: this.players, media: this.media });
    this.apply(out);
    return out;
  }
  until(t: number) {
    for (let k = 0; k < 20; k++) {
      const d = hostDeadline(this.input(), this.content);
      if (d === null || d > t) break;
      this.now = Math.max(this.now, d);
      this.apply(step(this.input(), { t: 'tick' }, this.now, { content: this.content, players: this.players, media: this.media }));
    }
    this.now = Math.max(this.now, t);
  }
  answer(uid: string, p: AnswerPayload, at = this.now) {
    this.answers.push({ uid, round: this.game.round?.i ?? -1, p, at });
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

function hostSnap(w: World, extra: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    gameId: 'g',
    game: w.game,
    totals: w.totals,
    players: w.players,
    answers: w.answers.filter((a) => a.round === w.game.round?.i),
    answersRound: w.game.round?.i ?? null,
    content: { rev: 1, settings, questions: [Q1, Q2], trash: [] },
    media: {},
    lease: { session: 's1', until: w.now + 10_000, label: 'tv', preferred: true, uid: 'admin', at: w.now },
    reactions: [],
    session: 's1',
    label: 'tv',
    health,
    ...extra,
  };
}

function phone(w: World, uid: string, answers: Record<number, MyAnswer> = {}, extra: Partial<PlayerViewInput> = {}): PlayerViewInput {
  return {
    uid,
    gameId: 'g',
    game: w.game,
    gameState: 'live',
    me: w.players[uid] ?? null,
    meLoaded: true,
    answers,
    lastScore: null,
    reactionsSent: [],
    ...extra,
  };
}

describe('timerView', () => {
  it('intro and answer countdowns, frozen while paused', () => {
    const w = new World();
    w.cmd({ type: 'start' });
    expect(timerView(w.game, T0 + 1_000)).toMatchObject({ kind: 'intro', remainingMs: 3_000, totalMs: INTRO, progress: 0.25, paused: false });
    w.now = T0 + 1_000;
    w.cmd({ type: 'pause' });
    expect(timerView(w.game, T0 + 50_000)).toMatchObject({ kind: 'intro', remainingMs: 3_000, paused: true });
    w.now = T0 + 11_000;
    w.cmd({ type: 'resume' });
    w.until(w.round.openAt + 5_000);
    expect(timerView(w.game, w.now)).toMatchObject({ kind: 'answer', remainingMs: 15_000, totalMs: 20_000, progress: 0.25, paused: false });
    w.cmd({ type: 'pause' });
    // Public endsAt is held open during the pause, the timer is not fooled by it.
    expect(w.round.endsAt).toBeGreaterThan(w.now + 20 * 60_000);
    expect(timerView(w.game, w.now + 99_000)).toMatchObject({ remainingMs: 15_000, totalMs: 20_000, paused: true });
    w.cmd({ type: 'resume' });
    w.until(w.round.endsAt);
    expect(timerView(w.game, w.now)).toMatchObject({ kind: 'answer', remainingMs: 0, progress: 1 });
    expect(timerView(initialGameDoc(settings), T0)).toBeNull();
  });
});

describe('PlayerView', () => {
  it('walks the phone through join → lobby → intro → question → answered → reveal → board → final', () => {
    const w = new World();
    expect(buildPlayerView({ ...phone(w, 'a'), game: null, gameState: 'loading' }, T0).screen).toBe('loading');
    expect(buildPlayerView({ ...phone(w, 'a'), game: null, gameState: 'missing' }, T0).screen).toBe('no_game');
    expect(buildPlayerView(phone(w, 'a'), T0)).toMatchObject({ screen: 'join', me: null, canAnswer: false });
    w.join('a', { thumb: new Uint8Array([1]) });
    w.join('b');
    // A freshly seeded lobby has no prefetch list: the host refreshes pub/next once.
    expect(buildPlayerView(phone(w, 'a'), T0).prefetch).toEqual([]);
    const fresh = refreshedGame(w.input(), { content: CONTENT, media: {} });
    expect(fresh).toEqual({ pub: w.game.pub, next: { media: ['img-blue'] } });
    w.game = { ...w.game, ...fresh };
    expect(refreshedGame(w.input(), { content: CONTENT, media: {} })).toBeNull();
    let v = buildPlayerView(phone(w, 'a'), T0);
    expect(v).toMatchObject({ screen: 'lobby', me: { uid: 'a', name: 'A', isVlados: false }, prefetch: ['img-blue'] });
    expect(v.texts.joinTitle).toBeTruthy();

    w.cmd({ type: 'start' });
    v = buildPlayerView(phone(w, 'a'), w.now);
    expect(v).toMatchObject({ screen: 'intro', question: { n: 1, total: 2, qid: 'q1' }, media: ['img-blue'], canAnswer: false });
    w.until(w.round.openAt);
    v = buildPlayerView(phone(w, 'a'), w.now + 1);
    expect(v).toMatchObject({ screen: 'question', canAnswer: true });
    const mine: Record<number, MyAnswer> = { 0: { round: 0, p: { t: 'choice', id: 'blue' }, status: 'sending' } };
    expect(buildPlayerView(phone(w, 'a', mine), w.now).screen).toBe('answered');
    expect(buildPlayerView(phone(w, 'a', { 0: { ...mine[0]!, status: 'rejected', error: 'offline' } }), w.now)).toMatchObject({ screen: 'question', canAnswer: true });
    w.answer('a', { t: 'choice', id: 'blue' }, w.round.openAt + 2_000);
    w.until(w.round.endsAt);
    expect(buildPlayerView(phone(w, 'b'), w.now).screen).toBe('time_up');
    w.until(w.round.endsAt + WAIT);
    const accepted = { 0: { ...mine[0]!, status: 'accepted' as const } };
    v = buildPlayerView(phone(w, 'a', accepted), w.now);
    expect(v).toMatchObject({ screen: 'reveal', score: { tot: 950, rank: 1 } });
    expect(v.reveal).toMatchObject({ correct: 'blue', verdict: 'correct', myAnswer: { t: 'choice', id: 'blue' }, pct: 1, count: 1, mine: { pts: 950 } });
    expect(buildPlayerView(phone(w, 'b'), w.now).reveal).toMatchObject({ verdict: 'none', mine: { pts: 0, rank: 2 } });

    w.cmd({ type: 'advance', phaseRev: w.game.phaseRev });
    v = buildPlayerView(phone(w, 'b'), w.now);
    expect(v.screen).toBe('board');
    expect(v.board?.top.map((r) => r.uid)).toEqual(['a', 'b']);
    expect(v.board?.mine).toMatchObject({ rank: 2 });

    w.cmd({ type: 'end' });
    for (let k = 0; k < 3; k++) w.cmd({ type: 'advance', phaseRev: w.game.phaseRev });
    v = buildPlayerView(phone(w, 'a'), w.now);
    expect(v).toMatchObject({ screen: 'final', final: { step: 3, mine: { tot: 950, rank: 1 } }, score: { tot: 950, rank: 1 } });
    expect(v.final?.podium[0]?.thumb).toEqual(new Uint8Array([1]));
    expect(buildPlayerView(phone(w, 'c'), w.now).screen).toBe('join_closed');
  });

  it('kicked, late join closed, Vlados flag, reactions cooldown, last known score', () => {
    const w = new World();
    w.join('a');
    w.join('v');
    w.cmd({ type: 'setVlados', uid: 'v' });
    expect(buildPlayerView(phone(w, 'v'), T0).me?.isVlados).toBe(true);
    w.cmd({ type: 'start' });
    expect(buildPlayerView(phone(w, 'late'), w.now).screen).toBe('join');
    expect(buildPlayerView({ ...phone(w, 'late'), game: { ...w.game, pub: { ...w.game.pub, lateJoin: false } } }, w.now).screen).toBe('join_closed');
    w.cmd({ type: 'kick', uid: 'a' });
    expect(buildPlayerView(phone(w, 'a'), w.now)).toMatchObject({ screen: 'kicked', kicked: true, reactions: { enabled: false } });
    const r = buildPlayerView({ ...phone(w, 'v'), reactionsSent: [w.now - 1_000], lastScore: { i: 0, tot: 500, rank: null } }, w.now);
    expect(r.reactions).toEqual({ enabled: true, cooldownMs: 2_000 });
    expect(r.score).toEqual({ tot: 500, rank: null });
  });
});

describe('TvView and AdminView', () => {
  it('live answered set, reveal answers, reactions, admin distribution and buttons', () => {
    const w = new World();
    for (const u of ['a', 'b', 'c', 'v']) w.join(u);
    w.cmd({ type: 'setVlados', uid: 'v' });
    let admin = buildAdminView(hostSnap(w), w.now);
    expect(admin.can).toMatchObject({ start: true, advance: false, reveal: false, pause: false, resume: false, rescoreRound: false });
    expect(admin.next).toEqual({ qid: 'q1', title: 'Цвет?', type: 'choice' });
    expect(admin.lease).toMatchObject({ mine: true, holder: { label: 'tv' } });

    w.cmd({ type: 'start' });
    w.until(w.round.openAt);
    w.answer('a', { t: 'choice', id: 'blue' }, w.now + 1_000);
    w.answer('b', { t: 'choice', id: 'red' }, w.now + 2_000);
    w.answer('v', { t: 'choice', id: 'blue' }, w.now + 500);
    const reactions = [{ id: 'a_1', uid: 'a', e: 0, at: w.now }, { id: 'b_1', uid: 'b', e: 3, at: w.now - 120_000 }];
    const tv = buildTvView(hostSnap(w, { reactions }), w.now + 3_000);
    expect(tv.counts).toEqual({ players: 4, answered: 3 });
    expect(tv.answeredIds.sort()).toEqual(['a', 'b', 'v']);
    expect(tv.players.find((p) => p.uid === 'c')).toMatchObject({ answered: false, isVlados: false });
    expect(tv.reactions).toEqual([{ id: 'a_1', uid: 'a', name: 'A', e: 0, emoji: '🔥', at: w.now }]);
    expect(tv.reveal).toBeNull();

    admin = buildAdminView(hostSnap(w), w.now + 3_000);
    expect(admin.correct).toEqual({ t: 'choice', id: 'blue', text: 'Синий' });
    expect(admin.liveDist).toEqual({ t: 'choice', counts: { red: 1, blue: 1 }, correctId: 'blue', total: 2 });
    expect(admin.vladosAnswer).toEqual({ t: 'choice', id: 'blue' });
    expect(admin.notAnswered.map((p) => p.uid)).toEqual(['c']);
    expect(admin.can).toMatchObject({ start: false, reveal: true, skip: true, pause: true, addTime: true });
    expect(admin.rounds).toEqual([{ i: 0, n: 1, qid: 'q1', title: 'Цвет?', type: 'choice', skipped: false, revealed: false, answered: 3 }]);

    w.until(w.round.endsAt + WAIT);
    const tvr = buildTvView(hostSnap(w), w.now);
    expect(tvr.reveal?.answers.map((x) => [x.uid, x.ok, x.isVlados])).toEqual([
      ['v', true, true],
      ['a', true, false],
      ['b', false, false],
    ]);
    admin = buildAdminView(hostSnap(w), w.now);
    expect(admin).toMatchObject({ liveDist: null, notAnswered: [], can: { advance: true, rescoreRound: true } });
    expect(admin.questions.map((q) => [q.qid, q.played, q.scored])).toEqual([
      ['q1', true, true],
      ['q2', false, false],
    ]);
    w.cmd({ type: 'end' });
    for (let k = 0; k < 5; k++) w.cmd({ type: 'advance', phaseRev: w.game.phaseRev });
    const fin = buildTvView(hostSnap(w), w.now);
    expect(fin.final?.step).toBe(5);
    expect(fin.final?.mosaic?.length).toBe(4);
    expect(fin.final?.vlados).toMatchObject({ uid: 'v' });
  });
});

describe('media ids per screen', () => {
  const QV: ChoiceQ = { ...Q1, id: 'qv', media: { mediaId: 'vid-1', onPhones: true } };
  const MEDIA = { 'vid-1': { kind: 'video' as const, posterId: 'img-poster' } };

  it('phones load the poster of a video, never the video; the TV loads the video even when not on phones', () => {
    const w = new World();
    w.join('a');
    w.game = { ...w.game, phase: 'intro', round: publicRound(QV, 0, 1, T0, { introMs: INTRO }, { media: MEDIA }) };
    const v = buildPlayerView(phone(w, 'a'), T0 + 1);
    expect(v.media).toContain('img-poster');
    expect(v.media).not.toContain('vid-1');
    const tvOff = { ...w.game, round: publicRound({ ...QV, media: { mediaId: 'vid-1', onPhones: false } }, 0, 1, T0, { introMs: INTRO }, { media: MEDIA }) };
    expect(buildTvView(hostSnap(w, { game: tvOff }), T0 + 1).media).toContain('vid-1');
    // videos are TV-only whatever «на телефонах» says: phones get the poster, never the video
    const off = buildPlayerView({ ...phone(w, 'a'), game: tvOff }, T0 + 1);
    expect(off.media).toEqual(['img-poster', 'img-blue']);
  });
});

describe('watch stage of a video question', () => {
  const QV: ChoiceQ = { ...Q1, id: 'qv', media: { mediaId: 'vid-1', onPhones: false } };
  // 20 s video → 25 s window
  const VMEDIA: MediaIndex = { 'vid-1': { kind: 'video', posterId: 'img-poster', durationS: 20 } };
  const WIN = 20_000 + WATCH.tailMs;
  const START = T0 + INTRO;

  function world(media: MediaIndex = VMEDIA): World {
    const w = new World({ rev: 1, settings, questions: [QV, Q2] }, media);
    w.join('a');
    w.cmd({ type: 'start' });
    return w;
  }
  const snap = (w: World) => hostSnap(w, { content: { rev: 1, settings, questions: [QV, Q2], trash: [] }, media: VMEDIA });

  it('intro splash → video (no timer, no options on phones) → 3-2-1 → answers', () => {
    const w = world();
    // splash: counts down to the video
    expect(watchView(w.game, T0 + 1_000)).toMatchObject({ stage: 'intro', startAt: START, windowMs: WIN, untilAt: START + WIN, openAt: START + WIN + WATCH.beatMs });
    expect(timerView(w.game, T0 + 1_000)).toMatchObject({ kind: 'intro', remainingMs: INTRO - 1_000, totalMs: INTRO });

    // the video plays on the TV: phones show «смотри на экран», no timer, cannot answer
    const t = START + 7_000;
    const p = buildPlayerView(phone(w, 'a'), t);
    expect(p).toMatchObject({ screen: 'intro', timer: null, canAnswer: false, watch: { stage: 'play', posMs: 7_000 } });
    const tv = buildTvView(snap(w), t);
    expect(tv.watch).toMatchObject({ stage: 'play', posMs: 7_000 });
    expect(tv.media).toContain('vid-1');
    const admin = buildAdminView(snap(w), t);
    expect(admin.can).toMatchObject({ watchEnd: true, pause: true, skip: true, reveal: false });

    // the TV reports the end → the beat
    w.now = START + 20_300;
    w.cmd({ type: 'watchEnd', phaseRev: w.game.phaseRev });
    const b = buildPlayerView(phone(w, 'a'), START + 21_300);
    expect(b.watch).toMatchObject({ stage: 'beat', openAt: START + 20_300 + WATCH.beatMs });
    expect(b.timer).toMatchObject({ kind: 'intro', remainingMs: 2_000, totalMs: WATCH.beatMs });
    expect(buildAdminView(snap(w), START + 21_300).can.watchEnd).toBe(false);

    // answers: the full 20 s from the new opening
    w.until(START + 20_300 + WATCH.beatMs);
    const q = buildPlayerView(phone(w, 'a'), w.now + 1_000);
    expect(q).toMatchObject({ screen: 'question', canAnswer: true, watch: null });
    expect(q.timer).toMatchObject({ kind: 'answer', remainingMs: 19_000, totalMs: 20_000 });
  });

  it('pause during the video: position and screens freeze, resume continues from the same frame', () => {
    const w = world();
    w.now = START + 5_000;
    w.cmd({ type: 'pause' });
    const later = START + 65_000;
    expect(watchView(w.game, later)).toMatchObject({ stage: 'play', posMs: 5_000 });
    const tv = buildTvView(snap(w), later);
    expect(tv.timer).toBeNull();
    expect(tv.pause).toMatchObject({ reason: 'admin', remainingMs: 0 });
    expect(buildAdminView(snap(w), later).can).toMatchObject({ watchEnd: false, resume: true });
    w.now = later;
    w.cmd({ type: 'resume' });
    expect(watchView(w.game, later + 1_000)).toMatchObject({ stage: 'play', posMs: 6_000, startAt: START + 60_000 });
    // fallback: nobody reported the end → beat, then open
    const until = START + 60_000 + WIN;
    expect(watchView(w.game, until)).toMatchObject({ stage: 'beat' });
    w.until(until + WATCH.beatMs);
    expect(w.game.phase).toBe('open');
  });

  it('the phones\' progress bar runs over the video itself (videoMs), not the fallback tail', () => {
    const w = world();
    expect(watchView(w.game, START + 5_000)).toMatchObject({ stage: 'play', videoMs: 20_000, windowMs: WIN, posMs: 5_000 });
    // a round published before videoMs existed: the whole window
    const old = { ...w.game, round: { ...w.round, media: { ...w.round.media!, videoMs: undefined } } } as typeof w.game;
    expect(watchView(old, START + 5_000)?.videoMs).toBe(WIN);
  });

  it('a late host (hidden admin tab): phones open by the clock at openAt with the full timer', () => {
    const w = world();
    const { openAt, endsAt } = w.round;
    const limit = endsAt - openAt;
    // the doc still says 'intro' (nobody switched it): 3-2-1, then the question exactly at openAt
    expect(w.game.phase).toBe('intro');
    const beat = buildPlayerView(phone(w, 'a'), openAt - 1);
    expect(beat).toMatchObject({ screen: 'intro', phase: 'intro', canAnswer: false, watch: { stage: 'beat' } });
    const q = buildPlayerView(phone(w, 'a'), openAt);
    expect(q).toMatchObject({ screen: 'question', phase: 'open', canAnswer: true, watch: null });
    expect(q.timer).toMatchObject({ kind: 'answer', remainingMs: limit, totalMs: limit, endsAt });
    expect(q.media).toEqual(['img-poster', 'img-blue']);
    const later = buildPlayerView(phone(w, 'a'), openAt + 5_000);
    expect(later.timer).toMatchObject({ remainingMs: limit - 5_000 });
    // my answer (sent at openAt + 5 s) shows as answered; without one the time runs out
    const mine = buildPlayerView(phone(w, 'a', { [w.round.i]: { round: w.round.i, p: { t: 'choice', id: 'blue' }, status: 'accepted' } }), openAt + 6_000);
    expect(mine.screen).toBe('answered');
    expect(buildPlayerView(phone(w, 'a'), endsAt + 1)).toMatchObject({ screen: 'time_up', canAnswer: false });
    // the TV and admin views keep the doc's phase (they are the hosts)
    expect(buildTvView(snap(w), openAt + 1).phase).toBe('intro');
    // the admin knows whether a TV is on air (a preferred page holds the lease) — «ТВ не подключён»
    const adminOnly = { ...snap(w), lease: { session: 's1', until: openAt + 10_000, label: 'admin', preferred: false, uid: 'admin', at: openAt } };
    expect(buildAdminView({ ...adminOnly, lease: { ...adminOnly.lease, preferred: true, label: 'tv', session: 'tv1' } }, openAt + 1).tvOnAir).toBe(true);
    expect(buildAdminView(adminOnly, openAt + 1)).toMatchObject({ tvOnAir: false, lease: { mine: true } });
    expect(buildAdminView({ ...snap(w), lease: { ...adminOnly.lease, preferred: true, until: openAt - 1 } }, openAt + 1).tvOnAir).toBe(false);
    // paused intro: no opening by the clock
    const paused = { ...w.game, pause: { at: openAt - 2_000, remainingMs: limit + 2_000, reason: 'admin' as const } };
    expect(buildPlayerView({ ...phone(w, 'a'), game: paused }, openAt + 1_000)).toMatchObject({ screen: 'intro', canAnswer: false });
  });

  it('options appear once: a clock that steps back after openAt does not take them away (organizer, 2026-09-23)', () => {
    const w = world();
    const { openAt, i } = w.round;
    // nothing shown yet: before openAt it is the 3-2-1
    expect(buildPlayerView(phone(w, 'a'), openAt - 300).screen).toBe('intro');
    // shown open on this device: a better clock sample puts "now" 300 ms back — still the question
    const opened = { opened: { gameId: 'g', i } };
    expect(buildPlayerView(phone(w, 'a', {}, opened), openAt - 300)).toMatchObject({ screen: 'question', phase: 'open', canAnswer: true });
    // …but not by more than the latch (a round moved later by pause + resume re-counts)
    expect(buildPlayerView(phone(w, 'a', {}, opened), openAt - OPEN_LATCH_MS - 1).screen).toBe('intro');
    // another round / another game: no latch
    expect(buildPlayerView(phone(w, 'a', {}, { opened: { gameId: 'g', i: i - 1 } }), openAt - 300).screen).toBe('intro');
    expect(buildPlayerView(phone(w, 'a', {}, { opened: { gameId: 'other', i } }), openAt - 300).screen).toBe('intro');
    // paused intro: still the pause
    const paused = { ...w.game, pause: { at: openAt - 2_000, remainingMs: 25_000, reason: 'admin' as const } };
    expect(buildPlayerView({ ...phone(w, 'a', {}, opened), game: paused }, openAt - 300).screen).toBe('intro');
  });

  it('media carries its pixel size (frames reserve their box before the file decodes)', () => {
    const w = world({ 'vid-1': { kind: 'video', posterId: 'img-poster', durationS: 20, w: 464, h: 848 } });
    expect(w.round.media).toMatchObject({ mediaId: 'vid-1', posterId: 'img-poster', w: 464, h: 848 });
  });

  it('non-video questions have no watch stage', () => {
    const w = new World();
    w.join('a');
    w.cmd({ type: 'start' });
    expect(watchView(w.game, T0 + 1_000)).toBeNull();
    expect(buildPlayerView(phone(w, 'a'), T0 + 1_000).watch).toBeNull();
    expect(buildAdminView(hostSnap(w), T0 + 1_000).can.watchEnd).toBe(false);
  });
});
