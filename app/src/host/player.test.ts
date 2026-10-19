// PlayerSession join/load against an in-memory fake of the Firestore calls it makes (no network):
// the join is one write however often it is asked for, a slow write still lands in the lobby,
// a resend that hits the stored doc adopts it, and a player who already joined never gets the
// join form just because the first reads failed.

import { defaultSettings } from '@shared/defaults';
import type { GameDoc } from '@shared/fbtypes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Snap = { exists(): boolean; data(): unknown; metadata: { fromCache: boolean } };
type Next = (s: Snap) => void;

const fake = vi.hoisted(() => {
  const state = {
    docs: new Map<string, Record<string, unknown>>(),
    listeners: new Map<string, (s: unknown) => void>(),
    /** getDocFromServer fails like the SDK does while it counts itself offline. */
    offline: false,
    /** setDoc hangs until release() (a write the SDK keeps queued). */
    holdWrites: false,
    held: [] as (() => void)[],
    setCalls: 0,
    now: 1_000_000,
  };
  const snap = (path: string, fromCache = false) => ({
    exists: () => state.docs.has(path),
    data: () => state.docs.get(path),
    metadata: { fromCache },
  });
  const denied = () => Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
  const stamp = (d: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(d)) out[k] = v === '__ST__' ? state.now : v;
    return out;
  };
  return {
    state,
    snap,
    firestore: {
      getDoc: async (path: string) => snap(path),
      getDocFromServer: async (path: string) => {
        if (state.offline) throw Object.assign(new Error('Failed to get document because the client is offline.'), { code: 'unavailable' });
        return snap(path);
      },
      onSnapshot: (path: string, ...rest: unknown[]) => {
        const next = rest.find((x) => typeof x === 'function') as (s: unknown) => void;
        state.listeners.set(path, next);
        return () => state.listeners.delete(path);
      },
      serverTimestamp: () => '__ST__',
      setDoc: (path: string, data: Record<string, unknown>) => {
        state.setCalls++;
        const apply = () => {
          // players/{uid}: create-only for a guest (a set on an existing doc changes joinedAt/seed → refused)
          if (state.docs.has(path)) throw denied();
          state.docs.set(path, stamp(data));
        };
        if (!state.holdWrites) return Promise.resolve().then(apply);
        return new Promise<void>((res, rej) =>
          state.held.push(() => {
            try {
              apply();
              res();
            } catch (e) {
              rej(e);
            }
          }),
        );
      },
      updateDoc: async (path: string, patch: Record<string, unknown>) => {
        const cur = state.docs.get(path);
        if (!cur) throw denied();
        state.docs.set(path, { ...cur, ...stamp(patch) });
      },
    },
  };
});

vi.mock('firebase/firestore', () => fake.firestore);
vi.mock('../fb/refs', () => ({
  fbRefs: () => ({
    configCurrent: () => 'config/current',
    game: (g: string) => `games/${g}`,
    player: (g: string, uid: string) => `games/${g}/players/${uid}`,
    answer: (g: string, i: number, uid: string) => `games/${g}/answers/${i}_${uid}`,
    reaction: (g: string, uid: string, b: number) => `games/${g}/reactions/${uid}_${b}`,
  }),
  newPlayerDoc: (p: Record<string, unknown>) => ({ ...p, joinedAt: '__ST__', kicked: false, seenAt: '__ST__' }),
  newAnswerDoc: (uid: string, round: number, p: unknown) => ({ uid, round, p, at: '__ST__' }),
  newReactionDoc: (uid: string, e: number) => ({ uid, e, at: '__ST__' }),
  toFirestorePatch: (x: unknown) => x,
}));

const { ServerClock } = await import('../fb/clock');
const { initialGameDoc } = await import('./pure');
const { PlayerSession } = await import('./player');

const G = 'g1';
const UID = 'u1';
const ME = `games/${G}/players/${UID}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (what: string, fn: () => boolean, ms = 3_000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
    await sleep(5);
  }
};

function lobby(): GameDoc {
  const g = initialGameDoc({ ...defaultSettings(), gameStartsAt: new Date(fake.state.now - 3_600_000).toISOString() });
  return { ...g, phase: 'lobby' };
}

/** Publishes the game doc to the session's listener, as a server (live) snapshot. */
function pushGame(fromCache = false): void {
  const next = fake.state.listeners.get(`games/${G}`) as Next | undefined;
  next?.(fake.snap(`games/${G}`, fromCache) as Snap);
}

let session: InstanceType<typeof PlayerSession>;
function newSession(timeoutMs = 40) {
  session = new PlayerSession({ db: {} as never, uid: UID, gameId: G, clock: new ServerClock(), timeoutMs, syncClock: false });
  return session;
}

beforeEach(() => {
  const s = fake.state;
  s.docs.clear();
  s.listeners.clear();
  s.offline = false;
  s.holdWrites = false;
  s.held = [];
  s.setCalls = 0;
  s.docs.set(`games/${G}`, lobby() as unknown as Record<string, unknown>);
});
afterEach(() => session?.stop());

describe('PlayerSession join', () => {
  it('shows the lobby as soon as the write is confirmed — one write however often join() is called', async () => {
    const p = newSession();
    await p.start();
    pushGame();
    await until('join form', () => p.view().screen === 'join');
    fake.state.holdWrites = true;
    // The server does not answer in time: 'offline', but the write stays queued …
    expect(await p.join('Валера')).toEqual({ ok: false, error: 'offline' });
    expect(p.joining).toBe(true);
    // … and asking again (the retry button, a double tap) waits for that same write.
    const again = p.join('Валера');
    expect(fake.state.setCalls).toBe(1);
    fake.state.held.forEach((f) => f());
    expect(await again).toEqual({ ok: true });
    expect(p.view().screen).toBe('lobby');
    expect(p.view().me?.name).toBe('Валера');
    expect(p.joining).toBe(false);
    expect(await p.join('Валера')).toEqual({ ok: true });
    expect(fake.state.setCalls).toBe(1);
  });

  it('a write that lands after the caller gave up still flips the view to the lobby', async () => {
    const p = newSession();
    await p.start();
    pushGame();
    await until('join form', () => p.view().screen === 'join');
    fake.state.holdWrites = true;
    expect(await p.join('Оля')).toEqual({ ok: false, error: 'offline' });
    fake.state.held.forEach((f) => f());
    await until('lobby', () => p.view().screen === 'lobby');
  });

  it('a resend that hits the stored doc (lost ack, reload, second tab) adopts it', async () => {
    const p = newSession();
    await p.start();
    pushGame();
    await until('join form', () => p.view().screen === 'join');
    // Stored meanwhile by an earlier write of this device.
    fake.state.docs.set(ME, { name: 'Валера', seed: 7, joinedAt: 1, kicked: false, seenAt: 1 });
    expect(await p.join('Валера')).toEqual({ ok: true });
    expect(p.view().screen).toBe('lobby');
    expect(p.view().me?.name).toBe('Валера');
  });

  it('refuses a closed door without writing', async () => {
    fake.state.docs.set(`games/${G}`, { ...lobby(), phase: 'final' } as unknown as Record<string, unknown>);
    const p = newSession();
    await p.start();
    pushGame();
    await until('closed', () => p.view().screen === 'join_closed');
    expect(await p.join('Валера')).toEqual({ ok: false, error: 'closed' });
    expect(fake.state.setCalls).toBe(0);
  });
});

describe('PlayerSession load', () => {
  it('a joined player whose first reads fail sees the loader, never the join form, then the lobby', async () => {
    fake.state.docs.set(ME, { name: 'Валера', seed: 7, joinedAt: 1, kicked: false, seenAt: 1 });
    fake.state.offline = true;
    const p = newSession();
    await p.start();
    pushGame(true);
    // Longer than the old code's 5 attempts would have waited in total (scaled down here: the
    // backoff grows to 8 s, so the loop is still waiting after a few failures).
    await sleep(1_600);
    expect(p.view().screen).toBe('loading');
    // Connected: the game arrives from the server and wakes the pending read at once.
    fake.state.offline = false;
    pushGame(false);
    await until('lobby', () => p.view().screen === 'lobby', 1_000);
    expect(p.view().me?.name).toBe('Валера');
  });
});

describe('PlayerSession stage per round', () => {
  it('the options appear once: a clock stepping back after openAt, or the host\'s late «open», never replays the intro', async () => {
    const openAt = fake.state.now + 10_000;
    const round = { i: 0, n: 1, total: 3, qid: 'q1', type: 'choice', title: 'Цвет?', double: false, timeLimitS: 20, options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], introAt: openAt - 4_000, openAt, endsAt: openAt + 20_000 };
    fake.state.docs.set(`games/${G}`, { ...lobby(), phase: 'intro', phaseRev: 2, round } as unknown as Record<string, unknown>);
    fake.state.docs.set(ME, { name: 'Валера', seed: 7, joinedAt: 1, kicked: false, seenAt: 1 });
    const p = newSession();
    await p.start();
    pushGame();
    await until('intro', () => p.view(openAt - 1_000).screen === 'intro');
    // the phone's clock reaches openAt: the question (the host has not switched yet)
    expect(p.view(openAt + 20).screen).toBe('question');
    // a better clock sample moves "now" 400 ms back: still the question, not the 3-2-1 again
    expect(p.view(openAt - 400)).toMatchObject({ screen: 'question', canAnswer: true });
    // the host's «open» arrives: the same screen
    fake.state.docs.set(`games/${G}`, { ...lobby(), phase: 'open', phaseRev: 3, round } as unknown as Record<string, unknown>);
    pushGame();
    expect(p.view(openAt + 300).screen).toBe('question');
    // a tap while the clock reads 400 ms before openAt is not refused on the device (the server decides)
    p.clock.offer({ serverMs: openAt - 400, t0: Date.now(), rttMs: 0 });
    expect(p.view().screen).toBe('question');
    expect(await p.answer(0, { t: 'choice', id: 'a' })).toEqual({ ok: true });
  });
});
