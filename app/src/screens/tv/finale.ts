// The video after the final on the TV (shared/engine/finale.ts). The built-in clip is a file of the
// site (app/public/finale.mp4 → /vlados/finale.mp4 on GitHub Pages, + finale-poster.jpg): it is
// registered in the TV media store under fixed ids, so the scene treats it like an uploaded video.
// «Начать шоу» loads it whole into memory (a blob URL) — the end of the party never waits for the
// network — and an uploaded one is warmed with the rest of the show's media (TvApp).

import { FINALE } from '@shared/engine/finale';
import type { Settings } from '@shared/types';
import { seedMediaUrl } from './media';

/** Media-store ids of the built-in clip (never a Firestore id: those have no '~'). */
export const BUILTIN_VIDEO_ID = '~finale';
export const BUILTIN_POSTER_ID = '~finale-poster';

/** A file of the site next to the page (works on /vlados/ and on the dev server's root). */
export const siteFile = (file: string): string => new URL(file, document.baseURI).href;

let seeded = false;

/** The built-in clip and its poster as media-store URLs (the static files until preloaded). */
export function seedBuiltinFinale(): void {
  if (seeded) return;
  seeded = true;
  seedMediaUrl(BUILTIN_VIDEO_ID, siteFile(FINALE.builtin.file));
  seedMediaUrl(BUILTIN_POSTER_ID, siteFile(FINALE.builtin.poster));
}

/** The scene has the clip on air: its URL must not change under the playing element. */
let onAir = false;
export function finaleOnAir(on: boolean): void {
  onAir = on;
}

let loading: Promise<boolean> | null = null;

/**
 * «Начать шоу»: the whole built-in clip into memory (≈3 MB) and its poster decoded. Resolves true
 * once the clip is in memory; a failed load keeps the static URL and is retried at the next call.
 */
export function preloadBuiltinFinale(): Promise<boolean> {
  seedBuiltinFinale();
  loading ??= (async () => {
    const img = new Image();
    img.src = siteFile(FINALE.builtin.poster);
    void img.decode().catch(() => undefined);
    // the backdrop's soft copy, ready long before the finale
    void softPoster(siteFile(FINALE.builtin.poster));
    try {
      const r = await fetch(siteFile(FINALE.builtin.file));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      if (!onAir) seedMediaUrl(BUILTIN_VIDEO_ID, URL.createObjectURL(new Blob([blob], { type: 'video/mp4' })));
      return true;
    } catch {
      loading = null;
      return false;
    }
  })();
  return loading;
}

/** Media ids the TV warms for the video after the final (an uploaded one; the built-in is preloaded). */
export function finaleWarmIds(settings: Partial<Pick<Settings, 'finaleVideo' | 'finaleMediaId'>> | undefined, posterOf: (id: string) => string | undefined): string[] {
  if (settings?.finaleVideo !== 'custom' || !settings.finaleMediaId) return [];
  const poster = posterOf(settings.finaleMediaId);
  return poster ? [settings.finaleMediaId, poster] : [settings.finaleMediaId];
}

// ------------------------------------------------------------------ the ambient backdrop

const softCache = new Map<string, Promise<string | null>>();

/** Three box blurs ≈ one Gaussian (σ ≈ r); RGB only, in place on `px` (w × h, RGBA). */
function boxBlur3(px: Uint8ClampedArray, w: number, h: number, r: number): void {
  const tmp = new Float32Array(Math.max(w, h) * 3);
  const pass = (len: number, count: number, at: (line: number, i: number) => number) => {
    for (let line = 0; line < count; line++) {
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let i = -r; i <= r; i++) acc += px[at(line, Math.min(len - 1, Math.max(0, i))) + c] as number;
        for (let i = 0; i < len; i++) {
          tmp[i * 3 + c] = acc / (2 * r + 1);
          acc += (px[at(line, Math.min(len - 1, i + r + 1)) + c] as number) - (px[at(line, Math.max(0, i - r)) + c] as number);
        }
      }
      for (let i = 0; i < len; i++) for (let c = 0; c < 3; c++) px[at(line, i) + c] = tmp[i * 3 + c] as number;
    }
  };
  for (let k = 0; k < 3; k++) {
    pass(w, h, (y, x) => (y * w + x) * 4);
    pass(h, w, (x, y) => (y * w + x) * 4);
  }
}

/**
 * The frame's ambient backdrop: the poster blurred, saturated and darkened ONCE into a small
 * picture that the stage scales up (a CSS blur(42px) saturate brightness over the whole 4K stage
 * was redone on every frame of the video: it dropped frames and the frame opened with a ~0.7 s
 * GPU freeze). The blur is ~3 % of the poster's width, like the CSS one at the stage's scale.
 * Null when the picture cannot be read (the backdrop keeps its plain gradient).
 */
export function softPoster(src: string): Promise<string | null> {
  let job = softCache.get(src);
  if (!job) {
    job = (async () => {
      // 'load', not decode(): decode() never settles while the page is hidden (a TV tab in the
      // background), drawImage below decodes a loaded picture by itself
      const img = new Image();
      await new Promise<void>((ok, fail) => {
        img.onload = () => ok();
        img.onerror = () => fail(new Error('poster'));
        img.src = src;
      });
      const w0 = img.naturalWidth;
      const h0 = img.naturalHeight;
      if (!w0 || !h0) return null;
      const w = 96;
      const h = Math.max(8, Math.min(320, Math.round((w * h0) / w0)));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h);
      const px = data.data;
      boxBlur3(px, w, h, 3);
      // saturate(1.35) brightness(0.62), the CSS filter's colour matrix (Rec. 709 luma)
      const s = 1.35;
      const b = 0.62;
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i] as number;
        const g = px[i + 1] as number;
        const bl = px[i + 2] as number;
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
        px[i] = (l + (r - l) * s) * b;
        px[i + 1] = (l + (g - l) * s) * b;
        px[i + 2] = (l + (bl - l) * s) * b;
      }
      ctx.putImageData(data, 0, 0);
      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
      return blob ? URL.createObjectURL(blob) : null;
    })().catch(() => null);
    softCache.set(src, job);
  }
  return job;
}
