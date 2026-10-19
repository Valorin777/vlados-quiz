// The whole phone experience for one PlayerView: one liquid stage, the screen for view.screen,
// the non-blocking status pills and toasts. Pure (view + actions in), so the live page and the
// fixture previews render exactly the same thing.

import { useEffect } from 'react';
import type { PlayerScreen, PlayerView } from '../../host/views';
import { LiquidStage, ToastHost, audio, cx, setAppearanceOverride, type Tier } from './vx';
import { Board } from './Board';
import { Final } from './Final';
import { useOnline } from './hooks';
import { Join } from './Join';
import { Lobby } from './Lobby';
import { hasOwnAppearance, StatusPills } from './parts';
import { Reveal } from './Reveal';
import { preloadOrderList, Round } from './Round';
import { CantConnect, Hold, JoinClosed, Kicked, Loading, NoGame } from './Status';
import { SurpriseScreen, useSurprise } from './Surprise';
import type { PlayerActions } from './types';
import './player.css';

function screenKey(v: PlayerView): string {
  switch (v.screen) {
    case 'intro':
    case 'question':
    case 'answered':
    case 'time_up':
      return `round-${v.question?.i ?? 'x'}`;
    case 'reveal':
      return `reveal-${v.reveal?.i ?? 'x'}`;
    case 'board':
      return `board-${v.reveal?.i ?? 'x'}`;
    default:
      return v.screen;
  }
}

function Screen({ view, actions }: { view: PlayerView; actions: PlayerActions }) {
  switch (view.screen) {
    case 'loading':
      return <Loading />;
    case 'no_game':
      return <NoGame view={view} />;
    case 'join':
      return <Join view={view} actions={actions} />;
    case 'join_closed':
      return <JoinClosed view={view} />;
    case 'kicked':
      return <Kicked view={view} />;
    case 'lobby':
      return <Lobby view={view} actions={actions} />;
    case 'intro':
    case 'question':
    case 'answered':
    case 'time_up':
      return <Round view={view} actions={actions} />;
    case 'reveal':
      return <Reveal view={view} actions={actions} />;
    case 'board':
      return <Board view={view} />;
    case 'final':
      return <Final view={view} actions={actions} />;
  }
}

/** Screens of a joined guest: the «стоп-экран» covers them (join / kicked / loading stay as they are). */
const GAME_SCREENS: ReadonlySet<PlayerScreen> = new Set<PlayerScreen>(['lobby', 'intro', 'question', 'answered', 'time_up', 'reveal', 'board', 'final']);

export interface PlayerShellProps {
  /** null: still connecting. */
  view: PlayerView | null;
  actions: PlayerActions | null;
  /** Could not reach Firebase at all (auth/network): show the retry screen. */
  failed?: boolean;
  onRetry?: () => void;
  /** Lab frames: fill the parent instead of the viewport. */
  contained?: boolean;
  tier?: Tier | 'auto';
}

export function PlayerShell({ view, actions, failed = false, onRetry, contained = false, tier }: PlayerShellProps) {
  const osOnline = useOnline();
  const themeDefault = view?.pub?.themeDefault;

  // The organizer's default look applies until this guest picks one.
  useEffect(() => {
    if (contained || !themeDefault || hasOwnAppearance()) return;
    setAppearanceOverride(themeDefault === 'system' ? null : themeDefault);
  }, [themeDefault, contained]);

  // «стоп-экран»: the guest's screen stays mounted but hidden (a typed number, an arranged order
  // survive), the calm hold screen in its place; the phone is silent meanwhile
  const held = !!view?.hold && GAME_SCREENS.has(view.screen);
  useEffect(() => {
    audio.hold(held);
  }, [held]);
  useEffect(() => () => audio.hold(false), []);

  const inGame = !!view && GAME_SCREENS.has(view.screen);
  // «Сюрприз»: the phone glitches, goes black, then «Смотри на экран» (the video is on the TV)
  const sur = useSurprise(inGame ? view : null);
  const blocked = !!sur && !sur.out;
  useEffect(() => {
    if (!inGame) return;
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(preloadOrderList, { timeout: 4000 });
      return () => w.cancelIdleCallback?.(id);
    }
    const id = setTimeout(preloadOrderList, 1500);
    return () => clearTimeout(id);
  }, [inGame]);

  const vlados = view?.me?.isVlados === true;
  let body;
  if (failed && !view) body = <CantConnect onRetry={() => onRetry?.()} />;
  else if (!view || !actions) body = <Loading />;
  else {
    body = (
      <>
        <div className={cx('pl-under', blocked && sur?.part === 'glitch' && 'is-glitch')} hidden={held} inert={held || blocked}>
          <Screen key={screenKey(view)} view={view} actions={actions} />
        </div>
        {held ? <Hold view={view} /> : sur ? <SurpriseScreen part={sur.part} out={sur.out} /> : null}
      </>
    );
  }

  return (
    <div className={cx('vx pl', vlados && 'is-vlados', contained && 'is-contained', held && 'is-held')} data-screen={view?.screen ?? 'loading'}>
      <LiquidStage profile="phone" contained={contained} {...(tier !== undefined ? { tier } : {})} className="pl-stage">
        {body}
        {view ? <StatusPills view={view} osOnline={osOnline} /> : null}
      </LiquidStage>
      <ToastHost />
    </div>
  );
}
