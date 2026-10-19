// Typed Firestore references for every document in docs/firebase.md, plus the converters that turn
// wire values into app values (Timestamp → server ms, Bytes → Uint8Array) and back.
// Works with any Firestore instance (the app's, or a test's in Node).

import type { AnswerPayload } from '@shared/types';
import {
  FB_PATHS,
  type AdminContentDoc,
  type AnswerDoc,
  type ClockProbeDoc,
  type ConfigAdminsDoc,
  type ConfigCurrentDoc,
  type GameDoc,
  type GamePrivateDoc,
  type MediaChunkDoc,
  type MediaMetaDoc,
  type PlayerDoc,
  type ReactionDoc,
} from '@shared/fbtypes';
import {
  Bytes,
  Timestamp,
  collection,
  doc,
  serverTimestamp,
  type CollectionReference,
  type DocumentData,
  type DocumentReference,
  type Firestore,
  type FirestoreDataConverter,
  type PartialWithFieldValue,
  type QueryDocumentSnapshot,
  type SnapshotOptions,
  type WithFieldValue,
} from 'firebase/firestore';

// ---------- Value conversion ----------

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

type TimestampLike = { seconds: number; nanoseconds: number; toMillis(): number };
type BytesLike = { toUint8Array(): Uint8Array; toBase64(): string };

// Duck-typed so it survives duplicate SDK copies (e.g. a test runner loading two builds).
const isTimestamp = (v: object): v is TimestampLike =>
  typeof (v as Partial<TimestampLike>).toMillis === 'function' && 'seconds' in v && 'nanoseconds' in v;
const isBytes = (v: object): v is BytesLike =>
  typeof (v as Partial<BytesLike>).toUint8Array === 'function' && typeof (v as Partial<BytesLike>).toBase64 === 'function';

/** Wire → app, deep: Timestamp → epoch ms, Bytes → Uint8Array. Everything else unchanged. */
export function fromFirestoreValue(v: unknown): unknown {
  if (typeof v !== 'object' || v === null) return v;
  if (Array.isArray(v)) return v.map(fromFirestoreValue);
  if (isTimestamp(v)) return v.toMillis();
  if (isBytes(v)) return v.toUint8Array();
  if (!isPlainObject(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = fromFirestoreValue(x);
  return out;
}

/** App → wire, deep: Uint8Array → Bytes. Sentinels (serverTimestamp(), deleteField()) pass through. */
export function toFirestoreValue(v: unknown): unknown {
  if (v instanceof Uint8Array) return Bytes.fromUint8Array(v);
  if (Array.isArray(v)) return v.map(toFirestoreValue);
  if (!isPlainObject(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = toFirestoreValue(x);
  return out;
}

/**
 * Query values are NOT converted: fields stored as Timestamps (answer/reaction `at`, player
 * joinedAt/seenAt, media createdAt) must be compared with this, e.g.
 * `where('at', '>', tsFromMs(startMs))` — a plain number never matches a Timestamp.
 */
export const tsFromMs = (ms: number): Timestamp => Timestamp.fromMillis(ms);

/** For updateDoc(), which bypasses converters: converts Uint8Array values in a field patch. */
export const toFirestorePatch = (patch: Record<string, unknown>): Record<string, unknown> =>
  toFirestoreValue(patch) as Record<string, unknown>;

const genericConverter: FirestoreDataConverter<DocumentData, DocumentData> = {
  toFirestore(model: PartialWithFieldValue<DocumentData>): DocumentData {
    return toFirestoreValue(model) as DocumentData;
  },
  fromFirestore(snap: QueryDocumentSnapshot, options?: SnapshotOptions): DocumentData {
    // Pending serverTimestamp() fields read as a local estimate instead of null.
    return fromFirestoreValue(snap.data({ serverTimestamps: 'estimate', ...options })) as DocumentData;
  },
};

export const converter = <T extends object>(): FirestoreDataConverter<T, DocumentData> =>
  genericConverter as unknown as FirestoreDataConverter<T, DocumentData>;

// ---------- References ----------

export function fbRefs(db: Firestore) {
  const d = <T extends object>(path: string): DocumentReference<T, DocumentData> => doc(db, path).withConverter(converter<T>());
  const c = <T extends object>(path: string): CollectionReference<T, DocumentData> =>
    collection(db, path).withConverter(converter<T>());
  return {
    configCurrent: () => d<ConfigCurrentDoc>(FB_PATHS.configCurrent),
    configAdmins: () => d<ConfigAdminsDoc>(FB_PATHS.configAdmins),
    clockProbe: (uid: string) => d<ClockProbeDoc>(FB_PATHS.clockProbe(uid)),
    adminContent: () => d<AdminContentDoc>(FB_PATHS.adminContent),
    /** Admins only (the rules refuse listing media to everyone else). */
    mediaList: () => c<MediaMetaDoc>(FB_PATHS.media),
    mediaMeta: (id: string) => d<MediaMetaDoc>(FB_PATHS.mediaMeta(id)),
    mediaChunk: (id: string, i: number) => d<MediaChunkDoc>(FB_PATHS.mediaChunk(id, i)),
    mediaChunks: (id: string) => c<MediaChunkDoc>(FB_PATHS.mediaChunks(id)),
    games: () => c<GameDoc>(FB_PATHS.games),
    game: (g: string) => d<GameDoc>(FB_PATHS.game(g)),
    gamePrivate: (g: string, name: string) => d<GamePrivateDoc>(FB_PATHS.gamePrivate(g, name)),
    players: (g: string) => c<PlayerDoc>(FB_PATHS.players(g)),
    player: (g: string, uid: string) => d<PlayerDoc>(FB_PATHS.player(g, uid)),
    answers: (g: string) => c<AnswerDoc>(FB_PATHS.answers(g)),
    answer: (g: string, round: number, uid: string) => d<AnswerDoc>(FB_PATHS.answer(g, round, uid)),
    reactions: (g: string) => c<ReactionDoc>(FB_PATHS.reactions(g)),
    reaction: (g: string, uid: string, bucket: number) => d<ReactionDoc>(FB_PATHS.reaction(g, uid, bucket)),
  };
}

export type FbRefs = ReturnType<typeof fbRefs>;

// ---------- Write builders (fields the rules pin to request.time use serverTimestamp()) ----------

export function newPlayerDoc(p: { name: string; seed: number; avatar?: Uint8Array; thumb?: Uint8Array }): WithFieldValue<PlayerDoc> {
  return {
    name: p.name,
    seed: p.seed,
    kicked: false,
    joinedAt: serverTimestamp(),
    seenAt: serverTimestamp(),
    ...(p.avatar ? { avatar: p.avatar } : {}),
    ...(p.thumb ? { thumb: p.thumb } : {}),
  };
}

export const newAnswerDoc = (uid: string, round: number, p: AnswerPayload): WithFieldValue<AnswerDoc> => ({
  uid,
  round,
  p,
  at: serverTimestamp(),
});

export const newReactionDoc = (uid: string, e: number): WithFieldValue<ReactionDoc> => ({ uid, e, at: serverTimestamp() });
