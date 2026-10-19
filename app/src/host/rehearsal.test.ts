// «Прогнать игру»: the precomputed show is the real host's show (step(), scoring, board, final,
// the video watch stage), deterministic, and the navigation helpers land where the chips say.

import { seedContent } from '@shared/defaults';
import { SHOW, revealAfterEndMs, revealHoldMs } from '@shared/engine/showTimings';
import { WATCH } from '@shared/engine/watch';
import type { ChoiceQ, Question } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { HOST_TIMING, type MediaIndex } from './model';
import { computeReveal, resultsOf } from './pure';
import {
  ME_UID,
  VLADOS_UID,
  frameAt,
  markAt,
  nextMark,
  playerInputAt,
  positionAt,
  prevMark,
  rehearsalGuests,
  remapTime,
  revealVideoStartMs,
  simulate,
  snapshotAt,
  type Timeline,
} from './rehearsal';
import { buildPlayerView, buildTvView } from './views';

const templates = () => {
  const c = seedContent();
  return { rev: c.rev, settings: c.settings, questions: c.questions };
};

const last = (tl: Timeline) => tl.frames[tl.frames.length - 1]!;

describe('rehearsal timeline', () => {
  const tl = simulate({ content: templates() });

  it('plays every template question in order, then the final to the video after it (step 6)', () => {
    expect(tl.rounds.map((r) => r.qid)).toEqual(['tpl-food', 'tpl-year', 'tpl-baby', 'tpl-life', 'tpl-coffee', 'tpl-wish']);
    expect(tl.rounds.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const r of tl.rounds) {
      expect(r.introAt).toBeLessThan(r.openAt);
      expect(r.lockedAt).not.toBeNull();
      expect(r.lockedAt!).toBeLessThanOrEqual(r.endsAt);
      // the reveal waits lockMs + the grace for late answers
      expect(r.revealAt! - r.lockedAt!).toBe(tl.settings.lockMs + HOST_TIMING.revealGraceMs);
      expect(r.boardAt!).toBeGreaterThan(r.revealAt!);
    }
    for (let k = 1; k < tl.rounds.length; k++) expect(tl.rounds[k]!.introAt).toBeGreaterThan(tl.rounds[k - 1]!.boardAt!);
    expect(last(tl).game.phase).toBe('final');
    expect(last(tl).game.final?.step).toBe(6);
    expect(tl.finalAt).toBeGreaterThan(tl.rounds[5]!.boardAt!);
    expect(tl.end).toBeGreaterThan(last(tl).at);
  });

  it('frames go forward in time and every round passes intro → open → locked → reveal → board', () => {
    for (let k = 1; k < tl.frames.length; k++) expect(tl.frames[k]!.at).toBeGreaterThanOrEqual(tl.frames[k - 1]!.at);
    for (const r of tl.rounds) {
      const phases = tl.frames.filter((f) => f.game.round?.i === r.i && f.game.phase !== 'final').map((f) => f.game.phase);
      expect([...new Set(phases)]).toEqual(['intro', 'open', 'locked', 'reveal', 'board']);
    }
  });

  it('is deterministic', () => {
    expect(JSON.stringify(simulate({ content: templates() }))).toBe(JSON.stringify(tl));
  });

  it('has ~24 guests, Vlados among them, and «Ты»', () => {
    expect(Object.keys(tl.players)).toHaveLength(24);
    expect(tl.vladosUid).toBe(VLADOS_UID);
    expect(last(tl).game.vladosUid).toBe(VLADOS_UID);
    expect(tl.players[ME_UID]?.name).toBe('Ты');
    expect(new Set(rehearsalGuests(24).map((g) => g.name)).size).toBe(24);
    // Vlados answers every question (the comparison is the point of the show)
    for (const r of tl.rounds) expect(tl.answers.some((a) => a.uid === VLADOS_UID && a.round === r.i)).toBe(true);
  });

  it('guests are right about 60 % of the time, at varied speeds', () => {
    let ok = 0;
    let all = 0;
    const times: number[] = [];
    for (const pr of last(tl).totals.rounds) {
      for (const [uid, x] of Object.entries(resultsOf(pr))) {
        if (uid === ME_UID || uid === VLADOS_UID) continue;
        all++;
        if (x.ok) ok++;
        times.push(x.e / (pr.q.timeLimitS * 1000));
      }
    }
    expect(ok / all).toBeGreaterThan(0.45);
    expect(ok / all).toBeLessThan(0.75);
    expect(Math.min(...times)).toBeLessThan(0.1);
    expect(Math.max(...times)).toBeGreaterThan(0.4);
  });

  it('number guesses spread around the answer, orderings partly right', () => {
    const year = tl.rounds.find((r) => r.qid === 'tpl-year')!;
    const vals = tl.answers.filter((a) => a.round === year.i && a.p.t === 'number').map((a) => (a.p.t === 'number' ? a.p.v : 0));
    expect(vals.some((v) => v < 2015)).toBe(true);
    expect(vals.some((v) => v > 2015)).toBe(true);
    expect(vals.every((v) => v >= 1995 && v <= 2026 && Number.isInteger(v))).toBe(true);
    const life = tl.frames.find((f) => f.game.phase === 'reveal' && f.game.round?.qid === 'tpl-life')!.game.reveal!;
    // dist keys: how many items were in the right place — more than just «all» and «none»
    expect(Object.keys(life.dist).filter((key) => (life.dist[key] ?? 0) > 0).length).toBeGreaterThanOrEqual(3);
  });

  it('every other question locks early because everybody answered', () => {
    const first = tl.rounds[0]!;
    expect(first.lockedAt!).toBeLessThan(first.endsAt);
    const second = tl.rounds[1]!;
    expect(second.lockedAt).toBe(second.endsAt);
  });

  it('scores exactly like the real reveal (computeReveal on the same answers)', () => {
    const totals = last(tl).totals;
    totals.rounds.forEach((pr, k) => {
      const revealFrame = tl.frames.find((f) => f.game.phase === 'reveal' && f.game.reveal?.i === pr.i)!;
      const answers = tl.answers.filter((a) => a.round === pr.i && a.at <= pr.lockedAt!);
      const ref = computeReveal({
        i: pr.i,
        q: pr.q,
        answers,
        players: tl.players,
        vladosUid: tl.vladosUid,
        scoring: tl.settings.scoring,
        openAt: pr.openAt,
        history: totals.rounds.slice(0, k),
      });
      expect(resultsOf(pr)).toEqual(ref.res);
      expect(revealFrame.game.reveal!.me).toEqual(ref.reveal.me);
      expect(revealFrame.game.reveal!.pct).toBe(ref.reveal.pct);
    });
    // the final's podium is the standings after the last round
    const lastRef = computeReveal({
      i: totals.rounds[5]!.i,
      q: totals.rounds[5]!.q,
      answers: tl.answers.filter((a) => a.round === totals.rounds[5]!.i),
      players: tl.players,
      vladosUid: tl.vladosUid,
      scoring: tl.settings.scoring,
      openAt: totals.rounds[5]!.openAt,
      history: totals.rounds.slice(0, 5),
    });
    expect(last(tl).game.final!.podium.map((p) => [p.uid, p.score])).toEqual(lastRef.podium.map((p) => [p.uid, p.score]));
    expect(last(tl).game.final!.vlados).toEqual(lastRef.vlados);
  });

  it('views at virtual times: the TV sees answers come in, the phone gets its verdict', () => {
    const r = tl.rounds[0]!;
    const early = buildTvView(snapshotAt(tl, r.openAt + 500), r.openAt + 500);
    const later = buildTvView(snapshotAt(tl, r.lockedAt! - 1), r.lockedAt! - 1);
    expect(early.phase).toBe('open');
    expect(early.counts.answered).toBeLessThan(later.counts.answered);
    expect(later.counts.answered).toBe(24);
    const lobby = buildTvView(snapshotAt(tl, tl.t0), tl.t0);
    expect(lobby.players.length).toBeLessThan(24);
    expect(buildTvView(snapshotAt(tl, r.introAt), r.introAt).players).toHaveLength(24);

    const q = buildPlayerView(playerInputAt(tl, r.openAt + 100), r.openAt + 100);
    expect(q.screen).toBe('question');
    expect(q.me?.name).toBe('Ты');
    const rv = buildPlayerView(playerInputAt(tl, r.revealAt! + 100), r.revealAt! + 100);
    expect(rv.screen).toBe('reveal');
    expect(rv.reveal?.verdict).toBe('correct'); // auto: right, wrong, right…
    const r2 = tl.rounds[1]!;
    expect(buildPlayerView(playerInputAt(tl, r2.revealAt! + 100), r2.revealAt! + 100).reveal?.verdict).toBe('wrong');
    const fin = buildPlayerView(playerInputAt(tl, tl.end - 1), tl.end - 1);
    expect(fin.screen).toBe('final');
    expect(fin.score?.rank).not.toBeNull();
  });
});

describe('«Мой ответ» and taps on the phone', () => {
  it('right / wrong / none', () => {
    const right = simulate({ content: templates(), me: { mode: 'right' } });
    const wrong = simulate({ content: templates(), me: { mode: 'wrong' } });
    const none = simulate({ content: templates(), me: { mode: 'none' } });
    for (const pr of last(right).totals.rounds) expect(resultsOf(pr)[ME_UID]?.ok).toBe(true);
    for (const pr of last(wrong).totals.rounds) expect(resultsOf(pr)[ME_UID]?.ok).toBe(false);
    for (const pr of last(none).totals.rounds) expect(resultsOf(pr)[ME_UID]).toBeUndefined();
    const r = none.rounds[0]!;
    // nobody locks early while «Ты» has not answered
    expect(r.lockedAt).toBe(r.endsAt);
    expect(buildPlayerView(playerInputAt(none, r.endsAt + 10), r.endsAt + 10).screen).toBe('time_up');
    expect(buildPlayerView(playerInputAt(none, r.revealAt! + 10), r.revealAt! + 10).reveal?.verdict).toBe('none');
  });

  it('a tap replaces the planned answer and leaves the past untouched', () => {
    const base = simulate({ content: templates(), me: { mode: 'none' } });
    const r = base.rounds[1]!;
    const q = r.q as Question;
    const at = r.openAt + 3_000;
    const tapped = simulate({ content: templates(), me: { mode: 'none', manual: { [q.id]: { p: { t: 'number', v: 2015 }, at } } } });
    const mine = tapped.answers.find((a) => a.uid === ME_UID && a.round === r.i);
    expect(mine).toEqual({ uid: ME_UID, round: r.i, p: { t: 'number', v: 2015 }, at });
    // everything before the tap is the same show
    const before = (tl: Timeline) => tl.frames.filter((f) => f.at < at).map((f) => [f.at, f.game.phase, f.game.phaseRev]);
    expect(before(tapped)).toEqual(before(base));
    expect(resultsOf(last(tapped).totals.rounds[1]!)[ME_UID]?.ok).toBe(true);
  });
});

describe('navigation', () => {
  const tl = simulate({ content: templates() });

  it('each chip lands on its stage', () => {
    for (const r of tl.rounds) {
      for (const stage of ['question', 'answer', 'board'] as const) {
        const t = markAt(tl, stage, r.k)!;
        expect(positionAt(tl, t)).toEqual({ stage, k: r.k, step: null });
      }
    }
    expect(positionAt(tl, tl.t0)).toEqual({ stage: 'lobby', k: null, step: null });
    for (let s = 0; s <= 5; s++) expect(positionAt(tl, markAt(tl, 'final', null, s)!)).toEqual({ stage: 'final', k: null, step: s });
    expect(frameAt(tl, markAt(tl, 'answer', 3)!).game.phase).toBe('reveal');
    expect(frameAt(tl, markAt(tl, 'board', 3)!).game.phase).toBe('board');
  });

  it('a re-simulated show keeps the place: same question, same stage', () => {
    const wrong = simulate({ content: templates(), me: { mode: 'wrong' } });
    const t = markAt(tl, 'answer', 4)! + 2_000;
    const t2 = remapTime(tl, wrong, t);
    expect(positionAt(wrong, t2)).toEqual({ stage: 'answer', k: 4, step: null });
    expect(t2 - markAt(wrong, 'answer', 4)!).toBe(2_000);
    expect(buildPlayerView(playerInputAt(wrong, t2), t2).reveal?.verdict).toBe('wrong');
    // same show (a tap later on, new faces): same time
    expect(remapTime(tl, simulate({ content: templates() }), t)).toBe(t);
    // a question that is gone: stay inside the new show
    const c = seedContent();
    const shorter = simulate({ content: { settings: c.settings, questions: c.questions.slice(0, 2) } });
    const t3 = remapTime(tl, shorter, t);
    expect(t3).toBeGreaterThanOrEqual(shorter.t0);
    expect(t3).toBeLessThanOrEqual(shorter.end);
  });

  it('prev / next walk the marks', () => {
    const q2 = markAt(tl, 'question', 2)!;
    expect(nextMark(tl, q2)).toBe(markAt(tl, 'answer', 2));
    expect(prevMark(tl, q2 + 500)).toBe(markAt(tl, 'board', 1)); // just started → the previous one
    expect(prevMark(tl, q2 + 10_000)).toBe(q2); // well into it → its start
    expect(nextMark(tl, tl.end)).toBe(tl.end);
    expect(prevMark(tl, tl.t0)).toBe(tl.t0);
  });
});

describe('video questions and edge cases', () => {
  const video: ChoiceQ = {
    id: 'vid',
    type: 'choice',
    title: 'Что было в конце видео?',
    options: [
      { id: 'a', text: 'Торт' },
      { id: 'b', text: 'Салют' },
    ],
    correctId: 'b',
    media: { mediaId: 'm-video', onPhones: true },
    timeLimitS: 20,
    double: false,
  };
  const media: MediaIndex = { 'm-video': { kind: 'video', durationS: 12, posterId: 'm-poster' } };

  it('the watch stage: video on the TV, the TV reports its end, 3-2-1, then the options', () => {
    const c = seedContent();
    const tl = simulate({ content: { settings: c.settings, questions: [video] }, media });
    const r = tl.rounds[0]!;
    expect(r.video).toBe(true);
    // intro → the video (12 s) → reported ended → beat → answers
    expect(r.openAt - r.introAt).toBe(c.settings.introMs + 12_000 + WATCH.beatMs);
    const inVideo = r.introAt + c.settings.introMs + 1_000;
    const tv = buildTvView(snapshotAt(tl, inVideo), inVideo);
    expect(tv.watch?.stage).toBe('play');
    expect(tv.media).toContain('m-video');
    const phone = buildPlayerView(playerInputAt(tl, inVideo), inVideo);
    expect(phone.screen).toBe('intro');
    expect(phone.watch?.stage).toBe('play');
    expect(phone.media).not.toContain('m-video');
    const beat = r.openAt - 1_000;
    expect(buildTvView(snapshotAt(tl, beat), beat).watch?.stage).toBe('beat');
    // nobody answers before the options are there
    expect(tl.answers.filter((a) => a.round === r.i).every((a) => a.at >= r.openAt)).toBe(true);
  });

  it('a reveal with a video stays up until the video has played (it comes after the right answer)', () => {
    const c = seedContent();
    const withReveal: ChoiceQ = { ...video, id: 'rv', media: undefined, revealMedia: { mediaId: 'm-rvideo', onPhones: true }, revealText: 'Вот так!' } as ChoiceQ;
    const rmedia: MediaIndex = { ...media, 'm-rvideo': { kind: 'video', durationS: 7, posterId: 'm-rposter', w: 464, h: 848 } };
    const tl = simulate({ content: { settings: c.settings, questions: [withReveal, { ...withReveal, id: 'plain', revealMedia: undefined }] }, media: rmedia });
    const [a, b] = tl.rounds;
    // like live: the TV reports the video's end (the droplet lands, then 7 s) → the board 2 s later,
    // before the clock hold (the fallback of a TV that never reports)
    const ended = revealVideoStartMs(withReveal) + 7_000;
    expect(a!.boardAt! - a!.revealAt!).toBe(ended + SHOW.revealVideoEndedMs);
    expect(a!.boardAt! - a!.revealAt!).toBe(revealAfterEndMs(revealHoldMs(withReveal, rmedia), ended));
    expect(a!.boardAt! - a!.revealAt!).toBeLessThan(revealHoldMs(withReveal, rmedia));
    expect(last(tl).totals.rounds[0]!.revealEndMs).toBe(ended);
    // unknown length: nothing reported, the clock hold
    const unknown = simulate({ content: { settings: c.settings, questions: [withReveal] }, media: { ...rmedia, 'm-rvideo': { kind: 'video', posterId: 'm-rposter' } } });
    expect(unknown.rounds[0]!.boardAt! - unknown.rounds[0]!.revealAt!).toBe(SHOW.revealVideoLeadMs + SHOW.revealVideoUnknownMs + SHOW.revealVideoTailMs);
    // no picture, a text after the answer: time to read it
    expect(b!.boardAt! - b!.revealAt!).toBe(SHOW.revealTextMs);
    // the TV gets the reveal video (with its size), the phone its poster
    const at = a!.revealAt! + 1_000;
    expect(buildTvView(snapshotAt(tl, at), at).reveal?.media).toMatchObject({ mediaId: 'm-rvideo', kind: 'video', posterId: 'm-rposter', w: 464, h: 848 });
    expect(buildPlayerView(playerInputAt(tl, at), at).reveal?.media).toMatchObject({ kind: 'video', posterId: 'm-rposter' });
    // a photo stays long enough to be seen; unknown video length: the fallback
    const rm = { revealMedia: { mediaId: 'x', onPhones: true } };
    expect(revealHoldMs(rm, { x: { kind: 'image' } })).toBe(SHOW.revealPictureMs);
    expect(revealHoldMs(rm, { x: { kind: 'video' } })).toBe(SHOW.revealVideoLeadMs + SHOW.revealVideoUnknownMs + SHOW.revealVideoTailMs);
  });

  it('no enabled question: the show stays in the lobby', () => {
    const c = seedContent();
    const tl = simulate({ content: { settings: c.settings, questions: c.questions.map((q) => ({ ...q, disabled: true })) } });
    expect(tl.rounds).toHaveLength(0);
    expect(tl.frames.every((f) => f.game.phase === 'lobby')).toBe(true);
    expect(tl.end).toBeGreaterThan(tl.t0);
  });

  it('disabled questions are skipped, the order is kept', () => {
    const c = seedContent();
    const questions = c.questions.map((q, k) => (k === 1 || k === 4 ? { ...q, disabled: true } : q));
    const tl = simulate({ content: { settings: c.settings, questions } });
    expect(tl.rounds.map((r) => r.qid)).toEqual(['tpl-food', 'tpl-baby', 'tpl-life', 'tpl-wish']);
    expect(frameAt(tl, tl.rounds[0]!.introAt).game.round?.total).toBe(4);
  });
});
