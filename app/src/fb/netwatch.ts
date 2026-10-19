// Connection watchdog for the TV and the phones (docs/firebase.md → Connectivity).
//
// The Firestore SDK retries a failed stream with exponential backoff (1 s × 1.5 per failure, up to
// 60 s, ±50 % jitter). A page that could not connect during its first half minute (Wi-Fi still
// joining, a captive portal, a proxy stalling WebChannel) can then wait more than a minute after
// the network is fine again — what the ship run saw on the TV. So, while no server snapshot is on
// hand:
//   ≥ 10 s  show «переподключаемся» and restart the network (disableNetwork → enableNetwork: an
//           intentional close resets the backoff and aborts a request stuck in flight — the SDK
//           itself waits on such a request forever); again after 15, 20, 25, then every 30 s
//           (a restart kills a handshake in progress, so on a very slow link they space out);
//   ≥ 25 s  and never connected since the page loaded: reload once with forced long polling (plain
//           HTTP requests that any proxy passes), remembered on this device for 12 h. At most two
//           automatic reloads per tab per 10 min; never while the TV show is running.
// Nothing is done while the device itself reports offline (navigator.onLine === false).

import { disableNetwork, enableNetwork, type Firestore, type FirestoreSettings } from 'firebase/firestore';
import { netState, type NetStage } from './netstate';
import { KEYS, readJson, readString, writeJson, writeString } from './storage';

export const NET_WATCH = {
  /** No server snapshot for this long → «переподключаемся» and the first network restart. */
  firstMs: 10_000,
  /** Then restart the network again after this long, + kickGrowMs per restart done, ≤ kickMaxMs. */
  kickEveryMs: 10_000,
  kickGrowMs: 5_000,
  kickMaxMs: 30_000,
  /** Never connected since the page loaded, for this long → reload with forced long polling. */
  reloadAfterMs: 25_000,
  maxReloads: 2,
  reloadWindowMs: 10 * 60_000,
  /** How long a device keeps forcing long polling after it needed it once. */
  longPollingTtlMs: 12 * 3_600_000,
  /** The long-poll «hanging GET» timeout asked from the server (default 30 s; proxies often cut at 30). */
  longPollTimeoutS: 25,
  tickMs: 1_000,
} as const;

export interface WatchState {
  /** Local time the connection went missing (null while live). */
  since: number | null;
  everLive: boolean;
  lastKickAt: number;
  kicks: number;
}

export const initialWatch = (): WatchState => ({ since: null, everLive: false, lastKickAt: -Infinity, kicks: 0 });

export interface WatchInput {
  now: number;
  /** A server (not cache) snapshot of what the page listens to is on hand. */
  live: boolean;
  /** Nothing to wait for right now (the TV login form): no stage, and the clock restarts later. */
  idle?: boolean;
  /** navigator.onLine */
  osOnline: boolean;
  /** The page allows a reload now and the per-tab budget is not used up. */
  canReload: boolean;
}

export interface WatchOut {
  state: WatchState;
  stage: NetStage;
  kick: boolean;
  reload: boolean;
}

export function watchStep(s: WatchState, i: WatchInput): WatchOut {
  if (i.idle && !i.live) return { state: { ...s, since: null, lastKickAt: -Infinity, kicks: 0 }, stage: 'ok', kick: false, reload: false };
  if (i.live) return { state: { since: null, everLive: true, lastKickAt: -Infinity, kicks: 0 }, stage: 'ok', kick: false, reload: false };
  const since = s.since ?? i.now;
  const down = i.now - since;
  const late = down >= NET_WATCH.firstMs;
  const gap = Math.min(NET_WATCH.kickMaxMs, NET_WATCH.kickEveryMs + s.kicks * NET_WATCH.kickGrowMs);
  const kick = late && i.osOnline && i.now - s.lastKickAt >= gap;
  const reload = !s.everLive && down >= NET_WATCH.reloadAfterMs && i.osOnline && i.canReload;
  return {
    state: { since, everLive: s.everLive, lastKickAt: kick ? i.now : s.lastKickAt, kicks: s.kicks + (kick ? 1 : 0) },
    stage: late ? 'reconnecting' : s.everLive ? 'ok' : 'connecting',
    kick,
    reload,
  };
}

/** Automatic reloads left in this tab (recent reload times, local ms). */
export const reloadAllowed = (recent: readonly number[], now: number): boolean =>
  recent.filter((t) => now - t < NET_WATCH.reloadWindowMs).length < NET_WATCH.maxReloads;

/** Long polling is forced after this device once needed a reload (for 12 h), or with `?lp=1`. */
export function longPollingForced(stored: string | null, now: number, search: string): boolean {
  try {
    if (new URLSearchParams(search).get('lp') === '1') return true;
  } catch {
    // no query string
  }
  const at = Number(stored);
  return stored !== null && Number.isFinite(at) && now - at >= 0 && now - at < NET_WATCH.longPollingTtlMs;
}

/**
 * The transport part of the Firestore settings: WebChannel streaming with automatic fallback to
 * long polling (the SDK default) — or long polling from the start after a failed start.
 */
export function firestoreTransport(forceLongPolling: boolean): Pick<FirestoreSettings, 'experimentalForceLongPolling' | 'experimentalAutoDetectLongPolling' | 'experimentalLongPollingOptions'> {
  const longPoll = { experimentalLongPollingOptions: { timeoutSeconds: NET_WATCH.longPollTimeoutS } };
  return forceLongPolling ? { experimentalForceLongPolling: true, ...longPoll } : { experimentalAutoDetectLongPolling: true, ...longPoll };
}

/** Whether this page load should force long polling (reads storage and the query string). */
export function pageForcesLongPolling(): boolean {
  const search = typeof location === 'undefined' ? '' : location.search;
  return longPollingForced(readString('local', KEYS.longPolling), Date.now(), search);
}

const isNumberList = (v: unknown): v is number[] => Array.isArray(v) && v.every((x) => typeof x === 'number');

function reloadWithLongPolling(): void {
  const now = Date.now();
  const recent = (readJson('session', KEYS.netReloads, isNumberList) ?? []).filter((t) => now - t < NET_WATCH.reloadWindowMs);
  writeJson('session', KEYS.netReloads, [...recent, now]);
  writeString('local', KEYS.longPolling, String(now));
  netState.set({ reloading: true });
  location.reload();
}

async function restartNetwork(db: Firestore): Promise<void> {
  try {
    await disableNetwork(db);
  } finally {
    await enableNetwork(db).catch(() => undefined);
  }
}

export interface NetWatchOptions {
  /** A server (not cache) snapshot is on hand right now. */
  isLive: () => boolean;
  /** Nothing to wait for right now (the TV login form). */
  isIdle?: () => boolean;
  /** May the page reload itself right now (default yes). The TV says no once the show runs. */
  allowReload?: () => boolean;
}

/** Watches the page's connection once a second (see the header); returns stop(). */
export function startNetWatch(db: Firestore, o: NetWatchOptions): () => void {
  let s = initialWatch();
  let restarting = false;
  let stopped = false;
  const tick = () => {
    if (stopped || restarting) return;
    const now = Date.now();
    const osOnline = typeof navigator === 'undefined' || navigator.onLine !== false;
    const canReload = (o.allowReload?.() ?? true) && reloadAllowed(readJson('session', KEYS.netReloads, isNumberList) ?? [], now);
    const out = watchStep(s, { now, live: o.isLive(), idle: o.isIdle?.() ?? false, osOnline, canReload });
    s = out.state;
    netState.set({ stage: out.stage, restarts: s.kicks });
    if (out.reload) {
      stopped = true;
      reloadWithLongPolling();
    } else if (out.kick) {
      restarting = true;
      void restartNetwork(db)
        .catch(() => undefined)
        .finally(() => {
          restarting = false;
        });
    }
  };
  const id = setInterval(tick, NET_WATCH.tickMs);
  tick();
  return () => {
    stopped = true;
    clearInterval(id);
  };
}
