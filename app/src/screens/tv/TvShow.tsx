// The show itself: picks the scene for the phase, keeps the reactions layer, the banner and the
// pause / connection overlays on top. Pure rendering of a TvView (live or demo fixtures).
//
// «Стоп-экран» (view.hold): only the organizer's text, still and silent. The scene stays mounted
// underneath, hidden and frozen — GSAP's global timeline paused, the liquid engine paused, the
// AudioContext suspended, every <video> paused and muted — so releasing it fades the show back in
// exactly where it stopped (a video plays on from the same frame, choreography mid-way goes on).

import { gsap } from 'gsap';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ReactionLayer, audio, cx, useLiquid, type ReactionItem } from '../../visual';
import type { TvView } from '../../host';
import { TvEnv, type TvEnvValue } from './common';
import { silenceMedia, useAvatarUrls } from './media';
import { Banner, HoldScreen, Hud, KeysHelp, OfflineOverlay, PauseOverlay, type HudMsg } from './Overlays';
import { Board } from './scenes/Board';
import { Final } from './scenes/Final';
import { Lobby } from './scenes/Lobby';
import { Question } from './scenes/Question';
import { RevealChoice } from './scenes/RevealChoice';
import { RevealNumber } from './scenes/RevealNumber';
import { RevealOrdering } from './scenes/RevealOrdering';
import { SoundAsk } from './SoundAsk';
import { SurpriseLayer } from './surprise/SurpriseLayer';

export interface TvShowProps {
  view: TvView;
  now: () => number;
  muted: boolean;
  hud?: HudMsg | null;
  help?: boolean;
  onHelpClose?: () => void;
  /** small status chip (who drives the game, DEV) */
  chip?: ReactNode;
  /** The question's video ended on this screen (live: host command 'watchEnd'). */
  onWatchEnded?: (phaseRev: number) => void;
  /** The «Сюрприз» video ended on this screen (live: host command 'surpriseEnd'). */
  onSurpriseEnded?: (phaseRev: number) => void;
  /** The reveal video ended on this screen (live: host command 'revealMediaEnd'). */
  onRevealMediaEnded?: (phaseRev: number) => void;
  /** The 🔊 button turned the sound on (the demo leaves its «Без звука» mode). */
  onSoundOn?: () => void;
}

/**
 * The question under the «Сюрприз» (phase 'locked' by the interrupt): it stays exactly as it was —
 * the options on screen, the timer frozen where the interrupt caught it — so the breakdown breaks
 * the live question (not a «Время вышло» screen), and nothing of it moves or sounds under the black.
 */
function frozenForSurprise(v: TvView): TvView {
  const q = v.question;
  const s = v.surprise;
  if (!q || !s || v.phase !== 'locked') return v;
  const total = q.timeLimitS * 1000;
  const left = Math.max(0, Math.min(total, q.openAt + total - s.at));
  return {
    ...v,
    phase: 'open',
    pause: { reason: 'admin', remainingMs: left },
    timer: { kind: 'answer', endsAt: v.now + left, remainingMs: left, totalMs: total, progress: total > 0 ? 1 - left / total : 1, paused: true },
  };
}

function sceneKey(v: TvView): string {
  const q = v.question;
  switch (v.phase) {
    case 'intro':
    case 'open':
    case 'locked':
      return `q-${q?.i ?? 0}`;
    case 'reveal':
      return `rv-${v.reveal?.i ?? q?.i ?? 0}`;
    case 'board':
      return `bd-${q?.i ?? 0}`;
    case 'final':
      return 'final';
    case 'lobby':
      return 'lobby';
    default:
      return 'none';
  }
}

function Scene({ view }: { view: TvView }) {
  const q = view.question;
  switch (view.phase) {
    case 'lobby':
      return <Lobby view={view} />;
    case 'intro':
    case 'open':
    case 'locked':
      return q ? <Question view={view} q={q} /> : null;
    case 'reveal':
      if (!q || !view.reveal) return null;
      if (q.type === 'number') return <RevealNumber view={view} q={q} />;
      if (q.type === 'ordering') return <RevealOrdering view={view} q={q} />;
      return <RevealChoice view={view} q={q} />;
    case 'board':
      return <Board view={view} q={q} />;
    case 'final':
      return <Final view={view} />;
    default:
      return (
        <div className="tv-scene tv-wait">
          <p className="vx-kick">подключаемся к игре…</p>
        </div>
      );
  }
}

/** true once `on` has held for `ms` (false again immediately). */
function useLasting(on: boolean, ms: number): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!on) {
      setHeld(false);
      return;
    }
    const t = window.setTimeout(() => setHeld(true), ms);
    return () => clearTimeout(t);
  }, [on, ms]);
  return on && held;
}

/**
 * Everything on the page stops while `held`: sound (AudioContext suspended, stays so when the tab
 * comes back), media (paused + muted), GSAP (global timeline) and, once the hold screen covers the
 * surface, the liquid engine. A layout effect: it runs before the scene's own effects could start
 * a sound or a video in the same commit (a TV page reloaded during a hold).
 */
function useStandstill(held: boolean): void {
  const { engine } = useLiquid();
  useLayoutEffect(() => {
    audio.hold(held);
    silenceMedia(held);
    freezeGsap(held);
  }, [held]);
  useEffect(
    () => () => {
      audio.hold(false);
      silenceMedia(false);
      freezeGsap(false);
    },
    [],
  );
  useEffect(() => {
    if (!held || !engine) return;
    const t = window.setTimeout(() => engine.pause(), HOLD_FADE_MS + 150);
    return () => {
      clearTimeout(t);
      engine.resume();
    };
  }, [held, engine]);
}

let gsapFrozen = false;

/** Pauses / resumes GSAP's global timeline for the hold (never resumes what someone else paused). */
function freezeGsap(on: boolean): void {
  if (on === gsapFrozen) return;
  gsapFrozen = on;
  if (on) gsap.globalTimeline.pause();
  else gsap.globalTimeline.resume();
}

/** The hold screen's fade (tv.css .tv-hold). */
const HOLD_FADE_MS = 900;

/** The text on the hold screen: live while held, then kept for its fade-out. */
function useHoldText(text: string | null): { text: string; leaving: boolean } | null {
  const [gone, setGone] = useState<string | null>(null);
  const last = useRef<string | null>(text);
  useEffect(() => {
    if (text !== null) {
      last.current = text;
      setGone(null);
      return;
    }
    const was = last.current;
    last.current = null;
    if (was === null) return;
    setGone(was);
    const t = window.setTimeout(() => setGone(null), 800);
    return () => clearTimeout(t);
  }, [text]);
  if (text !== null) return { text, leaving: false };
  return gone !== null ? { text: gone, leaving: true } : null;
}

export function TvShow({ view, now, muted, hud, help, onHelpClose, chip, onWatchEnded, onSurpriseEnded, onRevealMediaEnded, onSoundOn }: TvShowProps) {
  const avatars = useAvatarUrls(view.players);
  const { engine } = useLiquid();
  const key = sceneKey(view);
  const held = view.hold !== null;
  const surprise = view.surprise !== null;
  const env = useMemo<TvEnvValue>(
    () => ({
      now,
      avatars,
      texts: view.texts,
      vladosUid: view.vladosUid,
      sound: view.sound,
      muted,
      held,
      ...(onWatchEnded ? { onWatchEnded } : {}),
      ...(onSurpriseEnded ? { onSurpriseEnded } : {}),
      ...(onRevealMediaEnded ? { onRevealMediaEnded } : {}),
    }),
    [now, avatars, view.texts, view.vladosUid, view.sound, muted, held, onWatchEnded, onSurpriseEnded, onRevealMediaEnded],
  );
  useStandstill(held);
  const hold = useHoldText(view.hold ? view.hold.text || view.texts.paused || 'Небольшая пауза' : null);
  const reactions = useMemo<ReactionItem[]>(() => view.reactions.map((r) => ({ id: r.id, e: r.e, name: r.name })), [view.reactions]);

  // The organizer's sound settings (admin → «Звук и гости»): effects, music, volume.
  const { sfx, music, volume } = view.sound;
  useEffect(() => audio.setMix({ sfx, music, volume }), [sfx, music, volume]);

  // every scene change sends a wave through the liquid
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    engine?.ripple(640, 360, 1.3);
    audio.drop(0.55, 0.35);
  }, [key, engine]);

  // a blip of a second or two is not worth a full-screen overlay
  const offline = useLasting(!view.online && view.phase !== null, 3000);
  // (nobody watches emoji fly over the «Сюрприз»)
  const showReactions = (view.phase !== 'final' || (view.final?.step ?? 0) >= 3) && !surprise;
  const sceneView = surprise ? frozenForSurprise(view) : view;
  return (
    <TvEnv.Provider value={env}>
      <div className={cx('tv-show', `ph-${view.phase ?? 'none'}`, held && 'is-held')}>
        {/* the show; under the «стоп-экран» it waits hidden and frozen */}
        <div className="tv-live" aria-hidden={held || undefined}>
          <div key={key} className="tv-scene-wrap">
            <Scene view={sceneView} />
          </div>
          {/* held: reactions are only marked seen (max 0) — none fly in when the show returns */}
          {showReactions ? <ReactionLayer items={reactions} className="tv-rx" from={0.04} to={0.96} max={held ? 0 : 36} /> : null}
          {view.banner && !held && !surprise ? <Banner text={view.banner} /> : null}
          {view.pause && !held && view.phase !== 'lobby' ? <PauseOverlay pause={view.pause} text={view.texts.paused} /> : null}
        </div>
        {/* the «Сюрприз»: the breakdown, the black, the video, the melt into the reveal */}
        <SurpriseLayer s={view.surprise} phaseRev={view.phaseRev} round={view.question?.i ?? null} />
        {hold ? <HoldScreen text={hold.text} leaving={hold.leaving} note={held && offline ? 'переподключаемся…' : null} /> : null}
        {/* (the «Сюрприз» video plays from memory: no overlay over it) */}
        {offline && !held && !surprise ? <OfflineOverlay text={view.texts.reconnecting} /> : null}
        {help ? <KeysHelp onClose={() => onHelpClose?.()} /> : null}
        <Hud msg={hud ?? null} />
        {/* the browser refused the sound: one click on the TV gives it back; the organizer's 🔊
            button (on mouse move) over everything — the final's and the «Сюрприз» video play at full volume */}
        <SoundAsk muted={muted} held={held} volume={surprise || view.finale ? 1 : volume} black={view.surprise?.stage === 'black'} {...(onSoundOn ? { onSoundOn } : {})} />
        {chip && !held ? <div className="tv-chip">{chip}</div> : null}
      </div>
    </TvEnv.Provider>
  );
}
