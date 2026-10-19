// The video after the final (shared/engine/finale.ts): final step 6 after the mosaic — built-in
// clip by default, an uploaded one, or none; published with its start and length, followed by the
// phones on the clock, frozen and moved by the «стоп-экран», included in «Прогнать игру».

import { defaultSettings } from '@shared/defaults';
import { FINALE, finaleCustomId, finaleMsOf, finaleOn, lastFinalStep } from '@shared/engine/finale';
import type { GameDoc, PlayerDoc } from '@shared/fbtypes';
import type { ChoiceQ, Settings } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { heroAction } from '../screens/admin/core/live';
import { mainAction } from '../screens/tv/keys';
import type { HostHealth, HostSnapshot, MediaIndex, TotalsDoc } from './model';
import { emptyTotals, hostDeadline, hostEvent, initialGameDoc, step, type HostCommand, type HostContent, type StepOut } from './pure';
import { simulate } from './rehearsal';
import { buildAdminView, buildPlayerView, buildTvView, finaleView } from './views';

const T0 = 1_800_000_000_000;
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
const CUSTOM: MediaIndex = { vid: { kind: 'video', posterId: 'vid-poster', durationS: 21.5, w: 1280, h: 720 }, pic: { kind: 'image', w: 800, h: 600 } };

const mkContent = (patch: Partial<Settings> = {}): HostContent => ({ rev: 1, settings: { ...defaultSettings(), introMs: 1_000, lockMs: 500, ...patch }, questions: [Q1] });

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

class World {
  game: GameDoc;
  totals: TotalsDoc | null = emptyTotals(T0);
  players: Record<string, PlayerDoc> = {};
  now = T0;
  constructor(
    public content: HostContent = mkContent(),
    public media: MediaIndex = {},
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
  advance(at = this.now): StepOut {
    return this.cmd({ type: 'advance', phaseRev: this.game.phaseRev }, at);
  }
  deadline(): number | null {
    return hostDeadline(this.input(), this.content);
  }
  until(t: number): void {
    for (let k = 0; k < 40; k++) {
      const d = this.deadline();
      if (d === null || d > t) break;
      this.now = Math.max(this.now, d);
      this.apply(step(this.input(), { t: 'tick' }, this.now, this.ctx()));
    }
    this.now = Math.max(this.now, t);
  }
  /** Plays the one question and ends in the final at step `n`. */
  toFinalStep(n: number): void {
    this.cmd({ type: 'start' });
    this.cmd({ type: 'end' }, this.now + 2_000);
    expect(this.game.phase).toBe('final');
    // 1 s apart: before any auto-advance (finalStepS ≥ 2), which would otherwise run first and make the press stale
    for (let k = 0; k < n; k++) this.advance(this.now + 1_000);
    expect(this.game.final?.step).toBe(n);
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
  phone(uid = 'a', now = this.now) {
    return buildPlayerView({ uid, gameId: 'g', game: this.game, gameState: 'live', me: this.players[uid] ?? null, meLoaded: true, answers: {}, lastScore: null, reactionsSent: [] }, now);
  }
}

describe('finale settings', () => {
  it('built-in by default; off ends the final at the mosaic; custom needs a file', () => {
    const d = defaultSettings();
    expect(d.finaleVideo).toBe('builtin');
    expect(finaleOn(d)).toBe(true);
    expect(lastFinalStep(d)).toBe(6);
    expect(lastFinalStep({ finaleVideo: 'off' })).toBe(5);
    // older settings docs without the field get the built-in clip
    expect(lastFinalStep({})).toBe(6);
    expect(finaleCustomId({ finaleVideo: 'custom', finaleMediaId: 'vid' })).toBe('vid');
    expect(finaleCustomId({ finaleVideo: 'custom' })).toBeNull();
    expect(finaleCustomId({ finaleVideo: 'builtin', finaleMediaId: 'vid' })).toBeNull();
    expect(finaleMsOf(21.5)).toBe(21_500);
    expect(finaleMsOf(undefined)).toBe(FINALE.unknownMs);
    expect(finaleMsOf(1e9)).toBe(FINALE.maxMs);
  });
});

describe('final step 6: the video after the final', () => {
  it('comes after the mosaic on «advance»; the built-in clip starts after the droplet', () => {
    const w = new World();
    w.toFinalStep(5);
    expect(w.game.final?.video).toBeUndefined();
    const a = buildAdminView(w.snap(), w.now);
    expect(a.finalLast).toBe(6);
    expect(a.can.advance).toBe(true);
    // the autopilot's button: what comes and when; switched off: the old button
    expect(heroAction(a)).toMatchObject({ label: 'Финальное видео через 5 с', cmd: { type: 'advance' } });
    expect(heroAction({ ...a, autopilot: { ...a.autopilot, on: false } })).toMatchObject({ label: '▶ Финальное видео', cmd: { type: 'advance' } });
    expect(mainAction(a)?.cmd).toMatchObject({ type: 'advance' });

    const at = w.now + 3_000;
    expect(w.advance(at).ok).toBe(true);
    expect(w.game.final?.step).toBe(6);
    expect(w.game.final?.video).toEqual({ at: at + FINALE.leadMs, ms: FINALE.builtin.ms, w: 464, h: 848 });
    // the mosaic's selfies stay on the TV underneath / afterwards
    expect(buildTvView(w.snap(), w.now).final?.mosaic?.length).toBe(2);
    // the last step: nothing moves the game on, not even auto-advance
    expect(w.advance(at + 1_000)).toMatchObject({ ok: false, error: 'invalid' });
    expect(w.deadline()).toBeNull();
    const b = buildAdminView(w.snap(), at + 1_000);
    expect(b.can.advance).toBe(false);
    expect(mainAction(b)).toBeNull();
    expect(heroAction(b).cmd).toBeUndefined();
  });

  it('off: the final ends at the mosaic, as before', () => {
    const w = new World(mkContent({ finaleVideo: 'off' }));
    w.toFinalStep(5);
    expect(w.advance(w.now + 1_000)).toMatchObject({ ok: false, error: 'invalid' });
    const a = buildAdminView(w.snap(), w.now);
    expect(a.finalLast).toBe(5);
    expect(a.can.advance).toBe(false);
    expect(heroAction(a).label).toBe('Игра окончена');
  });

  it('autopilot off, with auto-advance: the steps before it follow finalStepS, the video still starts 5 s after the mosaic', () => {
    const w = new World(mkContent({ autopilot: false, autoAdvance: { revealToBoardS: null, boardToNextS: null, finalStepS: 8 } }));
    w.cmd({ type: 'start' });
    w.cmd({ type: 'end' }, w.now + 2_000);
    const f0 = w.now;
    w.until(f0 + 5 * 8_000);
    expect(w.game.final?.step).toBe(5);
    w.until(f0 + 5 * 8_000 + FINALE.autoMs);
    expect(w.game.final?.step).toBe(6);
    expect(w.game.final?.video?.at).toBe(f0 + 5 * 8_000 + FINALE.autoMs + FINALE.leadMs);
    expect(w.deadline()).toBeNull();
  });

  it('an uploaded video: its id, poster, size and length; phones prefetch the poster during the mosaic', () => {
    const w = new World(mkContent({ finaleVideo: 'custom', finaleMediaId: 'vid' }), CUSTOM);
    w.toFinalStep(5);
    expect(w.game.next).toEqual({ media: ['vid-poster'] });
    w.advance(w.now + 1_000);
    expect(w.game.final?.video).toEqual({ at: w.now + FINALE.leadMs, ms: 21_500, id: 'vid', poster: 'vid-poster', w: 1280, h: 720 });
    expect(w.game.next).toBeNull();
    // TV: the video + its poster; phones: never the video, only the poster
    const tv = buildTvView(w.snap(), w.now);
    expect(tv.finale).toMatchObject({ stage: 'gather', videoId: 'vid', posterId: 'vid-poster', videoMs: 21_500, w: 1280, h: 720 });
    expect(tv.media).toEqual(['vid', 'vid-poster']);
    const ph = w.phone();
    expect(ph.finale).not.toHaveProperty('videoId');
    expect(ph.finale?.posterId).toBe('vid-poster');
    expect(ph.media).toEqual(['vid-poster']);
  });

  it('custom without a (video) file falls back to the built-in clip', () => {
    for (const s of [{ finaleVideo: 'custom' as const }, { finaleVideo: 'custom' as const, finaleMediaId: 'pic' }, { finaleVideo: 'custom' as const, finaleMediaId: 'gone' }]) {
      const w = new World(mkContent(s), CUSTOM);
      w.toFinalStep(6);
      expect(w.game.final?.video).toMatchObject({ ms: FINALE.builtin.ms, w: 464, h: 848 });
      expect(w.game.final?.video?.id).toBeUndefined();
    }
  });

  it('views: gather → play → after on the clock; phones watch, then their final screen again', () => {
    const w = new World();
    w.toFinalStep(6);
    const v = w.game.final!.video!;
    const at = (t: number) => finaleView(w.game, t);
    expect(at(v.at - 1)).toMatchObject({ stage: 'gather', posMs: 0, videoId: null, posterId: null, w: 464, h: 848 });
    expect(at(v.at + 5_000)).toMatchObject({ stage: 'play', posMs: 5_000, endAt: v.at + v.ms });
    expect(at(v.at + v.ms + FINALE.tailMs - 1)?.stage).toBe('play');
    expect(at(v.at + v.ms + FINALE.tailMs)).toMatchObject({ stage: 'after', posMs: v.ms });
    const ph = w.phone('a', v.at + 3_000);
    expect(ph.screen).toBe('final');
    expect(ph.finale?.stage).toBe('play');
    expect(ph.media).toEqual([]);
    expect(w.phone('a', v.at + v.ms + 5_000).finale?.stage).toBe('after');
    // nothing before step 6
    const w5 = new World();
    w5.toFinalStep(5);
    expect(finaleView(w5.game, w5.now)).toBeNull();
    expect(w5.phone().finale).toBeNull();
  });

  it('«стоп-экран» mid-video: frozen where it stood, released → the start moves by the hold', () => {
    const w = new World();
    w.toFinalStep(6);
    const v0 = w.game.final!.video!;
    w.cmd({ type: 'hold', phaseRev: w.game.phaseRev, text: '🎂 Торт!' }, v0.at + 6_000);
    expect(finaleView(w.game, v0.at + 60_000)).toMatchObject({ stage: 'play', posMs: 6_000 });
    expect(w.phone('a', v0.at + 60_000).hold).not.toBeNull();
    expect(buildAdminView(w.snap(), v0.at + 60_000).can.advance).toBe(false);
    w.cmd({ type: 'unhold' }, v0.at + 36_000);
    const v1 = w.game.final!.video!;
    expect(v1.at).toBe(v0.at + 30_000);
    expect(finaleView(w.game, v0.at + 36_000)).toMatchObject({ stage: 'play', posMs: 6_000 });
    expect(finaleView(w.game, v1.at + v1.ms + FINALE.tailMs)?.stage).toBe('after');
  });
});

describe('the video starts by itself 5 s after «С днём рождения» (the mosaic)', () => {
  /** The final at the mosaic (step 5); returns the moment it came on. */
  const toMosaic = (w: World): number => {
    w.toFinalStep(5);
    return w.now;
  };
  const tick = (w: World, at: number): StepOut => {
    const out = step({ gameId: 'g', game: w.game, totals: w.totals, players: w.players, answers: [] }, { t: 'tick' }, at, { content: w.content, players: w.players, media: w.media });
    if (out.changed) {
      w.game = out.game;
      w.totals = out.totals;
    }
    w.now = at;
    return out;
  };
  const countdown = (w: World, at: number) => buildAdminView(w.snap(), at).finaleVideoIn;

  it('exactly +5 s, once, whatever the auto-advance / autopilot settings; the admin sees the countdown', () => {
    for (const [autopilot, finalStepS] of [[true, null], [false, null], [false, 3], [false, 12], [true, 12]] as const) {
      const w = new World(mkContent({ autopilot, autoAdvance: { revealToBoardS: null, boardToNextS: null, finalStepS } }));
      const m = toMosaic(w);
      const rev = w.game.phaseRev;
      expect(w.deadline()).toBe(m + FINALE.autoMs);
      expect(countdown(w, m)).toEqual({ ms: 5_000, at: m + 5_000, held: false });
      expect(countdown(w, m + 1_200)).toEqual({ ms: 3_800, at: m + 5_000, held: false });
      expect(buildAdminView(w.snap(), m + 1_200).autopilot).toEqual({ on: autopilot, next: { kind: 'step', n: 6, ms: 3_800, at: m + 5_000, held: false } });
      expect(heroAction(buildAdminView(w.snap(), m + 1_200))).toMatchObject(
        autopilot ? { label: 'Финальное видео через 4 с', cmd: { type: 'advance' } } : { label: '▶ Финальное видео', sub: 'само начнётся через 4 с' },
      );
      expect(tick(w, m + FINALE.autoMs - 1).changed).toBe(false);
      expect(w.game.final?.step).toBe(5);
      expect(tick(w, m + FINALE.autoMs).changed).toBe(true);
      expect(w.game.final?.step).toBe(6);
      expect(w.game.phaseRev).toBe(rev + 1);
      expect(w.game.final?.video).toEqual({ at: m + FINALE.autoMs + FINALE.leadMs, ms: FINALE.builtin.ms, w: 464, h: 848 });
      // a second host's tick (the transaction re-read the new state) finds nothing to do
      expect(tick(w, m + FINALE.autoMs).changed).toBe(false);
      expect(tick(w, m + 10 * 60_000).changed).toBe(false);
      expect(w.game.phaseRev).toBe(rev + 1);
      expect(w.deadline()).toBeNull();
      expect(countdown(w, w.now)).toBeNull();
      // a late «▶ Финальное видео» from before the switch: stale, nothing moves
      expect(w.cmd({ type: 'advance', phaseRev: rev }).ok).toBe(false);
      // TV only: phones get the clock and a poster, never the video
      const ph = w.phone('a', m + FINALE.autoMs + FINALE.leadMs + 1_000);
      expect(ph.finale?.stage).toBe('play');
      expect(ph.finale).not.toHaveProperty('videoId');
      expect(ph.media).toEqual([]);
    }
  });

  it('no countdown before the mosaic; an uploaded video starts the same way', () => {
    const w = new World(mkContent({ finaleVideo: 'custom', finaleMediaId: 'vid' }), CUSTOM);
    w.toFinalStep(4);
    expect(countdown(w, w.now)).toBeNull();
    const m = w.now + 3_000;
    w.advance(m);
    expect(w.deadline()).toBe(m + FINALE.autoMs);
    w.until(m + FINALE.autoMs);
    expect(w.game.final?.video).toMatchObject({ at: m + FINALE.autoMs + FINALE.leadMs, id: 'vid' });
  });

  it('«▶ Финальное видео» / TV Space earlier wins; the countdown never fires after it', () => {
    const w = new World();
    const m = toMosaic(w);
    expect(w.advance(m + 2_000).ok).toBe(true);
    const rev = w.game.phaseRev;
    expect(w.game.final?.video?.at).toBe(m + 2_000 + FINALE.leadMs);
    expect(w.deadline()).toBeNull();
    expect(tick(w, m + FINALE.autoMs).changed).toBe(false);
    w.until(m + 10 * 60_000);
    expect(w.game.phaseRev).toBe(rev);
    expect(w.game.final?.video?.at).toBe(m + 2_000 + FINALE.leadMs);
  });

  it('«стоп-экран» freezes the countdown; released, the rest of the 5 s runs', () => {
    const w = new World();
    const m = toMosaic(w);
    w.cmd({ type: 'hold', phaseRev: w.game.phaseRev, text: '🎂 Торт!' }, m + 2_000);
    expect(w.game.pause).toMatchObject({ reason: 'hold', remainingMs: 3_000 });
    expect(w.deadline()).toBeNull();
    expect(countdown(w, m + 40_000)).toEqual({ ms: 3_000, at: null, held: true });
    const held = buildAdminView(w.snap(), m + 4_000);
    expect(held.autopilot.next).toEqual({ kind: 'step', n: 6, ms: 3_000, at: null, held: true });
    expect(heroAction(held)).toMatchObject({ label: 'Финальное видео через 3 с', sub: 'стоп-экран: отсчёт стоит' });
    expect(heroAction({ ...held, autopilot: { ...held.autopilot, on: false } }).sub).toBe('стоп-экран: отсчёт до видео стоит');
    w.until(m + 60_000);
    expect(tick(w, m + 60_000).changed).toBe(false);
    expect(w.game.final?.step).toBe(5);
    // a new text keeps the time left
    w.cmd({ type: 'hold', phaseRev: w.game.phaseRev, text: 'Все сюда!' }, m + 30_000);
    expect(w.game.pause).toMatchObject({ remainingMs: 3_000 });

    w.cmd({ type: 'unhold' }, m + 60_000);
    expect(w.deadline()).toBe(m + 63_000);
    expect(countdown(w, m + 61_000)).toEqual({ ms: 2_000, at: m + 63_000, held: false });
    // held again 1 s later, released after a minute: 2 s left
    w.cmd({ type: 'hold', phaseRev: w.game.phaseRev, text: '🎂' }, m + 61_000);
    expect(w.game.pause).toMatchObject({ remainingMs: 2_000 });
    w.cmd({ type: 'unhold' }, m + 121_000);
    expect(w.deadline()).toBe(m + 123_000);
    w.until(m + 122_999);
    expect(w.game.final?.step).toBe(5);
    w.until(m + 123_000);
    expect(w.game.final?.step).toBe(6);
    expect(w.game.final?.video?.at).toBe(m + 123_000 + FINALE.leadMs);
  });

  it('«Не показывать»: no countdown, no transition (switched off mid-countdown too)', () => {
    const off = new World(mkContent({ finaleVideo: 'off', autoAdvance: { revealToBoardS: null, boardToNextS: null, finalStepS: 5 } }));
    const m = toMosaic(off);
    expect(off.deadline()).toBeNull();
    expect(countdown(off, m + 1_000)).toBeNull();
    expect(tick(off, m + 10 * 60_000).changed).toBe(false);
    expect(off.game.final?.step).toBe(5);

    const w = new World();
    const m2 = toMosaic(w);
    w.content = mkContent({ finaleVideo: 'off' });
    expect(w.deadline()).toBeNull();
    expect(tick(w, m2 + FINALE.autoMs).changed).toBe(false);
    expect(w.game.final?.step).toBe(5);
  });

  it('a restarted host / a lease takeover keeps the moment: it comes from the stored docs', () => {
    const w = new World();
    const m = toMosaic(w);
    // the TV reloads 2 s in: a fresh host with only what Firestore gives back
    const fresh = new World();
    fresh.game = JSON.parse(JSON.stringify(w.game)) as GameDoc;
    fresh.totals = JSON.parse(JSON.stringify(w.totals)) as TotalsDoc;
    fresh.now = m + 2_000;
    expect(fresh.deadline()).toBe(m + FINALE.autoMs);
    expect(countdown(fresh, m + 2_000)).toMatchObject({ ms: 3_000 });
    fresh.until(m + FINALE.autoMs);
    expect(fresh.game.final?.video?.at).toBe(m + FINALE.autoMs + FINALE.leadMs);

    // nobody held the lease at the moment (the admin page takes over 7 s late): it starts at once, once
    const late = new World();
    late.game = JSON.parse(JSON.stringify(w.game)) as GameDoc;
    late.totals = JSON.parse(JSON.stringify(w.totals)) as TotalsDoc;
    expect(countdown(late, m + 12_000)).toEqual({ ms: 0, at: m + FINALE.autoMs, held: false });
    expect(tick(late, m + 12_000).changed).toBe(true);
    expect(late.game.final?.video?.at).toBe(m + 12_000 + FINALE.leadMs);
    expect(tick(late, m + 12_000).changed).toBe(false);
  });
});

describe('«Прогнать игру» plays the video after the final', () => {
  const content = (s: Partial<Settings> = {}) => ({ rev: 1, settings: { ...defaultSettings(), ...s }, questions: [Q1] });

  it('the mosaic, then step 6 for the whole video and a while of the mosaic after it', () => {
    const tl = simulate({ content: content() });
    const last = tl.frames[tl.frames.length - 1]!;
    expect(last.game.final?.step).toBe(6);
    const v = last.game.final!.video!;
    const mosaic = tl.frames.find((f) => f.game.final?.step === 5)!;
    // the host starts it 5 s after «С днём рождения» came on, like the night
    expect(last.at - mosaic.at).toBe(FINALE.autoMs);
    expect(v.at).toBe(last.at + FINALE.leadMs);
    expect(tl.end).toBe(v.at + v.ms + 9_000);
  });

  it('the host starts it 5 s after the mosaic (with the autopilot switched off in the draft too)', () => {
    const tl = simulate({ content: content({ autopilot: false }) });
    const mosaic = tl.frames.find((f) => f.game.final?.step === 5)!;
    const video = tl.frames.find((f) => f.game.final?.step === 6)!;
    expect(video.at - mosaic.at).toBe(FINALE.autoMs);
    expect(video.game.final?.video?.at).toBe(mosaic.at + FINALE.autoMs + FINALE.leadMs);
  });

  it('without it the show ends at the mosaic', () => {
    const tl = simulate({ content: content({ finaleVideo: 'off' }) });
    const last = tl.frames[tl.frames.length - 1]!;
    expect(last.game.final?.step).toBe(5);
    expect(last.game.final?.video).toBeUndefined();
    expect(tl.end).toBe(last.at + 10_000);
  });

  it('an uploaded video plays for its own length', () => {
    const tl = simulate({ content: content({ finaleVideo: 'custom', finaleMediaId: 'vid' }), media: CUSTOM });
    const v = tl.frames[tl.frames.length - 1]!.game.final!.video!;
    expect(v).toMatchObject({ id: 'vid', ms: 21_500 });
    expect(tl.end).toBe(v.at + 21_500 + 9_000);
  });
});
