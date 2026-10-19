// End-to-end run of the DEPLOYED site against the DEV project (never prod), driven exactly like the
// organizer will drive the party: the TV page (#/tv, signed in as the DEV bot admin) + 2 real phone
// pages (WebKit 390×844, one light, one dark) + 10 Node bots (PlayerSession) play the show to its end.
//
//   npx tsx tools/e2e-live.ts                       (npm run e2e:live)
//   npm run e2e:local                               build + `vite preview` + this, on localhost:4173
//   npm run e2e:local -- --manual                   the same with the «Автопилот» OFF (E2E_MANUAL=1 too)
//   E2E_BASE=http://localhost:4173/ npx tsx tools/e2e-live.ts     against a running local preview
//   E2E_SHOTS=tv-final-mosaic,phones-final npm run e2e:live      only those screenshots
//
// Default: the «Автопилот» ON (settings.autopilot undefined, like PROD): the organizer presses only
// «Начать игру» (TV Space) and the run asserts that the whole show then advances BY ITSELF with the
// SHOW timings (±1.5 s, from the host's stored phase times): intro → options → lock → answer (text
// 12 s, photo 16 s, video: 2 s after the TV reported its end — 'revealMediaEnd') → board 7 s → next
// question … the LAST question is a «Сюрприз» (4 s after the options; this run's own short video,
// uploaded through the admin's media path, instead of the 4-min built-in one): breakdown → black
// 2 s → the video → the answer → 10 s → the final: drumroll → 3rd → 2nd → 1st → Vlados → «С днём
// рождения» (4 / 4.5 / 4.5 / 7 / 9 s) → the video after the final 5 s later (the built-in
// finale.mp4, 15 s) → the end. `--manual` (autopilot: false) presses Space for every step instead
// (only the always-timed steps are timed then), so both modes stay tested.
//
// Checks: no console errors, every phase renders on the TV and on both phones, TV and phone timers
// agree (±1 s), the points and rank a phone shows equal the reveal data, reactions from phones reach
// the TV, the phones' «Смотри на экран» during the «Сюрприз» and the video after the final, their
// place in the final before it. The VIDEO question (first): a ~7 s test clip (H.264 + AAC, recorded
// in WebKit) goes through the admin's own media path — the editor's media slot on #/admin
// (compression, poster, chunks) + autosave — and then: the TV plays it big with sound, the phones
// show «Смотри видео на большом экране» (poster, no options, no timer) and cannot answer
// (PlayerSession → 'closed', a raw write → rules refuse), the answers open only after the TV
// reported the video's end (3-2-1, full time limit), and every answer is scored from that
// post-video openAt. The same clip is the answer's video of another question and the «Сюрприз»;
// its poster is the answer's photo of a third one.
// Screenshots go to runtime/e2e/ (gitignored). Uses its own game id `e2e-<ts>`, temporarily changes
// DEV admin/content and restores everything afterwards (test game, media, bot + phone anonymous
// users). The DEV bot admin's session is created here in Node and handed to the TV/admin pages'
// storage — nobody types a password into a page.

import { FINALE } from '@shared/engine/finale';
import { SHOW, autoHoldMs } from '@shared/engine/showTimings';
import { SURPRISE, surpriseLeadMs } from '@shared/engine/surprise';
import { WATCH } from '@shared/engine/watch';
import { FB_PROJECTS, type AdminContentDoc, type GameDoc, type MediaMetaDoc, type RoundPub } from '@shared/fbtypes';
import { scoreAnswer } from '@shared/scoring';
import type { AnswerPayload, ChoiceQ, Question, Settings } from '@shared/types';
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { deleteUser, inMemoryPersistence, initializeAuth, signInAnonymously, signInWithEmailAndPassword, type Auth } from 'firebase/auth';
import { collection, deleteDoc, doc, getDocFromServer, getDocsFromServer, initializeFirestore, memoryLocalCache, setDoc, setLogLevel, terminate, type Firestore } from 'firebase/firestore';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, type Browser, type BrowserContext, type Page } from 'playwright';
import { ServerClock } from '../app/src/fb/clock';
import { deleteMedia } from '../app/src/fb/media';
import { fbRefs, newAnswerDoc } from '../app/src/fb/refs';
import { HOST_TIMING, type TotalsDoc } from '../app/src/host/model';
import { PlayerSession } from '../app/src/host/player';
import { hostContent } from '../app/src/host/pure';
import { ensureDevBotAdmin } from './dev-bot-admin.mjs';

const DEV = FB_PROJECTS.dev;
if (DEV.projectId !== 'vlados-2609-dev') throw new Error('e2e-live runs against the DEV project only');
setLogLevel('error');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.E2E_BASE ?? 'https://valorin777.github.io/vlados/';
/** --manual / E2E_MANUAL=1: the «Автопилот» off, the organizer's Space for every step. */
const MANUAL = process.argv.includes('--manual') || process.env.E2E_MANUAL === '1';
/** The show's timings are checked with this tolerance (host tick + transaction + clock sample). */
const TOL_MS = 1_500;
/** «Через сколько секунд после появления вариантов» of the «Сюрприз» (the organizer's default). */
const SURPRISE_AFTER_S = SURPRISE.afterDefaultS;
const OUT = join(ROOT, 'runtime', 'e2e');
/** DEV admin/content as it was when the last clean run started (an interrupted run is undone from it). */
const CONTENT_BACKUP = join(OUT, 'content-before-e2e.json');
const G = `e2e-${Date.now()}`;
const BOT_NAMES = ['Соня', 'Макс', 'Артём', 'Катя', 'Лёша', 'Владос', 'Дима', 'Настя', 'Егор', 'Полина'];
const VLADOS_BOT = 5;
const PHONES = [
  { name: 'Валера', mode: 'light' as const },
  { name: 'Оля', mode: 'dark' as const },
];
const MAX_SHOTS = 24;
/** The video question (inserted first into the DEV content for the run). */
const VIDEO_S = 7.3;
const VQ_LIMIT_S = 10;
const VQ: ChoiceQ = {
  id: 'e2e-video',
  type: 'choice',
  title: 'Что каталось по экрану в тестовом видео? (e2e)',
  options: [
    { id: 'a', text: 'Шар' },
    { id: 'b', text: 'Куб' },
    { id: 'c', text: 'Звезда' },
    { id: 'd', text: 'Ничего' },
  ],
  correctId: 'a',
  timeLimitS: VQ_LIMIT_S,
  double: false,
};

mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
const say = (m: string) => console.log(`${ts()} ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fails: string[] = [];
const check = (ok: unknown, what: string) => {
  if (!ok) fails.push(what);
  console.log(`${ts()} ${ok ? '  ok  ' : '  FAIL'} ${what}`);
};
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 30_000, every = 200): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timeout (${ms} ms): ${what}`);
    await sleep(every);
  }
}

// ------------------------------------------------------------------ Firebase clients (Node)

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

// ------------------------------------------------------------------ browser helpers

// tsx (esbuild keepNames) wraps named inner functions in `__name(...)`; evaluated code needs it too
const NAME_SHIM = 'globalThis.__name = globalThis.__name || ((f) => f)';

const errors: string[] = [];
const netWarnings: string[] = [];
function watch(page: Page, label: string): void {
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message.slice(0, 300)}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // the Firestore SDK's own "offline for 10 s" notice is the network, not the app: listed apart
    if (/Could not reach Cloud Firestore backend/.test(text)) netWarnings.push(`${label}: Firestore backend unreachable for 10 s (SDK retries)`);
    else errors.push(`${label} console.error: ${text.slice(0, 300)}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && !r.url().includes('firestore.googleapis.com')) errors.push(`${label} HTTP ${r.status()} ${r.url().slice(0, 160)}`);
  });
}

let shots = 0;
const taken = new Set<string>();
/** `E2E_SHOTS=tv-lobby,phones-final` takes only those (default: all, at most MAX_SHOTS). */
const ONLY = process.env.E2E_SHOTS ? new Set(process.env.E2E_SHOTS.split(',')) : null;
async function shot(name: string, pages: Page[], composer: Page): Promise<void> {
  if (shots >= MAX_SHOTS || (ONLY && !ONLY.has(name)) || taken.has(name)) return;
  taken.add(name);
  shots++;
  const file = join(OUT, `${String(shots).padStart(2, '0')}-${name}.png`);
  if (pages.length === 1) {
    await pages[0]!.screenshot({ path: file });
  } else {
    // several phones side by side in one image (one look instead of three)
    const bufs = await Promise.all(pages.map((p) => p.screenshot()));
    const imgs = bufs.map((b) => `<img src="data:image/png;base64,${b.toString('base64')}">`).join('');
    await composer.setContent(`<body style="margin:0;background:#777;display:flex;gap:12px;padding:12px;width:max-content">${imgs}</body>`);
    await composer.waitForTimeout(150);
    await composer.screenshot({ path: file, fullPage: true });
  }
  say(`shot ${file.slice(ROOT.length + 1)}`);
}

/**
 * Test media made in WebKit: a ~7 s MP4 (H.264 + an AAC tone, like a phone clip; recorded from a
 * canvas + WebAudio with MediaRecorder — no ffmpeg) and JPEG selfies for the bots.
 */
async function makeMedia(browser: Browser): Promise<{ video: Uint8Array<ArrayBuffer>; videoMime: string; audio: string; faces: { avatar: Uint8Array<ArrayBuffer>; thumb: Uint8Array<ArrayBuffer> }[] }> {
  const page = await browser.newPage();
  await page.setContent('<canvas id="c" width="640" height="360"></canvas>');
  await page.evaluate(NAME_SHIM);
  const out = await page.evaluate(async ([names, seconds]: [string[], number]) => {
    const b64 = async (blob: Blob) => {
      const u = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
      return btoa(s);
    };
    const c = document.getElementById('c') as HTMLCanvasElement;
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    const draw = (t: number) => {
      const gr = g.createLinearGradient(0, 0, 640, 360);
      gr.addColorStop(0, '#1b1f27');
      gr.addColorStop(1, `hsl(${(t * 60) % 360} 45% 30%)`);
      g.fillStyle = gr;
      g.fillRect(0, 0, 640, 360);
      const x = 320 + Math.cos(t * 2) * 180;
      const rg = g.createRadialGradient(x - 20, 160, 6, x, 180, 70);
      rg.addColorStop(0, '#ffffff');
      rg.addColorStop(0.5, '#9aa3af');
      rg.addColorStop(1, '#2b3039');
      g.fillStyle = rg;
      g.beginPath();
      g.arc(x, 180, 70, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#fff';
      g.font = '700 34px sans-serif';
      g.fillText(`Тестовое видео · e2e · ${t.toFixed(1)} с`, 24, 330);
    };
    draw(0);
    const stream = c.captureStream(30);
    // a quiet tone as the sound track (the TV plays videos with sound; the admin re-encodes it to AAC)
    let audio = 'none';
    try {
      const ac = new AudioContext();
      await ac.resume().catch(() => undefined);
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      gain.gain.value = 0.04;
      const dst = ac.createMediaStreamDestination();
      osc.connect(gain).connect(dst);
      osc.start();
      const track = dst.stream.getAudioTracks()[0];
      if (track && ac.state === 'running') {
        stream.addTrack(track);
        audio = 'aac';
      }
    } catch {
      audio = 'none';
    }
    const mimeType = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1'].find((t) => MediaRecorder.isTypeSupported(t) && (audio !== 'none' || !t.includes('mp4a'))) ?? 'video/mp4';
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1_200_000 });
    const parts: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    const done = new Promise<void>((r) => (rec.onstop = () => r()));
    rec.start(250);
    const start = performance.now();
    await new Promise<void>((r) => {
      const tick = () => {
        const t = (performance.now() - start) / 1000;
        draw(t);
        if (t < seconds) requestAnimationFrame(tick);
        else r();
      };
      requestAnimationFrame(tick);
    });
    rec.stop();
    await done;
    const video = new Blob(parts, { type: 'video/mp4' });
    const faces: { avatar: string; thumb: string }[] = [];
    for (const [k, n] of names.entries()) {
      const one = async (size: number, q: number) => {
        const cv = document.createElement('canvas');
        cv.width = cv.height = size;
        const x = cv.getContext('2d') as CanvasRenderingContext2D;
        const gg = x.createRadialGradient(size * 0.35, size * 0.3, size * 0.05, size / 2, size / 2, size * 0.7);
        gg.addColorStop(0, `hsl(${k * 36} 70% 72%)`);
        gg.addColorStop(1, `hsl(${k * 36 + 40} 55% 28%)`);
        x.fillStyle = gg;
        x.fillRect(0, 0, size, size);
        x.fillStyle = 'rgba(255,255,255,.92)';
        x.font = `800 ${size * 0.5}px sans-serif`;
        x.textAlign = 'center';
        x.textBaseline = 'middle';
        x.fillText(n.slice(0, 1), size / 2, size * 0.54);
        return b64(await new Promise<Blob>((r) => cv.toBlob((b) => r(b as Blob), 'image/jpeg', q)));
      };
      faces.push({ avatar: await one(256, 0.8), thumb: await one(64, 0.7) });
    }
    return { video: await b64(video), videoMime: rec.mimeType || mimeType, audio, faces };
  }, [BOT_NAMES, VIDEO_S] as [string[], number]);
  await page.close();
  const u8 = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(s, 'base64'));
  return { video: u8(out.video), videoMime: out.videoMime, audio: out.audio, faces: out.faces.map((f) => ({ avatar: u8(f.avatar), thumb: u8(f.thumb) })) };
}

// ------------------------------------------------------------------ in-page probes

type TvState = { phase: string; qn: number | null; qi: number | null; step: number | null; scene: string; tvq: string };
const tvState = (tv: Page): Promise<TvState | null> =>
  tv.evaluate(() => {
    const w = window as unknown as { __tv?: { view: () => { phase: string; question: { n: number; i: number } | null; final: { step: number } | null } } };
    if (!w.__tv) return null;
    const v = w.__tv.view();
    const scene = document.querySelector('.tv-scene')?.className ?? '';
    return { phase: v.phase, qn: v.question?.n ?? null, qi: v.question?.i ?? null, step: v.final?.step ?? null, scene, tvq: '' };
  });
/** The TV host's snapshot (DEV exposes it as window.__tv). */
const snap = (tv: Page): Promise<{ game: GameDoc; content: AdminContentDoc }> =>
  tv.evaluate(() => (window as unknown as { __tv: { host: { snapshot: () => unknown } } }).__tv.host.snapshot()) as Promise<{ game: GameDoc; content: AdminContentDoc }>;
/** The watch stage as the TV's view model has it (+ whether it has a timer). */
const tvWatch = (tv: Page): Promise<{ stage: string | null; timer: boolean }> =>
  tv.evaluate(() => {
    const v = (window as unknown as { __tv: { view: () => { watch: { stage: string } | null; timer: unknown } } }).__tv.view();
    return { stage: v.watch?.stage ?? null, timer: v.timer !== null };
  });
const screenOf = (p: Page): Promise<string> => p.evaluate(() => document.querySelector('.pl')?.getAttribute('data-screen') ?? 'none').catch(() => 'gone');
const secsOf = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const m = /(\d+):(\d{2})/.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const d = /\d+/.exec(s);
  return d ? Number(d[0]) : null;
};

async function pressSpace(tv: Page, label: string): Promise<void> {
  await tv.keyboard.press('Space');
  say(`TV ␣ ${label}`);
}

/** A Chromium context signed in as the DEV bot admin (the session handed over through storage). */
async function adminContext(cr: Browser, user: Record<string, unknown>, authKey: string, viewport: { width: number; height: number }): Promise<BrowserContext> {
  const ctx = await cr.newContext({ viewport, colorScheme: 'dark' });
  await ctx.addInitScript(NAME_SHIM);
  await ctx.addInitScript(
    ([k, v]) => {
      try {
        if (!localStorage.getItem(k as string)) localStorage.setItem(k as string, v as string);
      } catch {
        /* ignore */
      }
    },
    [authKey, JSON.stringify(user)],
  );
  return ctx;
}

/**
 * TV: every <video> event that matters (the watch stage, the answer's video, the «Сюрприз», the video
 * after the final), with the host's server time and where on the screen the element was.
 */
const TV_VIDEO_PROBE = `(() => {
  const ev = (window.__vev = []);
  for (const type of ['playing', 'ended', 'error']) {
    document.addEventListener(type, (e) => {
      const v = e.target;
      if (!(v instanceof HTMLVideoElement)) return;
      const h = window.__tv && window.__tv.host;
      const where = v.closest('.tq-watch') ? 'watch' : v.closest('.trc-media') ? 'reveal' : v.closest('.tsu') ? 'surprise' : v.closest('.tfv') ? 'finale' : 'other';
      ev.push({ type, srv: h ? h.now() : null, t: v.currentTime, d: v.duration, watch: where === 'watch', where, muted: v.muted, vol: v.volume, src: String(v.currentSrc || '').slice(0, 60) });
    }, true);
  }
})();`;
type VideoEvent = { type: string; srv: number | null; t: number; d: number; watch: boolean; where: string; muted: boolean; vol: number; src: string };
/** The first probe event of `type` at `where` after server time `after`. */
const videoEvent = async (tv: Page, type: string, where: string, after = 0): Promise<VideoEvent | null> =>
  (await videoEvents(tv)).find((e) => e.type === type && e.where === where && (e.srv ?? 0) >= after) ?? null;

/**
 * The show's phase log, kept by the TV page itself (every 50 ms from its host's snapshot): the
 * public phase with the host's STORED phase start (private/totals.phaseAt — the moment the lease
 * holder made the transition), one row per phaseRev.
 */
const PHASE_PROBE = `(() => {
  const log = (window.__ph = []);
  setInterval(() => {
    const t = window.__tv && window.__tv.host.snapshot();
    const g = t && t.game;
    if (!g || !t.totals) return;
    const last = log[log.length - 1];
    const e = { rev: g.phaseRev, phase: g.phase, step: g.final ? g.final.step : null, i: g.round ? g.round.i : null, at: t.totals.phaseAt };
    if (!last || last.rev !== e.rev || last.at !== e.at) log.push(e);
  }, 50);
})();`;
type PhaseRow = { rev: number; phase: string; step: number | null; i: number | null; at: number };
/** One row per phaseRev (the last one seen: the totals listener may lag the game's by a moment). */
async function phaseLog(tv: Page): Promise<PhaseRow[]> {
  const rows = await tv.evaluate(() => (window as unknown as { __ph: PhaseRow[] }).__ph.slice());
  const out: PhaseRow[] = [];
  for (const r of rows) {
    if (out.length && out[out.length - 1]!.rev === r.rev) out[out.length - 1] = r;
    else out.push(r);
  }
  return out;
}
const totalsOf = (tv: Page): Promise<TotalsDoc> => tv.evaluate(() => (window as unknown as { __tv: { host: { snapshot: () => { totals: unknown } } } }).__tv.host.snapshot().totals) as Promise<TotalsDoc>;
const markOf = (r: PhaseRow): string => (r.phase === 'final' ? `final:${r.step ?? 0}` : r.phase);
const videoEvents = (tv: Page): Promise<VideoEvent[]> => tv.evaluate(() => (window as unknown as { __vev: VideoEvent[] }).__vev.slice());

// ------------------------------------------------------------------ the admin's media path

/**
 * Attaches `video` to question `qid` the way the organizer does it: #/admin → the question's editor
 * → its media slot (the admin pipeline compresses to 720p H.264/AAC where WebCodecs can, else keeps
 * the original; makes the poster; uploads the chunks) → autosave. Videos are TV-only: the slot shows
 * the note instead of the «Показывать и в телефонах» switch.
 */
async function uploadThroughAdmin(ctx: BrowserContext, db: Firestore, qid: string, video: Uint8Array, mime: string): Promise<{ videoId: string; posterId: string | null; meta: MediaMetaDoc | undefined; ms: number }> {
  const page = await ctx.newPage();
  watch(page, 'admin');
  await page.goto(`${BASE}?env=dev#/admin/questions/${qid}`);
  const zone = page.getByLabel('Фото или видео к вопросу');
  await zone.waitFor({ timeout: 90_000 });
  const t = Date.now();
  await zone.locator('input[type=file]:not([capture])').setInputFiles({ name: 'e2e-test-video.mp4', mimeType: mime.split(';')[0] ?? 'video/mp4', buffer: Buffer.from(video) });
  // processed + uploaded: the slot shows the file («Видео · 7 с · 640×360 · 1.1 МБ»)
  const label = page.locator('.ad-media.has-file .ad-clip').first();
  await until('admin: video uploaded', async () => /^Видео/.test((await label.textContent().catch(() => null)) ?? ''), 180_000, 500);
  const ms = Date.now() - t;
  say(`admin: «${(await label.textContent())?.trim()}» after ${(ms / 1000).toFixed(1)} s`);
  await page.getByText(/Видео играет только на большом экране/).waitFor({ timeout: 15_000 });
  check((await page.getByRole('switch', { name: /Показывать и в телефонах/ }).count()) === 0, 'admin: a video has no «на телефонах» switch, just the TV-only note');
  const qm = await until('admin: autosaved to admin/content', async () => {
    const c = (await getDocFromServer(doc(db, 'admin/content'))).data() as AdminContentDoc | undefined;
    const m = c?.questions.find((q) => q.id === qid)?.media;
    return m ?? null;
  }, 30_000, 1000);
  const meta = (await getDocFromServer(fbRefs(db).mediaMeta(qm.mediaId))).data();
  await page.close();
  return { videoId: qm.mediaId, posterId: meta?.posterId ?? null, meta, ms };
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  say(`E2E on ${BASE} · DEV · game ${G}`);
  const bot = await ensureDevBotAdmin();
  const admin = await client('e2e-admin', (a) => signInWithEmailAndPassword(a, bot.email, bot.password));
  const refs = fbRefs(admin.db);
  const contentRef = doc(admin.db, 'admin/content');
  const found = (await getDocFromServer(contentRef)).data() as AdminContentDoc | undefined;
  // an interrupted earlier run can leave its content behind (the video question — same id → the game
  // would have one round fewer than expected —, the answer's photo / video, the «Сюрприз», the
  // settings): restore the content saved when that run started, else drop what it added
  const stale = found?.questions.filter((q) => q.id === VQ.id).length ?? 0;
  let original: AdminContentDoc | undefined = found;
  if (found && stale) {
    let saved: AdminContentDoc | undefined;
    try {
      saved = JSON.parse(readFileSync(CONTENT_BACKUP, 'utf8')) as AdminContentDoc;
    } catch {
      saved = undefined;
    }
    if (saved?.questions?.length && !saved.questions.some((q) => q.id === VQ.id)) original = { ...saved, rev: found.rev };
    else {
      const vm = found.questions.find((q) => q.id === VQ.id)?.media?.mediaId;
      const poster = vm ? (await getDocFromServer(refs.mediaMeta(vm)).catch(() => null))?.data()?.posterId : undefined;
      const ours = new Set([vm, poster].filter((x): x is string => !!x));
      const clean = (q: Question): Question => {
        const c = structuredClone(q);
        if (c.revealMedia && ours.has(c.revealMedia.mediaId)) delete c.revealMedia;
        if (c.surprise?.mediaId && ours.has(c.surprise.mediaId)) delete c.surprise;
        return c;
      };
      original = { ...found, questions: found.questions.filter((q) => q.id !== VQ.id).map(clean) };
    }
  } else if (found) writeFileSync(CONTENT_BACKUP, JSON.stringify(found));
  if (!original || original.questions.length < 3) throw new Error('DEV admin/content missing — run npm run seed:dev');
  say(`content rev ${original.rev}: ${original.questions.length} questions${stale ? ` (restored after an interrupted run: dropped ${stale} stale «${VQ.id}»)` : ''}`);

  const wk = await webkit.launch();
  const cr = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const media: string[] = [];
  let tvCtx: BrowserContext | null = null;
  const phoneCtx: BrowserContext[] = [];
  const bots: { p: PlayerSession; c: Client; name: string }[] = [];
  let botTimer: ReturnType<typeof setInterval> | null = null;
  let contentChanged = false;

  try {
    // ---- the video question: inserted first, its video attached through the admin's media path
    const made = await makeMedia(wk);
    say(`test video: ${(made.video.length / 1024).toFixed(0)} KB ${made.videoMime} (sound: ${made.audio})`);
    const patched: AdminContentDoc = { ...original, rev: original.rev + 1, questions: [VQ, ...original.questions] };
    await setDoc(contentRef, patched);
    contentChanged = true;

    const session = await client('e2e-tvsess', (a) => signInWithEmailAndPassword(a, bot.email, bot.password));
    const user = session.auth.currentUser?.toJSON() as Record<string, unknown>;
    user.appName = '[DEFAULT]';
    const authKey = `firebase:authUser:${DEV.apiKey}:[DEFAULT]`;
    const adCtx = await adminContext(cr, user, authKey, { width: 1280, height: 860 });
    const up = await uploadThroughAdmin(adCtx, admin.db, VQ.id, made.video, made.videoMime).finally(() => adCtx.close().catch(() => undefined));
    media.push(up.videoId, ...(up.posterId ? [up.posterId] : []));
    const vMeta = up.meta;
    const transcoded = !!vMeta && vMeta.bytes !== made.video.length;
    check(
      vMeta?.kind === 'video' && !!up.posterId && typeof vMeta.durationS === 'number' && vMeta.durationS >= 6 && vMeta.durationS <= 8,
      `admin media path: video ${up.videoId} ${vMeta?.w}×${vMeta?.h} ${vMeta?.mime} ${vMeta?.durationS} s, ${((vMeta?.bytes ?? 0) / 1024).toFixed(0)} KB in ${vMeta?.chunks} chunk(s), poster ${up.posterId} (${transcoded ? 'compressed in the browser' : 'original kept'})`,
    );

    // ---- the show's content: the video question first, a photo and a video after the answer of
    //      two others, the LAST question interrupted by the «Сюрприз» with this run's own clip (the
    //      same upload — the admin's media path — instead of the 4-min built-in video); the
    //      «Автопилот» as on the night (settings.autopilot undefined = on, like PROD) or off (--manual)
    const uploaded = (await getDocFromServer(contentRef)).data() as AdminContentDoc | undefined;
    if (!uploaded?.questions.find((q) => q.id === VQ.id)?.media) throw new Error('the video question lost its video');
    const questions: Question[] = uploaded.questions
      .filter((q) => !q.disabled)
      .map((q) => {
        const c = structuredClone(q);
        delete c.surprise;
        return c;
      });
    if (questions.length < 5 || questions[0]!.id !== VQ.id) throw new Error(`unexpected content: ${questions.map((q) => q.id).join(', ')}`);
    const mid = questions.slice(1, -1);
    const photoQ = mid.find((q) => q.type === 'choice' && !q.revealMedia) ?? mid.find((q) => !q.revealMedia);
    const videoQ = mid.find((q) => q !== photoQ && q.type === 'ordering' && !q.revealMedia) ?? mid.find((q) => q !== photoQ && !q.revealMedia);
    const lastQ = questions[questions.length - 1]!;
    if (!photoQ || !videoQ || !up.posterId) throw new Error('no question for the answer\'s photo / video');
    photoQ.revealMedia = { mediaId: up.posterId, onPhones: true };
    videoQ.revealMedia = { mediaId: up.videoId, onPhones: false };
    lastQ.surprise = { on: true, src: 'custom', mediaId: up.videoId, afterS: SURPRISE_AFTER_S };
    const { autopilot: _was, ...baseSettings } = uploaded.settings;
    void _was;
    const runSettings: Settings = {
      ...baseSettings,
      ...(MANUAL ? { autopilot: false } : {}),
      finaleVideo: 'builtin',
      autoAdvance: { revealToBoardS: null, boardToNextS: null, finalStepS: null },
    };
    await setDoc(contentRef, { ...uploaded, rev: uploaded.rev + 1, settings: runSettings, questions: uploaded.questions.map((q) => questions.find((x) => x.id === q.id) ?? q) });
    /** The settings exactly as the host reads them (defaults merged in). */
    const hostSettings = hostContent({ rev: 0, settings: runSettings, questions }).settings;
    say(`content: ${questions.length} questions (${questions.map((q) => q.type).join(', ')}) · the video one first · answer photo: «${photoQ.title.slice(0, 30)}» · answer video: «${videoQ.title.slice(0, 30)}» · «Сюрприз» (${SURPRISE_AFTER_S} s): «${lastQ.title.slice(0, 30)}» · autopilot ${MANUAL ? 'OFF (--manual)' : 'ON (undefined, like PROD)'}`);

    // ---- TV: the bot admin's session handed over via storage, then «Начать шоу»
    tvCtx = await adminContext(cr, user, authKey, { width: 1280, height: 720 });
    await tvCtx.addInitScript(TV_VIDEO_PROBE);
    await tvCtx.addInitScript(PHASE_PROBE);
    const tv = await tvCtx.newPage();
    watch(tv, 'tv');
    await tv.goto(`${BASE}?env=dev&game=${G}#/tv`);
    await tv.getByRole('button', { name: /Начать шоу/ }).click({ timeout: 90_000 });
    await until('TV host in lobby', async () => (await tvState(tv))?.phase === 'lobby', 45_000);
    await tv.evaluate(() => {
      const w = window as unknown as { __rx: string[] };
      w.__rx = [];
      new MutationObserver((ms) => {
        for (const m of ms)
          for (const n of m.addedNodes) {
            const el = n as HTMLElement;
            if (el.classList?.contains('vx-rx')) w.__rx.push(el.querySelector('small')?.textContent ?? '?');
          }
      }).observe(document.body, { childList: true, subtree: true });
    });
    say('TV live in lobby');

    // ---- 10 Node bots
    for (const [k, name] of BOT_NAMES.entries()) {
      const c = await client(`e2e-bot${k}`, (a) => signInAnonymously(a));
      const p = new PlayerSession({ db: c.db, uid: c.auth.currentUser?.uid ?? '', clock: new ServerClock(), gameId: G, timeoutMs: 15_000 });
      await p.start();
      await p.whenReady();
      const face = made.faces[k]!;
      const r = await p.join(name, k % 3 === 2 ? undefined : face.avatar, k % 3 === 2 ? undefined : face.thumb);
      if (!r.ok) check(false, `bot ${name} join: ${JSON.stringify(r)}`);
      bots.push({ p, c, name });
    }
    const vladosUid = bots[VLADOS_BOT]!.p.uid;
    const sv = await tv.evaluate((uid) => (window as unknown as { __tv: { host: { command: (c: unknown) => Promise<{ ok: boolean }> } } }).__tv.host.command({ type: 'setVlados', uid }), vladosUid);
    check(sv.ok, 'Vlados bot marked from the TV host');
    const answeredKey = new Set<string>();
    botTimer = setInterval(() => {
      bots.forEach(({ p }, k) => {
        const v = p.view();
        const q = v.question;
        if (!v.canAnswer || !q) return;
        const key = `${k}:${q.i}`;
        if (answeredKey.has(key)) return;
        answeredKey.add(key);
        let a: AnswerPayload | null = null;
        if (q.type === 'choice') a = { t: 'choice', id: q.options?.[(k * 7) % (q.options?.length || 1)]?.id ?? '' };
        else if (q.type === 'number') {
          const lo = q.number?.min ?? 0;
          const hi = q.number?.max ?? 100;
          a = { t: 'number', v: Math.round(lo + ((hi - lo) * (k + 1)) / 12) };
        } else {
          const ids = (q.items ?? []).map((i) => i.id);
          a = { t: 'ordering', ids: k % 2 ? ids.slice().reverse() : ids };
        }
        if (a) setTimeout(() => void p.answer(q.i, a), 400 + Math.random() * 3000);
        if (k % 4 === 0) setTimeout(() => void p.react(k % 8), 1500);
      });
    }, 250);

    // ---- 2 phones (WebKit, iPhone-sized), joining like a guest
    const phones: Page[] = [];
    const phoneUid: string[] = [];
    for (const ph of PHONES) {
      const ctx = await wk.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        colorScheme: ph.mode,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      });
      phoneCtx.push(ctx);
      await ctx.addInitScript(NAME_SHIM);
      const page = await ctx.newPage();
      watch(page, `phone-${ph.mode}`);
      await page.goto(`${BASE}?env=dev&game=${G}#/`);
      await until(`${ph.name}: join screen`, async () => (await screenOf(page)) === 'join', 45_000);
      // before the start time the join screen opens on the countdown with «Зарегистрируйся заранее»
      const early = page.getByRole('button', { name: 'Зарегистрируйся заранее' });
      const input = page.locator('input').first();
      await until(`${ph.name}: countdown or name field`, async () => (await early.isVisible().catch(() => false)) || (await input.isVisible().catch(() => false)), 20_000);
      if (await early.isVisible().catch(() => false)) {
        if (ph.mode === 'dark') await shot('phone-pregame', [page], page);
        await early.click();
      }
      await input.fill(ph.name);
      await page.getByRole('button', { name: 'Дальше' }).click();
      await page.getByRole('button', { name: 'Пропустить' }).click();
      await until(`${ph.name}: lobby`, async () => (await screenOf(page)) === 'lobby', 30_000);
      const mode = await page.evaluate(() => document.documentElement.dataset.mode);
      check(mode === ph.mode, `${ph.name}: page renders in ${ph.mode} mode (got ${mode})`);
      const uid = await page.evaluate((k) => {
        try {
          return (JSON.parse(localStorage.getItem(k) ?? '{}') as { uid?: string }).uid ?? '';
        } catch {
          return '';
        }
      }, authKey);
      phones.push(page);
      phoneUid.push(uid);
    }
    check(phoneUid.every(Boolean), 'phones signed in anonymously (uids known)');
    const composer = await (await cr.newContext({ viewport: { width: 900, height: 900 } })).newPage();

    // ---- phase recorder (TV scenes + phone screens)
    const seen = { tv: new Set<string>(), phones: PHONES.map(() => new Set<string>()) };
    let recording = true;
    const recorder = (async () => {
      while (recording) {
        const s = await tvState(tv).catch(() => null);
        if (s) seen.tv.add(`${s.phase}${s.step !== null ? `:${s.step}` : ''}|${(/tv-(lobby|q|rc|rn|ro|board|final|wait)\b/.exec(s.scene) ?? [])[1] ?? '-'}`);
        for (const [k, p] of phones.entries()) seen.phones[k]!.add(await screenOf(p));
        await sleep(250);
      }
    })();

    // ---- lobby: everyone on the TV, reactions from both phones reach it
    await until('TV sees 12 guests', () => tv.evaluate(() => (window as unknown as { __tv: { view: () => { counts: { players: number } } } }).__tv.view().counts.players >= 12), 30_000);
    for (const p of phones) {
      await p.locator('.vx-rb').nth(1).click();
      await sleep(400);
    }
    await until('both phone reactions on the TV', async () => {
      const got = await tv.evaluate(() => (window as unknown as { __rx: string[] }).__rx);
      return PHONES.every((ph) => got.includes(ph.name)) ? got : null;
    }, 12_000).then(
      (got) => check(true, `reactions reached the TV with names (${got.length} bubbles so far)`),
      () => check(false, 'reactions from phones reached the TV'),
    );
    await sleep(1500);
    await shot('tv-lobby', [tv], composer);

    // ---- the show: the organizer presses «Начать игру» (TV Space) — with the autopilot that is the
    //      ONLY press; --manual: Space for every step (the answer → board → next → final steps)
    await pressSpace(tv, 'Начать игру');
    const timerDiffs: number[] = [];
    /** Server time the TV's answer video ended (the autopilot's board comes 2 s after it). */
    let revealVideoEnd: { i: number; srv: number } | null = null;
    const tvClass = (sel: string) => tv.evaluate((q) => document.querySelector(q)?.className ?? null, sel);
    for (let n = 1; n <= questions.length; n++) {
      const st = await until(`TV question ${n}`, async () => {
        const s = await tvState(tv);
        return s && s.qn === n && (s.phase === 'intro' || s.phase === 'open') ? s : null;
      }, 45_000);
      const game = await snap(tv);
      const round = game.game.round!;
      const q = game.content.questions.find((x) => x.id === round.qid);
      const isSurprise = !!q?.surprise?.on;
      const rm = q?.revealMedia ? (q.revealMedia.mediaId === up.videoId ? 'video' : 'photo') : null;
      say(`Q${n} ${round.type} «${q?.title.slice(0, 40)}»${isSurprise ? ' · «Сюрприз»' : ''}${rm ? ` · answer ${rm}` : ''}`);

      // ---- a video question: the watch stage before the answers (TV plays it, phones wait)
      let vid: { r1: RoundPub; openAt0: number; oldEndsAt: number } | null = null;
      if (round.media?.kind === 'video' && (round.media.watchMs ?? 0) > 0) {
        const r0 = round;
        const introMs = hostSettings.introMs;
        const durMs = Math.round((vMeta?.durationS ?? 0) * 1000);
        const win = r0.media?.watchMs ?? 0;
        check(
          win === durMs + WATCH.tailMs && r0.openAt - r0.introAt === introMs + win + WATCH.beatMs,
          `Q${n} video round: fallback opening ${(r0.openAt - r0.introAt) / 1000} s after the intro = intro ${introMs / 1000} + video ${durMs / 1000} + tail ${WATCH.tailMs / 1000} + 3-2-1`,
        );
        await until(`Q${n} TV watch stage`, async () => (await tvWatch(tv)).stage === 'play', 20_000);
        const v1 = await until(`Q${n} TV video playing`, () =>
          tv.evaluate(() => {
            const v = document.querySelector('.tq-watch video') as HTMLVideoElement | null;
            return v && v.readyState >= 2 && !v.paused && v.currentTime > 0 ? { t: v.currentTime, w: v.videoWidth, h: v.videoHeight, muted: v.muted, vol: v.volume } : null;
          }), 10_000);
        const v1At = Date.now();
        const phonesDuring = await Promise.all(
          phones.map((p, k) =>
            until(`${PHONES[k]!.name}: «Смотри видео на большом экране»`, () =>
              p.evaluate(() => {
                const el = document.querySelector('.pl-watch');
                const img = el?.querySelector('.pl-qm img') as HTMLImageElement | null | undefined;
                if (!el || el.getAttribute('data-stage') !== 'play' || !img?.complete) return null;
                return {
                  screen: document.querySelector('.pl')?.getAttribute('data-screen'),
                  text: /Смотри видео на большом экране/.test(el.textContent ?? ''),
                  inputs: document.querySelectorAll('.vx-opt, .vx-key, .vx-ord-row').length,
                  timer: document.querySelectorAll('.pl-q-timer, .vx-tbar').length,
                  videos: document.querySelectorAll('video').length,
                  poster: img.naturalWidth,
                };
              }), 6_000).catch(() => null),
          ),
        );
        for (const [k, w] of phonesDuring.entries()) {
          check(
            w && w.screen === 'intro' && w.text && w.inputs === 0 && w.timer === 0 && w.videos === 0 && w.poster > 0,
            `Q${n} ${PHONES[k]!.name} during the video: «Смотри видео на большом экране» + poster, no options, no timer, no <video> (${JSON.stringify(w)})`,
          );
        }
        // nobody can answer while it plays: the app says 'closed', the rules refuse a raw write
        const [b0, b1] = [bots[0]!, bots[1]!];
        const viaApp = await b0.p.answer(r0.i, { t: 'choice', id: VQ.correctId });
        check(!viaApp.ok && viaApp.error === 'closed', `Q${n} a guest answering during the video → ${viaApp.ok ? 'ACCEPTED' : viaApp.error}`);
        const raw = await setDoc(fbRefs(b1.c.db).answer(G, r0.i, b1.p.uid), newAnswerDoc(b1.p.uid, r0.i, { t: 'choice', id: VQ.correctId })).then(
          () => 'WRITTEN',
          (e: unknown) => String((e as { code?: unknown }).code ?? e),
        );
        check(raw === 'permission-denied', `Q${n} a raw answer write during the video → ${raw}`);
        await sleep(Math.max(0, 1500 - (Date.now() - v1At)));
        const tvDuring = await tv.evaluate(() => ({ t: (document.querySelector('.tq-watch video') as HTMLVideoElement | null)?.currentTime ?? -1, tube: !!document.querySelector('.vx-tube-sec') }));
        const w1 = await tvWatch(tv);
        check(
          v1.w > 0 && !v1.muted && v1.vol > 0 && tvDuring.t > v1.t + 1 && !tvDuring.tube && !w1.timer,
          `Q${n} TV plays the video big with sound (${v1.w}×${v1.h}, volume ${v1.vol}, ${v1.t.toFixed(1)} → ${tvDuring.t.toFixed(1)} s), no answer timer (stage ${w1.stage})`,
        );
        await shot('phones-watch', phones, composer);
        // the TV well into the video (past the intro → video cross-fade)
        await until('TV video at 3 s', () => tv.evaluate(() => ((document.querySelector('.tq-watch video') as HTMLVideoElement | null)?.currentTime ?? 0) >= 3), 8_000).catch(() => null);
        await shot('tv-watch', [tv], composer);

        // the end: the TV reports it, the answers open after the 3-2-1 with the full time
        const ended = await until(`Q${n} TV video 'ended'`, async () => (await videoEvents(tv)).find((e) => e.type === 'ended' && e.watch) ?? null, durMs + 20_000);
        const evs = await videoEvents(tv);
        const played = evs.find((e) => e.type === 'playing' && e.watch);
        const r1 = await until(`Q${n} openAt moved`, async () => {
          const r = (await snap(tv)).game.round;
          return r && r.i === r0.i && r.openAt !== r0.openAt ? r : null;
        }, 10_000);
        const endSrv = ended.srv ?? NaN;
        const startSrv = played?.srv ?? NaN;
        check(
          !evs.some((e) => e.type === 'error') && Math.abs(ended.d - durMs / 1000) < 0.6 && ended.t >= ended.d - 0.3,
          `Q${n} TV played the video to its end (${ended.t.toFixed(2)} of ${ended.d.toFixed(2)} s, no error events)`,
        );
        check(
          r1.openAt - endSrv >= WATCH.beatMs - 250 && r1.openAt - endSrv <= WATCH.beatMs + 2500,
          `Q${n} answers open ${((r1.openAt - endSrv) / 1000).toFixed(2)} s after the TV's 'ended' (the 3-2-1)`,
        );
        check(
          r1.openAt - startSrv >= durMs + WATCH.beatMs - 700,
          `Q${n} … and only after the whole video: ${((r1.openAt - startSrv) / 1000).toFixed(2)} s after it started playing (video ${durMs / 1000} s + 3-2-1)`,
        );
        check(
          r1.openAt < r0.openAt && r1.endsAt - r1.openAt === VQ_LIMIT_S * 1000,
          `Q${n} the report pulled the opening in by ${((r0.openAt - r1.openAt) / 1000).toFixed(2)} s; the full ${VQ_LIMIT_S} s count from there`,
        );
        vid = { r1, openAt0: r0.openAt, oldEndsAt: r0.introAt + introMs + VQ_LIMIT_S * 1000 };
      }

      for (const [k, p] of phones.entries()) await until(`${PHONES[k]!.name}: question ${n}`, async () => (await screenOf(p)) === 'question', 20_000);
      await until('TV open', async () => (await tvState(tv))?.phase === 'open', 15_000);
      // (the «Сюрприз» comes 4 s after the options: the phones answer before it)
      await sleep(isSurprise ? 400 : 1200);

      // timers: TV tube vs both phones, sampled together
      const [tvT, ...phT] = await Promise.all([
        tv.evaluate(() => document.querySelector('.vx-tube-sec')?.textContent ?? null),
        ...phones.map((p) => p.evaluate(() => document.querySelector('.pl-q-timer b, .vx-tbar b')?.textContent ?? null)),
      ]);
      const tvS = secsOf(tvT);
      const diffs = phT.map((x) => (tvS === null || secsOf(x) === null ? 99 : Math.abs((secsOf(x) as number) - tvS)));
      timerDiffs.push(...diffs);
      check(diffs.every((d) => d <= 1), `Q${n} timers in sync: TV ${tvT} · phones ${phT.join(' / ')}`);

      if (vid) {
        const secs = phT.map(secsOf);
        check(secs.every((x) => x !== null && x >= VQ_LIMIT_S - 4 && x <= VQ_LIMIT_S), `Q${n} phones start the answer timer after the video with the full time (${phT.join(' / ')} of ${VQ_LIMIT_S} s)`);
        const again = await tv.evaluate(() => {
          const v = document.querySelector('.tq-main video') as HTMLVideoElement | null;
          return v ? !v.paused : false;
        });
        check(!again, `Q${n} the video does not play again next to the options`);
      }

      // phones answer: light = the right answer where we know it, dark = something else
      for (const [k, p] of phones.entries()) {
        if (round.type === 'choice' && q?.type === 'choice') {
          const ids = (round.options ?? []).map((o) => o.id);
          const right = Math.max(0, ids.indexOf(q.correctId));
          const idx = k === 0 ? right : (right + 1) % ids.length;
          await p.locator('.pl-q .vx-opt').nth(idx).click();
        } else if (round.type === 'number' && q?.type === 'number') {
          const lo = round.number?.min ?? q.min ?? 0;
          const hi = round.number?.max ?? q.max ?? 100;
          const v = k === 0 ? q.answer : Math.round((lo + hi) / 2);
          for (const ch of String(v)) await p.locator('.vx-key', { hasText: new RegExp(`^${ch}$`) }).dispatchEvent('pointerdown');
          await sleep(250);
          if (k === 1) await shot('phones-number-input', phones, composer);
          await p.getByRole('button', { name: 'Ответить' }).click();
        } else {
          const rows = p.locator('.vx-ord-row');
          await until('ordering rows', async () => (await rows.count()) >= 2, 10_000);
          if (k === 1) {
            await rows.nth(0).click();
            await rows.nth(1).click();
          }
          await p.getByRole('button', { name: /отправить порядок/ }).click();
        }
        await until(`${PHONES[k]!.name}: answered`, async () => ['answered', 'time_up', 'reveal'].includes(await screenOf(p)), 10_000);
      }

      // ---- the «Сюрприз»: 4 s after the options the TV breaks down, 2 s of black, the video; the
      //      phones glitch, go black, «Смотри на экран»; the TV's 'ended' → the answer
      if (isSurprise) {
        const g1 = await until(`Q${n} the «Сюрприз» interrupt`, async () => {
          const g = (await snap(tv)).game;
          return g.phase === 'locked' && g.next?.surprise ? g : null;
        }, 20_000, 50);
        const sp = g1.next!.surprise!;
        const durMs = Math.round((vMeta?.durationS ?? 0) * 1000);
        check(
          sp.id === up.videoId && Math.abs(sp.ms - durMs) <= 50 && Math.abs(sp.at - (g1.round!.openAt + SURPRISE_AFTER_S * 1000)) <= TOL_MS,
          `Q${n} «Сюрприз» ${((sp.at - g1.round!.openAt) / 1000).toFixed(2)} s after the options with this run's own clip (${sp.id}, ${sp.ms} ms)`,
        );
        const glitch = await until('TV: the breakdown', async () => ((await tvClass('.tsu'))?.includes('is-glitch') ? true : null), 5_000, 40).catch(() => false);
        const phGlitch = await Promise.all(
          phones.map((p) =>
            until('phone: glitch / black', () => p.evaluate(() => {
              const c = document.querySelector('.pl-sur')?.className ?? '';
              const pl = (window as unknown as { __pl?: { view(): { canAnswer: boolean } } }).__pl;
              return /is-(glitch|black)/.test(c) ? { c, can: pl?.view().canAnswer ?? null } : null;
            }), 6_000, 50).catch(() => null),
          ),
        );
        check(glitch, `Q${n} TV: «сбой эфира» on screen`);
        for (const [k, x] of phGlitch.entries()) check(x && x.can === false, `Q${n} ${PHONES[k]!.name}: its screen glitches / goes black, answering off (${JSON.stringify(x)})`);
        const black = await until('TV: black', async () => ((await tvClass('.tsu'))?.includes('is-black') ? true : null), 6_000, 50).catch(() => false);
        check(black, `Q${n} TV: pure black after the breakdown`);
        const playing = await until('TV: the «Сюрприз» video plays', () =>
          tv.evaluate(() => {
            const v = document.querySelector<HTMLVideoElement>('.tsu-host video');
            const c = document.querySelector('.tsu')?.className ?? '';
            return c.includes('is-play') && v && !v.paused && v.currentTime > 1 ? { muted: v.muted, vol: v.volume, d: v.duration, src: v.currentSrc.slice(0, 12) } : null;
          }), 15_000, 100);
        check(!playing.muted && playing.vol === 1 && Math.abs(playing.d * 1000 - durMs) < 600, `Q${n} TV: the clip plays WITH SOUND (muted=${playing.muted}, volume ${playing.vol}, ${playing.d.toFixed(2)} s, ${playing.src}…)`);
        const phWatch = await Promise.all(
          phones.map((p) =>
            until('phone: «Смотри на экран»', () => p.evaluate(() => {
              const el = document.querySelector('.pl-sur');
              const pl = (window as unknown as { __pl?: { view(): { canAnswer: boolean } } }).__pl;
              return el?.className.includes('is-watch') ? { text: document.querySelector('.pl-sur-h')?.textContent ?? '', can: pl?.view().canAnswer ?? null } : null;
            }), 10_000, 100).catch(() => null),
          ),
        );
        for (const [k, x] of phWatch.entries()) check(x && x.text === 'Смотри на экран' && x.can === false, `Q${n} ${PHONES[k]!.name} during the «Сюрприз»: «${x?.text}», answering off`);
        await shot('tv-surprise', [tv], composer);
        await shot('phones-surprise', phones, composer);
        const ended = await until(`Q${n} TV «Сюрприз» 'ended'`, () => videoEvent(tv, 'ended', 'surprise', sp.at), durMs + 20_000, 100);
        const g2 = await until(`Q${n} the answer after the «Сюрприз»`, async () => {
          const g = (await snap(tv)).game;
          return g.phase === 'reveal' ? g : null;
        }, 10_000, 100);
        const at = (await totalsOf(tv)).phaseAt;
        check(Math.abs(at - (ended.srv ?? 0)) <= TOL_MS && g2.phase === 'reveal', `Q${n} the answer came ${((at - (ended.srv ?? 0)) / 1000).toFixed(2)} s after the TV's 'ended' (surpriseEnd)`);
      }

      // reveal: points and rank on the phones = the reveal data
      await until(`TV reveal ${n}`, async () => (await tvState(tv))?.phase === 'reveal', 30_000);
      const revealAt = (await totalsOf(tv)).phaseAt;
      for (const [k, p] of phones.entries()) await until(`${PHONES[k]!.name}: reveal ${n}`, async () => (await screenOf(p)) === 'reveal', 15_000);
      const me = await tv.evaluate((uids) => {
        const g = (window as unknown as { __tv: { host: { snapshot: () => { game: { reveal?: { me: Record<string, { pts: number; tot: number; rank: number | null }> } } } } } }).__tv.host.snapshot().game;
        return uids.map((u) => g.reveal?.me[u] ?? null);
      }, phoneUid);
      for (const [k, p] of phones.entries()) {
        const want = me[k];
        // (the number counts up: wait for it — the autopilot's board comes 9 s after the answer)
        const shown = await until(`${PHONES[k]!.name}: points shown`, async () => {
          const x = await p.evaluate(() => ({
            pts: Number(/-?\d+/.exec(document.querySelector('.pl-r-pts')?.getAttribute('aria-label') ?? '')?.[0] ?? NaN),
            rank: Number(/\d+/.exec(document.querySelector('.pl-r-rank b')?.textContent ?? '')?.[0] ?? NaN),
          }));
          return want && x.pts === want.pts && (want.rank === null || x.rank === want.rank) ? x : null;
        }, 6_000, 150).catch(async () => p.evaluate(() => ({ pts: document.querySelector('.pl-r-pts')?.getAttribute('aria-label') ?? '', rank: document.querySelector('.pl-r-rank b')?.textContent ?? '' })));
        check(want && shown.pts === want.pts && (want.rank === null || shown.rank === want.rank), `Q${n} ${PHONES[k]!.name}: phone shows +${shown.pts} #${shown.rank} = reveal ${JSON.stringify(want)}`);
      }
      if (vid && q) {
        // every answer of the video round is scored from the post-video openAt
        const { r1, openAt0, oldEndsAt } = vid;
        const T = q.timeLimitS * 1000;
        const revealMe = (await snap(tv)).game.reveal?.me ?? {};
        const answers = (await getDocsFromServer(refs.answers(G))).docs.map((d) => d.data()).filter((a) => a.round === r1.i);
        const rows = answers.map((a) => {
          const e = Math.min(T, Math.max(0, a.at - r1.openAt));
          return {
            uid: a.uid,
            e,
            want: scoreAnswer(q, { p: a.p, elapsedMs: e }, hostSettings.scoring, false).points,
            // what the fallback openAt would have given (answers "before" it count as instant)
            fallback: scoreAnswer(q, { p: a.p, elapsedMs: Math.min(T, Math.max(0, a.at - openAt0)) }, hostSettings.scoring, false).points,
            got: revealMe[a.uid]?.pts,
            late: a.at > oldEndsAt,
          };
        });
        const everyone = BOT_NAMES.length + PHONES.length;
        const bad = rows.filter((r) => r.got !== r.want && !(r.uid === vladosUid && r.got === undefined));
        check(rows.length === everyone && bad.length === 0, `Q${n} all ${rows.length}/${everyone} answers scored from the post-video openAt (elapsed ${rows.map((r) => (r.e / 1000).toFixed(1)).join(', ')} s)${bad.length ? ` MISMATCH ${JSON.stringify(bad)}` : ''}`);
        check(rows.every((r) => r.late), `Q${n} ${rows.filter((r) => r.late).length}/${rows.length} answers came after the old timer (started with the video) had run out — all counted`);
        const light = rows.find((r) => r.uid === phoneUid[0]);
        say(`Q${n} ${PHONES[0]!.name}: ${light ? `${(light.e / 1000).toFixed(2)} s → +${light.got} (the fallback openAt would give +${light.fallback})` : 'no answer'}`);
      }
      // the answer's photo: on the TV (from the mercury droplet) and on the phones («на телефонах»)
      if (rm === 'photo') {
        const tvPic = await until(`Q${n} TV: the answer's photo`, () => tv.evaluate(() => {
          const img = document.querySelector<HTMLImageElement>('.trc-media img');
          return img?.complete && img.naturalWidth > 0 ? img.naturalWidth : null;
        }), 12_000, 150).catch(() => 0);
        const phPic = await Promise.all(phones.map((p) => until('phone: the answer\'s photo', () => p.evaluate(() => {
          const img = document.querySelector<HTMLImageElement>('.pl-r-photo img');
          return img?.complete && img.naturalWidth > 0 ? img.naturalWidth : null;
        }), 12_000, 150).catch(() => 0)));
        check(tvPic > 0 && phPic.every((x) => x > 0), `Q${n} the answer's photo on the TV (${tvPic}px) and on both phones (${phPic.join(' / ')}px)`);
        await shot('tv-reveal-photo', [tv], composer);
        await shot('phones-reveal-photo', phones, composer);
      }
      // the answer's video: the TV plays it with sound to its end and reports it ('revealMediaEnd')
      if (rm === 'video') {
        const pl = await until(`Q${n} TV: the answer's video plays`, () => videoEvent(tv, 'playing', 'reveal', revealAt), 15_000, 100).catch(() => null);
        check(pl && !pl.muted, `Q${n} TV: the answer's video plays with sound (${pl ? `${((pl.srv! - revealAt) / 1000).toFixed(1)} s after the answer` : 'never'})`);
        await sleep(1000);
        await shot('tv-reveal-video', [tv], composer);
        const en = await until(`Q${n} TV: the answer's video 'ended'`, () => videoEvent(tv, 'ended', 'reveal', revealAt), 30_000, 100).catch(() => null);
        check(en && en.t >= en.d - 0.3, `Q${n} TV: the answer's video played to its end (${en ? `${en.t.toFixed(2)} of ${en.d.toFixed(2)} s` : 'no ended'})`);
        if (en?.srv) revealVideoEnd = { i: round.i, srv: en.srv };
        const reported = await until(`Q${n} the TV reported it`, async () => {
          const r = (await totalsOf(tv)).rounds.find((x) => x.i === round.i);
          return typeof r?.revealEndMs === 'number' ? r.revealEndMs : null;
        }, 8_000, 100).catch(() => null);
        check(reported !== null && en?.srv && Math.abs(revealAt + reported - en.srv) <= 1_000, `Q${n} 'revealMediaEnd' stored: the video ended ${reported === null ? '?' : (reported / 1000).toFixed(2)} s after the answer`);
      }
      if (round.type === 'number' && !rm) await shot('tv-reveal-number', [tv], composer);
      if (round.type === 'ordering' && !rm) await shot('tv-reveal-ordering', [tv], composer);
      if (n === 1) {
        await shot('phones-reveal', phones, composer);
        await shot('tv-reveal-choice', [tv], composer);
      }

      // after a «Сюрприз» the quiz is over: the final comes by itself 10 s after its answer (no board)
      if (isSurprise) {
        await until('the final after the «Сюрприз»', async () => (await tvState(tv))?.phase === 'final', SURPRISE.toFinalMs + 8_000);
        void st;
        break;
      }
      if (MANUAL) await pressSpace(tv, 'Таблица');
      await until(`TV board ${n}${MANUAL ? '' : ' (by itself)'}`, async () => (await tvState(tv))?.phase === 'board', MANUAL ? 15_000 : 40_000);
      for (const [k, p] of phones.entries()) await until(`${PHONES[k]!.name}: board ${n}`, async () => (await screenOf(p)) === 'board', 15_000);
      if (n === 3) {
        await sleep(2500);
        await shot('tv-board', [tv], composer);
        await shot('phones-board', phones, composer);
      }
      if (MANUAL) {
        await sleep(1500);
        await pressSpace(tv, 'Следующий вопрос');
      }
      void st;
    }

    // ---- the final: drumroll → 3rd → 2nd → 1st → Vlados vs friends → «С днём рождения» → (5 s) the video
    await until('TV final', async () => (await tvState(tv))?.phase === 'final', 20_000);
    for (const [k, p] of phones.entries()) await until(`${PHONES[k]!.name}: final`, async () => (await screenOf(p)) === 'final', 15_000);
    const ranked = BOT_NAMES.length + PHONES.length - 1;
    /** The phones' place (from step 3 on): the rank the TV's data gives each of them, «место из N». */
    const checkPlaces = async (when: string) => {
      const fme = (await snap(tv)).game.final?.me ?? {};
      for (const [k, p] of phones.entries()) {
        const want = fme[phoneUid[k]!];
        const got = await until(`${PHONES[k]!.name}: place`, () => p.evaluate(() => {
          const num = document.querySelector('.pl-f-num')?.textContent ?? '';
          // («место из N» and the points are lines of their own: read each one apart)
          const of = [...document.querySelectorAll('.pl-f-of')].map((el) => /место из (\d+)/.exec((el.textContent ?? '').replace(/\s+/g, ' '))?.[1]).find(Boolean) ?? null;
          return num ? { num: Number(num), of } : null;
        }), 6_000, 150).catch(() => null);
        check(want && got && got.num === want.rank && got.of === String(ranked), `${when}: ${PHONES[k]!.name} sees place ${got?.num} «место из ${got?.of}» = final ${JSON.stringify(want)} (Vlados is out of the ranking)`);
      }
    };
    for (let guard = 0; guard < 12; guard++) {
      const s = await tvState(tv);
      const step = s?.step ?? 0;
      if (step >= 5) break;
      if (step === 3) {
        await sleep(2500);
        await shot('tv-final-podium', [tv], composer);
      }
      if (step === 4) {
        await checkPlaces('final step 4');
        await shot('phones-final', phones, composer);
      }
      if (MANUAL) {
        await sleep(step === 3 ? 1500 : 2600);
        await pressSpace(tv, `финал, шаг ${step}`);
      }
      await until(`final step ${step} → ${step + 1}${MANUAL ? '' : ' (by itself)'}`, async () => ((await tvState(tv))?.step ?? 0) > step, MANUAL ? 10_000 : 15_000);
    }
    // «С днём рождения, Владос!»: the phones still show their place right before the video
    const fin = await tv.evaluate(() => (window as unknown as { __tv: { view: () => { final: { step: number; vlados?: { uid: string } | null } | null } } }).__tv.view().final);
    check(fin?.step === 5 && fin.vlados?.uid === vladosUid, `final reached the mosaic with the Vlados comparison (step ${fin?.step})`);
    await checkPlaces('«С днём рождения» (right before the video)');
    await sleep(1200);
    await shot('tv-final-mosaic', [tv], composer);

    // ---- the video after the final: by itself 5 s after the mosaic (both modes), the built-in clip
    const g6 = await until('the video after the final (by itself)', async () => {
      const g = (await snap(tv)).game;
      return g.phase === 'final' && g.final?.step === 6 && g.final.video ? g : null;
    }, FINALE.autoMs + 8_000, 100);
    const fv = g6.final!.video!;
    check(!fv.id && Math.abs(fv.ms - FINALE.builtin.ms) < 50, `step 6: the built-in finale video (${fv.ms} ms), starts ${((fv.at - (await totalsOf(tv)).phaseAt) / 1000).toFixed(1)} s in`);
    const fplay = await until('TV: the finale video plays', () =>
      tv.evaluate(() => {
        const v = document.querySelector<HTMLVideoElement>('.tfv-host video');
        return v && !v.paused && v.currentTime > 1 ? { muted: v.muted, vol: v.volume, d: v.duration, src: v.currentSrc.slice(0, 40) } : null;
      }), 15_000, 100).catch(() => null);
    check(fplay && !fplay.muted && fplay.vol === 1 && Math.abs(fplay.d * 1000 - FINALE.builtin.ms) < 400, `TV: the finale video plays WITH SOUND (${JSON.stringify(fplay)})`);
    const phFv = await Promise.all(
      phones.map((p) =>
        until('phone: the finale — «Смотри на экран»', () => p.evaluate(() => {
          const el = document.querySelector('.pl-fv');
          return el?.getAttribute('data-stage') === 'play' ? { text: document.querySelector('.pl-fv-h')?.textContent ?? '', videos: document.querySelectorAll('video').length } : null;
        }), 10_000, 100).catch(() => null),
      ),
    );
    for (const [k, x] of phFv.entries()) check(x && /Смотри на экран/.test(x.text) && x.videos === 0, `${PHONES[k]!.name} during the finale video: «${x?.text}», no <video> on the phone`);
    await sleep(1500);
    await shot('tv-finale', [tv], composer);
    await shot('phones-finale', phones, composer);
    const fend = await until('TV: the finale video ended', () => videoEvent(tv, 'ended', 'finale', fv.at), FINALE.builtin.ms + 20_000, 200).catch(() => null);
    check(fend && fend.t >= fend.d - 0.3, `TV: the finale video played to its end (${fend ? `${fend.t.toFixed(2)} of ${fend.d.toFixed(2)} s, ${((fend.srv! - fv.at) / 1000).toFixed(1)} s after its start` : 'no ended'})`);
    // the end: the phones go back to their final screen, nothing is scheduled any more
    const back = await Promise.all(phones.map((p) => until('phone: back to its final', () => p.evaluate(() => (!document.querySelector('.pl-fv') && document.querySelector('.pl-f-num') ? true : null)), 10_000, 150).catch(() => false)));
    check(back.every(Boolean), `after the video the phones show their final again (${back.join(' / ')})`);
    await checkPlaces('the end');
    const endView = await tv.evaluate(() => (window as unknown as { __tv: { view: () => { autopilot: { next: unknown } } } }).__tv.view().autopilot);
    check(endView.next === null, 'the end: nothing is scheduled after the video');

    // ---- the pace: every transition from the host's stored phase times (±1.5 s)
    const plog = await phaseLog(tv);
    const tot = await totalsOf(tv);
    const marks = plog.map(markOf);
    const wantMarks = ['lobby', ...questions.flatMap((qq, k) => ['intro', 'open', 'locked', 'reveal', ...(k < questions.length - 1 ? ['board'] : [])]), ...[0, 1, 2, 3, 4, 5, 6].map((x) => `final:${x}`)];
    check(marks.join(' ') === wantMarks.join(' '), `every step once, in order: ${marks.length} phases${marks.join(' ') === wantMarks.join(' ') ? '' : ` — GOT ${marks.join(' ')}`}`);
    const pace: string[] = [];
    for (let k = 1; k + 1 < plog.length; k++) {
      const a = plog[k]!;
      const b = plog[k + 1]!;
      const gap = b.at - a.at;
      const r = a.i === null ? undefined : tot.rounds.find((x) => x.i === a.i);
      const qn = r ? `Q${questions.findIndex((x) => x.id === r.qid) + 1}` : '';
      let want: number | null = null;
      let what = '';
      if (a.phase === 'intro' && r) {
        want = r.openAt - r.introAt;
        what = r.watch ? 'intro + the video + 3-2-1' : 'intro';
        if (!r.watch) check(want === hostSettings.introMs, `${qn} options ${hostSettings.introMs / 1000} s after the intro (frozen ${want})`);
      } else if (a.phase === 'open' && r?.surprise) {
        want = r.surprise.afterMs;
        what = '«Сюрприз» after the options';
      } else if (a.phase === 'open' && r) {
        what = 'answers (everybody answered / the timer)';
        check(gap <= r.endsAt - r.openAt + TOL_MS, `${qn} ${what}: ${(gap / 1000).toFixed(1)} s`);
      } else if (a.phase === 'locked' && r) {
        want = r.surprise ? surpriseLeadMs() + r.surprise.ms : hostSettings.lockMs + HOST_TIMING.revealGraceMs;
        what = r.surprise ? 'breakdown + black + the video → the answer' : 'lock → the answer';
      } else if (a.phase === 'reveal' && r) {
        if (!MANUAL || r.surprise) want = autoHoldMs({ phase: 'reveal', finalStep: 0 }, r, hostSettings);
        what = r.surprise ? 'the answer → the final' : r.revealEndMs !== undefined ? 'the answer (its video ended + 2 s) → board' : r.revealHoldMs ? 'the answer (photo / video) → board' : 'the answer → board';
      } else if (a.phase === 'board') {
        if (!MANUAL) want = SHOW.boardMs;
        what = 'board → next';
      } else if (a.phase === 'final') {
        const step = a.step ?? 0;
        if (!MANUAL || step === 5) want = autoHoldMs({ phase: 'final', finalStep: step }, undefined, hostSettings);
        what = `final ${step} → ${step + 1}`;
      }
      pace.push(`${qn} ${markOf(a)} → ${markOf(b)} ${(gap / 1000).toFixed(2)} s${want !== null ? ` (want ${(want / 1000).toFixed(2)})` : ''}`);
      if (want !== null) check(Math.abs(gap - want) <= TOL_MS, `pace ${qn} ${what}: ${(gap / 1000).toFixed(2)} s (want ${(want / 1000).toFixed(2)} ± ${TOL_MS / 1000})`);
    }
    say(`pace:\n   ${pace.join('\n   ')}`);
    if (!MANUAL) {
      // the answer's video: the board 2 s after the TV's 'ended', well before the clock would have moved
      const rv = revealVideoEnd;
      const r = rv ? tot.rounds.find((x) => x.i === rv.i) : undefined;
      const k = r ? plog.findIndex((x) => x.phase === 'board' && x.i === r.i) : -1;
      const boardAt = k >= 0 ? plog[k]!.at : NaN;
      const revealAt = k > 0 ? plog[k - 1]!.at : NaN;
      check(
        rv && r?.revealHoldMs && Math.abs(boardAt - rv.srv - SHOW.revealVideoEndedMs) <= TOL_MS && boardAt - revealAt < r.revealHoldMs - 1_000,
        `the answer's video: the board ${((boardAt - (rv?.srv ?? 0)) / 1000).toFixed(2)} s after the TV's 'ended' (want ${SHOW.revealVideoEndedMs / 1000}), ${((boardAt - revealAt) / 1000).toFixed(1)} s after the answer instead of the clock's ${((r?.revealHoldMs ?? 0) / 1000).toFixed(1)} s`,
      );
    }

    recording = false;
    await recorder;
    const tvSeen = [...seen.tv].join(' ');
    for (const need of ['lobby|lobby', 'intro|q', 'open|q', 'reveal|rc', 'reveal|rn', 'reveal|ro', 'board|board', 'final:5|final', 'final:6|final']) {
      check(tvSeen.includes(need), `TV rendered ${need}`);
    }
    for (const [k, s] of seen.phones.entries()) {
      const need = ['lobby', 'intro', 'question', 'answered', 'reveal', 'board', 'final'];
      check(need.every((x) => s.has(x)), `${PHONES[k]!.name} saw ${need.join(', ')} (${[...s].join(', ')})`);
    }
    say(`TV scenes: ${tvSeen}`);
    check(Math.max(...timerDiffs) <= 1, `max timer difference TV↔phone: ${Math.max(...timerDiffs)} s`);

    // ---- cleanup of the phones' own anonymous users (they delete themselves)
    for (const p of phones) {
      await p.evaluate(async ([k, apiKey]) => {
        const u = JSON.parse(localStorage.getItem(k as string) ?? '{}') as { stsTokenManager?: { accessToken?: string } };
        const idToken = u.stsTokenManager?.accessToken;
        if (idToken) await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${apiKey}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken }) }).catch(() => undefined);
      }, [authKey, DEV.apiKey]);
    }
  } finally {
    if (botTimer) clearInterval(botTimer);
    for (const b of bots) b.p.stop();
    if (tvCtx) await tvCtx.close().catch(() => undefined);
    for (const c of phoneCtx) await c.close().catch(() => undefined);
    await wk.close().catch(() => undefined);
    await cr.close().catch(() => undefined);
    await sleep(500);
    // DEV cleanup: test game, test media, content restored, anonymous bot users removed
    for (const col of [refs.answers(G), refs.reactions(G), refs.players(G), collection(admin.db, `games/${G}/private`)]) {
      const snap = await getDocsFromServer(col).catch(() => null);
      await Promise.all((snap?.docs ?? []).map((d) => deleteDoc(d.ref)));
    }
    await deleteDoc(refs.game(G)).catch(() => undefined);
    for (const id of media) await deleteMedia(refs, id).catch((e) => say(`media cleanup ${id}: ${String(e)}`));
    if (contentChanged && original) {
      const now = (await getDocFromServer(contentRef).catch(() => null))?.data() as AdminContentDoc | undefined;
      await setDoc(contentRef, { ...original, rev: Math.max(original.rev, now?.rev ?? 0) + 1 });
    }
    for (const c of clients) {
      const u = c.auth.currentUser;
      if (u?.isAnonymous) await deleteUser(u).catch(() => undefined);
      await terminate(c.db).catch(() => undefined);
      await deleteApp(c.app).catch(() => undefined);
    }
    say(`cleaned up DEV: games/${G}, ${media.length} media, admin/content restored, bot users removed`);
  }
}

main()
  .catch((e: unknown) => {
    fails.push(`crashed: ${e instanceof Error ? e.message : String(e)}`);
    console.error(e);
  })
  .finally(() => {
    const uniq = [...new Set(errors)];
    check(uniq.length === 0, `no console/page errors (${uniq.length})`);
    for (const e of uniq.slice(0, 40)) console.log('   ' + e);
    if (netWarnings.length) console.log(`network warnings: ${netWarnings.length}\n   ${[...new Set(netWarnings)].join('\n   ')}`);
    writeFileSync(join(OUT, 'result.json'), JSON.stringify({ base: BASE, game: G, fails, errors: uniq, netWarnings, shots }, null, 2));
    console.log(fails.length ? `\nFAILED ${fails.length}:\n - ${fails.join('\n - ')}` : `\nALL OK (${ts().trim()} s, ${shots} screenshots)`);
    process.exit(fails.length ? 1 : 0);
  });
