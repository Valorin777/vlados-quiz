// The organizer's panel against the real DEV project: the «Эфир» big button (heroAction) drives a
// whole game through the real Host and security rules while 3 bot guests answer; the panel's
// Firebase backend uploads a media file, reads it back and deletes it; results/CSV come out right.
// Run: npm run test:rules (DEV only). Uses a throwaway game `admintest-<ts>` and never touches
// admin/content or config/current.
//
// Cost per run ≈ 350 reads + 120 writes on DEV.

import { defaultSettings } from '@shared/defaults';
import { FB_PROJECTS, type AdminContentDoc } from '@shared/fbtypes';
import type { AnswerPayload, ChoiceQ, NumberQ, OrderingQ } from '@shared/types';
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { deleteUser, getAuth, signInAnonymously, signInWithEmailAndPassword, type Auth } from 'firebase/auth';
import { collection, deleteDoc, getDocsFromServer, initializeFirestore, memoryLocalCache, setLogLevel, terminate, type Firestore } from 'firebase/firestore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Fb } from '../app/src/fb/app';
import { ServerClock } from '../app/src/fb/clock';
import { deleteMedia } from '../app/src/fb/media';
import { fbRefs } from '../app/src/fb/refs';
import { Host } from '../app/src/host/driver';
import { PlayerSession } from '../app/src/host/player';
import { firebaseBackend } from '../app/src/screens/admin/core/backend';
import { heroAction } from '../app/src/screens/admin/core/live';
import { roundStats, standings, standingsCsv } from '../app/src/screens/admin/core/results';
import { makeSession } from '../app/src/screens/admin/core/session';
import { ensureDevBotAdmin } from '../tools/dev-bot-admin.mjs';

const DEV = FB_PROJECTS.dev;
if (DEV.projectId !== 'vlados-2609-dev') throw new Error('admin tests must run against the DEV project only');

const G = `admintest-${Date.now()}`;

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
  const db = initializeFirestore(app, { localCache: memoryLocalCache(), ignoreUndefinedProperties: true });
  const c = { app, auth, db, uid: auth.currentUser?.uid ?? '' };
  clients.push(c);
  return c;
}

const Q1: ChoiceQ = {
  id: 'a1',
  type: 'choice',
  title: 'Что Владос закажет в ресторане?',
  options: [
    { id: 'o1', text: 'Шаурму' },
    { id: 'o2', text: 'Пасту' },
  ],
  correctId: 'o1',
  timeLimitS: 10,
  double: false,
};
const Q2: NumberQ = { id: 'a2', type: 'number', title: 'Рост Владоса?', answer: 183, unit: 'см', min: 150, max: 210, step: 1, tolerance: 1, zeroAt: 12, timeLimitS: 10, double: true };
const Q3: OrderingQ = {
  id: 'a3',
  type: 'ordering',
  title: 'Города по порядку',
  items: [
    { id: 'c1', text: 'Тверь' },
    { id: 'c2', text: 'Москва' },
    { id: 'c3', text: 'Питер' },
  ],
  firstLabel: 'Раньше',
  lastLabel: 'Позже',
  timeLimitS: 10,
  double: false,
};

const CONTENT: AdminContentDoc = {
  rev: 1,
  // the organizer's button for every step (with the «Автопилот» it reads «Таблица через 9 с»)
  settings: { ...defaultSettings(), introMs: 1_500, lockMs: 300, allAnsweredDelayMs: 300, autopilot: false },
  questions: [Q1, Q2, Q3],
  trash: [],
};

let admin: Client;
let host: Host;
const bots: PlayerSession[] = [];

beforeAll(async () => {
  setLogLevel('error');
  const bot = await ensureDevBotAdmin();
  admin = await makeClient('admin', (a) => signInWithEmailAndPassword(a, bot.email, bot.password));
  host = new Host({ db: admin.db, uid: admin.uid, clock: new ServerClock(), content: CONTENT, followCurrent: false, label: 'admin', reactions: false });
  await host.start(G);
  for (let k = 0; k < 3; k++) {
    const c = await makeClient(`p${k}`, (a) => signInAnonymously(a));
    const p = new PlayerSession({ db: c.db, uid: c.uid, clock: new ServerClock(), gameId: G, timeoutMs: 15_000 });
    await p.start();
    await p.whenReady();
    bots.push(p);
  }
}, 120_000);

afterAll(async () => {
  for (const p of bots) p.stop();
  await host?.stop();
  if (admin) {
    const r = fbRefs(admin.db);
    for (const col of [r.answers(G), r.players(G), collection(admin.db, `games/${G}/private`)]) {
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function botPayload(k: number, v: ReturnType<PlayerSession['view']>): AnswerPayload | null {
  const q = v.question;
  if (!q) return null;
  if (q.type === 'choice') return { t: 'choice', id: (k === 0 ? 'o1' : q.options?.[1]?.id) ?? 'o1' };
  if (q.type === 'number') return { t: 'number', v: 183 + k * 4 };
  const ids = (q.items ?? []).map((it) => it.id);
  return { t: 'ordering', ids: k === 0 ? ['c1', 'c2', 'c3'] : ids };
}

function fbOf(c: Client): Fb {
  return { env: 'dev', projectId: DEV.projectId, app: c.app, auth: c.auth, db: c.db, refs: fbRefs(c.db) };
}

describe('admin panel on DEV', () => {
  it('the «Эфир» button plays the whole game with 3 bots through the real rules', async () => {
    const session = makeSession(admin.auth.currentUser!, host, firebaseBackend(fbOf(admin)));
    const names = ['Бот Аня', 'Бот Дима', 'Владос'];
    for (const [k, p] of bots.entries()) expect(await p.join(names[k] as string)).toEqual({ ok: true });
    for (let t = 0; t < 200 && host.adminView().players.length < 3; t++) await sleep(100);
    expect(await session.run({ type: 'setVlados', uid: bots[2]!.uid })).toBe(true);

    const labels: string[] = [];
    const t0 = Date.now();
    for (;;) {
      if (Date.now() - t0 > 150_000) throw new Error(`stuck: ${JSON.stringify(labels)} phase=${host.adminView().phase}`);
      const v = host.adminView();
      if (v.phase === 'final' && (v.final?.step ?? 0) >= 5) break;
      // guests answer as soon as they can
      await Promise.all(
        bots.map(async (p, k) => {
          const pv = p.view();
          const pay = pv.canAnswer ? botPayload(k, pv) : null;
          if (pay && pv.question) await p.answer(pv.question.i, pay);
        }),
      );
      const a = heroAction(v);
      // let the host lock by itself once everyone answered; press everything else
      if (!a.cmd || v.phase === 'open' || v.phase === 'locked') {
        await sleep(250);
        continue;
      }
      if (labels[labels.length - 1] !== a.label) labels.push(a.label);
      expect(await session.run(a.cmd), `${a.label} (${v.phase})`).toBe(true);
      await sleep(400);
    }
    expect(labels[0]).toBe('Начать игру');
    expect(labels).toEqual(expect.arrayContaining(['Таблица', 'Следующий вопрос', 'Финал', 'Показать 3 место', 'Показать 1 место', 'Спасибо всем!']));

    const s = host.snapshot();
    const rows = standings(s);
    const rounds = roundStats(s);
    expect(rounds.map((r) => [r.qid, r.revealed, r.answered])).toEqual([
      ['a1', true, 2],
      ['a2', true, 2],
      ['a3', true, 2],
    ]);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.isVlados)?.rank).toBeNull();
    // Аня: right choice, exact number (×2), right order — she leads.
    expect(rows[0]?.name).toBe('Бот Аня');
    expect(rows[0]?.correct).toBe(3);
    expect(standingsCsv(rows, rounds).startsWith('\uFEFFМесто;Имя;Очки')).toBe(true);
  }, 200_000);

  it('the Firebase backend uploads, reads back and removes a media file; seeding never overwrites', async () => {
    const backend = firebaseBackend(fbOf(admin));
    const bytes = new Uint8Array(4_000).map((_, i) => i % 251);
    const { id, meta } = await backend.media.upload({ kind: 'image', blob: new Blob([bytes], { type: 'image/jpeg' }), w: 40, h: 30 });
    try {
      expect(meta).toMatchObject({ kind: 'image', w: 40, h: 30, bytes: 4_000, chunks: 1 });
      expect(await backend.media.meta(id)).toMatchObject({ kind: 'image', bytes: 4_000 });
      expect(typeof (await backend.media.url(id))).toBe('string');
      expect(await backend.media.meta('no-such-media-id')).toBeNull();
    } finally {
      await deleteMedia(fbRefs(admin.db), id);
    }
    expect(Array.isArray(await backend.getAdmins())).toBe(true);
    // DEV already has admin/content: the onboarding transaction must leave it alone.
    const before = (await getDocsFromServer(collection(admin.db, 'admin'))).docs.find((d) => d.id === 'content')?.data();
    if (before) expect(await backend.seed(true)).toBe('exists');
  }, 60_000);
});
