// View models sent to clients. Screens render these as props and never touch the socket.
// See docs/architecture.md → "Views". Every view carries `rev`; clients drop older revs.

import type {
  Answer,
  AnswerPayload,
  Appearance,
  Id,
  Item,
  MediaAsset,
  PauseReason,
  Phase,
  QrMode,
  RoundResult,
  Settings,
  TextKey,
} from './types';

// ---------- Building blocks ----------

/** Media as clients need it: URLs are built from cdnBase (+ Mac `/m/` fallback) and these file names. */
export interface MediaRef {
  id: Id;
  kind: MediaAsset['kind'];
  files: MediaAsset['files'];
  w: number;
  h: number;
  durationS?: number;
}

export interface PublicQMedia {
  media: MediaRef;
  onPhones: boolean;
  startAtS?: number;
}

export interface PublicItem extends Item {
  media?: MediaRef;
}

interface PublicQBase {
  id: Id;
  title: string;
  media?: PublicQMedia;
  double: boolean;
  timeLimitS: number;
}

/** A question WITHOUT its correct answer. */
export type PublicQuestion =
  | (PublicQBase & { type: 'choice'; options: PublicItem[] })
  | (PublicQBase & { type: 'number'; unit?: string; min?: number; max?: number; step: number })
  | (PublicQBase & {
      type: 'ordering';
      /** In the shared shuffled order (Round.shown), never the correct one. */
      items: PublicItem[];
      firstLabel: string;
      lastLabel: string;
    });

/** What a player looks like to others. Phones draw a sigil from `seed`; `avatar` is set only where a selfie may be shown. */
export interface PlayerChip {
  id: Id;
  name: string;
  seed: number;
  /** Selfie URL path (e.g. `/avatars/<file>`), present only when this client may load it. */
  avatar?: string;
}

export interface BoardEntry extends PlayerChip {
  score: number;
  rank: number;
  prevRank: number | null;
  /** Points earned in the last played round. */
  delta: number;
  correctCount: number;
}

export type CorrectAnswer =
  | { t: 'choice'; id: Id }
  | { t: 'number'; v: number; unit?: string; tolerance: number }
  | { t: 'ordering'; ids: Id[] };

export type Distribution =
  | { t: 'choice'; counts: Record<Id, number> }
  | {
      t: 'number';
      /** Guests' guesses, sorted ascending. */
      values: number[];
      median: number | null;
      closest: { v: number; players: PlayerChip[] } | null;
    }
  | {
      t: 'ordering';
      exactCount: number;
      /** Per correct position: how many guests put the right item there. */
      positionHits: number[];
    };

export interface RevealView {
  qid: Id;
  correct: CorrectAnswer;
  distribution: Distribution;
  /** 0..100, guests only. */
  pctCorrect: number;
  answeredCount: number;
  /** null when no Vlados is set. */
  vlados: { player: PlayerChip; answer: AnswerPayload | null; result: RoundResult | null } | null;
  revealText?: string;
  revealMedia?: PublicQMedia;
}

export interface VladosComparison {
  player: PlayerChip;
  /** Mean accuracy 0..1 over played rounds. */
  vladosAccuracy: number;
  /** Mean accuracy of guests who answered ≥ half of the rounds. */
  guestsAccuracy: number;
  bestGuest: (PlayerChip & { accuracy: number }) | null;
  /** best: beats everyone; middle: beats the average, not the best guest; worst: below average. */
  verdict: 'best' | 'middle' | 'worst';
}

export interface FinalView {
  step: number;
  /** Only the places already revealed by `step` (3rd at 1, 2nd at 2, 1st at 3) — no spoilers. */
  podium: BoardEntry[];
  /** Present from step 4. */
  vlados: VladosComparison | null;
}

/** Organizer-editable strings and titles, with defaults merged and `{vlados}` substituted. */
export interface BrandView {
  title: string;
  subtitle: string;
  vladosLabel: string;
  themeId: string;
  gameStartsAt: string;
  lobbyBg?: MediaRef;
  texts: Record<TextKey, string>;
  reactions: boolean;
  lateJoin: boolean;
}

export interface PubRound {
  /** 0-based index among played + remaining rounds. */
  index: number;
  total: number;
  qid: Id;
  q: PublicQuestion;
  double: boolean;
  introAt: number;
  openAt: number;
  endsAt: number;
  lockedAt?: number;
  timeLimitS: number;
}

// ---------- Views ----------

/** Broadcast to every player. */
export interface PubView {
  rev: number;
  gameId: Id;
  phase: Phase;
  phaseRev: number;
  phaseAt: number;
  brand: BrandView;
  round: PubRound | null;
  pause: { at: number; remainingMs: number; reason: PauseReason } | null;
  answeredCount: number;
  playerCount: number;
  /** Set during reveal and board for the current round. */
  reveal: RevealView | null;
  /** Top 5, set during board. */
  board: BoardEntry[] | null;
  final: FinalView | null;
  /** Media of the next question for early download. */
  prefetch: MediaRef[];
  /** e.g. `https://valorin777.github.io/vlados` — null when the CDN is not usable. */
  cdnBase: string | null;
}

/** Per player, sent on change. */
export interface MeView {
  rev: number;
  id: Id;
  name: string;
  code: string;
  seed: number;
  avatar?: string;
  isVlados: boolean;
  score: number;
  /** null for Vlados («вне конкурса») and before the first scored round. */
  rank: number | null;
  /** Points to the next place up; null when first or unranked. */
  gapToNext: number | null;
  rankedCount: number;
  /** My answer in the current round, if any. */
  answer: { round: number; p: AnswerPayload; elapsedMs: number } | null;
  last: {
    round: number;
    qid: Id;
    points: number;
    correct: boolean;
    accuracy: number;
    closest?: boolean;
    rankBefore: number | null;
    rankAfter: number | null;
  } | null;
  kicked: boolean;
}

export interface TvPlayer extends PlayerChip {
  answered: boolean;
  online: boolean;
  isVlados: boolean;
  joinedAt: number;
}

export interface TvAnswer {
  id: Id;
  p: AnswerPayload;
  elapsedMs: number;
  points: number;
  correct: boolean;
}

export interface JoinInfo {
  qrMode: QrMode;
  /** The URL encoded in the big QR (depends on qrMode). */
  qrUrl: string | null;
  direct: string | null;
  pages: string | null;
  lan: string | null;
  wifi: { ssid: string; password: string } | null;
}

export interface TvView extends PubView {
  /** Kicked players are omitted. */
  players: TvPlayer[];
  /** Every answer, set at reveal. */
  answers: TvAnswer[] | null;
  /** Top 10 with previous ranks, set during board. */
  top10: BoardEntry[] | null;
  /** Selfies (or sigils) of everyone for the final mosaic, set at final step 5. */
  mosaic: PlayerChip[] | null;
  join: JoinInfo;
  banner: string | null;
  sound: Settings['sound'];
  /** TV appearance chosen in admin Settings. */
  appearance: Appearance;
}

export interface AdminRoundSummary {
  index: number;
  qid: Id;
  title: string;
  skipped: boolean;
  answered: number;
}

export interface AdminView extends TvView {
  /** Live answers before reveal (player id → answer). */
  liveAnswers: Record<Id, Answer>;
  next: { qid: Id; title: string; type: PublicQuestion['type'] } | null;
  rounds: AdminRoundSummary[];
  vladosId: Id | null;
  /** Players with kicked ones included, for the players tab. */
  allPlayers: (TvPlayer & { code: string; kicked: boolean; bot: boolean })[];
}

// ---------- System ----------

export interface TunnelStatus {
  name: string;
  url: string | null;
  healthy: boolean;
  latencyMs: number | null;
  restarts: number;
  lastError?: string;
  since?: number;
}

export interface SystemStatus {
  at: number;
  uptimeS: number;
  gameId: Id;
  tunnels: TunnelStatus[];
  liveJson: { state: 'off' | 'pending' | 'ok' | 'error'; url?: string; publishedAt?: number; error?: string };
  git: { queue: number; busy: boolean; lastPushAt: number | null; lastError: string | null };
  connections: {
    total: number;
    byRole: { player: number; tv: number; admin: number };
    byTransport: { websocket: number; polling: number };
  };
  memory: { rssMB: number; heapUsedMB: number };
  loopLag: { p50Ms: number; p99Ms: number; maxMs: number };
  localUrl: string;
  lanUrl: string | null;
}
