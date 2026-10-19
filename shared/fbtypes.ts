// Firestore document shapes (docs/firebase.md → Firestore layout). SDK-agnostic: this is how the
// app sees a document after the converters in app/src/fb/refs.ts, i.e. Timestamps become
// milliseconds and Bytes become Uint8Array. firestore.rules validates exactly these fields.
//
// Time fields named *At that the rules pin to `request.time` (joinedAt, seenAt, answer/reaction
// `at`, media createdAt, clock probe `t`) are Firestore Timestamps on the wire, written with
// serverTimestamp(). Game timing fields inside `games/{g}` (introAt, openAt, endsAt, host.until,
// pause.at, pub.startsAt) are plain numbers in SERVER milliseconds (serverNow()).

import fbconfig from './fbconfig.json';
import type { AnswerPayload, Appearance, Id, PauseReason, Phase, Question, QuestionType, Settings, TextKey } from './types';

// ---------- Projects & limits ----------

export type FbEnv = 'prod' | 'dev';

/** Public web config (API keys of Firebase web apps are not secrets). */
export interface FbProjectConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  messagingSenderId: string;
}

export const FB_PROJECTS: Readonly<Record<FbEnv, FbProjectConfig>> = fbconfig.projects;

/** Shared with firestore.rules (tools/gen-rules.mjs substitutes them into the template). */
export const FB_LIMITS: Readonly<typeof fbconfig.limits> = fbconfig.limits;

// ---------- Ids & paths ----------

/** Milliseconds on the server clock (see app/src/fb/clock.ts). */
export type ServerMs = number;

export const DEFAULT_GAME_ID = 'main';

/** Ids we create (games, media, questions): what the rules accept in paths and id fields. */
export const FB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const isFbId = (v: unknown): v is string => typeof v === 'string' && FB_ID_RE.test(v);

/**
 * The rules check the player name with string.size(), which counts UTF-16 code units (same as
 * HTML maxlength and JS .length): 1–20. Stricter than normalizeName's 20 graphemes for emoji, so
 * the join form must apply both (normalizeName first).
 */
export const fbNameOk = (name: string): boolean => name.length >= 1 && name.length <= FB_LIMITS.nameMax;

/** `games/{g}/answers/{round}_{uid}` — one answer per player per round (create-only). */
export const answerId = (round: number, uid: string): string => `${round}_${uid}`;

/** Rate-limit bucket of a reaction sent at server time `serverMs`. */
export const reactionBucket = (serverMs: ServerMs): number => Math.floor(serverMs / FB_LIMITS.reactionBucketMs);

/** `games/{g}/reactions/{uid}_{bucket}` — the rules accept buckets within ±1 of the server's. */
export const reactionId = (uid: string, bucket: number): string => `${uid}_${bucket}`;

export const FB_PATHS = {
  configCurrent: 'config/current',
  configAdmins: 'config/admins',
  clockProbe: (uid: string) => `config/clock_${uid}`,
  adminContent: 'admin/content',
  media: 'media',
  mediaMeta: (id: Id) => `media/${id}`,
  mediaChunks: (id: Id) => `media/${id}/c`,
  mediaChunk: (id: Id, i: number) => `media/${id}/c/${i}`,
  games: 'games',
  game: (g: Id) => `games/${g}`,
  gamePrivate: (g: Id, doc: string) => `games/${g}/private/${doc}`,
  /** Host bookkeeping (rounds with answers + frozen results): see app/src/host/model.ts. */
  gameTotals: (g: Id) => `games/${g}/private/totals`,
  /** Host lease { session, until, … } — kept out of the public doc so renewals cost players nothing. */
  gameLease: (g: Id) => `games/${g}/private/host`,
  players: (g: Id) => `games/${g}/players`,
  player: (g: Id, uid: string) => `games/${g}/players/${uid}`,
  answers: (g: Id) => `games/${g}/answers`,
  answer: (g: Id, round: number, uid: string) => `games/${g}/answers/${answerId(round, uid)}`,
  reactions: (g: Id) => `games/${g}/reactions`,
  reaction: (g: Id, uid: string, bucket: number) => `games/${g}/reactions/${reactionId(uid, bucket)}`,
} as const;

// ---------- config/* ----------

/** `config/current` — public read, admin write. */
export interface ConfigCurrentDoc {
  gameId: Id;
}

/** `config/admins` — admin read/write. Lower-case emails that count as admins besides the built-in ones. */
export interface ConfigAdminsDoc {
  emails: string[];
}

/** `config/clock_{uid}` — an admin's clock probe (serverTimestamp written, then read back). */
export interface ClockProbeDoc {
  t: ServerMs;
}

// ---------- admin/content (ADMIN ONLY) ----------

export interface AdminContentDoc {
  rev: number;
  settings: Settings;
  /** With correct answers — never copy these into `games/{g}` before the reveal. */
  questions: Question[];
  trash: { q: Question; at: number }[];
  updatedAt?: ServerMs;
}

// ---------- media/{id} + media/{id}/c/{i} ----------

export type MediaKind = 'image' | 'video';

/** Written LAST, after every chunk: its existence means the upload is complete. */
export interface MediaMetaDoc {
  kind: MediaKind;
  mime: string;
  w: number;
  h: number;
  durationS?: number;
  /** Total size of the assembled file. */
  bytes: number;
  /** Number of chunk docs `c/0 … c/{chunks-1}`. */
  chunks: number;
  /** Video poster frame (an image media id). */
  posterId?: Id;
  createdAt: ServerMs;
}

export interface MediaChunkDoc {
  /** ≤ FB_LIMITS.chunkMaxBytes. */
  d: Uint8Array;
}

// ---------- games/{g} (PUBLIC: every signed-in client reads it) ----------

export interface PubInfo {
  title: string;
  subtitle: string;
  /** Texts with defaults merged and `{vlados}` substituted. */
  texts: Partial<Record<TextKey, string>>;
  /** Pre-game countdown target, epoch ms. */
  startsAt: number;
  /** Reactions bar enabled. */
  reactions: boolean;
  lobbyBg?: Id;
  /** Appearance phones start with until the player picks one. */
  themeDefault: Appearance;
  /** Joining after the lobby is allowed (the join screen and the rules check it). */
  lateJoin?: boolean;
  /**
   * Settings.maxPlayers. The rules refuse a join while `players` (the host-maintained count, pushed
   * at most every 15 s) is at or above it, so the cap is approximate but bounds junk player docs.
   */
  maxPlayers?: number;
  /** Settings.vladosLabel (texts already have it substituted). */
  vladosLabel?: string;
  themeId?: string;
}

export interface PubMedia {
  mediaId: Id;
  kind: MediaKind;
  /** false → phones show «Видео — на большом экране» / «смотри на экран». */
  onPhones: boolean;
  startAtS?: number;
  posterId?: Id;
  /** Pixel size of the file (a video's poster has the same proportions): frames are sized before it decodes. */
  w?: number;
  h?: number;
  /**
   * Main media of a round that is a video: the watch stage's window (video + tail, ms). While the
   * phase is 'intro' the TV plays the video from openAt − WATCH.beatMs − watchMs and the phones
   * show «смотри на экран»; the answers open WATCH.beatMs after the video ended (openAt moves in
   * when the TV reports the end). See shared/engine/watch.ts.
   */
  watchMs?: number;
  /** The video's own length inside watchMs (from startAtS), ms; absent when unknown. Phones fill their progress bar over it. */
  videoMs?: number;
}

export interface PubItem {
  id: Id;
  text?: string;
  mediaId?: Id;
}

/** The current question as players see it: NO correct answer. */
export interface RoundPub {
  /** Round index (0-based); answers carry it. Never reused within a game (resetScores continues the count). */
  i: number;
  /** 1-based question number shown to people (skipped rounds do not count). */
  n?: number;
  total: number;
  qid: Id;
  type: QuestionType;
  title: string;
  media?: PubMedia;
  double: boolean;
  timeLimitS: number;
  /** choice */
  options?: PubItem[];
  /** number */
  number?: { min?: number; max?: number; step: number; unit?: string };
  /** ordering: the shared shuffled order (never the correct one) */
  items?: PubItem[];
  firstLabel?: string;
  lastLabel?: string;
  introAt: ServerMs;
  /** Answers are accepted from openAt − 500 ms … */
  openAt: ServerMs;
  /** … to endsAt + 2000 ms (FB_LIMITS.answerEarlyMs / answerLateMs), while phase is open|locked. */
  endsAt: ServerMs;
}

export interface PausePub {
  at: ServerMs;
  remainingMs: number;
  reason: PauseReason;
}

export interface RevealMe {
  /** Points this round. */
  pts: number;
  /** Total after this round. */
  tot: number;
  /** null for Vlados («вне конкурса»). */
  rank: number | null;
  prev: number | null;
  ok: boolean;
  /** Accuracy 0..1 (2 decimals) when neither 0 nor 1 — drives «почти» for number/ordering. */
  acc?: number;
  /** Number questions: this player was (one of) the closest. */
  cl?: boolean;
}

export interface RevealPub {
  /** Round index this reveal belongs to. */
  i: number;
  /** choice: option id · number: the answer · ordering: ids in the correct order. */
  correct: Id | number | Id[];
  /** choice: option id → count; number/ordering: bucket label → count. */
  dist: Record<string, number>;
  /** Share of correct answers among guests who answered (Vlados excluded), 0..1. */
  pct: number;
  /**
   * number: bucket width when `dist` keys are bucket lower bounds (absent → keys are exact values).
   * ordering: `dist` keys are "how many items were in the right place" ("0" … "n").
   */
  bin?: number;
  /** Guests who answered. */
  count?: number;
  vlados?: AnswerPayload | null;
  media?: PubMedia;
  text?: string;
  me: Record<string, RevealMe>;
}

export interface BoardRow {
  uid: string;
  name: string;
  score: number;
  rank: number;
  prev: number | null;
  /** Points earned in the last scored round. */
  delta?: number;
}

export interface BoardPub {
  top: BoardRow[];
}

export interface PodiumRow {
  uid: string;
  /** 1, 2 or 3. */
  rank: number;
  name: string;
  score: number;
  /** ≤ FB_LIMITS.thumbMaxBytes JPEG. */
  thumb?: Uint8Array;
}

export interface FinalVlados {
  uid: string;
  name: string;
  vladosAccuracy: number;
  guestsAccuracy: number;
  best: { uid: string; name: string; accuracy: number } | null;
  verdict: 'best' | 'middle' | 'worst';
}

/** The video after the final on air (final step 6, shared/engine/finale.ts). */
export interface FinaleVideoPub {
  /** Server time the TV starts the video: the step's start + FINALE.leadMs (moves with a hold). */
  at: ServerMs;
  /** The video's length, ms. */
  ms: number;
  /** The uploaded video (Settings.finaleMediaId); absent: the built-in clip (app/public/finale.mp4). */
  id?: Id;
  /** Its poster — all the phones ever show of it. */
  poster?: Id;
  /** Pixel size (media meta): the frame takes the video's proportions. */
  w?: number;
  h?: number;
}

export interface FinalPub {
  /**
   * 0 drumroll, 1 third, 2 second, 3 first+confetti, 4 Vlados comparison, 5 mosaic+thanks,
   * 6 the video after the final (when Settings.finaleVideo is not 'off').
   */
  step: number;
  podium: PodiumRow[];
  vlados?: FinalVlados | null;
  /** Everyone's final total and rank — only from step 3 on (no podium spoilers before). */
  me?: Record<string, { tot: number; rank: number | null }>;
  /** Step 6: the video after the final. */
  video?: FinaleVideoPub;
}

/**
 * The «Сюрприз» interrupt on air (shared/engine/surprise.ts), in `next.surprise` — published only
 * once it runs (phase 'locked' of a surprise round), so nothing gives it away before.
 */
export interface SurprisePub {
  /** Server time the TV's breakdown starts (the round's lockedAt; moves with a hold). */
  at: ServerMs;
  /** The video's length, ms (it starts SURPRISE.glitchMs + blackMs after `at`). */
  ms: number;
  /** An uploaded video; absent: the built-in one (app/public/surprise.mp4). */
  id?: Id;
  poster?: Id;
  /** Pixel size (media meta): the frame takes the video's proportions. */
  w?: number;
  h?: number;
}

/**
 * Host lease: only the holder runs timed transitions. The live lease is `games/{g}/private/host`
 * (renewed every few seconds, so it stays out of the doc every phone listens to); the public
 * `host` field is kept for compatibility and written as null.
 */
export interface HostLease {
  session: string;
  until: ServerMs;
}

export interface GameDoc {
  pub: PubInfo;
  phase: Phase;
  phaseRev: number;
  round: RoundPub | null;
  pause: PausePub | null;
  /** Answered count for the open round, pushed at most every 5 s. */
  answered: number;
  /** Joined (non-kicked) players. */
  players: number;
  /** Only in phases reveal/board/final — the rules refuse it during intro/open/locked. */
  reveal: RevealPub | null;
  board: BoardPub | null;
  final: FinalPub | null;
  vladosUid: string | null;
  host: HostLease | null;
  banner: string | null;
  /**
   * Media to prefetch for the next question (set one phase early). `surprise`: the «Сюрприз»
   * stage on air — it lives here because the rules whitelist the keys of the doc and of `round`,
   * and `next` is a free map (no rules deploy needed).
   */
  next: { media: Id[]; surprise?: SurprisePub } | null;
  /** Players that were kicked (so their phones can show it without reading their own doc). */
  kicked?: string[];
}

export const GAME_KEYS = [
  'pub',
  'phase',
  'phaseRev',
  'round',
  'pause',
  'answered',
  'players',
  'reveal',
  'board',
  'final',
  'vladosUid',
  'host',
  'banner',
  'next',
  'kicked',
] as const satisfies readonly (keyof GameDoc)[];

// ---------- games/{g}/players/{uid} (owner or admin) ----------

export interface PlayerDoc {
  /** 1–20 UTF-16 code units (fbNameOk). */
  name: string;
  /** JPEG ≤ 40 KB, 256 px. */
  avatar?: Uint8Array;
  /** JPEG ≤ 6 KB, 64 px. */
  thumb?: Uint8Array;
  /** Sigil seed, unsigned 32-bit. */
  seed: number;
  /** == request.time at create. */
  joinedAt: ServerMs;
  kicked: boolean;
  /** == request.time; updated on join/reconnect (doubles as the player's clock probe). */
  seenAt: ServerMs;
}

// ---------- games/{g}/answers/{round}_{uid} (create-only by owner; admin reads) ----------

export interface AnswerDoc {
  uid: string;
  round: number;
  p: AnswerPayload;
  /** == request.time: the server receive time used for scoring. */
  at: ServerMs;
}

// ---------- games/{g}/reactions/{uid}_{bucket} (create-only by owner; admin reads) ----------

export interface ReactionDoc {
  uid: string;
  /** Index into REACTIONS (0..7). */
  e: number;
  at: ServerMs;
}

// ---------- games/{g}/private/* (ADMIN ONLY, host bookkeeping) ----------

export type GamePrivateDoc = Record<string, unknown>;
