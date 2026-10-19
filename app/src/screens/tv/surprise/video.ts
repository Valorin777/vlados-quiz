// The «Сюрприз» video on the TV (shared/engine/surprise.ts). The built-in one is a file of the site
// (app/public/surprise.mp4 → /vlados/surprise.mp4 on GitHub Pages, + surprise-poster.jpg, its first
// frame), registered in the TV media store under fixed ids so the layer treats it like an upload.
// The TV loads it WHOLE into memory (a blob URL, ≈24 MB) as soon as it knows a question has it —
// the moment itself never waits for the network — with progress for the start screen.

import { SURPRISE } from '@shared/engine/surprise';
import type { Question } from '@shared/types';
import { siteFile } from '../finale';
import { seedMediaUrl } from '../media';

/** Media-store ids of the built-in video (never a Firestore id: those have no '~'). */
export const SURPRISE_VIDEO_ID = '~surprise';
export const SURPRISE_POSTER_ID = '~surprise-poster';

let seeded = false;

/** The built-in video and its poster as media-store URLs (the static files until preloaded). */
export function seedBuiltinSurprise(): void {
  if (seeded) return;
  seeded = true;
  seedMediaUrl(SURPRISE_VIDEO_ID, siteFile(SURPRISE.builtin.file));
  seedMediaUrl(SURPRISE_POSTER_ID, siteFile(SURPRISE.builtin.poster));
}

/** The layer has the video on air: its URL must not change under the playing element. */
let onAir = false;
export function surpriseOnAir(on: boolean): void {
  onAir = on;
}

export interface SurpriseLoad {
  state: 'idle' | 'loading' | 'ready' | 'failed';
  /** Bytes so far / total (0 when unknown). */
  done: number;
  total: number;
}

let load: SurpriseLoad = { state: 'idle', done: 0, total: 0 };
const listeners = new Set<(l: SurpriseLoad) => void>();
const set = (l: SurpriseLoad) => {
  load = l;
  for (const fn of listeners) fn(l);
};

export const surpriseLoad = (): SurpriseLoad => load;

export function onSurpriseLoad(fn: (l: SurpriseLoad) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let job: Promise<boolean> | null = null;

/**
 * The whole built-in video into memory (streamed, with progress) and its poster decoded. Resolves
 * true once it is in memory; a failed load keeps the static URL (the element then streams it from
 * the site) and is retried at the next call.
 */
export function preloadBuiltinSurprise(): Promise<boolean> {
  seedBuiltinSurprise();
  job ??= (async () => {
    const img = new Image();
    img.src = siteFile(SURPRISE.builtin.poster);
    set({ state: 'loading', done: 0, total: 0 });
    try {
      const r = await fetch(siteFile(SURPRISE.builtin.file));
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      const total = Number(r.headers.get('content-length') ?? 0) || 0;
      const reader = r.body.getReader();
      const parts: Uint8Array[] = [];
      let done = 0;
      let last = 0;
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        parts.push(value);
        done += value.length;
        if (performance.now() - last > 250) {
          last = performance.now();
          set({ state: 'loading', done, total });
        }
      }
      const blob = new Blob(parts as BlobPart[], { type: 'video/mp4' });
      if (!onAir) seedMediaUrl(SURPRISE_VIDEO_ID, URL.createObjectURL(blob));
      set({ state: 'ready', done, total: total || done });
      return true;
    } catch {
      job = null;
      set({ state: 'failed', done: 0, total: 0 });
      return false;
    }
  })();
  return job;
}

/** Some enabled question plays the built-in video (the TV then loads it ahead). */
export const needsBuiltinSurprise = (questions: readonly Question[] | undefined): boolean =>
  (questions ?? []).some((q) => !q.disabled && q.surprise?.on && q.surprise.src !== 'custom');

/** Media ids the TV warms for the «Сюрприз» (uploaded videos and their posters). */
export function surpriseWarmIds(questions: readonly Question[] | undefined, posterOf: (id: string) => string | undefined): string[] {
  const out: string[] = [];
  for (const q of questions ?? []) {
    const s = q.surprise;
    if (q.disabled || !s?.on || s.src !== 'custom' || !s.mediaId) continue;
    const poster = posterOf(s.mediaId);
    if (poster) out.push(poster);
    out.push(s.mediaId);
  }
  return out;
}
