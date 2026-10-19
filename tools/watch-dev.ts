// DEV ONLY — the watch stage of a video question, end to end on Firestore (real rules, real host
// transactions, real PlayerSessions):
//   the answers (and their timer) open only after the video: phones cannot answer while it plays
//   (neither through PlayerSession nor with a raw write), the TV's 'ended' report (host command
//   'watchEnd') opens them after the 3-2-1, the full time limit counts from there, and the scores use
//   the new openAt.
//
//   npx tsx tools/watch-dev.ts
//
// Isolated game `watch-<ts>` with injected content (config/current and admin/content untouched), a
// throwaway video meta (the host only reads kind + duration); everything is deleted afterwards.

import { FB_PROJECTS, type GameDoc } from '@shared/fbtypes';
import { WATCH } from '@shared/engine/watch';
import { defaultSettings } from '@shared/defaults';
import { scoreAnswer } from '@shared/scoring';
import type { ChoiceQ } from '@shared/types';
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { deleteUser, inMemoryPersistence, initializeAuth, signInAnonymously, signInWithEmailAndPassword, type Auth } from 'firebase/auth';
import { collection, deleteDoc, getDocFromServer, getDocsFromServer, initializeFirestore, memoryLocalCache, serverTimestamp, setDoc, setLogLevel, terminate, type Firestore } from 'firebase/firestore';
import { ServerClock } from '../app/src/fb/clock';
import { fbRefs, newAnswerDoc } from '../app/src/fb/refs';
import { Host } from '../app/src/host/driver';
import { PlayerSession } from '../app/src/host/player';
import { resultsOf } from '../app/src/host/pure';
import { ensureDevBotAdmin } from './dev-bot-admin.mjs';

const DEV = FB_PROJECTS.dev;
if (DEV.projectId !== 'vlados-2609-dev') throw new Error('watch-dev runs against the DEV project only');
setLogLevel('silent');

const G = `watch-${Date.now()}`;
const VIDEO = `watchvid${Date.now().toString(36)}`;
const DURATION_S = 8;
const LIMIT_S = 8;
const INTRO = 1_500;
const t0 = Date.now();
const say = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fails: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) fails.push(what);
  say(`${ok ? '  ok  ' : '  FAIL'} ${what}`);
};
const codeOf = (e: unknown) => (e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : String(e));
const outcome = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => codeOf(e));
async function until<T>(what: string, fn: () => T | null | undefined | false, ms = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timeout: ${what}`);
    await sleep(50);
  }
}

const QV: ChoiceQ = {
  id: 'qv',
  type: 'choice',
  title: 'Что было в конце видео?',
  options: [
    { id: 'a', text: 'Торт' },
    { id: 'b', text: 'Кот' },
  ],
  correctId: 'a',
  media: { mediaId: VIDEO, onPhones: false },
  timeLimitS: LIMIT_S,
  double: false,
};
const settings = { ...defaultSettings(), autopilot: false, introMs: INTRO, lockMs: 300, allAnsweredDelayMs: 300, autoAdvance: { revealToBoardS: null, boardToNextS: null, finalStepS: null } };
const CONTENT = { rev: 1, settings, questions: [QV], trash: [] };

interface Client {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  uid: string;
}
const clients: Client[] = [];
async function client(name: string, signIn: (a: Auth) => Promise<unknown>): Promise<Client> {
  const app = initializeApp(DEV, `${name}-${Math.random().toString(36).slice(2, 8)}`);
  const auth = initializeAuth(app, { persistence: inMemoryPersistence });
  await signIn(auth);
  const db = initializeFirestore(app, { localCache: memoryLocalCache(), ignoreUndefinedProperties: true });
  const c = { app, auth, db, uid: auth.currentUser?.uid ?? '' };
  clients.push(c);
  return c;
}

let host: Host | null = null;
let admin: Client | null = null;
const players: PlayerSession[] = [];

async function main(): Promise<void> {
  say(`watch stage on DEV: game ${G}, ${DURATION_S} s video, ${LIMIT_S} s to answer`);
  const bot = await ensureDevBotAdmin();
  admin = await client('admin', (a) => signInWithEmailAndPassword(a, bot.email, bot.password));
  const ra = fbRefs(admin.db);
  await setDoc(ra.mediaChunk(VIDEO, 0), { d: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]) });
  await setDoc(ra.mediaMeta(VIDEO), { kind: 'video', mime: 'video/mp4', w: 640, h: 360, durationS: DURATION_S, bytes: 8, chunks: 1, createdAt: serverTimestamp() } as never);

  host = new Host({ db: admin.db, uid: admin.uid, content: CONTENT, followCurrent: false, preferred: true, label: 'tv', clock: new ServerClock() });
  await host.start(G);
  await host.whenReady();
  const h = host;
  await until('host resolved the video', () => h.snapshot().media[VIDEO]?.durationS === DURATION_S);
  await until('lobby', () => h.snapshot().game?.phase === 'lobby');

  for (const name of ['Соня', 'Макс']) {
    const c = await client('phone', (a) => signInAnonymously(a));
    const p = new PlayerSession({ db: c.db, uid: c.uid, clock: new ServerClock(), gameId: G, timeoutMs: 15_000 });
    await p.start();
    await p.whenReady(20_000);
    const r = await p.join(name);
    if (!r.ok) throw new Error(`join ${name}: ${JSON.stringify(r)}`);
    players.push(p);
  }
  const [p1, p2] = players as [PlayerSession, PlayerSession];
  const pc = clients.slice(1) as [Client, Client, ...Client[]];
  await until('players counted', () => Object.keys(h.snapshot().players).length === 2);

  const start = await h.command({ type: 'start' });
  check(start.ok, 'start');
  const g0 = await until('video round', () => {
    const g = h.snapshot().game;
    return g?.phase === 'intro' && g.round ? g : null;
  });
  const r0 = g0.round as NonNullable<GameDoc['round']>;
  const win = DURATION_S * 1000 + WATCH.tailMs;
  check(r0.media?.watchMs === win, `public round carries the watch window (${r0.media?.watchMs} ms = video + ${WATCH.tailMs / 1000} s)`);
  check(r0.openAt - r0.introAt === INTRO + win + WATCH.beatMs, `fallback: answers open ${(r0.openAt - r0.introAt) / 1000} s after the intro (intro + video + tail + 3-2-1)`);
  const i = r0.i;

  // --- the video plays on the TV
  await until('video playing', () => h.now() >= r0.introAt + INTRO + 2_000);
  const v1 = await until('phone sees the watch stage', () => {
    const v = p1.view();
    return v.watch?.stage === 'play' ? v : null;
  });
  check(v1.screen === 'intro' && v1.timer === null && !v1.canAnswer, `phone during the video: screen ${v1.screen}, no timer, cannot answer`);
  const tried = await p1.answer(i, { t: 'choice', id: 'a' });
  check(!tried.ok && tried.error === 'closed', `PlayerSession.answer during the video → ${tried.ok ? 'ok' : tried.error}`);
  const raw = await outcome(setDoc(fbRefs(pc[1].db).answer(G, i, pc[1].uid), newAnswerDoc(pc[1].uid, i, { t: 'choice', id: 'a' })));
  check(raw === 'permission-denied', `raw answer write during the video refused by the rules (${raw})`);

  // --- the TV reports 'ended'
  await sleep(1_000);
  const before = h.now();
  const ended = await h.command({ type: 'watchEnd', phaseRev: h.snapshot().game?.phaseRev ?? -1 });
  const after = h.now();
  check(ended.ok, `watchEnd (TV 'ended') accepted`);
  const r1 = await until('new openAt', () => {
    const r = h.snapshot().game?.round;
    return r && r.openAt < r0.openAt ? r : null;
  });
  check(r1.openAt >= before + WATCH.beatMs - 50 && r1.openAt <= after + WATCH.beatMs + 50, `answers open 3 s after the report (openAt − report = ${r1.openAt - before} ms)`);
  check(r1.endsAt - r1.openAt === LIMIT_S * 1000, `the full ${LIMIT_S} s count from the new opening`);
  const again = await h.command({ type: 'watchEnd', phaseRev: h.snapshot().game?.phaseRev ?? -1 });
  check(again.ok && h.snapshot().game?.round?.openAt === r1.openAt, 'a second report (admin button / Space) changes nothing');
  const vb = await until('phone sees the 3-2-1', () => {
    const v = p2.view();
    return v.watch?.stage === 'beat' ? v : null;
  });
  check(vb.timer?.kind === 'intro' && vb.timer.remainingMs <= WATCH.beatMs, `phone shows the 3-2-1 (${vb.timer?.remainingMs} ms to go)`);
  if (h.now() < r1.openAt - 1_000) {
    const early = await outcome(setDoc(fbRefs(pc[1].db).answer(G, i, pc[1].uid), newAnswerDoc(pc[1].uid, i, { t: 'choice', id: 'a' })));
    check(early === 'permission-denied', `raw answer during the 3-2-1 refused (${early})`);
  }

  // --- answers
  await until('phone can answer', () => p1.view().canAnswer, 10_000);
  const a1 = await p1.answer(i, { t: 'choice', id: 'a' });
  check(a1.ok, 'guest 1 answers right after the opening');
  const oldEndsAt = r0.introAt + INTRO + LIMIT_S * 1000;
  await until('late in the window', () => h.now() >= r1.openAt + (LIMIT_S - 2) * 1000);
  const a2 = await p2.answer(i, { t: 'choice', id: 'b' });
  check(a2.ok && h.now() > oldEndsAt, `guest 2 answers ${((h.now() - r1.openAt) / 1000).toFixed(1)} s after the opening — ${((h.now() - oldEndsAt) / 1000).toFixed(1)} s after the timer would have run out if it had started with the video`);

  // --- reveal: scores use the new openAt
  const gr = await until('reveal', () => {
    const g = h.snapshot().game;
    return g?.phase === 'reveal' && g.reveal ? g : null;
  }, 20_000);
  const pr = await until('totals', () => h.snapshot().totals?.rounds.find((r) => r.i === i && r.res));
  const res = resultsOf(pr);
  check(pr.openAt === r1.openAt, 'private/totals keeps the new openAt');
  for (const [k, c] of pc.slice(0, 2).entries()) {
    const d = (await getDocFromServer(fbRefs(admin.db).answer(G, i, c.uid))).data();
    const x = res[c.uid];
    const want = d ? Math.min(LIMIT_S * 1000, Math.max(0, d.at - r1.openAt)) : NaN;
    const pts = d ? scoreAnswer(QV, { p: d.p, elapsedMs: want }, settings.scoring, false).points : NaN;
    check(!!x && x.e === want && gr.reveal?.me[c.uid]?.pts === pts, `guest ${k + 1}: elapsed ${x?.e} ms = answer.at − new openAt, ${pts} pts`);
  }
}

async function cleanup(): Promise<void> {
  for (const p of players) p.stop();
  await host?.stop().catch(() => undefined);
  if (admin) {
    const r = fbRefs(admin.db);
    for (const col of [r.answers(G), r.reactions(G), r.players(G), collection(admin.db, `games/${G}/private`), r.mediaChunks(VIDEO)]) {
      try {
        const snap = await getDocsFromServer(col);
        await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
      } catch (e) {
        console.warn('cleanup', codeOf(e));
      }
    }
    await deleteDoc(r.mediaMeta(VIDEO)).catch(() => undefined);
    await deleteDoc(r.game(G)).catch(() => undefined);
    await deleteDoc(r.clockProbe(admin.uid)).catch(() => undefined);
  }
  for (const c of clients) {
    const u = c.auth.currentUser;
    if (u?.isAnonymous) await deleteUser(u).catch(() => undefined);
    await terminate(c.db).catch(() => undefined);
    await deleteApp(c.app).catch(() => undefined);
  }
  say(`deleted games/${G}, media ${VIDEO} and the guest users`);
}

let code = 0;
try {
  await main();
} catch (e) {
  code = 1;
  console.error(e);
} finally {
  await cleanup().catch((e) => console.error('cleanup failed', e));
}
if (fails.length) {
  console.log(`\n${fails.length} check(s) failed`);
  code = 1;
} else if (!code) console.log('\nall checks passed');
process.exit(code);
