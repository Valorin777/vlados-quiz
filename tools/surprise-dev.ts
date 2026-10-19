// DEV ONLY — the «Сюрприз» end to end (organizer, 2026-09-25: on the last question, while the
// options are on screen and before everyone has answered, the TV «breaks down», goes black for 2 s
// and plays the video from the party; after it the right answer and the final). Against a LOCAL
// build (vite preview) or a running dev server, and the DEV project:
//
//   npx tsx tools/surprise-dev.ts          --base http://localhost:5181/ (reuse a dev server; else
//                                          build + vite preview on --port 4186) · --shots (runtime/surprise/*.png)
//
// Pages: the TV (#/tv, WebKit — H.264 like Safari; «Начать шоу» clicked → it holds the lease, loads
// the built-in video into memory, plays it with sound) and one guest phone (WebKit, joined through
// the form). Plus 3 Node bots (PlayerSession) and a standby Node admin Host (reads the docs, sends
// the organizer's commands). Content: the surprise question (30 s, the interrupt 6 s after the
// options), then a normal question that must never be played.
//
//   1. the question opens; bot 1 answers (right) 2 s in
//   2. the interrupt: phase 'locked' with next.surprise at openAt + 6 s — no early lock before it
//   3. bots 2 and 3 answer after it: PlayerSession refuses, a raw write is refused by the rules
//   4. TV: breakdown → black → the built-in video from memory, playing, NOT muted; the phone:
//      glitch → black → «Смотри на экран», answering off
//   5. «стоп-экран» during the video: paused + muted at its frame; released: plays on from it
//   6. the TV's video is sought to its last seconds → 'ended' → surpriseEnd → the reveal (bot 1
//      scored, bots 2–3 «не успел»), the phone's overlay gone → ~10 s later the final by itself;
//      the second question never played
//
// DEV admin/content is restored afterwards; the test game `sp-<ts>` and the anonymous users are deleted.

import { SURPRISE } from '@shared/engine/surprise';
import { FB_PROJECTS, type AdminContentDoc, type GameDoc } from '@shared/fbtypes';
import type { ChoiceQ } from '@shared/types';
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { deleteUser, inMemoryPersistence, initializeAuth, signInAnonymously, signInWithEmailAndPassword, type Auth } from 'firebase/auth';
import { collection, deleteDoc, doc, getDocFromServer, getDocsFromServer, initializeFirestore, memoryLocalCache, setDoc, setLogLevel, terminate, type Firestore } from 'firebase/firestore';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, type BrowserContext, type Page } from 'playwright';
import { ServerClock } from '../app/src/fb/clock';
import { fbRefs, newAnswerDoc } from '../app/src/fb/refs';
import { Host } from '../app/src/host/driver';
import { PlayerSession } from '../app/src/host/player';
import { resultsOf } from '../app/src/host/pure';
import { ensureDevBotAdmin } from './dev-bot-admin.mjs';

const DEV = FB_PROJECTS.dev;
if (DEV.projectId !== 'vlados-2609-dev') throw new Error('surprise-dev runs against the DEV project only');
setLogLevel('silent');

const args = process.argv.slice(2);
const flag = (k: string) => args.includes(`--${k}`);
const opt = (k: string): string | undefined => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const PORT = opt('port') ?? '4186';
const BASE = opt('base') ?? `http://localhost:${PORT}/`;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'runtime', 'surprise');
mkdirSync(OUT, { recursive: true });
const G = `sp-${Date.now()}`;
const AUTH_KEY = `firebase:authUser:${DEV.apiKey}:[DEFAULT]`;
const NAME_SHIM = 'globalThis.__name = globalThis.__name || ((f) => f)';
const AFTER_S = 6;
const LEAD = SURPRISE.glitchMs + SURPRISE.blackMs;

const t0 = Date.now();
const say = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fails: string[] = [];
const check = (ok: unknown, what: string) => {
  if (!ok) fails.push(what);
  say(`${ok ? '  ok  ' : '  FAIL'} ${what}`);
};
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 30_000, every = 100): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timeout (${ms} ms): ${what}`);
    await sleep(every);
  }
}

const QS: ChoiceQ = {
  id: 'sp-last',
  type: 'choice',
  title: 'Кто лучше всех поздравил Владоса? (тест сюрприза)',
  options: [
    { id: 'a', text: 'Мама и папа' },
    { id: 'b', text: 'Одноклассники' },
    { id: 'c', text: 'Лучший друг' },
  ],
  correctId: 'a',
  timeLimitS: 30,
  double: false,
  surprise: { on: true, src: 'builtin', afterS: AFTER_S },
};
const QN: ChoiceQ = {
  id: 'sp-never',
  type: 'choice',
  title: 'Этот вопрос не должен показаться (тест сюрприза)',
  options: [
    { id: 'x', text: 'Да' },
    { id: 'y', text: 'Нет' },
  ],
  correctId: 'y',
  timeLimitS: 20,
  double: false,
};

// ------------------------------------------------------------------ Firebase (Node)

interface Client {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  uid: string;
}
const clients: Client[] = [];
async function client(label: string, signIn: (a: Auth) => Promise<unknown>): Promise<Client> {
  const app = initializeApp(DEV, `${label}-${Math.random().toString(36).slice(2, 8)}`);
  const auth = initializeAuth(app, { persistence: inMemoryPersistence });
  await signIn(auth);
  const db = initializeFirestore(app, { localCache: memoryLocalCache(), ignoreUndefinedProperties: true });
  const c = { app, auth, db, uid: auth.currentUser?.uid ?? '' };
  clients.push(c);
  return c;
}

// ------------------------------------------------------------------ what the pages show

interface TvSeen {
  layer: string | null;
  video: { src: string; paused: boolean; muted: boolean; volume: number; t: number; d: number; attached: boolean } | null;
  ctx: string;
  dark: boolean;
}
const tvSeen = (tv: Page): Promise<TvSeen> =>
  tv.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>('.tsu-host video');
    const w = window as unknown as { __tvSound?: () => { ctx: string } };
    return {
      layer: document.querySelector('.tsu')?.className ?? null,
      video: v ? { src: v.currentSrc.slice(0, 30), paused: v.paused, muted: v.muted, volume: v.volume, t: Math.round(v.currentTime * 100) / 100, d: v.duration, attached: v.isConnected } : null,
      ctx: w.__tvSound?.().ctx ?? 'none',
      dark: document.documentElement.classList.contains('tv-sur-dark'),
    };
  });

interface PhoneSeen {
  screen: string;
  sur: string | null;
  text: string | null;
  held: boolean;
  canAnswer: boolean;
}
const phoneSeen = (p: Page): Promise<PhoneSeen> =>
  p.evaluate(() => {
    const pl = (window as unknown as { __pl?: { view(): { canAnswer: boolean } } }).__pl;
    return {
      screen: document.querySelector('.pl')?.getAttribute('data-screen') ?? 'none',
      sur: document.querySelector('.pl-sur')?.className ?? null,
      text: document.querySelector('.pl-sur-h')?.textContent ?? null,
      held: !!document.querySelector('.pl-hold'),
      canAnswer: pl?.view().canAnswer ?? false,
    };
  });

// ------------------------------------------------------------------ main

const cleanups: (() => Promise<unknown>)[] = [];

async function main(): Promise<void> {
  if (!opt('base')) {
    if (!flag('no-build')) {
      const b = spawnSync(join(ROOT, 'node_modules', '.bin', 'vite'), ['build'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
      if (b.status !== 0) throw new Error('vite build failed');
    }
    const preview = spawn(join(ROOT, 'node_modules', '.bin', 'vite'), ['preview', '--port', PORT, '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
    cleanups.push(async () => void preview.kill());
  }
  await until('site up', () => fetch(BASE).then((r) => r.ok, () => false), 20_000, 200);
  say(`${BASE} · DEV game ${G}`);

  const bot = await ensureDevBotAdmin();
  const admin = await client('sp-admin', (a) => signInWithEmailAndPassword(a, bot.email, bot.password));
  const refs = fbRefs(admin.db);
  const contentRef = doc(admin.db, 'admin/content');
  const original = (await getDocFromServer(contentRef)).data() as AdminContentDoc | undefined;
  if (!original) throw new Error('DEV admin/content missing — run npm run seed:dev');
  const settings = { ...original.settings, autopilot: false, introMs: 4_000, autoAdvance: { ...original.settings.autoAdvance, revealToBoardS: null, boardToNextS: null, finalStepS: null } };
  await setDoc(contentRef, { ...original, rev: original.rev + 1, settings, questions: [QS, QN] });
  cleanups.push(async () => {
    const now = (await getDocFromServer(contentRef)).data() as AdminContentDoc | undefined;
    await setDoc(contentRef, { ...original, rev: Math.max(original.rev, now?.rev ?? 0) + 1 });
  });
  cleanups.push(async () => {
    for (const col of [refs.answers(G), refs.reactions(G), refs.players(G), collection(admin.db, `games/${G}/private`)]) {
      const snap = await getDocsFromServer(col).catch(() => null);
      await Promise.all((snap?.docs ?? []).map((d) => deleteDoc(d.ref)));
    }
    await deleteDoc(refs.game(G)).catch(() => undefined);
  });

  // ---- a standby admin Host in Node (the organizer's commands; the TV holds the lease)
  const host = new Host({ db: admin.db, uid: admin.uid, label: 'admin', reactions: false, followCurrent: false, clock: new ServerClock() });
  await host.start(G);
  await host.whenReady();
  cleanups.push(() => host.stop());
  await until('lobby with the surprise question', () => host.snapshot().game?.phase === 'lobby' && host.snapshot().content?.questions[0]?.surprise?.on === true, 30_000);
  const game = (): GameDoc => host.snapshot().game as GameDoc;

  // ---- the TV (WebKit: plays H.264 like the party Mac's Safari)
  const session = await client('sp-sess', (a) => signInWithEmailAndPassword(a, bot.email, bot.password));
  const user = session.auth.currentUser?.toJSON() as Record<string, unknown>;
  user.appName = '[DEFAULT]';
  const wk = await webkit.launch();
  cleanups.push(() => wk.close());
  const signedIn = async (c: BrowserContext) => {
    await c.addInitScript(NAME_SHIM);
    await c.addInitScript(([k, v]) => localStorage.getItem(k as string) ?? localStorage.setItem(k as string, v as string), [AUTH_KEY, JSON.stringify(user)]);
  };
  const errors: string[] = [];
  const watchErrors = (p: Page, who: string) => {
    p.on('pageerror', (e) => errors.push(`${who} pageerror: ${e.message.slice(0, 200)}`));
    p.on('console', (m) => m.type() === 'error' && !/Could not reach Cloud Firestore|ERR_|net::|Failed to load resource|Fetch API cannot load/.test(m.text()) && errors.push(`${who} console.error: ${m.text().slice(0, 200)}`));
  };
  const tvCtx = await wk.newContext({ viewport: { width: 1280, height: 720 } });
  await signedIn(tvCtx);
  const tv = await tvCtx.newPage();
  watchErrors(tv, 'tv');
  await tv.goto(`${BASE}?env=dev&game=${G}#/tv`);
  const go = tv.getByRole('button', { name: /Начать шоу/ });
  await go.waitFor({ timeout: 60_000 });
  // the gate shows the big video loading into memory
  const gate = await until('gate: the big video in memory', () => tv.evaluate(() => [...document.querySelectorAll('.tg-media span')].map((x) => x.textContent ?? '').find((x) => /Большое видео уже в памяти/.test(x)) ?? null), 60_000, 300);
  check(!!gate, `TV gate: «${gate}»`);
  await go.click();
  await until('TV holds the lease', () => host.snapshot().lease?.label === 'tv' && host.snapshot().lease!.until > host.now(), 30_000, 200);

  // ---- the guest's phone (WebKit)
  const phCtx = await wk.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  });
  await phCtx.addInitScript(NAME_SHIM);
  const phone = await phCtx.newPage();
  watchErrors(phone, 'phone');
  await phone.goto(`${BASE}?env=dev&game=${G}#/`);
  await until('phone: join', () => phone.evaluate(() => document.querySelector('.pl')?.getAttribute('data-screen') === 'join').catch(() => false), 45_000, 200);
  const early = phone.getByRole('button', { name: 'Зарегистрируйся заранее' });
  const input = phone.locator('input').first();
  await until('name field', async () => (await early.isVisible().catch(() => false)) || (await input.isVisible().catch(() => false)), 20_000, 200);
  if (await early.isVisible().catch(() => false)) await early.click();
  await input.fill('Телефон');
  await phone.getByRole('button', { name: 'Дальше' }).click();
  await phone.getByRole('button', { name: 'Пропустить' }).click();
  await until('phone: lobby', async () => (await phoneSeen(phone)).screen === 'lobby', 30_000, 200);
  cleanups.push(async () => {
    await phone
      .evaluate(async ([k, apiKey]) => {
        const u = JSON.parse(localStorage.getItem(k as string) ?? '{}') as { stsTokenManager?: { accessToken?: string } };
        const idToken = u.stsTokenManager?.accessToken;
        if (idToken) await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${apiKey}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken }) }).catch(() => undefined);
      }, [AUTH_KEY, DEV.apiKey])
      .catch(() => undefined);
  });

  // ---- 3 bots
  const bots: PlayerSession[] = [];
  const botClients: Client[] = [];
  for (const name of ['Бот-Успел', 'Бот-Опоздал', 'Бот-Совсем']) {
    const c = await client('sp-bot', (a) => signInAnonymously(a));
    botClients.push(c);
    cleanups.push(async () => c.auth.currentUser && deleteUser(c.auth.currentUser).catch(() => undefined));
    const p = new PlayerSession({ db: c.db, uid: c.uid, clock: new ServerClock(), gameId: G, timeoutMs: 15_000 });
    await p.start();
    await p.whenReady(20_000);
    const r = await p.join(name);
    if (!r.ok) throw new Error(`join ${name}: ${JSON.stringify(r)}`);
    bots.push(p);
    cleanups.push(async () => p.stop());
  }
  const [b1, b2, b3] = bots as [PlayerSession, PlayerSession, PlayerSession];
  await until('4 players', () => Object.keys(host.snapshot().players).length === 4, 30_000, 200);
  say('3 bots + the phone joined');

  // ================================================================== 1. the question
  check((await host.command({ type: 'start' })).ok, 'start');
  const r0 = await until('open', () => (game().phase === 'open' && game().round ? game().round : null), 30_000, 100);
  const i = r0.i;
  check(!game().next?.surprise && !('surprise' in (game().round as object)), 'nothing public says a surprise is coming');
  await until('2 s into the question', () => host.now() >= r0.openAt + 2_000, 10_000, 50);
  const a1 = await b1.answer(i, { t: 'choice', id: 'a' });
  check(a1.ok, `bot 1 answers 2 s in (before the interrupt): ${JSON.stringify(a1)}`);
  // the phone answers too (tap the right option), before the interrupt
  const tapped = await phone.evaluate(() => {
    const b = [...document.querySelectorAll<HTMLButtonElement>('.pl-q .vx-opt')].find((x) => /Мама и папа/.test(x.textContent ?? ''));
    b?.click();
    return !!b;
  });
  check(tapped, 'the phone taps «Мама и папа» before the interrupt');

  // ================================================================== 2. the interrupt
  const g1 = await until('the interrupt', () => (game().phase === 'locked' && game().next?.surprise ? game() : null), 20_000, 50);
  const S = g1.next!.surprise!.at;
  check(Math.abs(S - (r0.openAt + AFTER_S * 1000)) < 1_500, `the interrupt at openAt + ${((S - r0.openAt) / 1000).toFixed(2)} s (asked ${AFTER_S} s)`);
  check(g1.round!.endsAt === S && g1.reveal === null, 'the answer window closed at the interrupt (endsAt = its start), no reveal');
  const tvG = await until('TV: breakdown', async () => {
    const s = await tvSeen(tv);
    return s.layer?.includes('is-glitch') ? s : null;
  }, 5_000, 30);
  check(tvG.dark, `TV: «сбой эфира» on screen ${((host.now() - S) / 1000).toFixed(2)} s after the interrupt`);
  if (flag('shots')) {
    await sleep(900);
    await tv.screenshot({ path: join(OUT, '1-tv-breakdown.png') });
  }
  const ph1 = await until('phone: glitch/black', async () => {
    const x = await phoneSeen(phone);
    return x.sur ? x : null;
  }, 5_000, 50);
  check(!ph1.canAnswer, `phone: surprise overlay (${ph1.sur}), answering off`);

  // ================================================================== 3. late answers are refused
  await until('S + 2.5 s', () => host.now() >= S + 2_500, 10_000, 50);
  const a2 = await b2.answer(i, { t: 'choice', id: 'a' });
  check(!a2.ok, `bot 2 answers 2.5 s after the interrupt → refused (${JSON.stringify(a2)})`);
  const raw = await setDoc(fbRefs(botClients[1]!.db).answer(G, i, botClients[1]!.uid), newAnswerDoc(botClients[1]!.uid, i, { t: 'choice', id: 'a' })).then(
    () => 'written',
    (e: { code?: string }) => e.code ?? 'error',
  );
  check(raw === 'permission-denied', `bot 2's raw write after the interrupt: ${raw}`);

  // ================================================================== 4. black → the video
  const tvB = await until('TV: black', async () => {
    const s = await tvSeen(tv);
    return s.layer?.includes('is-black') ? s : null;
  }, 6_000, 50);
  check(!!tvB, 'TV: pure black after the breakdown');
  await until('S + 6 s', () => host.now() >= S + 6_000, 10_000, 50);
  const a3 = await b3.answer(i, { t: 'choice', id: 'a' });
  check(!a3.ok, `bot 3 answers 6 s after the interrupt → refused (${JSON.stringify(a3)})`);
  const tvV = await until('TV: the video plays', async () => {
    const s = await tvSeen(tv);
    return s.layer?.includes('is-play') && s.video && !s.video.paused && s.video.t > 1.5 ? s : null;
  }, 20_000, 100);
  check(tvV.video!.src.startsWith('blob:'), `TV: the built-in video from memory (${tvV.video!.src}…)`);
  check(!tvV.video!.muted && tvV.video!.volume === 1, `TV: WITH SOUND (muted=${tvV.video!.muted}, volume ${tvV.video!.volume})`);
  check(Math.abs(tvV.video!.d - SURPRISE.builtin.ms / 1000) < 0.5, `TV: the whole video (${tvV.video!.d.toFixed(1)} s)`);
  const ph2 = await until('phone: «Смотри на экран»', async () => {
    const x = await phoneSeen(phone);
    return x.sur?.includes('is-watch') ? x : null;
  }, 10_000, 100);
  check(ph2.text === 'Смотри на экран' && !ph2.canAnswer, `phone: «${ph2.text}», answering off`);
  if (flag('shots')) {
    await sleep(2_500);
    await tv.screenshot({ path: join(OUT, '2-tv-video.png') });
    await phone.screenshot({ path: join(OUT, '3-phone-watch.png') });
  }

  // ================================================================== 5. «стоп-экран» during the video
  await until('10 s of video', async () => ((await tvSeen(tv)).video?.t ?? 0) >= 10, 30_000, 200);
  const hold = await host.command({ type: 'hold', phaseRev: game().phaseRev, text: 'Небольшая пауза' });
  check(hold.ok, 'hold during the video');
  await sleep(1_500);
  const h1 = await tvSeen(tv);
  await sleep(4_000);
  const h2 = await tvSeen(tv);
  check(h1.video?.paused && h1.video.muted && h2.video?.paused && Math.abs((h2.video?.t ?? 0) - (h1.video?.t ?? -1)) < 0.05, `held: the video paused + muted at ${h1.video?.t} s (still ${h2.video?.t} s 4 s later)`);
  const ph3 = await phoneSeen(phone);
  check(ph3.held, 'held: the phone shows the hold screen');
  const atHeld = game().next?.surprise?.at ?? 0;
  const heldFor = Date.now();
  check((await host.command({ type: 'unhold' })).ok, 'unhold');
  const h3 = await until('released: plays on', async () => {
    const s = await tvSeen(tv);
    return s.video && !s.video.paused && s.video.t > (h2.video?.t ?? 0) + 0.2 ? s : null;
  }, 10_000, 100);
  check(!h3.video!.muted && h3.video!.t < (h2.video?.t ?? 0) + 2, `released: plays on from the same frame with sound (${h2.video?.t} → ${h3.video!.t} s, muted=${h3.video!.muted})`);
  // (from the server: this Node page's listener may still be a moment behind the TV's)
  const shift = await until('the stage moved', async () => {
    const g = (await getDocFromServer(refs.game(G))).data();
    const d = (g?.next?.surprise?.at ?? 0) - atHeld;
    return d > 0 ? d : null;
  }, 5_000, 300).catch(() => 0);
  check(shift >= 5_000 && shift <= 5_000 + (Date.now() - heldFor) + 2_000, `released: the stage moved by the hold (+${(shift / 1000).toFixed(1)} s)`);

  // ================================================================== 6. the end → the reveal → the final
  await tv.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>('.tsu-host video');
    if (v) v.currentTime = Math.max(0, v.duration - 3);
  });
  say('the TV video sought to its last 3 s');
  const gR = await until('the reveal (TV reported the end)', () => (game().phase === 'reveal' ? game() : null), 20_000, 100);
  const revealAt = host.now();
  const rv = gR.reveal!;
  const uids = botClients.map((c) => c.uid);
  check((rv.me[uids[0]!]?.pts ?? 0) > 0 && rv.me[uids[0]!]?.ok, `reveal: bot 1 scored (${rv.me[uids[0]!]?.pts} pts)`);
  check((rv.me[uids[1]!]?.pts ?? -1) === 0 && (rv.me[uids[2]!]?.pts ?? -1) === 0, `reveal: bots 2 and 3 «не успел» (${rv.me[uids[1]!]?.pts}, ${rv.me[uids[2]!]?.pts} pts)`);
  const res = resultsOf(host.snapshot().totals!.rounds.find((r) => r.i === i)!);
  check(Object.keys(res).length === 2 && !res[uids[1]!] && !res[uids[2]!], `counted answers: ${Object.keys(res).length} (bot 1 + the phone)`);
  const d2 = await getDocFromServer(fbRefs(admin.db).answer(G, i, uids[1]!));
  check(!d2.exists(), 'no answer doc of bot 2 landed');
  const ph4 = await until('phone: the reveal', async () => {
    const x = await phoneSeen(phone);
    return x.screen === 'reveal' && !x.sur ? x : null;
  }, 10_000, 100);
  check(!!ph4, 'phone: the overlay is gone, the reveal is on');
  const tvR = await until('TV: the layer melted away', async () => {
    const s = await tvSeen(tv);
    return s.layer === null ? s : null;
  }, 8_000, 100);
  check(!tvR.dark, 'TV: the melt finished, the black is gone');
  if (flag('shots')) await tv.screenshot({ path: join(OUT, '4-tv-reveal.png') });
  const gF = await until('the final by itself', () => (game().phase === 'final' ? game() : null), 20_000, 100);
  const after = (host.now() - revealAt) / 1000;
  check(gF.final?.step === 0 && after > 8 && after < 13, `the final ${after.toFixed(1)} s after the reveal (no board)`);
  check(host.snapshot().totals?.rounds.length === 1, `the second question was never played (${host.snapshot().totals?.rounds.length} round)`);
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
}

let code = 0;
try {
  await main();
} catch (e) {
  code = 1;
  say(`ERROR ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
} finally {
  for (const c of cleanups.reverse()) await c().catch((e: unknown) => say(`cleanup: ${String(e)}`));
  for (const c of clients) {
    await terminate(c.db).catch(() => undefined);
    await deleteApp(c.app).catch(() => undefined);
  }
}
if (fails.length) {
  code = 1;
  say(`${fails.length} FAILED:\n  ${fails.join('\n  ')}`);
} else if (!code) say('all good');
process.exit(code);
