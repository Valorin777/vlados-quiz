// A video question before its answers open (PlayerView.watch). Videos play ONLY on the TV, with
// sound (organizer, 2026-09-23); the phone never plays them:
//   intro/play  «Смотри видео на большом экране» + a thin bar that fills over the video's length
//   beat        «Варианты появятся через 3…2…1» — counting down to openAt exactly
// then Round shows the options with the FULL timer, starting at that very moment (openAt; the
// phones open by the clock even when the host is late, see views.phoneGame).

import { gsap } from 'gsap';
import { useEffect, useRef, useState } from 'react';
import { WATCH } from '@shared/engine/watch';
import type { PlayerView, QuestionView, WatchView } from '../../host/views';
import { useEntrance } from './hooks';
import { Hud, MediaFit } from './parts';
import type { PlayerActions } from './types';
import { Badge, ChromeBlock, audio, beats } from './vx';

/** Thin progress of the video on the TV (server clock; frozen while paused). */
function WatchBar({ w, paused, actions }: { w: WatchView; paused: boolean; actions: PlayerActions }) {
  const fill = useRef<HTMLElement | null>(null);
  const cur = useRef({ w, paused });
  cur.current = { w, paused };
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const { w: x, paused: p } = cur.current;
      const pos = p ? x.posMs : Math.max(0, actions.now() - x.startAt);
      const f = x.videoMs > 0 ? Math.min(1, pos / x.videoMs) : 0;
      const el = fill.current;
      if (el) {
        el.style.transform = `scaleX(${f.toFixed(4)})`;
        el.dataset.p = f.toFixed(2);
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [actions]);
  return (
    <div className="pl-watch-bar pl-f" role="progressbar" aria-label="Видео на большом экране" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((Math.min(w.posMs, w.videoMs) / Math.max(1, w.videoMs)) * 100)}>
      <i ref={fill} />
    </div>
  );
}

/** 3, 2, 1 to openAt on the server clock (re-rendered 10× a second while `on`; `frozenMs` while paused). */
function useBeat(openAt: number, on: boolean, frozenMs: number | null, actions: PlayerActions): number {
  const [, force] = useState(0);
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => force((k) => k + 1), 100);
    return () => clearInterval(id);
  }, [on]);
  const left = frozenMs ?? openAt - actions.now();
  return Math.min(Math.round(WATCH.beatMs / 1000), Math.max(1, Math.ceil(left / 1000)));
}

export function Watch({ view, actions, q }: { view: PlayerView; actions: PlayerActions; q: QuestionView }) {
  const root = useRef<HTMLDivElement | null>(null);
  const w = view.watch as WatchView;
  const stage = w.stage;
  const paused = view.pause !== null;
  const beat = stage === 'beat';
  const n = useBeat(w.openAt, beat && !paused, paused ? (view.timer?.remainingMs ?? 0) : null, actions);
  useEntrance(() => {
    const s = gsap.utils.selector(root);
    const tl = gsap.timeline();
    tl.add(beats.fadeUp(s('.pl-f'), { stagger: 0.08 }), 0.05);
    tl.add(beats.popIn(s('.pl-intro-drop')), 0.2);
    tl.call(() => audio.rise(0.6), undefined, 0.1);
    return tl;
  });
  // a vertical clip's poster, never the video (it plays on the TV only)
  const poster = q.media?.kind === 'video' && q.media.posterId ? q.media.posterId : null;
  const ending = stage === 'play' && w.posMs >= w.videoMs;
  return (
    <div className="pl-screen pl-intro pl-watch" ref={root} data-stage={stage}>
      <Hud view={view} game />
      <div className="pl-q-top">
        <p className="vx-kick">
          вопрос {q.n} из {q.total}
        </p>
        {q.double ? (
          <Badge liquid title={view.texts.doubleBadge}>
            ×2
          </Badge>
        ) : null}
      </div>
      <div className="pl-intro-mid">
        <p className="vx-kick pl-f">{paused ? 'пауза' : beat ? 'видео закончилось' : ending ? 'видео заканчивается' : stage === 'play' ? 'идёт видео' : 'сейчас будет видео'}</p>
        <ChromeBlock shape="circle" film={q.double ? 0.95 : 0.5} className="pl-intro-drop">
          {beat ? (
            <b className="vx-eng pl-intro-n" key={n}>
              {n}
            </b>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden="true" style={{ display: 'block', width: 64, height: 64, margin: 'auto', fill: 'currentColor' }}>
              {paused ? <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" /> : <path d="M8 5.5v13l10.5-6.5z" />}
            </svg>
          )}
        </ChromeBlock>
        {beat ? (
          <p className="pl-intro-ready pl-f" aria-live="polite">
            Варианты появятся через {n}
          </p>
        ) : (
          <>
            <p className="pl-intro-ready pl-f">Смотри видео на большом экране</p>
            <WatchBar w={w} paused={paused} actions={actions} />
            <p className="pl-wait pl-f" style={{ textAlign: 'center' }}>
              Сразу после видео — варианты ответа и таймер
            </p>
          </>
        )}
      </div>
      <p className="vx-lead pl-q-title pl-f">{q.title}</p>
      {poster ? (
        <figure className="pl-qm is-video pl-f">
          <MediaFit actions={actions} id={poster} alt={q.title} w={q.media?.w} h={q.media?.h} />
        </figure>
      ) : null}
    </div>
  );
}
