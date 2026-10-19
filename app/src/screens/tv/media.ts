// TV media: question images/videos (Firestore chunks → Cache API → object URLs), guests' selfies
// (player doc bytes → object URLs, cached per uid) and the ONE persistent <video> element that is
// unlocked by the «Начать шоу» click, so every later question video can autoplay WITH sound
// (Safari lifts the gesture restriction per element, so the same element is reused everywhere).

import { gsap } from 'gsap';
import { useEffect, useMemo, useState } from 'react';
import { getFb } from '../../fb/app';
import { loadMedia, mediaUrl } from '../../fb/media';
import { audio } from '../../visual';
import { blessMedia, clearSoundBlock, playVideo as playSound, soundBlocked, unblockSound } from './sound';

// ------------------------------------------------------------------ question media

const resolved = new Map<string, string>();
const failed = new Set<string>();
const pending = new Set<string>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

/** Starts loading (idempotent); the hook re-renders when the URL is ready. */
export function requestMedia(id: string): void {
  if (resolved.has(id) || failed.has(id) || pending.has(id)) return;
  pending.add(id);
  mediaUrl(getFb().refs, id)
    .then((url) => resolved.set(id, url))
    .catch(() => failed.add(id))
    .finally(() => {
      pending.delete(id);
      emit();
    });
}

export const mediaReady = (id: string): boolean => resolved.has(id);

/** Demo fixtures: serve a ready-made URL for an id (no Firestore). */
export function seedMediaUrl(id: string, url: string): void {
  resolved.set(id, url);
  emit();
}

/** Object URL of a media file, or null while loading (`failed` when it cannot be loaded). */
export function useMediaUrl(id: string | null | undefined): { url: string | null; failed: boolean } {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!id) return;
    const fn = () => bump((n) => n + 1);
    listeners.add(fn);
    requestMedia(id);
    return () => {
      listeners.delete(fn);
    };
  }, [id]);
  if (!id) return { url: null, failed: false };
  return { url: resolved.get(id) ?? null, failed: failed.has(id) };
}

/**
 * Background warm-up of every file the show will need (sequential, so the question on air never
 * competes with 40 MB of later videos). Returns a stop function; `onProgress` reports done/total.
 */
export function prefetchAll(ids: readonly string[], onProgress?: (done: number, total: number, failedN: number) => void): () => void {
  let stop = false;
  const list = [...new Set(ids)];
  let done = 0;
  let bad = 0;
  onProgress?.(0, list.length, 0);
  void (async () => {
    for (const id of list) {
      if (stop) return;
      try {
        await loadMedia(getFb().refs, id);
      } catch {
        bad++;
      }
      done++;
      if (!stop) onProgress?.(done, list.length, bad);
    }
  })();
  return () => {
    stop = true;
  };
}

// ------------------------------------------------------------------ selfies

interface AvatarEntry {
  bytes: Uint8Array;
  key: string;
  url: string;
}
const avatars = new Map<string, AvatarEntry>();

/** Cheap identity of a JPEG (length + sampled bytes): hashing 90 × 40 KB four times a second is not. */
function bytesKey(b: Uint8Array): string {
  const n = b.length;
  let h = n;
  for (let k = 0; k < 24; k++) {
    const i = Math.floor(((k + 0.5) / 24) * n);
    h = (h * 31 + (b[i] ?? 0)) >>> 0;
  }
  return `${n}:${h}`;
}

/** Object URL for a player's selfie bytes (reused while the bytes stay the same). */
export function avatarUrl(uid: string, bytes: Uint8Array | undefined | null): string | null {
  if (!bytes || bytes.length < 16) return null;
  const have = avatars.get(uid);
  if (have && (have.bytes === bytes || have.key === bytesKey(bytes))) {
    have.bytes = bytes;
    return have.url;
  }
  if (have) URL.revokeObjectURL(have.url);
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }));
  avatars.set(uid, { bytes, key: bytesKey(bytes), url });
  return url;
}

export interface HasAvatar {
  uid: string;
  avatar?: Uint8Array;
  thumb?: Uint8Array;
}

/** uid → selfie URL for everyone on screen (big selfie, else the 64 px thumb). */
export function useAvatarUrls(players: readonly HasAvatar[]): ReadonlyMap<string, string> {
  // Recomputed only when someone's bytes change (the view is rebuilt 4× a second).
  const sig = players.map((p) => `${p.uid}:${p.avatar?.length ?? 0}:${p.thumb?.length ?? 0}`).join('|');
  return useMemo(() => {
    const out = new Map<string, string>();
    for (const p of players) {
      const url = avatarUrl(p.uid, p.avatar ?? p.thumb);
      if (url) out.set(p.uid, url);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
}

// ------------------------------------------------------------------ the persistent video

let video: HTMLVideoElement | null = null;
let unlocked = false;

export function tvVideo(): HTMLVideoElement {
  if (video) return video;
  const v = document.createElement('video');
  v.playsInline = true;
  v.preload = 'auto';
  v.className = 'tv-video';
  v.setAttribute('playsinline', '');
  v.setAttribute('webkit-playsinline', '');
  video = v;
  return v;
}

export const videoUnlocked = (): boolean => unlocked;

/**
 * 4 s of 8-bit silence as a WAV (plays in a <video> in Safari and Chrome; 32 KB). Long, so the
 * blessing stops it long before its end (a scene listening for 'ended' must never hear it).
 */
function silentWav(): string {
  const rate = 8000;
  const n = rate * 4;
  const b = new Uint8Array(44 + n);
  const dv = new DataView(b.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  dv.setUint32(4, 36 + n, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate, true);
  dv.setUint16(32, 1, true);
  dv.setUint16(34, 8, true);
  str(36, 'data');
  dv.setUint32(40, n, true);
  b.fill(128, 44);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
}

/**
 * Call inside the «Начать шоу» click: the persistent element plays silence WITH SOUND
 * (unmuted, volume up), so Safari lets it play every later video with sound (sound.ts). An
 * element that already holds a video is blessed without starting it.
 */
export function unlockVideo(): void {
  const v = tvVideo();
  if (!(v.volume > 0)) v.volume = 1;
  const fresh = !v.src;
  if (fresh) {
    v.src = silentWav();
    // the silence stops as soon as it plays: a scene's 'ended' listener must never hear it end
    const silent = v.src;
    v.addEventListener('playing', () => v.src === silent && v.pause(), { once: true });
  }
  unlocked = blessMedia(v, { resume: fresh });
  if (unlocked) clearSoundBlock();
}

/**
 * «Начать шоу» (and the demo's «Смотреть со звуком»), inside the click: the TV's sound on — a mute
 * left in this browser (the rehearsal, the M key) does not survive it — the WebAudio context
 * created and resumed, the one video element blessed.
 */
export function startTvSound(): void {
  audio.setMuted(false);
  audio.unlock();
  unlockVideo();
}

/**
 * The «Нажми, чтобы включить звук» click: the synth gets its sound, and the video if the browser
 * refused it (a video that plays fine is left alone).
 */
export function fixTvSound(muted: boolean): void {
  audio.unlock();
  const v = tvVideo();
  if (!v.src) unlockVideo();
  else if (soundBlocked()) unblockSound(v, muted);
}

/**
 * The TV's 🔊 button (SoundAsk.tsx), inside its click, at any moment of the show: what «Начать
 * шоу» does (startTvSound) without disturbing the one <video>. A video that plays — muted by the
 * browser or by the M key — gets its sound in place (no restart) at `volume` (the settings', full
 * for the final's and the «Сюрприз» video); a refused one that could not start at all starts; a
 * paused one stays where it stands; an ended one keeps its last frame (play() would start it
 * over). Under the «стоп-экран» it comes back with its sound when the hold is released.
 */
export function tvSoundOn(volume: number): void {
  const v = tvVideo();
  if (Number.isFinite(volume)) v.volume = Math.max(0, Math.min(1, volume));
  const was = silenced?.get(v);
  if (was) was.muted = false;
  if (!v.src) {
    startTvSound();
    return;
  }
  audio.setMuted(false);
  audio.unlock();
  if (soundBlocked()) unblockSound(v, false);
  else if (v.ended) v.muted = false;
  else if (blessMedia(v)) unlocked = true;
}

/** Plays the element with sound; refused by the browser → muted + the TV's prompt (sound.ts). */
export const playVideo = (v: HTMLVideoElement, muted: boolean): Promise<'sound' | 'muted' | 'failed'> => playSound(v, muted);

// ------------------------------------------------------------------ the reveal video's exit

let outro: { ghost: HTMLElement; tween: gsap.core.Tween; volume: number } | null = null;

/** Ends a running fade-out at once (a new slot takes the element): silent, paused, restored. */
export function cancelVideoOutro(): void {
  const o = outro;
  if (!o) return;
  outro = null;
  o.tween.kill();
  const v = tvVideo();
  v.pause();
  v.volume = o.volume;
  o.ghost.remove();
}

/**
 * The host moved on (reveal → board) while the reveal video still plays: instead of a hard cut,
 * a copy of its layer (`[data-outro]`, the frame as it is on screen) stays over the next scene
 * with the SAME playing element inside, and fades out with the sound in 0.9 s. Called from the
 * slot's unmount, while its DOM is still attached. false: nothing playing here (normal cleanup).
 */
export function videoOutro(host: HTMLElement | null): boolean {
  const v = tvVideo();
  if (!host || v.parentElement !== host || v.paused || v.ended) return false;
  const layer = host.closest<HTMLElement>('[data-outro]');
  const wrap = layer?.closest('.tv-scene-wrap');
  if (!layer || !wrap?.parentElement) return false;
  cancelVideoOutro();
  const ghost = layer.cloneNode(true) as HTMLElement;
  ghost.querySelectorAll('video').forEach((x) => x.remove());
  const slot = ghost.querySelector('.tv-video-host');
  if (!slot) return false;
  ghost.removeAttribute('data-outro');
  ghost.classList.add('is-outro');
  ghost.setAttribute('aria-hidden', 'true');
  wrap.after(ghost);
  slot.appendChild(v);
  const volume = v.volume;
  const tween = gsap.to(ghost, {
    opacity: 0,
    scale: 0.96,
    duration: 0.9,
    ease: 'power1.inOut',
    onUpdate: () => {
      v.volume = Math.max(0, Math.min(1, volume * (1 - tween.progress())));
    },
    onComplete: () => {
      if (outro?.tween !== tween) return;
      outro = null;
      v.pause();
      v.remove();
      v.volume = volume;
      ghost.remove();
    },
  });
  outro = { ghost, tween, volume };
  return true;
}

// ------------------------------------------------------------------ «стоп-экран»

let silenced: Map<HTMLMediaElement, { muted: boolean; playing: boolean }> | null = null;
let onPlay: ((e: Event) => void) | null = null;

/**
 * The organizer's «стоп-экран»: every <video>/<audio> of the page (the persistent question video,
 * a reveal video, one fading out over the next scene) is paused and muted, and anything that tries
 * to start while held is stopped again at once. Released: each gets its sound back and plays on
 * from where it stood if it was playing. The scenes' own `play` props agree (TvEnv.held).
 */
export function silenceMedia(on: boolean): void {
  if (on === (silenced !== null)) return;
  if (on) {
    const els = new Set<HTMLMediaElement>(document.querySelectorAll<HTMLMediaElement>('video, audio'));
    if (video) els.add(video);
    const was = new Map<HTMLMediaElement, { muted: boolean; playing: boolean }>();
    for (const el of els) {
      was.set(el, { muted: el.muted, playing: !el.paused && !el.ended });
      el.pause();
      el.muted = true;
    }
    silenced = was;
    // capture: a media 'play' event does not bubble
    onPlay = (e: Event) => {
      const el = e.target;
      if (!(el instanceof HTMLMediaElement)) return;
      if (!silenced?.has(el)) silenced?.set(el, { muted: el.muted, playing: false });
      el.pause();
      el.muted = true;
    };
    document.addEventListener('play', onPlay, true);
    return;
  }
  const was = silenced;
  silenced = null;
  if (onPlay) document.removeEventListener('play', onPlay, true);
  onPlay = null;
  for (const [el, st] of was ?? []) {
    el.muted = st.muted;
    if (st.playing && el.isConnected && el.paused && !el.ended) void el.play().catch(() => undefined);
  }
}

/** Every media element of the page and what it does (DEV checks of the «стоп-экран»). */
export function mediaState(): { tag: string; src: string; paused: boolean; muted: boolean; volume: number; t: number; attached: boolean }[] {
  const els = new Set<HTMLMediaElement>(document.querySelectorAll<HTMLMediaElement>('video, audio'));
  if (video) els.add(video);
  return [...els].map((el) => ({ tag: el.tagName.toLowerCase(), src: el.currentSrc.slice(0, 40), paused: el.paused, muted: el.muted, volume: el.volume, t: Math.round(el.currentTime * 1000) / 1000, attached: el.isConnected }));
}
