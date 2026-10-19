// The «Сюрприз» on the TV (shared/engine/surprise.ts → TvView.surprise), over the whole show:
//
//   glitch  «сбой эфира» (breakdown.ts): the Liquid Chrome world freezes, splits, tears, shatters
//           into mercury beads and switches off like an old CRT — with its sound
//   black   pure black, total silence (the game's sound is ducked, the liquid engine sees the
//           opaque layer and stops drawing)
//   play    the video fades up from black: full height, its own proportions, centred over a
//           blurred, darkened copy of itself (no bars), WITH SOUND at full volume on the persistent
//           unlocked element; its 'ended' tells the host (→ the reveal)
//   melt    the stage is over (the reveal is on air): the frame turns to mercury, rounds into a
//           drop, splashes into the liquid, and the black fades off the reveal
//
// Driven by the server clock (TvView.surprise.stage / sinceMs / posMs): a TV that reloads or a
// rehearsal that jumps joins at the right point (mid-glitch, the black, mid-video). «Стоп-экран»:
// the video pauses on its frame (TvShow silences every media element) and plays on when released.

import { SURPRISE } from '@shared/engine/surprise';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { audio, cx, useLiquid } from '../../../visual';
import type { SurpriseView } from '../../../host';
import { useTvEnv } from '../common';
import { W as STAGE_W, H as STAGE_H } from '../TvStage';
import { cancelVideoOutro, playVideo, tvVideo, useMediaUrl } from '../media';
import { releaseDark, runBreakdown } from './breakdown';
import { SURPRISE_POSTER_ID, SURPRISE_VIDEO_ID, seedBuiltinSurprise, surpriseOnAir } from './video';
import './surprise.css';

seedBuiltinSurprise();

type Mode = 'off' | 'glitch' | 'black' | 'play' | 'melt';

/** The melt into the reveal (ms). */
const MELT_MS = 1_700;
/** A video that cannot be loaded or played: the stage ends this long after (not minutes of black). */
const GIVE_UP_MS = 3_000;
/** The end is reported again while the host has not moved on (offline, a lost transaction). */
const RETRY_MS = 4_000;

const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export interface SurpriseLayerProps {
  s: SurpriseView | null;
  phaseRev: number;
  /** The round on air (a new round never inherits a running layer). */
  round: number | null;
}

export function SurpriseLayer({ s, phaseRev, round }: SurpriseLayerProps) {
  const env = useTvEnv();
  const { engine } = useLiquid();
  const [mode, setMode] = useState<Mode>('off');
  const [last, setLast] = useState<SurpriseView | null>(null);
  const modeRef = useRef<Mode>('off');
  modeRef.current = mode;
  const fx = useRef<HTMLCanvasElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const [glitchDone, setGlitchDone] = useState(false);
  /** The video part was reached (a melt from the black alone has no frame to melt). */
  const [shown, setShown] = useState(false);
  const roundRef = useRef(round);

  // ---- the stage by the clock → the layer's mode
  const stage = s?.stage ?? null;
  useLayoutEffect(() => {
    if (s) setLast(s);
    const m = modeRef.current;
    if (s) {
      roundRef.current = round;
      if (m === 'off' || m === 'melt') {
        // just began (a breakdown still worth showing), or joined later: straight to its part
        setGlitchDone(false);
        setShown(false);
        setMode(s.stage === 'glitch' && s.sinceMs < SURPRISE.glitchMs - 250 ? 'glitch' : s.stage === 'black' || s.stage === 'glitch' ? 'black' : 'play');
      } else if (m === 'glitch' && s.stage !== 'glitch') setMode(s.stage === 'black' ? 'black' : 'play');
      else if (m === 'black' && (s.stage === 'play' || s.stage === 'after')) setMode('play');
      return;
    }
    // the stage is over: the reveal came (the video ended, «к ответу») → melt; anything else
    // (skipped, a rehearsal jumping back) → off at once
    if (m === 'off' || m === 'melt') return;
    setMode(round === roundRef.current && (m === 'play' || m === 'black') ? 'melt' : 'off');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, s !== null, round]);

  // the breakdown finished by its own clock: black
  useEffect(() => {
    if (glitchDone && mode === 'glitch') setMode('black');
  }, [glitchDone, mode]);
  useEffect(() => {
    if (mode === 'play') setShown(true);
  }, [mode]);

  // the melt ends: off
  useEffect(() => {
    if (mode !== 'melt') return;
    const t = setTimeout(() => setMode('off'), reducedMotion() ? 700 : MELT_MS);
    return () => clearTimeout(t);
  }, [mode]);

  // the TV's black letterbox and the game's silence while it runs
  const on = mode !== 'off';
  useEffect(() => {
    if (!on) return;
    return () => {
      releaseDark();
      audio.duck(false);
    };
  }, [on]);
  useEffect(() => {
    if (mode === 'black' || mode === 'play') audio.duck(true);
    if (mode === 'melt') audio.duck(false);
  }, [mode]);

  // ---- the breakdown
  const held = env.held === true;
  const sRef = useRef(s);
  sRef.current = s;
  useLayoutEffect(() => {
    if (mode !== 'glitch' || held) return;
    const stageEl = root.current?.closest('.tv-stage') as HTMLElement | null;
    const live = root.current?.closest('.tv-show')?.querySelector<HTMLElement>(':scope > .tv-live') ?? null;
    if (!stageEl || !fx.current) {
      setGlitchDone(true);
      return;
    }
    const from = sRef.current?.sinceMs ?? 0;
    const reduced = reducedMotion();
    if (env.sound.sfx && from < 400) audio.breakdown(from / 1000, SURPRISE.glitchMs / 1000);
    const b = runBreakdown({ stage: stageEl, live, fx: fx.current, engine, fromMs: from, durMs: SURPRISE.glitchMs, reduced, seed: sRef.current?.at ?? 1 });
    const t = setTimeout(() => setGlitchDone(true), Math.max(0, SURPRISE.glitchMs - from));
    return () => {
      clearTimeout(t);
      b.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, held]);

  if (mode === 'off') return null;
  const v = s ?? last;
  return (
    <div ref={root} className={cx('tsu', `is-${mode}`)} aria-hidden="true">
      {mode === 'glitch' ? (
        <>
          <canvas ref={fx} className="tsu-fx" />
          <i className="tsu-scan" />
        </>
      ) : v ? (
        <SurpriseVideo s={v} live={s} leaving={mode === 'melt'} phaseRev={phaseRev} showVideo={mode === 'play' || (mode === 'melt' && shown)} />
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ the video

/** A blurred, darkened copy of the playing video behind its frame (tiny canvas, scaled up). */
function useAmbient(canvas: React.RefObject<HTMLCanvasElement | null>, active: boolean): void {
  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx || !active) return;
    const tiny = document.createElement('canvas');
    tiny.width = 9;
    tiny.height = 16;
    const tctx = tiny.getContext('2d');
    let raf = 0;
    let lastAt = 0;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (now - lastAt < 50) return;
      lastAt = now;
      const v = tvVideo();
      if (!tctx || v.readyState < 2 || !v.videoWidth) return;
      try {
        // the video's colours, a few px big: its middle band covers the 16:9 stage
        tctx.drawImage(v, 0, 0, tiny.width, tiny.height);
        const sh = (tiny.width * c.height) / c.width;
        ctx.globalAlpha = 0.28;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(tiny, 0, (tiny.height - sh) / 2, tiny.width, sh, 0, 0, c.width, c.height);
        ctx.globalAlpha = 1;
      } catch {
        // a tainted or not yet decodable frame: keep the last one
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [canvas, active]);
}

function SurpriseVideo({ s, live, leaving, phaseRev, showVideo }: { s: SurpriseView; live: SurpriseView | null; leaving: boolean; phaseRev: number; showVideo: boolean }) {
  const env = useTvEnv();
  const { engine } = useLiquid();
  const { muted, held = false } = env;
  const custom = s.videoId !== null;
  const { url, failed } = useMediaUrl(custom ? s.videoId : SURPRISE_VIDEO_ID);
  const host = useRef<HTMLDivElement | null>(null);
  const amb = useRef<HTMLCanvasElement | null>(null);
  const [on, setOn] = useState(false);
  const [ended, setEnded] = useState<number | null>(null);
  const joinMs = useRef(s.stage === 'play' && s.posMs > 1_000 ? s.posMs : 0);
  const onEnded = useRef(env.onSurpriseEnded);
  onEnded.current = env.onSurpriseEnded;
  const revRef = useRef(phaseRev);
  revRef.current = phaseRev;

  // the ONE unlocked element moves into this frame (and out again when the layer goes)
  useLayoutEffect(() => {
    if (!showVideo) return;
    const v = tvVideo();
    cancelVideoOutro();
    surpriseOnAir(true);
    host.current?.appendChild(v);
    const playing = () => setOn(true);
    const end = () => setEnded((t) => t ?? Date.now());
    v.addEventListener('playing', playing);
    v.addEventListener('ended', end);
    return () => {
      v.removeEventListener('playing', playing);
      v.removeEventListener('ended', end);
      v.pause();
      v.remove();
      surpriseOnAir(false);
    };
  }, [showVideo]);

  useEffect(() => {
    if (!showVideo || !url) return;
    const v = tvVideo();
    const seek = () => {
      const at = joinMs.current / 1000;
      if (at > 0 && Number.isFinite(v.duration) && at < v.duration - 0.3) v.currentTime = at;
    };
    if (v.src !== url) {
      setOn(false);
      v.src = url;
      v.addEventListener('loadedmetadata', seek, { once: true });
      v.load();
    } else if (v.readyState >= 1) seek();
    const bad = () => setTimeout(() => setEnded((t) => t ?? Date.now()), GIVE_UP_MS);
    v.addEventListener('error', bad);
    return () => v.removeEventListener('error', bad);
  }, [url, showVideo]);

  // full volume: the video's own soundtrack (the TV's M key still wins)
  useEffect(() => {
    const v = tvVideo();
    v.volume = 1;
    v.muted = muted;
  }, [muted]);

  const play = showVideo && !leaving && ended === null && url !== null;
  useEffect(() => {
    const v = tvVideo();
    if (!showVideo || !url) return;
    if (play && !held) void playVideo(v, muted);
    else if (!leaving) v.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [play, held, url, showVideo]);

  // a file that cannot be loaded at all: the show goes on
  useEffect(() => {
    if (!failed || !showVideo) return;
    const t = setTimeout(() => setEnded((x) => x ?? Date.now()), GIVE_UP_MS);
    return () => clearTimeout(t);
  }, [failed, showVideo]);
  // joined after the video should have ended (a reload at the very end): it has ended — unless the
  // element still plays it (started late): then its own 'ended' tells
  useEffect(() => {
    if (live?.stage !== 'after' || held) return;
    const v = tvVideo();
    if (!v.isConnected || v.paused || v.ended || v.error) setEnded((x) => x ?? Date.now());
  }, [live?.stage, held]);

  // ---- the end: tell the host (again while it has not moved on)
  useEffect(() => {
    if (ended === null || !live || held) return;
    onEnded.current?.(revRef.current);
    const t = setTimeout(() => setEnded(Date.now()), RETRY_MS);
    return () => clearTimeout(t);
  }, [ended, live, held]);

  useAmbient(amb, showVideo && !leaving);

  // ---- the melt: the sound fades with the frame; the drop splashes into the liquid
  useEffect(() => {
    if (!leaving) return;
    const v = tvVideo();
    const vol0 = v.volume;
    const t0 = performance.now();
    let raf = 0;
    const fade = () => {
      const k = Math.min(1, (performance.now() - t0) / 900);
      v.volume = Math.max(0, vol0 * (1 - k));
      if (k < 1) raf = requestAnimationFrame(fade);
      else v.pause();
    };
    raf = requestAnimationFrame(fade);
    const splash = setTimeout(() => {
      audio.drop(0.55, 0.5);
      if (engine) {
        engine.splash(STAGE_W / 2, STAGE_H / 2, 70, 14, true);
        engine.ripple(STAGE_W / 2, STAGE_H / 2, 1.5);
      }
    }, reducedMotion() ? 0 : 1_050);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(splash);
      v.volume = vol0;
    };
  }, [leaving, engine]);

  const ar = Math.min(2.4, Math.max(0.45, s.w / s.h));
  // the circle the frame melts into: as wide as a portrait frame, as tall as a wide one
  const inset = ar < 1 ? `${(((1 - ar) / 2) * 100).toFixed(2)}% 0%` : `0% ${(((1 - 1 / ar) / 2) * 100).toFixed(2)}%`;
  const style = { '--media-ar': ar, '--melt-clip': `inset(${inset} ${inset} round 50%)` } as CSSProperties;
  return (
    <div className={cx('tsu-v', showVideo && 'is-up', on && 'is-playing', leaving && 'is-leaving', ar < 0.9 ? 'is-portrait' : 'is-wide')} style={style}>
      <div className="tsu-back">
        <canvas ref={amb} className="tsu-amb" width={64} height={36} />
        <i className="tsu-vig" />
      </div>
      {showVideo ? (
        <div className="tsu-frame">
          <div ref={host} className="tsu-host" />
          <i className="tsu-merc" />
        </div>
      ) : null}
    </div>
  );
}

/** The built-in video's poster id (the admin preview and the rehearsal use it). */
export { SURPRISE_POSTER_ID };
