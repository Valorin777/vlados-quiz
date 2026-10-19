// Pure host logic (docs/firebase.md → Host). No Firestore, no clock, no randomness: every function
// takes the documents and the server time it needs, so the same code runs in the TV, in an admin
// page, in Node bots and in tests.
//
// The state machine itself is shared/engine/reduce.ts (already tested). This module
//   1. turns the Firestore docs (games/{g} + private/totals + players + answers) into a GameState,
//   2. runs reduce() with a command or a tick,
//   3. projects the new GameState back into the public game doc and private/totals.
// Scoring uses SERVER times only: elapsed = answer.at − openAt, pauses excluded, clamped to [0, T].

import { defaultSettings, resolveTexts } from '@shared/defaults';
import { nextDeadline } from '@shared/engine/deadlines';
import { FINALE, finaleCustomId, finaleMsOf, finaleOn } from '@shared/engine/finale';
import { reduce, type EngineEvent } from '@shared/engine/reduce';
import {
  computeRoundResults,
  computeStandings,
  lastScoredIndex,
  standingsBefore,
  vladosComparison,
  type Standing,
} from '@shared/engine/results';
import { nextQuestion, shownOrder } from '@shared/engine/select';
import { SURPRISE, surpriseCustomId, surpriseRunning } from '@shared/engine/surprise';
import { openDelayMs, watchVideoMs, watchWindowMs, type WatchMedia } from '@shared/engine/watch';
import {
  FB_LIMITS,
  fbNameOk,
  type AnswerDoc,
  type BoardPub,
  type BoardRow,
  type FinalPub,
  type FinaleVideoPub,
  type FinalVlados,
  type GameDoc,
  type PausePub,
  type PlayerDoc,
  type PodiumRow,
  type PubInfo,
  type PubItem,
  type PubMedia,
  type RevealMe,
  type RevealPub,
  type RoundPub,
  type ServerMs,
  type SurprisePub,
} from '@shared/fbtypes';
import type { AdminCmd, CmdErr } from '@shared/protocol';
import { correctOrder, isPermutation, timeLimitMs } from '@shared/scoring';
import type {
  AnswerPayload,
  Content,
  GameState,
  Id,
  Item,
  MediaAsset,
  Phase,
  Player,
  QMedia,
  Question,
  Round,
  RoundResult,
  ScoringParams,
  Settings,
} from '@shared/types';
import { clamp, hashSeed, normalizeName } from '@shared/util';
import {
  HOST_TIMING,
  type HostInput,
  type LeaseDoc,
  type MediaIndex,
  type PauseRec,
  type PrivResult,
  type PrivResultRow,
  type PrivRound,
  type TotalsDoc,
} from './model';

// ---------- Content & settings ----------

/** admin/content as the host uses it (settings merged over defaults, so older docs keep working). */
export interface HostContent {
  rev: number;
  settings: Settings;
  questions: Question[];
}

type DeepPartialSettings = Partial<Omit<Settings, 'autoAdvance' | 'sound' | 'scoring'>> & {
  autoAdvance?: Partial<Settings['autoAdvance']>;
  sound?: Partial<Settings['sound']>;
  scoring?: Partial<Omit<ScoringParams, 'choice' | 'number' | 'ordering'>> & {
    choice?: Partial<ScoringParams['choice']>;
    number?: Partial<ScoringParams['number']>;
    ordering?: Partial<ScoringParams['ordering']>;
  };
};

export function normalizeSettings(s: DeepPartialSettings | null | undefined): Settings {
  const d = defaultSettings();
  if (!s) return d;
  const sc = s.scoring ?? {};
  return {
    ...d,
    ...(s as Partial<Settings>),
    texts: { ...(s.texts ?? {}) },
    autoAdvance: { ...d.autoAdvance, ...(s.autoAdvance ?? {}) },
    sound: { ...d.sound, ...(s.sound ?? {}) },
    scoring: {
      ...d.scoring,
      ...(sc as Partial<ScoringParams>),
      choice: { ...d.scoring.choice, ...(sc.choice ?? {}) },
      number: { ...d.scoring.number, ...(sc.number ?? {}) },
      ordering: { ...d.scoring.ordering, ...(sc.ordering ?? {}) },
    },
  };
}

export function hostContent(doc: { rev?: number; settings?: unknown; questions?: Question[] } | null | undefined): HostContent {
  return {
    rev: doc?.rev ?? 0,
    settings: normalizeSettings(doc?.settings as DeepPartialSettings | undefined),
    questions: doc?.questions ?? [],
  };
}

/** Settings the engine runs with: the reveal waits lockMs + the grace for the last answers. */
export const engineSettings = (s: Settings): Settings => ({ ...s, lockMs: s.lockMs + HOST_TIMING.revealGraceMs });

/** The media index as the engine's Content.media (kind + duration drive the watch stage). */
function engineMedia(media: MediaIndex): Record<Id, MediaAsset> {
  const out: Record<Id, MediaAsset> = {};
  for (const [id, m] of Object.entries(media)) {
    const a: MediaAsset = { id, kind: m.kind, files: { sm: '' }, w: 0, h: 0, bytes: 0, status: 'ready', cdn: 'live', createdAt: 0 };
    if (m.durationS !== undefined) a.durationS = m.durationS;
    out[id] = a;
  }
  return out;
}

/** `tv` false: no TV is on air — a video round starts with the short watch fallback (engine/watch.ts). */
const engineContent = (c: HostContent, media: MediaIndex = {}, tv = true): Content => ({
  rev: c.rev,
  settings: engineSettings(c.settings),
  questions: c.questions,
  trash: [],
  media: engineMedia(media),
  ...(tv ? {} : { tvOnAir: false }),
});

// ---------- Docs → engine state ----------

export const emptyTotals = (now: ServerMs, iBase = 0): TotalsDoc => ({ v: 1, rev: 0, phaseAt: now, iBase, rounds: [], updatedAt: now });

export function enginePlayers(docs: Readonly<Record<string, PlayerDoc>>, kicked: readonly string[] = []): Record<Id, Player> {
  const out: Record<Id, Player> = {};
  const kickedSet = new Set(kicked);
  for (const [uid, d] of Object.entries(docs)) {
    out[uid] = {
      id: uid,
      token: '',
      code: '',
      name: d.name,
      seed: d.seed,
      joinedAt: d.joinedAt,
      lastSeen: d.seenAt,
      // No presence in Firebase: everyone who joined counts until kicked (all-answered lock).
      online: true,
      kicked: d.kicked === true || kickedSet.has(uid),
    };
  }
  return out;
}

/**
 * Scoring time of an answer received by the server at `at`: time since openAt with every pause
 * taken out (an answer sent during a pause gets the frozen time), clamped to [0, limitMs].
 *
 * `r.openAt` is the CURRENT openAt, which each resume moved by that pause's `sh`; so an answer
 * given before a pause gets those shifts added back.
 */
export function serverElapsedMs(
  at: ServerMs,
  r: { openAt: ServerMs; pauses?: readonly PauseRec[] },
  ongoing: { at: ServerMs } | null,
  limitMs: number,
): number {
  let t = at;
  for (const p of r.pauses ?? []) if (at >= p.s && at < p.e) t = p.s;
  if (ongoing && at >= ongoing.at) t = ongoing.at;
  let el = t - r.openAt;
  for (const p of r.pauses ?? []) if (p.s >= t) el += p.sh;
  return Math.round(clamp(el, 0, Math.max(0, limitMs)));
}

const safePayload = (json: string): AnswerPayload => {
  try {
    const p = JSON.parse(json) as AnswerPayload;
    if (p && (p.t === 'choice' || p.t === 'number' || p.t === 'ordering')) return p;
  } catch {
    // fall through
  }
  return { t: 'choice', id: '' };
};

export const packResult = (x: PrivResult): PrivResultRow => [x.pt, x.ac, x.ok ? 1 : 0, x.cl === undefined ? -1 : x.cl ? 1 : 0, x.e, x.at, JSON.stringify(x.p)];

export function unpackResult(row: PrivResultRow): PrivResult {
  const [pt, ac, ok, cl, e, at, p] = row;
  const x: PrivResult = { p: safePayload(p), at, e, pt, ac, ok: ok === 1 };
  if (cl !== -1) x.cl = cl === 1;
  return x;
}

/** The decoded results of a revealed round ({} before the reveal). */
export function resultsOf(pr: Pick<PrivRound, 'res'>): Record<string, PrivResult> {
  const out: Record<string, PrivResult> = {};
  for (const [uid, row] of Object.entries(pr.res ?? {})) out[uid] = unpackResult(row);
  return out;
}

function privToRound(pr: PrivRound): Round {
  const r: Round = { qid: pr.qid, q: pr.q, introAt: pr.introAt, openAt: pr.openAt, endsAt: pr.endsAt, answers: {} };
  if (pr.shown) r.shown = [...pr.shown];
  if (pr.lockedAt !== undefined) r.lockedAt = pr.lockedAt;
  if (pr.revealedAt !== undefined) r.revealedAt = pr.revealedAt;
  if (pr.skipped) r.skipped = true;
  if (pr.surprise) r.surprise = { ...pr.surprise };
  if (typeof pr.revealHoldMs === 'number') r.revealHoldMs = pr.revealHoldMs;
  if (typeof pr.revealEndMs === 'number') r.revealEndMs = pr.revealEndMs;
  if (pr.res) {
    const results: Record<Id, RoundResult> = {};
    for (const [uid, x] of Object.entries(resultsOf(pr))) {
      r.answers[uid] = { p: x.p, elapsedMs: x.e, at: x.at, cid: '' };
      results[uid] = { points: x.pt, accuracy: x.ac, correct: x.ok, ...(x.cl !== undefined ? { closest: x.cl } : {}) };
    }
    r.results = results;
  }
  return r;
}

const pausePub = (p: PausePub | null | undefined): GameState['pause'] =>
  p ? { at: p.at, remainingMs: p.remainingMs, reason: p.reason } : null;

/**
 * Does an answer payload fit the frozen question? The rules only check its rough shape, so a guest
 * with devtools can store an unknown option id, a number outside [min, max] (or ±1e308), or an
 * "ordering" of maps/duplicates. Such answers are ignored: never scored, never in the histogram.
 */
export function answerFits(q: Question, p: AnswerPayload | null | undefined): boolean {
  if (!p || typeof p !== 'object') return false;
  switch (q.type) {
    case 'choice':
      return p.t === 'choice' && typeof p.id === 'string' && q.options.some((o) => o.id === p.id);
    case 'number':
      return (
        p.t === 'number' &&
        typeof p.v === 'number' &&
        Number.isFinite(p.v) &&
        (q.min === undefined || p.v >= q.min) &&
        (q.max === undefined || p.v <= q.max)
      );
    case 'ordering':
      return p.t === 'ordering' && Array.isArray(p.ids) && p.ids.every((id) => typeof id === 'string') && isPermutation(correctOrder(q), p.ids);
  }
}

/** The engine's GameState for these docs. Live answers are attached to the unrevealed round on air. */
export function toEngineState(inp: HostInput): GameState {
  const t = inp.totals ?? emptyTotals(0);
  const rounds = t.rounds.map(privToRound);
  const cur = rounds.length - 1;
  const live = rounds[cur];
  const pr = t.rounds[cur];
  const pause = pausePub(inp.game.pause);
  if (live && pr && !pr.res && !pr.skipped) {
    const T = timeLimitMs(pr.q);
    for (const a of inp.answers) {
      if (a.round !== pr.i || live.answers[a.uid] || !answerFits(pr.q, a.p)) continue;
      live.answers[a.uid] = { p: a.p, elapsedMs: serverElapsedMs(a.at, pr, pause, T), at: a.at, cid: '' };
    }
  }
  return {
    gameId: inp.gameId,
    rev: t.rev,
    phase: inp.game.phase,
    phaseRev: inp.game.phaseRev,
    phaseAt: t.phaseAt,
    players: enginePlayers(inp.players, inp.game.kicked),
    vladosId: inp.game.vladosUid ?? null,
    rounds,
    cur,
    pause,
    finalStep: inp.game.final?.step ?? 0,
    tvBanner: inp.game.banner ?? null,
    savedAt: 0,
  };
}

// ---------- Public question ----------

function pubMedia(qm: QMedia | undefined, media: MediaIndex): PubMedia | undefined {
  const info = qm ? media[qm.mediaId] : undefined;
  if (!qm || !info) return undefined;
  const out: PubMedia = { mediaId: qm.mediaId, kind: info.kind, onPhones: qm.onPhones };
  if (qm.startAtS !== undefined) out.startAtS = qm.startAtS;
  if (info.posterId !== undefined) out.posterId = info.posterId;
  if (info.w && info.h && info.w > 0 && info.h > 0) {
    out.w = Math.round(info.w);
    out.h = Math.round(info.h);
  }
  return out;
}

const pubItem = (it: Item): PubItem => {
  const out: PubItem = { id: it.id };
  if (it.text !== undefined) out.text = it.text;
  if (it.mediaId !== undefined) out.mediaId = it.mediaId;
  return out;
};

/** Question fields every player may see: whitelisted, so a correct answer can never leak. */
function publicFields(q: Question, shown: readonly Id[] | undefined, media: MediaIndex) {
  const base: Pick<RoundPub, 'qid' | 'type' | 'title' | 'double' | 'timeLimitS' | 'media'> = {
    qid: q.id,
    type: q.type,
    title: q.title,
    double: q.double,
    timeLimitS: q.timeLimitS,
  };
  const m = pubMedia(q.media, media);
  if (m) base.media = m;
  switch (q.type) {
    case 'choice':
      return { ...base, options: q.options.map(pubItem) };
    case 'number': {
      const number: NonNullable<RoundPub['number']> = { step: q.step };
      if (q.min !== undefined) number.min = q.min;
      if (q.max !== undefined) number.max = q.max;
      if (q.unit !== undefined) number.unit = q.unit;
      return { ...base, number };
    }
    case 'ordering': {
      const byId = new Map(q.items.map((it) => [it.id, it] as const));
      const order = shown && isPermutation(correctOrder(q), shown) ? shown : defaultShown(q, 0);
      return {
        ...base,
        items: order.map((id) => pubItem(byId.get(id) as Item)),
        firstLabel: q.firstLabel,
        lastLabel: q.lastLabel,
      };
    }
  }
}

const defaultShown = (q: Extract<Question, { type: 'ordering' }>, i: number): Id[] => shownOrder(q, hashSeed(`${q.id}:${i}`));

/**
 * The public round for question `q` started at `now` as round `i` of `total`: no correct answer,
 * ordering items in a deterministic shuffled order that is never the correct one. A video question
 * gets the watch stage (answers open after the video + beat), exactly like the host starts it.
 */
export function publicRound(
  q: Question,
  i: number,
  total: number,
  now: ServerMs,
  settings: Pick<Settings, 'introMs'>,
  opts: { n?: number; media?: MediaIndex; shown?: readonly Id[]; tv?: boolean } = {},
): RoundPub {
  const media = opts.media ?? {};
  const watch = watchWindowMs(q, media, opts.tv !== false);
  const openAt = now + openDelayMs(settings.introMs, watch);
  const shown = q.type === 'ordering' ? (opts.shown ?? defaultShown(q, i)) : undefined;
  const out: RoundPub = {
    i,
    n: opts.n ?? i + 1,
    total,
    ...publicFields(q, shown, media),
    introAt: now,
    openAt,
    endsAt: openAt + timeLimitMs(q),
  };
  if (watch > 0 && out.media) out.media = { ...out.media, ...watchPub(watchFor(q, media, watch)) };
  return out;
}

// ---------- Reveal, board, final ----------

const inGame = (s: GameState, uid: Id): boolean => {
  const p = s.players[uid];
  return p !== undefined && !p.kicked;
};

const round2 = (x: number): number => Math.round(x * 100) / 100;
const numKey = (x: number): string => String(Number(x.toPrecision(12)));

/** A bucket width ≥ raw on the 1-2-2.5-5 ladder, a multiple of the question's step. */
function niceBin(raw: number, step: number): number {
  const min = Math.max(raw, step > 0 ? step : 0, 1e-9);
  const pow = 10 ** Math.floor(Math.log10(min));
  for (const m of [1, 2, 2.5, 5, 10]) {
    const w = m * pow;
    if (w >= min * (1 - 1e-12)) return step > 0 ? Math.ceil(w / step - 1e-9) * step : w;
  }
  return 10 * pow;
}

/** Histogram of number guesses: exact values when there are few distinct ones, else ≤ ~10 buckets. */
export function numberDist(values: readonly number[], step: number): { dist: Record<string, number>; bin?: number } {
  const finite = values.filter(Number.isFinite);
  const distinct = new Set(finite);
  const dist: Record<string, number> = {};
  if (distinct.size <= 10) {
    for (const v of [...finite].sort((a, b) => a - b)) dist[numKey(v)] = (dist[numKey(v)] ?? 0) + 1;
    return { dist };
  }
  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  const w = niceBin((hi - lo) / 8, step);
  const lo0 = Math.floor(lo / w) * w;
  const buckets = Math.floor((hi - lo0) / w) + 1;
  for (let k = 0; k < buckets; k++) dist[numKey(lo0 + k * w)] = 0;
  for (const v of finite) {
    const k = Math.min(buckets - 1, Math.floor((v - lo0) / w + 1e-9));
    const key = numKey(lo0 + k * w);
    dist[key] = (dist[key] ?? 0) + 1;
  }
  return { dist, bin: w };
}

function correctValue(q: Question): RevealPub['correct'] {
  switch (q.type) {
    case 'choice':
      return q.correctId;
    case 'number':
      return q.answer;
    case 'ordering':
      return correctOrder(q);
  }
}

/** Public reveal of round index `k` (engine index) published as round `i`. */
export function revealPub(s: GameState, k: number, i: number, media: MediaIndex): RevealPub {
  const r = s.rounds[k] as Round;
  const q = r.q;
  const results = r.results ?? {};
  const guests = Object.keys(r.answers).filter((uid) => inGame(s, uid) && uid !== s.vladosId && results[uid] !== undefined);
  let dist: Record<string, number> = {};
  let bin: number | undefined;
  switch (q.type) {
    case 'choice': {
      dist = Object.fromEntries(q.options.map((o) => [o.id, 0]));
      for (const uid of guests) {
        const p = r.answers[uid]?.p;
        if (p?.t === 'choice' && p.id in dist) dist[p.id] = (dist[p.id] ?? 0) + 1;
      }
      break;
    }
    case 'number': {
      const values = guests.flatMap((uid) => {
        const p = r.answers[uid]?.p;
        return p?.t === 'number' ? [p.v] : [];
      });
      ({ dist, bin } = numberDist(values, q.step));
      break;
    }
    case 'ordering': {
      const correct = correctOrder(q);
      for (let h = 0; h <= correct.length; h++) dist[String(h)] = 0;
      for (const uid of guests) {
        const p = r.answers[uid]?.p;
        if (p?.t !== 'ordering') continue;
        const hits = correct.filter((id, pos) => p.ids[pos] === id).length;
        dist[String(hits)] = (dist[String(hits)] ?? 0) + 1;
      }
      break;
    }
  }
  const correctGuests = guests.filter((uid) => results[uid]?.correct).length;

  const after = computeStandings(s.rounds.slice(0, k + 1), s.players, s.vladosId);
  const before = standingsBefore(s.rounds, k, s.players, s.vladosId);
  const me: Record<string, RevealMe> = {};
  for (const st of after) {
    const res = results[st.id];
    const m: RevealMe = {
      pts: res?.points ?? 0,
      tot: st.score,
      rank: st.rank,
      prev: st.rank === null ? null : (before?.get(st.id)?.rank ?? null),
      ok: res?.correct ?? false,
    };
    if (res && res.accuracy > 0 && res.accuracy < 1) m.acc = round2(res.accuracy);
    if (res?.closest) m.cl = true;
    me[st.id] = m;
  }

  const out: RevealPub = {
    i,
    correct: correctValue(q),
    dist,
    pct: guests.length ? Math.round((10_000 * correctGuests) / guests.length) / 10_000 : 0,
    count: guests.length,
    me,
  };
  if (bin !== undefined) out.bin = bin;
  if (s.vladosId && s.players[s.vladosId]) out.vlados = r.answers[s.vladosId]?.p ?? null;
  const rm = pubMedia(q.revealMedia, media);
  if (rm) out.media = rm;
  if (q.revealText !== undefined && q.revealText !== '') out.text = q.revealText;
  return out;
}

const nameOf = (s: GameState, docs: Readonly<Record<string, PlayerDoc>>, uid: Id): string =>
  docs[uid]?.name ?? s.players[uid]?.name ?? '';

/** Top `limit` ranked players (Vlados excluded) with ranks before the last scored round. */
export function boardPub(s: GameState, docs: Readonly<Record<string, PlayerDoc>>, limit = 10): BoardPub {
  const last = lastScoredIndex(s.rounds);
  const before = standingsBefore(s.rounds, last, s.players, s.vladosId);
  const lastRes = last >= 0 ? s.rounds[last]?.results : undefined;
  const top: BoardRow[] = computeStandings(s.rounds, s.players, s.vladosId)
    .filter((st) => st.rank !== null)
    .slice(0, limit)
    .map((st) => ({
      uid: st.id,
      name: nameOf(s, docs, st.id),
      score: st.score,
      rank: st.rank as number,
      prev: before?.get(st.id)?.rank ?? null,
      delta: lastRes?.[st.id]?.points ?? 0,
    }));
  return { top };
}

/** Top 3 with thumbs, best first (all of them — finalPub hides the ones not revealed yet). */
export function podiumRows(s: GameState, docs: Readonly<Record<string, PlayerDoc>>, standings?: readonly Standing[]): PodiumRow[] {
  const list = standings ?? computeStandings(s.rounds, s.players, s.vladosId);
  return list
    .filter((st) => st.rank !== null)
    .slice(0, 3)
    .map((st) => {
      const row: PodiumRow = { uid: st.id, rank: st.rank as number, name: nameOf(s, docs, st.id), score: st.score };
      const thumb = docs[st.id]?.thumb;
      if (thumb && thumb.length <= FB_LIMITS.thumbMaxBytes) row.thumb = thumb;
      return row;
    });
}

export function finalVlados(s: GameState, docs: Readonly<Record<string, PlayerDoc>>): FinalVlados | null {
  const c = vladosComparison(s.rounds, s.players, s.vladosId);
  if (!c) return null;
  return {
    uid: c.player.id,
    name: nameOf(s, docs, c.player.id),
    vladosAccuracy: round2(c.vladosAccuracy),
    guestsAccuracy: round2(c.guestsAccuracy),
    best: c.bestGuest ? { uid: c.bestGuest.id, name: nameOf(s, docs, c.bestGuest.id), accuracy: round2(c.bestGuest.accuracy) } : null,
    verdict: c.verdict,
  };
}

/**
 * The video after the final as step 6 publishes it (shared/engine/finale.ts): the uploaded video
 * when 'custom' has a resolved video file, else the built-in clip. `at` = the step's start + the
 * droplet's lead, so releasing a hold (which shifts phaseAt) moves it with the paused video.
 */
export function finaleVideoPub(s: GameState, settings: Settings, media: MediaIndex): FinaleVideoPub | null {
  if (s.finalStep < FINALE.step || !finaleOn(settings)) return null;
  const at = s.phaseAt + FINALE.leadMs;
  const id = finaleCustomId(settings);
  const m = id ? media[id] : undefined;
  if (id && m?.kind === 'video') {
    const out: FinaleVideoPub = { at, ms: finaleMsOf(m.durationS), id };
    if (m.posterId) out.poster = m.posterId;
    if (m.w && m.h) Object.assign(out, { w: m.w, h: m.h });
    return out;
  }
  return { at, ms: FINALE.builtin.ms, w: FINALE.builtin.w, h: FINALE.builtin.h };
}

/**
 * Final screen at s.finalStep: 1 → 3rd place, 2 → 2nd, 3 → 1st (+ everyone's rank), 4 → Vlados,
 * 5 → the mosaic, 6 → the video after the final (`finale`: the settings and media it is made of).
 */
export function finalPub(s: GameState, docs: Readonly<Record<string, PlayerDoc>>, finale?: { settings: Settings; media: MediaIndex }): FinalPub {
  const step = s.finalStep;
  const standings = computeStandings(s.rounds, s.players, s.vladosId);
  const out: FinalPub = {
    step,
    podium: podiumRows(s, docs, standings).filter((row) => row.rank >= 4 - step),
    vlados: step >= 4 ? finalVlados(s, docs) : null,
  };
  if (step >= 3) out.me = Object.fromEntries(standings.map((st) => [st.id, { tot: st.score, rank: st.rank }]));
  const video = finale ? finaleVideoPub(s, finale.settings, finale.media) : null;
  if (video) out.video = video;
  return out;
}

// ---------- Standalone reveal (preview, bots, tests) ----------

export interface RevealInput {
  /** Public round index. */
  i: number;
  q: Question;
  answers: readonly Pick<AnswerDoc, 'uid' | 'p' | 'at'>[];
  players: Readonly<Record<string, PlayerDoc>>;
  vladosUid: string | null;
  scoring: ScoringParams;
  openAt: ServerMs;
  /** Time limit the round was played with (defaults to q.timeLimitS). */
  timeLimitS?: number;
  pauses?: readonly PauseRec[];
  /** Earlier rounds of the game (private/totals) for totals and previous ranks. */
  history?: readonly PrivRound[];
  kicked?: readonly string[];
  media?: MediaIndex;
}

export interface RevealOutput {
  reveal: RevealPub;
  /** Counted answers with frozen results (what private/totals stores). */
  res: Record<string, PrivResult>;
  board: BoardPub;
  podium: PodiumRow[];
  vlados: FinalVlados | null;
  /** Everyone's total and rank after this round. */
  totals: Record<string, { tot: number; rank: number | null }>;
}

/**
 * Scores one round from raw answers with server times and builds everything that depends on it:
 * the public reveal (reveal.me, dist, pct, Vlados's answer), updated totals, the top-10 board with
 * previous ranks, the podium and the Vlados comparison. Late answers (at > endsAt + 2 s) never get
 * here: callers pass only the answers the host had when it froze the round.
 */
export function computeReveal(input: RevealInput): RevealOutput {
  const q: Question = { ...input.q, timeLimitS: input.timeLimitS ?? input.q.timeLimitS };
  const T = timeLimitMs(q);
  const history = (input.history ?? []).map(privToRound);
  const round: Round = { qid: q.id, q, introAt: input.openAt, openAt: input.openAt, endsAt: input.openAt + T, answers: {} };
  for (const a of input.answers) {
    if (round.answers[a.uid] || !answerFits(q, a.p)) continue;
    round.answers[a.uid] = { p: a.p, elapsedMs: serverElapsedMs(a.at, { openAt: input.openAt, pauses: input.pauses ?? [] }, null, T), at: a.at, cid: '' };
  }
  const players = enginePlayers(input.players, input.kicked);
  const vladosId = input.vladosUid && players[input.vladosUid] ? input.vladosUid : null;
  round.results = computeRoundResults(round, players, vladosId, input.scoring);
  const s: GameState = {
    gameId: '',
    rev: 0,
    phase: 'reveal',
    phaseRev: 0,
    phaseAt: 0,
    players,
    vladosId,
    rounds: [...history, round],
    cur: history.length,
    pause: null,
    finalStep: 5,
    tvBanner: null,
    savedAt: 0,
  };
  const standings = computeStandings(s.rounds, players, vladosId);
  return {
    reveal: revealPub(s, s.cur, input.i, input.media ?? {}),
    res: resultsOf({ res: packResults(round) }),
    board: boardPub(s, input.players),
    podium: podiumRows(s, input.players, standings),
    vlados: finalVlados(s, input.players),
    totals: Object.fromEntries(standings.map((st) => [st.id, { tot: st.score, rank: st.rank }])),
  };
}

// ---------- Engine state → docs ----------

function packResults(r: Round): Record<string, PrivResultRow> {
  const out: Record<string, PrivResultRow> = {};
  for (const [uid, res] of Object.entries(r.results ?? {})) {
    const a = r.answers[uid];
    if (!a) continue;
    const x: PrivResult = { p: a.p, at: a.at, e: a.elapsedMs, pt: res.points, ac: res.accuracy, ok: res.correct };
    if (res.closest !== undefined) x.cl = res.closest;
    out[uid] = packResult(x);
  }
  return out;
}

const ANSWER_PHASES: ReadonlySet<Phase> = new Set<Phase>(['intro', 'open', 'locked']);

/** private/totals after a transition from s0 to s1 (pause history and public indices carried over). */
export function nextTotals(prev: TotalsDoc | null, s0: GameState, s1: GameState, now: ServerMs, isNewGame: boolean): TotalsDoc {
  if (isNewGame) return { ...emptyTotals(now), phaseAt: s1.phaseAt };
  const p = prev ?? emptyTotals(s0.phaseAt);
  // resetScores empties the rounds; move iBase on so the next round never reuses an answer id.
  const reset = s1.rounds.length < s0.rounds.length;
  const iBase = reset ? p.iBase + Math.max(s0.rounds.length, p.rounds.length) : p.iBase;
  const rounds: PrivRound[] = s1.rounds.map((r, k) => {
    const old = reset ? undefined : p.rounds[k];
    const pr: PrivRound = { i: old?.i ?? iBase + k, qid: r.qid, q: r.q, introAt: r.introAt, openAt: r.openAt, endsAt: r.endsAt };
    if (r.shown) pr.shown = [...r.shown];
    if (r.lockedAt !== undefined) pr.lockedAt = r.lockedAt;
    if (r.revealedAt !== undefined) pr.revealedAt = r.revealedAt;
    if (r.skipped) pr.skipped = true;
    if (old?.watch) pr.watch = { ...old.watch };
    if (r.surprise) pr.surprise = { ...r.surprise };
    if (typeof r.revealHoldMs === 'number') pr.revealHoldMs = r.revealHoldMs;
    if (typeof r.revealEndMs === 'number') pr.revealEndMs = r.revealEndMs;
    if (old?.pauses?.length) pr.pauses = old.pauses.map((x) => ({ ...x }));
    if (r.results && !r.skipped) pr.res = packResults(r);
    return pr;
  });
  // A pause ended (resume, or cleared by a lock/skip/jump): remember it for the elapsed times.
  // Only while answers count (a hold may also stop a reveal, the board or the final).
  if (s0.pause && !reset && ANSWER_PHASES.has(s0.phase)) {
    const k = s0.cur;
    const target = rounds[k];
    const stillPaused = s1.pause !== null && s1.cur === k;
    if (target && !stillPaused) {
      const sh = (s1.rounds[k]?.openAt ?? 0) - (s0.rounds[k]?.openAt ?? 0);
      target.pauses = [...(target.pauses ?? []), { s: s0.pause.at, e: now, sh }];
    }
  }
  return { v: 1, rev: p.rev + 1, phaseAt: s1.phaseAt, iBase, rounds, updatedAt: now };
}

export function pubInfo(settings: Settings): PubInfo {
  const startsAt = Date.parse(settings.gameStartsAt);
  const out: PubInfo = {
    title: settings.title,
    subtitle: settings.subtitle,
    texts: resolveTexts(settings),
    startsAt: Number.isFinite(startsAt) ? startsAt : 0,
    reactions: settings.reactions,
    lateJoin: settings.lateJoin,
    maxPlayers: settings.maxPlayers,
    vladosLabel: settings.vladosLabel,
    themeId: settings.themeId,
    themeDefault: 'system',
  };
  if (settings.lobbyBgMediaId) out.lobbyBg = settings.lobbyBgMediaId;
  return out;
}

/**
 * Media ids the host must resolve (kind, poster) before it can publish them: every question of the
 * content, the lobby background, AND the frozen questions of this game's rounds — a question deleted
 * from content mid-round must keep its picture/video on air when a restarted or standby host
 * projects the next transition.
 */
export function referencedMediaIds(
  content: { questions?: readonly Question[]; settings?: { lobbyBgMediaId?: Id | undefined; finaleMediaId?: Id | undefined } } | null,
  totals: Pick<TotalsDoc, 'rounds'> | null,
): Id[] {
  const ids = new Set<Id>();
  const add = (q: Question) => {
    if (q.media) ids.add(q.media.mediaId);
    if (q.revealMedia) ids.add(q.revealMedia.mediaId);
  };
  for (const q of content?.questions ?? []) add(q);
  for (const r of totals?.rounds ?? []) add(r.q);
  if (content?.settings?.lobbyBgMediaId) ids.add(content.settings.lobbyBgMediaId);
  // the uploaded video after the final (its length, poster and size go into final.video)
  if (content?.settings?.finaleMediaId) ids.add(content.settings.finaleMediaId);
  // an uploaded «Сюрприз» video (its length is frozen when the round starts)
  for (const q of content?.questions ?? []) if (q.surprise?.mediaId) ids.add(q.surprise.mediaId);
  for (const r of totals?.rounds ?? []) if (r.q.surprise?.mediaId) ids.add(r.q.surprise.mediaId);
  return [...ids];
}

const ROUND_PHASES: ReadonlySet<Phase> = new Set<Phase>(['intro', 'open', 'locked', 'reveal', 'board']);
const PREFETCH_PHASES: ReadonlySet<Phase> = new Set<Phase>(['lobby', 'reveal', 'board']);

export interface ProjectCtx {
  content: HostContent;
  players: Readonly<Record<string, PlayerDoc>>;
  media: MediaIndex;
}

/** Answers of the round on air from players still in the game. */
export function answeredCount(s: GameState): number {
  const r = ROUND_PHASES.has(s.phase) ? s.rounds[s.cur] : undefined;
  return r ? Object.keys(r.answers).filter((uid) => inGame(s, uid)).length : 0;
}

export const playerCount = (s: GameState): number => Object.values(s.players).filter((p) => !p.kicked).length;

/**
 * What phones prefetch for question `q`. A video never goes to phones (up to 45 MB × 90 phones would
 * eat the egress budget): they show its poster, and only the TV loads the video itself.
 */
function mediaIdsOf(q: Question, media: MediaIndex): Id[] {
  const ids = new Set<Id>();
  const info = q.media ? media[q.media.mediaId] : undefined;
  if (q.media?.onPhones && info) {
    if (info.kind === 'video') {
      if (info.posterId) ids.add(info.posterId);
    } else ids.add(q.media.mediaId);
  }
  const items = q.type === 'choice' ? q.options : q.type === 'ordering' ? q.items : [];
  for (const it of items) if (it.mediaId !== undefined) ids.add(it.mediaId);
  return [...ids];
}

/**
 * The «Сюрприз» stage on air (shared/engine/surprise.ts) as `next.surprise` publishes it: only while
 * it runs, never before (the phones must not know). `at` = lockedAt, so a hold (released: lockedAt
 * moves) moves the whole stage with the paused video.
 */
export function surprisePub(s: GameState, media: MediaIndex): SurprisePub | null {
  const r = s.rounds[s.cur];
  if (!surpriseRunning(s) || !r?.surprise || r.lockedAt === undefined) return null;
  const out: SurprisePub = { at: r.lockedAt, ms: r.surprise.ms };
  const id = surpriseCustomId(r.q.surprise, media);
  const m = id ? media[id] : undefined;
  if (id && m) {
    out.id = id;
    if (m.posterId) out.poster = m.posterId;
    if (m.w && m.h) Object.assign(out, { w: Math.round(m.w), h: Math.round(m.h) });
  } else Object.assign(out, { w: SURPRISE.builtin.w, h: SURPRISE.builtin.h });
  return out;
}

function nextPub(s: GameState, content: Content, media: MediaIndex): GameDoc['next'] {
  const surprise = surprisePub(s, media);
  if (surprise) return { media: [], surprise };
  // the mosaic before the video after the final: phones fetch its poster (an uploaded video's; the
  // built-in clip's poster is a static file of the site)
  if (s.phase === 'final') {
    const id = s.finalStep === FINALE.step - 1 && finaleOn(content.settings) ? finaleCustomId(content.settings) : null;
    const poster = id && media[id]?.kind === 'video' ? media[id]?.posterId : undefined;
    return poster ? { media: [poster] } : null;
  }
  const next = PREFETCH_PHASES.has(s.phase) ? nextQuestion(s, content) : null;
  return next ? { media: mediaIdsOf(next, media) } : null;
}

/** The public game doc for engine state `s` (totals `t` gives the public round indices). */
export function projectGame(s: GameState, t: TotalsDoc, ctx: ProjectCtx): GameDoc {
  const content = engineContent(ctx.content);
  const onAir = ROUND_PHASES.has(s.phase) ? s.rounds[s.cur] : undefined;
  const pr = onAir ? t.rounds[s.cur] : undefined;
  let round: RoundPub | null = null;
  if (onAir && pr) {
    const playedQids = new Set(s.rounds.map((r) => r.qid));
    const remaining = content.questions.filter((q) => !q.disabled && !playedQids.has(q.id)).length;
    const played = s.rounds.filter((r) => !r.skipped).length;
    round = {
      i: pr.i,
      n: s.rounds.slice(0, s.cur).filter((r) => !r.skipped).length + 1,
      total: played + remaining,
      ...publicFields(onAir.q, onAir.shown, ctx.media),
      introAt: onAir.introAt,
      openAt: onAir.openAt,
      // Paused open question: keep the answer window open (the rules check endsAt).
      endsAt: s.pause && s.phase === 'open' ? Math.max(onAir.endsAt, s.pause.at + s.pause.remainingMs + HOST_TIMING.pauseHoldMs) : onAir.endsAt,
    };
    if (pr.watch && round.media) round.media = { ...round.media, ...watchPub(pr.watch) };
  }
  const revealed = onAir && pr && (s.phase === 'reveal' || s.phase === 'board') && onAir.results !== undefined;
  const kicked = Object.values(s.players)
    .filter((p) => p.kicked)
    .map((p) => p.id)
    .sort();
  const doc: GameDoc = {
    pub: pubInfo(ctx.content.settings),
    phase: s.phase,
    phaseRev: s.phaseRev,
    round,
    pause: s.pause ? { at: s.pause.at, remainingMs: Math.round(s.pause.remainingMs), reason: s.pause.reason } : null,
    answered: answeredCount(s),
    players: playerCount(s),
    reveal: revealed ? revealPub(s, s.cur, (pr as PrivRound).i, ctx.media) : null,
    board: s.phase === 'board' ? boardPub(s, ctx.players) : null,
    final: s.phase === 'final' ? finalPub(s, ctx.players, { settings: ctx.content.settings, media: ctx.media }) : null,
    vladosUid: s.vladosId,
    host: null,
    banner: s.tvBanner,
    next: nextPub(s, content, ctx.media),
  };
  if (kicked.length) doc.kicked = kicked;
  return doc;
}

/** Order-insensitive deep equality for doc values (Firestore returns map keys in its own order). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    return a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((x, k) => x === b[k]);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, k) => sameValue(x, b[k]));
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * `pub` (titles, texts, flags from settings) and `next` (prefetch ids) as the host would write them
 * now, when they differ from the doc — e.g. the organizer edited a text, or a freshly seeded lobby
 * has no prefetch list yet. Null when the doc is up to date.
 */
export function refreshedGame(inp: HostInput, ctx: Pick<ProjectCtx, 'content' | 'media'>): Pick<GameDoc, 'pub' | 'next'> | null {
  const s = toEngineState(inp);
  const pub = pubInfo(ctx.content.settings);
  const next = keepSurprise(nextPub(s, engineContent(ctx.content), ctx.media), inp.game.next ?? null);
  return sameValue(pub, inp.game.pub) && sameValue(next, inp.game.next ?? null) ? null : { pub, next };
}

/**
 * A refresh never touches `next.surprise`: only the phase transactions (step()) write it. The
 * game doc and private/totals reach a page through two listeners; a refresh computed between them
 * (another page released a «стоп-экран»: the doc is new, lockedAt in totals still old) would put
 * the stage back by the hold, or drop it (patchGame only checks phaseRev and the round).
 */
function keepSurprise(next: GameDoc['next'], doc: GameDoc['next']): GameDoc['next'] {
  const media = next?.media ?? [];
  if (doc?.surprise) return { media, surprise: doc.surprise };
  return next?.surprise ? (media.length ? { media } : null) : next;
}

/** A fresh game in the lobby (seed tools, newGame). */
export function initialGameDoc(settings: Settings, phaseRev = 0): GameDoc {
  return {
    pub: pubInfo(settings),
    phase: 'lobby',
    phaseRev,
    round: null,
    pause: null,
    answered: 0,
    players: 0,
    reveal: null,
    board: null,
    final: null,
    vladosUid: null,
    host: null,
    banner: null,
    next: null,
  };
}

// ---------- Commands & ticks ----------

/** Admin commands (app/src/host/commands.ts sends them as transactions). */
export type HostCommand =
  | { type: 'start' }
  | { type: 'advance'; phaseRev: number }
  | { type: 'reveal'; phaseRev: number }
  | { type: 'skip'; phaseRev: number }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'addTime'; ms: number }
  | { type: 'jumpTo'; qid: Id }
  | { type: 'end' }
  | { type: 'resetScores' }
  | { type: 'newGame' }
  /** `round` = public round index (RoundPub.i / PrivRound.i). */
  | { type: 'rescoreRound'; round: number }
  | { type: 'kick'; uid: string }
  | { type: 'unkick'; uid: string }
  | { type: 'rename'; uid: string; name: string }
  | { type: 'setVlados'; uid: string | null }
  | { type: 'banner'; text: string | null }
  /**
   * «Стоп-экран»: `text` on the TV and the whole show stopped in any phase — timers frozen with
   * their time left, no timed transitions, phones on «Пауза — смотри на экран». Again while held:
   * a new text. See isHeld().
   */
  | { type: 'hold'; phaseRev: number; text: string }
  /** Ends the hold: the text goes, every timer continues with the time it had left. */
  | { type: 'unhold' }
  /** The question's video has been watched (TV 'ended', «Видео досмотрели — старт», TV Space). */
  | { type: 'watchEnd'; phaseRev: number }
  /** The «Сюрприз» video has been watched (TV 'ended', «Досмотрели — к ответу», TV Space): the reveal now. */
  | { type: 'surpriseEnd'; phaseRev: number }
  /**
   * The reveal video has been watched (the TV's 'ended'): the «Автопилот» moves on to the board
   * SHOW.revealVideoEndedMs later (never before the plain reveal hold; the clock hold stays the
   * fallback). Only once per reveal; nothing else changes.
   */
  | { type: 'revealMediaEnd'; phaseRev: number };

export type HostCommandType = HostCommand['type'];

export type CmdError = CmdErr | 'not_found' | 'not_leader' | 'offline' | 'failed';
export type CmdResult = { ok: true; phaseRev: number; gameId?: string } | { ok: false; error: CmdError };

/** The engine command for a host command (null: not an engine command, or invalid). */
export function toEngineCmd(cmd: HostCommand, totals: TotalsDoc | null): AdminCmd | null {
  switch (cmd.type) {
    case 'start':
    case 'pause':
    case 'resume':
    case 'end':
    case 'resetScores':
    case 'newGame':
      return { type: cmd.type };
    case 'advance':
    case 'reveal':
    case 'skip':
      return { type: cmd.type, phaseRev: cmd.phaseRev };
    case 'addTime':
      return Number.isFinite(cmd.ms) ? { type: 'addTime', ms: Math.round(cmd.ms) } : null;
    case 'jumpTo':
      return { type: 'jumpTo', qid: cmd.qid };
    case 'rescoreRound': {
      const k = totals?.rounds.findIndex((r) => r.i === cmd.round) ?? -1;
      return k >= 0 ? { type: 'rescoreRound', round: k } : null;
    }
    case 'kick':
    case 'unkick':
      return { type: cmd.type, id: cmd.uid };
    case 'setVlados':
      return { type: 'setVlados', id: cmd.uid };
    case 'banner': {
      const text = cmd.text?.trim() || null;
      if (text !== null && text.length > FB_LIMITS.bannerMax) return null;
      return { type: 'tvBanner', text };
    }
    case 'hold': {
      const text = typeof cmd.text === 'string' ? cmd.text.trim() : '';
      if (!text || text.length > FB_LIMITS.bannerMax || !Number.isFinite(cmd.phaseRev)) return null;
      return { type: 'hold', phaseRev: cmd.phaseRev, text };
    }
    case 'unhold':
      return { type: 'unhold' };
    case 'rename':
    case 'watchEnd':
    case 'surpriseEnd':
    case 'revealMediaEnd':
      return null;
  }
}

/** The engine event for a host command (null: not an engine event — rename — or invalid). */
export function hostEvent(cmd: HostCommand, totals: TotalsDoc | null): EngineEvent | null {
  if (cmd.type === 'watchEnd') return { t: 'watchEnd', phaseRev: cmd.phaseRev };
  if (cmd.type === 'surpriseEnd') return Number.isFinite(cmd.phaseRev) ? { t: 'surpriseEnd', phaseRev: cmd.phaseRev } : null;
  if (cmd.type === 'revealMediaEnd') return Number.isFinite(cmd.phaseRev) ? { t: 'revealMediaEnd', phaseRev: cmd.phaseRev } : null;
  const engineCmd = toEngineCmd(cmd, totals);
  return engineCmd ? { t: 'cmd', cmd: engineCmd } : null;
}

/** A player name an admin may set: normalized, and within the rules' UTF-16 limit. */
export function checkedName(raw: string): string | null {
  const name = normalizeName(raw);
  return name !== null && fbNameOk(name) ? name : null;
}

export interface StepCtx extends ProjectCtx {
  /** newGame: id of the new game. */
  newGameId?: string;
  /**
   * Secret entropy for the shared shuffle of a new ordering round (the driver passes a fresh random
   * number per transaction). The engine seeds it from gameId + round + qid only — all public — and
   * the shuffle's permutation depends on nothing else, so a guest with the JS bundle could invert
   * the shown order into the correct one. The order is stored (private/totals + the public round),
   * so the seed is never needed again.
   */
  shuffleSeed?: number;
  /**
   * A TV is on air (it holds the lease, see tvOnAir()): it plays a video round's video and reports
   * its end. false → a video round starting now gets the short watch fallback. Default true.
   */
  tv?: boolean;
}

const isNewRound = (s0: GameState, s1: GameState, k: number): boolean => {
  const old = s0.rounds[k];
  const r = s1.rounds[k];
  return !!r && (!old || old.qid !== r.qid || old.introAt !== r.introAt);
};

/** Re-shuffles the ordering rounds that `s1` started (not in `s0`) with the secret seed. */
function reseedNewRounds(s0: GameState, s1: GameState, seed: number): void {
  s1.rounds.forEach((r, k) => {
    if (!isNewRound(s0, s1, k) || r.q.type !== 'ordering' || r.results) return;
    r.shown = shownOrder(r.q, hashSeed(`${seed >>> 0}:${s1.gameId}:${k}:${r.qid}`));
  });
}

/**
 * Freezes the watch window of the video rounds `s1` started: the same watchWindowMs() the engine
 * used for their openAt, with the same media, so the video start (openAt − beat − window) is exact.
 */
function freezeWatch(s0: GameState, s1: GameState, totals: TotalsDoc, content: Content): void {
  s1.rounds.forEach((r, k) => {
    const pr = totals.rounds[k];
    if (!pr || !isNewRound(s0, s1, k)) return;
    const ms = watchWindowMs(r.q, content.media, content.tvOnAir !== false);
    if (ms > 0) pr.watch = watchFor(r.q, content.media, ms);
    else delete pr.watch;
  });
}

/** The frozen watch stage of a video round: its window and the video's own length (when known). */
function watchFor(q: Question, media: Readonly<Record<Id, WatchMedia | undefined>>, ms: number): NonNullable<PrivRound['watch']> {
  const v = watchVideoMs(q, media);
  return typeof v === 'number' ? { ms, videoMs: Math.min(v, ms) } : { ms };
}

const watchPub = (w: NonNullable<PrivRound['watch']>): Pick<PubMedia, 'watchMs' | 'videoMs'> => (w.videoMs !== undefined ? { watchMs: w.ms, videoMs: w.videoMs } : { watchMs: w.ms });

export interface StepOut {
  ok: boolean;
  error?: CmdError;
  /** False when nothing needs writing. */
  changed: boolean;
  state: GameState;
  /** Game id the docs below belong to (differs from the input after newGame). */
  gameId: string;
  game: GameDoc;
  totals: TotalsDoc;
  /** Player docs whose `kicked` flag must change. */
  kicked: { uid: string; kicked: boolean }[];
  newGame: boolean;
}

/**
 * Applies a command or a tick to the docs. Overdue timed transitions are applied first (and after),
 * exactly like the engine does, so a late timer can never let an answer in after the reveal.
 */
export function step(inp: HostInput, ev: EngineEvent, now: ServerMs, ctx: StepCtx): StepOut {
  const s0 = toEngineState(inp);
  const event: EngineEvent = ev.t === 'cmd' && ev.cmd.type === 'newGame' && ctx.newGameId ? { ...ev, gameId: ctx.newGameId } : ev;
  const unchanged = { state: s0, gameId: inp.gameId, game: inp.game, totals: inp.totals ?? emptyTotals(s0.phaseAt), kicked: [], newGame: false };
  // Only a round that started with a watch stage can end it (whatever the media index says now).
  if (ev.t === 'watchEnd' && !inp.totals?.rounds[s0.cur]?.watch) return { ok: false, error: 'invalid', changed: false, ...unchanged };
  const content = engineContent(ctx.content, ctx.media, ctx.tv !== false);
  const res = reduce(s0, event, now, content);
  for (const e of res.effects) {
    if (e.k === 'ack' && !e.res.ok) return { ok: false, error: e.res.err as CmdError, changed: false, ...unchanged };
  }
  const s1 = res.state;
  if (s1 === s0) return { ok: true, changed: false, ...unchanged };
  if (ctx.shuffleSeed !== undefined) reseedNewRounds(s0, s1, ctx.shuffleSeed);
  const isNewGame = res.effects.some((e) => e.k === 'newGame');
  const totals = nextTotals(inp.totals, s0, s1, now, isNewGame);
  freezeWatch(s0, s1, totals, content);
  const players = isNewGame ? {} : inp.players;
  const game = projectGame(s1, totals, { ...ctx, players });
  const kicked: StepOut['kicked'] = [];
  if (!isNewGame) {
    for (const [uid, p] of Object.entries(s1.players)) {
      const doc = inp.players[uid];
      if (doc && doc.kicked !== p.kicked) kicked.push({ uid, kicked: p.kicked });
    }
  }
  return { ok: true, changed: true, state: s1, gameId: s1.gameId, game, totals, kicked, newGame: isNewGame };
}

/** When the next timed transition is due (server ms), or null. */
export function hostDeadline(inp: HostInput, content: HostContent): ServerMs | null {
  return nextDeadline(toEngineState(inp), engineSettings(content.settings));
}

/** Live counts the public doc should show. */
export function liveCounts(inp: HostInput): { answered: number; players: number } {
  const s = toEngineState(inp);
  return { answered: answeredCount(s), players: playerCount(s) };
}

/**
 * Spacing of the public `answered` count while a question is open. Every push costs every phone a
 * read, so: ≥ 5 s, at most 3 pushes per question (limit / 3), and 100 ms per player on top — 95
 * phones × 15 questions stay at ≤ 3 × 95 × 15 ≈ 4.3k reads (tools/swarm.mjs measures it).
 */
export function answeredPushGapMs(limitMs: number, players: number): number {
  return Math.max(HOST_TIMING.answeredPushMs, limitMs / 3, players * 100);
}

/**
 * Spacing of the public `players` count (lobby counter, late joins, the join cap): ≥ 15 s and 1 s
 * per player, so however slowly guests trickle in, the pushes cost all phones together ≤ 1 read/s
 * (≈ 1.5k for a 30 min lobby of 95); never slower than 90 s.
 */
export function playersPushGapMs(players: number): number {
  return Math.min(90_000, Math.max(HOST_TIMING.playersPushMs, players * 1_000));
}

/** Throttle for the counts in the public doc (see answeredPushGapMs / playersPushGapMs); only when changed. */
export function countsPushDue(game: GameDoc, live: { answered: number; players: number }, lastPushAt: ServerMs, now: ServerMs): boolean {
  const since = now - lastPushAt;
  const crowd = Math.max(live.players, game.players);
  const limitMs = (game.round?.timeLimitS ?? 0) * 1000;
  if (game.phase === 'open' && !game.pause && live.answered !== game.answered && since >= answeredPushGapMs(limitMs, crowd)) return true;
  return live.players !== game.players && since >= playersPushGapMs(crowd);
}

// ---------- Lease ----------

export type LeaseAction = 'acquire' | 'renew' | 'takeover' | 'none';

export const leaseHeld = (lease: LeaseDoc | null | undefined, session: string, now: ServerMs): boolean =>
  !!lease && lease.session === session && lease.until > now;

/**
 * A TV page is on air: it (preferred) holds an unexpired lease — a TV always takes the lease over
 * from an admin page. Only a TV plays a question's video (and reports its end).
 */
export const tvOnAir = (lease: LeaseDoc | null | undefined, now: ServerMs): boolean => !!lease && lease.preferred && lease.until > now;

/** The «стоп-экран» is on: the show stands still, the TV shows only `banner` (see HostCommand 'hold'). */
export const isHeld = (g: Pick<GameDoc, 'pause'> | null | undefined): boolean => g?.pause?.reason === 'hold';

/**
 * The answers of the round on air count: open / locked, or an intro whose opening time has come
 * (the host that should switch it to 'open' is late — a hidden admin tab: the rules accept answers
 * by the clock then, see firestore.rules → windowOpen).
 */
export const answersLive = (g: GameDoc | null | undefined, now: ServerMs): boolean =>
  !!g?.round && (g.phase === 'open' || g.phase === 'locked' || (g.phase === 'intro' && !g.pause && now >= g.round.openAt - FB_LIMITS.answerEarlyMs));

/**
 * What this page should do about the lease. `active`: a timed transition is pending (short lease,
 * renewed every 5 s); otherwise a longer, lazier lease keeps the idle write rate low.
 */
export function leaseAction(lease: LeaseDoc | null | undefined, me: { session: string; preferred: boolean }, now: ServerMs, active: boolean): LeaseAction {
  if (!lease || lease.until <= now) return 'acquire';
  if (lease.session === me.session) {
    const ttl = active ? HOST_TIMING.leaseTtlMs : HOST_TIMING.idleLeaseTtlMs;
    const every = active ? HOST_TIMING.leaseRenewMs : HOST_TIMING.idleLeaseRenewMs;
    return lease.until - now <= ttl - every ? 'renew' : 'none';
  }
  return me.preferred && !lease.preferred ? 'takeover' : 'none';
}

export function newLease(me: { session: string; preferred: boolean; label: string; uid: string }, now: ServerMs, active: boolean): LeaseDoc {
  return {
    session: me.session,
    until: now + (active ? HOST_TIMING.leaseTtlMs : HOST_TIMING.idleLeaseTtlMs),
    label: me.label,
    preferred: me.preferred,
    uid: me.uid,
    at: now,
  };
}

// ---------- Player side ----------

export type AnswerError = 'late' | 'closed' | 'kicked' | 'offline' | 'invalid' | 'not_joined';

/** Does the payload fit the public round? (The rules only check its shape.) */
export function validAnswerPayload(round: RoundPub, p: AnswerPayload): boolean {
  switch (round.type) {
    case 'choice':
      return p.t === 'choice' && (round.options ?? []).some((o) => o.id === p.id);
    case 'number': {
      if (p.t !== 'number' || !Number.isFinite(p.v)) return false;
      const n = round.number;
      return (n?.min === undefined || p.v >= n.min) && (n?.max === undefined || p.v <= n.max);
    }
    case 'ordering':
      return p.t === 'ordering' && isPermutation((round.items ?? []).map((it) => it.id), p.ids);
  }
}

/** Client-side mirror of the answer rules: null when the write is worth trying. */
export function answerPrecheck(
  game: GameDoc | null,
  me: { uid: string; joined: boolean; kicked: boolean },
  round: number,
  p: AnswerPayload,
  now: ServerMs,
): AnswerError | null {
  if (!me.joined) return 'not_joined';
  if (me.kicked || game?.kicked?.includes(me.uid)) return 'kicked';
  if (!game) return 'offline';
  const r = game.round;
  if (!r) return game.phase === 'final' ? 'late' : 'closed';
  if (r.i !== round) return round < r.i ? 'late' : 'closed';
  // «стоп-экран»: the phones show «смотри на экран», nothing is sent until the show goes on
  if (isHeld(game)) return 'closed';
  // A late host (hidden admin tab, lost TV): the answers open by the clock at openAt, like the rules.
  if (game.phase === 'intro' ? !!game.pause : game.phase !== 'open' && game.phase !== 'locked') return game.phase === 'intro' ? 'closed' : 'late';
  if (now < r.openAt - FB_LIMITS.answerEarlyMs) return 'closed';
  if (now > r.endsAt + FB_LIMITS.answerLateMs) return 'late';
  if (!validAnswerPayload(r, p)) return 'invalid';
  return null;
}

/**
 * Reactions a device may send: one per 3 s and 4 per minute (the rules alone allow ~40/min). Each
 * is a write plus a TV read; at 4/min even 95 guests tapping nonstop for an hour stay near the
 * 20k writes/day, so answers never start failing because of emoji.
 */
export const REACTION_LIMITS = { minGapMs: 3_000, perMinute: 4 } as const;

export function reactionAllowed(sentAt: readonly ServerMs[], now: ServerMs): boolean {
  const last = sentAt.length ? (sentAt[sentAt.length - 1] as number) : -Infinity;
  if (now - last < REACTION_LIMITS.minGapMs) return false;
  return sentAt.filter((t) => now - t < 60_000).length < REACTION_LIMITS.perMinute;
}

// ---------- Firestore hygiene ----------

/** Deep copy without undefined values (Firestore rejects them unless ignoreUndefinedProperties). */
export function stripUndefined<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => stripUndefined(x)) as T;
  if (v === null || typeof v !== 'object' || v instanceof Uint8Array) return v;
  const proto: unknown = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (x !== undefined) out[k] = stripUndefined(x);
  return out as T;
}
