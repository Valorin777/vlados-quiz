// The «Сюрприз» on a phone (PlayerView.surprise, shared/engine/surprise.ts): the video plays ONLY on
// the TV. At the moment the TV breaks down, the phone glitches too — a short RGB split, static and
// a buzz of vibration (~1 s) — then goes black, and when the video starts: «👀 Смотри на экран»,
// dark and calm (no poster: the surprise stays a surprise). Answering is off (the phase is
// 'locked'); after the video the normal reveal comes (points if answered before the interrupt,
// else «не успел»). Pure: a view in, no Firestore.

import { useEffect, useRef, useState } from 'react';
import type { PlayerView } from '../../host/views';
import { ChromeText, audio, cx } from './vx';
import './surprise.css';

type Sur = NonNullable<PlayerView['surprise']>;

/** The phone's own glitch (the TV's lasts 2.6 s; a phone only echoes it). */
export const PHONE_GLITCH_MS = 1_000;
/** The overlay fades off the reveal. */
const OUT_MS = 650;

export type SurprisePart = 'glitch' | 'black' | 'watch';

export function surprisePart(s: Sur, sinceMs = s.sinceMs): SurprisePart {
  if (s.stage === 'glitch' || s.stage === 'black') return sinceMs < PHONE_GLITCH_MS ? 'glitch' : 'black';
  return 'watch';
}

/**
 * The surprise on screen: the view's, or the last one for OUT_MS after it ended (the overlay fades
 * off the reveal instead of vanishing). `sinceMs` follows the phone's own clock between the views.
 */
export function useSurprise(view: PlayerView | null): { s: Sur; part: SurprisePart; out: boolean } | null {
  const cur = view?.surprise ?? null;
  const [gone, setGone] = useState<Sur | null>(null);
  const last = useRef<Sur | null>(cur);
  const seen = useRef<{ at: number; since: number } | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    if (cur) {
      last.current = cur;
      setGone(null);
      return;
    }
    const was = last.current;
    last.current = null;
    if (!was) return;
    setGone(was);
    const t = setTimeout(() => setGone(null), OUT_MS);
    return () => clearTimeout(t);
  }, [cur]);
  // the glitch → black switch exactly on time (the view is rebuilt only 4× a second)
  const s = cur ?? gone;
  if (cur && (!seen.current || seen.current.since > cur.sinceMs || cur.sinceMs - seen.current.since > 400)) seen.current = { at: performance.now(), since: cur.sinceMs };
  const since = cur && seen.current ? Math.max(cur.sinceMs, seen.current.since + (performance.now() - seen.current.at)) : (s?.sinceMs ?? 0);
  const part = s ? surprisePart(s, since) : null;
  useEffect(() => {
    if (part !== 'glitch' || !cur) return;
    const t = setTimeout(() => tick((x) => x + 1), Math.max(16, PHONE_GLITCH_MS - since + 5));
    return () => clearTimeout(t);
  }, [part, cur, since]);
  if (!s || !part) return null;
  return { s, part, out: !cur };
}

export function SurpriseScreen({ part, out }: { part: SurprisePart; out: boolean }) {
  // the jolt: a buzz in the hand and a crackle (when the guest has the sound on)
  const felt = useRef(false);
  useEffect(() => {
    if (part !== 'glitch' || felt.current) return;
    felt.current = true;
    try {
      navigator.vibrate?.([40, 30, 90, 40, 160]);
    } catch {
      /* iOS has no vibration API */
    }
    audio.glitchBlip();
  }, [part]);
  return (
    // always the dark chrome: a light phone must not glare in a dark room during the video
    <div className={cx('pl-sur', `is-${part}`, out && 'is-out')} data-mode="dark" role="status" aria-live="polite">
      {part === 'glitch' ? (
        <>
          <i className="pl-sur-noise" />
          <i className="pl-sur-bars" />
        </>
      ) : null}
      {part === 'watch' ? (
        <div className="pl-sur-mid">
          <span className="pl-sur-eyes" aria-hidden="true">
            👀
          </span>
          <ChromeText as="h2" size="h2" className="pl-sur-h">
            Смотри на экран
          </ChromeText>
          <p className="pl-sur-sub">Сейчас всё — на большом экране</p>
        </div>
      ) : (
        <span className="vx-sr">Смотри на экран</span>
      )}
    </div>
  );
}
