// Screens without a game to play: loading, no game yet, the door is closed, kicked, can't connect.

import { gsap } from 'gsap';
import { useRef, type ReactNode } from 'react';
import type { PlayerView } from '../../host/views';
import { ChromeBlock, ChromeButton, ChromeText, beats, cx, type Blob } from './vx';
import { useEntrance, useNetState } from './hooks';
import { HeroTitle, Hud, ThemeToggle } from './parts';

function Frame({ view, tone = 'chrome', kick, title, body, children }: { view: PlayerView | null; tone?: 'chrome' | 'tarnish'; kick: string; title: string; body?: string; children?: ReactNode }) {
  const root = useRef<HTMLDivElement | null>(null);
  const blob = useRef<Blob | null>(null);
  const el = useRef<HTMLDivElement | null>(null);
  useEntrance((engine) => {
    const s = gsap.utils.selector(root);
    const tl = gsap.timeline();
    tl.add(beats.popIn(el.current, { from: 0.3 }), 0.05);
    tl.add(beats.fadeUp(s('.pl-f'), { stagger: 0.08 }), 0.25);
    if (tone === 'tarnish') tl.add(beats.meltWrong(engine, blob.current, { mode: 'sag', el: el.current, drips: 2 }), 0.4);
    return tl;
  });
  return (
    <div className={cx('pl-screen pl-status', `is-${tone}`)} ref={root}>
      {view ? <Hud view={view} /> : <header className="pl-hud"><div className="pl-hud-l" /><div className="pl-hud-r"><ThemeToggle /></div></header>}
      <div className="pl-status-mid">
        <ChromeBlock ref={el} shape="circle" film={tone === 'tarnish' ? 0.18 : 0.55} tar={tone === 'tarnish' ? 1 : 0} tone={tone === 'tarnish' ? 'tarnish' : 'chrome'} blobRef={blob} className="pl-status-drop" />
        <p className="vx-kick pl-f">{kick}</p>
        <ChromeText as="h2" size="h2" className="pl-f pl-status-h">
          {title}
        </ChromeText>
        {body ? <p className="vx-body pl-f pl-status-b">{body}</p> : null}
        {children}
      </div>
    </div>
  );
}

export function Loading() {
  // No game doc from the server for 10 s: say so while the watchdog restarts the connection
  // (and, if that does not help, reloads the page once with long polling).
  const net = useNetState();
  const slow = net.stage === 'reconnecting';
  return (
    <div className="pl-screen pl-loading" aria-busy="true">
      <header className="pl-hud">
        <div className="pl-hud-l" />
        <div className="pl-hud-r">
          <ThemeToggle />
        </div>
      </header>
      <div className="pl-status-mid">
        <ChromeBlock shape="circle" film={0.6} className="pl-loading-drop" />
        <p className="vx-small pl-dots" role="status" aria-live="polite">
          {slow ? (net.reloading ? 'перезапускаем страницу' : 'переподключаемся') : 'наливаем ртуть'}
        </p>
        {slow ? <p className="vx-small pl-loading-sub">Сервер игры долго не отвечает — пробуем ещё раз, ничего нажимать не нужно</p> : null}
      </div>
    </div>
  );
}

export function CantConnect({ onRetry }: { onRetry: () => void }) {
  return (
    <Frame view={null} tone="tarnish" kick="нет связи" title="Не достучались до игры" body="Похоже, интернет пропал или сеть режет соединение. Проверь мобильный интернет или Wi-Fi и жми ещё раз.">
      <ChromeButton className="pl-f" onClick={onRetry}>
        Попробовать ещё раз
      </ChromeButton>
    </Frame>
  );
}

export function NoGame({ view }: { view: PlayerView }) {
  return <Frame view={view} kick="рановато" title="Игру ещё не создали" body="Организатор вот-вот всё запустит. Загляни чуть позже — ссылка та же." />;
}

export function JoinClosed({ view }: { view: PlayerView }) {
  return (
    <Frame view={view} kick={view.phase === 'final' ? 'уже финал' : 'игра идёт'} title={view.texts.joinClosed} body="Но смотреть на большой экран и болеть за своих никто не запрещает.">
      {view.pub ? <HeroTitle title={view.pub.title} className="pl-f pl-status-title" max={30} /> : null}
    </Frame>
  );
}

export function Kicked({ view }: { view: PlayerView }) {
  return <Frame view={view} tone="tarnish" kick="ой" title="Организатор убрал тебя из игры" body="Если это ошибка — подойди к нему, он всё вернёт. А пока — смотри на большой экран." />;
}

/**
 * The organizer's «стоп-экран»: the show stands still (a toast, the parents' video on the TV…).
 * Calm on purpose: no timer, no answers, no reactions — the screen underneath waits as it was and
 * comes back when the organizer goes on. The organizer's text, small, under the main line.
 */
export function Hold({ view }: { view: PlayerView }) {
  const text = view.hold?.text.trim() ?? '';
  return (
    <div className="pl-screen pl-status pl-hold" role="status" aria-live="polite">
      <Hud view={view} game />
      <div className="pl-status-mid">
        <ChromeBlock shape="circle" film={0.4} className="pl-status-drop pl-hold-drop" />
        <p className="vx-kick pl-hold-f">пауза</p>
        <ChromeText as="h2" size="h2" className="pl-status-h pl-hold-f">
          Смотри на экран
        </ChromeText>
        {text ? <p className="pl-hold-text pl-hold-f">{text}</p> : null}
        <p className="vx-small pl-hold-sub pl-hold-f">Игра продолжится с того же места — ничего нажимать не нужно</p>
      </div>
    </div>
  );
}
