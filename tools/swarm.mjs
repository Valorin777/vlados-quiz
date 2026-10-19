#!/usr/bin/env node
// DEV ONLY — load + resilience run: N anonymous bot players (each its own Firebase app instance =
// own auth session + own Firestore connection) play the 6 template questions (shared/defaults.ts
// seedContent, short timers) against an in-process Host signed in as the DEV bot admin, in an
// isolated game `swarm-<ts>` (config/current and admin/content are not touched). Deletes the game
// and the bots' anonymous users afterwards.
//
//   npm run swarm -- [--bots 40] [--time 10] [--chaos] [--seed 1] [--keep]
//
// Bots join with ~12 KB selfies, answer all 3 question types after random delays (60 % correct,
// 10 % silent), throw reactions; one bot is Vlados. --chaos: 30 % of the bots drop the network
// (disableNetwork → enableNetwork, 1.5–5 s) at a random moment of every question, and one bot per
// question stays offline for ~12 s across the lock and the reveal.
//
// Checks: every reveal.me pts == shared/scoring recomputed from the stored server times (answer.at
// − openAt), tot == running sum, ranks == compareStandings, Vlados unranked and off the board and
// podium, the phones' own reveal lines equal the host's; nothing about the correct answer in the
// public doc before the reveal; rate limits (reactions, player-doc edits, double answers) and read
// denials hold; every bot reaches every phase (lag) and the final.
// Usage: every Firestore read/write is metered (tools/lib/fsmeter.mjs) per client kind and phase,
// then extrapolated to a real party (95 guests × 15 questions, 60 s timers) against the Spark
// budget of docs/firebase.md (≤ 25k reads, ≤ 6k writes per game = 2× margin to the daily limits).

import { register } from 'node:module';

register('./lib/fsmeter-hooks.mjs', import.meta.url);

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : def;
};
const N = opt('bots', 40);
const T = opt('time', 10);
const CHAOS = flag('chaos');
const KEEP = flag('keep');
let seed = opt('seed', Date.now() % 100_000) >>> 0 || 1;

const { meter } = await import('./lib/fsmeter.mjs');
const fs = await import('firebase/firestore');
const { deleteApp, initializeApp } = await import('firebase/app');
const { deleteUser, inMemoryPersistence, initializeAuth, signInAnonymously, signInWithEmailAndPassword } = await import('firebase/auth');
const { FB_PROJECTS, reactionBucket } = await import('../shared/fbtypes.ts');
const { seedContent } = await import('../shared/defaults.ts');
const { scoreRound } = await import('../shared/scoring.ts');
const { compareStandings } = await import('../shared/engine/results.ts');
const { ServerClock } = await import('../app/src/fb/clock.ts');
const { fbRefs, newAnswerDoc, newReactionDoc } = await import('../app/src/fb/refs.ts');
const { totalsRef } = await import('../app/src/host/commands.ts');
const { Host } = await import('../app/src/host/driver.ts');
const { HOST_TIMING } = await import('../app/src/host/model.ts');
const { PlayerSession } = await import('../app/src/host/player.ts');
const pure = await import('../app/src/host/pure.ts');
const { answerFits, hostContent, stripUndefined } = pure;
const { ensureDevBotAdmin } = await import('./dev-bot-admin.mjs');

const DEV = FB_PROJECTS.dev;
if (DEV.projectId !== 'vlados-2609-dev') throw new Error('swarm runs against the DEV project only');
fs.setLogLevel('silent');

const G = `swarm-${Date.now()}`;
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
const say = (m) => console.log(`${ts()} ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (ok, what) => {
  if (!ok) fails.push(what);
  console.log(`${ts()} ${ok ? '  ok  ' : '  FAIL'} ${what}`);
};
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const pickOne = (xs) => xs[Math.floor(rnd() * xs.length)];
const codeOf = (e) => (e && typeof e === 'object' && 'code' in e ? String(e.code) : String(e));
async function until(what, fn, ms = 30_000, every = 100) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timeout (${ms} ms): ${what}`);
    await sleep(every);
  }
}
/** Resolves with the Firestore error code of a refused operation, or 'ok'. */
const outcome = (p) => p.then(() => 'ok', (e) => codeOf(e));

// ------------------------------------------------------------------ content (short timers)

const base = seedContent();
const CONTENT = stripUndefined({
  rev: 1,
  settings: {
    ...base.settings,
    introMs: 1_500,
    lockMs: 300,
    allAnsweredDelayMs: 300,
    autopilot: false,
    autoAdvance: { revealToBoardS: 3, boardToNextS: 2, finalStepS: 1 },
    reactions: true,
    lateJoin: true,
    maxPlayers: 150,
  },
  questions: base.questions.map((q) => ({ ...q, timeLimitS: T })),
  trash: [],
});
const SETTINGS = hostContent(CONTENT).settings;
const QBYID = new Map(CONTENT.questions.map((q) => [q.id, q]));

// ------------------------------------------------------------------ clients

const clients = [];
async function client(kind, signIn) {
  const app = initializeApp(DEV, `${kind}-${Math.random().toString(36).slice(2, 10)}`);
  const auth = initializeAuth(app, { persistence: inMemoryPersistence });
  await signIn(auth);
  const db = fs.initializeFirestore(app, { localCache: fs.memoryLocalCache(), ignoreUndefinedProperties: true });
  meter.label(db, kind);
  const c = { app, auth, db, uid: auth.currentUser?.uid ?? '', kind };
  clients.push(c);
  return c;
}

/** Fake JPEG bytes (the rules only check type and size). */
function jpegish(n) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (rnd() * 256) | 0;
  b.set([0xff, 0xd8, 0xff, 0xe0], 0);
  b.set([0xff, 0xd9], n - 2);
  return b;
}

// ------------------------------------------------------------------ bots

const NAMES = ['Владос', 'Соня', 'Макс', 'Артём', 'Катя', 'Лёша', 'Дима', 'Оля', 'Серёга', 'Настя', 'Паша', 'Юля', 'Вова', 'Лиза', 'Гоша', 'Маша', 'Костя', 'Аня', 'Миша', 'Женя', 'Даша', 'Рома', 'Вика', 'Никита', 'Полина', 'Тёма', 'Кира', 'Гриша', 'Алина', 'Стас', 'Ира', 'Егор', 'Лена', 'Боря', 'Вера', 'Федя', 'Ксюша', 'Тимур', 'Света', 'Илья'];
const ROUND_KEYS = new Set(['i', 'n', 'total', 'qid', 'type', 'title', 'media', 'double', 'timeLimitS', 'options', 'number', 'items', 'firstLabel', 'lastLabel', 'introAt', 'openAt', 'endsAt']);
const ITEM_KEYS = new Set(['id', 'text', 'mediaId']);
const NUMBER_KEYS = new Set(['min', 'max', 'step', 'unit']);

const bots = [];
const leaks = [];
/** Host-side first sighting (Date.now()) of each phaseRev, and the phase it had. */
const hostSeen = new Map();
const revealByRound = new Map();
const boardByRound = new Map();
let finalDoc = null;
const joinMs = { signIn: 0, start: 0, join: 0 };
const otherKeys = new Map();
const versions = { step: 0, count: 0, other: 0, perRound: new Map() };

function leakCheck(bot, g) {
  if (!['intro', 'open', 'locked'].includes(g.phase) || !g.round) return;
  const r = g.round;
  const bad = [];
  if (g.reveal) bad.push('reveal present');
  const json = JSON.stringify(g);
  if (/correctId|"answer"|"correct"|revealText|"notes"/.test(json)) bad.push('answer-like key in the doc');
  for (const k of Object.keys(r)) if (!ROUND_KEYS.has(k)) bad.push(`round.${k}`);
  for (const it of [...(r.options ?? []), ...(r.items ?? [])]) for (const k of Object.keys(it)) if (!ITEM_KEYS.has(k)) bad.push(`item.${k}`);
  for (const k of Object.keys(r.number ?? {})) if (!NUMBER_KEYS.has(k)) bad.push(`number.${k}`);
  const q = QBYID.get(r.qid);
  if (q?.type === 'ordering' && r.items?.map((x) => x.id).join() === q.items.map((x) => x.id).join()) bad.push('ordering shown in the correct order');
  if (bad.length) leaks.push(`${bot.name} ${g.phase} q${r.i}: ${bad.join(', ')}`);
}

/** The answer a bot gives: correct with probability 0.6. */
function payloadFor(q, round, correct) {
  if (q.type === 'choice') {
    const wrong = q.options.filter((o) => o.id !== q.correctId);
    return { t: 'choice', id: correct ? q.correctId : pickOne(wrong).id };
  }
  if (q.type === 'number') {
    if (correct) return { t: 'number', v: q.answer };
    let v = q.answer;
    while (Math.abs(v - q.answer) <= q.tolerance) v = q.min + Math.round(rnd() * (q.max - q.min));
    return { t: 'number', v };
  }
  const right = q.items.map((x) => x.id);
  if (correct) return { t: 'ordering', ids: right };
  const shown = (round.items ?? []).map((x) => x.id);
  return { t: 'ordering', ids: shown.join() !== right.join() ? shown : [...right].reverse() };
}

function planRound(bot, g) {
  const r = g.round;
  const q = QBYID.get(r.qid);
  const ms = r.timeLimitS * 1000;
  const plan = {
    i: r.i,
    silent: bot.k > 2 && rnd() < 0.1, // Vlados and the probe bots always answer
    correct: rnd() < 0.6,
    at: r.openAt + 400 + rnd() * ms * 0.8,
    react: rnd() < 0.35 ? r.openAt + rnd() * (ms + 4_000) : null,
    drop: null,
    done: false,
    reacted: false,
  };
  if (CHAOS && bot.k > 2) {
    if (bot.k === 3 + (r.i % Math.max(1, N - 3))) plan.drop = { from: r.openAt + ms * 0.5, to: r.openAt + ms * 0.5 + 12_000 };
    else if (rnd() < 0.3) {
      const from = r.openAt + rnd() * ms * 0.7;
      plan.drop = { from, to: from + 1_500 + rnd() * 3_500 };
    }
  }
  plan.q = q;
  plan.round = r;
  bot.plans.set(r.i, plan);
  return plan;
}

async function botTick(bot) {
  if (bot.busy || stopping) return;
  bot.busy = true;
  try {
    const s = bot.p.snapshot();
    const g = s.game;
    const now = bot.p.clock.now();
    // network chaos (any phase: the drop outlives the question on purpose)
    for (const plan of bot.plans.values()) {
      const d = plan.drop;
      if (!d || d.over) continue;
      if (!bot.offline && now >= d.from && now < d.to) {
        bot.offline = true;
        bot.drops++;
        await fs.disableNetwork(bot.c.db);
      } else if (bot.offline && now >= d.to) {
        d.over = true;
        bot.offline = false;
        await fs.enableNetwork(bot.c.db);
      }
    }
    if (!g?.round) return;
    const plan = bot.plans.get(g.round.i) ?? (['open', 'locked'].includes(g.phase) || g.phase === 'intro' ? planRound(bot, g) : null);
    if (!plan) return;
    if (plan.react !== null && !plan.reacted && now >= plan.react) {
      plan.reacted = true;
      const r = await bot.p.react(Math.floor(rnd() * 8));
      bot.reacts[r.ok ? 'ok' : r.error] = (bot.reacts[r.ok ? 'ok' : r.error] ?? 0) + 1;
    }
    if (plan.silent || plan.done || now < plan.at) return;
    const v = bot.p.view(now);
    if (v.screen !== 'question' || v.question?.i !== plan.i) {
      // not open on this phone (yet): keep trying until the window is over
      if (now > plan.round.endsAt + 3_000) plan.done = true;
      return;
    }
    plan.done = true;
    const p = payloadFor(plan.q, plan.round, plan.correct);
    const sentAt = Date.now();
    const offline = bot.offline;
    void bot.p.answer(plan.i, p).then((res) => {
      bot.answers.set(plan.i, { p, res, ms: Date.now() - sentAt, offline });
    });
  } catch (e) {
    bot.errors.push(String(e));
  } finally {
    bot.busy = false;
  }
}

let stopping = false;
let observer = null;
let prevObserved = null;

function watchBot(bot) {
  bot.p.subscribe((s) => {
    const g = s.game;
    if (!g || s.gameState !== 'live') return;
    if (!bot.seen.has(g.phaseRev)) bot.seen.set(g.phaseRev, Date.now());
    leakCheck(bot, g);
    if (g.phase === 'reveal' && g.reveal) {
      const v = bot.p.view();
      if (v.screen === 'reveal' && v.reveal) bot.reveals.set(v.reveal.i, { mine: v.reveal.mine, verdict: v.reveal.verdict });
    }
    if (bot === observer) {
      // every server version of games/{g} is one read for every phone: classify them
      const json = stable(g);
      if (prevObserved && json !== prevObserved.json) {
        const kind = g.phaseRev !== prevObserved.g.phaseRev ? 'step' : onlyCounts(prevObserved.g, g) ? 'count' : 'other';
        if (kind === 'other') for (const k of Object.keys(g)) if (stable(g[k]) !== stable(prevObserved.g[k])) otherKeys.set(`${g.phase}.${k}`, (otherKeys.get(`${g.phase}.${k}`) ?? 0) + 1);
        versions[kind]++;
        const i = g.round?.i ?? -1;
        const pr = versions.perRound.get(i) ?? { step: 0, count: 0, other: 0 };
        pr[kind]++;
        versions.perRound.set(i, pr);
      }
      prevObserved = { g, json };
    }
  });
}

/** JSON with sorted keys: the server does not keep map-field order between two sends of a doc. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object' && !(v instanceof Uint8Array)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

function onlyCounts(a, b) {
  const strip = (x) => stable({ ...x, answered: 0, players: 0 });
  return strip(a) === strip(b);
}

// ------------------------------------------------------------------ main

let admin;
let host;
const hostLog = [];

async function main() {
  say(`swarm on DEV: game ${G}, ${N} bots, ${T} s timers${CHAOS ? ', chaos' : ''}, seed ${seed}`);
  meter.phase = 'join';
  const botAdmin = await ensureDevBotAdmin();
  admin = await client('host', (a) => signInWithEmailAndPassword(a, botAdmin.email, botAdmin.password));
  host = new Host({ db: admin.db, uid: admin.uid, content: CONTENT, followCurrent: false, preferred: true, label: 'tv', clock: new ServerClock(), log: (m) => hostLog.push(`${ts()} ${m}`) });
  await host.start(G);
  await host.whenReady();
  check(await until('game doc', () => host.snapshot().game?.phase === 'lobby', 15_000).catch(() => false), 'host created the game in the lobby');
  host.subscribe((s) => {
    const g = s.game;
    if (!g || s.health.listeners.game !== 'live') return;
    if (!hostSeen.has(g.phaseRev)) {
      hostSeen.set(g.phaseRev, { at: Date.now(), phase: g.phase, i: g.round?.i ?? null });
    }
    if (g.phase === 'reveal' && g.reveal) revealByRound.set(g.reveal.i, structuredClone(g.reveal));
    if (g.phase === 'board' && g.board && g.round) boardByRound.set(g.round.i, structuredClone(g.board));
    if (g.phase === 'final' && g.final && g.final.step >= (finalDoc?.step ?? -1)) finalDoc = structuredClone(g.final);
  });

  // sign-ups in small waves (Firebase Auth throttles anonymous sign-ups per IP)
  const tJoin = Date.now();
  for (let k = 0; k < N; k += 8) {
    await Promise.all(
      Array.from({ length: Math.min(8, N - k) }, async (_, j) => {
        const n = k + j;
        const tb = Date.now();
        const c = await client('bot', (a) => signInAnonymously(a));
        joinMs.signIn += Date.now() - tb;
        const p = new PlayerSession({ db: c.db, uid: c.uid, clock: new ServerClock(), gameId: G, timeoutMs: 15_000 });
        const bot = { k: n, name: NAMES[n % NAMES.length] + (n >= NAMES.length ? ` ${n}` : ''), c, p, uid: c.uid, seen: new Map(), reveals: new Map(), plans: new Map(), answers: new Map(), reacts: {}, errors: [], offline: false, drops: 0, busy: false };
        bots[n] = bot;
        const ts0 = Date.now();
        await p.start();
        await p.whenReady(30_000);
        joinMs.start += Date.now() - ts0;
        bot.watchFrom = Date.now();
        watchBot(bot);
        const tj = Date.now();
        const r = await p.join(bot.name, jpegish(11_500 + Math.floor(rnd() * 1_500)), jpegish(1_800));
        joinMs.join += Date.now() - tj;
        if (!r.ok) throw new Error(`${bot.name} could not join: ${r.error}`);
      }),
    );
  }
  observer = bots[2] ?? bots[0];
  say(`${N} bots joined in ${((Date.now() - tJoin) / 1000).toFixed(1)} s (per bot: sign-in ${Math.round(joinMs.signIn / N)} ms, first snapshot ${Math.round(joinMs.start / N)} ms, join ${Math.round(joinMs.join / N)} ms)`);
  await until('all players on the TV', () => host.tvView().players.length === N, 30_000);
  check(host.tvView().players.every((p) => (p.thumb?.length ?? 0) > 0), 'every player has a selfie thumb on the TV');
  const vlados = bots[0];
  check((await host.command({ type: 'setVlados', uid: vlados.uid })).ok, 'Vlados set');

  meter.phase = 'probe';
  await probes();

  meter.phase = 'game';
  const ticker = setInterval(() => bots.forEach((b) => void botTick(b)), 200);
  const tGame = Date.now();
  check((await host.command({ type: 'start' })).ok, 'game started');
  await until('final step 5 on the host', () => (host.snapshot().game?.final?.step ?? -1) >= 5, 60_000 + CONTENT.questions.length * (T * 1000 + 15_000));
  const finalRev = host.snapshot().game?.phaseRev ?? -1;
  const gameMs = Date.now() - tGame;
  say(`game over in ${(gameMs / 1000).toFixed(0)} s (phaseRev ${finalRev})`);
  // everyone back online, then every phone must reach the final
  for (const b of bots) if (b.offline) {
    b.offline = false;
    await fs.enableNetwork(b.c.db);
  }
  let stuck = [];
  try {
    await until('every phone at the final', () => bots.every((b) => b.p.view().screen === 'final' && b.p.view().phaseRev === finalRev), 20_000, 250);
  } catch {
    stuck = bots.filter((b) => !(b.p.view().screen === 'final' && b.p.view().phaseRev === finalRev)).map((b) => `${b.name}: ${b.p.view().screen}@${b.p.view().phaseRev}`);
  }
  check(stuck.length === 0, `every phone reached the final${stuck.length ? `: stuck ${stuck.join('; ')}` : ''}`);
  clearInterval(ticker);
  await sleep(1_000);

  meter.phase = 'verify';
  await verify(vlados.uid, finalRev);
  report(gameMs);
}

// ------------------------------------------------------------------ rate limits & read denials

async function probes() {
  const [, a, b] = bots;
  const g = G;
  const ra = fbRefs(a.c.db);
  // reactions: the client throttle, then raw writes around it
  check((await a.p.react(0)).ok, 'reaction accepted');
  const second = await a.p.react(1);
  check(!second.ok && second.error === 'throttled', 'second reaction within 3 s throttled on the phone');
  const cur = reactionBucket(a.p.clock.now());
  const r1 = await outcome(fs.setDoc(ra.reaction(g, a.uid, cur + 1), newReactionDoc(a.uid, 2)));
  const r2 = await outcome(fs.setDoc(ra.reaction(g, a.uid, cur + 1), newReactionDoc(a.uid, 3)));
  const r3 = await outcome(fs.setDoc(ra.reaction(g, a.uid, cur + 6), newReactionDoc(a.uid, 4)));
  check(r2 === 'permission-denied' && r3 === 'permission-denied', `raw reactions: same bucket again refused (${r1} → ${r2}), a bucket 18 s ahead refused (${r3})`);
  // owner edits of players/{uid}: at most one per 3 s
  const rb = fbRefs(b.c.db);
  await sleep(3_600);
  const e1 = await outcome(fs.updateDoc(rb.player(g, b.uid), { seenAt: fs.serverTimestamp() }));
  const e2 = await outcome(fs.updateDoc(rb.player(g, b.uid), { seenAt: fs.serverTimestamp() }));
  check(e1 === 'ok' && e2 === 'permission-denied', `player-doc edits spaced ≥ 3 s (first ${e1}, second right after: ${e2})`);
  const e3 = await outcome(fs.updateDoc(rb.player(g, b.uid), { name: 'x'.repeat(21), seenAt: fs.serverTimestamp() }));
  check(e3 === 'permission-denied', 'over-long name refused');
  check((await b.p.rename('Бот Переименован')).ok, 'rename through the session waits out the 3 s gap');
  check((await b.p.rename('Бот Два')).ok, 'second rename queued and accepted');
  // reads a guest must not get
  const denied = await Promise.all([
    outcome(fs.getDoc(ra.adminContent())),
    outcome(fs.getDoc(totalsRef(a.c.db, g))),
    outcome(fs.getDocs(ra.players(g))),
    outcome(fs.getDoc(ra.player(g, b.uid))),
    outcome(fs.getDocs(ra.reactions(g))),
    outcome(fs.getDocs(ra.answers(g))),
  ]);
  check(denied.every((d) => d === 'permission-denied'), `guest reads refused: admin/content, totals, players list, other player, reactions, answers (${denied.join(',')})`);
}

/** During the first open question: double answers, answers for others, future rounds. */
async function answerProbes(i) {
  const [, a, b] = bots;
  const ra = fbRefs(a.c.db);
  const d1 = await outcome(fs.setDoc(ra.answer(G, i, b.uid), newAnswerDoc(b.uid, i, { t: 'choice', id: 'x' })));
  const d2 = await outcome(fs.setDoc(ra.answer(G, i + 1, a.uid), newAnswerDoc(a.uid, i + 1, { t: 'choice', id: 'x' })));
  await until('probe bot answered', () => a.answers.get(i)?.res?.ok, 20_000);
  const d3 = await outcome(fs.setDoc(ra.answer(G, i, a.uid), newAnswerDoc(a.uid, i, { t: 'choice', id: 'x' })));
  check([d1, d2, d3].every((d) => d === 'permission-denied'), `answer for someone else / a future round / a second time refused (${d1},${d2},${d3})`);
}

// ------------------------------------------------------------------ verification

async function verify(vladosUid, finalRev) {
  const r = fbRefs(admin.db);
  const totals = (await fs.getDocFromServer(totalsRef(admin.db, G))).data();
  const answers = (await fs.getDocsFromServer(r.answers(G))).docs.map((d) => d.data());
  const players = Object.fromEntries((await fs.getDocsFromServer(r.players(G))).docs.map((d) => [d.id, d.data()]));
  const reactions = (await fs.getDocsFromServer(r.reactions(G))).docs.map((d) => d.data());
  const uids = Object.keys(players).filter((u) => !players[u].kicked);
  check(uids.length === N, `${N} players stored`);
  check(leaks.length === 0, `no answer leak in ${bots.reduce((n, b) => n + b.seen.size, 0)} public-doc versions before the reveals${leaks.length ? `: ${leaks.slice(0, 3).join(' | ')}` : ''}`);

  const scored = (totals?.rounds ?? []).filter((pr) => pr.res);
  check(scored.length === CONTENT.questions.length, `${scored.length}/${CONTENT.questions.length} rounds scored`);
  const acc = Object.fromEntries(uids.map((u) => [u, { score: 0, correct: 0, answered: 0, elapsedMs: 0 }]));
  let mism = [];
  let late = 0;
  let phoneChecked = 0;
  let phoneMism = [];
  const typeStats = {};
  for (const pr of scored) {
    const q = pr.q;
    const ms = q.timeLimitS * 1000;
    const rev = revealByRound.get(pr.i);
    if (!rev) {
      mism.push(`round ${pr.i}: reveal never seen by the host`);
      continue;
    }
    const got = answers.filter((a) => a.round === pr.i && players[a.uid] && !players[a.uid].kicked && answerFits(q, a.p));
    const counted = new Set(Object.keys(pr.res));
    const input = {};
    for (const a of got) {
      if (!counted.has(a.uid)) {
        late++;
        continue;
      }
      input[a.uid] = { p: a.p, elapsedMs: Math.round(Math.min(ms, Math.max(0, a.at - pr.openAt))) };
    }
    const res = scoreRound(q, input, vladosUid, SETTINGS.scoring);
    typeStats[q.type] = (typeStats[q.type] ?? 0) + Object.keys(input).length;
    for (const u of uids) {
      const pts = res[u]?.points ?? 0;
      const a = acc[u];
      a.score += pts;
      if (input[u]) {
        a.answered++;
        a.elapsedMs += input[u].elapsedMs;
        if (res[u].correct) a.correct++;
      } else a.elapsedMs += ms;
    }
    const ranked = uids
      .filter((u) => u !== vladosUid)
      .map((u) => ({ id: u, ...acc[u], joinedAt: players[u].joinedAt, accuracySum: 0, rank: null }))
      .sort(compareStandings);
    const rank = new Map(ranked.map((s, k) => [s.id, k + 1]));
    for (const u of uids) {
      const me = rev.me[u];
      const want = { pts: res[u]?.points ?? 0, tot: acc[u].score, rank: u === vladosUid ? null : rank.get(u) };
      if (!me || me.pts !== want.pts || me.tot !== want.tot || me.rank !== want.rank) mism.push(`q${pr.i} ${players[u].name}: host ${JSON.stringify(me && { pts: me.pts, tot: me.tot, rank: me.rank })} ≠ ${JSON.stringify(want)}`);
      const phone = bots.find((b) => b.uid === u)?.reveals.get(pr.i);
      if (phone) {
        phoneChecked++;
        if (!phone.mine || phone.mine.pts !== me?.pts || phone.mine.tot !== me?.tot || phone.mine.rank !== me?.rank) phoneMism.push(`q${pr.i} ${players[u].name}`);
      }
    }
    const board = boardByRound.get(pr.i);
    if (board) {
      const want = ranked.slice(0, board.top.length).map((s) => s.id);
      if (board.top.map((x) => x.uid).join() !== want.join()) mism.push(`q${pr.i}: board order differs`);
      if (board.top.some((x) => x.uid === vladosUid)) mism.push(`q${pr.i}: Vlados on the board`);
    }
    if (pr === scored[scored.length - 1] && finalDoc) {
      const podium = finalDoc.podium.map((x) => x.uid);
      if (podium.join() !== ranked.slice(0, podium.length).map((s) => s.id).join()) mism.push('final podium differs');
      if (podium.includes(vladosUid)) mism.push('Vlados on the podium');
      if (finalDoc.vlados?.uid !== vladosUid) mism.push('final.vlados is not Vlados');
      for (const u of uids) {
        const f = finalDoc.me?.[u];
        const want = { tot: acc[u].score, rank: u === vladosUid ? null : rank.get(u) };
        if (!f || f.tot !== want.tot || f.rank !== want.rank) mism.push(`final ${players[u].name}: ${JSON.stringify(f)} ≠ ${JSON.stringify(want)}`);
      }
    }
  }
  check(mism.length === 0, `reveal.me pts/tot/rank of ${uids.length} players × ${scored.length} rounds == shared/scoring from server times; board, podium, final.me agree; Vlados unranked${mism.length ? `\n        ${mism.slice(0, 8).join('\n        ')}` : ''}`);
  check(late === 0, `every stored answer counted in its reveal (${late} arrived after the reveal was computed)`);
  check(phoneMism.length === 0 && phoneChecked > 0, `${phoneChecked} reveal lines shown on phones equal the host's${phoneMism.length ? `: ${phoneMism.slice(0, 5).join(', ')}` : ''}`);
  say(`answers counted by type: ${JSON.stringify(typeStats)}; stored ${answers.length}; host log errors: ${hostLog.filter((l) => /error|fail|denied/i.test(l)).length}`);

  // reactions: at most one per 3 s bucket per player (±1 bucket slack at the edges)
  const byUid = new Map();
  for (const x of reactions) byUid.set(x.uid, [...(byUid.get(x.uid) ?? []), x.at]);
  const over = [...byUid].filter(([, ats]) => {
    ats.sort((p, q) => p - q);
    return ats.length > Math.floor((ats[ats.length - 1] - ats[0]) / 3_000) + 3;
  });
  check(over.length === 0, `reactions within 1 per 3 s per player (${reactions.length} stored from ${byUid.size} players)`);

  // stale phases: how long after the host each phone saw every phaseRev
  const lags = { calm: [], chaos: [] };
  let missing = 0;
  for (const [rev, h] of hostSeen) {
    for (const b of bots) {
      if (h.at < b.watchFrom) continue;
      const seenAt = Math.min(...[...b.seen].filter(([r]) => r >= rev).map(([, t]) => t));
      if (!Number.isFinite(seenAt)) {
        missing++;
        continue;
      }
      (b.drops ? lags.chaos : lags.calm).push(Math.max(0, seenAt - h.at));
    }
  }
  const pct = (xs, p) => (xs.length ? [...xs].sort((x, y) => x - y)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : 0);
  say(`phase lag after the host — steady phones: p50 ${pct(lags.calm, 0.5)} ms, p95 ${pct(lags.calm, 0.95)} ms, max ${pct(lags.calm, 1)} ms; phones with drops: p95 ${pct(lags.chaos, 0.95)} ms, max ${pct(lags.chaos, 1)} ms`);
  check(missing === 0 && pct(lags.calm, 1) < 5_000, `no phone stuck in a stale phase (${hostSeen.size} phase changes; steady max lag ${pct(lags.calm, 1)} ms; missing ${missing})`);
  const errs = bots.flatMap((b) => b.errors);
  check(errs.length === 0, `bots ran without exceptions${errs.length ? `: ${errs.slice(0, 3).join(' | ')}` : ''}`);
  const results = {};
  for (const b of bots) for (const a of b.answers.values()) {
    const k = a.res.ok ? (a.offline ? 'ok (sent offline)' : 'ok') : a.res.error;
    results[k] = (results[k] ?? 0) + 1;
  }
  const reacts = {};
  for (const b of bots) for (const [k, v] of Object.entries(b.reacts)) reacts[k] = (reacts[k] ?? 0) + v;
  say(`answer() results ${JSON.stringify(results)}; react() results ${JSON.stringify(reacts)}; network drops ${bots.reduce((n, b) => n + b.drops, 0)}`);
  void finalRev;
}

// ------------------------------------------------------------------ usage report + extrapolation

/** Sums the meter over keys "phase|label|area" matching the filter. */
function sum(snap, { phase, label, area } = {}) {
  const out = { reads: 0, writes: 0, deletes: 0 };
  for (const [k, v] of Object.entries(snap)) {
    const [p, l, a] = k.split('|');
    if ((phase && p !== phase) || (label && l !== label) || (area && a !== area)) continue;
    out.reads += v.reads;
    out.writes += v.writes;
    out.deletes += v.deletes;
  }
  return out;
}

/** Answered-count pushes per question: the count changes in every push window (worst case). */
const countPushes = (timeS, players) => Math.floor((timeS * 1000) / answeredGapMs(timeS * 1000, players));
function answeredGapMs(limitMs, players) {
  return typeof pure.answeredPushGapMs === 'function' ? pure.answeredPushGapMs(limitMs, players) : HOST_TIMING.answeredPushMs;
}
function playersGapMs(players) {
  return typeof pure.playersPushGapMs === 'function' ? pure.playersPushGapMs(players) : HOST_TIMING.playersPushMs;
}

function report(gameMs) {
  const m = meter.snapshot();
  const Q = CONTENT.questions.length;
  const gameS = gameMs / 1000;
  console.log('\nFirestore usage of this run, metered per operation (tools/lib/fsmeter.mjs):');
  for (const ph of ['join', 'probe', 'game', 'verify']) {
    for (const lb of ['bot', 'host']) {
      const rows = Object.entries(m).filter(([k]) => k.startsWith(`${ph}|${lb}|`));
      if (!rows.length) continue;
      const t = sum(m, { phase: ph, label: lb });
      const parts = rows.map(([k, v]) => `${k.split('|')[2]} ${v.reads}r/${v.writes}w`).join(', ');
      console.log(`   ${ph.padEnd(6)} ${lb === 'bot' ? `${N} bots` : 'TV host'}: ${t.reads} reads, ${t.writes} writes  (${parts})`);
    }
  }
  const rounds = [...versions.perRound].filter(([i]) => i >= 0);
  const avg = (f) => rounds.reduce((n, [, v]) => n + f(v), 0) / Math.max(1, rounds.length);
  const steps = avg((v) => v.step);
  const counts = avg((v) => v.count);
  const other = avg((v) => v.other);
  const fin = (versions.perRound.get(-1)?.step ?? 0) + (versions.perRound.get(-1)?.count ?? 0) + (versions.perRound.get(-1)?.other ?? 0);
  console.log(`   games/{g} versions per question (1 read on every phone each): ${steps.toFixed(1)} phase steps + ${counts.toFixed(1)} answered/player counts + ${other.toFixed(1)} other${otherKeys.size ? ` ${JSON.stringify(Object.fromEntries(otherKeys))}` : ''}; final ${fin}`);

  // ---- measured building blocks (game phase)
  const tv = (area) => sum(m, { phase: 'game', label: 'host', area });
  const joinBot = sum(m, { phase: 'join', label: 'bot' });
  const answersStored = bots.reduce((n, b) => n + [...b.answers.values()].filter((a) => a.res.ok).length, 0);
  const reactionsOk = bots.reduce((n, b) => n + (b.reacts.ok ?? 0), 0);
  const tvAnswersPerAnswer = (tv('answers').reads - Q) / Math.max(1, answersStored);
  const leasePerS = { r: tv('lease').reads / gameS, w: tv('lease').writes / gameS };
  const gamePerQ = { r: (tv('game').reads - fin * 2) / Q, w: (tv('game').writes - fin) / Q };
  const totalsPerQ = { r: (tv('totals').reads - fin * 2) / Q, w: (tv('totals').writes - fin) / Q };
  console.log(`   TV per question: game ${gamePerQ.r.toFixed(1)}r/${gamePerQ.w.toFixed(1)}w, totals ${totalsPerQ.r.toFixed(1)}r/${totalsPerQ.w.toFixed(1)}w, answers ${tvAnswersPerAnswer.toFixed(2)} reads per answer; lease ${(leasePerS.r * 5).toFixed(2)}r/${(leasePerS.w * 5).toFixed(2)}w per 5 s; reactions ${tv('reactions').reads} reads for ${reactionsOk} sent`);

  // ---- a real party: 95 phones + the TV + one admin page, 15 questions × 60 s
  const P = 95;
  const QQ = 15;
  const TT = 60;
  const R = P * QQ * 2; // two reactions per guest per question
  const party = countPushes(TT, P);
  const versionsPerQ = steps + other + party;
  const activeS = QQ * (4 + TT + 3.5) + 30;
  const idleS = QQ * 60 + 30 * 60; // reveal + board held by the organizer, a 30 min lobby
  const leaseRenewals = activeS / 5 + idleS / 20;
  // lobby: guests trickle in evenly over 30 min; every player-count push is one read per phone
  let lobbyPushes = 0;
  let lobbyPhoneReads = 0;
  for (let t = 0, last = -Infinity, pushed = 0; t <= 30 * 60; t++) {
    const now = Math.round((P * t) / (30 * 60));
    if (now !== pushed && (t - last) * 1000 >= playersGapMs(now)) {
      lobbyPushes++;
      lobbyPhoneReads += now;
      last = t;
      pushed = now;
    }
  }
  // per phone and game: one reload (config ×2, game, own doc, answer, 2 clock probes = 7 reads,
  // 2 writes) and two network blips (game re-sync + a clock probe = 2 reads, 1 write each)
  const reconnect = { r: 7 + 2 * 2, w: 2 + 2 };
  const phoneJoinR = joinBot.reads / N + 2; // + config/current get + listener (bots are given the game id)
  const phones = {
    r: P * (phoneJoinR + QQ * versionsPerQ + fin + reconnect.r) + lobbyPhoneReads,
    w: P * (1 + QQ + reconnect.w) + R,
  };
  const tvParty = {
    r: QQ * (gamePerQ.r + (party - counts) * 2 + totalsPerQ.r + steps + 1 + P * tvAnswersPerAnswer) + leaseRenewals * 2 + fin * 5 + lobbyPushes * 2 + P * 5 + R,
    w: QQ * (gamePerQ.w + (party - counts) + totalsPerQ.w) + leaseRenewals + fin * 2 + lobbyPushes + 4,
  };
  const adminPage = { r: QQ * (versionsPerQ + steps + 1 + P) + leaseRenewals + fin * 2 + lobbyPushes + P * 5, w: 4 };
  const reads = Math.round(phones.r + tvParty.r + adminPage.r);
  const writes = Math.round(phones.w + tvParty.w + adminPage.w);
  console.log(`\nExtrapolated party: ${P} phones + TV + 1 admin page, ${QQ} questions × ${TT} s (answered pushes ${party}/question), 30 min lobby (${lobbyPushes} player-count pushes), ${R} reactions, a reload + 2 network blips per phone:`);
  console.log(`   reads  ≈ ${reads}  (phones ${Math.round(phones.r)}, TV ${Math.round(tvParty.r)}, admin ${Math.round(adminPage.r)})   budget 25 000`);
  console.log(`   writes ≈ ${writes}  (phones ${Math.round(phones.w)}, TV ${Math.round(tvParty.w)}, admin ${Math.round(adminPage.w)})   budget 6 000`);
  check(reads <= 25_000 && writes <= 6_000, `extrapolated party fits the Spark budget with a 2× margin (${reads} reads, ${writes} writes)`);
}

// ------------------------------------------------------------------ cleanup

async function cleanup() {
  stopping = true;
  meter.phase = 'cleanup';
  for (const b of bots) {
    if (!b) continue;
    b.p.stop();
    if (b.offline) await fs.enableNetwork(b.c.db).catch(() => undefined);
  }
  await host?.stop().catch(() => undefined);
  if (admin && !KEEP) {
    const r = fbRefs(admin.db);
    for (const col of [r.answers(G), r.reactions(G), r.players(G), fs.collection(admin.db, `games/${G}/private`)]) {
      try {
        const snap = await fs.getDocsFromServer(col);
        for (let k = 0; k < snap.docs.length; k += 20) await Promise.all(snap.docs.slice(k, k + 20).map((d) => fs.deleteDoc(d.ref)));
      } catch (e) {
        console.warn('cleanup', codeOf(e));
      }
    }
    await fs.deleteDoc(r.game(G)).catch(() => undefined);
    await fs.deleteDoc(r.clockProbe(admin.uid)).catch(() => undefined);
  }
  for (const c of clients) {
    const u = c.auth.currentUser;
    if (u?.isAnonymous && !KEEP) await deleteUser(u).catch(() => deleteUser(u).catch(() => undefined));
    await fs.terminate(c.db).catch(() => undefined);
    await deleteApp(c.app).catch(() => undefined);
  }
  say(KEEP ? `kept games/${G} and the bot users (--keep)` : `deleted games/${G} and ${clients.length - 1} anonymous bot users`);
}

// the first question: run the answer probes while it is open
const probeWatch = setInterval(() => {
  const g = host?.snapshot().game;
  if (g?.phase === 'open' && g.round && !probeWatch.done) {
    probeWatch.done = true;
    void answerProbes(g.round.i).catch((e) => check(false, `answer probes: ${e.message}`));
  }
}, 100);

let exitCode = 0;
try {
  await main();
} catch (e) {
  exitCode = 1;
  console.error(`${ts()} run failed: ${e?.stack ?? e}`);
  console.error(hostLog.slice(-15).join('\n'));
} finally {
  clearInterval(probeWatch);
  await cleanup().catch((e) => console.error('cleanup failed', e));
}
if (fails.length) {
  console.log(`\n${fails.length} check(s) failed`);
  exitCode = 1;
} else if (!exitCode) console.log('\nall checks passed');
process.exit(exitCode);
