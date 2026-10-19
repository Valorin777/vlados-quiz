// Live plumbing of the big screen: the organizer's session, the Host (TV = preferred lease
// holder), a 4 Hz view ticker, fullscreen and the screen wake lock.

import type { User } from 'firebase/auth';
import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { getFb } from '../../fb/app';
import { detectRole, watchUser, type FbRole } from '../../fb/auth';
import { netState, type NetState } from '../../fb/netstate';
import { startNetWatch } from '../../fb/netwatch';
import { Host, type AdminView } from '../../host';
import { workerWake } from '../../host/wake';

// ------------------------------------------------------------------ auth

export type TvAuth =
  | { state: 'loading' }
  | { state: 'signed_out' }
  | { state: 'checking'; user: User }
  | { state: 'not_admin'; user: User }
  | { state: 'error'; user: User; retry: () => void }
  | { state: 'admin'; user: User };

/** The organizer's email session (anonymous player sessions on this Mac count as signed out). */
export function useTvAuth(): TvAuth {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [role, setRole] = useState<{ uid: string; role: FbRole | 'error' } | null>(null);
  const [attempt, retry] = useReducer((n: number) => n + 1, 0);
  useEffect(() => watchUser(getFb().auth, (u) => setUser(u)), []);
  useEffect(() => {
    if (!user || user.isAnonymous) return;
    let alive = true;
    detectRole(getFb().refs, user)
      .then((r) => alive && setRole({ uid: user.uid, role: r }))
      .catch(() => alive && setRole({ uid: user.uid, role: 'error' }));
    return () => {
      alive = false;
    };
  }, [user, attempt]);
  // No answer from Firestore (the role check reads admin/content from the server): try again by
  // itself — the organizer should not have to walk to the Mac and click.
  const failed = role?.role === 'error';
  useEffect(() => {
    if (!failed) return;
    const t = setTimeout(retry, 3_000);
    return () => clearTimeout(t);
  }, [failed, attempt]);
  if (user === undefined) return { state: 'loading' };
  if (!user || user.isAnonymous) return { state: 'signed_out' };
  if (!role || role.uid !== user.uid) return { state: 'checking', user };
  if (role.role === 'admin') return { state: 'admin', user };
  if (role.role === 'error') return { state: 'error', user, retry };
  return { state: 'not_admin', user };
}

// ------------------------------------------------------------------ connection

/** The connection watchdog's stage (fb/netwatch.ts). */
export const useNetState = (): NetState => useSyncExternalStore(netState.subscribe, netState.get, netState.get);

/**
 * Runs the connection watchdog for the page: «переподключаемся» after 10 s without a server
 * snapshot, network restarts, and — only while `allowReload()` — one reload with long polling.
 */
export function useNetWatch(o: { isLive: () => boolean; isIdle: () => boolean; allowReload: () => boolean }): void {
  const cur = useRef(o);
  cur.current = o;
  useEffect(() => startNetWatch(getFb().db, { isLive: () => cur.current.isLive(), isIdle: () => cur.current.isIdle(), allowReload: () => cur.current.allowReload() }), []);
}

// ------------------------------------------------------------------ host

export type HostState = { host: Host | null; error: string | null };

/** One Host for the page while signed in as an admin; stopped (lease freed) on unload. */
export function useHost(uid: string | null, gameId: string | null): HostState {
  const [st, setSt] = useState<HostState>({ host: null, error: null });
  useEffect(() => {
    if (!uid) return;
    // a TV tab that lost focus (the organizer switched windows) keeps driving on time
    const wake = workerWake();
    const host = new Host({
      db: getFb().db,
      uid,
      preferred: true,
      label: 'tv',
      ...(wake ? { wake } : {}),
      ...(gameId ? { followCurrent: false } : {}),
    });
    let alive = true;
    host
      .start(gameId ?? undefined)
      .then(() => alive && setSt({ host, error: null }))
      .catch((e: unknown) => alive && setSt({ host: null, error: e instanceof Error ? e.message : String(e) }));
    const bye = () => void host.stop();
    addEventListener('pagehide', bye);
    return () => {
      alive = false;
      removeEventListener('pagehide', bye);
      void host.stop();
      setSt({ host: null, error: null });
    };
  }, [uid, gameId]);
  return st;
}

/** The admin view (a TvView plus `can`), rebuilt on every snapshot and 4× a second for timers. */
export function useHostView(host: Host | null): AdminView | null {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const queued = useRef(false);
  useEffect(() => {
    if (!host) return;
    const off = host.subscribe(() => {
      if (queued.current) return;
      queued.current = true;
      requestAnimationFrame(() => {
        queued.current = false;
        tick();
      });
    });
    const id = setInterval(tick, 250);
    return () => {
      off();
      clearInterval(id);
    };
  }, [host]);
  return host ? host.adminView() : null;
}

// ------------------------------------------------------------------ fullscreen / wake lock

type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => void };

export const isFullscreen = (): boolean => {
  const d = document as FsDoc;
  return !!(d.fullscreenElement ?? d.webkitFullscreenElement);
};

export function enterFullscreen(): void {
  const el = document.documentElement as FsEl;
  try {
    if (el.requestFullscreen) void el.requestFullscreen({ navigationUI: 'hide' }).catch(() => undefined);
    else el.webkitRequestFullscreen?.();
  } catch {
    /* not allowed here: the organizer can press F later */
  }
}

export function toggleFullscreen(): void {
  const d = document as FsDoc;
  if (!isFullscreen()) return enterFullscreen();
  try {
    if (d.exitFullscreen) void d.exitFullscreen().catch(() => undefined);
    else d.webkitExitFullscreen?.();
  } catch {
    /* ignore */
  }
}

type WakeLockSentinelLike = { release: () => Promise<void>; released?: boolean };

/** Keeps the Mac's screen awake while the show runs (re-acquired when the tab comes back). */
export function useWakeLock(on: boolean): void {
  useEffect(() => {
    if (!on) return;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<WakeLockSentinelLike> } };
    if (!nav.wakeLock) return;
    let lock: WakeLockSentinelLike | null = null;
    let alive = true;
    const get = () => {
      if (document.visibilityState !== 'visible') return;
      nav.wakeLock
        ?.request('screen')
        .then((l) => {
          if (alive) lock = l;
          else void l.release();
        })
        .catch(() => undefined);
    };
    get();
    document.addEventListener('visibilitychange', get);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', get);
      void lock?.release().catch(() => undefined);
    };
  }, [on]);
}

/**
 * Hides the mouse pointer after a few idle seconds (it would sit in the middle of the TV); the
 * organizer's 🔊 button goes with it (tv.css `.tv-sound-btn`).
 */
export function useIdleCursor(ms = 3000): void {
  useEffect(() => {
    let t = 0;
    const root = document.documentElement;
    const wake = () => {
      root.classList.remove('tv-nocursor');
      clearTimeout(t);
      t = window.setTimeout(() => root.classList.add('tv-nocursor'), ms);
    };
    wake();
    addEventListener('pointermove', wake);
    addEventListener('pointerdown', wake);
    return () => {
      clearTimeout(t);
      removeEventListener('pointermove', wake);
      removeEventListener('pointerdown', wake);
      root.classList.remove('tv-nocursor');
    };
  }, [ms]);
}
