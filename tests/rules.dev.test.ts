// Firestore security rules against the real DEV project (vlados-2609-dev) with the real JS SDK.
// Run: npm run test:rules   (not part of `npm test`). Creates a throwaway game `rulestest-<ts>`
// and media `rulestest-<ts>-*`, and deletes everything it created at the end (anonymous users too).
//
// Cost per run ≈ 150 reads + 80 writes on DEV.

import { REACTIONS } from '@shared/defaults';
import { FB_LIMITS, FB_PROJECTS, fbNameOk, reactionBucket, type GameDoc, type RoundPub } from '@shared/fbtypes';
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { deleteUser, getAuth, signInAnonymously, signInWithEmailAndPassword, type Auth } from 'firebase/auth';
import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDocFromServer,
  getDocs,
  getDocsFromServer,
  initializeFirestore,
  limit,
  memoryLocalCache,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  setLogLevel,
  terminate,
  updateDoc,
  where,
  type Firestore,
} from 'firebase/firestore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClockProbe, ServerClock } from '../app/src/fb/clock';
import { clearMediaMemory, deleteMedia, loadMedia, uploadMedia } from '../app/src/fb/media';
import { fbRefs, newAnswerDoc, newPlayerDoc, newReactionDoc, toFirestorePatch, tsFromMs, type FbRefs } from '../app/src/fb/refs';
import { detectRole } from '../app/src/fb/auth';
import { ensureDevBotAdmin, ensureDevBotUser, setDevEmailVerified } from '../tools/dev-bot-admin.mjs';

const DEV = FB_PROJECTS.dev;
if (DEV.projectId !== 'vlados-2609-dev') throw new Error('rules tests must run against the DEV project only');

interface Client {
  label: string;
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  refs: FbRefs;
  uid: string;
}

const clients: Client[] = [];

async function makeClient(label: string, signIn: (auth: Auth) => Promise<unknown>): Promise<Client> {
  const app = initializeApp(DEV, `${label}-${Math.random().toString(36).slice(2)}`);
  const auth = getAuth(app);
  await signIn(auth);
  const db = initializeFirestore(app, { localCache: memoryLocalCache(), ignoreUndefinedProperties: true });
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error(`${label}: not signed in`);
  const c = { label, app, auth, db, refs: fbRefs(db), uid };
  clients.push(c);
  return c;
}

const denied = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ code: 'permission-denied' });

const TS = Date.now();
const G = `rulestest-${TS}`;
const MEDIA_ID = `rulestest-${TS}-img`;
const ADMIN_SCRATCH = `rulestest-${TS}`;

let admin: Client;
let p1: Client; // joins and plays
let p2: Client; // joins, gets kicked
let stranger: Client; // signed in, never joins
let emailUser: Client; // email/password account that is not an admin
const serverClock = new ServerClock();
const now = () => serverClock.now();

function round(i: number, openAt: number, endsAt: number, extra: Partial<RoundPub> = {}): RoundPub {
  return {
    i,
    total: 10,
    qid: `q${i}`,
    type: 'choice',
    title: `Вопрос ${i}`,
    double: false,
    timeLimitS: 60,
    options: [
      { id: 'a', text: 'A' },
      { id: 'b', text: 'B' },
    ],
    introAt: openAt - 4000,
    openAt,
    endsAt,
    ...extra,
  };
}

function gameDoc(patch: Partial<GameDoc> = {}): GameDoc {
  return {
    pub: { title: 'Rules test', subtitle: '', texts: {}, startsAt: TS, reactions: true, themeDefault: 'system' },
    phase: 'lobby',
    phaseRev: 0,
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
    ...patch,
  };
}

/** Admin moves the game into `phase` with round `r` (full doc write, like the host's transactions). */
const setGame = (patch: Partial<GameDoc>) => setDoc(admin.refs.game(G), gameDoc(patch));

const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Server ms of each client's last accepted owner write to its player doc (the rules space them). */
const lastOwnerWrite = new Map<string, number>();

/** Waits until the rules accept the next owner update of `c`'s player doc. */
async function ownerGap(c: Client): Promise<void> {
  const last = lastOwnerWrite.get(c.uid);
  if (last !== undefined) await sleep(Math.max(0, last + FB_LIMITS.playerWriteGapMs + 400 - now()));
}

/** An owner update of the own player doc, the way PlayerSession sends it (seenAt bumped). */
async function ownerUpdate(c: Client, patch: Record<string, unknown>, g = G): Promise<void> {
  await ownerGap(c);
  await updateDoc(c.refs.player(g, c.uid), { ...toFirestorePatch(patch), seenAt: serverTimestamp() });
  lastOwnerWrite.set(c.uid, now());
}

beforeAll(async () => {
  // Every refused write is also logged by the SDK as a stream warning; the assertions cover them.
  setLogLevel('error');
  const bot = await ensureDevBotAdmin();
  admin = await makeClient('admin', (a) => signInWithEmailAndPassword(a, bot.email, bot.password));
  p1 = await makeClient('p1', (a) => signInAnonymously(a));
  p2 = await makeClient('p2', (a) => signInAnonymously(a));
  stranger = await makeClient('stranger', (a) => signInAnonymously(a));
  const plain = await ensureDevBotUser();
  emailUser = await makeClient('emailUser', (a) => signInWithEmailAndPassword(a, plain.email, plain.password));
  const ok = await serverClock.measure(adminClockProbe(admin.refs, admin.uid), 2);
  if (!ok) throw new Error('clock probe failed');
});

afterAll(async () => {
  const errors: unknown[] = [];
  const attempt = async (f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (e) {
      errors.push(e);
    }
  };
  if (admin) {
    const r = admin.refs;
    for (const col of [r.answers(G), r.reactions(G), r.players(G), collection(admin.db, `games/${G}/private`)]) {
      await attempt(async () => {
        const snap = await getDocsFromServer(col);
        await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
      });
    }
    await attempt(() => deleteDoc(r.game(G)));
    await attempt(() => deleteMedia(r, MEDIA_ID));
    await attempt(() => deleteDoc(doc(admin.db, `admin/${ADMIN_SCRATCH}`)));
    await attempt(() => deleteDoc(r.clockProbe(admin.uid)));
  }
  for (const c of clients) {
    const user = c.auth.currentUser;
    // Retried once: the Auth REST call occasionally fails with a transient "fetch failed".
    if (user?.isAnonymous) await attempt(() => deleteUser(user).catch(() => deleteUser(user)));
    await attempt(() => terminate(c.db));
    await attempt(() => deleteApp(c.app));
  }
  if (errors.length) console.warn('rules test cleanup errors:', errors);
});

describe('admin-only data', () => {
  it('bot admin (dev rules) can read admin/content; anonymous users cannot', async () => {
    await getDocFromServer(admin.refs.adminContent());
    await denied(getDocFromServer(p1.refs.adminContent()));
    await denied(getDocFromServer(stranger.refs.adminContent()));
  });

  it('anonymous users cannot write admin/content, config/current or config/admins', async () => {
    await denied(setDoc(p1.refs.adminContent(), { rev: 1, settings: {} as never, questions: [], trash: [] }));
    await denied(setDoc(p1.refs.configCurrent(), { gameId: G }));
    await denied(setDoc(p1.refs.configAdmins(), { emails: ['x@example.com'] }));
    await denied(getDocFromServer(p1.refs.configAdmins()));
  });

  it('admin/content validation (writes only if the doc exists: never clobbers DEV content)', async () => {
    const snap = await getDocFromServer(admin.refs.adminContent());
    // Invalid shapes are refused even for admins (a refused write changes nothing).
    await denied(setDoc(admin.refs.adminContent(), { rev: 1, settings: {} as never, questions: 'x' as never, trash: [] }));
    await denied(setDoc(admin.refs.adminContent(), { rev: 1, settings: {} as never, questions: [], trash: [], junk: 1 } as never));
    if (snap.exists()) {
      await updateDoc(admin.refs.adminContent(), { rev: snap.data().rev });
      await denied(updateDoc(p1.refs.adminContent(), { rev: snap.data().rev }));
    }
    await denied(deleteDoc(admin.refs.adminContent()));
  });

  it('admin scratch docs, config reads, clock probes', async () => {
    const scratch = doc(admin.db, `admin/${ADMIN_SCRATCH}`);
    await setDoc(scratch, { ok: true });
    await denied(getDocFromServer(doc(p1.db, `admin/${ADMIN_SCRATCH}`)));
    await getDocFromServer(admin.refs.configAdmins());
    // config/current: public get, admin write (write back whatever DEV has, or the default).
    const cur = await getDocFromServer(p1.refs.configCurrent());
    await setDoc(admin.refs.configCurrent(), { gameId: cur.data()?.gameId ?? 'main' });
    await denied(setDoc(admin.refs.configCurrent(), { gameId: 'bad id!' }));
    await denied(deleteDoc(admin.refs.configCurrent()));
    // Clock probes: only admins, only their own, only serverTimestamp.
    expect((await getDocFromServer(admin.refs.clockProbe(admin.uid))).data()?.t).toBeTypeOf('number');
    await denied(setDoc(admin.refs.clockProbe(admin.uid), { t: Timestamp.now() as never }));
    await denied(setDoc(p1.refs.clockProbe(p1.uid), { t: serverTimestamp() }));
    expect(Math.abs(serverClock.get().offsetMs)).toBeLessThan(5 * 60_000);
  });
});

describe('roles and config/admins', () => {
  it('detectRole: admin by rules, plain email user, anonymous', async () => {
    expect(await detectRole(admin.refs, admin.auth.currentUser)).toBe('admin');
    expect(await detectRole(emailUser.refs, emailUser.auth.currentUser)).toBe('user');
    expect(await detectRole(p1.refs, p1.auth.currentUser)).toBe('anon');
    expect(await detectRole(p1.refs, null)).toBe('none');
  });

  it('a VERIFIED email listed in config/admins becomes admin; unverified or removed does not', async () => {
    const user = emailUser.auth.currentUser;
    const email = user?.email;
    expect(email).toBeTruthy();
    const setVerified = async (v: boolean) => {
      await setDevEmailVerified(email!, v);
      const token = await user!.getIdTokenResult(true);
      expect(token.claims.email_verified).toBe(v);
    };
    const before = await getDocFromServer(admin.refs.configAdmins());
    const original = before.data()?.emails ?? [];
    await setVerified(false);
    await denied(getDocFromServer(emailUser.refs.adminContent()));
    await denied(setDoc(emailUser.refs.configAdmins(), { emails: [email!] }));
    await denied(setDoc(admin.refs.configAdmins(), { emails: original, extra: true } as never));
    try {
      await setDoc(admin.refs.configAdmins(), { emails: [...original.filter((e) => e !== email), email!] });
      // Listed but the address is not confirmed: anyone could have registered it.
      await denied(getDocFromServer(emailUser.refs.adminContent()));
      expect(await detectRole(emailUser.refs, user)).toBe('user');
      await setVerified(true);
      await getDocFromServer(emailUser.refs.adminContent());
      await getDocFromServer(emailUser.refs.configAdmins());
      expect(await detectRole(emailUser.refs, user)).toBe('admin');
    } finally {
      // Restore DEV's list (an absent doc becomes an empty list: admins cannot delete it).
      await setDoc(admin.refs.configAdmins(), { emails: original.filter((e) => e !== email) });
    }
    // Verified but no longer listed.
    await denied(getDocFromServer(emailUser.refs.adminContent()));
    await setVerified(false);
  });
});

describe('games', () => {
  it('only admins write games/*; every signed-in user reads the public doc; only admins list', async () => {
    await denied(setDoc(p1.refs.game(G), gameDoc()));
    await setGame({});
    await denied(updateDoc(p1.refs.game(G), { phase: 'open' }));
    await denied(setDoc(stranger.refs.game(`${G}-evil`), gameDoc()));
    expect((await getDocFromServer(p1.refs.game(G))).data()?.phase).toBe('lobby');
    await denied(getDocsFromServer(query(p1.refs.games(), limit(1))));
    await getDocsFromServer(query(admin.refs.games(), limit(1)));
    await denied(deleteDoc(p1.refs.game(G)));
  });

  it('game doc validation: phase, unknown keys, round shape, no reveal before the reveal', async () => {
    const t = now();
    await denied(setGame({ phase: 'party' as never }));
    await denied(setDoc(admin.refs.game(G), { ...gameDoc(), secret: 1 } as never));
    await denied(setGame({ phase: 'open', round: { ...round(0, t, t + 60_000), correctId: 'a' } as never }));
    const reveal = { i: 0, correct: 'a', dist: { a: 1 }, pct: 1, me: {} };
    await denied(setGame({ phase: 'open', round: round(0, t, t + 60_000), reveal }));
    await denied(setGame({ phase: 'locked', round: round(0, t, t + 60_000), reveal }));
    await setGame({ phase: 'reveal', round: round(0, t, t + 60_000), reveal });
    // The display number n is an optional int.
    await setGame({ phase: 'intro', round: round(0, t, t + 60_000, { n: 1 }) });
    await denied(setGame({ phase: 'intro', round: round(0, t, t + 60_000, { n: 1.5 }) }));
    await denied(setGame({ phase: 'intro', round: round(0, t, t + 60_000, { n: 'one' as never }) }));
    await setGame({ phase: 'lobby' });
  });

  it('private host docs are admin-only', async () => {
    await setDoc(admin.refs.gamePrivate(G, 'totals'), { rev: 1 });
    await denied(getDocFromServer(p1.refs.gamePrivate(G, 'totals')));
    await denied(setDoc(p1.refs.gamePrivate(G, 'totals'), { rev: 2 }));
  });
});

describe('players', () => {
  it('joins are refused when the game is full, over, or closed to late joiners', async () => {
    const t = now();
    const join = () => setDoc(stranger.refs.player(G, stranger.uid), newPlayerDoc({ name: 'Опоздал', seed: 1 }));
    const pub = gameDoc().pub;
    // players = the host-maintained count; maxPlayers from the settings; a hard cap regardless.
    await setGame({ players: 5, pub: { ...pub, maxPlayers: 5 } });
    await denied(join());
    await setGame({ players: FB_LIMITS.playersHardMax, pub: { ...pub, maxPlayers: FB_LIMITS.playersHardMax + 100 } });
    await denied(join());
    await setGame({ players: FB_LIMITS.playersHardMax });
    await denied(join());
    await setGame({ phase: 'final' });
    await denied(join());
    await setGame({ phase: 'open', round: round(0, t, t + 60_000), pub: { ...pub, lateJoin: false } });
    await denied(join());
    await setGame({});
  });

  it('owner creates their own doc with validated fields only', async () => {
    const ok = newPlayerDoc({ name: 'Ё'.repeat(FB_LIMITS.nameMax), seed: 123, avatar: bytes(FB_LIMITS.avatarMaxBytes), thumb: bytes(FB_LIMITS.thumbMaxBytes) });
    const player = p1.refs.player(G, p1.uid);
    await denied(setDoc(p1.refs.player(G, p2.uid), newPlayerDoc({ name: 'Чужой', seed: 1 })));
    await denied(setDoc(player, { ...ok, name: '' }));
    await denied(setDoc(player, { ...ok, name: 'Ж'.repeat(FB_LIMITS.nameMax + 1) }));
    await denied(setDoc(player, { ...ok, kicked: true }));
    await denied(setDoc(player, { ...ok, joinedAt: Timestamp.now() as never }));
    await denied(setDoc(player, { ...ok, seenAt: Timestamp.now() as never }));
    await denied(setDoc(player, { ...ok, seed: -1 }));
    await denied(setDoc(player, { ...ok, seed: 1.5 }));
    await denied(setDoc(player, { ...ok, score: 100000 } as never));
    await denied(setDoc(player, { ...ok, avatar: bytes(FB_LIMITS.avatarMaxBytes + 1) }));
    await denied(setDoc(player, { ...ok, thumb: bytes(FB_LIMITS.thumbMaxBytes + 1) }));
    await denied(setDoc(stranger.refs.player(`${G}-nope`, stranger.uid), newPlayerDoc({ name: 'Нет игры', seed: 1 })));
    await setDoc(player, ok);
    await setDoc(p2.refs.player(G, p2.uid), newPlayerDoc({ name: 'Бот 2 🎉', seed: 4294967295 }));
    const mine = (await getDocFromServer(player)).data();
    expect(mine?.avatar).toBeInstanceOf(Uint8Array);
    expect(mine?.avatar?.length).toBe(FB_LIMITS.avatarMaxBytes);
    expect(mine?.joinedAt).toBeTypeOf('number');
    // A second create is an update of joinedAt/kicked → refused.
    await denied(setDoc(player, ok));
    lastOwnerWrite.set(p1.uid, now());
    lastOwnerWrite.set(p2.uid, now());
  });

  it('name length is counted in UTF-16 code units, like HTML maxlength (see fbNameOk)', async () => {
    const me = p1.refs.player(G, p1.uid);
    await ownerGap(p1);
    for (const name of ['🎉'.repeat(FB_LIMITS.nameMax / 2 + 1), '👨‍👩‍👧‍👦'.repeat(2)]) {
      expect(fbNameOk(name)).toBe(false);
      await denied(updateDoc(me, { name, seenAt: serverTimestamp() }));
    }
    for (const name of ['🎉'.repeat(FB_LIMITS.nameMax / 2), 'Саша 👨‍👩‍👧‍👦', 'е\u0301'.repeat(FB_LIMITS.nameMax / 2)]) {
      expect(fbNameOk(name)).toBe(true);
      await ownerUpdate(p1, { name });
    }
  });

  it('owner updates bump seenAt to the server time and are spaced (write-quota flood guard)', async () => {
    const me = p1.refs.player(G, p1.uid);
    await ownerGap(p1);
    // Without the seenAt bump the rules cannot rate-limit → refused.
    await denied(updateDoc(me, { name: 'Игрок 1' }));
    await ownerUpdate(p1, { name: 'Игрок 1' });
    // Right after an accepted write: refused, whatever the field.
    await denied(updateDoc(me, { name: 'Флуд', seenAt: serverTimestamp() }));
    await denied(updateDoc(me, { seenAt: serverTimestamp() }));
    await denied(updateDoc(me, toFirestorePatch({ thumb: bytes(100, 2), seenAt: serverTimestamp() })));
    await ownerUpdate(p1, { name: 'Игрок 1' });
  });

  it('reads: owner or admin only; listing is admin-only', async () => {
    await getDocFromServer(p1.refs.player(G, p1.uid));
    await getDocFromServer(stranger.refs.player(G, stranger.uid)); // own path, not joined: allowed, empty
    await denied(getDocFromServer(p1.refs.player(G, p2.uid)));
    await denied(getDocsFromServer(p1.refs.players(G)));
    await denied(getDocsFromServer(stranger.refs.players(G)));
    expect((await getDocsFromServer(admin.refs.players(G))).size).toBe(2);
  });

  it('owner may change name/avatar/thumb/seenAt only', async () => {
    const me = p1.refs.player(G, p1.uid);
    await ownerGap(p1);
    await denied(updateDoc(me, { seenAt: Timestamp.now() }));
    await denied(updateDoc(me, { kicked: true, seenAt: serverTimestamp() }));
    await denied(updateDoc(me, { seed: 5, seenAt: serverTimestamp() }));
    await denied(updateDoc(me, { joinedAt: serverTimestamp(), seenAt: serverTimestamp() }));
    await denied(updateDoc(p1.refs.player(G, p2.uid), { name: 'Взлом', seenAt: serverTimestamp() }));
    await denied(deleteDoc(me));
    await ownerUpdate(p1, {});
    await ownerUpdate(p1, { thumb: bytes(100, 1) });
  });
});

describe('answers', () => {
  it('owner answers once, inside the window, for the current round and question type', async () => {
    const t = now();
    await setGame({ phase: 'open', phaseRev: 1, round: round(0, t - 1_000, t + 60_000) });
    const a = newAnswerDoc(p1.uid, 0, { t: 'choice', id: 'a' });
    await setDoc(p1.refs.answer(G, 0, p1.uid), a);
    await denied(setDoc(p1.refs.answer(G, 0, p1.uid), newAnswerDoc(p1.uid, 0, { t: 'choice', id: 'b' })));
    await denied(deleteDoc(p1.refs.answer(G, 0, p1.uid)));
    // For another uid: path, field, or both.
    await denied(setDoc(p1.refs.answer(G, 0, p2.uid), newAnswerDoc(p2.uid, 0, { t: 'choice', id: 'a' })));
    await denied(setDoc(p1.refs.answer(G, 0, p2.uid), a));
    await denied(setDoc(p2.refs.answer(G, 0, p2.uid), a));
    // Shape: wrong type for the round, bad payload, wrong round, client time, not joined.
    await denied(setDoc(p2.refs.answer(G, 0, p2.uid), newAnswerDoc(p2.uid, 0, { t: 'number', v: 3 })));
    await denied(setDoc(p2.refs.answer(G, 0, p2.uid), newAnswerDoc(p2.uid, 0, { t: 'choice', id: 'a', extra: 1 } as never)));
    await denied(setDoc(p2.refs.answer(G, 1, p2.uid), newAnswerDoc(p2.uid, 1, { t: 'choice', id: 'a' })));
    await denied(setDoc(p2.refs.answer(G, 0, p2.uid), { ...newAnswerDoc(p2.uid, 0, { t: 'choice', id: 'a' }), at: Timestamp.now() as never }));
    await denied(setDoc(stranger.refs.answer(G, 0, stranger.uid), newAnswerDoc(stranger.uid, 0, { t: 'choice', id: 'a' })));
  });

  it('refuses answers before openAt − 0.5 s, after endsAt + 2 s, outside intro/open/locked, and in a paused intro', async () => {
    const t = now();
    const ans = () => setDoc(p2.refs.answer(G, 1, p2.uid), newAnswerDoc(p2.uid, 1, { t: 'choice', id: 'b' }));
    await setGame({ phase: 'open', phaseRev: 2, round: round(1, t + 30_000, t + 90_000) });
    await denied(ans());
    await setGame({ phase: 'open', phaseRev: 2, round: round(1, t - 70_000, t - 10_000) });
    await denied(ans());
    // The intro (a video's watch stage) before openAt: refused.
    await setGame({ phase: 'intro', phaseRev: 2, round: round(1, t + 20_000, t + 80_000) });
    await denied(ans());
    // A paused intro past its (old) openAt: refused (resume moves openAt).
    await setGame({ phase: 'intro', phaseRev: 2, round: round(1, t - 1_000, t + 60_000), pause: { at: t - 2_000, remainingMs: 61_000, reason: 'admin' } });
    await denied(ans());
    await setGame({ phase: 'board', phaseRev: 2, round: round(1, t - 1_000, t + 60_000) });
    await denied(ans());
    // Locked still accepts (latency grace).
    await setGame({ phase: 'locked', phaseRev: 3, round: round(1, t - 60_000, now() - 500) });
    await ans();
  });

  it('a late host: an intro past its openAt accepts answers by the clock (phones open at openAt)', async () => {
    const t = now();
    const ans = () => setDoc(p1.refs.answer(G, 9, p1.uid), newAnswerDoc(p1.uid, 9, { t: 'choice', id: 'a' }));
    await setGame({ phase: 'intro', phaseRev: 4, round: round(9, t - 1_000, t + 60_000) });
    await ans();
  });

  it('kicked players cannot answer (or edit themselves)', async () => {
    await updateDoc(admin.refs.player(G, p2.uid), { kicked: true });
    const t = now();
    await setGame({
      phase: 'open',
      phaseRev: 4,
      round: round(2, t - 1_000, t + 60_000, { type: 'ordering', options: [], items: [{ id: 'x' }, { id: 'y' }, { id: 'z' }] }),
    });
    await denied(setDoc(p2.refs.answer(G, 2, p2.uid), newAnswerDoc(p2.uid, 2, { t: 'ordering', ids: ['x', 'y', 'z'] })));
    await denied(updateDoc(p2.refs.player(G, p2.uid), { name: 'Вернулся' }));
    await setDoc(p1.refs.answer(G, 2, p1.uid), newAnswerDoc(p1.uid, 2, { t: 'ordering', ids: ['z', 'y', 'x'] }));
  });

  it('number answers must be finite and inside the public [min, max]; ordering a same-size list without repeats', async () => {
    const t = now();
    await setGame({
      phase: 'open',
      phaseRev: 5,
      round: round(3, t - 1_000, t + 60_000, { type: 'number', options: [], number: { min: 0, max: 100, step: 1 } }),
    });
    const ans = (v: number) => setDoc(p1.refs.answer(G, 3, p1.uid), newAnswerDoc(p1.uid, 3, { t: 'number', v }));
    for (const v of [1e308, -1e308, Number.NaN, Number.POSITIVE_INFINITY, -1, 100.5]) await denied(ans(v));
    await ans(42.5);
    await setGame({
      phase: 'open',
      phaseRev: 6,
      round: round(4, t - 1_000, t + 60_000, { type: 'ordering', options: [], items: [{ id: 'x' }, { id: 'y' }, { id: 'z' }] }),
    });
    const ord = (ids: string[]) => setDoc(p1.refs.answer(G, 4, p1.uid), newAnswerDoc(p1.uid, 4, { t: 'ordering', ids }));
    await denied(ord(['x', 'x', 'y']));
    await denied(ord(['x', 'y']));
    await denied(ord(['x', 'y', 'z', 'w']));
    await ord(['y', 'x', 'z']);
  });

  it('reads: own answer (get) or admin; listing is admin-only', async () => {
    expect((await getDocFromServer(p1.refs.answer(G, 0, p1.uid))).data()?.p).toEqual({ t: 'choice', id: 'a' });
    await getDocFromServer(p1.refs.answer(G, 5, p1.uid)); // own id, missing: allowed
    await denied(getDocFromServer(p1.refs.answer(G, 1, p2.uid)));
    await denied(getDocsFromServer(p1.refs.answers(G)));
    await denied(getDocsFromServer(query(p1.refs.answers(G), where('uid', '==', p1.uid))));
    const r0 = await getDocsFromServer(query(admin.refs.answers(G), where('round', '==', 0)));
    expect(r0.docs.map((d) => d.data().uid)).toEqual([p1.uid]);
    const r1 = await getDocsFromServer(query(admin.refs.answers(G), where('round', '==', 1), orderBy('at')));
    expect(r1.size).toBe(1);
    expect(r1.docs[0]?.data().at).toBeTypeOf('number');
  });
});

describe('reactions', () => {
  it('one per player per bucket (FB_LIMITS.reactionBucketMs), bucket within ±1 of server time', async () => {
    const b = reactionBucket(now());
    await setDoc(p1.refs.reaction(G, p1.uid, b), newReactionDoc(p1.uid, 0));
    await denied(setDoc(p1.refs.reaction(G, p1.uid, b), newReactionDoc(p1.uid, 1)));
    await setDoc(p1.refs.reaction(G, p1.uid, b + 1), newReactionDoc(p1.uid, REACTIONS.length - 1));
    await denied(setDoc(p1.refs.reaction(G, p1.uid, b + 5), newReactionDoc(p1.uid, 2)));
    await denied(setDoc(p1.refs.reaction(G, p1.uid, b - 3), newReactionDoc(p1.uid, 2)));
    await denied(setDoc(doc(p1.db, `games/${G}/reactions/${p1.uid}_0${b}`), newReactionDoc(p1.uid, 2)));
    await denied(setDoc(p1.refs.reaction(G, p2.uid, b), newReactionDoc(p2.uid, 2)));
    await denied(setDoc(p1.refs.reaction(G, p1.uid, b - 1), newReactionDoc(p1.uid, REACTIONS.length)));
    await denied(setDoc(p1.refs.reaction(G, p1.uid, b - 1), { ...newReactionDoc(p1.uid, 1), at: Timestamp.now() as never }));
    // Kicked and not-joined users cannot react at all.
    await denied(setDoc(p2.refs.reaction(G, p2.uid, b), newReactionDoc(p2.uid, 1)));
    await denied(setDoc(stranger.refs.reaction(G, stranger.uid, b), newReactionDoc(stranger.uid, 1)));
  });

  it('only admins read reactions', async () => {
    await denied(getDocsFromServer(p1.refs.reactions(G)));
    await denied(getDocFromServer(p1.refs.reaction(G, p1.uid, reactionBucket(now()))));
    const recent = await getDocsFromServer(query(admin.refs.reactions(G), where('at', '>', tsFromMs(now() - 5 * 60_000))));
    expect(recent.size).toBe(2);
  });
});

describe('media', () => {
  it('admins upload chunks + meta; players get by id; nobody but admins lists', async () => {
    const size = FB_LIMITS.chunkMaxBytes + 1234;
    const original = new Uint8Array(size);
    for (let i = 0; i < size; i++) original[i] = (i * 31 + 7) & 0xff;
    await denied(uploadMedia(p1.refs, { id: `${MEDIA_ID}-x`, kind: 'image', blob: new Blob([original], { type: 'image/jpeg' }), w: 10, h: 10 }));
    const { meta } = await uploadMedia(admin.refs, { id: MEDIA_ID, kind: 'image', blob: new Blob([original], { type: 'image/jpeg' }), w: 1600, h: 1200 });
    expect(meta.chunks).toBe(2);

    clearMediaMemory();
    const blob = await loadMedia(p1.refs, MEDIA_ID);
    expect(blob.type).toBe('image/jpeg');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(original);

    await denied(getDocs(p1.refs.mediaList()));
    await denied(getDocsFromServer(query(p1.refs.mediaList(), limit(1))));
    await denied(getDocsFromServer(p1.refs.mediaChunks(MEDIA_ID)));
    await getDocsFromServer(query(admin.refs.mediaList(), limit(1)));
    await denied(setDoc(p1.refs.mediaChunk(MEDIA_ID, 0), { d: bytes(10) }));
    await denied(deleteDoc(p1.refs.mediaMeta(MEDIA_ID)));
  });

  it('chunk and meta validation', async () => {
    await denied(setDoc(admin.refs.mediaChunk(MEDIA_ID, 5), { d: bytes(FB_LIMITS.chunkMaxBytes + 1) }));
    await denied(setDoc(admin.refs.mediaChunk(MEDIA_ID, FB_LIMITS.maxChunks), { d: bytes(10) }));
    await denied(setDoc(doc(admin.db, `media/${MEDIA_ID}/c/01`), toFirestorePatch({ d: bytes(10) })));
    await denied(setDoc(admin.refs.mediaChunk(MEDIA_ID, 5), { d: 'text' as never }));
    const base = { kind: 'image' as const, mime: 'image/jpeg', w: 1, h: 1, bytes: 10, chunks: 1, createdAt: serverTimestamp() };
    await denied(setDoc(admin.refs.mediaMeta(`${MEDIA_ID}-bad`), { ...base, kind: 'audio' as never }));
    await denied(setDoc(admin.refs.mediaMeta(`${MEDIA_ID}-bad`), { ...base, mime: 'text/html' }));
    await denied(setDoc(admin.refs.mediaMeta(`${MEDIA_ID}-bad`), { ...base, chunks: FB_LIMITS.maxChunks + 1 }));
    await denied(setDoc(admin.refs.mediaMeta(`${MEDIA_ID}-bad`), { ...base, url: 'http://x' } as never));
  });
});
