// DEV ONLY — a video question as a guest's phone lives it, second by second (the organizer's report:
// «на телефоне ни видео, ни звука, ни вариантов ответа»). Against a LOCAL build (vite preview):
//
//   npm run build && npx tsx tools/video-phone-dev.ts                 no TV: an admin Host is the only host
//   npx tsx tools/video-phone-dev.ts --tv                             + the TV page (#/tv) as the host
//   npx tsx tools/video-phone-dev.ts --freeze 6:40                    no TV, the admin host frozen 40 s from
//                                                                     6 s into the round (a hidden admin tab)
//   --no-build (reuse dist/app) · --port 4183 · --shots (2 phone screenshots)
//   --flog                                                            frame log of the options: they must
//                                                                     appear ONCE and only grow (no flash,
//                                                                     no replay when the host's «open» lands
//                                                                     after the phone opened by its clock); the
//                                                                     tap waits 5 s so the log covers that
//
// The question: a vertical (720×1280) ~15 s test clip with sound (recorded in WebKit, cached in
// runtime/video-phone/), media.onPhones = true (as the organizer had it), 15 s to answer. The admin
// host is a Node Host with preferred:false (what #/admin runs); the phone is a real WebKit page,
// 390×844, joined through the join form. Logged every 250 ms when something changes (at least every
// second): the phone's screen, watch stage, copy, option buttons (and how many are enabled), the
// timer, a <video> on the phone, relative to the round's introAt / openAt (server time). At the
// opening the phone taps an option. Checks: the watch window (video + 5 s with a TV, + 1 s without),
// the phone never shows a video, «Смотри видео на большом экране» + a bar that follows the video,
// «Варианты появятся через 3…2…1» counting to openAt, the options at openAt (±0.35 s) with the FULL
// timer — also while the doc still says 'intro' (--freeze) — and the tap accepted and scored from openAt.
//
// DEV admin/content gets the test question first for the run and is restored afterwards; the test
// game `vp-<ts>`, the clip, its poster and the phone's anonymous user are deleted.

import { FB_PROJECTS, type AdminContentDoc, type GameDoc, type RoundPub } from '@shared/fbtypes';
import { WATCH } from '@shared/engine/watch';
import { scoreAnswer } from '@shared/scoring';
import type { ChoiceQ } from '@shared/types';
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { inMemoryPersistence, initializeAuth, signInWithEmailAndPassword, type Auth } from 'firebase/auth';
import { collection, deleteDoc, doc, getDocFromServer, getDocsFromServer, initializeFirestore, memoryLocalCache, setDoc, setLogLevel, terminate, type Firestore } from 'firebase/firestore';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, type Browser, type BrowserContext, type Page } from 'playwright';
import { ServerClock } from '../app/src/fb/clock';
import { deleteMedia, uploadMedia } from '../app/src/fb/media';
import { fbRefs } from '../app/src/fb/refs';
import { Host } from '../app/src/host/driver';
import { hostContent } from '../app/src/host/pure';
import { ensureDevBotAdmin } from './dev-bot-admin.mjs';

const DEV = FB_PROJECTS.dev;
if (DEV.projectId !== 'vlados-2609-dev') throw new Error('video-phone-dev runs against the DEV project only');
setLogLevel('silent');

const args = process.argv.slice(2);
const flag = (k: string) => args.includes(`--${k}`);
const opt = (k: string): string | undefined => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const WITH_TV = flag('tv');
const FREEZE = opt('freeze')?.split(':').map(Number) as [number, number] | undefined;
const PORT = opt('port') ?? '4183';
const BASE = `http://localhost:${PORT}/`;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'runtime', 'video-phone');
mkdirSync(OUT, { recursive: true });
const G = `vp-${Date.now()}`;
const CLIP_S = 15.1;
const LIMIT_S = 15;
const AUTH_KEY = `firebase:authUser:${DEV.apiKey}:[DEFAULT]`;
const NAME_SHIM = 'globalThis.__name = globalThis.__name || ((f) => f)';

/**
 * --flog: every animation frame, the option buttons' visible amount (effective opacity × scale of
 * the most visible one, 0 when there are none) with the phone's server time and the game doc's phase.
 */
const FLOG = `(() => {
  const log = (window.__flog = []);
  const eff = (el) => {
    let op = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return 0;
      op *= parseFloat(cs.opacity);
    }
    return op;
  };
  const frame = () => {
    let a = 0;
    const els = document.querySelectorAll('.pl-q .vx-opt');
    for (const el of els) {
      const r = el.getBoundingClientRect();
      a = Math.max(a, eff(el) * (el.offsetWidth ? r.width / el.offsetWidth : 0));
    }
    const pl = window.__pl;
    log.push({ t: pl ? pl.clock.now() : Date.now(), a: +a.toFixed(3), n: els.length, doc: pl && pl.snapshot().game ? pl.snapshot().game.phase : '' });
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
})();`;

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
  id: 'vp-video',
  type: 'choice',
  title: 'Что было в конце вертикального видео? (тест)',
  options: [
    { id: 'a', text: 'Торт' },
    { id: 'b', text: 'Кот' },
    { id: 'c', text: 'Шар' },
    { id: 'd', text: 'Ничего' },
  ],
  correctId: 'c',
  timeLimitS: LIMIT_S,
  double: false,
};

// ------------------------------------------------------------------ the test clip (cached)

/** A vertical 720×1280 MP4 (H.264 + an AAC tone) and a JPEG poster, recorded in WebKit. */
async function clip(wk: Browser): Promise<{ video: Buffer; mime: string; poster: Buffer; durationS: number }> {
  const vf = join(OUT, 'clip.mp4');
  const pf = join(OUT, 'poster.jpg');
  const mf = join(OUT, 'clip.json');
  if (existsSync(vf) && existsSync(pf) && existsSync(mf)) {
    const m = JSON.parse(readFileSync(mf, 'utf8')) as { mime: string; durationS: number };
    return { video: readFileSync(vf), poster: readFileSync(pf), ...m };
  }
  say(`recording a ${CLIP_S} s vertical test clip in WebKit…`);
  const page = await wk.newPage();
  await page.setContent('<canvas id="c" width="720" height="1280"></canvas>');
  await page.evaluate(NAME_SHIM);
  const out = await page.evaluate(async (seconds: number) => {
    const b64 = async (blob: Blob) => {
      const u = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
      return btoa(s);
    };
    const c = document.getElementById('c') as HTMLCanvasElement;
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    const draw = (t: number) => {
      g.fillStyle = `hsl(${(t * 24) % 360} 40% 22%)`;
      g.fillRect(0, 0, 720, 1280);
      const y = 640 + Math.sin(t * 1.6) * 420;
      g.fillStyle = '#e8ecf2';
      g.beginPath();
      g.arc(360, y, 110, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#fff';
      g.font = '700 54px sans-serif';
      g.fillText(`вертикальное · ${t.toFixed(1)} с`, 60, 120);
    };
    draw(0.5);
    const poster = await new Promise<Blob>((r) => c.toBlob((b) => r(b as Blob), 'image/jpeg', 0.8));
    draw(0);
    const stream = c.captureStream(30);
    try {
      const ac = new AudioContext();
      await ac.resume().catch(() => undefined);
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      gain.gain.value = 0.05;
      const dst = ac.createMediaStreamDestination();
      osc.connect(gain).connect(dst);
      osc.start();
      const track = dst.stream.getAudioTracks()[0];
      if (track) stream.addTrack(track);
    } catch {
      /* no sound track */
    }
    const mimeType = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4'].find((t) => MediaRecorder.isTypeSupported(t)) ?? 'video/mp4';
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1_500_000 });
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
    // the real length (a recorder's MP4 may report Infinity until seeked to the end)
    const v = document.createElement('video');
    v.muted = true;
    v.src = URL.createObjectURL(video);
    const dur = await new Promise<number>((r) => {
      v.onloadedmetadata = () => {
        if (Number.isFinite(v.duration)) return r(v.duration);
        v.ontimeupdate = () => {
          v.ontimeupdate = null;
          r(v.duration);
        };
        v.currentTime = 1e6;
      };
      v.onerror = () => r(NaN);
      setTimeout(() => r(NaN), 8000);
    });
    return { video: await b64(video), poster: await b64(poster), mime: rec.mimeType || mimeType, durationS: dur };
  }, CLIP_S);
  await page.close();
  const durationS = Number.isFinite(out.durationS) && out.durationS > 0 ? Math.round(out.durationS * 10) / 10 : CLIP_S;
  const res = { video: Buffer.from(out.video, 'base64'), poster: Buffer.from(out.poster, 'base64'), mime: out.mime.split(';')[0] ?? 'video/mp4', durationS };
  writeFileSync(vf, res.video);
  writeFileSync(pf, res.poster);
  writeFileSync(mf, JSON.stringify({ mime: res.mime, durationS }));
  return res;
}

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

// ------------------------------------------------------------------ the phone, as seen

interface PhoneSeen {
  screen: string;
  stage: string | null;
  kick: string;
  big: string;
  sub: string;
  opts: number;
  enabled: number;
  timer: string | null;
  intro: string | null;
  bar: number | null;
  video: number;
  /** The phone's own server clock (PlayerSession.clock, DEV hook window.__pl) and its sample. */
  clk: number | null;
  rtt: number | null;
}
const phoneSeen = (p: Page): Promise<PhoneSeen | null> =>
  p
    .evaluate(() => {
      const q = (s: string) => document.querySelector(s);
      const txt = (s: string) => (q(s)?.textContent ?? '').replace(/\s+/g, ' ').trim();
      const opts = Array.from(document.querySelectorAll<HTMLButtonElement>('.pl-q .vx-opt'));
      const fill = q('.pl-watch-bar i') as HTMLElement | null;
      return {
        screen: q('.pl')?.getAttribute('data-screen') ?? 'none',
        stage: q('.pl-watch')?.getAttribute('data-stage') ?? null,
        kick: txt('.pl-intro-mid .vx-kick'),
        big: txt('.pl-intro-ready'),
        sub: txt('.pl-intro-mid .pl-wait'),
        opts: opts.length,
        enabled: opts.filter((b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true').length,
        timer: q('.pl-q-timer b')?.textContent ?? null,
        intro: q('.pl-intro-n')?.textContent ?? null,
        bar: fill ? Math.round(Number(fill.dataset.p ?? 0) * 100) : null,
        video: document.querySelectorAll('video').length,
        clk: (window as unknown as { __pl?: { clock: { now(): number } } }).__pl?.clock.now() ?? null,
        rtt: (window as unknown as { __pl?: { clock: { get(): { rttMs: number | null } } } }).__pl?.clock.get().rttMs ?? null,
      };
    })
    .catch(() => null);

const fmt = (s: PhoneSeen): string =>
  [
    s.screen.padEnd(8),
    s.stage ? `watch:${s.stage}` : '',
    s.kick ? `«${s.kick}»` : '',
    s.big ? `«${s.big}»` : '',
    s.sub ? `«${s.sub.slice(0, 48)}»` : '',
    s.intro !== null ? `n=${s.intro}` : '',
    s.bar !== null ? `bar=${s.bar}%` : '',
    s.opts ? `options ${s.enabled}/${s.opts} enabled` : 'no options',
    s.timer ? `timer ${s.timer}` : '',
    s.video ? `VIDEO×${s.video}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  if (!flag('no-build')) {
    const b = spawnSync(join(ROOT, 'node_modules', '.bin', 'vite'), ['build'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
    if (b.status !== 0) throw new Error('vite build failed');
  }
  const preview = spawn(join(ROOT, 'node_modules', '.bin', 'vite'), ['preview', '--port', PORT, '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  cleanups.push(async () => void preview.kill());
  await until('vite preview', () => fetch(BASE).then((r) => r.ok, () => false), 20_000, 200);
  say(`scenario: ${WITH_TV ? 'TV page + admin host' : 'NO TV, admin host only'}${FREEZE ? `, admin host frozen ${FREEZE[1]} s from ${FREEZE[0]} s` : ''} · ${BASE} · DEV game ${G}`);

  const bot = await ensureDevBotAdmin();
  const admin = await client('vp-admin', (a) => signInWithEmailAndPassword(a, bot.email, bot.password));
  const refs = fbRefs(admin.db);
  const contentRef = doc(admin.db, 'admin/content');
  const original = (await getDocFromServer(contentRef)).data() as AdminContentDoc | undefined;
  if (!original) throw new Error('DEV admin/content missing — run npm run seed:dev');

  const wk = await webkit.launch();
  cleanups.push(() => wk.close());
  const cl = await clip(wk);
  const poster = await uploadMedia(refs, { kind: 'image', blob: new Blob([new Uint8Array(cl.poster)], { type: 'image/jpeg' }), w: 720, h: 1280 });
  cleanups.push(() => deleteMedia(refs, poster.id));
  const video = await uploadMedia(refs, { kind: 'video', blob: new Blob([new Uint8Array(cl.video)], { type: cl.mime }), w: 720, h: 1280, durationS: cl.durationS, posterId: poster.id });
  cleanups.push(() => deleteMedia(refs, video.id));
  say(`clip: ${video.id} ${(cl.video.length / 1024).toFixed(0)} KB ${cl.mime} ${cl.durationS} s 720×1280, poster ${poster.id}`);

  const q: ChoiceQ = { ...VQ, media: { mediaId: video.id, onPhones: true } };
  await setDoc(contentRef, { ...original, rev: original.rev + 1, questions: [q, ...original.questions] });
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
  const introMs = original.settings.introMs;

  // ---- the admin page's host (standby, not preferred) — the organizer's only host
  const host = new Host({ db: admin.db, uid: admin.auth.currentUser?.uid ?? '', label: 'admin', reactions: false, followCurrent: false, clock: new ServerClock() });
  await host.start(G);
  await host.whenReady();
  cleanups.push(() => host.stop());
  await until('admin host: lobby + video known', () => host.snapshot().game?.phase === 'lobby' && host.snapshot().media[video.id]?.durationS === cl.durationS, 30_000);

  // ---- the TV page (optional)
  let tv: Page | null = null;
  if (WITH_TV) {
    const session = await client('vp-tvsess', (a) => signInWithEmailAndPassword(a, bot.email, bot.password));
    const user = session.auth.currentUser?.toJSON() as Record<string, unknown>;
    user.appName = '[DEFAULT]';
    const cr = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
    cleanups.push(() => cr.close());
    const ctx = await cr.newContext({ viewport: { width: 1280, height: 720 } });
    await ctx.addInitScript(NAME_SHIM);
    await ctx.addInitScript(([k, v]) => localStorage.getItem(k as string) ?? localStorage.setItem(k as string, v as string), [AUTH_KEY, JSON.stringify(user)]);
    await ctx.addInitScript(`(() => { const ev = (window.__vev = []); for (const type of ['playing', 'ended', 'error']) document.addEventListener(type, (e) => { const v = e.target; if (v instanceof HTMLVideoElement) ev.push({ type, srv: window.__tv ? window.__tv.host.now() : null, t: v.currentTime, d: v.duration, muted: v.muted }); }, true); })();`);
    tv = await ctx.newPage();
    await tv.goto(`${BASE}?env=dev&game=${G}#/tv`);
    await tv.getByRole('button', { name: /Начать шоу/ }).click({ timeout: 60_000 });
    await until('TV holds the lease', () => host.snapshot().lease?.label === 'tv' && host.snapshot().lease!.until > host.now(), 30_000, 200);
    say('TV page is live and holds the lease');
  } else {
    await until('admin host holds the lease', () => host.snapshot().lease?.session === host.session, 30_000, 200);
  }

  // ---- the phone: WebKit, iPhone-sized, joins like a guest
  const phoneCtx: BrowserContext = await wk.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  });
  await phoneCtx.addInitScript(NAME_SHIM);
  if (flag('flog')) await phoneCtx.addInitScript(FLOG);
  const phone = await phoneCtx.newPage();
  const errors: string[] = [];
  phone.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 200)}`));
  phone.on('console', (m) => m.type() === 'error' && !/Could not reach Cloud Firestore/.test(m.text()) && errors.push(`console.error: ${m.text().slice(0, 200)}`));
  await phone.goto(`${BASE}?env=dev&game=${G}#/`);
  await until('phone: join', async () => (await phoneSeen(phone))?.screen === 'join', 45_000, 200);
  const early = phone.getByRole('button', { name: 'Зарегистрируйся заранее' });
  const input = phone.locator('input').first();
  await until('name field', async () => (await early.isVisible().catch(() => false)) || (await input.isVisible().catch(() => false)), 20_000, 200);
  if (await early.isVisible().catch(() => false)) await early.click();
  await input.fill('Тестер');
  await phone.getByRole('button', { name: 'Дальше' }).click();
  await phone.getByRole('button', { name: 'Пропустить' }).click();
  await until('phone: lobby', async () => (await phoneSeen(phone))?.screen === 'lobby', 30_000, 200);
  const uid = await phone.evaluate((k) => (JSON.parse(localStorage.getItem(k) ?? '{}') as { uid?: string }).uid ?? '', AUTH_KEY);
  cleanups.push(async () => {
    await phone.evaluate(async ([k, apiKey]) => {
      const u = JSON.parse(localStorage.getItem(k as string) ?? '{}') as { stsTokenManager?: { accessToken?: string } };
      const idToken = u.stsTokenManager?.accessToken;
      if (idToken) await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${apiKey}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken }) }).catch(() => undefined);
    }, [AUTH_KEY, DEV.apiKey]).catch(() => undefined);
  });
  await until('host sees the phone', () => Object.keys(host.snapshot().players).length === 1, 30_000, 200);
  say(`phone joined (uid ${uid.slice(0, 6)}…)`);

  // ---- start (the admin's «Начать»)
  const started = await host.command({ type: 'start' });
  check(started.ok, `admin «Начать» → ${JSON.stringify(started)}`);
  const r0 = await until('video round', () => {
    const g = host.snapshot().game;
    return g?.phase === 'intro' && g.round ? g.round : null;
  });
  const win = r0.media?.watchMs ?? 0;
  say(`round ${r0.i}: introAt, video window ${win} ms, openAt = introAt + ${(r0.openAt - r0.introAt) / 1000} s (intro ${introMs / 1000} + window + 3-2-1), endsAt = openAt + ${(r0.endsAt - r0.openAt) / 1000} s`);

  // ---- the frozen admin tab (optional): no lease renewals, no ticks
  const h = host as unknown as { pump: () => Promise<void> };
  const pump = h.pump.bind(host);
  if (FREEZE && !WITH_TV) {
    setTimeout(() => {
      h.pump = async () => undefined;
      say(`--- admin host FROZEN (hidden tab) for ${FREEZE[1]} s`);
      setTimeout(() => {
        h.pump = pump;
        say('--- admin host back');
        void pump();
      }, FREEZE[1] * 1000);
    }, Math.max(0, r0.introAt + FREEZE[0] * 1000 - host.now()));
  }

  // ---- second by second (sampled every 100 ms, printed on change or at least every second)
  let last = '';
  let lastAt = 0;
  let tapped: { at: number; openAt: number } | null = null;
  let firstOptions: { at: number; seen: PhoneSeen; round: RoundPub } | null = null;
  let flogUntil = 0;
  let seenVideo = false;
  const during: PhoneSeen[] = [];
  const bars: { pos: number; bar: number; videoMs: number }[] = [];
  const beatOff: string[] = [];
  let beatSamples = 0;
  let shots = 0;
  const skews: number[] = [];
  for (;;) {
    const g = host.snapshot().game as GameDoc;
    const r = g.round ?? r0;
    const t = host.now();
    const s = await phoneSeen(phone);
    const hostNow = (t + host.now()) / 2;
    if (!s) continue;
    // the phone's own server clock: what it aligns its 3-2-1 and options with
    const now = s.clk ?? hostNow;
    skews.push(now - hostNow);
    if (s.video) seenVideo = true;
    const untilAt = r.openAt - WATCH.beatMs;
    const startAt = untilAt - (r.media?.watchMs ?? 0);
    if (now < untilAt - 300 && now > startAt + 300) {
      during.push(s);
      if (s.bar !== null) bars.push({ pos: now - startAt, bar: s.bar, videoMs: r.media?.videoMs ?? 0 });
    }
    // «Варианты появятся через N»: N = the seconds to openAt on the phone's clock (±120 ms: rendering)
    if (now > untilAt + 150 && now < r.openAt - 150) {
      beatSamples++;
      const want = Math.ceil((r.openAt - now) / 1000);
      const got = Number(/через (\d+)/.exec(s.big)?.[1] ?? NaN);
      const frac = (r.openAt - now) % 1000;
      const edge = frac < 120 || frac > 880;
      if (got !== want && !edge) beatOff.push(`${((now - r.openAt) / 1000).toFixed(2)} s: «${s.big}» (want ${want})`);
    }
    const line = `${g.phase.padEnd(7)} t=${((now - r.introAt) / 1000).toFixed(1).padStart(5)} s  open${now < r.openAt ? '−' : '+'}${(Math.abs(now - r.openAt) / 1000).toFixed(1).padStart(4)} │ ${fmt(s)}`;
    const key = fmt(s).replace(/bar=\d+%/, '') + g.phase;
    if (key !== last || now - lastAt >= 1000) {
      console.log(`         ${line}`);
      last = key;
      lastAt = now;
    }
    if (flag('shots') && shots === 0 && s.stage === 'play' && now > startAt + 6000) {
      shots++;
      await phone.screenshot({ path: join(OUT, `${WITH_TV ? 'tv' : FREEZE ? 'freeze' : 'notv'}-1-watch.png`) });
    }
    if (!firstOptions && s.enabled > 0) firstOptions = { at: now, seen: s, round: r };
    if (firstOptions && !tapped && now >= firstOptions.at + (flag('flog') ? 5_000 : 1_200)) {
      if (flag('shots') && shots === 1) {
        shots++;
        await phone.screenshot({ path: join(OUT, `${WITH_TV ? 'tv' : FREEZE ? 'freeze' : 'notv'}-2-options.png`) });
      }
      tapped = { at: host.now(), openAt: r.openAt };
      if (flag('flog')) flogUntil = await phone.evaluate(() => (window as unknown as { __pl: { clock: { now(): number } } }).__pl.clock.now());
      await phone.locator('.pl-q .vx-opt').nth(2).click();
      say(`phone taps «${VQ.options[2]!.text}» (the game doc says '${host.snapshot().game?.phase}')`);
    }
    if (g.phase === 'reveal' || g.phase === 'board' || now > r.endsAt + 60_000) break;
    await sleep(firstOptions || now < r.openAt - WATCH.beatMs - 1500 ? 250 : 100);
  }

  // ---- verdict
  const g = host.snapshot().game as GameDoc;
  const r1 = g.round!;
  const answers = (await getDocsFromServer(refs.answers(G))).docs.map((d) => d.data()).filter((a) => a.round === r1.i);
  const mine = answers.find((a) => a.uid === uid);
  const me = g.reveal?.me[uid];
  const want = WITH_TV ? WATCH.tailMs : WATCH.soloTailMs;
  check(win === Math.round(cl.durationS * 1000) + want, `watch window ${win} ms = video ${cl.durationS} s + ${want / 1000} s (${WITH_TV ? 'TV on air' : 'no TV: short fallback'})`);
  check(r0.media?.videoMs === Math.round(cl.durationS * 1000), `round.media.videoMs = ${r0.media?.videoMs} (the phones' bar)`);
  check(!seenVideo, 'the phone never shows a <video>');
  const watchOk = during.every((s) => s.screen === 'intro' && s.stage === 'play' && /Смотри видео на большом экране/.test(s.big) && s.opts === 0 && !s.timer && s.bar !== null);
  check(during.length > 0 && watchOk, `during the video: «Смотри видео на большом экране» + bar, no options, no timer (${during.length} samples${during[0] ? `: ${fmt(during[0])}` : ''})`);
  const barOk = bars.every((b, k) => (k === 0 || b.bar >= (bars[k - 1]?.bar ?? 0)) && Math.abs(b.bar - Math.min(100, (b.pos / b.videoMs) * 100)) <= 8);
  check(bars.length > 0 && barOk, `the bar follows the video: ${bars.filter((_, k) => k % 8 === 0).map((b) => `${(b.pos / 1000).toFixed(1)}s→${b.bar}%`).join(' ')}`);
  check(beatSamples > 5 && beatOff.length === 0, `«Варианты появятся через 3…2…1» counts to openAt (${beatSamples} samples${beatOff.length ? `; off: ${beatOff.slice(0, 3).join(', ')}` : ''})`);
  if (firstOptions) {
    const d = firstOptions.at - firstOptions.round.openAt;
    check(d >= -50 && d <= 250, `options appear ${(d / 1000).toFixed(2)} s from openAt on the phone's clock (sampled every 0.1 s)`);
    const secs = /(\d+):(\d{2})/.exec(firstOptions.seen.timer ?? '');
    const left = secs ? Number(secs[1]) * 60 + Number(secs[2]) : -1;
    check(left === LIMIT_S, `timer starts full with the options (${firstOptions.seen.timer} of ${LIMIT_S} s)`);
  } else check(false, 'options appeared on the phone');
  check(!!mine, `the tap reached the server (${mine ? `${((mine.at - r1.openAt) / 1000).toFixed(2)} s after openAt` : 'no answer doc'})`);
  if (mine) {
    const e = Math.min(LIMIT_S * 1000, Math.max(0, mine.at - r1.openAt));
    const pts = scoreAnswer(q, { p: mine.p, elapsedMs: e }, hostContent(original).settings.scoring, false).points;
    check(me !== undefined && me.pts === pts && me.ok, `scored from openAt: elapsed ${(e / 1000).toFixed(2)} s → ${me?.pts} pts = ${pts} (ok=${me?.ok})`);
  }
  check(errors.length === 0, `no page errors (${errors.length}) ${errors.slice(0, 3).join(' | ')}`);
  if (flag('flog')) {
    // from 3 s before openAt to the tap: the options appear once and only grow (no dip, no second rise)
    const log = ((await phone.evaluate(() => (window as unknown as { __flog: { t: number; a: number; n: number; doc: string }[] }).__flog)) ?? []).filter(
      (x) => x.t >= r1.openAt - 3_000 && x.t < flogUntil,
    );
    let rises = 0;
    let dips = 0;
    let peak = 0;
    let was = false;
    for (const x of log) {
      const on = x.a >= 0.08;
      if (on && !was) rises++;
      was = on;
      if (x.a > peak) peak = x.a;
      else if (peak - x.a > 0.25 && peak > 0.3) {
        dips++;
        peak = x.a;
      }
    }
    const first = log.find((x) => x.a >= 0.08);
    const hostOpen = log.find((x) => x.doc === 'open');
    let prev = '';
    const trace = log
      .filter((x) => x.t >= (first?.t ?? r1.openAt) - 200 && x.t <= (first?.t ?? r1.openAt) + 1_500)
      .flatMap((x) => {
        const v = `${x.a}${x.doc === 'open' ? '' : '·' + x.doc}`;
        if (v === prev) return [];
        prev = v;
        return [`${x.t - r1.openAt}:${v}`];
      });
    say(`frame log (${log.length} frames, ms from openAt: visible amount, ·doc phase while not 'open'): ${trace.join(' ')}`);
    say(`the host's «open» reached the phone ${hostOpen ? `${hostOpen.t - r1.openAt} ms` : 'never (before the tap)'} after openAt; options first visible ${first ? `${first.t - r1.openAt} ms` : '—'} after openAt`);
    check(rises === 1 && dips === 0, `the options appear once and only grow (rises ${rises}, dips ${dips})`);
  }
  const sk = skews.slice().sort((a, b) => a - b);
  say(`phone clock − admin host clock: median ${sk[sk.length >> 1]?.toFixed(0)} ms (each synced to the server ±rtt/2; phone sample rtt ${(await phoneSeen(phone))?.rtt?.toFixed(0)} ms, host rtt ${host.snapshot().health.clock.rttMs?.toFixed(0)} ms)`);
  if (tv) {
    const evs = await tv.evaluate(() => (window as unknown as { __vev: unknown[] }).__vev);
    say(`TV video events: ${JSON.stringify(evs)}`);
  }
  void tapped;
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
