// DEV ONLY — the «стоп-экран» end to end (organizer, 2026-09-23: «нажимаю «Показать» — вся викторина
// должна остановиться… ни звука, ничего, только надпись на ТВ; потом переключаюсь на другую вкладку
// и включаю видео от родителей»). Against a LOCAL build (vite preview) and the DEV project:
//
//   npm run build && npx tsx tools/hold-dev.ts          --no-build (reuse dist/app) · --port 4184
//                                                       --shots [tv,admin,phone,long] (runtime/hold/*.png)
//
// Pages: the TV (#/tv, Chromium, «Начать шоу» clicked → it holds the lease and plays the video with
// sound), the admin panel (#/admin/live, Chromium at phone size — the holds go through its buttons),
// one guest phone (WebKit, joined through the form) and a standby Node admin Host (reads the docs).
// Content for the run: a ~15 s video question, then a text question; reveal → board after 30 s.
//
//   1. lobby   — a quick chip: TV only the text, AudioContext suspended, GSAP paused; the phone
//                «Пауза — смотри на экран», reactions off (PlayerSession.react refuses); release.
//   2. video   — «Свой текст…» + «Показать» 4 s into the watch stage: the TV's video paused + muted
//                at its frame, the server's video position frozen, silent through a tab switch and a
//                hidden→visible round trip; released: the video plays on from the same frame.
//   3. open    — a chip 3 s into the answers: the timer frozen (phone and doc), answers off; released
//                (the Node host): exactly the same time left; the phone answers.
//   4. reveal  — held; the TV's host stops (a background tab): its lease expires and the admin host
//                takes over — nothing resumes, nothing moves; released: auto-advance keeps its time.
//
// DEV admin/content is restored afterwards; the test game `hd-<ts>`, the clip and the phone's
// anonymous user are deleted.

import { FB_PROJECTS, type AdminContentDoc, type GameDoc } from '@shared/fbtypes';
import type { ChoiceQ } from '@shared/types';
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { inMemoryPersistence, initializeAuth, signInWithEmailAndPassword, type Auth } from 'firebase/auth';
import { collection, deleteDoc, doc, getDocFromServer, getDocsFromServer, initializeFirestore, memoryLocalCache, setDoc, setLogLevel, terminate, type Firestore } from 'firebase/firestore';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, type BrowserContext, type Page } from 'playwright';
import { ServerClock } from '../app/src/fb/clock';
import { deleteMedia, uploadMedia } from '../app/src/fb/media';
import { fbRefs } from '../app/src/fb/refs';
import { Host } from '../app/src/host/driver';
import { hostContent, hostDeadline } from '../app/src/host/pure';
import { ensureDevBotAdmin } from './dev-bot-admin.mjs';

const DEV = FB_PROJECTS.dev;
if (DEV.projectId !== 'vlados-2609-dev') throw new Error('hold-dev runs against the DEV project only');
setLogLevel('silent');

const args = process.argv.slice(2);
const flag = (k: string) => args.includes(`--${k}`);
const opt = (k: string): string | undefined => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const PORT = opt('port') ?? '4184';
const BASE = `http://localhost:${PORT}/`;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'runtime', 'hold');
const CLIP = join(ROOT, 'runtime', 'video-phone');
mkdirSync(OUT, { recursive: true });
const G = `hd-${Date.now()}`;
const AUTH_KEY = `firebase:authUser:${DEV.apiKey}:[DEFAULT]`;
const NAME_SHIM = 'globalThis.__name = globalThis.__name || ((f) => f)';
const REVEAL_TO_BOARD_S = 30;
/** Which screenshots to take (`--shots` alone: all). */
const SHOTS = new Set(flag('shots') ? (opt('shots')?.startsWith('--') === false ? (opt('shots') as string).split(',') : ['tv', 'admin', 'phone', 'long']) : []);

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

const VQ: ChoiceQ = {
  id: 'hd-video',
  type: 'choice',
  title: 'Что было в конце видео? (тест стоп-экрана)',
  options: [
    { id: 'a', text: 'Торт' },
    { id: 'b', text: 'Кот' },
    { id: 'c', text: 'Шар' },
  ],
  correctId: 'c',
  timeLimitS: 20,
  double: false,
};
const TQ: ChoiceQ = {
  id: 'hd-text',
  type: 'choice',
  title: 'Какой цвет любит Владос? (тест стоп-экрана)',
  options: [
    { id: 'r', text: 'Красный' },
    { id: 'g', text: 'Зелёный' },
    { id: 'b', text: 'Синий' },
  ],
  correctId: 'b',
  timeLimitS: 30,
  double: false,
};

// ------------------------------------------------------------------ Firebase (Node)

interface Client {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
}
const clients: Client[] = [];
async function client(label: string, signIn: (a: Auth) => Promise<unknown>): Promise<Client> {
  const app = initializeApp(DEV, `${label}-${Math.random().toString(36).slice(2, 8)}`);
  const auth = initializeAuth(app, { persistence: inMemoryPersistence });
  await signIn(auth);
  const db = initializeFirestore(app, { localCache: memoryLocalCache(), ignoreUndefinedProperties: true });
  const c = { app, auth, db };
  clients.push(c);
  return c;
}

// ------------------------------------------------------------------ what the pages show

interface MediaSeen {
  tag: string;
  src: string;
  paused: boolean;
  muted: boolean;
  t: number;
  attached: boolean;
}
interface TvSeen {
  ctx: string;
  held: boolean;
  media: MediaSeen[];
  gsapPaused: boolean;
  holdText: string | null;
  liveVisibility: string | null;
}
const tvSeen = (tv: Page): Promise<TvSeen> =>
  tv.evaluate(() => {
    const w = window as unknown as { __tvSound: () => Omit<TvSeen, 'liveVisibility'> };
    const live = document.querySelector('.tv-live');
    return { ...w.__tvSound(), liveVisibility: live ? getComputedStyle(live).visibility : null };
  });
/** The question/reveal video (the persistent element with a blob: source). */
const tvVideo = (s: TvSeen): MediaSeen | undefined => s.media.find((m) => m.tag === 'video' && m.src.startsWith('blob:') && m.t > 0.3);

interface PhoneSeen {
  screen: string;
  held: boolean;
  text: string | null;
  rbar: boolean;
  canAnswer: boolean;
  reactions: boolean;
  timer: number | null;
  opts: number;
}
const phoneSeen = (p: Page): Promise<PhoneSeen> =>
  p.evaluate(() => {
    const pl = (window as unknown as { __pl: { view(): { canAnswer: boolean; reactions: { enabled: boolean }; timer: { remainingMs: number } | null } } }).__pl;
    const v = pl.view();
    return {
      screen: document.querySelector('.pl')?.getAttribute('data-screen') ?? 'none',
      held: !!document.querySelector('.pl-hold'),
      text: document.querySelector('.pl-hold-text')?.textContent ?? null,
      rbar: !!document.querySelector('.vx-rbar'),
      canAnswer: v.canAnswer,
      reactions: v.reactions.enabled,
      timer: v.timer?.remainingMs ?? null,
      opts: Array.from(document.querySelectorAll<HTMLButtonElement>('.pl-q .vx-opt')).filter((b) => b.offsetParent !== null && !b.disabled && b.getAttribute('aria-disabled') !== 'true').length,
    };
  });

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  if (!flag('no-build')) {
    const b = spawnSync(join(ROOT, 'node_modules', '.bin', 'vite'), ['build'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
    if (b.status !== 0) throw new Error('vite build failed');
  }
  const preview = spawn(join(ROOT, 'node_modules', '.bin', 'vite'), ['preview', '--port', PORT, '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  cleanups.push(async () => void preview.kill());
  await until('vite preview', () => fetch(BASE).then((r) => r.ok, () => false), 20_000, 200);
  say(`${BASE} · DEV game ${G}`);

  const bot = await ensureDevBotAdmin();
  const admin = await client('hd-admin', (a) => signInWithEmailAndPassword(a, bot.email, bot.password));
  const refs = fbRefs(admin.db);
  const contentRef = doc(admin.db, 'admin/content');
  const original = (await getDocFromServer(contentRef)).data() as AdminContentDoc | undefined;
  if (!original) throw new Error('DEV admin/content missing — run npm run seed:dev');

  // ---- the test clip (recorded by tools/video-phone-dev.ts into runtime/video-phone)
  if (!existsSync(join(CLIP, 'clip.mp4'))) throw new Error('no test clip: run `npx tsx tools/video-phone-dev.ts` once (it records runtime/video-phone/clip.mp4)');
  const meta = JSON.parse(readFileSync(join(CLIP, 'clip.json'), 'utf8')) as { mime: string; durationS: number };
  const poster = await uploadMedia(refs, { kind: 'image', blob: new Blob([new Uint8Array(readFileSync(join(CLIP, 'poster.jpg')))], { type: 'image/jpeg' }), w: 720, h: 1280 });
  cleanups.push(() => deleteMedia(refs, poster.id));
  const video = await uploadMedia(refs, { kind: 'video', blob: new Blob([new Uint8Array(readFileSync(join(CLIP, 'clip.mp4')))], { type: meta.mime }), w: 720, h: 1280, durationS: meta.durationS, posterId: poster.id });
  cleanups.push(() => deleteMedia(refs, video.id));
  say(`clip ${video.id}: ${meta.durationS} s`);

  const settings = { ...original.settings, autopilot: false, autoAdvance: { ...original.settings.autoAdvance, revealToBoardS: REVEAL_TO_BOARD_S, boardToNextS: null } };
  await setDoc(contentRef, { ...original, rev: original.rev + 1, settings, questions: [{ ...VQ, media: { mediaId: video.id, onPhones: false } }, TQ, ...original.questions] });
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

  // ---- a standby admin Host in Node (reads the docs; takes the lease over when the TV's expires)
  const host = new Host({ db: admin.db, uid: admin.auth.currentUser?.uid ?? '', label: 'admin', reactions: false, followCurrent: false, clock: new ServerClock() });
  await host.start(G);
  await host.whenReady();
  cleanups.push(() => host.stop());
  await until('lobby + video known', () => host.snapshot().game?.phase === 'lobby' && host.snapshot().media[video.id]?.durationS === meta.durationS, 30_000);
  const game = (): GameDoc => host.snapshot().game as GameDoc;
  const deadline = () => {
    const s = host.snapshot();
    return s.game ? hostDeadline({ gameId: G, game: s.game, totals: s.totals, players: s.players, answers: s.answers }, hostContent(s.content)) : null;
  };

  // ---- the organizer's pages (Chromium, signed in as the DEV bot admin)
  const session = await client('hd-sess', (a) => signInWithEmailAndPassword(a, bot.email, bot.password));
  const user = session.auth.currentUser?.toJSON() as Record<string, unknown>;
  user.appName = '[DEFAULT]';
  const cr = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  cleanups.push(() => cr.close());
  const signedIn = async (c: BrowserContext) => {
    await c.addInitScript(NAME_SHIM);
    await c.addInitScript(([k, v]) => localStorage.getItem(k as string) ?? localStorage.setItem(k as string, v as string), [AUTH_KEY, JSON.stringify(user)]);
  };
  const errors: string[] = [];
  const watchErrors = (p: Page, who: string) => {
    p.on('pageerror', (e) => errors.push(`${who} pageerror: ${e.message.slice(0, 200)}`));
    // a failed request is reported by the 'response' hook below (with its URL), not as a page error
    p.on('console', (m) => m.type() === 'error' && !/Could not reach Cloud Firestore|ERR_|net::|Failed to load resource/.test(m.text()) && errors.push(`${who} console.error: ${m.text().slice(0, 200)}`));
    p.on('response', (r) => {
      if (r.status() < 400) return;
      const u = r.url();
      // Firestore's WebChannel answers 400 to a stream it already closed (a listener detached), and a
      // transaction commit that lost a race (two hosts writing the same second) is a 400 the SDK
      // retries on fresh data — both harmless; a command that really failed shows in its result
      const benign = /firestore\.googleapis\.com\/(google\.firestore\.v1\.Firestore\/(Listen|Write)\/channel|v1\/projects\/[^/]+\/databases\/\(default\)\/documents:commit)/.test(u);
      say(`${who}: HTTP ${r.status()} ${u.split('?')[0]}${benign ? ' (Firestore stream / transaction retry, ignored)' : ''}`);
      if (!benign) errors.push(`${who} HTTP ${r.status()} ${u.split('?')[0]}`);
    });
  };

  const tvCtx = await cr.newContext({ viewport: { width: 1280, height: 720 } });
  await signedIn(tvCtx);
  const tv = await tvCtx.newPage();
  watchErrors(tv, 'tv');
  await tv.goto(`${BASE}?env=dev&game=${G}#/tv`);
  await tv.getByRole('button', { name: /Начать шоу/ }).click({ timeout: 60_000 });
  await until('TV holds the lease', () => host.snapshot().lease?.label === 'tv' && host.snapshot().lease!.until > host.now(), 30_000, 200);
  check((await tvSeen(tv)).ctx === 'running', `TV: sound unlocked by «Начать шоу» (AudioContext ${(await tvSeen(tv)).ctx})`);

  const adCtx = await cr.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await signedIn(adCtx);
  const ad = await adCtx.newPage();
  watchErrors(ad, 'admin');
  await ad.goto(`${BASE}?env=dev&game=${G}#/admin/live`);
  await ad.getByRole('button', { name: /Тост! Продолжим через минуту/ }).waitFor({ timeout: 60_000 });
  say('admin panel is live (Эфир)');

  // ---- the guest's phone (WebKit)
  const wk = await webkit.launch();
  cleanups.push(() => wk.close());
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
  await input.fill('Тестер');
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
  await until('host sees the phone', () => Object.keys(host.snapshot().players).length === 1, 30_000, 200);
  say('phone joined');

  const held = () => game().pause?.reason === 'hold';
  const released = async (what: string) => {
    await until(`${what}: released`, () => !game().pause && game().banner === null, 15_000);
    await until(`${what}: TV back`, async () => {
      const s = await tvSeen(tv);
      return !s.held && s.holdText === null && s.ctx === 'running' && !s.gsapPaused && s.liveVisibility === 'visible';
    }, 10_000, 200);
  };
  /** TV + phone while held (after the fade), and the phone's reaction refused. */
  const checkHeld = async (what: string, text: string) => {
    await sleep(1_500);
    const s = await tvSeen(tv);
    check(s.holdText === text && s.liveVisibility === 'hidden', `${what}: TV shows only the text «${s.holdText}» (show hidden: ${s.liveVisibility})`);
    check(s.ctx === 'suspended' && s.held && s.gsapPaused, `${what}: TV silent — AudioContext ${s.ctx}, GSAP paused ${s.gsapPaused}`);
    check(s.media.every((m) => m.paused && m.muted), `${what}: every media element paused + muted (${s.media.map((m) => `${m.tag} paused=${m.paused} muted=${m.muted} t=${m.t}`).join('; ')})`);
    const p = await until(`${what}: phone hold`, async () => {
      const x = await phoneSeen(phone);
      return x.held ? x : null;
    }, 10_000, 200);
    check(p.text === text && !p.canAnswer && !p.reactions && !p.rbar && p.opts === 0, `${what}: phone «Пауза — смотри на экран» + «${p.text}», answers off, reactions off (bar ${p.rbar ? 'shown' : 'gone'})`);
    const r = await phone.evaluate(() => (window as unknown as { __pl: { react(e: number): Promise<unknown> } }).__pl.react(0));
    check(JSON.stringify(r) === JSON.stringify({ ok: false, error: 'disabled' }), `${what}: a reaction is refused on the phone (${JSON.stringify(r)})`);
    return { tv: s, phone: p };
  };

  // ================================================================== 1. lobby (a quick chip)
  say('--- 1. lobby');
  const CHIP1 = '📱 Кто ещё не в игре — наведите камеру на QR-код';
  await ad.getByRole('button', { name: CHIP1 }).click();
  await until('lobby held', held, 10_000);
  check(game().phase === 'lobby' && game().banner === CHIP1, `lobby: one tap = text + hold (phase ${game().phase}, banner «${game().banner}»)`);
  await checkHeld('lobby', CHIP1);
  await ad.getByRole('button', { name: /Убрать надпись и продолжить/ }).click();
  await released('lobby');
  const p1 = await until('phone back in the lobby', async () => {
    const x = await phoneSeen(phone);
    return !x.held && x.screen === 'lobby' ? x : null;
  }, 10_000, 200);
  check(p1.reactions, `lobby released: phone back in the lobby, reactions on again`);

  // ================================================================== 2. the video watch stage («Показать»)
  say('--- 2. video watch stage');
  check((await host.command({ type: 'start' })).ok, 'start');
  const r0 = await until('video playing on the TV ≥ 4 s', async () => {
    const g = game();
    const v = tvVideo(await tvSeen(tv));
    return g.phase === 'intro' && g.round && v && !v.paused && v.t >= 4 ? g.round : null;
  }, 40_000, 150);
  const TEXT2 = 'Сейчас — видеопоздравление от мамы и папы Владоса 💛';
  await ad.getByPlaceholder('Свой текст…').fill(TEXT2);
  await ad.getByRole('button', { name: 'Показать', exact: true }).click();
  await until('video held', held, 10_000);
  const pos0 = host.adminView().watch?.posMs ?? -1;
  const h2 = await checkHeld('video', TEXT2);
  const v1 = tvVideo(h2.tv);
  say(`held at the server's video position ${(pos0 / 1000).toFixed(2)} s; the TV's video stands at ${v1?.t} s`);
  if (SHOTS.has('tv')) await tv.screenshot({ path: join(OUT, '1-tv-hold.png') });
  if (SHOTS.has('admin')) {
    await sleep(800); // the held card scrolls itself into view
    await ad.screenshot({ path: join(OUT, '2-admin-held.png') });
  }
  // the organizer switches tabs (another tab in front), then comes back
  const other = await tvCtx.newPage();
  await other.goto('about:blank');
  await other.bringToFront();
  await tv.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await sleep(3_000);
  await tv.bringToFront();
  await tv.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await other.close();
  await sleep(1_500);
  const s2 = await tvSeen(tv);
  const v2 = tvVideo(s2) ?? s2.media.find((m) => m.tag === 'video' && m.src.startsWith('blob:'));
  check(s2.ctx === 'suspended' && v2?.paused && v2.muted && Math.abs((v2?.t ?? -1) - (v1?.t ?? -2)) < 0.05, `video: still silent after the tab went hidden and came back (ctx ${s2.ctx}, video paused=${v2?.paused} muted=${v2?.muted} at ${v2?.t} s)`);
  check(game().phase === 'intro' && (host.adminView().watch?.posMs ?? -1) === pos0, `video: the server's video position frozen at ${(pos0 / 1000).toFixed(2)} s (${((host.adminView().watch?.posMs ?? -1) / 1000).toFixed(2)} s after ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  await ad.getByRole('button', { name: /Убрать надпись и продолжить/ }).click();
  await released('video');
  await sleep(1_200);
  const s3 = await tvSeen(tv);
  const v3 = tvVideo(s3);
  const pos1 = host.adminView().watch?.posMs ?? -1;
  check(!!v3 && !v3.paused && !v3.muted && v3.t > (v1?.t ?? 0) && v3.t < (v1?.t ?? 0) + 2.5, `video: plays on from the same frame with sound (${v1?.t} s → ${v3?.t} s, muted=${v3?.muted}; server position ${(pos1 / 1000).toFixed(2)} s)`);
  check(r0.openAt < game().round!.openAt, `video: the opening moved by the hold (openAt +${((game().round!.openAt - r0.openAt) / 1000).toFixed(1)} s)`);

  // ================================================================== 3. open question (a chip; released from the Node host)
  say('--- 3. open question');
  await until('the video ends → options open', () => game().phase === 'open' && host.now() > game().round!.openAt + 3_000, 40_000, 200);
  const CHIP3 = '🥂 Тост! Продолжим через минуту';
  await ad.getByRole('button', { name: CHIP3 }).click();
  await until('open held', held, 10_000);
  const R = game().pause!.remainingMs;
  const h3 = await checkHeld('open', CHIP3);
  if (SHOTS.has('phone')) await phone.screenshot({ path: join(OUT, '3-phone-hold.png') });
  check(h3.phone.timer === R, `open: the phone's timer frozen at ${(R / 1000).toFixed(1)} s (${h3.phone.timer})`);
  await sleep(6_000);
  const R2 = host.adminView().timer?.remainingMs;
  const ph3 = await phoneSeen(phone);
  check(R2 === R && ph3.timer === R && game().phase === 'open', `open: 7.5 s later the same ${(R / 1000).toFixed(1)} s left (admin ${R2}, phone ${ph3.timer}), still open`);
  check(deadline() === null, 'open: nothing scheduled while held');
  const back = await host.command({ type: 'unhold' });
  check(back.ok, `unhold → ${JSON.stringify(back)}`);
  await released('open');
  // exact: the round's window ends R after the release (the pause record's end = the release time)
  const rec = await until('pause record', () => host.snapshot().totals?.rounds.at(-1)?.pauses?.at(-1), 10_000);
  const left = game().round!.endsAt - rec.e;
  check(left === R && rec.sh === rec.e - rec.s, `open: resumed with exactly ${(left / 1000).toFixed(3)} s left (had ${(R / 1000).toFixed(3)} s; held ${((rec.e - rec.s) / 1000).toFixed(1)} s, window moved by the same)`);
  const p3 = await until('phone: options back', async () => {
    const x = await phoneSeen(phone);
    return !x.held && x.canAnswer && x.opts > 0 ? x : null;
  }, 10_000, 200);
  check(p3.timer !== null && Math.abs(p3.timer - R) < 2_500, `open: phone back on the question, ${p3.opts} options enabled, timer ${((p3.timer ?? 0) / 1000).toFixed(1)} s`);
  await phone.locator('.pl-q .vx-opt').nth(2).click();
  await until('answer accepted', () => phone.evaluate(() => document.querySelector('.pl')?.getAttribute('data-screen') === 'answered'), 15_000, 200);
  say('phone answered');

  // ================================================================== 4. reveal (TV host in a background tab: the lease expires)
  say('--- 4. reveal');
  check((await host.command({ type: 'reveal', phaseRev: game().phaseRev })).ok, 'reveal (lock)');
  await until('reveal', () => game().phase === 'reveal', 20_000, 200);
  await sleep(3_000);
  const rev = game().phaseRev;
  const hr = await host.command({ type: 'hold', phaseRev: rev, text: '📸 Общее фото — все к экрану!' });
  check(hr.ok, `hold during the reveal → ${JSON.stringify(hr)}`);
  await until('reveal held', held, 10_000);
  const RR = game().pause!.remainingMs;
  check(RR > 20_000 && RR <= REVEAL_TO_BOARD_S * 1000, `reveal: ${(RR / 1000).toFixed(1)} s of the ${REVEAL_TO_BOARD_S} s auto-advance left`);
  await checkHeld('reveal', '📸 Общее фото — все к экрану!');
  // the TV tab stops driving (a throttled background tab): its lease runs out, the admin host takes over
  await tv.evaluate(() => {
    const h = (window as unknown as { __tv: { host: Record<string, unknown> } }).__tv.host;
    (window as unknown as { __pump: unknown }).__pump = h.pump;
    h.pump = async () => undefined;
  });
  // (the admin panel's page or this Node host, whichever is first)
  const took = await until('an admin host takes the lease over', () => {
    const l = host.snapshot().lease;
    return l && l.label === 'admin' && l.until > host.now() ? l : null;
  }, 60_000, 500);
  check(took, `reveal: the TV's lease expired, an admin host took over (${took.session === host.session ? 'this Node host' : 'the admin panel'}, ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  await sleep(3_000);
  const g4 = game();
  check(g4.phase === 'reveal' && g4.phaseRev === rev && g4.pause?.reason === 'hold' && g4.pause.remainingMs === RR && deadline() === null, `reveal: after the takeover still held — phase ${g4.phase}, phaseRev ${g4.phaseRev}, ${(g4.pause?.remainingMs ?? 0) / 1000} s left, nothing scheduled`);
  const s4 = await tvSeen(tv);
  check(s4.ctx === 'suspended' && s4.holdText !== null, `reveal: the TV still silent with the text (ctx ${s4.ctx})`);
  await tv.evaluate(() => {
    const w = window as unknown as { __tv: { host: Record<string, unknown> }; __pump: unknown };
    delete w.__tv.host.pump;
  });
  await until('TV takes the lease back', () => host.snapshot().lease?.label === 'tv' && host.snapshot().lease!.until > host.now(), 40_000, 500);
  const u = host.now();
  check((await host.command({ type: 'unhold' })).ok, 'unhold');
  await released('reveal');
  const d = deadline();
  check(d !== null && Math.abs(d - (u + RR)) < 2_000, `reveal: the board comes ${(((d ?? 0) - u) / 1000).toFixed(1)} s after the release (had ${(RR / 1000).toFixed(1)} s)`);

  check(errors.length === 0, `no page errors (${errors.length}) ${errors.slice(0, 4).join(' | ')}`);

  // ---- the long text on the TV (demo fixture), for the eye
  if (SHOTS.has('long')) {
    const demo = await tvCtx.newPage();
    await demo.goto(`${BASE}?env=dev&demo=hold-long#/tv`);
    await sleep(3_500);
    await demo.screenshot({ path: join(OUT, '4-tv-hold-long.png') });
    await demo.close();
  }
}

const cleanups: (() => Promise<unknown>)[] = [];
let code = 0;
try {
  await main();
} catch (e) {
  code = 1;
  console.error(e);
} finally {
  for (const c of cleanups.reverse()) await c().catch((e: unknown) => say(`cleanup: ${String(e)}`));
  for (const c of clients) {
    await terminate(c.db).catch(() => undefined);
    await deleteApp(c.app).catch(() => undefined);
  }
  say(`cleaned up DEV: games/${G}, test media, admin/content restored`);
}
if (fails.length) {
  console.log(`\nFAILED ${fails.length}:\n - ${fails.join('\n - ')}`);
  code = 1;
} else if (!code) console.log('\nALL OK');
process.exit(code);
