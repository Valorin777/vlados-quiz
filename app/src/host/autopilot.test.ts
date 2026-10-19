// «Автопилот» (shared/engine/showTimings.ts): the organizer presses «Начать игру», the host does the
// rest with the pace of «Прогнать игру» — the answer (longer with a text / photo / video) → the board
// → the next question → the «Сюрприз» → its answer → the final steps → the video after the final.
// Driven through step() + hostDeadline() exactly like the driver (the lease holder ticks at the
// deadline; a transaction re-reads the docs, so a second tick finds nothing to do).

import { defaultSettings } from '@shared/defaults';
import { FINALE } from '@shared/engine/finale';
import { SHOW, autoHoldMs, autopilotOn, revealAfterEndMs, revealHoldMs } from '@shared/engine/showTimings';
import { SURPRISE, surpriseLeadMs } from '@shared/engine/surprise';
import type { GameDoc, PlayerDoc } from '@shared/fbtypes';
import type { ChoiceQ, NumberQ, OrderingQ, Question, Settings } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { autoStepText, heroAction } from '../screens/admin/core/live';
import { HOST_TIMING, type HostHealth, type HostSnapshot, type MediaIndex, type TotalsDoc } from './model';
import { emptyTotals, hostContent, hostDeadline, hostEvent, initialGameDoc, step, type HostCommand, type HostContent, type StepOut } from './pure';
import { revealVideoStartMs, simulate } from './rehearsal';
import { buildAdminView } from './views';

const T0 = 1_800_000_000_000;
const INTRO = 4_000;
const LOCK = 1_500;
/** lock → reveal: lockMs + the host's grace for answers on their way. */
const REVEAL_WAIT = LOCK + HOST_TIMING.revealGraceMs;
const MIN = 60_000;

const opts = [
  { id: 'a', text: 'Раз' },
  { id: 'b', text: 'Два' },
];
const Q_PLAIN: ChoiceQ = { id: 'q-plain', type: 'choice', title: 'Просто?', options: opts, correctId: 'a', timeLimitS: 20, double: false };
const Q_TEXT: NumberQ = { id: 'q-text', type: 'number', title: 'Сколько?', answer: 10, min: 0, max: 100, step: 1, tolerance: 0, zeroAt: 10, timeLimitS: 20, double: false, revealText: 'Вот столько!' };
const Q_PHOTO: OrderingQ = {
  id: 'q-photo',
  type: 'ordering',
  title: 'По порядку',
  items: [
    { id: 'x', text: 'Первое' },
    { id: 'y', text: 'Второе' },
    { id: 'z', text: 'Третье' },
  ],
  firstLabel: 'Раньше',
  lastLabel: 'Позже',
  timeLimitS: 20,
  double: false,
  revealText: 'Так и было',
  revealMedia: { mediaId: 'pic', onPhones: true },
};
const Q_VIDEO: ChoiceQ = { ...Q_PLAIN, id: 'q-video', title: 'А в видео?', revealMedia: { mediaId: 'rvid', onPhones: true } };
const Q_SURPRISE: ChoiceQ = { ...Q_PLAIN, id: 'q-surprise', title: 'Кто лучше всех поздравил Владоса?', timeLimitS: 30, surprise: { on: true, src: 'builtin', afterS: SURPRISE.afterDefaultS } };
const MEDIA: MediaIndex = { pic: { kind: 'image', w: 800, h: 600 }, rvid: { kind: 'video', durationS: 7, posterId: 'rvid-poster', w: 464, h: 848 } };
const QUESTIONS: Question[] = [Q_PLAIN, Q_TEXT, Q_PHOTO, Q_VIDEO, Q_SURPRISE];

const mkContent = (patch: Partial<Settings> = {}, questions: Question[] = QUESTIONS): HostContent => ({
  rev: 1,
  settings: { ...defaultSettings(), introMs: INTRO, lockMs: LOCK, ...patch },
  questions,
});

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

/** The docs in memory; step() like the driver (guests who never answer: the timer ends each question). */
class World {
  game: GameDoc;
  totals: TotalsDoc | null = emptyTotals(T0);
  players: Record<string, PlayerDoc> = {};
  now = T0;
  constructor(
    public content: HostContent = mkContent(),
    public media: MediaIndex = MEDIA,
  ) {
    this.game = initialGameDoc(this.content.settings);
    for (const uid of ['a', 'b']) this.players[uid] = { name: uid.toUpperCase(), seed: 1, joinedAt: T0, kicked: false, seenAt: T0 };
  }
  private ctx() {
    return { content: this.content, players: this.players, media: this.media };
  }
  private input() {
    return { gameId: 'g', game: this.game, totals: this.totals, players: this.players, answers: [] };
  }
  private apply(out: StepOut): StepOut {
    if (out.changed) {
      this.game = out.game;
      this.totals = out.totals;
    }
    return out;
  }
  cmd(c: HostCommand, at = this.now): StepOut {
    this.now = at;
    const ev = hostEvent(c, this.totals);
    if (!ev) throw new Error(c.type);
    return this.apply(step(this.input(), ev, at, this.ctx()));
  }
  tick(at: number): StepOut {
    this.now = Math.max(this.now, at);
    return this.apply(step(this.input(), { t: 'tick' }, at, this.ctx()));
  }
  deadline(): number | null {
    return hostDeadline(this.input(), this.content);
  }
  until(t: number): void {
    for (let k = 0; k < 60; k++) {
      const d = this.deadline();
      if (d === null || d > t) break;
      this.tick(Math.max(this.now, d));
    }
    this.now = Math.max(this.now, t);
  }
  get phaseAt(): number {
    return this.totals!.phaseAt;
  }
  round(): NonNullable<GameDoc['round']> {
    const r = this.game.round;
    if (!r) throw new Error('no round');
    return r;
  }
  snap(): HostSnapshot {
    return {
      gameId: 'g',
      game: this.game,
      totals: this.totals,
      players: this.players,
      answers: [],
      answersRound: null,
      content: { rev: 1, settings: this.content.settings, questions: this.content.questions, trash: [] },
      media: this.media,
      lease: { session: 's1', until: this.now + 10_000, label: 'tv', preferred: true, uid: 'admin', at: this.now },
      reactions: [],
      session: 's1',
      label: 'tv',
      health,
    };
  }
  admin(at = this.now) {
    return buildAdminView(this.snap(), at);
  }
}

interface Mark {
  at: number;
  what: string;
}
const markOf = (g: GameDoc): string =>
  g.phase === 'final' ? `final ${g.final?.step ?? 0}` : g.phase === 'lobby' ? 'lobby' : `${g.round?.qid ?? '?'} ${g.phase}`;

/**
 * The lease holder: ticks exactly at every deadline (once — a second host's tick at the same moment
 * finds nothing), the TV reports the «Сюрприз» video's end when it ends. Returns every transition.
 */
function autoplay(w: World, opts: { surpriseEnd?: boolean } = {}): Mark[] {
  const log: Mark[] = [{ at: w.now, what: markOf(w.game) }];
  for (let k = 0; k < 200; k++) {
    const sp = w.game.phase === 'locked' ? w.game.next?.surprise : undefined;
    const d = w.deadline();
    if (sp && opts.surpriseEnd !== false) {
      const end = sp.at + surpriseLeadMs() + sp.ms;
      if (d === null || end < d) {
        expect(w.cmd({ type: 'surpriseEnd', phaseRev: w.game.phaseRev }, end).ok).toBe(true);
        log.push({ at: end, what: markOf(w.game) });
        continue;
      }
    }
    if (d === null) break;
    const rev = w.game.phaseRev;
    expect(w.tick(d).changed).toBe(true);
    // exactly once: a second host ticking at the same moment moves nothing
    expect(w.tick(d).changed).toBe(false);
    expect(w.game.phaseRev).toBe(rev + 1);
    log.push({ at: d, what: markOf(w.game) });
  }
  return log;
}

/** ms between consecutive marks, as «from → to: ms». */
const gaps = (log: readonly Mark[]): string[] => log.slice(1).map((m, k) => `${log[k]!.what} → ${m.what}: ${m.at - log[k]!.at}`);

describe('«Автопилот»: the whole show by itself', () => {
  it('«Начать игру» is the only press: every question type, reveal text / photo / video, the «Сюрприз», the final, the video after it', () => {
    const w = new World();
    expect(autopilotOn(w.content.settings)).toBe(true);
    w.cmd({ type: 'start' }, T0);
    const log = autoplay(w);
    const S = SURPRISE.afterDefaultS * 1000;
    const V = SURPRISE.builtin.ms;
    const [d0, d1, d2, d3, d4] = SHOW.finalStepMs;
    expect(gaps(log)).toEqual([
      // choice, no text: 9 s of the answer, 7 s of the board, then the next question's intro
      `q-plain intro → q-plain open: ${INTRO}`,
      'q-plain open → q-plain locked: 20000',
      `q-plain locked → q-plain reveal: ${REVEAL_WAIT}`,
      `q-plain reveal → q-plain board: ${SHOW.revealMs}`,
      `q-plain board → q-text intro: ${SHOW.boardMs}`,
      // number with a text after the answer: time to read it
      `q-text intro → q-text open: ${INTRO}`,
      'q-text open → q-text locked: 20000',
      `q-text locked → q-text reveal: ${REVEAL_WAIT}`,
      `q-text reveal → q-text board: ${SHOW.revealTextMs}`,
      `q-text board → q-photo intro: ${SHOW.boardMs}`,
      // ordering with a photo
      `q-photo intro → q-photo open: ${INTRO}`,
      'q-photo open → q-photo locked: 20000',
      `q-photo locked → q-photo reveal: ${REVEAL_WAIT}`,
      `q-photo reveal → q-photo board: ${SHOW.revealPictureMs}`,
      `q-photo board → q-video intro: ${SHOW.boardMs}`,
      // choice with a 7 s video after the answer: it comes ~9 s in and plays to its end
      `q-video intro → q-video open: ${INTRO}`,
      'q-video open → q-video locked: 20000',
      `q-video locked → q-video reveal: ${REVEAL_WAIT}`,
      `q-video reveal → q-video board: ${SHOW.revealVideoLeadMs + 7_000 + SHOW.revealVideoTailMs}`,
      `q-video board → q-surprise intro: ${SHOW.boardMs}`,
      // the «Сюрприз»: 4 s after the options, the video, the answer right after it, the final 10 s later
      `q-surprise intro → q-surprise open: ${INTRO}`,
      `q-surprise open → q-surprise locked: ${S}`,
      `q-surprise locked → q-surprise reveal: ${surpriseLeadMs() + V}`,
      `q-surprise reveal → final 0: ${SURPRISE.toFinalMs}`,
      // drumroll → 3rd → 2nd → 1st → Vlados → the mosaic → the video after the final
      `final 0 → final 1: ${d0}`,
      `final 1 → final 2: ${d1}`,
      `final 2 → final 3: ${d2}`,
      `final 3 → final 4: ${d3}`,
      `final 4 → final 5: ${d4}`,
      `final 5 → final 6: ${FINALE.autoMs}`,
    ]);
    // the last step: nothing is scheduled after the video
    expect(w.game.final?.step).toBe(6);
    expect(w.deadline()).toBeNull();
    // the photo / video holds are frozen into the round when it starts (restart-safe)
    expect(w.totals!.rounds.map((r) => r.revealHoldMs)).toEqual([undefined, undefined, SHOW.revealPictureMs, 20_000, undefined]);
  });

  it('the exact timings table', () => {
    expect(SHOW).toEqual({
      revealMs: 9_000,
      revealTextMs: 12_000,
      revealPictureMs: 16_000,
      revealVideoLeadMs: 9_000,
      revealVideoTailMs: 4_000,
      revealVideoEndedMs: 2_000,
      revealVideoUnknownMs: 30_000,
      revealVideoMaxMs: 600_000,
      boardMs: 7_000,
      finalStepMs: [4_000, 4_500, 4_500, 7_000, 9_000],
    });
    expect(FINALE.autoMs).toBe(5_000);
    expect(SURPRISE.toFinalMs).toBe(10_000);
    expect(SURPRISE.afterDefaultS).toBe(4);
    // a reveal video: from its start (startAtS), unknown length → the fallback
    expect(revealHoldMs({ revealMedia: { mediaId: 'v', onPhones: true, startAtS: 2 } }, { v: { kind: 'video', durationS: 12 } })).toBe(9_000 + 10_000 + 4_000);
    expect(revealHoldMs({ revealMedia: { mediaId: 'v', onPhones: true } }, { v: { kind: 'video' } })).toBe(9_000 + 30_000 + 4_000);
    // a reveal media that is not resolved is not shown: the base (or the text) hold
    expect(revealHoldMs({ revealMedia: { mediaId: 'gone', onPhones: true }, revealText: 'Ага' }, {})).toBe(SHOW.revealTextMs);
    expect(revealHoldMs({ revealText: '   ' }, {})).toBe(SHOW.revealMs);
  });

  it('«Прогнать игру» runs on the same timings: its show is the live one', () => {
    const tl = simulate({ content: mkContent(), media: MEDIA });
    const byQ = new Map(tl.rounds.map((r) => [r.qid, r] as const));
    expect(byQ.get('q-plain')!.boardAt! - byQ.get('q-plain')!.revealAt!).toBe(SHOW.revealMs);
    expect(byQ.get('q-text')!.boardAt! - byQ.get('q-text')!.revealAt!).toBe(SHOW.revealTextMs);
    expect(byQ.get('q-photo')!.boardAt! - byQ.get('q-photo')!.revealAt!).toBe(SHOW.revealPictureMs);
    // the reveal video: like the live TV, the rehearsal's TV reports its end ('revealMediaEnd') when
    // the droplet has landed and the 7 s have played → the board 2 s later (the clock hold: 20 s)
    const ended = revealVideoStartMs(Q_VIDEO) + 7_000;
    expect(byQ.get('q-video')!.boardAt! - byQ.get('q-video')!.revealAt!).toBe(revealAfterEndMs(20_000, ended));
    expect(byQ.get('q-video')!.boardAt! - byQ.get('q-video')!.revealAt!).toBe(ended + SHOW.revealVideoEndedMs);
    for (const [a, b] of [['q-plain', 'q-text'], ['q-text', 'q-photo'], ['q-photo', 'q-video'], ['q-video', 'q-surprise']] as const) {
      expect(byQ.get(b)!.introAt - byQ.get(a)!.boardAt!).toBe(SHOW.boardMs);
    }
    const sp = byQ.get('q-surprise')!;
    expect(sp.surpriseAt! - sp.openAt).toBe(4_000);
    expect(tl.finalAt! - sp.revealAt!).toBe(SURPRISE.toFinalMs);
    const steps = tl.marks.filter((m) => m.stage === 'final').map((m) => m.at);
    expect(steps.slice(1).map((at, k) => at - steps[k]!)).toEqual([...SHOW.finalStepMs, FINALE.autoMs]);
    // a draft with the autopilot switched off still rehearses the autopilot's show
    const off = simulate({ content: mkContent({ autopilot: false }), media: MEDIA });
    expect(off.rounds.map((r) => [r.revealAt, r.boardAt])).toEqual(tl.rounds.map((r) => [r.revealAt, r.boardAt]));
  });
});

describe('«Автопилот»: settings', () => {
  it('undefined (every settings doc before it existed, PROD autoAdvance all null) is ON', () => {
    const { autopilot: _gone, ...old } = defaultSettings();
    const prodLike = { ...old, autoAdvance: { revealToBoardS: null, boardToNextS: null, finalStepS: null } };
    expect('autopilot' in prodLike).toBe(false);
    expect(autopilotOn(prodLike)).toBe(true);
    expect(autopilotOn(undefined)).toBe(true);
    expect(autoHoldMs({ phase: 'board', finalStep: 0 }, undefined, prodLike)).toBe(SHOW.boardMs);
    // the host reads admin/content through hostContent: the same (the default is merged in)
    expect(hostContent({ rev: 1, settings: prodLike, questions: [] }).settings.autopilot).toBe(true);
    const w = new World({ rev: 1, settings: { ...prodLike, introMs: INTRO, lockMs: LOCK } as Settings, questions: [Q_PLAIN] });
    w.cmd({ type: 'start' }, T0);
    w.until(T0 + INTRO + 20_000 + REVEAL_WAIT);
    expect(w.game.phase).toBe('reveal');
    expect(w.deadline()).toBe(w.phaseAt + SHOW.revealMs);
  });

  it('off: the organizer\'s button for every step (the video after the mosaic and the final after a «Сюрприз» stay timed)', () => {
    const w = new World(mkContent({ autopilot: false }, [Q_PLAIN, Q_SURPRISE]));
    w.cmd({ type: 'start' }, T0);
    w.until(T0 + 10 * MIN);
    expect(w.game.phase).toBe('reveal');
    expect(w.deadline()).toBeNull();
    const a = w.admin();
    expect(a.autopilot).toEqual({ on: false, next: null });
    expect(heroAction(a)).toMatchObject({ label: 'Таблица', cmd: { type: 'advance' } });
    expect(w.cmd({ type: 'advance', phaseRev: w.game.phaseRev }).ok).toBe(true);
    w.until(w.now + 10 * MIN);
    expect(w.game.phase).toBe('board');
    expect(heroAction(w.admin())).toMatchObject({ label: 'Следующий вопрос' });
    expect(w.cmd({ type: 'advance', phaseRev: w.game.phaseRev }).ok).toBe(true);
    // the «Сюрприз»: its reveal goes on to the final by itself, autopilot or not
    w.until(w.round().openAt + 4_000);
    expect(w.game.phase).toBe('locked');
    expect(w.cmd({ type: 'surpriseEnd', phaseRev: w.game.phaseRev }, w.now + 1_000).ok).toBe(true);
    const r = w.now;
    expect(w.deadline()).toBe(r + SURPRISE.toFinalMs);
    expect(w.admin().autopilot.next).toMatchObject({ kind: 'final', ms: SURPRISE.toFinalMs });
    w.until(r + SURPRISE.toFinalMs);
    expect(w.game.phase).toBe('final');
    expect(w.deadline()).toBeNull();
    for (let s = 1; s <= 5; s++) expect(w.cmd({ type: 'advance', phaseRev: w.game.phaseRev }, w.now + 1_000).ok).toBe(true);
    expect(w.deadline()).toBe(w.now + FINALE.autoMs);
  });

  it('off with the old autoAdvance numbers: those apply', () => {
    const w = new World(mkContent({ autopilot: false, autoAdvance: { revealToBoardS: 3, boardToNextS: 2, finalStepS: 1 } }, [Q_PHOTO]));
    w.cmd({ type: 'start' }, T0);
    w.until(T0 + INTRO + 20_000 + REVEAL_WAIT);
    expect(w.game.phase).toBe('reveal');
    // the photo's 16 s are the autopilot's: switched off, the number rules
    expect(w.deadline()).toBe(w.phaseAt + 3_000);
    w.until(w.phaseAt + 3_000);
    expect(w.game.phase).toBe('board');
    expect(w.deadline()).toBe(w.phaseAt + 2_000);
  });

  it('switched on / off mid-show: the host follows the settings at once, the countdown from the stored phaseAt', () => {
    const w = new World(mkContent({ autopilot: false }, [Q_PLAIN, Q_TEXT]));
    w.cmd({ type: 'start' }, T0);
    w.until(T0 + INTRO + 20_000 + REVEAL_WAIT);
    const revealAt = w.phaseAt;
    w.until(revealAt + 5_000);
    expect(w.game.phase).toBe('reveal');
    w.content = mkContent({ autopilot: true }, [Q_PLAIN, Q_TEXT]);
    expect(w.deadline()).toBe(revealAt + SHOW.revealMs);
    expect(autoStepText(w.admin(revealAt + 5_000).autopilot.next!)).toBe('Таблица через 4 с');
    // switched on long after: the board at once (late: once)
    w.content = mkContent({ autopilot: false }, [Q_PLAIN, Q_TEXT]);
    w.until(revealAt + MIN);
    expect(w.game.phase).toBe('reveal');
    w.content = mkContent({ autopilot: true }, [Q_PLAIN, Q_TEXT]);
    w.until(revealAt + MIN);
    expect(w.game.phase).toBe('board');
    expect(w.phaseAt).toBe(revealAt + MIN);
    expect(w.deadline()).toBe(revealAt + MIN + SHOW.boardMs);
  });
});

describe('«Автопилот»: the organizer stays in control', () => {
  const toReveal = (w: World, q: Question = Q_PLAIN): number => {
    w.cmd({ type: 'start' }, T0);
    w.until(T0 + INTRO + q.timeLimitS * 1000 + REVEAL_WAIT);
    expect(w.game.phase).toBe('reveal');
    return w.phaseAt;
  };

  it('the big button: what comes and when; pressing it does that step now, the next countdown starts then', () => {
    const w = new World(mkContent({}, [Q_PLAIN, Q_TEXT]));
    const r = toReveal(w);
    let a = w.admin(r + 2_500);
    expect(a.autopilot).toEqual({ on: true, next: { kind: 'board', n: null, ms: 6_500, at: r + SHOW.revealMs, held: false } });
    expect(heroAction(a)).toMatchObject({ label: 'Таблица через 7 с', sub: 'автопилот · нажми — покажу сразу', cmd: { type: 'advance', phaseRev: w.game.phaseRev } });
    // skip the wait
    const rev = w.game.phaseRev;
    expect(w.cmd({ type: 'advance', phaseRev: rev }, r + 3_000).ok).toBe(true);
    expect(w.game.phase).toBe('board');
    expect(w.deadline()).toBe(r + 3_000 + SHOW.boardMs);
    a = w.admin(r + 4_000);
    expect(heroAction(a).label).toBe('Вопрос 2 через 6 с');
    // a second tap from before the move (or the host's own tick at the old moment): nothing twice
    expect(w.cmd({ type: 'advance', phaseRev: rev }, r + 3_100)).toMatchObject({ ok: false, error: 'stale' });
    expect(w.tick(r + SHOW.revealMs).changed).toBe(false);
    expect(w.game.phase).toBe('board');
    w.until(r + 3_000 + SHOW.boardMs);
    expect(w.game).toMatchObject({ phase: 'intro', round: { qid: 'q-text', n: 2 } });
    // the last question's board → «Финал через …»; the final steps count down too
    w.until(w.round().endsAt + REVEAL_WAIT + SHOW.revealTextMs);
    expect(w.game.phase).toBe('board');
    expect(heroAction(w.admin(w.phaseAt + 1_000)).label).toBe('Финал через 6 с');
    w.until(w.phaseAt + SHOW.boardMs);
    expect(w.game.phase).toBe('final');
    const names = [];
    for (let s = 0; s < 6; s++) {
      names.push(heroAction(w.admin(w.phaseAt)).label);
      w.until(w.deadline()!);
    }
    expect(names).toEqual(['3-е место через 4 с', '2-е место через 5 с', '1-е место через 5 с', 'Финальные титры через 7 с', 'С днём рождения через 9 с', 'Финальное видео через 5 с']);
    expect(w.game.final?.step).toBe(6);
    expect(heroAction(w.admin()).cmd).toBeUndefined();
  });

  it('«стоп-экран» freezes the countdown in the answer, the board and the final; released, the rest runs', () => {
    const w = new World(mkContent({}, [Q_PLAIN, Q_TEXT]));
    const r = toReveal(w);
    w.cmd({ type: 'hold', phaseRev: w.game.phaseRev, text: 'Тост!' }, r + 4_000);
    expect(w.game.pause).toMatchObject({ reason: 'hold', remainingMs: SHOW.revealMs - 4_000 });
    expect(w.deadline()).toBeNull();
    expect(w.admin(r + 50_000).autopilot.next).toEqual({ kind: 'board', n: null, ms: 5_000, at: null, held: true });
    w.until(r + 5 * MIN);
    expect(w.game.phase).toBe('reveal');
    const u = r + 5 * MIN;
    w.cmd({ type: 'unhold' }, u);
    expect(w.deadline()).toBe(u + 5_000);
    w.until(u + 5_000);
    expect(w.game.phase).toBe('board');
    // the board, 2 s in
    const b = w.phaseAt;
    w.cmd({ type: 'hold', phaseRev: w.game.phaseRev, text: 'Минутку' }, b + 2_000);
    w.until(b + 3 * MIN);
    expect(w.game.phase).toBe('board');
    w.cmd({ type: 'unhold' }, b + 3 * MIN);
    expect(w.deadline()).toBe(b + 3 * MIN + SHOW.boardMs - 2_000);
    // the final: 1st place (step 3 → 4, 7 s), held 3 s in
    w.cmd({ type: 'end' }, w.now + 1_000);
    for (let s = 0; s < 3; s++) w.until(w.deadline()!);
    expect(w.game.final?.step).toBe(3);
    const f = w.phaseAt;
    w.cmd({ type: 'hold', phaseRev: w.game.phaseRev, text: 'Ура!' }, f + 3_000);
    expect(w.game.pause?.remainingMs).toBe(SHOW.finalStepMs[3]! - 3_000);
    w.until(f + 10 * MIN);
    expect(w.game.final?.step).toBe(3);
    w.cmd({ type: 'unhold' }, f + 10 * MIN);
    expect(w.deadline()).toBe(f + 10 * MIN + 4_000);
  });

  it('the admin pause during a question freezes it; the autopilot goes on after the answer as usual', () => {
    const w = new World(mkContent({}, [Q_PLAIN, Q_TEXT]));
    w.cmd({ type: 'start' }, T0);
    w.until(T0 + INTRO + 5_000);
    expect(w.game.phase).toBe('open');
    w.cmd({ type: 'pause' }, T0 + INTRO + 5_000);
    w.until(T0 + 10 * MIN);
    expect(w.game.phase).toBe('open');
    w.cmd({ type: 'resume' }, T0 + 10 * MIN);
    // 15 s of the answer time were left
    w.until(T0 + 10 * MIN + 15_000 + REVEAL_WAIT);
    expect(w.game.phase).toBe('reveal');
    expect(w.deadline()).toBe(w.phaseAt + SHOW.revealMs);
  });

  it('restart mid-wait: a new host (or a lease takeover) keeps the moment from the stored docs; late: at once, once', () => {
    const w = new World(mkContent({}, [Q_VIDEO, Q_PLAIN]));
    const r = toReveal(w, Q_VIDEO);
    const hold = SHOW.revealVideoLeadMs + 7_000 + SHOW.revealVideoTailMs;
    expect(w.deadline()).toBe(r + hold);
    // the restarted page: the same docs, no media index yet (it loads in the background)
    const fresh = new World(w.content, {});
    fresh.game = w.game;
    fresh.totals = w.totals;
    expect(fresh.deadline()).toBe(r + hold);
    // it comes back 40 s late: exactly one step (the board), its own 7 s from now
    const rev = fresh.game.phaseRev;
    expect(fresh.tick(r + hold + 40_000).changed).toBe(true);
    expect(fresh.game.phase).toBe('board');
    expect(fresh.game.phaseRev).toBe(rev + 1);
    // the old host wakes up too: its tick finds the board, nothing moves twice
    expect(fresh.tick(r + hold + 40_050).changed).toBe(false);
    expect(fresh.phaseAt).toBe(r + hold + 40_000);
    expect(fresh.deadline()).toBe(r + hold + 40_000 + SHOW.boardMs);
    // a hold's release shifts the stored phaseAt: a restart after it still has the time left
    fresh.cmd({ type: 'hold', phaseRev: fresh.game.phaseRev, text: 'Пауза' }, fresh.phaseAt + 2_000);
    fresh.cmd({ type: 'unhold' }, fresh.now + MIN);
    const again = new World(fresh.content, {});
    again.game = fresh.game;
    again.totals = fresh.totals;
    expect(again.deadline()).toBe(fresh.now + SHOW.boardMs - 2_000);
  });

  it('skip and «Сразу к финалу» still work; the autopilot continues from there', () => {
    const w = new World(mkContent({}, [Q_PLAIN, Q_TEXT, Q_PHOTO]));
    w.cmd({ type: 'start' }, T0);
    w.until(T0 + INTRO + 1_000);
    expect(w.cmd({ type: 'skip', phaseRev: w.game.phaseRev }, T0 + INTRO + 1_000).ok).toBe(true);
    expect(w.game).toMatchObject({ phase: 'intro', round: { qid: 'q-text', n: 1 } });
    w.until(w.round().endsAt + REVEAL_WAIT);
    expect(w.game.phase).toBe('reveal');
    expect(w.deadline()).toBe(w.phaseAt + SHOW.revealTextMs);
    expect(w.cmd({ type: 'end' }, w.now + 1_000).ok).toBe(true);
    expect(w.game).toMatchObject({ phase: 'final', final: { step: 0 } });
    expect(w.deadline()).toBe(w.phaseAt + SHOW.finalStepMs[0]!);
  });
});

describe('«Автопилот»: the TV reports the end of the reveal video (\'revealMediaEnd\')', () => {
  /** Q_VIDEO's reveal video is 7 s: the clock hold is 9 s lead + 7 s + 4 s. */
  const CLOCK = SHOW.revealVideoLeadMs + 7_000 + SHOW.revealVideoTailMs;
  const toVideoReveal = (w: World): number => {
    w.cmd({ type: 'start' }, T0);
    w.until(T0 + INTRO + Q_VIDEO.timeLimitS * 1000 + REVEAL_WAIT);
    expect(w.game).toMatchObject({ phase: 'reveal', round: { qid: 'q-video' } });
    expect(w.deadline()).toBe(w.phaseAt + CLOCK);
    return w.phaseAt;
  };
  const report = (w: World, at: number, rev = w.game.phaseRev) => w.cmd({ type: 'revealMediaEnd', phaseRev: rev }, at);

  it('the board 2 s after the TV\'s \'ended\' (not at the clock); once; the phase and its phaseRev stay', () => {
    const w = new World(mkContent({}, [Q_VIDEO, Q_PLAIN]));
    const r = toVideoReveal(w);
    const rev = w.game.phaseRev;
    // the video came 9.6 s in and played its 7 s: 'ended' at 16.6 s
    const out = report(w, r + 16_600);
    expect(out).toMatchObject({ ok: true, changed: true });
    expect(w.game).toMatchObject({ phase: 'reveal', phaseRev: rev });
    expect(w.phaseAt).toBe(r);
    expect(w.totals!.rounds[0]!.revealEndMs).toBe(16_600);
    expect(w.deadline()).toBe(r + 16_600 + SHOW.revealVideoEndedMs);
    // the organizer's countdown agrees
    expect(w.admin(r + 17_000).autopilot.next).toEqual({ kind: 'board', n: null, ms: 1_600, at: r + 18_600, held: false });
    // a second report (a replay, a retry): nothing changes, nothing is written
    expect(report(w, r + 17_500)).toMatchObject({ ok: true, changed: false });
    expect(w.totals!.rounds[0]!.revealEndMs).toBe(16_600);
    w.until(r + 18_600);
    expect(w.game.phase).toBe('board');
    expect(w.phaseAt).toBe(r + 18_600);
    expect(w.deadline()).toBe(r + 18_600 + SHOW.boardMs);
    // too late now: the reveal is over
    expect(report(w, r + 19_000, rev)).toMatchObject({ ok: false, error: 'stale' });
  });

  it('never before the plain 9 s hold; never after the clock hold (the fallback)', () => {
    expect(revealAfterEndMs(CLOCK, undefined)).toBe(CLOCK);
    expect(revealAfterEndMs(CLOCK, 1_000)).toBe(SHOW.revealMs);
    expect(revealAfterEndMs(CLOCK, 10_000)).toBe(12_000);
    expect(revealAfterEndMs(CLOCK, CLOCK)).toBe(CLOCK);
    expect(revealAfterEndMs(CLOCK, Number.NaN)).toBe(CLOCK);
    // a very short clip ended 3 s in: the answer still stays its 9 s
    const w = new World(mkContent({}, [Q_VIDEO, Q_PLAIN]));
    const r = toVideoReveal(w);
    expect(report(w, r + 3_000).ok).toBe(true);
    expect(w.deadline()).toBe(r + SHOW.revealMs);
    // a video that started late ends after the clock would have moved on: the clock wins
    const l = new World(mkContent({}, [Q_VIDEO, Q_PLAIN]));
    const rl = toVideoReveal(l);
    expect(report(l, rl + CLOCK - 500).ok).toBe(true);
    expect(l.deadline()).toBe(rl + CLOCK);
    // a report after the clock hold finds the board (the overdue step is applied first)
    const z = new World(mkContent({}, [Q_VIDEO, Q_PLAIN]));
    const rz = toVideoReveal(z);
    const rev = z.game.phaseRev;
    expect(report(z, rz + CLOCK + 100, rev)).toMatchObject({ ok: false, error: 'stale' });
  });

  it('only the reveal of a video: refused elsewhere (stale phaseRev, no video, a photo, the board, held)', () => {
    const w = new World(mkContent({}, [Q_PLAIN, Q_PHOTO, Q_VIDEO]));
    w.cmd({ type: 'start' }, T0);
    // not in the reveal yet
    expect(report(w, T0 + 1_000)).toMatchObject({ ok: false, error: 'invalid' });
    w.until(T0 + INTRO + 20_000 + REVEAL_WAIT);
    expect(w.game).toMatchObject({ phase: 'reveal', round: { qid: 'q-plain' } });
    expect(report(w, w.now)).toMatchObject({ ok: false, error: 'invalid' });
    expect(report(w, w.now, w.game.phaseRev - 1)).toMatchObject({ ok: false, error: 'stale' });
    w.until(w.phaseAt + SHOW.revealMs);
    expect(w.game.phase).toBe('board');
    expect(report(w, w.now)).toMatchObject({ ok: false, error: 'invalid' });
    // a photo after the answer: its 16 s stay
    w.until(w.phaseAt + SHOW.boardMs);
    w.until(w.round().endsAt + REVEAL_WAIT);
    expect(w.game).toMatchObject({ phase: 'reveal', round: { qid: 'q-photo' } });
    expect(report(w, w.phaseAt + 5_000)).toMatchObject({ ok: false, error: 'invalid' });
    expect(w.deadline()).toBe(w.phaseAt + SHOW.revealPictureMs);
    // the video's reveal under the «стоп-экран»: refused (nothing plays), accepted once released
    w.until(w.phaseAt + SHOW.revealPictureMs + SHOW.boardMs);
    w.until(w.round().endsAt + REVEAL_WAIT);
    expect(w.game).toMatchObject({ phase: 'reveal', round: { qid: 'q-video' } });
    const r = w.phaseAt;
    expect(w.cmd({ type: 'hold', phaseRev: w.game.phaseRev, text: 'Тост!' }, r + 12_000).ok).toBe(true);
    expect(report(w, r + 13_000)).toMatchObject({ ok: false, error: 'invalid' });
    expect(w.admin(r + 13_000).can.revealMediaEnd).toBe(false);
    // released after 30 s: the video plays on and ends 4 s later → the board 2 s after that
    expect(w.cmd({ type: 'unhold' }, r + 42_000).ok).toBe(true);
    expect(w.phaseAt).toBe(r + 30_000);
    expect(w.admin(r + 43_000).can.revealMediaEnd).toBe(true);
    expect(report(w, r + 46_000).ok).toBe(true);
    expect(w.totals!.rounds.at(-1)!.revealEndMs).toBe(16_000);
    expect(w.deadline()).toBe(r + 48_000);
  });

  it('a «стоп-экран» after the report keeps the time left; a restarted host keeps the moment', () => {
    const w = new World(mkContent({}, [Q_VIDEO, Q_PLAIN]));
    const r = toVideoReveal(w);
    expect(report(w, r + 16_000).ok).toBe(true);
    expect(w.cmd({ type: 'hold', phaseRev: w.game.phaseRev, text: 'Минутку' }, r + 17_000).ok).toBe(true);
    expect(w.game.pause?.remainingMs).toBe(1_000);
    w.until(r + 5 * MIN);
    expect(w.game.phase).toBe('reveal');
    expect(w.cmd({ type: 'unhold' }, r + 5 * MIN).ok).toBe(true);
    expect(w.deadline()).toBe(r + 5 * MIN + 1_000);
    // a new host (no media index yet) from the docs: the same moment
    const fresh = new World(w.content, {});
    fresh.game = w.game;
    fresh.totals = w.totals;
    expect(fresh.deadline()).toBe(r + 5 * MIN + 1_000);
  });

  it('the autopilot off: the report is kept, the organizer\'s button still decides', () => {
    const w = new World(mkContent({ autopilot: false }, [Q_VIDEO, Q_PLAIN]));
    w.cmd({ type: 'start' }, T0);
    w.until(T0 + INTRO + 20_000 + REVEAL_WAIT);
    expect(w.game.phase).toBe('reveal');
    expect(report(w, w.phaseAt + 16_000).ok).toBe(true);
    expect(w.deadline()).toBeNull();
  });

  it('host command → engine event (a phaseRev that is not a number is refused)', () => {
    expect(hostEvent({ type: 'revealMediaEnd', phaseRev: 7 }, null)).toEqual({ t: 'revealMediaEnd', phaseRev: 7 });
    expect(hostEvent({ type: 'revealMediaEnd', phaseRev: Number.NaN }, null)).toBeNull();
  });
});
