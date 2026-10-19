// «Нажми, чтобы включить звук»: the browser refused the TV's sound — a video had to go on muted
// (sound.ts), or the WebAudio context stays suspended after a tab switch (the organizer played a
// clip in another tab during a «стоп-экран»). The context is woken on focus / visibility by
// itself; if that does not help, one click or key press anywhere on the TV fixes it: inside that
// gesture the context resumes and the one video element gets its sound back.
//
// And the organizer's own 🔊 button, bottom right, over everything (the «стоп-экран» too): it shows
// when the mouse moves (or on Tab / the M key) and hides with the cursor after 3 s (useIdleCursor),
// so the guests do not see it during the show. Its click is «Начать шоу» for the sound again
// (media.tvSoundOn): the device mute off, WebAudio resumed, a playing video unmuted in place. While
// the sound is refused (the prompt's condition) it shows 🔇, highlighted, and stays up — except on
// the 2 s black before the «Сюрприз» video (only the mouse brings it there).

import { useCallback, useEffect, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { LiquidOff, audio, cx } from '../../visual';
import { fixTvSound, tvSoundOn } from './media';
import { onSoundBlocked, soundBlocked, soundNote } from './sound';

/** The context is checked every CHECK_MS; suspended MISSES checks in a row → the prompt. */
const CHECK_MS = 1_000;
const MISSES = 3;
/** Tab / M: the button stays up this long (the mouse: html.tv-nocursor, useIdleCursor). */
const AWAKE_MS = 3_000;

const onButton = (e: Event): boolean => e.target instanceof Element && e.target.closest('.tv-sound-btn') !== null;

export interface SoundAskProps {
  muted: boolean;
  held: boolean;
  /** The volume the TV's <video> plays at now (the settings', 1 for the final's / «Сюрприз» video). */
  volume: number;
  /** The 2 s black before the «Сюрприз» video: the button only on mouse move. */
  black?: boolean;
  /** The 🔊 button turned the sound on (the demo leaves its «Без звука» mode). */
  onSoundOn?: () => void;
}

export function SoundAsk({ muted, held, volume, black = false, onSoundOn }: SoundAskProps) {
  const [video, setVideo] = useState(soundBlocked);
  useEffect(() => onSoundBlocked(setVideo), []);

  // the context: woken when the TV tab comes back; asked for when it does not come back by itself
  const [ctxOff, setCtxOff] = useState(false);
  useEffect(() => {
    let misses = 0;
    const check = () => {
      const s: string = audio.state;
      if ((s !== 'suspended' && s !== 'interrupted') || audio.isHeld || document.hidden || muted) {
        misses = 0;
        setCtxOff(false);
        return;
      }
      audio.wake();
      if (++misses === MISSES) {
        soundNote(`звук игры остановлен браузером (AudioContext: ${s}) — на ТВ «Нажми, чтобы включить звук»`);
        setCtxOff(true);
      }
    };
    const wake = () => audio.wake();
    const t = window.setInterval(check, CHECK_MS);
    addEventListener('focus', wake);
    addEventListener('pageshow', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      clearInterval(t);
      removeEventListener('focus', wake);
      removeEventListener('pageshow', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [muted]);

  const ask = !held && !muted && (video || ctxOff);
  const fix = useCallback(
    (e: Event) => {
      // the 🔊 button does it all itself
      if (onButton(e)) return;
      fixTvSound(muted);
      setCtxOff(false);
    },
    [muted],
  );

  // any click or key on the TV while it is up (the organizer need not aim at the pill); click and
  // keydown, not pointerdown: those are the gestures every browser lets start sound
  useEffect(() => {
    if (!ask) return;
    addEventListener('click', fix, true);
    addEventListener('keydown', fix, true);
    return () => {
      removeEventListener('click', fix, true);
      removeEventListener('keydown', fix, true);
    };
  }, [ask, fix]);

  // Tab / M: the button shows for a moment (the mouse wakes it through html.tv-nocursor)
  const [awake, setAwake] = useState(false);
  useEffect(() => {
    let t = 0;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.code !== 'KeyM' && e.code !== 'Tab') return;
      setAwake(true);
      clearTimeout(t);
      t = window.setTimeout(() => setAwake(false), AWAKE_MS);
    };
    addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      removeEventListener('keydown', onKey);
    };
  }, []);

  const soundOn = (e: MouseEvent<HTMLButtonElement>) => {
    tvSoundOn(volume);
    setCtxOff(false);
    onSoundOn?.();
    // a mouse click leaves no focus behind: the show's Space / Enter must not press it again
    if (e.detail > 0) e.currentTarget.blur();
  };
  // focused by Tab: Enter / Space press the button, not the show's keys
  const ownKeys = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') e.stopPropagation();
  };

  const off = muted || ask;
  const sticky = ask && !black;
  return (
    <>
      {ask ? (
        <LiquidOff>
          <button type="button" className="tv-sound-ask" role="alert">
            <span aria-hidden="true">🔇</span> Нажми, чтобы включить звук
          </button>
        </LiquidOff>
      ) : null}
      <button
        type="button"
        className={cx('tv-sound-btn lq lq-circle', off && 'is-off', sticky && 'is-ask', awake && 'is-awake')}
        title="Звук"
        aria-label="Звук"
        aria-pressed={!off}
        onClick={soundOn}
        onKeyDown={ownKeys}
      >
        <span aria-hidden="true">{off ? '🔇' : '🔊'}</span>
      </button>
    </>
  );
}
