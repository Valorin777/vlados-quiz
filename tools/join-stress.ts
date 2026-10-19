// Join stress + phone lag audit on the DEV project (never prod), against a LOCAL build:
//
//   npx vite build --outDir /tmp/x && npm run join-stress -- /tmp/x [--label after] [--only perf,reload]
//   npm run build && npm run join-stress -- --set webkit15      15 fresh WebKit phones (see below)
//
// A Node Host (the DEV bot admin) opens a throwaway game `stress-<ts>` in the lobby. Each run is a
// fresh browser context (390×844, fake front camera = a canvas stream) that goes through the real
// join: name → «Включить камеру» → «Снять» → «Готово» → lobby. Scenarios: WebKit plain, WebKit and
// Chromium with a reload right after «Готово», Chromium on «Slow 3G» (CDP), a returning player
// reloading on «Slow 3G», and a perf run (Chromium, 4× CPU, «Slow 4G») that also measures the
// lobby and a question screen. Logged per run: the screens seen after submitting — any name/selfie
// form or error after «Готово» = the guest was asked twice — time to lobby, page reloads, console
// errors; perf: long tasks, event (input) latency, frame gaps, camera start, chunk load times.
// `--set webkit15`: 15 fresh WebKit (iPhone) phones, one after another: 11 on the plain network, one
// reloading right after «Готово», and 3 on a throttled network (Slow 4G, 3G, Slow 3G). WebKit has
// no network emulation, so those go through a local throttling proxy (every byte each way delayed
// by half the RTT and paced to the bandwidth — TCP/TLS handshakes pay the latency too) and load
// the app from an equally throttled static server. Pass = every phone reached the lobby on the
// first attempt: no name/selfie form and no error after «Готово».
// Everything it made is deleted afterwards (players, game, the pages' anonymous users).

import { defaultSettings } from '@shared/defaults';
import { FB_PROJECTS, type AdminContentDoc } from '@shared/fbtypes';
import type { ChoiceQ } from '@shared/types';
import { deleteApp, initializeApp } from 'firebase/app';
import { initializeAuth, inMemoryPersistence, signInWithEmailAndPassword } from 'firebase/auth';
import { collection, deleteDoc, getDocsFromServer, initializeFirestore, memoryLocalCache, setLogLevel, terminate } from 'firebase/firestore';
import { createReadStream, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { createGzip } from 'node:zlib';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, type Browser, type BrowserContext, type Page } from 'playwright';
import { ServerClock } from '../app/src/fb/clock';
import { fbRefs } from '../app/src/fb/refs';
import { Host } from '../app/src/host/driver';
import { ensureDevBotAdmin } from './dev-bot-admin.mjs';

const DEV = FB_PROJECTS.dev;
if (DEV.projectId !== 'vlados-2609-dev') throw new Error('join-stress runs against the DEV project only');
setLogLevel('silent');

const args = process.argv.slice(2);
const DIST = args[0] && !args[0].startsWith('--') ? args[0] : join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'app');
const opt = (k: string): string | undefined => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const LABEL = opt('label') ?? (opt('set') ?? 'run');
const ONLY = opt('only');
const SET = opt('set') ?? 'default';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'join-stress');
mkdirSync(OUT, { recursive: true });
const G = `stress-${Date.now()}`;
let PHOTO: Buffer | null = null;
const AUTH_KEY = `firebase:authUser:${DEV.apiKey}:[DEFAULT]`;
const t0 = Date.now();
const say = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ static server for the build

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain' };
function serve(dir: string, net?: Net): Promise<{ url: string; close: () => void }> {
  const srv = createServer((req, res) => {
    if (net) {
      // throttled: the request pays one RTT, the body is paced to the download bandwidth
      const out = pacedWriter(res, net.downloadThroughput, 0);
      setTimeout(() => serveFile(dir, req, res, out), net.latency);
      return;
    }
    serveFile(dir, req, res, null);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => {
    const a = srv.address();
    const port = typeof a === 'object' && a ? a.port : 0;
    r({ url: `http://localhost:${port}/`, close: () => srv.close() });
  }));
}

function serveFile(dir: string, req: IncomingMessage, res: ServerResponse, paced: Paced | null): void {
  // (a request relayed by a proxy may carry the absolute URL)
  const p = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  let f = join(dir, p === '/' ? 'index.html' : p);
  if (!f.startsWith(dir) || !existsSync(f) || statSync(f).isDirectory()) f = join(dir, 'index.html');
  const type = TYPES[extname(f)] ?? 'application/octet-stream';
  // gzip like GitHub Pages does (the throttled runs would otherwise measure 3× the bytes)
  const gz = /gzip/.test(String(req.headers['accept-encoding'] ?? '')) && /text|javascript|json|svg/.test(type);
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', ...(gz ? { 'content-encoding': 'gzip' } : {}) });
  const body = gz ? createReadStream(f).pipe(createGzip()) : createReadStream(f);
  if (!paced) body.pipe(res);
  else {
    body.on('data', (c: Buffer) => paced.write(c));
    body.on('end', () => paced.end());
  }
}

// ------------------------------------------------------------------ throttling proxy (WebKit)

type Net = { latency: number; downloadThroughput: number; uploadThroughput: number };
interface Paced {
  write: (c: Buffer) => void;
  end: () => void;
}
/** Writes chunks to `dst` as a slow link would: serialized at `bps` bytes/s, each `delayMs` late. */
function pacedWriter(dst: { write: (c: Buffer) => unknown; end: () => unknown; destroyed?: boolean }, bps: number, delayMs: number): Paced {
  let free = 0;
  let last = 0;
  const at = (bytes: number) => {
    const now = Date.now();
    free = Math.max(now, free) + (bytes / bps) * 1000;
    last = Math.max(last, free + delayMs);
    return last - now;
  };
  return {
    write: (c) => void setTimeout(() => !dst.destroyed && dst.write(c), at(c.length)),
    end: () => void setTimeout(() => !dst.destroyed && dst.end(), at(0) + 1),
  };
}
function pipePaced(src: Socket, dst: Socket, bps: number, delayMs: number): void {
  const w = pacedWriter(dst, bps, delayMs);
  src.on('data', (c: Buffer) => w.write(c));
  src.on('end', () => w.end());
  src.on('error', () => dst.destroy());
  src.on('close', () => setTimeout(() => dst.destroy(), delayMs + 5_000));
}
/**
 * An HTTP(S) proxy that behaves like a slow mobile link: CONNECT tunnels (all of Firebase) pay one
 * RTT to open, then every chunk each way is delayed by RTT/2 and paced to the bandwidth. Plain
 * HTTP (the local app server, which throttles itself) is passed through.
 */
interface ProxyStats {
  tunnels: number;
  hosts: Set<string>;
  up: number;
  down: number;
}
function throttleProxy(net: Net): Promise<{ server: string; close: () => void; stats: ProxyStats }> {
  const sockets = new Set<Socket>();
  const stats: ProxyStats = { tunnels: 0, hosts: new Set(), up: 0, down: 0 };
  const srv = createServer((req, res) => {
    const u = new URL(req.url ?? '/');
    const up = httpRequest({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method, headers: req.headers }, (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.pipe(res);
    });
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  srv.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    const [host, port] = (req.url ?? '').split(':');
    sockets.add(client);
    stats.tunnels++;
    stats.hosts.add(host ?? '?');
    client.on('data', (c: Buffer) => void (stats.up += c.length));
    const up = netConnect(Number(port) || 443, host ?? '', () => {
      setTimeout(() => {
        if (client.destroyed) return up.destroy();
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) up.write(head);
        pipePaced(client, up, net.uploadThroughput, net.latency / 2);
        pipePaced(up, client, net.downloadThroughput, net.latency / 2);
      }, net.latency);
    });
    sockets.add(up);
    up.on('data', (c: Buffer) => void (stats.down += c.length));
    up.on('error', () => client.destroy());
    client.on('error', () => up.destroy());
  });
  return new Promise((r) =>
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      r({
        server: `http://127.0.0.1:${port}`,
        stats,
        close: () => {
          for (const x of sockets) x.destroy();
          srv.close();
        },
      });
    }),
  );
}

// ------------------------------------------------------------------ in-page shims

const INIT = `(() => {
  globalThis.__name = globalThis.__name || ((f) => f);
  // Fake front camera: a canvas stream with a bit of noise (real sensors are noisy → bigger JPEGs).
  const md = navigator.mediaDevices || (Object.defineProperty(navigator, 'mediaDevices', { value: {}, configurable: true }), navigator.mediaDevices);
  md.getUserMedia = async () => {
    await new Promise((r) => setTimeout(r, 120));
    const c = document.createElement('canvas'); c.width = 640; c.height = 480;
    const g = c.getContext('2d'); let t = 0;
    const draw = () => {
      t++;
      const gr = g.createRadialGradient(320, 220, 20, 320, 240, 360);
      gr.addColorStop(0, 'hsl(' + (t * 3 % 360) + ',55%,70%)'); gr.addColorStop(1, '#223');
      g.fillStyle = gr; g.fillRect(0, 0, 640, 480);
      for (let k = 0; k < 900; k++) { g.fillStyle = 'rgba(' + (Math.random()*255|0) + ',' + (Math.random()*255|0) + ',' + (Math.random()*255|0) + ',.35)'; g.fillRect(Math.random()*640, Math.random()*480, 3, 3); }
      g.fillStyle = '#fff'; g.font = '700 90px sans-serif'; g.fillText(':)', 270, 270);
      setTimeout(draw, 66);
    };
    draw();
    return c.captureStream(15);
  };
  // Perf probes: long tasks + event timing (Chromium), frame gaps (both engines).
  const P = (window.__perf = { lt: [], ev: [], fi: null, gaps: [] });
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.lt.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask', buffered: true }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.ev.push([e.name, Math.round(e.startTime), Math.round(e.duration), Math.round(e.processingStart - e.startTime)]); }).observe({ type: 'event', buffered: true, durationThreshold: 16 }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.fi = [e.name, Math.round(e.processingStart - e.startTime)]; }).observe({ type: 'first-input', buffered: true }); } catch {}
  let last = 0;
  const raf = (t) => { if (last && t - last > 50 && document.visibilityState === 'visible') P.gaps.push([Math.round(last), Math.round(t - last)]); last = t; requestAnimationFrame(raf); };
  requestAnimationFrame(raf);
})();`;

const NET = {
  slow3g: { offline: false, latency: 2000, downloadThroughput: 50_000, uploadThroughput: 50_000 },
  reg3g: { offline: false, latency: 1000, downloadThroughput: 90_000, uploadThroughput: 45_000 },
  slow4g: { offline: false, latency: 562, downloadThroughput: 180_000, uploadThroughput: 84_375 },
} as const;

interface Scenario {
  name: string;
  engine: 'webkit' | 'chromium';
  net?: keyof typeof NET;
  cpu?: number;
  reloadAfterSubmit?: boolean;
  /** After joining: reload on this network and check the join form never shows again. */
  returning?: keyof typeof NET;
  perf?: boolean;
}

const SCENARIOS: Scenario[] = [
  ...Array.from({ length: 8 }, (_, k): Scenario => ({ name: `webkit-${k + 1}`, engine: 'webkit' })),
  { name: 'webkit-reload-1', engine: 'webkit', reloadAfterSubmit: true },
  { name: 'webkit-reload-2', engine: 'webkit', reloadAfterSubmit: true },
  { name: 'chromium-slow3g-1', engine: 'chromium', net: 'slow3g' },
  { name: 'chromium-slow3g-2', engine: 'chromium', net: 'slow3g' },
  { name: 'chromium-slow3g-reload', engine: 'chromium', net: 'slow3g', reloadAfterSubmit: true },
  { name: 'chromium-returning-slow3g', engine: 'chromium', returning: 'slow3g' },
  { name: 'perf-4xcpu-slow4g', engine: 'chromium', net: 'slow4g', cpu: 4, perf: true },
];

/** 15 fresh WebKit phones: plain, one reload right after «Готово», three throttled (proxy). */
const WEBKIT15: Scenario[] = [
  ...Array.from({ length: 4 }, (_, k): Scenario => ({ name: `webkit-${k + 1}`, engine: 'webkit' })),
  { name: 'webkit-slow4g', engine: 'webkit', net: 'slow4g' },
  ...Array.from({ length: 4 }, (_, k): Scenario => ({ name: `webkit-${k + 5}`, engine: 'webkit' })),
  { name: 'webkit-reload-after-submit', engine: 'webkit', reloadAfterSubmit: true },
  { name: 'webkit-3g', engine: 'webkit', net: 'reg3g' },
  ...Array.from({ length: 3 }, (_, k): Scenario => ({ name: `webkit-${k + 9}`, engine: 'webkit' })),
  { name: 'webkit-slow3g', engine: 'webkit', net: 'slow3g' },
];
const SETS: Record<string, Scenario[]> = { default: SCENARIOS, webkit15: WEBKIT15 };

interface RunLog {
  name: string;
  ok: boolean;
  askedAgain: boolean;
  error: string | null;
  msToJoinScreen: number | null;
  msSubmitToLobby: number | null;
  reloads: number;
  trail: string[];
  consoleErrors: string[];
  perf?: Record<string, unknown>;
  returning?: { sawJoinForm: boolean; msToLobby: number | null; trail: string[] };
}

/** What the phone shows right now, finer than data-screen for the join door. */
const stateOf = (p: Page): Promise<string> =>
  p
    .evaluate(() => {
      const pl = document.querySelector('.pl');
      if (!pl) return 'none';
      const s = pl.getAttribute('data-screen') ?? '?';
      if (s !== 'join') return s;
      if (document.querySelector('.pl-err')) return 'join:error';
      if (document.querySelector('.pl-confirm')) return 'join:confirm';
      if (document.querySelector('.pl-joining')) return 'join:joining';
      if (document.querySelector('.pl-selfie')) return 'join:selfie';
      if (document.querySelector('.pl-pre')) return 'join:pregame';
      if (document.querySelector('.pl-join')) return 'join:name';
      return 'join:?';
    })
    .catch(() => 'gone');

async function watchUntil(p: Page, done: (s: string) => boolean, ms: number, trail: string[]): Promise<string | null> {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < ms) {
    const s = await stateOf(p);
    if (s !== last) {
      trail.push(`${((Date.now() - start) / 1000).toFixed(1)}s ${s}`);
      last = s;
    }
    if (done(s)) return s;
    await sleep(100);
  }
  return null;
}

async function perfSnapshot(p: Page, from: number, to: number): Promise<{ longTasks: number; longMs: number; maxLong: number; gaps: number; maxGap: number }> {
  return p.evaluate(
    ([a, b]) => {
      const P = (window as unknown as { __perf: { lt: number[][]; gaps: number[][] } }).__perf;
      const lt = P.lt.filter(([s]) => s! >= a! && s! <= b!);
      const gaps = P.gaps.filter(([s]) => s! >= a! && s! <= b!);
      return {
        longTasks: lt.length,
        longMs: lt.reduce((x, [, d]) => x + d!, 0),
        maxLong: lt.reduce((x, [, d]) => Math.max(x, d!), 0),
        gaps: gaps.length,
        maxGap: gaps.reduce((x, [, d]) => Math.max(x, d!), 0),
      };
    },
    [from, to],
  );
}
const pnow = (p: Page): Promise<number> => p.evaluate(() => performance.now());

async function fillJoin(page: Page, name: string, log: RunLog, perf: Record<string, unknown> | null): Promise<number> {
  const early = page.getByRole('button', { name: 'Зарегистрируйся заранее' });
  if (await early.isVisible().catch(() => false)) await early.click();
  const input = page.locator('.pl-join input').first();
  await input.waitFor({ timeout: 30_000 });
  const tType = await pnow(page);
  await input.click();
  await input.pressSequentially(name, { delay: 70 });
  const tTyped = await pnow(page);
  await page.getByRole('button', { name: 'Дальше' }).click();
  await page.getByRole('button', { name: 'Включить камеру' }).waitFor({ timeout: 15_000 });
  const camMs = await page.evaluate(
    () =>
      new Promise<number>((res) => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.includes('Включить камеру')) as HTMLButtonElement;
        const t = performance.now();
        b.click();
        const iv = setInterval(() => {
          if (document.querySelector('.vx-vf.is-live, .vx-vf.is-nocam')) {
            clearInterval(iv);
            res(Math.round(performance.now() - t));
          }
        }, 5);
        setTimeout(() => res(-1), 15_000);
      }),
  );
  const tCam = await pnow(page);
  const nocam = /is-nocam/.test((await page.locator('.vx-vf').getAttribute('class')) ?? '');
  let tShot: number;
  if (nocam) {
    // WebKit headless cannot play a canvas stream: the «Выбрать фото» path with a phone-sized photo.
    log.trail.push('no camera → photo file');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Выбрать фото' }).click();
    const fc = await chooser;
    tShot = await pnow(page);
    await fc.setFiles({ name: 'IMG_0001.jpg', mimeType: 'image/jpeg', buffer: PHOTO! });
  } else {
    log.trail.push(`camera ${camMs} ms`);
    await sleep(600);
    await page.getByRole('button', { name: 'Снять' }).click({ timeout: 15_000 });
    tShot = await pnow(page);
  }
  await page.getByRole('button', { name: 'Готово' }).waitFor({ timeout: 15_000 });
  const shotMs = Math.round((await pnow(page)) - tShot);
  if (perf) {
    const ev = await page.evaluate(
      ([a, b]) => (window as unknown as { __perf: { ev: [string, number, number, number][] } }).__perf.ev.filter(([n, s]) => s >= a && s <= b && /key|input|pointer|click/.test(n)),
      [tType, tTyped] as [number, number],
    );
    perf.typing = {
      slowEvents: ev.length,
      maxEventMs: ev.reduce((x, e) => Math.max(x, e[2]), 0),
      maxInputDelayMs: ev.reduce((x, e) => Math.max(x, e[3]), 0),
      ...(await perfSnapshot(page, tType, tTyped)),
    };
    perf.cameraStartMs = camMs;
    perf.captureEncodeMs = shotMs;
    perf.selfieStep = await perfSnapshot(page, tCam, tShot + shotMs + 50);
  }
  log.trail.push(`capture+encode ${shotMs} ms`);
  const tSubmit = Date.now();
  await page.getByRole('button', { name: 'Готово' }).click();
  return tSubmit;
}

async function deleteOwnUser(page: Page): Promise<void> {
  await page
    .evaluate(
      async ([k, apiKey]) => {
        const u = JSON.parse(localStorage.getItem(k as string) ?? '{}') as { stsTokenManager?: { accessToken?: string } };
        const idToken = u.stsTokenManager?.accessToken;
        if (idToken) await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${apiKey}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken }) });
      },
      [AUTH_KEY, DEV.apiKey],
    )
    .catch(() => undefined);
}

async function runOne(sc: Scenario, k: number, browsers: { webkit: Browser; chromium: Browser }, base: string, host: Host): Promise<RunLog> {
  const log: RunLog = { name: sc.name, ok: false, askedAgain: false, error: null, msToJoinScreen: null, msSubmitToLobby: null, reloads: 0, trail: [], consoleErrors: [] };
  // WebKit on a slow network: a throttling proxy for Firebase + a throttled server for the app
  const thr = sc.engine === 'webkit' && sc.net ? { app: await serve(DIST, NET[sc.net]), proxy: await throttleProxy(NET[sc.net]) } : null;
  if (thr) base = thr.app.url;
  const ctx: BrowserContext = await browsers[sc.engine].newContext({
    ...(thr ? { proxy: { server: thr.proxy.server } } : {}),
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    ...(sc.engine === 'webkit' ? { isMobile: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' } : {}),
    hasTouch: true,
    colorScheme: k % 2 ? 'dark' : 'light',
  });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Could not reach Cloud Firestore backend|net::ERR|WebChannelConnection/.test(m.text())) log.consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => {
    // WebKit reports the Firestore channel requests a reload aborts as page errors.
    if (!/firestore\.googleapis\.com/.test(e.message)) log.consoleErrors.push(`pageerror: ${e.message.slice(0, 200)}`);
  });
  let navs = 0;
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) navs++;
  });
  const cdp = sc.engine === 'chromium' ? await ctx.newCDPSession(page) : null;
  const setNet = async (n: keyof typeof NET | undefined) => {
    if (!cdp) return;
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', n ? NET[n] : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  };
  if (cdp) {
    await setNet(sc.net);
    if (sc.cpu) await cdp.send('Emulation.setCPUThrottlingRate', { rate: sc.cpu });
  }
  const perf: Record<string, unknown> | null = sc.perf ? {} : null;
  const name = `Гость${k + 1}`;
  try {
    const tNav = Date.now();
    await page.goto(`${base}?env=dev&game=${G}#/`, { timeout: 120_000 });
    const first = await watchUntil(page, (s) => s.startsWith('join'), 120_000, log.trail);
    if (!first) throw new Error('join screen never showed');
    log.msToJoinScreen = Date.now() - tNav;
    if (sc.net) {
      // Where the first-load time went: every request (start → end, ms since navigation).
      log.trail.push(
        'requests: ' +
          (await page.evaluate(() =>
            (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
              .map((r) => {
                const u = new URL(r.name);
                const n = u.hostname === location.hostname ? u.pathname.split('/').pop() : `${u.hostname.split('.')[0]}${u.pathname.replace(/.*\/(Listen|Write)\/channel.*/, '/$1').replace(/^\/v1\/accounts:/, ':').slice(0, 30)}${u.searchParams.get('TYPE') ? `?${u.searchParams.get('TYPE')}` : ''}`;
                return `${n} ${Math.round(r.startTime)}→${Math.round(r.responseEnd)}`;
              })
              .join(', '),
          )),
      );
    }
    if (perf) {
      perf.msToJoinScreen = log.msToJoinScreen;
      perf.firstLoad = await page.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
        const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
        const pick = (re: RegExp) => res.filter((r) => re.test(r.name)).map((r) => ({ f: r.name.split('/').pop(), start: Math.round(r.startTime), ms: Math.round(r.responseEnd - r.startTime), kb: Math.round(r.encodedBodySize / 1024) }));
        return { domContentLoaded: Math.round(nav?.domContentLoadedEventEnd ?? 0), chunks: [...pick(/assets\/(index|live|clock|views|player|engine)-/)] };
      });
      perf.loadToJoin = await perfSnapshot(page, 0, await pnow(page));
    }
    const tSubmit = await fillJoin(page, name, log, perf);
    log.trail.push('— submitted —');
    if (sc.reloadAfterSubmit) {
      await sleep(250);
      await page.reload({ timeout: 120_000 });
      log.trail.push('— reloaded —');
    }
    const end = await watchUntil(page, (s) => s === 'lobby' || s === 'join:name' || s === 'join:selfie' || s === 'join:error' || s === 'join:pregame', 90_000, log.trail);
    if (end === 'lobby') {
      log.ok = true;
      log.msSubmitToLobby = Date.now() - tSubmit;
    } else {
      log.askedAgain = end !== null;
      log.error = end ?? 'timeout';
      if (end === 'join:error') log.error += `: ${await page.locator('.pl-err').textContent().catch(() => '')}`;
    }
    if (log.ok && perf) {
      const a = await pnow(page);
      await sleep(5_000);
      perf.lobby5s = await perfSnapshot(page, a, await pnow(page));
      // A question: start the game from the Node host, measure the question screen + a tap.
      const r = await host.command({ type: 'start' });
      if (!r.ok) throw new Error(`start: ${JSON.stringify(r)}`);
      await watchUntil(page, (s) => s === 'question', 60_000, log.trail);
      const q0 = await pnow(page);
      await sleep(3_000);
      const tile = page.locator('.pl-screen .vx-opt:not([disabled])').first();
      const prof = process.env.PROFILE_Q && cdp ? cdp : null;
      if (prof) {
        await prof.send('Profiler.enable');
        await prof.send('Profiler.setSamplingInterval', { interval: 250 });
        await prof.send('Profiler.start');
      }
      const tapMs = await tile
        .evaluate(
          (b) =>
            new Promise<number>((res) => {
              const t = performance.now();
              (b as HTMLButtonElement).click();
              const iv = setInterval(() => {
                if (document.querySelector('.pl')?.getAttribute('data-screen') === 'answered' || document.querySelector('.vx-opt:not(.is-idle)')) {
                  clearInterval(iv);
                  res(Math.round(performance.now() - t));
                }
              }, 5);
              setTimeout(() => res(-1), 10_000);
            }),
        )
        .catch(() => -2);
      if (prof) {
        await sleep(600);
        const { profile } = (await prof.send('Profiler.stop')) as { profile: { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[]; samples: number[]; timeDeltas: number[] } };
        const byId = new Map(profile.nodes.map((n) => [n.id, n]));
        const self = new Map<string, number>();
        profile.samples.forEach((id, i) => {
          const n = byId.get(id)!;
          const k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`;
          self.set(k, (self.get(k) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
        });
        say('question tap profile: ' + [...self.entries()].filter(([k]) => !/^\((idle|program)\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${v.toFixed(1)} ${k}`).join(' | '));
      }
      await sleep(2_000);
      perf.question = { ...(await perfSnapshot(page, q0, await pnow(page))), tapToFeedbackMs: tapMs };
      perf.firstInput = await page.evaluate(() => (window as unknown as { __perf: { fi: unknown } }).__perf.fi);
      perf.whole = await perfSnapshot(page, 0, await pnow(page));
    }
    if (log.ok && sc.returning) {
      await setNet(sc.returning);
      const trail: string[] = [];
      const tr = Date.now();
      await page.reload({ timeout: 120_000 });
      const end2 = await watchUntil(page, (s) => s === 'lobby' || s.startsWith('join'), 120_000, trail);
      log.returning = { sawJoinForm: end2 !== null && end2 !== 'lobby', msToLobby: end2 === 'lobby' ? Date.now() - tr : null, trail };
      if (end2 !== 'lobby') log.askedAgain = true;
      await setNet(undefined);
    }
  } catch (e) {
    log.error = e instanceof Error ? e.message.split('\n')[0]! : String(e);
  } finally {
    log.reloads = Math.max(0, navs - 1 - (sc.reloadAfterSubmit ? 1 : 0) - (log.returning ? 1 : 0));
    if (perf) log.perf = perf;
    if (cdp) await setNet(undefined).catch(() => undefined);
    await deleteOwnUser(page);
    await ctx.close().catch(() => undefined);
    if (thr) {
      const st = thr.proxy.stats;
      log.trail.push(`throttled proxy: ${st.tunnels} TLS tunnels to ${[...st.hosts].join(', ')}; ${(st.up / 1024).toFixed(0)} KB up, ${(st.down / 1024).toFixed(0)} KB down`);
    }
    thr?.app.close();
    thr?.proxy.close();
  }
  return log;
}

async function main(): Promise<void> {
  const srv = await serve(DIST);
  say(`serving ${DIST} at ${srv.url}; game ${G} on DEV`);
  const bot = await ensureDevBotAdmin();
  const app = initializeApp(DEV, `stress-admin-${Date.now()}`);
  const auth = initializeAuth(app, { persistence: inMemoryPersistence });
  await signInWithEmailAndPassword(auth, bot.email, bot.password);
  const db = initializeFirestore(app, { localCache: memoryLocalCache(), ignoreUndefinedProperties: true });
  const refs = fbRefs(db);
  const Q: ChoiceQ = { id: 's1', type: 'choice', title: 'Какого цвета небо?', options: [{ id: 'a', text: 'Синее' }, { id: 'b', text: 'Зелёное' }, { id: 'c', text: 'В клетку' }, { id: 'd', text: 'Не видно' }], correctId: 'a', timeLimitS: 30, double: false };
  const content: AdminContentDoc = { rev: 1, settings: { ...defaultSettings(), gameStartsAt: new Date(Date.now() - 3_600_000).toISOString(), introMs: 1_500 }, questions: [Q], trash: [] };
  const host = new Host({ db, uid: auth.currentUser?.uid ?? '', clock: new ServerClock(), preferred: true, label: 'stress', content, followCurrent: false, reactions: false });
  await host.start(G);
  for (let i = 0; i < 200 && host.snapshot().game?.phase !== 'lobby'; i++) await sleep(100);
  say(`host up: ${host.snapshot().game?.phase}`);
  const browsers = { webkit: await webkit.launch(), chromium: await chromium.launch() };
  {
    // A phone-camera-sized photo (3024×4032, noisy) for the file path.
    const pg = await browsers.chromium.newPage();
    const b64 = await pg.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 3024;
      c.height = 4032;
      const g = c.getContext('2d') as CanvasRenderingContext2D;
      const gr = g.createLinearGradient(0, 0, 3024, 4032);
      gr.addColorStop(0, '#d9a07a');
      gr.addColorStop(1, '#2a3550');
      g.fillStyle = gr;
      g.fillRect(0, 0, 3024, 4032);
      for (let k = 0; k < 60_000; k++) {
        g.fillStyle = `rgba(${(Math.random() * 255) | 0},${(Math.random() * 255) | 0},${(Math.random() * 255) | 0},.3)`;
        g.fillRect(Math.random() * 3024, Math.random() * 4032, 8, 8);
      }
      const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b as Blob), 'image/jpeg', 0.9));
      const u = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
      return btoa(s);
    });
    PHOTO = Buffer.from(b64, 'base64');
    await pg.close();
    say(`test photo ${(PHOTO.length / 1e6).toFixed(1)} MB`);
  }
  const logs: RunLog[] = [];
  try {
    const set = SETS[SET];
    if (!set) throw new Error(`unknown --set ${SET} (${Object.keys(SETS).join(', ')})`);
    const list = set.filter((s) => !ONLY || ONLY.split(',').some((o) => s.name.includes(o)));
    for (const [k, sc] of list.entries()) {
      const r = await runOne(sc, k, browsers, srv.url, host);
      logs.push(r);
      say(`${r.ok ? 'ok  ' : 'FAIL'} ${sc.name}: join screen ${r.msToJoinScreen ?? '-'} ms, submit→lobby ${r.msSubmitToLobby ?? '-'} ms, reloads ${r.reloads}${r.askedAgain ? ', ASKED AGAIN' : ''}${r.error ? `, ${r.error}` : ''}${r.returning ? `, returning: ${r.returning.sawJoinForm ? 'JOIN FORM AGAIN' : `lobby in ${r.returning.msToLobby} ms`}` : ''}`);
      if (!r.ok || r.askedAgain || r.reloads || sc.net) say(`     trail: ${r.trail.join(' | ')}${r.returning ? ` || returning: ${r.returning.trail.join(' | ')}` : ''}`);
      if (r.consoleErrors.length) say(`     console: ${[...new Set(r.consoleErrors)].slice(0, 5).join(' | ')}`);
      if (r.perf) say(`     perf: ${JSON.stringify(r.perf)}`);
    }
  } finally {
    await browsers.webkit.close().catch(() => undefined);
    await browsers.chromium.close().catch(() => undefined);
    await host.stop().catch(() => undefined);
    for (const col of [refs.answers(G), refs.reactions(G), refs.players(G), collection(db, `games/${G}/private`)]) {
      const snap = await getDocsFromServer(col).catch(() => null);
      await Promise.all((snap?.docs ?? []).map((d) => deleteDoc(d.ref)));
    }
    await deleteDoc(refs.game(G)).catch(() => undefined);
    await deleteDoc(refs.clockProbe(auth.currentUser?.uid ?? '')).catch(() => undefined);
    await terminate(db).catch(() => undefined);
    await deleteApp(app).catch(() => undefined);
    srv.close();
    const summary = {
      label: LABEL,
      runs: logs.length,
      ok: logs.filter((l) => l.ok).length,
      firstAttempt: logs.filter((l) => l.ok && !l.askedAgain).length,
      throttled: logs.filter((l) => /slow|3g|4g/.test(l.name)).map((l) => `${l.name}:${l.ok && !l.askedAgain ? `ok ${((l.msSubmitToLobby ?? 0) / 1000).toFixed(1)} s` : 'FAIL'}`),
      askedAgain: logs.filter((l) => l.askedAgain).map((l) => l.name),
      reloads: logs.filter((l) => l.reloads).map((l) => `${l.name}:${l.reloads}`),
    };
    writeFileSync(join(OUT, `${LABEL}.json`), JSON.stringify({ summary, logs }, null, 2));
    say(`SUMMARY ${JSON.stringify(summary)}  (cleaned up games/${G})`);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
