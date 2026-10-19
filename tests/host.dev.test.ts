// End-to-end: the host driver + 3 player bots play a whole (short, auto-advancing) game on the
// DEV project through the real security rules. Also covers lease failover to a standby host,
// kick, pause/resume, late/stale errors, reactions and scoring from server times.
// Run: npm run test:rules (DEV only). Creates `hosttest-<ts>` and deletes it (and its anonymous users).
//
// Cost per run ≈ 400 reads + 150 writes on DEV.

import { DEFAULT_SCORING, defaultSettings } from '@shared/defaults';
import { FB_PROJECTS, type AdminContentDoc, type AnswerDoc } from '@shared/fbtypes';
import { scoreAnswer } from '@shared/scoring';
import type { ChoiceQ, NumberQ, OrderingQ, Question } from '@shared/types';
import { clamp } from '@shared/util';
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { deleteUser, getAuth, signInAnonymously, signInWithEmailAndPassword, type Auth } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  getDocsFromServer,
  initializeFirestore,
  memoryLocalCache,
  setLogLevel,
  terminate,
  type Firestore,
} from 'firebase/firestore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ServerClock } from '../app/src/fb/clock';
import { fbRefs } from '../app/src/fb/refs';
import { Host } from '../app/src/host/driver';
import type { TotalsDoc } from '../app/src/host/model';
import { PlayerSession } from '../app/src/host/player';
import { ensureDevBotAdmin } from '../tools/dev-bot-admin.mjs';

const DEV = FB_PROJECTS.dev;
if (DEV.projectId !== 'vlados-2609-dev') throw new Error('host tests must run against the DEV project only');

const G = `hosttest-${Date.now()}`;

interface Client {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  uid: string;
}
const clients: Client[] = [];

async function makeClient(label: string, signIn: (a: Auth) => Promise<unknown>): Promise<Client> {
  const app = initializeApp(DEV, `${label}-${Math.random().toString(36).slice(2)}`);
  const auth = getAuth(app);
  await signIn(auth);
  const db = initializeFirestore(app, { localCache: memoryLocalCache() });
  const c = { app, auth, db, uid: auth.currentUser?.uid ?? '' };
  clients.push(c);
  return c;
}

const Q1: ChoiceQ = {
  id: 'h1',
  type: 'choice',
  title: 'Любимый цвет?',
  options: [
    { id: 'red', text: 'Красный' },
    { id: 'blue', text: 'Синий' },
  ],
  correctId: 'blue',
  timeLimitS: 8,
  double: false,
};
const Q2: NumberQ = { id: 'h2', type: 'number', title: 'Сколько?', answer: 42, min: 0, max: 100, step: 1, tolerance: 0, zeroAt: 20, timeLimitS: 8, double: true };
const Q3: OrderingQ = {
  id: 'h3',
  type: 'ordering',
  title: 'По порядку',
  items: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }],
  firstLabel: 'Раньше',
  lastLabel: 'Позже',
  timeLimitS: 8,
  double: false,
};

const CONTENT: AdminContentDoc = {
  rev: 1,
  settings: {
    ...defaultSettings(),
    introMs: 1_500,
    lockMs: 300,
    allAnsweredDelayMs: 300,
    // Long enough for a losing concurrent transaction (retried after ~1 s backoff) to report 'stale'.
    autopilot: false,
    autoAdvance: { revealToBoardS: 4, boardToNextS: 3, finalStepS: 1 },
  },
  questions: [Q1, Q2, Q3],
  trash: [],
};

let admin: Client;
let host: Host;
let standby: Host;
const players: PlayerSession[] = [];
const log: string[] = [];

function diag(): string {
  const h = (x: Host | undefined) => {
    if (!x) return 'none';
    const s = x.snapshot();
    return JSON.stringify({ phase: s.game?.phase, rev: s.game?.phaseRev, round: s.game?.round?.i, lease: s.lease?.label, until: s.lease ? s.lease.until - x.now() : null, health: { ...s.health, clock: undefined }, totalsRev: s.totals?.rev, phaseAt: s.totals ? s.totals.phaseAt - x.now() : null });
  };
  return `tv: ${h(host)}\nstandby: ${h(standby)}\nplayers: ${players.map((p) => p.view().screen).join(',')}`;
}

async function waitFor<T>(what: string, fn: () => T | null | undefined | false, timeoutMs = 30_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}\n${diag()}\n${log.slice(-30).join('\n')}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}


beforeAll(async () => {
  setLogLevel('error');
  const bot = await ensureDevBotAdmin();
  admin = await makeClient('admin', (a) => signInWithEmailAndPassword(a, bot.email, bot.password));
  const standbyClient = await makeClient('admin2', (a) => signInWithEmailAndPassword(a, bot.email, bot.password));
  const opts = { uid: admin.uid, content: CONTENT, followCurrent: false, log: (m: string) => log.push(m) };
  host = new Host({ ...opts, db: admin.db, clock: new ServerClock(), preferred: true, label: 'tv' });
  standby = new Host({ ...opts, db: standbyClient.db, clock: new ServerClock(), preferred: false, label: 'standby', reactions: false });
  await host.start(G);
  await standby.start(G);
  for (let k = 0; k < 3; k++) {
    const c = await makeClient(`p${k}`, (a) => signInAnonymously(a));
    const p = new PlayerSession({ db: c.db, uid: c.uid, clock: new ServerClock(), gameId: G, timeoutMs: 15_000 });
    await p.start();
    await p.whenReady();
    players.push(p);
  }
}, 120_000);

afterAll(async () => {
  for (const p of players) p.stop();
  await host?.stop();
  await standby?.stop();
  if (admin) {
    const r = fbRefs(admin.db);
    for (const col of [r.answers(G), r.reactions(G), r.players(G), collection(admin.db, `games/${G}/private`)]) {
      try {
        const snap = await getDocsFromServer(col);
        await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
      } catch (e) {
        console.warn('cleanup', e);
      }
    }
    await deleteDoc(r.game(G)).catch(() => undefined);
    await deleteDoc(r.clockProbe(admin.uid)).catch(() => undefined);
  }
  for (const c of clients) {
    const u = c.auth.currentUser;
    if (u?.isAnonymous) await deleteUser(u).catch(() => deleteUser(u).catch(() => undefined));
    await terminate(c.db).catch(() => undefined);
    await deleteApp(c.app).catch(() => undefined);
  }
}, 120_000);

/** Server-time points the host must have given (recomputed from the stored answer docs). */
async function expectedPoints(round: number, q: Question): Promise<Record<string, number>> {
  const totals = (await getDocsFromServer(collection(admin.db, `games/${G}/private`))).docs.find((d) => d.id === 'totals')?.data() as
    | TotalsDoc
    | undefined;
  const pr = totals?.rounds.find((r) => r.i === round);
  const answers = (await getDocsFromServer(fbRefs(admin.db).answers(G))).docs.map((d) => d.data() as AnswerDoc).filter((a) => a.round === round);
  const out: Record<string, number> = {};
  for (const a of answers) {
    const elapsed = clamp(a.at - (pr?.openAt ?? 0), 0, q.timeLimitS * 1000);
    out[a.uid] = scoreAnswer(q, { p: a.p, elapsedMs: Math.round(elapsed) }, DEFAULT_SCORING).points;
  }
  return out;
}

describe('host + players on DEV', () => {
  it('plays a full game with failover, kick, pause and scoring from server times', async () => {
    const [p1, p2, p3] = players as [PlayerSession, PlayerSession, PlayerSession];

    // Lobby: joins (one with a selfie), the throttled player count, Vlados.
    const thumb = new Uint8Array(1_000).fill(9);
    expect(await p1.join('Бот Один', new Uint8Array(5_000).fill(1), thumb)).toEqual({ ok: true });
    expect(await p2.join('  Бот   Два ')).toEqual({ ok: true });
    expect(await p3.join('Владос')).toEqual({ ok: true });
    expect(await p2.join('again')).toEqual({ ok: true });
    expect(p2.view().me?.name).toBe('Бот Два');
    expect(p1.view().screen).toBe('lobby');
    await waitFor('3 players on the TV', () => host.tvView().players.length === 3);
    expect(host.tvView().players[0]?.thumb?.length).toBe(1_000);
    await waitFor('lease', () => host.snapshot().health.leader);
    expect(standby.snapshot().health.leader).toBe(false);
    expect(await host.command({ type: 'setVlados', uid: p3.uid })).toMatchObject({ ok: true });
    await waitFor('player count pushed', () => p1.view().counts.players === 3, 20_000);

    // Q1 (choice): everybody answers → early lock → reveal.
    expect(await standby.command({ type: 'start' })).toMatchObject({ ok: true, phaseRev: 1 });
    expect(await host.command({ type: 'start' })).toMatchObject({ ok: false, error: 'invalid' });
    await waitFor('intro', () => p1.view().screen === 'intro');
    expect(p1.view().question).toMatchObject({ n: 1, total: 3, type: 'choice', i: 0 });
    expect(JSON.stringify(p1.view().question)).not.toContain('correctId');
    expect(await p1.answer(0, { t: 'choice', id: 'blue' })).toEqual({ ok: false, error: 'closed' });
    await waitFor('Q1 open', () => p1.view().screen === 'question');
    expect(await p1.answer(0, { t: 'choice', id: 'blue' })).toEqual({ ok: true });
    expect(await p1.answer(0, { t: 'choice', id: 'red' })).toEqual({ ok: true }); // already accepted
    expect(p1.view().screen).toBe('answered');
    expect(await p1.react(0)).toEqual({ ok: true });
    expect(await p1.react(1)).toEqual({ ok: false, error: 'throttled' });
    await new Promise((r) => setTimeout(r, 700));
    expect(await p2.answer(0, { t: 'choice', id: 'red' })).toEqual({ ok: true });
    expect(await p3.answer(0, { t: 'choice', id: 'blue' })).toEqual({ ok: true });
    await waitFor('admin sees 3 answers', () => host.adminView().counts.answered === 3);
    const admin1 = host.adminView();
    expect(admin1.correct).toEqual({ t: 'choice', id: 'blue', text: 'Синий' });
    expect(admin1.liveDist).toMatchObject({ t: 'choice', counts: { blue: 1, red: 1 } }); // Vlados apart
    expect(admin1.vladosAnswer).toEqual({ t: 'choice', id: 'blue' });
    await waitFor('reaction on the TV', () => host.tvView().reactions.some((r) => r.uid === p1.uid && r.emoji === '🔥'));
    await waitFor('Q1 reveal on every phone', () => players.every((p) => p.view().screen === 'reveal'), 15_000);
    const pts1 = await expectedPoints(0, Q1);
    const r1 = p1.view().reveal;
    expect(r1).toMatchObject({ correct: 'blue', verdict: 'correct', myAnswer: { t: 'choice', id: 'blue' }, count: 2, pct: 0.5 });
    expect(r1?.mine?.pts).toBe(pts1[p1.uid]);
    expect(r1?.mine?.pts).toBeGreaterThan(500);
    expect(p2.view().reveal).toMatchObject({ verdict: 'wrong', mine: { pts: 0, rank: 2 } });
    expect(p3.view().reveal).toMatchObject({ verdict: 'correct', mine: { rank: null }, vlados: { t: 'choice', id: 'blue' } });
    expect(p3.view().me?.isVlados).toBe(true);
    expect(host.tvView().reveal?.answers.map((a) => a.uid).sort()).toEqual([p1.uid, p2.uid, p3.uid].sort());
    // Answering again is idempotent; a double tap on «next» is stale for one of the two pages.
    expect(await p2.answer(0, { t: 'choice', id: 'blue' })).toEqual({ ok: true });
    const rev = host.snapshot().game?.phaseRev ?? -1;
    const [a, b] = await Promise.all([host.command({ type: 'advance', phaseRev: rev }), standby.command({ type: 'advance', phaseRev: rev })]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((x) => !x.ok)).toMatchObject({ error: 'stale' });
    await waitFor('board', () => p1.view().screen === 'board');
    expect(p1.view().board?.top.map((r) => r.uid)).toEqual([p1.uid, p2.uid]);

    // Failover: the TV host stops; the standby takes the lease and drives the rest.
    await host.stop();
    await waitFor('standby leads', () => standby.snapshot().health.leader, 20_000);

    // Q2 (number, ×2) starts by auto-advance; p2 gets kicked.
    await waitFor('Q2 open', () => p1.view().screen === 'question' && p1.view().question?.qid === 'h2', 20_000);
    expect(await standby.command({ type: 'kick', uid: p2.uid })).toMatchObject({ ok: true });
    await waitFor('p2 sees the kick', () => p2.view().screen === 'kicked');
    expect(await p2.answer(1, { t: 'number', v: 42 })).toEqual({ ok: false, error: 'kicked' });
    expect(await p1.answer(1, { t: 'number', v: 101 })).toEqual({ ok: false, error: 'invalid' });
    expect(await p1.answer(1, { t: 'number', v: 40 })).toEqual({ ok: true });
    expect(await p3.answer(1, { t: 'number', v: 42 })).toEqual({ ok: true });
    await waitFor('Q2 reveal', () => p1.view().screen === 'reveal' && p3.view().screen === 'reveal', 20_000);
    expect(p1.view().reveal).toMatchObject({ correct: 42, verdict: 'closest', count: 1, dist: { '40': 1 } });
    expect(p1.view().reveal?.mine?.cl).toBe(true);
    expect(p3.view().reveal?.mine).toMatchObject({ rank: null, cl: true });
    expect(await standby.command({ type: 'unkick', uid: p2.uid })).toMatchObject({ ok: true });

    // Q3 (ordering) with a pause.
    await waitFor('Q3 open', () => p2.view().screen === 'question' && p2.view().question?.qid === 'h3', 20_000);
    const items = p2.view().question?.items?.map((x) => x.id);
    expect(items).not.toEqual(['a', 'b', 'c']);
    expect(await standby.command({ type: 'pause' })).toMatchObject({ ok: true });
    await waitFor('paused on phones', () => p1.view().pause !== null);
    const frozen = p1.view().timer?.remainingMs ?? 0;
    await new Promise((r) => setTimeout(r, 1_000));
    expect(Math.abs((p1.view().timer?.remainingMs ?? 0) - frozen)).toBeLessThan(50);
    expect(await p2.answer(2, { t: 'ordering', ids: ['a', 'c', 'b'] })).toEqual({ ok: true }); // during the pause
    expect(await standby.command({ type: 'resume' })).toMatchObject({ ok: true });
    await waitFor('resumed', () => p1.view().pause === null);
    expect(await p1.answer(2, { t: 'ordering', ids: ['a', 'b', 'c'] })).toEqual({ ok: true });
    // Vlados does not answer Q3: the question runs its full time, then he is too late.
    await waitFor('Q3 time up', () => p3.view().screen === 'time_up', 20_000);
    await waitFor('Q3 reveal on every phone', () => players.every((p) => p.view().screen === 'reveal'), 20_000);
    expect(await p3.answer(2, { t: 'ordering', ids: ['c', 'b', 'a'] })).toEqual({ ok: false, error: 'late' });
    expect(p3.view().reveal).toMatchObject({ verdict: 'none', mine: { pts: 0, rank: null } });
    expect(p1.view().reveal).toMatchObject({ correct: ['a', 'b', 'c'], verdict: 'correct' });
    expect(p2.view().reveal?.mine?.ok).toBe(false);
    expect(p2.view().reveal?.mine?.pts).toBeGreaterThan(0);

    // Final: podium step by step, then the Vlados comparison.
    await waitFor('final step 5', () => p1.view().final?.step === 5, 30_000);
    const fin = p1.view().final;
    expect(fin?.podium.map((r) => r.uid)).toEqual([p1.uid, p2.uid]);
    expect(fin?.podium[0]?.thumb?.length).toBe(1_000);
    expect(fin?.mine?.rank).toBe(1);
    expect(fin?.vlados).toMatchObject({ uid: p3.uid, name: 'Владос' });
    expect(standby.adminView().rounds.map((r) => [r.n, r.revealed])).toEqual([
      [1, true],
      [2, true],
      [3, true],
    ]);
    const writes = standby.snapshot().totals?.rev;
    expect(writes).toBeGreaterThan(10);
  }, 240_000);
});
