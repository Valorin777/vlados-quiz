// Socket.IO contract. See docs/architecture.md → "Protocol".

import type { AnswerPayload, Content, Id, MediaAsset, Question, QrMode, Settings } from './types';
import type { AdminView, MeView, PubView, SystemStatus, TvView } from './views';

export const PROTOCOL_V = 1;

export type Role = 'player' | 'tv' | 'admin';

/** Sent as `io(url, { auth: Handshake })`. */
export type Handshake =
  | { role: 'player'; token?: string; v: 1 }
  | { role: 'tv'; key: string; v: 1 }
  | { role: 'admin'; key?: string; session?: string; v: 1 };

/** Socket.IO delivers binaries as ArrayBuffer in browsers and Buffer (a Uint8Array) in Node. */
export type Binary = ArrayBuffer | Uint8Array;

// ---------- Ack results ----------

/** Errors any ack may return besides its own ones. */
export type CommonErr = 'rate_limited' | 'server';

export type Ok<T extends object = object> = { ok: true } & T;
export type Err<E extends string> = { ok: false; err: E | CommonErr; msg?: string };
export type Result<T extends object, E extends string> = Ok<T> | Err<E>;
export type Ack<T extends object, E extends string> = (res: Result<T, E>) => void;

export type JoinErr = 'name_taken' | 'bad_name' | 'full' | 'closed';
export type RecoverErr = 'not_found' | 'kicked';
export type AvatarErr = 'too_big' | 'bad_type' | 'no_player';
/** Resending the same cid is not an error (acked again with the stored elapsedMs); 'dup' = a different answer for an answered round. */
export type AnswerErr = 'not_open' | 'closed' | 'dup' | 'invalid' | 'kicked';
export type CmdErr = 'stale' | 'invalid' | 'forbidden';
export type ContentErr = 'invalid' | 'forbidden' | 'not_found';
export type LoginErr = 'bad_password';

// ---------- Payloads ----------

export interface JoinReq {
  name: string;
  avatar?: Binary;
  mime?: string;
}
export interface JoinOk {
  token: string;
  id: Id;
  code: string;
}

export interface RecoverReq {
  name: string;
  code: string;
}

export interface AvatarReq {
  data: Binary;
  mime: string;
}
export interface AvatarOk {
  /** New selfie URL path. */
  avatar: string;
}

export interface AnswerReq {
  /** Round index (GameState.cur at the time of answering). */
  round: number;
  p: AnswerPayload;
  elapsedMs: number;
  cid: string;
}
export interface AnswerOk {
  elapsedMs: number;
}

export interface Hello {
  v: 1;
  serverNow: number;
  gameId: Id;
  role: Role;
  /** Players only, once identified (token restored or after join). */
  you?: { id: Id };
}

/** [playerId, index into REACTIONS] */
export type ReactionEvent = [Id, number];

/** Shallow patch; `null` removes an optional field (JSON can't carry `undefined`). */
export type SettingsPatch = Partial<Omit<Settings, 'wifi' | 'lobbyBgMediaId' | 'finaleMediaId'>> & {
  wifi?: Settings['wifi'] | null;
  lobbyBgMediaId?: Id | null;
  finaleMediaId?: Id | null;
};

// ---------- Admin commands ----------

export type AdminCmd =
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
  | { type: 'rescoreRound'; round: number }
  | { type: 'kick'; id: Id }
  | { type: 'unkick'; id: Id }
  | { type: 'removeAvatar'; id: Id }
  | { type: 'rename'; id: Id; name: string }
  | { type: 'setVlados'; id: Id | null }
  | { type: 'merge'; from: Id; into: Id }
  | { type: 'tvBanner'; text: string | null }
  /** «Стоп-экран»: the text on the TV AND the whole show paused in any phase (see reduce.ts → hold). */
  | { type: 'hold'; phaseRev: number; text: string }
  /** Ends the hold: text gone, the show continues exactly where it stopped. */
  | { type: 'unhold' }
  | { type: 'qrMode'; mode: QrMode }
  | { type: 'openTv' }
  | { type: 'bots'; n: number };

export type AdminCmdType = AdminCmd['type'];

/** Commands that must carry the current phaseRev (a double tap gets 'stale'). */
export const PHASE_REV_CMDS = ['advance', 'reveal', 'skip'] as const satisfies readonly AdminCmdType[];

// ---------- Events ----------

export interface ClientToServerEvents {
  /** Clock sync ping: client sends its Date.now(), server answers with its own. */
  time: (t0: number, ack: (serverNow: number) => void) => void;
  join: (req: JoinReq, ack: Ack<JoinOk, JoinErr>) => void;
  recover: (req: RecoverReq, ack: Ack<JoinOk, RecoverErr>) => void;
  avatar: (req: AvatarReq, ack: Ack<AvatarOk, AvatarErr>) => void;
  answer: (req: AnswerReq, ack: Ack<AnswerOk, AnswerErr>) => void;
  /** Index into REACTIONS (0..7). Fire-and-forget. */
  react: (emojiIndex: number) => void;
  /** Diagnostics page round-trip test. */
  diagEcho: (buf: Binary, ack: (buf: Binary) => void) => void;

  // Admin only.
  cmd: (cmd: AdminCmd, ack: Ack<{ phaseRev: number }, CmdErr>) => void;
  qUpsert: (q: Question, ack: Ack<{ rev: number }, ContentErr>) => void;
  qDelete: (id: Id, ack: Ack<{ rev: number }, ContentErr>) => void;
  qRestore: (id: Id, ack: Ack<{ rev: number }, ContentErr>) => void;
  qDuplicate: (id: Id, ack: Ack<{ rev: number; id: Id }, ContentErr>) => void;
  /** Full list of question ids in the new order. */
  qReorder: (ids: Id[], ack: Ack<{ rev: number }, ContentErr>) => void;
  settingsPatch: (patch: SettingsPatch, ack: Ack<{ rev: number }, ContentErr>) => void;
  /** Phone admin login; the session token is then passed as Handshake.session. */
  login: (password: string, ack: Ack<{ session: string }, LoginErr>) => void;
}

export interface ServerToClientEvents {
  hello: (h: Hello) => void;
  pub: (v: PubView) => void;
  me: (v: MeView) => void;
  tv: (v: TvView) => void;
  admin: (v: AdminView) => void;
  /** Ids of players who answered since the last batch (150 ms), tv + admin. */
  answered: (ids: Id[]) => void;
  /** Batched every 100 ms, capped at 25/s to the TV. */
  reactions: (list: ReactionEvent[]) => void;
  /** Full content, admin only. */
  content: (c: Content) => void;
  /** Changed media assets (processing progress, CDN state), admin only. */
  media: (assets: MediaAsset[]) => void;
  sys: (s: SystemStatus) => void;
  kicked: () => void;
}

// Single process, no adapter.
export type InterServerEvents = Record<never, never>;

export interface SocketData {
  role: Role;
  /** Set for players once identified. */
  playerId?: Id;
  /** How an admin authenticated. */
  adminVia?: 'key' | 'session';
  connectedAt: number;
}

/** `Error.message` of a refused handshake (the client sees it in `connect_error`). */
export type HandshakeErr = 'forbidden' | 'bad_version';

// ---------- HTTP discovery ----------

/** `GET /health` on the game server. Discovery accepts a server only if it answers with a gameId. */
export interface HealthResponse {
  ok: true;
  v: 1;
  gameId: Id;
  serverNow: number;
}

/**
 * `live.json` next to the SPA on Pages, republished by the launcher when tunnel URLs change.
 * `headers`: extra request headers per tunnel (e.g. an interstitial bypass), keyed by the server's
 * origin (`https://abc.example`). Clients send them with /health and socket.io polling requests.
 */
export interface LiveJson {
  v: 1;
  server: string | null;
  alt: string[];
  gameId: Id;
  headers: Record<string, Record<string, string>>;
  updatedAt: string;
}
