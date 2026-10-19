// `#/` — the phone. First paint is the chrome loader; Firebase + the PlayerSession arrive in a
// separate chunk (./live) and the liquid engine in another (LiquidStage), so a guest on 4G sees
// something alive at once. `?fx=<state>` renders fixture states instead (screenshots, the Lab).

import { gsap } from 'gsap';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import type { PlayerView } from '../../host/views';
import { audio } from './vx';
import { useWakeLock } from './hooks';
import type { Live } from './live';
import { PlayerShell } from './Shell';

// Entrance timelines target optional parts (a media block, a hint); an empty match is fine.
gsap.config({ nullTargetWarn: false });

const FixturePlayer = lazy(() => import('./preview/FixturePlayer').then((m) => ({ default: m.FixturePlayer })));

let booting: Promise<Live> | null = null;

/** One live session per page (StrictMode mounts twice; hash navigation remounts). */
function boot(): Promise<Live> {
  if (!booting) {
    booting = import('./live').then((m) => m.startLive());
    booting.catch(() => {
      booting = null;
    });
  }
  return booting;
}

const TICK_FAST = new Set(['intro', 'question', 'answered', 'time_up']);

function useLiveView(live: Live | null): PlayerView | null {
  const [view, setView] = useState<PlayerView | null>(() => (live ? live.session.view() : null));
  const screen = view?.screen;
  useEffect(() => {
    if (!live) return;
    const render = () => setView(live.session.view());
    render();
    const off = live.session.subscribe(render);
    // Timers and screen switches that depend only on time (question → time_up, countdowns).
    const id = setInterval(render, screen && TICK_FAST.has(screen) ? 250 : 1000);
    return () => {
      off();
      clearInterval(id);
    };
  }, [live, screen]);
  // The options appear exactly at openAt (by the clock, whatever the host does): render right then.
  const openAt = view?.phase === 'intro' ? (view.question?.openAt ?? null) : null;
  useEffect(() => {
    if (!live || openAt === null) return;
    const ms = openAt - live.session.clock.now();
    if (ms < 0 || ms > 10 * 60_000) return;
    const id = setTimeout(() => setView(live.session.view()), ms + 5);
    return () => clearTimeout(id);
  }, [live, openAt]);
  return view;
}

function LivePlayer() {
  const [live, setLive] = useState<Live | null>(null);
  const [failed, setFailed] = useState(false);
  const start = useCallback(() => {
    setFailed(false);
    boot().then(setLive, () => setFailed(true));
  }, []);
  useEffect(() => {
    start();
  }, [start]);

  const view = useLiveView(live);
  useWakeLock(view?.me != null && view.screen !== 'kicked' && view.screen !== 'join_closed');

  const prefetch = view?.prefetch;
  useEffect(() => {
    if (live && prefetch?.length) live.prefetch(prefetch);
  }, [live, prefetch]);

  return <PlayerShell view={view} actions={live?.actions ?? null} failed={failed} onRetry={start} />;
}

function fixtureParam(): string | null {
  try {
    return new URLSearchParams(location.search).get('fx');
  } catch {
    return null;
  }
}

export function PlayerApp() {
  const [fx] = useState(fixtureParam);
  useEffect(() => {
    // Phones start silent (a room of 90 phones!); the corner toggle turns the sound on — and
    // builds the audio graph in its own tap. Arming on the first tap of a muted phone built it
    // for nothing (a 3 s reverb impulse: ~120 ms of the guest's first tap on a slow phone).
    audio.setDefaultMuted(true);
    if (!audio.isMuted) audio.armOnFirstGesture();
  }, []);
  if (fx !== null) {
    return (
      <Suspense fallback={<PlayerShell view={null} actions={null} />}>
        <FixturePlayer id={fx} />
      </Suspense>
    );
  }
  return <LivePlayer />;
}
