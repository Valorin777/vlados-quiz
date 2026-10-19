// In the game, waiting for the start: your chrome self, the live head count (a droplet falls into
// the pool for every new guest), reactions to the big screen, and what happens next.

import { gsap } from 'gsap';
import { useEffect, useRef } from 'react';
import type { PlayerView } from '../../host/views';
import { Avatar, ChromeBlock, ChromeText, Countdown, Odometer, beats, plural, useLiquid, type Blob } from './vx';
import { useBytesUrl, useEntrance } from './hooks';
import { Hud } from './parts';
import { Reactions } from './Reactions';
import type { PlayerActions } from './types';

export function Lobby({ view, actions }: { view: PlayerView; actions: PlayerActions }) {
  const root = useRef<HTMLDivElement | null>(null);
  const hero = useRef<HTMLElement | null>(null);
  const pool = useRef<Blob | null>(null);
  const poolEl = useRef<HTMLDivElement | null>(null);
  const { engine } = useLiquid();
  const me = view.me;
  const src = useBytesUrl(me?.avatar);
  const count = view.counts.players;
  const early = view.pub !== null && view.now < view.pub.startsAt;
  const vlados = me?.isVlados === true;

  useEntrance(() => {
    const q = gsap.utils.selector(root);
    const tl = gsap.timeline();
    tl.add(beats.riseLetters(hero.current, { stagger: 0.09 }), 0.1);
    tl.add(beats.fadeUp(q('.pl-f'), { stagger: 0.06 }), 0.3);
    tl.add(beats.popIn(q('.pl-me'), { from: 0.2 }), 0.35);
    tl.add(beats.popIn(poolEl.current, { from: 0.3 }), 0.5);
    tl.add(beats.popIn(q('.vx-rb'), { stagger: 0.05 }), 0.7);
    return tl;
  });

  // A droplet for every newcomer (the count arrives throttled, so a few at once is one big drop).
  const last = useRef(count);
  useEffect(() => {
    const d = count - last.current;
    last.current = count;
    if (d > 0) beats.poolDrop(engine, pool.current, d > 2);
  }, [count, engine]);

  if (!me) return null;
  return (
    <div className={`pl-screen pl-lobby${vlados ? ' is-vlados' : ''}`} ref={root}>
      <Hud view={view} left={<span className="vx-kick pl-f">{early ? 'регистрация открыта' : 'ждём, пока соберутся все'}</span>} />
      <ChromeText ref={hero} as="h2" split="words" className="pl-l-hero">
        {vlados ? `Ты — ${view.pub?.vladosLabel ?? 'Владос'}` : 'Ты в игре'}
      </ChromeText>
      <div className="pl-me-row">
        <div className="pl-me">
          <Avatar name={me.name} src={src} size={104} liquid you />
        </div>
        <div className="pl-f">
          <p className="pl-me-name">{me.name}</p>
          <p className="vx-small">{vlados ? `Играешь ${view.texts.outOfCompetition} — просто отвечай про себя честно` : 'уже на большом экране'}</p>
        </div>
      </div>
      <p className="vx-body pl-f pl-l-sub">
        {early ? 'Ты зарегистрирован — возвращайся к началу, телефон вспомнит тебя сам.' : view.texts.waitingText}
      </p>
      <div className="pl-l-mid">
        <ChromeBlock ref={poolEl} shape="circle" film={0.55} blobRef={pool} className="pl-pool">
          <b className="vx-eng">
            <Odometer value={count} />
          </b>
          <span className="vx-eng">{plural(count, ['игрок', 'игрока', 'игроков'])}</span>
        </ChromeBlock>
      </div>
      {early && view.pub ? (
        <div className="pl-l-count pl-f">
          <p className="vx-kick">{view.texts.preGameCountdown}</p>
          <Countdown target={view.pub.startsAt} now={actions.now} className="pl-count is-small" />
        </div>
      ) : (
        <p className="vx-small pl-f pl-l-hint">Вопросы появятся на большом экране — отвечать будешь здесь. Кто быстрее, тому больше очков.</p>
      )}
      <Reactions view={view} actions={actions} />
    </div>
  );
}

