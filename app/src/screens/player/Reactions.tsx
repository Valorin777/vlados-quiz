// Reactions to the big screen. PlayerSession.react throttles (1 per 3 s, 4 per minute, bucketed
// by the server): the bar greys out while recharging, so spam taps never leave the phone.

import { useEffect, useState } from 'react';
import type { PlayerView } from '../../host/views';
import { ReactionBar, cx, toast } from './vx';
import type { PlayerActions } from './types';

export function Reactions({ view, actions, className }: { view: PlayerView; actions: PlayerActions; className?: string }) {
  const [until, setUntil] = useState(0);
  const [, force] = useState(0);
  const wait = Math.max(view.reactions.cooldownMs, until - Date.now());
  const cooling = wait > 0;

  useEffect(() => {
    if (!cooling) return;
    const id = setTimeout(() => force((n) => n + 1), wait + 30);
    return () => clearTimeout(id);
  }, [cooling, wait]);

  if (!view.reactions.enabled) return null;
  return (
    <ReactionBar
      className={cx('pl-rbar', cooling && 'is-cooling', className)}
      label={cooling ? 'перезаряжаем реакции…' : 'Кинуть реакцию на большой экран'}
      disabled={cooling}
      onReact={(e) => {
        actions.haptic('tap');
        setUntil(Date.now() + 3_000);
        void actions.react(e).then((r) => {
          if (r.ok) return;
          if (r.error === 'offline') toast('Реакция не долетела — связь шалит', { tone: 'info', ms: 2200 });
          else if (r.error === 'throttled') setUntil(Date.now() + Math.max(3_000, view.reactions.cooldownMs));
        });
      }}
    />
  );
}
