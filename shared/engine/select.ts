// Pure view-model builders (docs/architecture.md → Views). The server calls them on every change;
// admin preview, Lab and screenshot fixtures call them too, so every screen renders the same data.
// Public views whitelist question fields: correct answers only appear in `reveal`, at reveal.

import { resolveTexts } from '../defaults';
import { correctOrder } from '../scoring';
import type { Content, GameState, Id, Item, OrderingQ, Phase, Player, QMedia, Question, Round } from '../types';
import { hashSeed, rng, shuffleNotIdentity } from '../util';
import type {
  AdminView,
  BoardEntry,
  BrandView,
  CorrectAnswer,
  Distribution,
  FinalView,
  JoinInfo,
  MediaRef,
  MeView,
  PlayerChip,
  PubRound,
  PubView,
  PublicItem,
  PublicQMedia,
  PublicQuestion,
  RevealView,
  TvAnswer,
  TvPlayer,
  TvView,
} from '../views';
import {
  computeStandings,
  lastScoredIndex,
  scoredCount,
  standingsBefore,
  standingsById,
  vladosComparison,
  type Standing,
} from './results';

/** Server-side facts the views need that are not part of the game state. */
export interface ViewCtx {
  /** e.g. `https://valorin777.github.io/vlados`; null when the CDN is not usable. */
  cdnBase: string | null;
  /** Join URLs for the QR codes. */
  urls: { direct: string | null; pages: string | null; lan: string | null };
}

export const NO_CTX: ViewCtx = { cdnBase: null, urls: { direct: null, pages: null, lan: null } };

export const avatarPath = (file: string): string => `/avatars/${file}`;

/** Views change with both the game and the content, so their rev is the sum of both counters. */
export const viewRev = (state: GameState, content: Content): number => state.rev + content.rev;

// ---------- Questions & rounds ----------

/** Every question that already has a round (skipped ones included). */
export const playedQids = (state: GameState): Set<Id> => new Set(state.rounds.map((r) => r.qid));

/** "Next" = first enabled question in content order not yet played. */
export function nextQuestion(state: GameState, content: Content): Question | null {
  const played = playedQids(state);
  return content.questions.find((q) => !q.disabled && !played.has(q.id)) ?? null;
}

export const roundSeed = (gameId: Id, index: number, qid: Id): number => hashSeed(`${gameId}:${index}:${qid}`);

/** Deterministic shared shuffle for an ordering round; never the correct order. */
export const shownOrder = (q: OrderingQ, seed: number): Id[] => shuffleNotIdentity(correctOrder(q), rng(seed));

const ROUND_PHASES: ReadonlySet<Phase> = new Set<Phase>(['intro', 'open', 'locked', 'reveal', 'board']);

/** The round on screen right now (null in lobby and final). */
export const currentRound = (state: GameState): Round | null =>
  ROUND_PHASES.has(state.phase) ? (state.rounds[state.cur] ?? null) : null;

const inGame = (state: GameState, id: Id): boolean => {
  const p = state.players[id];
  return p !== undefined && !p.kicked;
};

const answeredIds = (state: GameState, round: Round): Id[] => Object.keys(round.answers).filter((id) => inGame(state, id));

// ---------- Media ----------

function mediaRef(content: Content, id: Id | undefined): MediaRef | undefined {
  const m = id === undefined ? undefined : content.media[id];
  if (!m || m.status !== 'ready') return undefined;
  const ref: MediaRef = { id: m.id, kind: m.kind, files: { ...m.files }, w: m.w, h: m.h };
  if (m.durationS !== undefined) ref.durationS = m.durationS;
  return ref;
}

function publicQMedia(content: Content, qm: QMedia | undefined): PublicQMedia | undefined {
  const media = mediaRef(content, qm?.mediaId);
  if (!qm || !media) return undefined;
  const out: PublicQMedia = { media, onPhones: qm.onPhones };
  if (qm.startAtS !== undefined) out.startAtS = qm.startAtS;
  return out;
}

function publicItem(content: Content, it: Item): PublicItem {
  const out: PublicItem = { id: it.id };
  if (it.text !== undefined) out.text = it.text;
  if (it.mediaId !== undefined) {
    out.mediaId = it.mediaId;
    const media = mediaRef(content, it.mediaId);
    if (media) out.media = media;
  }
  return out;
}

/** The question without its correct answer; ordering items in the round's shuffled order. */
export function publicQuestion(round: Round, content: Content): PublicQuestion {
  const q = round.q;
  const base = { id: q.id, title: q.title, double: q.double, timeLimitS: q.timeLimitS };
  const media = publicQMedia(content, q.media);
  const withMedia = media ? { ...base, media } : base;
  switch (q.type) {
    case 'choice':
      return { ...withMedia, type: 'choice', options: q.options.map((o) => publicItem(content, o)) };
    case 'number': {
      const out: PublicQuestion = { ...withMedia, type: 'number', step: q.step };
      if (q.unit !== undefined) out.unit = q.unit;
      if (q.min !== undefined) out.min = q.min;
      if (q.max !== undefined) out.max = q.max;
      return out;
    }
    case 'ordering': {
      const byId = new Map(q.items.map((i) => [i.id, i] as const));
      const order = round.shown ?? shownOrder(q, hashSeed(q.id));
      const items = order.flatMap((id) => {
        const it = byId.get(id);
        return it ? [publicItem(content, it)] : [];
      });
      return { ...withMedia, type: 'ordering', items, firstLabel: q.firstLabel, lastLabel: q.lastLabel };
    }
  }
}

function prefetchFor(q: Question | null, content: Content): MediaRef[] {
  if (!q) return [];
  const ids = new Set<Id>();
  if (q.media?.onPhones) ids.add(q.media.mediaId);
  const items = q.type === 'choice' ? q.options : q.type === 'ordering' ? q.items : [];
  for (const it of items) if (it.mediaId !== undefined) ids.add(it.mediaId);
  return [...ids].flatMap((id) => {
    const m = mediaRef(content, id);
    return m ? [m] : [];
  });
}

// ---------- Players ----------

type Audience = 'phone' | 'tv';
type ChipFn = (p: Player) => PlayerChip;

const chipOf = (p: Player, withAvatar: boolean): PlayerChip => {
  const c: PlayerChip = { id: p.id, name: p.name, seed: p.seed };
  if (withAvatar && p.avatar) c.avatar = avatarPath(p.avatar);
  return c;
};

/** Phones see generated sigils for others; the TV sees selfies. */
const chipFor = (audience: Audience): ChipFn => (p) => chipOf(p, audience === 'tv');

/** Ranked players (Vlados excluded) with previous ranks and deltas relative to the last scored round. */
function rankedBoard(state: GameState, chip: ChipFn): BoardEntry[] {
  const { rounds, players, vladosId } = state;
  const last = lastScoredIndex(rounds);
  const before = standingsBefore(rounds, last, players, vladosId);
  const lastResults = last >= 0 ? rounds[last]?.results : undefined;
  const out: BoardEntry[] = [];
  for (const s of computeStandings(rounds, players, vladosId)) {
    const p = players[s.id];
    if (s.rank === null || !p) continue;
    out.push({
      ...chip(p),
      score: s.score,
      rank: s.rank,
      prevRank: before?.get(s.id)?.rank ?? null,
      delta: lastResults?.[s.id]?.points ?? 0,
      correctCount: s.correct,
    });
  }
  return out;
}

// ---------- Reveal ----------

function correctAnswer(q: Question): CorrectAnswer {
  switch (q.type) {
    case 'choice':
      return { t: 'choice', id: q.correctId };
    case 'number': {
      const c: CorrectAnswer = { t: 'number', v: q.answer, tolerance: q.tolerance };
      if (q.unit !== undefined) c.unit = q.unit;
      return c;
    }
    case 'ordering':
      return { t: 'ordering', ids: correctOrder(q) };
  }
}

const median = (sorted: readonly number[]): number | null => {
  if (sorted.length === 0) return null;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[m] as number) : ((sorted[m - 1] as number) + (sorted[m] as number)) / 2;
};

function revealView(state: GameState, round: Round, content: Content, chip: ChipFn): RevealView {
  const q = round.q;
  const results = round.results ?? {};
  const guests = answeredIds(state, round).filter((id) => id !== state.vladosId);
  let distribution: Distribution;
  switch (q.type) {
    case 'choice': {
      const counts: Record<Id, number> = Object.fromEntries(q.options.map((o) => [o.id, 0]));
      for (const id of guests) {
        const p = round.answers[id]?.p;
        if (p?.t === 'choice' && p.id in counts) counts[p.id] = (counts[p.id] ?? 0) + 1;
      }
      distribution = { t: 'choice', counts };
      break;
    }
    case 'number': {
      const guesses: { id: Id; v: number }[] = [];
      for (const id of guests) {
        const p = round.answers[id]?.p;
        if (p?.t === 'number') guesses.push({ id, v: p.v });
      }
      guesses.sort((a, b) => a.v - b.v);
      const closest = guesses.filter((g) => results[g.id]?.closest);
      distribution = {
        t: 'number',
        values: guesses.map((g) => g.v),
        median: median(guesses.map((g) => g.v)),
        closest: closest[0]
          ? { v: closest[0].v, players: closest.flatMap((g) => (state.players[g.id] ? [chip(state.players[g.id] as Player)] : [])) }
          : null,
      };
      break;
    }
    case 'ordering': {
      const correct = correctOrder(q);
      const positionHits = correct.map(() => 0);
      let exactCount = 0;
      for (const id of guests) {
        const p = round.answers[id]?.p;
        if (p?.t !== 'ordering') continue;
        if (results[id]?.correct) exactCount++;
        correct.forEach((cid, k) => {
          if (p.ids[k] === cid) positionHits[k] = (positionHits[k] ?? 0) + 1;
        });
      }
      distribution = { t: 'ordering', exactCount, positionHits };
      break;
    }
  }
  const correctGuests = guests.filter((id) => results[id]?.correct).length;
  const vp = state.vladosId ? state.players[state.vladosId] : undefined;
  const view: RevealView = {
    qid: q.id,
    correct: correctAnswer(q),
    distribution,
    pctCorrect: guests.length ? Math.round((100 * correctGuests) / guests.length) : 0,
    answeredCount: guests.length,
    vlados: vp
      ? { player: chip(vp), answer: round.answers[vp.id]?.p ?? null, result: results[vp.id] ?? null }
      : null,
  };
  if (q.revealText !== undefined) view.revealText = q.revealText;
  const rm = publicQMedia(content, q.revealMedia);
  if (rm) view.revealMedia = rm;
  return view;
}

// ---------- Public view ----------

function brandView(content: Content): BrandView {
  const s = content.settings;
  const brand: BrandView = {
    title: s.title,
    subtitle: s.subtitle,
    vladosLabel: s.vladosLabel,
    themeId: s.themeId,
    gameStartsAt: s.gameStartsAt,
    texts: resolveTexts(s),
    reactions: s.reactions,
    lateJoin: s.lateJoin,
  };
  const bg = mediaRef(content, s.lobbyBgMediaId);
  if (bg) brand.lobbyBg = bg;
  return brand;
}

function pubRound(state: GameState, round: Round, content: Content): PubRound {
  const played = playedQids(state);
  const remaining = content.questions.filter((q) => !q.disabled && !played.has(q.id)).length;
  const r: PubRound = {
    index: state.rounds.slice(0, state.cur).filter((x) => !x.skipped).length,
    total: state.rounds.filter((x) => !x.skipped).length + remaining,
    qid: round.qid,
    q: publicQuestion(round, content),
    double: round.q.double,
    introAt: round.introAt,
    openAt: round.openAt,
    endsAt: round.endsAt,
    timeLimitS: round.q.timeLimitS,
  };
  if (round.lockedAt !== undefined) r.lockedAt = round.lockedAt;
  return r;
}

interface Built {
  view: PubView;
  round: Round | null;
  /** Full ranked board, computed once when a phase needs it. */
  board: () => BoardEntry[];
}

function buildPub(state: GameState, content: Content, ctx: ViewCtx, audience: Audience): Built {
  const chip = chipFor(audience);
  let boardCache: BoardEntry[] | null = null;
  const board = () => (boardCache ??= rankedBoard(state, chip));
  const round = currentRound(state);
  const revealed = round !== null && (state.phase === 'reveal' || state.phase === 'board') && round.results !== undefined;

  let final: FinalView | null = null;
  if (state.phase === 'final') {
    const step = state.finalStep;
    // Top-3 selfies are shown on phones too at the end.
    const podium = board()
      .slice(0, 3)
      .filter((e) => e.rank >= 4 - step)
      .map((e) => {
        const p = state.players[e.id];
        return p?.avatar ? { ...e, avatar: avatarPath(p.avatar) } : e;
      });
    final = { step, podium, vlados: step >= 4 ? vladosComparison(state.rounds, state.players, state.vladosId, chip) : null };
  }

  const view: PubView = {
    rev: viewRev(state, content),
    gameId: state.gameId,
    phase: state.phase,
    phaseRev: state.phaseRev,
    phaseAt: state.phaseAt,
    brand: brandView(content),
    round: round ? pubRound(state, round, content) : null,
    pause: state.pause ? { ...state.pause } : null,
    answeredCount: round ? answeredIds(state, round).length : 0,
    playerCount: Object.values(state.players).filter((p) => !p.kicked).length,
    reveal: revealed ? revealView(state, round, content, chip) : null,
    board: state.phase === 'board' ? board().slice(0, 5) : null,
    final,
    prefetch: state.phase === 'final' ? [] : prefetchFor(nextQuestion(state, content), content),
    cdnBase: ctx.cdnBase,
  };
  return { view, round, board };
}

/** Broadcast to every player. */
export const pubView = (state: GameState, content: Content, ctx: ViewCtx = NO_CTX): PubView =>
  buildPub(state, content, ctx, 'phone').view;

// ---------- TV & admin ----------

function joinInfo(content: Content, ctx: ViewCtx): JoinInfo {
  const { urls } = ctx;
  const mode = content.settings.qrMode;
  const wifi = content.settings.wifi;
  return {
    qrMode: mode,
    qrUrl: urls[mode] ?? urls.direct ?? urls.pages ?? urls.lan ?? null,
    direct: urls.direct,
    pages: urls.pages,
    lan: urls.lan,
    wifi: wifi ? { ...wifi } : null,
  };
}

const byJoin = (a: Player, b: Player) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1);

function tvPlayer(state: GameState, round: Round | null, p: Player): TvPlayer {
  return {
    ...chipOf(p, true),
    answered: round ? round.answers[p.id] !== undefined : false,
    online: p.online,
    isVlados: p.id === state.vladosId,
    joinedAt: p.joinedAt,
  };
}

function buildTv(state: GameState, content: Content, ctx: ViewCtx): { view: TvView; round: Round | null } {
  const { view: pub, round, board } = buildPub(state, content, ctx, 'tv');
  const active = Object.values(state.players).filter((p) => !p.kicked).sort(byJoin);
  let answers: TvAnswer[] | null = null;
  if (pub.reveal && round) {
    answers = answeredIds(state, round)
      .map((id): TvAnswer => {
        const a = round.answers[id] as Round['answers'][Id];
        const res = round.results?.[id];
        return { id, p: a.p, elapsedMs: a.elapsedMs, points: res?.points ?? 0, correct: res?.correct ?? false };
      })
      .sort((a, b) => a.elapsedMs - b.elapsedMs);
  }
  const view: TvView = {
    ...pub,
    players: active.map((p) => tvPlayer(state, round, p)),
    answers,
    top10: state.phase === 'board' ? board().slice(0, 10) : null,
    mosaic: state.phase === 'final' && state.finalStep >= 5 ? active.map((p) => chipOf(p, true)) : null,
    join: joinInfo(content, ctx),
    banner: state.tvBanner,
    sound: { ...content.settings.sound },
    appearance: content.settings.tvAppearance,
  };
  return { view, round };
}

export const tvView = (state: GameState, content: Content, ctx: ViewCtx = NO_CTX): TvView => buildTv(state, content, ctx).view;

export function adminView(state: GameState, content: Content, ctx: ViewCtx = NO_CTX): AdminView {
  const { view: tv, round } = buildTv(state, content, ctx);
  const next = nextQuestion(state, content);
  return {
    ...tv,
    liveAnswers: round ? structuredClone(round.answers) : {},
    next: next ? { qid: next.id, title: next.title, type: next.type } : null,
    rounds: state.rounds.map((r, index) => ({
      index,
      qid: r.qid,
      title: r.q.title,
      skipped: r.skipped === true,
      answered: answeredIds(state, r).length,
    })),
    vladosId: state.vladosId,
    allPlayers: Object.values(state.players)
      .sort(byJoin)
      .map((p) => ({ ...tvPlayer(state, round, p), code: p.code, kicked: p.kicked, bot: p.bot === true })),
  };
}

// ---------- Me ----------

interface MeCtx {
  scored: number;
  ranked: Standing[];
  byId: Map<Id, Standing>;
  /** Index of the last scored round, -1 if none. */
  last: number;
  before: Map<Id, Standing> | null;
}

function meCtx(state: GameState): MeCtx {
  const standings = computeStandings(state.rounds, state.players, state.vladosId);
  const last = lastScoredIndex(state.rounds);
  return {
    scored: scoredCount(state.rounds),
    ranked: standings.filter((s) => s.rank !== null),
    byId: standingsById(standings),
    last,
    before: standingsBefore(state.rounds, last, state.players, state.vladosId),
  };
}

function buildMe(state: GameState, p: Player, c: MeCtx): MeView {
  const isVlados = p.id === state.vladosId;
  const st = c.byId.get(p.id);
  const rank = c.scored > 0 && st?.rank != null ? st.rank : null;
  const above = rank !== null && rank > 1 ? c.ranked[rank - 2] : undefined;
  const round = currentRound(state);
  const mine = round?.answers[p.id];

  let last: MeView['last'] = null;
  const lr = c.last >= 0 ? state.rounds[c.last] : undefined;
  // Someone who joined after that round locked has nothing to show for it.
  if (lr && (lr.answers[p.id] || p.joinedAt <= (lr.lockedAt ?? lr.endsAt))) {
    const res = lr.results?.[p.id];
    last = {
      round: c.last,
      qid: lr.qid,
      points: res?.points ?? 0,
      correct: res?.correct ?? false,
      accuracy: res?.accuracy ?? 0,
      rankBefore: isVlados || p.kicked ? null : (c.before?.get(p.id)?.rank ?? null),
      rankAfter: rank,
    };
    if (res?.closest !== undefined) last.closest = res.closest;
  }

  const view: MeView = {
    rev: state.rev,
    id: p.id,
    name: p.name,
    code: p.code,
    seed: p.seed,
    isVlados,
    score: st?.score ?? 0,
    rank,
    gapToNext: above && st ? above.score - st.score : null,
    rankedCount: c.ranked.length,
    answer: round && mine ? { round: state.cur, p: mine.p, elapsedMs: mine.elapsedMs } : null,
    last,
    kicked: p.kicked,
  };
  if (p.avatar) view.avatar = avatarPath(p.avatar);
  return view;
}

/** Per-player view (own selfie included); null for an unknown id. */
export function meView(state: GameState, playerId: Id): MeView | null {
  const p = state.players[playerId];
  return p ? buildMe(state, p, meCtx(state)) : null;
}

/** Views for many players at once (standings computed once). Defaults to everyone. */
export function meViews(state: GameState, ids: readonly Id[] = Object.keys(state.players)): Record<Id, MeView> {
  const c = meCtx(state);
  const out: Record<Id, MeView> = {};
  for (const id of ids) {
    const p = state.players[id];
    if (p) out[id] = buildMe(state, p, c);
  }
  return out;
}
