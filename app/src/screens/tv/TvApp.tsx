// `#/tv` — the big screen on the MacBook (Safari → HDMI TV). Requires the organizer's session:
// it runs the preferred Host (timed transitions, reveals) and renders the TvView.
//
// Keys: Space / → = the next main action (AdminView.can) · P pause · M sound · F fullscreen · H help.
// DEV only (`?env=dev`): `&game=<id>` plays a separate test game, `&bots=N` adds N bot guests,
// `&demo=<scene>` renders fixtures without Firebase (see dev/demo.tsx). `&mode=light|dark` forces
// the colour mode.

import { gsap } from 'gsap';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { audio, setAppearanceOverride, type AppearancePref } from '../../visual';
import { currentEnv } from '../../fb/env';
import type { HostCommand } from '../../host';
import { StartGate, TvLogin, TvNotAdmin, TvWait } from './Gate';
import { mainAction } from './keys';
import { finaleWarmIds, preloadBuiltinFinale } from './finale';
import { mediaState, prefetchAll, startTvSound } from './media';
import { soundBlocked, soundLog } from './sound';
import { needsBuiltinSurprise, onSurpriseLoad, preloadBuiltinSurprise, surpriseLoad, surpriseWarmIds, type SurpriseLoad } from './surprise/video';
import type { HudMsg } from './Overlays';
import { TvShow } from './TvShow';
import { TvStage } from './TvStage';
import { enterFullscreen, toggleFullscreen, useHost, useHostView, useIdleCursor, useNetState, useNetWatch, useTvAuth, useWakeLock } from './useTv';
import './tv.css';

const TvDemo = lazy(() => import('./dev/demo').then((m) => ({ default: m.TvDemo })));

export function param(name: string): string | null {
  try {
    return new URLSearchParams(location.search).get(name) ?? new URLSearchParams(location.hash.split('?')[1] ?? '').get(name);
  } catch {
    return null;
  }
}

const isDev = (): boolean => currentEnv() === 'dev';

/** Light/dark: the organizer's TV setting; `?mode=` wins (rehearsals, tests). */
export function useTvAppearance(pref: AppearancePref | undefined): void {
  const forced = param('mode');
  const want: AppearancePref = forced === 'light' || forced === 'dark' ? forced : (pref ?? 'dark');
  useEffect(() => {
    setAppearanceOverride(want);
    // another module may re-apply the device's own choice on system changes: keep the TV's mode
    const root = document.documentElement;
    const target = () => (want === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : want);
    const fix = () => {
      const m = target();
      if (root.dataset.mode !== m) {
        root.dataset.mode = m;
        root.style.colorScheme = m;
      }
    };
    fix();
    const obs = new MutationObserver(fix);
    obs.observe(root, { attributes: true, attributeFilter: ['data-mode'] });
    return () => obs.disconnect();
  }, [want]);
  useEffect(() => () => setAppearanceOverride(null), []);
}

export function useMuted(): boolean {
  const [m, setM] = useState(audio.isMuted);
  useEffect(() => audio.subscribe(() => setM(audio.isMuted)), []);
  return m;
}

const CMD_ERR: Record<string, string> = {
  stale: 'Уже сделано',
  offline: 'Нет связи — повтори через секунду',
  not_found: 'Игра не найдена',
  invalid: 'Сейчас это нельзя',
  failed: 'Не получилось — попробуй ещё раз',
  not_leader: 'Игру ведёт другой экран',
};

function Live() {
  const auth = useTvAuth();
  const email = auth.state !== 'loading' && auth.state !== 'signed_out' ? (auth.user.email ?? null) : null;
  const gameId = isDev() ? param('game') : null;
  const { host, error } = useHost(auth.state === 'admin' ? auth.user.uid : null, gameId);
  const view = useHostView(host);
  const [started, setStarted] = useState(false);
  const [help, setHelp] = useState(false);
  const [hud, setHud] = useState<HudMsg | null>(null);
  const [media, setMedia] = useState<{ done: number; total: number; failed: number } | null>(null);
  const [bigVideo, setBigVideo] = useState<SurpriseLoad>(surpriseLoad);
  useEffect(() => onSurpriseLoad(setBigVideo), []);
  const muted = useMuted();
  const armed = useRef(0);
  const busy = useRef(false);
  useTvAppearance(view?.appearance);
  useWakeLock(started);
  useIdleCursor();
  const say = useCallback((text: string, tone?: HudMsg['tone']) => setHud({ id: Date.now() + Math.random(), text, ...(tone ? { tone } : {}) }), []);
  const now = useMemo(() => (host ? () => host.now() : Date.now), [host]);

  // Connection watchdog (fb/netwatch.ts): «переподключаемся» + network restarts when Firestore
  // does not answer; one automatic reload with long polling, but only before the show started
  // (a reload would drop fullscreen and the sound unlock).
  const net = useNetState();
  const live = useRef({ host, auth: auth.state });
  live.current = { host, auth: auth.state };
  const startedRef = useRef(false);
  startedRef.current = started;
  useNetWatch({
    isLive: () => {
      const h = live.current.host;
      return h !== null && h.snapshot().health.listeners.game === 'live';
    },
    // the login form (or «not an organizer») waits for a person, not for the network
    isIdle: () => live.current.auth === 'signed_out' || live.current.auth === 'not_admin',
    allowReload: () => !startedRef.current,
  });
  const reconnecting = net.stage === 'reconnecting' && !started;
  const netWait = (retry?: () => void) => (
    <TvWait
      text={net.reloading ? 'Перезапускаем страницу…' : 'Переподключаемся…'}
      sub={`Сервер игры не отвечает — пробуем ещё раз сами${net.restarts > 1 ? ` (попытка ${net.restarts})` : ''}. Если это надолго — проверь Wi-Fi на Mac.`}
      {...(retry ? { action: { label: 'Попробовать сейчас', run: retry } } : {})}
    />
  );

  // warm every question's photos and videos into this Mac's cache (sequential, in the background)
  const contentRev = host && view ? (host.snapshot().content?.rev ?? -1) : -1;
  useEffect(() => {
    if (!host || contentRev < 0) return;
    const s = host.snapshot();
    const ids: string[] = [];
    for (const q of s.content?.questions ?? []) {
      if (q.disabled) continue;
      for (const m of [q.media, q.revealMedia]) {
        if (!m) continue;
        ids.push(m.mediaId);
        const poster = s.media[m.mediaId]?.posterId;
        if (poster) ids.push(poster);
      }
      const items = q.type === 'choice' ? q.options : q.type === 'ordering' ? q.items : [];
      for (const it of items) if (it.mediaId) ids.push(it.mediaId);
    }
    // the uploaded video after the final (the built-in clip is loaded at «Начать шоу»)
    ids.push(...finaleWarmIds(s.content?.settings, (id) => s.media[id]?.posterId));
    // an uploaded «Сюрприз» video; the built-in one goes whole into memory right away (≈24 MB)
    ids.push(...surpriseWarmIds(s.content?.questions, (id) => s.media[id]?.posterId));
    if (needsBuiltinSurprise(s.content?.questions)) void preloadBuiltinSurprise();
    return prefetchAll(ids, (done, total, failed) => setMedia({ done, total, failed }));
  }, [host, contentRev]);

  // DEV: bot guests for rehearsals (`?env=dev&game=tvtest-1&bots=12`)
  useEffect(() => {
    if (!host || !isDev()) return;
    const w = window as unknown as Record<string, unknown>;
    w.__tv = { host, view: () => host.adminView() };
    // what the page plays right now (checks of the «стоп-экран»: context suspended, media paused)
    w.__tvSound = () => ({ ctx: audio.state, held: audio.isHeld, muted: audio.isMuted, blocked: soundBlocked(), log: [...soundLog], media: mediaState(), gsapPaused: gsap.globalTimeline.paused(), holdText: document.querySelector('.tv-hold')?.getAttribute('aria-label') ?? null });
    const n = Number(param('bots') ?? 0);
    const g = host.gameId;
    if (!n || !g) return;
    let stop: (() => void) | null = null;
    let alive = true;
    void import('./dev/bots').then(async (m) => {
      if (!alive) return;
      const bots = await m.startBots({ gameId: g, n });
      w.__bots = bots;
      stop = () => void bots.stop();
      if (!alive) stop();
    });
    return () => {
      alive = false;
      stop?.();
    };
  }, [host]);

  const run = useCallback(
    async (cmd: HostCommand, label: string) => {
      if (!host || busy.current) return;
      busy.current = true;
      say(label);
      try {
        const r = await host.command(cmd);
        if (!r.ok) say(CMD_ERR[r.error] ?? 'Не получилось — попробуй ещё раз', 'warn');
      } finally {
        busy.current = false;
      }
    },
    [host, say],
  );

  // the question's video ended on this screen: the answers open after the 3-2-1 (host 'watchEnd')
  const onWatchEnded = useCallback(
    (phaseRev: number) => {
      if (!host) return;
      void host.command({ type: 'watchEnd', phaseRev }).then((r) => {
        if (!r.ok && r.error !== 'stale' && r.error !== 'invalid') say('Видео закончилось — нажми пробел, чтобы открыть ответы', 'warn');
      });
    },
    [host, say],
  );

  // the «Сюрприз» video ended on this screen: the question's answer now (host 'surpriseEnd')
  const onSurpriseEnded = useCallback(
    (phaseRev: number) => {
      if (!host) return;
      void host.command({ type: 'surpriseEnd', phaseRev }).then((r) => {
        if (!r.ok && r.error !== 'stale' && r.error !== 'invalid') say('Видео закончилось — нажми пробел, чтобы показать ответ', 'warn');
      });
    },
    [host, say],
  );

  // the reveal video ended on this screen: the autopilot's board 2 s later (host 'revealMediaEnd';
  // the clock hold stays the fallback, so one retry is plenty)
  const onRevealMediaEnded = useCallback(
    (phaseRev: number) => {
      if (!host) return;
      const send = (again: boolean) =>
        void host.command({ type: 'revealMediaEnd', phaseRev }).then((r) => {
          if (!r.ok && again && r.error !== 'stale' && r.error !== 'invalid') setTimeout(() => send(false), 1_500);
        });
      send(true);
    },
    [host],
  );

  const start = useCallback(() => {
    // inside the click: sound on, the WebAudio context resumed, the one video element blessed
    startTvSound();
    // the video after the final (built-in clip): into memory now, played at the very end
    void preloadBuiltinFinale();
    // the «Сюрприз» (built-in): into memory now if a question has it (already loading since the gate)
    if (needsBuiltinSurprise(host?.snapshot().content?.questions)) void preloadBuiltinSurprise();
    enterFullscreen();
    setStarted(true);
  }, [host]);

  // the organizer's keys (physical codes: work with the Russian layout too)
  useEffect(() => {
    if (!started) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const v = host?.adminView();
      switch (e.code) {
        case 'Space':
        case 'ArrowRight':
        case 'Enter':
        case 'NumpadEnter':
        case 'PageDown': {
          e.preventDefault();
          if (e.repeat || !v) return;
          const a = mainAction(v);
          if (!a) {
            say(v.phase === 'intro' ? (v.watch?.stage === 'beat' ? 'Ответы открываются' : 'Вопрос уже начинается') : v.surprise ? 'Сюрприз на экране' : v.phase === 'locked' ? 'Считаем ответы — секунду' : v.phase === 'final' ? 'Это финал — дальше только торт 🎂' : 'Сейчас нечего нажимать', 'warn');
            return;
          }
          if (a.confirm && Date.now() - armed.current > 2500) {
            armed.current = Date.now();
            say(a.confirm, 'warn');
            return;
          }
          armed.current = 0;
          void run(a.cmd, a.label);
          return;
        }
        case 'KeyP': {
          e.preventDefault();
          if (!v) return;
          if (v.hold) say('Стоп-экран: пробел два раза — убрать надпись и продолжить', 'warn');
          else if (v.can.resume) void run({ type: 'resume' }, 'Продолжаем');
          else if (v.can.pause) void run({ type: 'pause' }, 'Пауза');
          else say('Пауза бывает во время вопроса', 'warn');
          return;
        }
        case 'KeyM': {
          e.preventDefault();
          const m = audio.toggleMuted();
          say(m ? 'Звук выключен' : 'Звук включён');
          return;
        }
        case 'KeyF':
          e.preventDefault();
          toggleFullscreen();
          return;
        case 'KeyH':
        case 'Slash':
          e.preventDefault();
          setHelp((h) => !h);
          return;
        case 'Escape':
          setHelp(false);
          return;
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [started, host, run, say]);

  let body: ReactNode;
  if (auth.state === 'loading') body = <TvWait text="Подключаемся…" />;
  else if (auth.state === 'signed_out') body = <TvLogin />;
  else if (auth.state === 'checking') body = reconnecting ? netWait() : <TvWait text="Проверяем вход организатора…" />;
  else if (auth.state === 'not_admin') body = <TvNotAdmin email={email} />;
  else if (auth.state === 'error') body = netWait(auth.retry);
  else if (error) body = <TvWait text="Не удалось запустить игру" sub={error} action={{ label: 'Перезагрузить', run: () => location.reload() }} />;
  else if (!host || !view) body = reconnecting ? netWait() : <TvWait text="Загружаем игру…" />;
  else if (!started) body = reconnecting && view.phase === null ? netWait() : <StartGate view={view} email={email} media={media} video={bigVideo} onStart={start} />;
  else {
    const holder = view.lease.holder;
    const other = !view.lease.mine && holder !== null && holder.session !== host.session;
    const chip =
      isDev() || other ? (
        <>
          {isDev() ? <b className="tv-chip-dev">DEV</b> : null}
          {other && holder ? <span>пульт: {holder.label === 'tv' ? 'другой экран' : 'админка'}</span> : null}
        </>
      ) : null;
    body = <TvShow view={view} now={now} muted={muted} hud={hud} help={help} onHelpClose={() => setHelp(false)} chip={chip} onWatchEnded={onWatchEnded} onSurpriseEnded={onSurpriseEnded} onRevealMediaEnded={onRevealMediaEnded} />;
  }
  return <TvStage>{body}</TvStage>;
}

/**
 * DEV (`&nolag=1`): rehearsal screenshots from a hidden/background tab, where the browser stops
 * requestAnimationFrame. Frames are driven by timers and GSAP follows real time.
 */
function backgroundTabClock(): void {
  const w = window as Window & { __tvClock?: boolean };
  if (w.__tvClock) return;
  w.__tvClock = true;
  // the liquid engine skips frames while the page reports itself hidden
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  window.requestAnimationFrame = (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 16);
  window.cancelAnimationFrame = (id: number) => clearTimeout(id);
  gsap.ticker.lagSmoothing(0);
  gsap.ticker.sleep();
  gsap.ticker.wake();
}

export function TvApp() {
  const demo = isDev() || import.meta.env.DEV ? param('demo') : null;
  if ((demo || isDev()) && param('nolag')) backgroundTabClock();
  if (demo) {
    return (
      <Suspense fallback={null}>
        <TvDemo which={demo} />
      </Suspense>
    );
  }
  return <Live />;
}
