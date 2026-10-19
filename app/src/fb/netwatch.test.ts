// Connection watchdog: when the first server snapshot does not come, restart the network (which
// resets the SDK's exponential backoff — up to 60 s between attempts), then reload once with
// forced long polling. Pure parts only; the runtime is exercised by the TV and phone pages.

import { describe, expect, it } from 'vitest';
import { NET_WATCH, firestoreTransport, initialWatch, longPollingForced, reloadAllowed, watchStep, type WatchState } from './netwatch';

const T0 = 1_000_000;

function run(steps: { at: number; live?: boolean; idle?: boolean; osOnline?: boolean; canReload?: boolean }[], s0: WatchState = initialWatch()) {
  let s = s0;
  return steps.map((x) => {
    const out = watchStep(s, { now: T0 + x.at, live: x.live ?? false, idle: x.idle ?? false, osOnline: x.osOnline ?? true, canReload: x.canReload ?? true });
    s = out.state;
    return out;
  });
}

describe('connection watchdog', () => {
  it('connecting → «переподключаемся» at 10 s with a network restart, reload at 25 s', () => {
    const out = run([{ at: 0 }, { at: 9_999 }, { at: 10_000 }, { at: 15_000 }, { at: 20_000 }, { at: 25_000 }]);
    expect(out.map((o) => o.stage)).toEqual(['connecting', 'connecting', 'reconnecting', 'reconnecting', 'reconnecting', 'reconnecting']);
    expect(out.map((o) => o.kick)).toEqual([false, false, true, false, false, true]);
    expect(out.map((o) => o.reload)).toEqual([false, false, false, false, false, true]);
    expect(NET_WATCH.firstMs).toBe(10_000);
  });

  // A restart aborts a handshake in flight: on a very slow network a fixed 10 s cadence could
  // keep killing it, so the gaps grow (10, 15, 20 … 30 s).
  it('restarts space out while the connection stays down', () => {
    const at = Array.from({ length: 200 }, (_, k) => ({ at: 20_000 + k * 1_000, canReload: false }));
    const out = run([{ at: 0, live: true }, ...at]);
    const kicks = out.flatMap((o, k) => (o.kick ? [k - 1] : []));
    expect(kicks.slice(0, 6).map((k, n, xs) => (n ? k - (xs[n - 1] as number) : k))).toEqual([10, 15, 20, 25, 30, 30]);
  });

  it('the first live snapshot ends it; a later drop only restarts the network, never reloads', () => {
    const out = run([{ at: 0 }, { at: 3_000, live: true }, { at: 60_000 }, { at: 70_000 }, { at: 200_000 }]);
    expect(out[1]).toMatchObject({ stage: 'ok', kick: false, reload: false });
    expect(out[2]).toMatchObject({ stage: 'ok', kick: false });
    expect(out[3]).toMatchObject({ stage: 'reconnecting', kick: true, reload: false });
    expect(out[4]).toMatchObject({ stage: 'reconnecting', reload: false });
  });

  it('offline device: say so, but neither restart nor reload (they cannot help)', () => {
    const out = run([{ at: 0, osOnline: false }, { at: 12_000, osOnline: false }, { at: 40_000, osOnline: false }]);
    expect(out.map((o) => [o.stage, o.kick, o.reload])).toEqual([
      ['connecting', false, false],
      ['reconnecting', false, false],
      ['reconnecting', false, false],
    ]);
    // back online: restart at once
    expect(run([{ at: 41_000 }], out[2]?.state)[0]).toMatchObject({ kick: true, reload: true });
  });

  // The TV login form has nothing to wait for; the wait (and the reload) starts after sign-in.
  it('idle (login form) is not a connection: no stage, and a later stall may still reload', () => {
    const out = run([{ at: 0, idle: true }, { at: 30_000, idle: true }, { at: 31_000 }, { at: 41_000 }, { at: 56_000 }]);
    expect(out.map((o) => o.stage)).toEqual(['ok', 'ok', 'connecting', 'reconnecting', 'reconnecting']);
    expect(out.map((o) => o.reload)).toEqual([false, false, false, false, true]);
  });

  it('no reload when the page says no (TV show already running) or the budget is used up', () => {
    expect(run([{ at: 0 }, { at: 30_000, canReload: false }])[1]).toMatchObject({ stage: 'reconnecting', reload: false, kick: true });
    expect(reloadAllowed([], T0)).toBe(true);
    expect(reloadAllowed([T0 - 60_000], T0)).toBe(true);
    expect(reloadAllowed([T0 - 60_000, T0 - 30_000], T0)).toBe(false);
    expect(reloadAllowed([T0 - NET_WATCH.reloadWindowMs - 1, T0 - 30_000], T0)).toBe(true);
  });
});

describe('Firestore transport', () => {
  it('auto-detects long polling by default; forced after a failed start (12 h) or with ?lp=1', () => {
    expect(longPollingForced(null, T0, '')).toBe(false);
    expect(longPollingForced(String(T0 - 60_000), T0, '')).toBe(true);
    expect(longPollingForced(String(T0 - 13 * 3_600_000), T0, '')).toBe(false);
    expect(longPollingForced('garbage', T0, '?env=dev')).toBe(false);
    expect(longPollingForced(null, T0, '?env=dev&lp=1')).toBe(true);
    expect(firestoreTransport(false)).toEqual({ experimentalAutoDetectLongPolling: true, experimentalLongPollingOptions: { timeoutSeconds: 25 } });
    expect(firestoreTransport(true)).toEqual({ experimentalForceLongPolling: true, experimentalLongPollingOptions: { timeoutSeconds: 25 } });
  });
});
