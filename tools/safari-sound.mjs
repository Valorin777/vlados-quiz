// The TV's sound under Safari's autoplay rules, in WebKit, on the DEV demo (no Firebase):
//   npm run dev:app, then  node tools/safari-sound.mjs   (BASE=http://127.0.0.1:5173/ default,
//   SHOTS=<dir> saves screenshots of the start button and the «Нажми, чтобы включить звук» prompt)
//
// WebKit + an emulation of Safari's autoplay policy («Stop Media with Sound», the macOS default):
//   - a <video>/<audio> may play() with sound only if play() was once called on THAT element
//     inside a user gesture (click / key / mouse); muted play is always allowed
//   - unmuting a playing, never-blessed element outside a gesture pauses it
//   - an AudioContext created outside a gesture stays suspended; resume() outside a gesture does
//     nothing (pending) until one resume() ran inside a gesture
// Playwright's WebKit does not enforce any of this by itself (checked: play() with sound works
// without a gesture), so the page gets it as an init script.
import { webkit } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173/';
const SHOTS = process.env.SHOTS ?? null;
const shot = (page, name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : Promise.resolve());

const SAFARI_RULES = () => {
  let gesture = false;
  const GESTURES = ['mousedown', 'mouseup', 'click', 'keydown', 'keyup', 'pointerdown', 'pointerup', 'touchend'];
  // a real input event is a gesture for the rest of its task (WebKit: the whole dispatch)
  for (const t of GESTURES)
    addEventListener(
      t,
      (e) => {
        if (!e.isTrusted) return;
        gesture = true;
        setTimeout(() => (gesture = false), 0);
      },
      true,
    );
  const log = [];
  const A = (window.__autoplay = { refused: 0, unmutePaused: 0, ctxRefused: 0, log, inGesture: () => gesture });
  const blessed = new WeakSet();
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    if (gesture) blessed.add(this);
    if (!this.muted && this.volume > 0 && !blessed.has(this)) {
      A.refused++;
      log.push(`refused play() with sound: ${this.currentSrc.slice(0, 60)}`);
      return Promise.reject(new DOMException('The request is not allowed by the user agent or the platform in the current context', 'NotAllowedError'));
    }
    return play.call(this);
  };
  const md = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted');
  Object.defineProperty(HTMLMediaElement.prototype, 'muted', {
    configurable: true,
    get() {
      return md.get.call(this);
    },
    set(m) {
      if (!m && gesture) blessed.add(this);
      md.set.call(this, m);
      if (!m && !blessed.has(this) && !this.paused && this.volume > 0) {
        A.unmutePaused++;
        log.push('unmuted outside a gesture → paused');
        this.pause();
      }
    },
  });
  A.unbless = (el) => blessed.delete(el);
  const C = window.AudioContext;
  const resume = C.prototype.resume;
  const suspend = C.prototype.suspend;
  const ctxs = (A.ctxs = []);
  const okCtx = new WeakSet();
  window.AudioContext = class extends C {
    constructor(...a) {
      super(...a);
      ctxs.push(this);
      if (gesture) okCtx.add(this);
      else void suspend.call(this);
    }
  };
  C.prototype.resume = function () {
    if (gesture) okCtx.add(this);
    if (!okCtx.has(this)) {
      A.ctxRefused++;
      log.push('AudioContext.resume() outside a gesture: stays suspended');
      return new Promise(() => undefined);
    }
    return resume.call(this);
  };
  // Safari took the sound away (an interruption): suspended, and only a gesture brings it back
  A.revokeAudio = () => ctxs.forEach((c) => { okCtx.delete(c); if (c.state !== 'closed') suspend.call(c).catch(() => undefined); });
  // a tab switch: hidden → visible
  let hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  A.setHidden = (h) => {
    hidden = h;
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event(h ? 'blur' : 'focus'));
  };
};

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = (page, sel) =>
  page.evaluate((sel) => {
    const s = window.__tvSound?.() ?? null;
    const v = [...document.querySelectorAll(sel)][0] ?? null;
    return {
      ctx: s?.ctx ?? null,
      mode: s?.mode ?? null,
      blocked: s?.blocked ?? null,
      log: s?.log ?? [],
      ask: !!document.querySelector('.tv-sound-ask'),
      ap: { refused: window.__autoplay.refused, unmutePaused: window.__autoplay.unmutePaused, ctxRefused: window.__autoplay.ctxRefused, log: window.__autoplay.log.slice(-6) },
      v: v ? { src: v.currentSrc.slice(-24), paused: v.paused, muted: v.muted, volume: v.volume, t: v.currentTime, ended: v.ended } : null,
    };
  }, sel);

async function waitPlaying(page, sel, ms) {
  const t0 = Date.now();
  for (;;) {
    const s = await state(page, sel);
    if (s.v && !s.v.paused && s.v.t > 0.3) return s;
    if (Date.now() - t0 > ms) return s;
    await sleep(250);
  }
}

const browser = await webkit.launch();

async function scene(name, sel, waitMs, extraQ = '') {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(SAFARI_RULES);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  pageerror: ${e.message}`));
  await page.goto(`${BASE}?env=dev&demo=${name}&gate=1${extraQ}#/tv`);
  await page.waitForSelector('text=Смотреть со звуком', { timeout: 20_000 });
  const pre = await state(page, sel);
  ok(`${name}: the gate is up, no sound engine before the click`, pre.ctx === 'none' && pre.v === null, JSON.stringify({ ctx: pre.ctx }));
  if (name === 'surprise') await shot(page, `gate-${name}`);
  await page.click('text=Смотреть со звуком');
  await sleep(600);
  const s0 = await state(page, sel);
  ok(`${name}: AudioContext running after the click`, s0.ctx === 'running', `ctx=${s0.ctx}`);
  if (name === 'surprise') {
    // the blessing's silence is stopped, never played to its end (a scene's 'ended' would hear it)
    const m = await page.evaluate(() => window.__tvSound().media.find((x) => x.src.startsWith('blob:')) ?? null);
    ok('the blessing: the one <video> played silence unmuted in the click, then paused (not ended)', m && m.paused && !m.muted && m.volume > 0 && m.t < 1, JSON.stringify(m));
  }
  const s = await waitPlaying(page, sel, waitMs);
  ok(`${name}: the video plays with sound (muted=false, volume>0), no refusal`, s.v && !s.v.paused && !s.v.muted && s.v.volume > 0 && s.ap.refused === 0 && !s.blocked && !s.ask, JSON.stringify({ v: s.v, refused: s.ap.refused, blocked: s.blocked, ask: s.ask }));
  ok(`${name}: AudioContext still running during the video`, s.ctx === 'running', `ctx=${s.ctx}`);
  return { ctx, page };
}

// 1. the organizer's case: the «Сюрприз» demo
{
  const { ctx, page } = await scene('surprise', '.tsu-host video', 25_000, '&vms=40000');
  await shot(page, 'surprise-playing');
  // 2. the tab switch: hidden (the organizer plays a clip in another tab), then back
  await page.evaluate(() => window.__autoplay.setHidden(true));
  await sleep(700);
  const h = await state(page, '.tsu-host video');
  ok('tab hidden: our context suspended (as designed)', h.ctx === 'suspended', `ctx=${h.ctx}`);
  await page.evaluate(() => window.__autoplay.setHidden(false));
  await sleep(700);
  const b = await state(page, '.tsu-host video');
  ok('tab back: AudioContext running again without a click, video still with sound', b.ctx === 'running' && b.v && !b.v.paused && !b.v.muted, JSON.stringify({ ctx: b.ctx, v: b.v }));
  // 3. Safari takes the WebAudio sound away (an interruption) → the prompt → one click
  await page.evaluate(() => window.__autoplay.revokeAudio());
  await sleep(4_200);
  const r = await state(page, '.tsu-host video');
  ok('interrupted context that does not come back: the TV shows «Нажми, чтобы включить звук»', r.ask && r.ctx !== 'running', JSON.stringify({ ask: r.ask, ctx: r.ctx, log: r.log.slice(-1) }));
  await shot(page, 'sound-ask-ctx');
  await page.mouse.click(640, 200);
  await sleep(800);
  const f = await state(page, '.tsu-host video');
  ok('one click anywhere: AudioContext running, prompt gone, video still with sound', f.ctx === 'running' && !f.ask && f.v && !f.v.paused && !f.v.muted, JSON.stringify({ ctx: f.ctx, ask: f.ask, v: f.v }));
  await ctx.close();
}

// 4. the other video moments behind the same gate: question video, reveal video, finale video
await (await scene('watch', '.tv-video-host video', 25_000)).ctx.close();
await (await scene('reveal-video', '.tv-video-host video', 25_000)).ctx.close();
await (await scene('final-6', '.tfv-host video', 20_000)).ctx.close();

// 5. what the organizer had before: no start button (`&gate=0`, the old demo: the first click only
//    unlocks the synth) → Safari refuses the video's sound → now: muted + the prompt, not silent
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(SAFARI_RULES);
  const page = await ctx.newPage();
  await page.goto(`${BASE}?env=dev&demo=surprise&gate=0&vms=40000#/tv`);
  await sleep(1_500);
  await page.mouse.click(640, 360);
  await waitPlaying(page, '.tsu-host video', 25_000);
  await sleep(500);
  const s2 = await state(page, '.tsu-host video');
  ok('without the gate: Safari refuses the sound (the organizer\'s bug reproduced)', s2.ap.refused > 0, JSON.stringify(s2.ap));
  ok('…and the TV does not stay silently muted: «Нажми, чтобы включить звук» is up', s2.ask && s2.blocked && s2.v && s2.v.muted, JSON.stringify({ ask: s2.ask, blocked: s2.blocked, v: s2.v, log: s2.log }));
  await shot(page, 'sound-ask-video');
  await page.mouse.click(640, 600);
  await sleep(800);
  const s3 = await state(page, '.tsu-host video');
  ok('one click: the same video plays on WITH sound, prompt gone', s3.v && !s3.v.paused && !s3.v.muted && s3.v.volume > 0 && !s3.ask && !s3.blocked, JSON.stringify({ ask: s3.ask, v: s3.v }));
  await ctx.close();
}

// 6. «Без звука»: runs muted, no prompt, no sound engine
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(SAFARI_RULES);
  const page = await ctx.newPage();
  await page.goto(`${BASE}?env=dev&demo=final-6&gate=1#/tv`);
  await page.waitForSelector('text=Без звука', { timeout: 20_000 });
  await page.click('text=Без звука');
  const s = await waitPlaying(page, '.tfv-host video', 20_000);
  ok('«Без звука»: the video plays muted, no prompt, no refusal', s.v && !s.v.paused && s.v.muted && !s.ask && s.ap.refused === 0, JSON.stringify({ v: s.v, ask: s.ask, ctx: s.ctx }));
  await ctx.close();
}

// 7. automation (WebDriver) without `&gate=`: no button, the scene as before (tools/hold-dev.ts)
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}?env=dev&demo=hold-long#/tv`);
  const hold = await page.waitForSelector('.tv-hold', { timeout: 20_000 }).then(() => true, () => false);
  const gate = await page.$('text=Смотреть со звуком');
  ok('automation without &gate: no start button, the scene renders as before', hold && !gate);
  await ctx.close();
}

await browser.close();
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} OK`);
process.exit(bad.length ? 1 : 0);
