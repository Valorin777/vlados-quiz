// Lobby: the title in chrome, a real QR on a chrome plate, the guest counter and the orbit of
// selfies — every new guest arcs in as a mercury comet and splashes into the core.

import { gsap } from 'gsap';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AvatarOrbit, ChromeText, Odometer, QRCode, audio, beats, ease, plural, type OrbitPlayer } from '../../../visual';
import type { TvView } from '../../../host';
import { currentEnv } from '../../../fb/env';
import { splitTitle, useBeat, useTvEnv } from '../common';

export const JOIN_URL = 'https://valorin777.github.io/vlados/';
export const JOIN_SHORT = 'valorin777.github.io/vlados';

const joinUrl = (): string => (currentEnv() === 'dev' ? `${JOIN_URL}?env=dev` : JOIN_URL);

function startsText(startsAt: number, now: number): { when: string; left: string | null } {
  const d = new Date(startsAt);
  const when = Number.isFinite(startsAt) && startsAt > 0 ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) : '';
  const ms = startsAt - now;
  if (!when || ms <= 30_000 || ms > 36 * 3600_000) return { when, left: null };
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return { when, left: `через ${min} ${plural(min, ['минуту', 'минуты', 'минут'])}` };
  const h = Math.floor(min / 60);
  const m = min % 60;
  return { when, left: `через ${h} ${plural(h, ['час', 'часа', 'часов'])}${m ? ` ${m} мин` : ''}` };
}

export function Lobby({ view }: { view: TvView }) {
  const env = useTvEnv();
  const root = useRef<HTMLDivElement | null>(null);
  const hero = useRef<HTMLElement | null>(null);
  const [tick, setTick] = useState<string | null>(null);
  const title = view.pub?.title || 'Кто лучше знает Владоса';
  const { kicker, hero: heroWord } = splitTitle(title);
  const heroSize = Math.min(118, 640 / Math.max(4, heroWord.length * 0.8));
  const players = useMemo<OrbitPlayer[]>(
    () => view.players.map((p) => ({ id: p.uid, name: p.name, src: env.avatars.get(p.uid) ?? null })),
    [view.players, env.avatars],
  );
  const n = view.players.length;
  const st = startsText(view.pub?.startsAt ?? 0, view.now);

  useBeat(() => {
    const q = gsap.utils.selector(root);
    const tl = gsap.timeline();
    tl.add(beats.riseLetters(hero.current, { stagger: 0.05 }), 0.15);
    tl.add(beats.fadeUp(q('.tl-fade'), { stagger: 0.07 }), 0.25);
    tl.fromTo(q('.tl-qr'), { opacity: 0, scale: 0.86, rotate: -4 }, { opacity: 1, scale: 1, rotate: 0, duration: 1, ease: ease.back }, 0.35);
    return tl;
  }, []);

  // ambient pad while guests gather
  useEffect(() => {
    if (!env.sound.music) return;
    audio.drone(true);
    return () => audio.drone(false);
  }, [env.sound.music]);

  // a lone lobby gets a gentle shimmer every few seconds so the room sees it is alive
  useEffect(() => {
    const id = setInterval(() => {
      const el = root.current?.querySelector('.tl-qr');
      if (el) gsap.fromTo(el, { '--glint': 0 }, { '--glint': 1, duration: 1.4, ease: 'power2.inOut' });
    }, 7000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="tv-scene tv-lobby" ref={root}>
      {kicker ? <p className="tl-kick tl-fade">{kicker.toLocaleLowerCase('ru-RU')}</p> : null}
      <ChromeText ref={hero} split="chars" className="tl-hero" style={{ fontSize: heroSize }}>
        {heroWord.toLocaleUpperCase('ru-RU')}
      </ChromeText>
      {view.pub?.subtitle ? <p className="tl-sub tl-fade">{view.pub.subtitle}</p> : null}
      <div className="tl-meta tl-fade">
        {st.when ? (
          <span className="vx-kick">
            старт в {st.when}
            {st.left ? <b> · {st.left}</b> : null}
          </span>
        ) : null}
      </div>
      <div className="tl-qr">
        <QRCode value={joinUrl()} size={232} />
      </div>
      <p className="tl-lnk tl-fade">{JOIN_SHORT}</p>
      <p className="tl-hint tl-fade">{env.texts.lobbyHint || 'Наведи камеру на QR-код и залетай в игру'}</p>
      <div className="tl-cnt tl-fade">
        <p className="vx-kick">уже в игре</p>
        <Odometer value={n} chrome className="tl-cnt-n" />
        <p className="tl-cnt-of">{n === 0 ? 'ждём первого смельчака' : plural(n, ['гость', 'гостя', 'гостей'])}</p>
      </div>
      <div className="tl-orbit">
        <AvatarOrbit players={players} onLand={(p) => setTick(p.name)}>
          <span className="tl-core-n vx-eng">{n}</span>
        </AvatarOrbit>
      </div>
      <p className="tl-tick" aria-live="polite">
        {tick ? (
          <span key={tick} className="tl-tick-in">
            <b>{tick}</b> <i>влетает в игру</i>
          </span>
        ) : (
          <i>ждём гостей…</i>
        )}
      </p>
    </div>
  );
}
