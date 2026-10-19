// The video after the final on the phone (PlayerView.finale, final step 6): it plays ONLY on the TV,
// with its own sound — the whole room watches one screen. The phone says «Смотри на экран» with the
// video's poster, a small 🎬 badge and a thin bar that follows the video by the server clock; when
// it has ended, Final shows the final screen again.

import { FINALE } from '@shared/engine/finale';
import { gsap } from 'gsap';
import { useEffect, useRef } from 'react';
import type { PlayerView } from '../../host/views';
import { FitImage } from '../../visual/ui/FitImage';
import { useEntrance, useMediaUrl } from './hooks';
import { Hud } from './parts';
import type { PlayerActions } from './types';
import { ChromeText, audio, beats } from './vx';
import './finale.css';

/** The built-in clip's poster: a file of the site next to the page (/vlados/finale-poster.jpg). */
export const builtinPosterUrl = (): string => new URL(FINALE.builtin.poster, document.baseURI).href;

/** Warms the built-in poster while the mosaic is on (≈85 KB from GitHub Pages, not Firebase). */
export function preloadFinalePoster(): void {
  const img = new Image();
  img.src = builtinPosterUrl();
}

type Finale = NonNullable<PlayerView['finale']>;

/** Follows the video on the TV (server clock; frozen while the show is held). */
function FinaleBar({ f, frozen, actions }: { f: Finale; frozen: boolean; actions: PlayerActions }) {
  const fill = useRef<HTMLElement | null>(null);
  const cur = useRef({ f, frozen });
  cur.current = { f, frozen };
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const { f: x, frozen: fr } = cur.current;
      const pos = fr ? x.posMs : Math.max(0, actions.now() - x.startAt);
      const p = x.videoMs > 0 ? Math.min(1, pos / x.videoMs) : 0;
      if (fill.current) fill.current.style.transform = `scaleX(${p.toFixed(4)})`;
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [actions]);
  return (
    <div className="pl-fv-bar pl-f" aria-hidden="true">
      <i ref={fill} />
    </div>
  );
}

export function FinaleWatch({ view, actions }: { view: PlayerView; actions: PlayerActions }) {
  const root = useRef<HTMLDivElement | null>(null);
  const f = view.finale as Finale;
  const custom = f.posterId !== null;
  const media = useMediaUrl(actions, custom ? f.posterId : null);
  const src = custom ? media.url : builtinPosterUrl();
  const frozen = view.hold !== null || view.pause !== null;
  useEntrance(() => {
    const s = gsap.utils.selector(root);
    const tl = gsap.timeline();
    tl.add(beats.fadeUp(s('.pl-f'), { stagger: 0.08 }), 0.05);
    tl.fromTo(s('.pl-fv-poster'), { scale: 0.86, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.9, ease: 'elastic.out(1,0.7)' }, 0.25);
    tl.call(() => audio.rise(0.6), undefined, 0.1);
    actions.haptic('tap');
    return tl;
  });
  return (
    <div className="pl-screen pl-final pl-fv" ref={root} data-stage={f.stage}>
      <Hud view={view} game />
      <p className="vx-kick pl-f">финал · {f.stage === 'gather' ? 'сейчас будет видео' : 'идёт видео'}</p>
      <ChromeText as="h2" size="hero" className="pl-f pl-fv-h">
        Смотри на экран
      </ChromeText>
      <p className="pl-fv-sub pl-f">Видео — на большом экране, со звуком</p>
      <figure className="pl-fv-poster" style={{ aspectRatio: `${f.w} / ${f.h}` }}>
        <FitImage src={src} failed={custom && media.failed} fit="fill" alt="Видео на большом экране" failLabel="" />
        <figcaption className="pl-fv-badge" aria-hidden="true">
          🎬
        </figcaption>
      </figure>
      <FinaleBar f={f} frozen={frozen} actions={actions} />
    </div>
  );
}
