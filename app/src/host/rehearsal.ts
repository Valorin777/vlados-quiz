// «Прогнать игру»: the whole show on a virtual clock, for the organizer's rehearsal view
// (app/src/screens/admin/rehearsal). Pure and deterministic: the current content (settings +
// enabled questions in order + media index) goes through the REAL host logic — step() with
// commands, ticks and the video watch stage, so publicRound, the reveal scoring, the board, the
// final steps and the Vlados comparison are exactly what the night will produce — played by ~24
// fake guests whose answers are realistic (≈60 % right, varied speeds, number guesses spread around
// the answer, orderings partly right). One of them is Vlados, one is «Ты» (the phone on screen).
//
// The pace is the «Автопилот»'s (shared/engine/showTimings.ts), the very same deadlines the live
// host runs on: the simulated organizer only presses «Начать игру»; the answer → the board → the
// next question → every final step → the video after the final come from the host's own ticks.
// So what the organizer watches here is exactly what the night will do by itself.
//
// simulate() precomputes the timeline once (a few ms); a view at virtual time t is then
//   buildTvView(snapshotAt(tl, t), t)          — the TV
//   buildPlayerView(playerInputAt(tl, t), t)   — «Ты»'s phone
// Nothing here reads a clock, draws randomness or touches Firestore.

import { REACTIONS } from '@shared/defaults';
import type { EngineEvent } from '@shared/engine/reduce';
import { lastFinalStep } from '@shared/engine/finale';
import { surpriseLeadMs } from '@shared/engine/surprise';
import { WATCH } from '@shared/engine/watch';
import { FB_LIMITS, type AdminContentDoc, type AnswerDoc, type GameDoc, type PlayerDoc, type ReactionDoc, type ServerMs } from '@shared/fbtypes';
import { correctOrder } from '@shared/scoring';
import type { AnswerPayload, ChoiceQ, Id, NumberQ, OrderingQ, Question, QuestionType, Settings } from '@shared/types';
import { clamp, hashSeed, rng, shuffleNotIdentity } from '@shared/util';
import type { HostHealth, HostInput, HostSnapshot, MediaIndex, TotalsDoc } from './model';
import { emptyTotals, hostContent, hostDeadline, initialGameDoc, step, stripUndefined, type StepCtx } from './pure';
import type { MyAnswer, PlayerViewInput } from './views';

// ---------- Guests ----------

export const ME_UID = 'rh-me';
export const VLADOS_UID = 'rh-vlados';
export const ME_NAME = 'Ты';

const NAMES = [
  'Соня', 'Макс', 'Артём', 'Катя', 'Лёша', 'Дима', 'Оля', 'Серёга', 'Настя', 'Паша', 'Юля', 'Вова',
  'Лиза', 'Гоша', 'Маша', 'Костя', 'Аня', 'Миша', 'Женя', 'Даша', 'Рома', 'Вика', 'Никита', 'Полина',
  'Тёма', 'Кира', 'Гриша', 'Алина', 'Стас', 'Ира', 'Егор', 'Лена',
];

export interface RehearsalGuest {
  uid: string;
  name: string;
  seed: number;
  isVlados: boolean;
  isMe: boolean;
  /** Chance to know the right answer, 0..1 (≈0.6 on average). */
  skill: number;
  /** Typical share of the time limit an answer takes, 0..1. */
  pace: number;
}

/** `n` guests (at least 3): n − 2 friends, Vlados and «Ты». Deterministic for a seed. */
export function rehearsalGuests(n = 24, seed = 2609, vladosLabel = 'Владос'): RehearsalGuest[] {
  const R = rng(hashSeed(`guests:${seed}`));
  const friends = Math.max(1, Math.min(NAMES.length, n - 2));
  const names = NAMES.slice(0, friends);
  const out: RehearsalGuest[] = names.map((name, k) => ({
    uid: `rh-${k}`,
    name,
    seed: hashSeed(`${seed}:${name}:${k}`),
    isVlados: false,
    isMe: false,
    skill: 0.35 + R() * 0.5,
    pace: 0.1 + R() * 0.32,
  }));
  const vlados = (vladosLabel.trim() || 'Владос').slice(0, 20);
  out.splice(Math.min(3, out.length), 0, { uid: VLADOS_UID, name: vlados, seed: hashSeed(`${seed}:vlados`), isVlados: true, isMe: false, skill: 0.72, pace: 0.14 });
  out.splice(Math.min(9, out.length), 0, { uid: ME_UID, name: ME_NAME, seed: hashSeed(`${seed}:me`), isVlados: false, isMe: true, skill: 0.6, pace: 0.28 });
  return out;
}

// ---------- Options ----------

/** How «Ты» answers: auto = mostly right, every third question wrong. */
export type MyMode = 'auto' | 'right' | 'wrong' | 'none';

/** «Ты» tapped on the phone: this answer at this virtual time (null: explicitly no answer). */
export interface ManualAnswer {
  p: AnswerPayload;
  at: ServerMs;
}

/**
 * What is not the host's to decide (virtual ms). Everything from the first question on runs by the
 * «Автопилот» (shared/engine/showTimings.ts: SHOW), exactly like the night.
 */
export interface Pacing {
  /** The lobby on screen before the organizer presses «Начать игру». */
  lobbyMs: number;
  /** The last final step stays this long (the mosaic, when the video after the final is off). */
  endMs: number;
  /** After the video after the final: the mosaic stays this long. */
  finaleAfterMs: number;
  /** A question's video without a known duration is assumed to end after this long (the TV's report). */
  unknownVideoMs: number;
}

export const PACING: Pacing = {
  lobbyMs: 9_000,
  endMs: 10_000,
  finaleAfterMs: 9_000,
  unknownVideoMs: 15_000,
};

/**
 * When the TV starts the answer's video (ms into the reveal): the droplet out of the right answer
 * lands ~1.6 s after the scene calls for it (screens/tv/scenes/Reveal*.tsx: `revealMediaAt`, then
 * Emerge's flight), + ~0.3 s until the scene is up — choice ≈ 7.3 s + 1.9, number ≈ 5.5 s + 1.9,
 * ordering ≈ 4.2 s + 0.32 s per item + 1.9 (the E2E, 4 items: 7.4 s). The rehearsal's TV reports
 * the video's end then + its length, like the live TV.
 */
export function revealVideoStartMs(q: Question): number {
  if (q.type === 'choice') return 9_200;
  if (q.type === 'ordering') return 6_100 + 320 * q.items.length;
  return 7_400;
}

export interface RehearsalOptions {
  /** admin/content (the draft): settings + questions; disabled questions are not played. */
  content: { rev?: number; settings?: unknown; questions?: Question[] } | null;
  media?: MediaIndex;
  guests?: RehearsalGuest[];
  /** Avatars by uid (JPEG bytes). */
  faces?: Readonly<Record<string, { avatar?: Uint8Array; thumb?: Uint8Array }>>;
  me?: { mode?: MyMode; manual?: Readonly<Record<Id, ManualAnswer | null>> };
  seed?: number;
  /** Virtual time of the first frame (default: the lobby ends at settings.gameStartsAt). */
  t0?: ServerMs;
  pacing?: Partial<Pacing>;
}

// ---------- Timeline ----------

export interface Frame {
  at: ServerMs;
  game: GameDoc;
  totals: TotalsDoc;
}

export type Stage = 'lobby' | 'question' | 'answer' | 'board' | 'final';

export interface RehearsalRound {
  /** 0-based position in the show. */
  k: number;
  /** Public round index. */
  i: number;
  n: number;
  qid: Id;
  /** The frozen question, WITH its answer. */
  q: Question;
  type: QuestionType;
  /** The question's main media is a video (it had a watch stage). */
  video: boolean;
  /** A «Сюрприз» round: when its interrupt came (the breakdown, then the video); null otherwise. */
  surpriseAt: ServerMs | null;
  introAt: ServerMs;
  openAt: ServerMs;
  endsAt: ServerMs;
  lockedAt: ServerMs | null;
  revealAt: ServerMs | null;
  boardAt: ServerMs | null;
}

export interface RehearsalMark {
  at: ServerMs;
  stage: Stage;
  /** Round position (question stages). */
  k?: number;
  /** Final step (final stage). */
  step?: number;
}

export interface Timeline {
  gameId: string;
  t0: ServerMs;
  /** The show is over (the last final step — the mosaic, or the video after the final — has been on screen for a while). */
  end: ServerMs;
  frames: Frame[];
  players: Record<string, PlayerDoc>;
  /** Every answer of the game (all rounds), by arrival time. */
  answers: AnswerDoc[];
  reactions: (ReactionDoc & { id: string })[];
  rounds: RehearsalRound[];
  finalAt: ServerMs | null;
  marks: RehearsalMark[];
  content: AdminContentDoc;
  settings: Settings;
  media: MediaIndex;
  guests: RehearsalGuest[];
  meUid: string;
  vladosUid: string | null;
}

// ---------- Answers ----------

const decimals = (x: number): number => {
  const s = String(x);
  const e = s.match(/e-(\d+)$/);
  if (e) return Number(e[1]);
  return (s.split('.')[1] ?? '').length;
};

/** A number snapped to the question's step and range. */
function snapNumber(q: NumberQ, v: number): number {
  const stepV = q.step > 0 ? q.step : 1;
  let x = Math.round(v / stepV) * stepV;
  if (q.min !== undefined) x = Math.max(q.min, x);
  if (q.max !== undefined) x = Math.min(q.max, x);
  return Number(x.toFixed(Math.min(10, decimals(stepV))));
}

/** ≈ N(0, 1) from three uniforms. */
const gauss = (R: () => number): number => (R() + R() + R() - 1.5) * 2;

function guessChoice(q: ChoiceQ, skill: number, R: () => number): AnswerPayload {
  const know = R() < skill;
  const wrong = q.options.filter((o) => o.id !== q.correctId);
  if (know || !wrong.length) return { t: 'choice', id: q.correctId };
  // one wrong option is the popular trap (twice as likely as each other one)
  const w = R() * (wrong.length + 1);
  const pick = w < 2 ? wrong[0] : wrong[Math.min(wrong.length - 1, Math.floor(w) - 1)];
  return { t: 'choice', id: (pick ?? wrong[0])!.id };
}

function guessNumber(q: NumberQ, skill: number, R: () => number): AnswerPayload {
  const know = R() < skill;
  const tol = Math.max(0, q.tolerance);
  const span = Math.max(q.zeroAt - tol, q.step, 1e-9);
  const err = know ? (R() * 2 - 1) * tol : gauss(R) * (tol + span * 0.75);
  return { t: 'number', v: snapNumber(q, q.answer + err) };
}

function guessOrdering(q: OrderingQ, skill: number, R: () => number): AnswerPayload {
  const correct = correctOrder(q);
  const r0 = R();
  if (r0 < skill * 0.7 || correct.length < 2) return { t: 'ordering', ids: correct };
  if (r0 > 0.92) return { t: 'ordering', ids: shuffleNotIdentity(correct, R) };
  // partly right: one or two neighbours swapped
  const ids = correct.slice();
  const swaps = R() < 0.5 ? 1 : 2;
  for (let s = 0; s < swaps; s++) {
    const j = Math.floor(R() * (ids.length - 1));
    [ids[j], ids[j + 1]] = [ids[j + 1] as Id, ids[j] as Id];
  }
  if (ids.every((id, k) => id === correct[k])) [ids[0], ids[1]] = [ids[1] as Id, ids[0] as Id];
  return { t: 'ordering', ids };
}

/** A guest's answer to `q` with this skill. */
export function guessFor(q: Question, skill: number, R: () => number): AnswerPayload {
  switch (q.type) {
    case 'choice':
      return guessChoice(q, skill, R);
    case 'number':
      return guessNumber(q, skill, R);
    case 'ordering':
      return guessOrdering(q, skill, R);
  }
}

/** The right answer to `q`. */
export function rightAnswer(q: Question): AnswerPayload {
  switch (q.type) {
    case 'choice':
      return { t: 'choice', id: q.correctId };
    case 'number':
      return { t: 'number', v: q.answer };
    case 'ordering':
      return { t: 'ordering', ids: correctOrder(q) };
  }
}

/** A clearly wrong answer to `q` (a wrong option, a number ≥ zeroAt off, the order reversed). */
export function wrongAnswer(q: Question): AnswerPayload {
  switch (q.type) {
    case 'choice': {
      const w = q.options.find((o) => o.id !== q.correctId);
      return { t: 'choice', id: (w ?? q.options[0])?.id ?? q.correctId };
    }
    case 'number': {
      const off = Math.max(q.zeroAt, q.tolerance + q.step, q.step);
      const up = snapNumber(q, q.answer + off);
      const down = snapNumber(q, q.answer - off);
      return { t: 'number', v: Math.abs(up - q.answer) >= Math.abs(down - q.answer) ? up : down };
    }
    case 'ordering': {
      const ids = correctOrder(q).reverse();
      return { t: 'ordering', ids };
    }
  }
}

// ---------- Simulation ----------

const GAME_ID = 'rehearsal';
const SESSION = 'rehearsal';

/** Every other round everybody answers (the early «все ответили» lock); in the others a few guests (never Vlados) doze off. */
const everyoneAnswers = (k: number): boolean => k % 2 === 0;

export function simulate(o: RehearsalOptions): Timeline {
  const draft = hostContent(o.content);
  // the show as the «Автопилот» runs it (switched off, the organizer would press at these moments)
  const content = { ...draft, settings: { ...draft.settings, autopilot: true } };
  const settings = content.settings;
  const seed = o.seed ?? 2609;
  const pace: Pacing = { ...PACING, ...(o.pacing ?? {}) };
  const media = o.media ?? {};
  const guests = o.guests ?? rehearsalGuests(24, seed, settings.vladosLabel);
  const startsAt = Date.parse(settings.gameStartsAt);
  const t0 = o.t0 ?? (Number.isFinite(startsAt) ? startsAt - pace.lobbyMs : 1_800_000_000_000);

  // Join order: a third already in the lobby, the rest trickle in while it is on screen.
  const players: Record<string, PlayerDoc> = {};
  const early = Math.ceil(guests.length / 3);
  guests.forEach((g, k) => {
    const joinedAt = g.isMe || k < early ? t0 - (guests.length - k) * 1_500 : t0 + Math.round(((k - early + 1) / (guests.length - early + 1)) * pace.lobbyMs * 0.8);
    const face = o.faces?.[g.uid];
    players[g.uid] = {
      name: g.name,
      seed: g.seed,
      joinedAt,
      kicked: false,
      seenAt: joinedAt,
      ...(face?.avatar ? { avatar: face.avatar } : {}),
      ...(face?.thumb ? { thumb: face.thumb } : {}),
    };
  });
  const vladosUid = guests.find((g) => g.isVlados)?.uid ?? null;
  const meUid = guests.find((g) => g.isMe)?.uid ?? ME_UID;

  let game: GameDoc = initialGameDoc(settings);
  let totals: TotalsDoc = emptyTotals(t0);
  const frames: Frame[] = [];
  const answers: AnswerDoc[] = [];
  const planned = new Set<number>();
  const watched = new Set<number>();
  const surprised = new Set<number>();
  const revealed = new Set<number>();
  const ctx: StepCtx = { content, players, media, tv: true, shuffleSeed: hashSeed(`shuffle:${seed}`) };

  const input = (at: number): HostInput => {
    const i = game.round?.i;
    return { gameId: GAME_ID, game, totals, players, answers: i === undefined ? [] : answers.filter((a) => a.round === i && a.at <= at) };
  };
  const apply = (ev: EngineEvent, at: number): boolean => {
    const out = step(input(at), ev, at, ctx);
    if (!out.ok) return false;
    if (out.changed) {
      game = stripUndefined(out.game);
      totals = stripUndefined(out.totals);
      frames.push({ at, game, totals });
      refuseLate();
    }
    return true;
  };
  /**
   * The rules: a «Сюрприз» closed the answer window (endsAt pulled in to the interrupt) — the
   * answers planned for later never land (like the night: refused), only the ones on their way.
   */
  const refuseLate = (): void => {
    const r = game.round;
    if (game.phase !== 'locked' || !r || !game.next?.surprise) return;
    const last = r.endsAt + FB_LIMITS.answerLateMs;
    for (let k = answers.length - 1; k >= 0; k--) {
      const a = answers[k] as AnswerDoc;
      if (a.round === r.i && a.at > last) answers.splice(k, 1);
    }
  };

  frames.push({ at: t0, game, totals });
  if (vladosUid) apply({ t: 'cmd', cmd: { type: 'setVlados', id: vladosUid } }, t0);

  const myAnswer = (q: Question, k: number, openAt: number, endsAt: number): ManualAnswer | null => {
    const manual = o.me?.manual?.[q.id];
    if (manual !== undefined) return manual ? { p: manual.p, at: clamp(Math.round(manual.at), openAt, endsAt) } : null;
    const mode = o.me?.mode ?? 'auto';
    const how = mode === 'auto' ? (k % 3 === 1 ? 'wrong' : 'right') : mode;
    if (how === 'none') return null;
    const T = endsAt - openAt;
    let e = clamp(T * 0.3, Math.min(2_500, T / 2), Math.max(0, T - 600));
    // a «Сюрприз» round: «Ты» makes it before the interrupt (the others partly do not)
    const sp = totals.rounds.find((x) => x.qid === q.id && !x.res)?.surprise;
    if (sp) e = Math.max(600, Math.min(e, sp.afterMs - 1_500));
    return { p: how === 'right' ? rightAnswer(q) : wrongAnswer(q), at: openAt + Math.round(e) };
  };

  /** Everyone's answers to the round that just opened (openAt is final now: the watch stage is over). */
  const plan = (r: NonNullable<GameDoc['round']>): void => {
    const k = totals.rounds.findIndex((x) => x.i === r.i);
    const q = totals.rounds[k]?.q;
    if (!q) return;
    const T = r.endsAt - r.openAt;
    for (const g of guests) {
      if (g.isMe) {
        const m = myAnswer(q, k, r.openAt, r.endsAt);
        if (m) answers.push({ uid: g.uid, round: r.i, p: m.p, at: m.at });
        continue;
      }
      const R = rng(hashSeed(`${seed}:${g.uid}:${q.id}`));
      // Vlados (in the front row) always answers: the show's comparison needs him
      const miss = R() < 0.14 && !everyoneAnswers(k) && !g.isVlados;
      const u = R();
      const p = guessFor(q, g.skill, R);
      if (miss) continue;
      const e = clamp(T * g.pace * (0.55 + 0.9 * u), Math.min(1_100, T / 2), Math.max(0, T - 600));
      answers.push({ uid: g.uid, round: r.i, p, at: Math.round(r.openAt + e) });
    }
    answers.sort((a, b) => a.at - b.at || (a.uid < b.uid ? -1 : 1));
  };

  const lastStep = lastFinalStep(settings);
  /**
   * The organizer's only press: «Начать игру». The answer → the board → the next question → the
   * final steps → the video after the final are the host's own ticks (hostDeadline: the autopilot).
   */
  const press = (): { at: number; ev: EngineEvent } | null =>
    game.phase === 'lobby' ? { at: t0 + pace.lobbyMs, ev: { t: 'cmd', cmd: { type: 'start' } } } : null;
  /** The TV reports the end of the question's video (live: host command 'watchEnd'). */
  const watchEnd = (): number | null => {
    const r = game.round;
    const w = r?.media?.watchMs;
    if (game.phase !== 'intro' || !r || !w || game.pause || watched.has(r.i)) return null;
    const untilAt = r.openAt - WATCH.beatMs;
    const at = untilAt - w + Math.min(w, r.media?.videoMs ?? pace.unknownVideoMs);
    return at < untilAt ? at : null;
  };

  /** The TV reports the end of the «Сюрприз» video (live: host command 'surpriseEnd'). */
  const surpriseEnd = (): number | null => {
    const r = game.round;
    const sp = game.next?.surprise;
    if (game.phase !== 'locked' || !r || !sp || game.pause || surprised.has(r.i)) return null;
    return sp.at + surpriseLeadMs() + sp.ms;
  };

  /**
   * The TV reports the end of the answer's video (live: host command 'revealMediaEnd' — the
   * autopilot's board SHOW.revealVideoEndedMs later): it starts when the droplet out of the right
   * answer lands (revealVideoStartMs) and plays its length. Unknown length: nothing is reported (the
   * clock hold, like a live TV that never reports).
   */
  const revealEnd = (): number | null => {
    const r = game.round;
    if (game.phase !== 'reveal' || !r || game.pause || revealed.has(r.i)) return null;
    const pr = totals.rounds.find((x) => x.i === r.i);
    const rm = pr?.q.revealMedia;
    const m = rm ? media[rm.mediaId] : undefined;
    const d = m?.durationS;
    if (!pr || pr.surprise || !rm || m?.kind !== 'video' || typeof d !== 'number' || !Number.isFinite(d) || d <= 0) return null;
    return totals.phaseAt + revealVideoStartMs(pr.q) + Math.round(Math.max(1_000, (d - Math.max(0, rm.startAtS ?? 0)) * 1000));
  };

  let t = t0;
  let end = t0 + pace.lobbyMs;
  for (let guard = 0; guard < 20_000; guard++) {
    const r = game.round;
    if (game.phase === 'open' && r && !planned.has(r.i)) {
      planned.add(r.i);
      plan(r);
    }
    if (game.phase === 'final' && (game.final?.step ?? 0) >= lastStep) {
      // the video after the final plays to its end, then the mosaic stays a while
      const v = game.final?.video;
      end = v ? v.at + v.ms + pace.finaleAfterMs : totals.phaseAt + pace.endMs;
      break;
    }
    const due = hostDeadline(input(t), content);
    const pr = press();
    const we = watchEnd();
    const se = surpriseEnd();
    const re = revealEnd();
    const next = game.phase === 'open' && r ? answers.find((a) => a.round === r.i && a.at > t)?.at ?? null : null;
    const cands = [due, pr?.at ?? null, we, se, re, next].filter((x): x is number => x !== null);
    if (!cands.length) {
      end = t + pace.endMs;
      break;
    }
    t = Math.max(t, Math.min(...cands));
    if (due !== null && due <= t) {
      apply({ t: 'tick' }, t);
    } else if (we !== null && we <= t && r) {
      watched.add(r.i);
      apply({ t: 'watchEnd', phaseRev: game.phaseRev }, t);
    } else if (se !== null && se <= t && r) {
      surprised.add(r.i);
      apply({ t: 'surpriseEnd', phaseRev: game.phaseRev }, t);
    } else if (re !== null && re <= t && r) {
      revealed.add(r.i);
      apply({ t: 'revealMediaEnd', phaseRev: game.phaseRev }, t);
    } else if (pr && pr.at <= t) {
      if (!apply(pr.ev, t)) {
        // e.g. «Начать» with no enabled question: the show stays in the lobby
        end = t + pace.endMs;
        break;
      }
    }
    // else: an answer arrived — the all-answered deadline may have moved
  }

  const rounds = roundsOf(frames, totals);
  const finalFrame = frames.find((f) => f.game.phase === 'final');
  const finalAt = finalFrame?.at ?? null;
  const tl: Timeline = {
    gameId: GAME_ID,
    t0,
    end: Math.max(end, frames[frames.length - 1]?.at ?? t0),
    frames,
    players,
    answers,
    reactions: settings.reactions ? fakeReactions(frames, guests, seed) : [],
    rounds,
    finalAt,
    marks: [],
    content: { rev: content.rev, settings, questions: content.questions, trash: [] },
    settings,
    media,
    guests,
    meUid,
    vladosUid,
  };
  tl.marks = marksOf(tl);
  return tl;
}

function roundsOf(frames: readonly Frame[], totals: TotalsDoc): RehearsalRound[] {
  let n = 0;
  return totals.rounds.map((pr, k): RehearsalRound => {
    const board = frames.find((f) => f.game.phase === 'board' && f.game.round?.i === pr.i);
    const shown = pr.skipped ? n : ++n;
    return {
      k,
      i: pr.i,
      n: shown,
      qid: pr.qid,
      q: pr.q,
      type: pr.q.type,
      video: pr.watch !== undefined,
      surpriseAt: pr.surprise && pr.lockedAt !== undefined ? pr.lockedAt : null,
      introAt: pr.introAt,
      openAt: pr.openAt,
      endsAt: pr.endsAt,
      lockedAt: pr.lockedAt ?? null,
      revealAt: pr.revealedAt ?? null,
      boardAt: board?.at ?? null,
    };
  });
}

function marksOf(tl: Timeline): RehearsalMark[] {
  const out: RehearsalMark[] = [{ at: tl.t0, stage: 'lobby' }];
  for (const r of tl.rounds) {
    out.push({ at: r.introAt, stage: 'question', k: r.k });
    // → from the question: the interrupt (the breakdown); → again skips the long video to the answer
    if (r.surpriseAt !== null) out.push({ at: r.surpriseAt, stage: 'question', k: r.k });
    if (r.revealAt !== null) out.push({ at: r.revealAt, stage: 'answer', k: r.k });
    if (r.boardAt !== null) out.push({ at: r.boardAt, stage: 'board', k: r.k });
  }
  let last = -1;
  for (const f of tl.frames) {
    const s = f.game.phase === 'final' ? (f.game.final?.step ?? 0) : -1;
    if (s > last) {
      out.push({ at: f.at, stage: 'final', step: s });
      last = s;
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** A few reactions from the room: after each reveal, on the board and at the end of the final. */
function fakeReactions(frames: readonly Frame[], guests: readonly RehearsalGuest[], seed: number): (ReactionDoc & { id: string })[] {
  const out: (ReactionDoc & { id: string })[] = [];
  const who = guests.filter((g) => !g.isMe);
  if (!who.length) return out;
  const seen = new Set<string>();
  for (const f of frames) {
    const g = f.game;
    const key = g.phase === 'final' ? `final:${g.final?.step ?? 0}` : `${g.phase}:${g.round?.i ?? -1}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const burst = g.phase === 'reveal' ? 7 : g.phase === 'board' ? 3 : g.phase === 'final' && (g.final?.step ?? 0) >= 3 ? 9 : 0;
    const R = rng(hashSeed(`rx:${seed}:${key}`));
    for (let k = 0; k < burst; k++) {
      const guest = who[Math.floor(R() * who.length)] as RehearsalGuest;
      const at = Math.round(f.at + 900 + R() * 5_500);
      out.push({ id: `${guest.uid}_${at}_${k}`, uid: guest.uid, e: Math.floor(R() * REACTIONS.length), at });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// ---------- Reading the timeline ----------

/** Index of the frame on screen at `t` (the last one at or before it). */
export function frameIndexAt(tl: Timeline, t: number): number {
  const f = tl.frames;
  let lo = 0;
  let hi = f.length - 1;
  if (!f.length || t < (f[0] as Frame).at) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((f[mid] as Frame).at <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export const frameAt = (tl: Timeline, t: number): Frame => tl.frames[frameIndexAt(tl, t)] as Frame;

/** Guests who have joined by `t`. */
export function playersAt(tl: Timeline, t: number): Record<string, PlayerDoc> {
  const out: Record<string, PlayerDoc> = {};
  for (const [uid, p] of Object.entries(tl.players)) if (p.joinedAt <= t) out[uid] = p;
  return out;
}

/** The public doc at `t`: live answered / joined counts on top of the frame. */
function publicAt(f: Frame, players: Readonly<Record<string, PlayerDoc>>, answered: number): GameDoc {
  const live = f.game.phase === 'open' || f.game.phase === 'locked';
  return { ...f.game, players: Object.keys(players).length, answered: live ? answered : f.game.answered };
}

const HEALTH = (t: number): HostHealth => ({
  listeners: { game: 'live', totals: 'live', lease: 'live', players: 'live', answers: 'live', content: 'live', reactions: 'live' },
  clock: { offsetMs: 0, rttMs: 0, syncedAt: t },
  leader: true,
  lastTickAt: t,
  lastWriteAt: t,
  lastError: null,
  pending: 0,
  warnings: [],
});

/** What the TV's host sees at `t` (feed it to buildTvView / buildAdminView). */
export function snapshotAt(tl: Timeline, t: number): HostSnapshot {
  const f = frameAt(tl, t);
  const i = f.game.round?.i ?? null;
  const players = playersAt(tl, t);
  const answers = i === null ? [] : tl.answers.filter((a) => a.round === i && a.at <= t);
  return {
    gameId: tl.gameId,
    game: publicAt(f, players, answers.length),
    totals: f.totals,
    players,
    answers,
    answersRound: i,
    content: tl.content,
    media: tl.media,
    lease: { session: SESSION, until: t + 30_000, label: 'tv', preferred: true, uid: SESSION, at: t },
    reactions: tl.reactions.filter((r) => r.at <= t && r.at > t - 60_000),
    session: SESSION,
    label: SESSION,
    health: HEALTH(t),
  };
}

/** What a guest's phone knows at `t` (feed it to buildPlayerView). */
export function playerInputAt(tl: Timeline, t: number, uid: string = tl.meUid): PlayerViewInput {
  const idx = frameIndexAt(tl, t);
  const f = tl.frames[idx] as Frame;
  const players = playersAt(tl, t);
  const i = f.game.round?.i ?? null;
  const answered = i === null ? 0 : tl.answers.filter((a) => a.round === i && a.at <= t).length;
  const mine: Record<number, MyAnswer> = {};
  for (const a of tl.answers) if (a.uid === uid && a.at <= t) mine[a.round] = { round: a.round, p: a.p, status: 'accepted' };
  let lastScore: PlayerViewInput['lastScore'] = null;
  for (let k = 0; k <= idx; k++) {
    const g = (tl.frames[k] as Frame).game;
    const fin = g.final?.me?.[uid];
    if (fin) lastScore = { i: Number.MAX_SAFE_INTEGER, tot: fin.tot, rank: fin.rank };
    const m = g.reveal?.me[uid];
    if (g.reveal && m && (!lastScore || g.reveal.i >= lastScore.i)) lastScore = { i: g.reveal.i, tot: m.tot, rank: m.rank };
  }
  return {
    uid,
    gameId: tl.gameId,
    game: publicAt(f, players, answered),
    gameState: 'live',
    me: players[uid] ?? null,
    meLoaded: true,
    answers: mine,
    lastScore,
    reactionsSent: [],
  };
}

// ---------- Navigation ----------

export interface Position {
  stage: Stage;
  /** Round position for question stages. */
  k: number | null;
  /** Final step. */
  step: number | null;
}

export function positionAt(tl: Timeline, t: number): Position {
  if (tl.finalAt !== null && t >= tl.finalAt) return { stage: 'final', k: null, step: frameAt(tl, t).game.final?.step ?? 0 };
  for (let k = tl.rounds.length - 1; k >= 0; k--) {
    const r = tl.rounds[k] as RehearsalRound;
    if (t < r.introAt) continue;
    const stage: Stage = r.boardAt !== null && t >= r.boardAt ? 'board' : r.revealAt !== null && t >= r.revealAt ? 'answer' : 'question';
    return { stage, k, step: null };
  }
  return { stage: 'lobby', k: null, step: null };
}

/** Virtual time of a question's stage (or of a final step / the lobby), null when there is none. */
export function markAt(tl: Timeline, stage: Stage, k: number | null = null, stepN: number | null = null): number | null {
  if (stage === 'lobby') return tl.t0;
  if (stage === 'final') return tl.marks.find((m) => m.stage === 'final' && (stepN === null || m.step === stepN))?.at ?? null;
  const r = k === null ? undefined : tl.rounds[k];
  if (!r) return null;
  return stage === 'question' ? r.introAt : stage === 'answer' ? r.revealAt : r.boardAt;
}

/** The next mark after `t` (→ / «дальше»), or the end. */
export function nextMark(tl: Timeline, t: number): number {
  return tl.marks.find((m) => m.at > t + 50)?.at ?? tl.end;
}

/** The mark before `t` (← / «назад»): the current one's start unless it just began (1.5 s). */
export function prevMark(tl: Timeline, t: number): number {
  let best = tl.t0;
  for (const m of tl.marks) if (m.at < t - 1_500) best = m.at;
  return best;
}

/**
 * Where to be in a re-simulated timeline (another «Мой ответ», a tap, edited content): the same
 * stage of the same question, as far into it as before (never past its end). A tap or new faces
 * leave the past alone, so there it is the same time.
 */
export function remapTime(from: Timeline, to: Timeline, t: number): number {
  const pos = positionAt(from, t);
  const a = markAt(from, pos.stage, pos.k, pos.step) ?? from.t0;
  const b = markAt(to, pos.stage, pos.k, pos.step);
  if (b === null) return clamp(t, to.t0, to.end);
  const next = nextMark(to, b);
  return clamp(b + (t - a), to.t0, Math.max(b, next - 1));
}
