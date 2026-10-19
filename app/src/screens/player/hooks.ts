import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type DependencyList } from 'react';
import { netState, type NetState } from '../../fb/netstate';
import { useLiquid, type LiquidEngine } from './vx';
import type { PlayerActions } from './types';

/**
 * Entrance choreography: runs `fn` once the liquid engine settled (or definitively won't) and
 * again when `deps` change; kills the returned timeline on change/unmount. The engine is read when
 * the entrance starts, not a dependency: the governor dropping to tier 0 on a weak phone (engine
 * → null in the context) used to kill the entrance and play it again — the options vanished and
 * popped in a second time.
 */
export function useEntrance(fn: (engine: LiquidEngine | null) => gsap.core.Animation | (() => void) | void, deps: DependencyList = []): void {
  const { engine, ready } = useLiquid();
  const f = useRef(fn);
  f.current = fn;
  const eng = useRef(engine);
  eng.current = engine;
  useLayoutEffect(() => {
    if (!ready) return;
    const r = f.current(eng.current);
    return () => {
      if (typeof r === 'function') r();
      else r?.kill();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, ...deps]);
}

/** JPEG bytes (avatar / podium thumb) → object URL, revoked when the bytes change. */
export function useBytesUrl(bytes: Uint8Array | undefined | null): string | null {
  // Created and revoked inside one effect (a memoized URL revoked by a StrictMode/remount
  // cleanup would be dead when the component comes back).
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!bytes || !bytes.length) {
      setUrl(null);
      return;
    }
    let u: string | null = null;
    try {
      u = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }));
    } catch {
      u = null;
    }
    setUrl(u);
    return () => {
      if (u) URL.revokeObjectURL(u);
    };
  }, [bytes]);
  return url;
}

const known = new Map<string, string>();

/** Object URL of a media-store image; null while loading or when it failed. */
export function useMediaUrl(actions: PlayerActions, id: string | undefined | null): { url: string | null; failed: boolean } {
  const [state, setState] = useState<{ id: string | null; url: string | null; failed: boolean }>(() => ({
    id: id ?? null,
    url: id ? (known.get(id) ?? null) : null,
    failed: false,
  }));
  useEffect(() => {
    if (!id) return;
    const have = known.get(id);
    if (have) {
      setState({ id, url: have, failed: false });
      return;
    }
    let alive = true;
    setState({ id, url: null, failed: false });
    actions.media(id).then(
      (url) => {
        known.set(id, url);
        if (alive) setState({ id, url, failed: false });
      },
      () => alive && setState({ id, url: null, failed: true }),
    );
    return () => {
      alive = false;
    };
  }, [actions, id]);
  if (!id || state.id !== id) return { url: id ? (known.get(id) ?? null) : null, failed: false };
  return { url: state.url, failed: state.failed };
}

/** Keeps the screen awake while `on` (re-acquired after the tab comes back / on the next tap). */
export function useWakeLock(on: boolean): void {
  useEffect(() => {
    if (!on || typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let busy = false;
    let alive = true;
    const get = async () => {
      if (!alive || lock || busy || document.visibilityState !== 'visible') return;
      busy = true;
      try {
        const l = await navigator.wakeLock.request('screen');
        if (!alive) void l.release();
        else {
          lock = l;
          l.addEventListener('release', () => {
            if (lock === l) lock = null;
          });
        }
      } catch {
        /* denied (battery saver, no gesture yet): try again on the next tap */
      } finally {
        busy = false;
      }
    };
    const onVis = () => void get();
    document.addEventListener('visibilitychange', onVis);
    document.addEventListener('pointerdown', onVis, { passive: true });
    void get();
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVis);
      document.removeEventListener('pointerdown', onVis);
      void lock?.release().catch(() => undefined);
      lock = null;
    };
  }, [on]);
}

/** The connection watchdog's stage (fb/netwatch.ts): «переподключаемся» before the first snapshot. */
export const useNetState = (): NetState => useSyncExternalStore(netState.subscribe, netState.get, netState.get);

/** navigator.onLine as state (the reconnect pill also shows when the OS says we are offline). */
export function useOnline(): boolean {
  const [on, setOn] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  useEffect(() => {
    const up = () => setOn(true);
    const down = () => setOn(false);
    addEventListener('online', up);
    addEventListener('offline', down);
    return () => {
      removeEventListener('online', up);
      removeEventListener('offline', down);
    };
  }, []);
  return on;
}
