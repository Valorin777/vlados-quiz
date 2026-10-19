// The TV's sound against the browser's autoplay rules. Safari lets media play WITH SOUND only when
// play() was once called inside a click / key press — per ELEMENT (so the show reuses one <video>
// that «Начать шоу» blesses, media.ts) — and WebAudio needs its context resumed inside a gesture.
// If the browser still refuses the sound, the video goes on muted and the TV asks for one click
// («Нажми, чтобы включить звук», SoundAsk.tsx) — it never stays silently muted.
// No DOM types beyond the few members used: the unit tests drive it with fake elements.

/** What this module touches of a media element. */
export interface MediaLike {
  muted: boolean;
  paused: boolean;
  ended: boolean;
  isConnected: boolean;
  play(): Promise<void> | undefined;
  pause(): void;
}

let blocked = false;
/** The refused element did not even start muted: the click has to start it. */
let stuck = false;
const listeners = new Set<(b: boolean) => void>();

function setBlocked(b: boolean): void {
  if (!b) stuck = false;
  if (b === blocked) return;
  blocked = b;
  for (const fn of listeners) fn(b);
}

/** The browser refused the video's sound: the TV shows its «включить звук» prompt. */
export const soundBlocked = (): boolean => blocked;

/** The element was blessed again («Начать шоу»): no prompt. */
export const clearSoundBlock = (): void => setBlocked(false);

export function onSoundBlocked(fn: (b: boolean) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The last few sound problems (DEV `__tvSound`, the console has them too). */
export const soundLog: string[] = [];

export function soundNote(text: string, err?: unknown): void {
  const line = `${new Date().toLocaleTimeString('ru-RU')} ${text}`;
  soundLog.push(line);
  if (soundLog.length > 20) soundLog.shift();
  console.warn(`[tv-sound] ${text}`, err ?? '');
}

/** The autoplay policy said no (not an AbortError: a pause()/new source interrupted the play). */
const refused = (e: unknown): boolean => (e as { name?: unknown } | null)?.name === 'NotAllowedError';

/**
 * Plays the element with sound (or muted when the TV is muted). Refused by the autoplay policy:
 * it goes on muted — the show keeps its clock and 'ended' — and the prompt asks for a click that
 * gives the sound back. Any other failure (interrupted, a file it cannot play) is just 'failed'.
 */
export async function playVideo(v: MediaLike, muted: boolean): Promise<'sound' | 'muted' | 'failed'> {
  v.muted = muted;
  try {
    await v.play();
    if (!muted) setBlocked(false);
    return muted ? 'muted' : 'sound';
  } catch (e) {
    if (muted || !refused(e)) return 'failed';
    soundNote('браузер не дал видео играть со звуком — играет без звука, на ТВ «Нажми, чтобы включить звук»', e);
    setBlocked(true);
    v.muted = true;
    try {
      await v.play();
      return 'muted';
    } catch (e2) {
      stuck = true;
      soundNote('браузер не дал видео играть даже без звука — ждём клика', e2);
      return 'failed';
    }
  }
}

/**
 * Inside a click / key press: from now on the element may play with sound (Safari lifts the
 * restriction for THIS element when play() runs in a gesture). `resume`: it should be playing
 * (it plays on, with sound); otherwise a paused element is stopped again at once. False: play()
 * threw.
 */
export function blessMedia(v: MediaLike, { muted = false, resume = false }: { muted?: boolean; resume?: boolean } = {}): boolean {
  const wasPaused = v.paused;
  v.muted = muted;
  let p: Promise<void> | undefined;
  try {
    p = v.play();
  } catch (e) {
    soundNote('play() в клике не сработал', e);
    return false;
  }
  if (wasPaused && !resume) v.pause();
  void p?.catch((e: unknown) => {
    if (!refused(e)) return;
    soundNote('браузер отказал в звуке даже в клике', e);
    setBlocked(true);
  });
  return true;
}

/**
 * The prompt's click (or any click / key on the TV while it is up): the refused video gets its
 * sound back and keeps playing (or starts, if it could not start at all).
 */
export function unblockSound(v: MediaLike, muted: boolean): void {
  const resume = v.isConnected && ((!v.paused && !v.ended) || stuck);
  setBlocked(false);
  // a video that already ended stays on its last frame (play() would start it over); the next
  // one asks again if it has to
  if (v.ended && !resume) {
    v.muted = muted;
    return;
  }
  blessMedia(v, { muted, resume });
}
