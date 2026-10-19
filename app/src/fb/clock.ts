// Server clock: serverNow() = Date.now() + offset (docs/firebase.md → Host → Server clock).
//
// A probe writes serverTimestamp() and reads the stored value back. The server stamped the write
// somewhere inside the write's round trip; assuming the middle gives offset = stamp − (t0 + rtt/2),
// good to ±rtt/2. The sample with the smallest round trip wins (the first write also opens the
// write stream, so it is usually slow). Players probe with their own `players/{uid}.seenAt`
// (join/reconnect only), admins with `config/clock_{uid}`.
//
// Re-measured when the browser comes back online, when the tab becomes visible after a while and on
// resync() (call it when a snapshot goes from fromCache to live). Probes are rate-limited so a
// flapping connection cannot burn the daily write budget.

import { getDocFromServer, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import type { FbRefs } from './refs';

/** Performs one server-timestamped write and resolves with that timestamp (server ms). */
export type ClockProbe = () => Promise<{ serverMs: number; t0: number; rttMs: number }>;

export interface ClockState {
  offsetMs: number;
  /** Round trip of the sample in use; null until the first successful probe. */
  rttMs: number | null;
  /** Date.now() of that sample. */
  syncedAt: number | null;
}

type Listener = (s: ClockState) => void;

/** Samples slower than this say more about the network than about the clock. */
const MAX_RTT_MS = 8_000;
/** After this long any fresh sample replaces the current one, even a slower one. */
const SAMPLE_TTL_MS = 10 * 60_000;
const MIN_SYNC_GAP_MS = 20_000;
const VISIBLE_RESYNC_AFTER_MS = 60_000;

export class ServerClock {
  private state: ClockState = { offsetMs: 0, rttMs: null, syncedAt: null };
  private listeners = new Set<Listener>();

  now = (): number => Date.now() + this.state.offsetMs;

  get(): ClockState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Offers a measured sample; keeps it if it is better than the current one (or that one is stale). */
  offer(sample: { serverMs: number; t0: number; rttMs: number }, at = Date.now()): boolean {
    if (!(sample.rttMs >= 0) || sample.rttMs > MAX_RTT_MS || !Number.isFinite(sample.serverMs)) return false;
    const cur = this.state;
    const offsetMs = Math.round(sample.serverMs - (sample.t0 + sample.rttMs / 2));
    const stale = cur.syncedAt === null || cur.rttMs === null || at - cur.syncedAt > SAMPLE_TTL_MS;
    // Outside both samples' error bars → the device clock itself moved (manual change, NTP step).
    const jumped = cur.rttMs !== null && Math.abs(offsetMs - cur.offsetMs) > (sample.rttMs + cur.rttMs) / 2 + 250;
    if (!stale && !jumped && sample.rttMs > (cur.rttMs ?? Infinity)) return false;
    this.set({ offsetMs, rttMs: sample.rttMs, syncedAt: at });
    return true;
  }

  /** Runs `samples` sequential probes; true if at least one succeeded. */
  async measure(probe: ClockProbe, samples = 1): Promise<boolean> {
    let ok = false;
    for (let i = 0; i < samples; i++) {
      try {
        const s = await probe();
        this.offer(s);
        ok = true;
      } catch {
        if (i === 0) return false;
      }
    }
    return ok;
  }

  /** Test helper. */
  reset(): void {
    this.set({ offsetMs: 0, rttMs: null, syncedAt: null });
  }

  private set(s: ClockState): void {
    this.state = s;
    for (const fn of this.listeners) fn(s);
  }
}

export const clock = new ServerClock();

/** Current server time in ms. */
export const serverNow = (): number => clock.now();

async function timed(write: () => Promise<unknown>, read: () => Promise<number | undefined>) {
  const t0 = Date.now();
  const p0 = performance.now();
  await write();
  const rttMs = performance.now() - p0;
  const serverMs = await read();
  if (typeof serverMs !== 'number') throw new Error('clock probe: no timestamp');
  return { serverMs, t0, rttMs };
}

/** Player probe: bumps `players/{uid}.seenAt` (the player must have joined). */
export const playerClockProbe =
  (refs: FbRefs, gameId: string, uid: string): ClockProbe =>
  () =>
    timed(
      () => updateDoc(refs.player(gameId, uid), { seenAt: serverTimestamp() }),
      async () => (await getDocFromServer(refs.player(gameId, uid))).data()?.seenAt,
    );

/** Admin probe: `config/clock_{uid}` = { t: serverTimestamp() }. */
export const adminClockProbe =
  (refs: FbRefs, uid: string): ClockProbe =>
  () =>
    timed(
      () => setDoc(refs.clockProbe(uid), { t: serverTimestamp() }),
      async () => (await getDocFromServer(refs.clockProbe(uid))).data()?.t,
    );

export interface ClockSync {
  /** Measure again now (rate-limited). */
  resync(): void;
  stop(): void;
}

/**
 * Measures now (2 samples), then again on `online`, on returning to the tab after a minute and on
 * resync(); never more often than every 20 s.
 */
export function startClockSync(probe: ClockProbe, target: ServerClock = clock): ClockSync {
  let stopped = false;
  let running = false;
  let lastRun = 0;
  let hiddenAt: number | null = null;

  const run = (samples: number) => {
    if (stopped || running || Date.now() - lastRun < MIN_SYNC_GAP_MS) return;
    running = true;
    lastRun = Date.now();
    void target.measure(probe, samples).then(
      (ok) => {
        running = false;
        // Nothing measured (offline): let the next trigger try right away.
        if (!ok) lastRun = 0;
      },
      () => {
        running = false;
        lastRun = 0;
      },
    );
  };
  const onOnline = () => run(1);
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
    } else if (hiddenAt !== null && Date.now() - hiddenAt > VISIBLE_RESYNC_AFTER_MS) {
      hiddenAt = null;
      run(1);
    }
  };

  const hasWindow = typeof window !== 'undefined' && typeof document !== 'undefined';
  if (hasWindow) {
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);
  }
  run(2);
  return {
    resync: () => run(1),
    stop() {
      stopped = true;
      if (hasWindow) {
        window.removeEventListener('online', onOnline);
        document.removeEventListener('visibilitychange', onVisibility);
      }
    },
  };
}
