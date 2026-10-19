// DEV ONLY: bot guests for rehearsing the TV (`#/tv?env=dev&game=tvtest-1&bots=12`). Each bot is
// its own anonymous Firebase session + PlayerSession on the DEV project: it joins with a fake
// selfie, answers every question after a random delay and throws the odd reaction.
// Console: `__bots.stop()` (deletes the bots' anonymous users), `__bots.add(5)`, `__bots.react(8)`.

import { FB_PROJECTS } from '@shared/fbtypes';
import type { AnswerPayload } from '@shared/types';
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { deleteUser, inMemoryPersistence, initializeAuth, signInAnonymously, type Auth } from 'firebase/auth';
import { initializeFirestore, memoryLocalCache, terminate, type Firestore } from 'firebase/firestore';
import { currentEnv } from '../../../fb/env';
import { ServerClock } from '../../../fb/clock';
import { PlayerSession, type PlayerView } from '../../../host';
import { BOT_NAMES, fakeSelfie } from './faces';

interface Bot {
  name: string;
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  p: PlayerSession;
  timer: ReturnType<typeof setInterval>;
  planned: number;
}

export interface BotsApi {
  readonly bots: readonly { name: string; uid: string }[];
  add(n: number): Promise<void>;
  react(n?: number): void;
  stop(): Promise<void>;
}

function pickAnswer(v: PlayerView, k: number): AnswerPayload | null {
  const q = v.question;
  if (!q) return null;
  if (q.type === 'choice') {
    const opts = q.options ?? [];
    if (!opts.length) return null;
    // a crowd with opinions: the first two options are more popular
    const w = opts.map((_, i) => (i < 2 ? 3 : 1.4));
    let x = Math.random() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < opts.length; i++) {
      x -= w[i] ?? 1;
      if (x <= 0) return { t: 'choice', id: opts[i]?.id ?? '' };
    }
    return { t: 'choice', id: opts[0]?.id ?? '' };
  }
  if (q.type === 'number') {
    const n = q.number;
    const lo = n?.min ?? 0;
    const hi = n?.max ?? 100;
    const mid = lo + (hi - lo) * (0.55 + (k % 5) * 0.03);
    const g = (Math.random() + Math.random() + Math.random() - 1.5) * (hi - lo) * 0.35;
    const step = n?.step || 1;
    const v0 = Math.min(hi, Math.max(lo, Math.round((mid + g) / step) * step));
    return { t: 'number', v: Number(v0.toPrecision(12)) };
  }
  const ids = (q.items ?? []).map((i) => i.id);
  for (let i = ids.length - 1; i > 0; i--) {
    if (Math.random() < 0.45) continue;
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j] as string, ids[i] as string];
  }
  return { t: 'ordering', ids };
}

export async function startBots(o: { gameId: string; n: number }): Promise<BotsApi> {
  if (currentEnv() !== 'dev' || FB_PROJECTS.dev.projectId !== 'vlados-2609-dev') throw new Error('bots run on DEV only');
  const bots: Bot[] = [];
  let made = 0;

  const one = async (): Promise<void> => {
    const k = made++;
    const name = BOT_NAMES[k % BOT_NAMES.length] ?? `Бот ${k}`;
    const app = initializeApp(FB_PROJECTS.dev, `tvbot-${k}-${Math.random().toString(36).slice(2, 8)}`);
    const auth = initializeAuth(app, { persistence: inMemoryPersistence });
    const cred = await signInAnonymously(auth);
    const db = initializeFirestore(app, { localCache: memoryLocalCache() });
    const p = new PlayerSession({ db, uid: cred.user.uid, clock: new ServerClock(), gameId: o.gameId, timeoutMs: 15_000 });
    await p.start();
    await p.whenReady();
    const face = await fakeSelfie(k + 1);
    const r = await p.join(name, face.avatar, face.thumb);
    if (!r.ok) console.warn('bot join failed', name, r);
    const bot: Bot = { name, app, auth, db, p, planned: -1, timer: setInterval(() => tick(bot, k), 400) };
    bots.push(bot);
  };

  const tick = (b: Bot, k: number) => {
    const v = b.p.view();
    if (v.screen === 'question' && v.canAnswer && v.question && b.planned !== v.question.i) {
      const round = v.question.i;
      b.planned = round;
      const total = v.timer?.remainingMs ?? 20_000;
      const delay = 700 + Math.pow(Math.random(), 1.4) * Math.min(total * 0.7, 14_000);
      setTimeout(() => {
        const now = b.p.view();
        const a = pickAnswer(now, k);
        if (a && now.canAnswer && now.question?.i === round) void b.p.answer(round, a);
      }, delay);
    }
    if (v.reactions.enabled && v.reactions.cooldownMs === 0 && Math.random() < 0.012) void b.p.react(Math.floor(Math.random() * 8));
  };

  // join in a gentle stream (the TV shows every arrival)
  for (let i = 0; i < o.n; i++) {
    await one();
    await new Promise((r) => setTimeout(r, 350 + Math.random() * 500));
  }

  return {
    get bots() {
      return bots.map((b) => ({ name: b.name, uid: b.auth.currentUser?.uid ?? '' }));
    },
    async add(n: number) {
      for (let i = 0; i < n; i++) await one();
    },
    react(n = 6) {
      bots.slice(0, n).forEach((b) => void b.p.react(Math.floor(Math.random() * 8)));
    },
    async stop() {
      for (const b of bots.splice(0)) {
        clearInterval(b.timer);
        b.p.stop();
        try {
          if (b.auth.currentUser) await deleteUser(b.auth.currentUser);
        } catch {
          /* ignore */
        }
        await terminate(b.db).catch(() => undefined);
        await deleteApp(b.app).catch(() => undefined);
      }
    },
  };
}
