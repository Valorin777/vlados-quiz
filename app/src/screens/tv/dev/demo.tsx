// DEV/demo: every TV scene from fixtures, no Firebase (`#/tv?env=dev&demo=reveal-choice`;
// `demo=all` starts at the lobby). Space / → next scene, ← previous, R replays, S toggles the
// «стоп-экран» over the scene on screen. Used for design checks and screenshots of moments that
// are hard to hit live (reveals, the final, the video after the final: final-6 built-in clip,
// final-6-custom a 3 s test clip as the organizer's upload; surprise — the «Сюрприз»: the last
// question, 4 s later the breakdown, the black and the built-in video with sound, `&vms=<ms>` ends it
// early (the reveal comes then, as if «Досмотрели — к ответу»), surprise-end joins 8 s before the
// video's end → its 'ended' → the melt into the reveal).
// Sound: every scene starts behind «▶ Смотреть со звуком» (the click is what Safari needs — the
// same unlock as the real TV's «Начать шоу»: sound on, WebAudio resumed, the one <video> blessed);
// «Без звука» runs it muted. `&gate=0` skips it (and it is skipped under WebDriver unless `&gate=1`):
// then the first click / key unlocks the synth as before.
// Perf checks: `&n=90` guests, `&full=1` the lobby starts with everyone, `&rx=25` a storm of N
// reactions per second over any scene, `&auto=<ms>` moves to the next scene on its own (soak).

import { REACTIONS, defaultSettings, resolveTexts } from '@shared/defaults';
import { FINALE } from '@shared/engine/finale';
import { SURPRISE } from '@shared/engine/surprise';
import type { BoardRow, PodiumRow } from '@shared/fbtypes';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChromeButton, ChromeText, audio } from '../../../visual';
import type { QuestionView, TvAnswer, TvPlayer, TvView } from '../../../host';
import { mediaState, seedMediaUrl, startTvSound } from '../media';
import { soundBlocked, soundLog } from '../sound';
import { TvShow } from '../TvShow';
import { TvStage } from '../TvStage';
import { param, useMuted, useTvAppearance } from '../TvApp';
import { useIdleCursor } from '../useTv';
import { BOT_NAMES, fakeClip, fakePhoto, fakePictureFor, fakeSelfie } from './faces';

const SCENES = [
  'lobby',
  'intro',
  'intro-x2',
  'intro-media',
  'watch',
  'open-choice',
  'open-media',
  'open-portrait',
  'open-number',
  'open-ordering',
  'locked',
  'reveal-choice',
  'reveal-photo',
  'reveal-video',
  'reveal-number',
  'reveal-ordering',
  'board',
  'final-0',
  'final-1',
  'final-2',
  'final-3',
  'final-4',
  'final-5',
  'final-6',
  'final-6-custom',
  'surprise',
  'surprise-end',
  'pause',
  'hold',
  'hold-long',
] as const;
type SceneId = (typeof SCENES)[number];

const T0 = Date.now();

/** Scenes that need the recorded test clips (see faces.fakeClip). */
const VIDEO_SCENES: ReadonlySet<string> = new Set(['watch', 'reveal-video', 'final-6-custom']);

/** `&photo=900x1200` picks the proportions of the framing-check picture (open-portrait, reveal-photo). */
const PIC = `fx-pic-${/^\d+x\d+$/.test(param('photo') ?? '') ? param('photo') : '900x1200'}`;

function players(n: number, faces: Map<number, { avatar: Uint8Array; thumb: Uint8Array }>): TvPlayer[] {
  return Array.from({ length: n }, (_, i) => {
    const f = faces.get(i + 1);
    const p: TvPlayer = { uid: `u${i}`, name: BOT_NAMES[i % BOT_NAMES.length] ?? `Гость ${i}`, seed: i, joinedAt: T0 + i, answered: false, isVlados: i === 3, kicked: false };
    if (f && i % 9 !== 5) {
      p.avatar = f.avatar;
      p.thumb = f.thumb;
    }
    if (i === 3) p.name = 'Владос';
    return p;
  });
}

const choiceQ = (media: boolean, double = false): QuestionView => ({
  i: 2,
  n: 3,
  total: 12,
  qid: 'q-food',
  type: 'choice',
  title: media ? 'Где сделана эта фотография?' : 'Что Владос закажет, если ему дать выбрать любое блюдо?',
  double,
  timeLimitS: 30,
  options: [
    { id: 'a', text: media ? 'На Бали' : 'Шаурму с двойным сыром' },
    { id: 'b', text: media ? 'В Сочи' : 'Пасту карбонару' },
    { id: 'c', text: media ? 'На даче у бабушки' : 'Бабушкин борщ' },
    { id: 'd', text: media ? 'В Стамбуле' : 'Сет роллов на троих' },
  ],
  ...(media ? { media: { mediaId: 'demo-photo', kind: 'image' as const, onPhones: false } } : {}),
  introAt: T0,
  openAt: T0 + 4000,
  endsAt: T0 + 34_000,
});

const numberQ: QuestionView = {
  i: 4,
  n: 5,
  total: 12,
  qid: 'q-year',
  type: 'number',
  title: 'В каком году Владос впервые сел за руль?',
  double: false,
  timeLimitS: 30,
  number: { min: 1995, max: 2026, step: 1 },
  introAt: T0,
  openAt: T0,
  endsAt: T0 + 30_000,
};

const orderQ: QuestionView = {
  i: 6,
  n: 7,
  total: 12,
  qid: 'q-life',
  type: 'ordering',
  title: 'Расставь события жизни Владоса по порядку',
  double: true,
  timeLimitS: 45,
  items: [
    { id: 'l3', text: 'Устроился на первую работу' },
    { id: 'l1', text: 'Первый раз пошёл в школу' },
    { id: 'l4', text: 'Переехал в свою квартиру' },
    { id: 'l2', text: 'Получил права' },
  ],
  firstLabel: 'Раньше',
  lastLabel: 'Позже',
  introAt: T0,
  openAt: T0,
  endsAt: T0 + 45_000,
};

function demoBoard(ps: TvPlayer[]): BoardRow[] {
  const rows: BoardRow[] = ps
    .filter((p) => !p.isVlados)
    .slice(0, 10)
    .map((p, k) => ({ uid: p.uid, name: p.name, score: 0, rank: 0, prev: k + 1, delta: [120, 900, 0, 850, 300, 1000, 640, 0, 980, 400][k] ?? 0 }));
  rows.forEach((r, k) => (r.score = 9000 - k * 620 + (r.delta ?? 0)));
  rows.sort((x, y) => y.score - x.score).forEach((r, k) => (r.rank = k + 1));
  return rows;
}

/** `&photo=WxH` as the published pixel size (frames reserve their box before the picture decodes). */
function picSize(): { w: number; h: number } {
  const m = /^(\d+)x(\d+)$/.exec(PIC.slice('fx-pic-'.length));
  return m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 900, h: 1200 };
}

/**
 * The «Сюрприз» scenes: the last question, the interrupt `at`, the video (`ms` of it before the
 * reveal comes; the real length unless `&vms=`), the reveal once it ended (`endedAt`: the layer
 * reported 'ended').
 */
function surpriseScene(base: TvView, ps: TvPlayer[], started: number, now: number, end: boolean, endedAt: number | null): TvView {
  const lead = SURPRISE.glitchMs + SURPRISE.blackMs;
  const full = SURPRISE.builtin.ms;
  const vms = Number(param('vms') ?? NaN);
  const ms = Number.isFinite(vms) && vms > 0 ? Math.min(full, vms) : full;
  // surprise-end: the scene starts 8 s before the end of the video
  const at = end ? started - lead - (ms - 8_000) : started + 4_000;
  const q: QuestionView = {
    i: 11,
    n: 12,
    total: 12,
    qid: 'q-last',
    type: 'choice',
    title: 'Кто лучше всех поздравил Владоса?',
    double: true,
    timeLimitS: 30,
    options: [
      { id: 'a', text: 'Мама и папа' },
      { id: 'b', text: 'Одноклассники' },
      { id: 'c', text: 'Лучший друг' },
      { id: 'd', text: 'Бабушка' },
    ],
    introAt: at - 8_000,
    openAt: at - 4_000,
    endsAt: at + 26_000,
  };
  const videoAt = at + lead;
  const endAt = videoAt + ms;
  const revealAt = endedAt ?? endAt;
  const ids = ps.filter((_, i) => i % 3 !== 1).map((p) => p.uid);
  if (now >= revealAt) {
    const guests = ps.filter((p) => !p.isVlados);
    return {
      ...base,
      phase: 'reveal',
      phaseRev: 3,
      question: { ...q, endsAt: at },
      reveal: {
        i: q.i,
        correct: 'a',
        dist: { a: Math.round(guests.length * 0.4), b: 6, c: 9, d: 3 },
        pct: 0.4,
        count: guests.length,
        vlados: { t: 'choice', id: 'a' },
        text: 'Конечно, мама и папа — это было лучшее поздравление!',
        me: {},
        answers: [],
      },
    };
  }
  if (now < at) {
    const left = Math.max(0, q.endsAt - now);
    const shown = ids.slice(0, Math.floor(ids.length * Math.min(0.7, (now - q.openAt) / 9_000)));
    return {
      ...base,
      phase: 'open',
      phaseRev: 1,
      question: q,
      timer: { kind: 'answer', endsAt: q.endsAt, remainingMs: left, totalMs: 30_000, progress: 1 - left / 30_000, paused: false },
      answeredIds: shown,
      counts: { players: ps.length, answered: shown.length },
    };
  }
  const t = now;
  const stage = t < at + SURPRISE.glitchMs ? 'glitch' : t < videoAt ? 'black' : t < endAt + SURPRISE.tailMs ? 'play' : 'after';
  const answered = ids.slice(0, Math.floor(ids.length * 0.4));
  return {
    ...base,
    phase: 'locked',
    phaseRev: 2,
    question: { ...q, endsAt: at },
    timer: { kind: 'answer', endsAt: at, remainingMs: 0, totalMs: 4_000, progress: 1, paused: false },
    answeredIds: answered,
    counts: { players: ps.length, answered: answered.length },
    surprise: { stage, at, videoAt, endAt, sinceMs: Math.max(0, t - at), posMs: Math.max(0, Math.min(ms, t - videoAt)), videoMs: ms, videoId: null, posterId: null, w: SURPRISE.builtin.w, h: SURPRISE.builtin.h },
  };
}

function build(id: SceneId, ps: TvPlayer[], started: number, endedAt: number | null = null): TvView {
  const settings = defaultSettings();
  const texts = resolveTexts(settings);
  const now = Date.now();
  const base: TvView = {
    gameId: 'demo',
    phase: 'lobby',
    phaseRev: 1,
    now,
    online: true,
    pub: {
      title: settings.title,
      subtitle: settings.subtitle,
      texts,
      startsAt: Date.parse(settings.gameStartsAt),
      reactions: true,
      themeDefault: 'dark',
      vladosLabel: 'Владос',
    },
    texts,
    question: null,
    watch: null,
    timer: null,
    pause: null,
    hold: null,
    players: ps,
    counts: { players: ps.length, answered: 0 },
    answeredIds: [],
    reveal: null,
    board: null,
    final: null,
    finale: null,
    surprise: null,
    reactions: [],
    banner: null,
    vladosUid: 'u3',
    appearance: 'dark',
    sound: { sfx: true, music: false, volume: 0.8 },
    media: [],
    prefetch: [],
  };
  const answered = (share: number) => ps.filter((_, i) => i === 3 || ((i * 37) % 100) / 100 < share).map((p) => p.uid);
  const timer = (q: QuestionView, left: number) => ({ kind: 'answer' as const, endsAt: now + left, remainingMs: left, totalMs: q.timeLimitS * 1000, progress: 1 - left / (q.timeLimitS * 1000), paused: false });
  const answers = (q: QuestionView): TvAnswer[] =>
    ps.map((p, i) => {
      let pl: TvAnswer['p'];
      let ok = false;
      if (q.type === 'choice') {
        const id = ['a', 'b', 'c', 'd'][(i * 7) % 5 === 0 ? 3 : (i * 3) % 4 === 1 ? 0 : (i * 5) % 3] ?? 'a';
        pl = { t: 'choice', id };
        ok = id === 'a';
      } else if (q.type === 'number') {
        const v = 2015 + Math.round(Math.sin(i * 1.7) * 6 + Math.cos(i * 0.9) * 3);
        pl = { t: 'number', v };
        ok = Math.abs(v - 2015) <= 1;
      } else {
        const ids = i % 4 === 0 ? ['l1', 'l2', 'l3', 'l4'] : i % 3 === 0 ? ['l1', 'l3', 'l2', 'l4'] : ['l2', 'l1', 'l3', 'l4'];
        pl = { t: 'ordering', ids };
        ok = i % 4 === 0;
      }
      return { uid: p.uid, name: p.name, p: pl, e: 1800 + ((i * 733) % 14_000), pts: ok ? 700 : 0, ok, isVlados: p.isVlados };
    });
  const withQ = (q: QuestionView, phase: TvView['phase'], extra: Partial<TvView> = {}): TvView => ({ ...base, phase, question: q, ...extra });

  switch (id) {
    case 'lobby':
      return { ...base, players: param('full') ? ps : ps.slice(0, Math.min(ps.length, 6 + Math.floor((now - started) / 900))), banner: null };
    case 'intro':
    case 'intro-x2':
    case 'intro-media': {
      const q = id === 'intro-media' ? { ...choiceQ(true), media: { mediaId: PIC, kind: 'image' as const, onPhones: true, ...picSize() } } : choiceQ(false, id === 'intro-x2');
      // the intro hands over to the open question after 4 s, like the real show
      if (now - started > 4000) {
        const ids = answered(Math.min(0.8, (now - started - 4000) / 12_000));
        return withQ(q, 'open', { timer: timer(q, Math.max(0, 30_000 - (now - started - 4000))), answeredIds: ids, counts: { players: ps.length, answered: ids.length } });
      }
      return withQ(q, 'intro', { timer: { kind: 'intro', endsAt: started + 4000, remainingMs: Math.max(0, started + 4000 - now), totalMs: 4000, progress: 0, paused: false } });
    }
    case 'open-choice':
    case 'open-media':
    case 'locked': {
      const q = choiceQ(id === 'open-media');
      const ids = answered(id === 'locked' ? 0.9 : Math.min(0.85, (now - started) / 16_000));
      return withQ(q, id === 'locked' ? 'locked' : 'open', {
        timer: timer(q, id === 'locked' ? 0 : Math.max(0, 24_000 - (now - started))),
        answeredIds: ids,
        counts: { players: ps.length, answered: ids.length },
        banner: id === 'open-media' ? 'Торт через 10 минут — не расходимся! 🎂' : null,
      });
    }
    case 'open-portrait': {
      const q: QuestionView = { ...choiceQ(true), title: 'Какого цвета у Влада глаза?', media: { mediaId: PIC, kind: 'image', onPhones: true } };
      const ids = answered(Math.min(0.85, (now - started) / 16_000));
      return withQ(q, 'open', { timer: timer(q, Math.max(0, 24_000 - (now - started))), answeredIds: ids, counts: { players: ps.length, answered: ids.length } });
    }
    case 'open-number':
      return withQ(numberQ, 'open', { timer: timer(numberQ, 9000), answeredIds: answered(0.5), counts: { players: ps.length, answered: 20 } });
    case 'open-ordering':
      return withQ(orderQ, 'open', { timer: timer(orderQ, 31_000), answeredIds: answered(0.3), counts: { players: ps.length, answered: 12 } });
    case 'reveal-choice':
    case 'reveal-photo':
    case 'reveal-video': {
      const q = choiceQ(false);
      // `&advance=<ms>`: the host presses on to the board while the reveal video still plays
      const adv = Number(param('advance') ?? NaN);
      if (id === 'reveal-video' && Number.isFinite(adv) && now - started > adv) return withQ(q, 'board', { board: demoBoard(ps) });
      const a = answers(q);
      const guests = a.filter((x) => !x.isVlados);
      const dist: Record<string, number> = { a: 0, b: 0, c: 0, d: 0 };
      guests.forEach((x) => x.p.t === 'choice' && (dist[x.p.id] = (dist[x.p.id] ?? 0) + 1));
      return withQ(q, 'reveal', {
        reveal: {
          i: q.i,
          correct: 'a',
          dist,
          pct: (dist.a ?? 0) / guests.length,
          count: guests.length,
          vlados: { t: 'choice', id: 'c' },
          text: 'Конечно, шаурма! Проверено годами.',
          me: {},
          answers: a,
          ...(id === 'reveal-photo' ? { media: { mediaId: PIC, kind: 'image' as const, onPhones: true } } : {}),
          ...(id === 'reveal-video' ? { media: { mediaId: 'demo-rvideo', kind: 'video' as const, onPhones: true, posterId: 'demo-rvideo-poster', w: 464, h: 848 } } : {}),
        },
      });
    }
    case 'reveal-number': {
      const a = answers(numberQ);
      const best = Math.min(...a.filter((x) => !x.isVlados).map((x) => (x.p.t === 'number' ? Math.abs(x.p.v - 2015) : 99)));
      const me = Object.fromEntries(a.map((x) => [x.uid, { pts: 0, tot: 0, rank: 1, prev: null, ok: x.ok, ...(x.p.t === 'number' && Math.abs(x.p.v - 2015) === best && !x.isVlados ? { cl: true } : {}) }]));
      return withQ(numberQ, 'reveal', {
        reveal: { i: numberQ.i, correct: 2015, dist: {}, pct: 0.2, count: a.length - 1, vlados: { t: 'number', v: 2014 }, text: 'И с тех пор ни одного поцарапанного бампера (почти).', me, answers: a },
      });
    }
    case 'reveal-ordering': {
      const a = answers(orderQ);
      const guests = a.filter((x) => !x.isVlados);
      const dist: Record<string, number> = { '0': 2, '1': 5, '2': 11, '3': 0, '4': guests.filter((x) => x.ok).length };
      return withQ(orderQ, 'reveal', {
        reveal: { i: orderQ.i, correct: ['l1', 'l2', 'l3', 'l4'], dist, pct: 0.25, count: guests.length, vlados: { t: 'ordering', ids: ['l1', 'l2', 'l4', 'l3'] }, me: {}, answers: a },
      });
    }
    case 'board':
      return withQ(choiceQ(false), 'board', { board: demoBoard(ps) });
    case 'surprise':
    case 'surprise-end':
      return surpriseScene(base, ps, started, now, id === 'surprise-end', endedAt);
    case 'watch': {
      // a video question: 4 s title → the video (8 s here) → 3-2-1 → the answers with the full timer
      const W = 8_000 + 5_000;
      const t = now - started;
      const ended = Math.min(started + 4_000 + W, started + 12_000);
      const openAt = ended + 3_000;
      const q: QuestionView = {
        ...choiceQ(true),
        title: 'Что Владос сделал в конце этого видео?',
        media: { mediaId: 'demo-video', kind: 'video', onPhones: false, posterId: 'demo-photo', watchMs: W, videoMs: 8_000 },
        introAt: started,
        openAt,
        endsAt: openAt + 30_000,
      };
      if (now >= openAt) {
        const ids = answered(Math.min(0.8, (now - openAt) / 12_000));
        return withQ(q, 'open', { timer: timer(q, Math.max(0, openAt + 30_000 - now)), answeredIds: ids, counts: { players: ps.length, answered: ids.length } });
      }
      const startAt = started + 4_000;
      const stage = now >= ended ? 'beat' : t >= 4_000 ? 'play' : 'intro';
      const watch = { stage, startAt, posMs: Math.max(0, Math.min(W, now - startAt)), windowMs: W, videoMs: 8_000, untilAt: ended, openAt } as const;
      const toGo = stage === 'intro' ? startAt - now : openAt - now;
      return withQ(q, 'intro', {
        watch,
        timer: stage === 'play' ? null : { kind: 'intro', endsAt: now + toGo, remainingMs: toGo, totalMs: stage === 'intro' ? 4_000 : 3_000, progress: 0, paused: false },
      });
    }
    case 'pause': {
      const q = choiceQ(false);
      return withQ(q, 'open', { timer: { ...timer(q, 17_000), paused: true }, pause: { reason: 'admin', remainingMs: 17_000 }, answeredIds: answered(0.5) });
    }
    case 'hold':
    case 'hold-long': {
      // «стоп-экран» over an open question (the scene waits underneath, silent)
      const q = choiceQ(false);
      const text = id === 'hold' ? '🎂 Несём торт — небольшая пауза' : 'Сейчас будет видеопоздравление от мамы и папы Владоса — смотрим все вместе, телефоны можно отложить 💛';
      return withQ(q, 'open', {
        timer: { ...timer(q, 17_000), paused: true },
        pause: { reason: 'hold', remainingMs: 17_000 },
        hold: { text, at: started },
        banner: text,
        answeredIds: answered(0.5),
      });
    }
    default: {
      const step = Number(id.split('-')[1] ?? 0);
      // the video after the final: the step started at `started`, the video after the droplet
      const custom = id === 'final-6-custom';
      const startAt = started + FINALE.leadMs;
      const ms = custom ? 3_000 : FINALE.builtin.ms;
      const t = now;
      const finale =
        step >= 6
          ? {
              stage: t < startAt ? ('gather' as const) : t < startAt + ms + FINALE.tailMs ? ('play' as const) : ('after' as const),
              startAt,
              posMs: Math.max(0, Math.min(ms, t - startAt)),
              videoMs: ms,
              endAt: startAt + ms,
              videoId: custom ? 'demo-rvideo' : null,
              posterId: custom ? 'demo-rvideo-poster' : null,
              w: 464,
              h: 848,
            }
          : null;
      const pod: PodiumRow[] = [
        { uid: 'u0', rank: 1, name: ps[0]?.name ?? 'Соня', score: 11_820 },
        { uid: 'u1', rank: 2, name: ps[1]?.name ?? 'Макс', score: 10_330 },
        { uid: 'u2', rank: 3, name: ps[2]?.name ?? 'Артём', score: 9_810 },
      ].filter((r) => r.rank >= 4 - step);
      return {
        ...base,
        phase: 'final',
        final: {
          step,
          podium: pod,
          vlados: step >= 4 ? { uid: 'u3', name: 'Владос', vladosAccuracy: 0.58, guestsAccuracy: 0.66, best: { uid: 'u0', name: ps[0]?.name ?? 'Соня', accuracy: 0.92 }, verdict: 'worst' } : null,
          mosaic: step >= 5 ? ps : null,
          ...(finale ? { video: { at: startAt, ms, w: 464, h: 848, ...(custom ? { id: 'demo-rvideo', poster: 'demo-rvideo-poster' } : {}) } } : {}),
        },
        finale,
        media: finale ? ([finale.videoId, finale.posterId].filter(Boolean) as string[]) : [],
      };
    }
  }
}

const REACT_WINDOW_MS = 60_000;

/** `&rx=N`: N reactions per second from the crowd, the last minute of them (like the live view). */
function storm(ps: TvPlayer[], now: number): TvView['reactions'] {
  const rate = Number(param('rx') ?? 0);
  if (!(rate > 0) || !ps.length) return [];
  const last = Math.floor(((now - T0) * rate) / 1000);
  const first = Math.max(0, Math.floor(((now - REACT_WINDOW_MS - T0) * rate) / 1000));
  const out: TvView['reactions'] = [];
  for (let k = first; k <= last; k++) {
    const p = ps[(k * 7) % ps.length] as TvPlayer;
    const e = (k * 5) % REACTIONS.length;
    out.push({ id: `rx${k}`, e, emoji: REACTIONS[e] ?? '🔥', uid: p.uid, name: p.name, at: T0 + (k * 1000) / rate });
  }
  return out;
}

/** ask: the start button is up · sound / silent: the viewer chose · auto: no button (`&gate=0`, WebDriver). */
type SoundMode = 'ask' | 'sound' | 'silent' | 'auto';

const gated = (): boolean => param('gate') === '1' || (param('gate') !== '0' && !navigator.webdriver);

/** The demo's start: one click with sound (Safari lets the show's sound start only from a click). */
function SoundGate({ scene, onSound, onSilent }: { scene: string; onSound: () => void; onSilent: () => void }) {
  const btn = useRef<HTMLButtonElement | null>(null);
  useEffect(() => btn.current?.focus({ preventScroll: true }), []);
  return (
    <div className="tv-scene tv-gate">
      <div className="tg-col is-center">
        <p className="vx-kick">демо · {scene}</p>
        <ChromeText as="h1" className="tg-h">
          Сцена начнётся после нажатия
        </ChromeText>
        <ChromeButton ref={btn} size="l" variant="film" className="tg-go" onClick={onSound}>
          ▶ Смотреть со звуком
        </ChromeButton>
        <p className="tg-p">Браузер (Safari) включает звук только по клику — как «Начать шоу» на настоящем экране.</p>
        <ChromeButton variant="ghost" size="s" onClick={onSilent}>
          Без звука
        </ChromeButton>
      </div>
    </div>
  );
}

export function TvDemo({ which }: { which: string }) {
  const [mode, setMode] = useState<SoundMode>(() => (gated() ? 'ask' : 'auto'));
  const modeRef = useRef(mode);
  modeRef.current = mode;
  /** The test clips' recording, started by the start button's click (see makeClips). */
  const clipsLater = useRef<(() => void) | null>(null);
  const begin = (m: 'sound' | 'silent') => {
    // inside the click — exactly the real TV's «Начать шоу» for the sound
    if (m === 'sound') startTvSound();
    clipsLater.current?.();
    clipsLater.current = null;
    setMode(m);
    setStarted(Date.now());
  };
  const [idx, setIdx] = useState(() => Math.max(0, SCENES.indexOf(which as SceneId)));
  const [run, setRun] = useState(0);
  const [faces, setFaces] = useState<Map<number, { avatar: Uint8Array; thumb: Uint8Array }> | null>(null);
  const [clips, setClips] = useState(false);
  const sceneRef = useRef<string>(which);
  const [, tick] = useState(0);
  const [started, setStarted] = useState(Date.now());
  const [held, setHeld] = useState<number | null>(null);
  // the «Сюрприз» video ended on screen (the layer tells it like the live TV tells the host)
  const [endedAt, setEndedAt] = useState<number | null>(null);
  useEffect(() => setEndedAt(null), [started, idx, run]);
  const n = Number(param('n') ?? 48);
  const muted = useMuted();
  useTvAppearance(undefined);
  // the cursor (and the 🔊 button with it) hides after 3 s without the mouse, like the real TV
  useIdleCursor();

  useEffect(() => {
    seedMediaUrl('demo-photo', fakePhoto('ФОТО ВОПРОСА', 3));
    seedMediaUrl(PIC, fakePictureFor(PIC) ?? fakePhoto('ФОТО', 5));
    let alive = true;
    // the watch stage's clip (landscape, 6 s) and the reveal video (vertical 464×848, 3 s, a tone).
    // The tone is WebAudio: in Safari a context made before any click stays suspended and the
    // recording never ends — so with the start button they are recorded from its click.
    const makeClips = () =>
      void Promise.all([fakeClip(640, 360, 6_000, 'ВИДЕО ВОПРОСА', 330), fakeClip(464, 848, 3_000, 'ОТВЕТ', 523)]).then(([qv, rv]) => {
        if (qv) seedMediaUrl('demo-video', qv.url);
        if (rv) {
          seedMediaUrl('demo-rvideo', rv.url);
          seedMediaUrl('demo-rvideo-poster', rv.poster);
        }
        if (!alive) return;
        setClips(true);
        // a video scene waited for its clip: it starts now
        if (VIDEO_SCENES.has(sceneRef.current)) setStarted(Date.now());
      });
    if (modeRef.current === 'auto') makeClips();
    else clipsLater.current = makeClips;
    void (async () => {
      const m = new Map<number, { avatar: Uint8Array; thumb: Uint8Array }>();
      // 12 distinct faces are plenty for a demo crowd
      const uniq: { avatar: Uint8Array; thumb: Uint8Array }[] = [];
      for (let i = 1; i <= Math.min(12, n); i++) uniq.push(await fakeSelfie(i));
      for (let i = 1; i <= n; i++) m.set(i, uniq[(i - 1) % uniq.length] as { avatar: Uint8Array; thumb: Uint8Array });
      if (alive) {
        setFaces(m);
        setStarted(Date.now());
      }
    })();
    const id = setInterval(() => tick((x) => x + 1), 250);
    // no start button (`&gate=0`, automation): the first click unlocks the synth, as before
    const arm = () => {
      if (modeRef.current !== 'auto') return;
      audio.setDefaultMuted(false);
      audio.unlock();
    };
    addEventListener('pointerdown', arm, { once: true });
    // what the page plays right now (sound checks)
    (window as unknown as Record<string, unknown>).__tvSound = () => ({ mode: modeRef.current, ctx: audio.state, muted: audio.isMuted, blocked: soundBlocked(), log: [...soundLog], media: mediaState() });
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [n]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // the start button is up: its own keys (Enter / Space) press it, nothing else moves
      if (modeRef.current === 'ask') return;
      if (modeRef.current !== 'silent') audio.unlock();
      if (e.code === 'KeyS') {
        // «стоп-экран» over whatever is on screen (the scene keeps running underneath, frozen)
        e.preventDefault();
        setHeld((h) => (h === null ? Date.now() : null));
        return;
      }
      if (e.code === 'Space' || e.code === 'ArrowRight') setIdx((i) => (i + 1) % SCENES.length);
      else if (e.code === 'ArrowLeft') setIdx((i) => (i - 1 + SCENES.length) % SCENES.length);
      else if (e.code === 'KeyR') setRun((r) => r + 1);
      else return;
      e.preventDefault();
      setStarted(Date.now());
    };
    addEventListener('keydown', onKey);
    // `&auto=<ms>`: the next scene on its own (a soak through every scene)
    const auto = Number(param('auto') ?? 0);
    const t = auto > 0 ? setInterval(() => {
      if (modeRef.current === 'ask') return;
      setIdx((i) => (i + 1) % SCENES.length);
      setStarted(Date.now());
    }, auto) : 0;
    return () => {
      removeEventListener('keydown', onKey);
      clearInterval(t);
    };
  }, []);

  const ps = useMemo(() => (faces ? players(n, faces) : []), [faces, n]);
  const id = SCENES[idx] ?? 'lobby';
  sceneRef.current = id;
  const scene = mode !== 'ask' && faces && (clips || !VIDEO_SCENES.has(id)) ? build(id, ps, started, endedAt) : null;
  const built = scene && param('rx') ? { ...scene, reactions: storm(ps, scene.now) } : scene;
  const holdText = '🎂 Несём торт — небольшая пауза';
  const view = built && held !== null && !built.hold ? { ...built, hold: { text: holdText, at: held }, pause: { reason: 'hold' as const, remainingMs: 0 }, banner: holdText } : built;
  if (mode === 'ask') {
    return (
      <TvStage>
        <SoundGate scene={id} onSound={() => begin('sound')} onSilent={() => begin('silent')} />
      </TvStage>
    );
  }
  return (
    <TvStage>
      {view ? (
        <div key={`${id.startsWith('final-') && id !== 'final-6-custom' ? 'final' : id}-${run}`} style={{ display: 'contents' }}>
          <TvShow view={view} now={Date.now} muted={mode === 'silent' || muted} chip={<span>демо · {id}</span>} onSurpriseEnded={() => setEndedAt((t) => t ?? Date.now())} onSoundOn={() => setMode((m) => (m === 'silent' ? 'sound' : m))} />
        </div>
      ) : null}
    </TvStage>
  );
}
