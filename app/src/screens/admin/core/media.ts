// Admin media pipeline (docs/firebase.md → Media): decode → resize → encode in the browser, then
// upload through app/src/fb/media.ts (chunks + meta).
//   images: longest side ≤ 1600 px, JPEG q 0.82 (Safari cannot encode WebP)
//   videos: WebCodecs via mediabunny → MP4 H.264/AAC ≤ 1280×720, ~2 Mbps, plus a JPEG poster;
//           without WebCodecs the original is accepted up to 40 MB. Hard cap 45 MB.

import type { MediaMetaDoc } from '@shared/fbtypes';
import { useEffect, useState } from 'react';
import type { MediaBackend } from './backend';
import { useAdmin } from './session';

export const IMAGE_MAX_PX = 1600;
export const JPEG_Q = 0.82;
export const VIDEO_BOX = { long: 1280, short: 720 } as const;
export const VIDEO_BITRATE = 2_000_000;
export const ORIGINAL_MAX_BYTES = 40 * 1024 * 1024;
export const VIDEO_MAX_BYTES = 45 * 1024 * 1024;

export type MediaStage = 'reading' | 'converting' | 'uploading' | 'done';
export interface MediaProgress {
  stage: MediaStage;
  /** 0..1 over the whole job */
  p: number;
  note?: string;
}

export interface UploadedMedia {
  id: string;
  kind: 'image' | 'video';
  w: number;
  h: number;
  posterId?: string;
  durationS?: number;
  bytes: number;
}

export class MediaError extends Error {}

const isVideo = (f: Blob): boolean => f.type.startsWith('video/') || /\.(mov|mp4|m4v|webm|3gp)$/i.test((f as File).name ?? '');
const isImage = (f: Blob): boolean => f.type.startsWith('image/') || /\.(jpe?g|png|heic|heif|webp|gif|avif)$/i.test((f as File).name ?? '');

// ---------- images ----------

async function decodeImage(file: Blob): Promise<{ src: CanvasImageSource; w: number; h: number; close: () => void }> {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { src: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close() };
  } catch {
    // e.g. HEIC outside Safari fails above; an <img> sometimes still decodes it
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      return { src: img, w: img.naturalWidth, h: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
    } catch {
      URL.revokeObjectURL(url);
      throw new MediaError('Не получилось открыть картинку. Попробуй JPG или PNG.');
    }
  }
}

function canvasToJpeg(canvas: HTMLCanvasElement, q = JPEG_Q): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new MediaError('Не удалось сжать картинку'))), 'image/jpeg', q),
  );
}

/** Draws `src` into a canvas of at most `max` px on the longest side. */
function drawScaled(src: CanvasImageSource, w: number, h: number, max: number): HTMLCanvasElement {
  const k = Math.min(1, max / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * k));
  const ch = Math.max(1, Math.round(h * k));
  const c = document.createElement('canvas');
  c.width = cw;
  c.height = ch;
  const g = c.getContext('2d');
  if (!g) throw new MediaError('Canvas недоступен');
  g.imageSmoothingQuality = 'high';
  // JPEG has no alpha: paint transparent PNGs on white
  g.fillStyle = '#fff';
  g.fillRect(0, 0, cw, ch);
  g.drawImage(src, 0, 0, cw, ch);
  return c;
}

export async function processImage(file: Blob, max = IMAGE_MAX_PX): Promise<{ blob: Blob; w: number; h: number }> {
  const img = await decodeImage(file);
  try {
    const c = drawScaled(img.src, img.w, img.h, max);
    return { blob: await canvasToJpeg(c), w: c.width, h: c.height };
  } finally {
    img.close();
  }
}

// ---------- video ----------

/** Output size: fits 1280×720 (or 720×1280 for portrait), never upscaled, even numbers. */
export function videoTarget(w: number, h: number): { w: number; h: number } {
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  const k = Math.min(1, VIDEO_BOX.long / long, VIDEO_BOX.short / short);
  const even = (n: number) => Math.max(2, Math.round((n * k) / 2) * 2);
  return { w: even(w), h: even(h) };
}

interface VideoOut {
  video: { blob: Blob; w: number; h: number; durationS: number };
  poster: { blob: Blob; w: number; h: number };
  transcoded: boolean;
}

async function transcode(file: Blob, onP: (p: number) => void): Promise<VideoOut> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') throw new MediaError('no-webcodecs');
  const mb = await import('mediabunny');
  const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(file) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new MediaError('В файле нет видео — попробуй другой файл');
    if ((await track.computePacketStats(4)).packetCount === 0) throw new MediaError('В видео нет ни одного кадра — попробуй другой файл');
    const durationS = await input.computeDuration();
    const size = videoTarget(track.displayWidth, track.displayHeight);
    if (!(await mb.canEncodeVideo('avc', { width: size.w, height: size.h, bitrate: VIDEO_BITRATE }))) throw new MediaError('no-avc');

    // Poster first (a frame a quarter in, but not later than 1.5 s)
    const sink = new mb.CanvasSink(track, { width: size.w, height: size.h, fit: 'contain' });
    const frame = await sink.getCanvas(Math.min(1.5, Math.max(0, durationS * 0.25)));
    let poster: VideoOut['poster'] | null = null;
    if (frame) {
      const c = document.createElement('canvas');
      c.width = frame.canvas.width;
      c.height = frame.canvas.height;
      c.getContext('2d')?.drawImage(frame.canvas as CanvasImageSource, 0, 0);
      poster = { blob: await canvasToJpeg(c), w: c.width, h: c.height };
    }

    const target = new mb.BufferTarget();
    const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target });
    const conv = await mb.Conversion.init({
      input,
      output,
      tracks: 'primary',
      video: { width: size.w, height: size.h, fit: 'contain', codec: 'avc', bitrate: VIDEO_BITRATE, forceTranscode: true },
      audio: { codec: 'aac', bitrate: 128_000 },
    });
    if (!conv.isValid) throw new MediaError('Конвертация невозможна');
    conv.onProgress = (p) => onP(Math.max(0, Math.min(1, p)));
    await conv.execute();
    const buf = target.buffer;
    if (!buf) throw new MediaError('bad-output');
    const blob = new Blob([buf], { type: 'video/mp4' });
    // An encoder hiccup can finish "successfully" with no frames: check before trusting it.
    const check = new mb.Input({ formats: [mb.MP4], source: new mb.BlobSource(blob) });
    try {
      const out = await check.getPrimaryVideoTrack();
      const d = await check.computeDuration();
      if (!out || !(d > 0)) throw new MediaError('bad-output');
    } finally {
      check.dispose();
    }
    if (!poster) poster = await posterFromElement(blob);
    return { video: { blob, w: size.w, h: size.h, durationS: durationS > 0 ? durationS : 0 }, poster, transcoded: true };
  } finally {
    input.dispose();
  }
}

/** Metadata + poster through a <video> element (fallback path). */
async function posterFromElement(file: Blob): Promise<VideoOut['poster'] & { vw: number; vh: number; durationS: number }> {
  const url = URL.createObjectURL(file);
  try {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.src = url;
    await new Promise<void>((res, rej) => {
      v.onloadeddata = () => res();
      v.onerror = () => rej(new MediaError('Браузер не может открыть это видео. Попробуй MP4.'));
      setTimeout(() => rej(new MediaError('Это видео не открывается — попробуй MP4 или другой файл')), 12_000);
    });
    const durationS = Number.isFinite(v.duration) ? v.duration : 0;
    await new Promise<void>((res) => {
      v.onseeked = () => res();
      v.currentTime = Math.min(1.5, durationS * 0.25);
      setTimeout(res, 3000);
    });
    const c = drawScaled(v, v.videoWidth || 1280, v.videoHeight || 720, VIDEO_BOX.long);
    return { blob: await canvasToJpeg(c), w: c.width, h: c.height, vw: v.videoWidth, vh: v.videoHeight, durationS };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function processVideo(file: Blob, onP: (p: number) => void): Promise<VideoOut> {
  try {
    return await transcode(file, onP);
  } catch (e) {
    const why = e instanceof Error ? e.message : '';
    // A broken or empty source: no point in uploading the original either.
    if (e instanceof MediaError && why.startsWith('В ')) throw e;
    if (file.size > ORIGINAL_MAX_BYTES) {
      throw new MediaError(
        why === 'no-webcodecs' || why === 'no-avc'
          ? 'Этот браузер не умеет сжимать видео, а файл больше 40 МБ. Открой админку в Chrome или Safari на ноутбуке — или обрежь видео.'
          : 'Не получилось сжать видео, а оригинал больше 40 МБ. Попробуй обрезать его или открыть админку в Chrome.',
      );
    }
    const p = await posterFromElement(file);
    return {
      video: { blob: file.type ? file : new Blob([file], { type: 'video/mp4' }), w: p.vw, h: p.vh, durationS: p.durationS },
      poster: { blob: p.blob, w: p.w, h: p.h },
      transcoded: false,
    };
  }
}

// ---------- upload ----------

/** Full job: process + upload. Reports progress 0..1 across stages. */
export async function processAndUpload(
  media: MediaBackend,
  file: Blob,
  opts: { accept: 'image' | 'video' | 'any'; onProgress?: (p: MediaProgress) => void },
): Promise<UploadedMedia> {
  const report = opts.onProgress ?? (() => undefined);
  const video = isVideo(file);
  if (video && opts.accept === 'image') throw new MediaError('Сюда подходит только картинка');
  if (!video && opts.accept === 'video') throw new MediaError('Сюда подходит только видео');
  if (!video && !isImage(file)) throw new MediaError('Это не похоже на фото или видео');

  if (!video) {
    report({ stage: 'reading', p: 0.05 });
    const img = await processImage(file);
    report({ stage: 'uploading', p: 0.4 });
    const { id, meta } = await media.upload({
      kind: 'image',
      blob: img.blob,
      w: img.w,
      h: img.h,
      onProgress: (d, t) => report({ stage: 'uploading', p: 0.4 + 0.6 * (d / Math.max(1, t)) }),
    });
    rememberMeta(id, meta);
    report({ stage: 'done', p: 1 });
    return { id, kind: 'image', w: meta.w, h: meta.h, bytes: meta.bytes };
  }

  report({ stage: 'reading', p: 0.02 });
  const out = await processVideo(file, (p) => report({ stage: 'converting', p: 0.02 + 0.68 * p, note: 'Сжимаю видео до 720p' }));
  if (out.video.blob.size > VIDEO_MAX_BYTES) throw new MediaError('Даже после сжатия видео больше 45 МБ — обрежь его покороче');
  report({ stage: 'uploading', p: 0.7, note: out.transcoded ? undefined : 'Загружаю оригинал (без сжатия)' });
  const poster = await media.upload({ kind: 'image', blob: out.poster.blob, w: out.poster.w, h: out.poster.h });
  const { id, meta } = await media.upload({
    kind: 'video',
    blob: out.video.blob,
    w: out.video.w,
    h: out.video.h,
    durationS: Math.round(out.video.durationS * 10) / 10,
    posterId: poster.id,
    onProgress: (d, t) => report({ stage: 'uploading', p: 0.72 + 0.28 * (d / Math.max(1, t)) }),
  });
  rememberMeta(poster.id, poster.meta);
  rememberMeta(id, meta);
  report({ stage: 'done', p: 1 });
  const res: UploadedMedia = { id, kind: 'video', w: meta.w, h: meta.h, posterId: poster.id, bytes: meta.bytes };
  if (meta.durationS !== undefined) res.durationS = meta.durationS;
  return res;
}

// ---------- reading back (previews) ----------

const metaCache = new Map<string, Promise<MediaMetaDoc | null>>();

/** media/{id} meta, read once per page (null: not found). */
export function mediaMeta(media: MediaBackend, id: string): Promise<MediaMetaDoc | null> {
  let p = metaCache.get(id);
  if (!p) {
    p = media
      .meta(id)
      .catch(() => {
        metaCache.delete(id);
        return null;
      });
    metaCache.set(id, p);
  }
  return p;
}

/** Freshly uploaded files are known without a read. */
export function rememberMeta(id: string, meta: MediaMetaDoc): void {
  metaCache.set(id, Promise.resolve(meta));
}

export function useMediaMeta(id: string | undefined): MediaMetaDoc | null | undefined {
  const media = useAdmin().backend.media;
  const [meta, setMeta] = useState<MediaMetaDoc | null | undefined>(undefined);
  useEffect(() => {
    setMeta(undefined);
    if (!id) return;
    let alive = true;
    void mediaMeta(media, id).then((m) => alive && setMeta(m));
    return () => {
      alive = false;
    };
  }, [media, id]);
  return meta;
}

/** Object URL of a media file (cached per device); null while loading or on failure. */
export function useMediaUrl(id: string | undefined): { url: string | null; failed: boolean } {
  const media = useAdmin().backend.media;
  const [st, setSt] = useState<{ url: string | null; failed: boolean }>({ url: null, failed: false });
  useEffect(() => {
    setSt({ url: null, failed: false });
    if (!id) return;
    let alive = true;
    media.url(id).then(
      (url) => alive && setSt({ url, failed: false }),
      () => alive && setSt({ url: null, failed: true }),
    );
    return () => {
      alive = false;
    };
  }, [media, id]);
  return st;
}

// ---------- small inline pictures (player selfies) ----------
//
// Every players snapshot from Firestore hands over NEW Uint8Arrays for the same selfies (any guest's
// join / rename / clock probe re-reads the whole list). Keyed by the array, 90 avatars made 90 new
// object URLs — 90 image reloads and decodes — on each of them. Keyed by the content instead, a
// picture keeps its URL (and its decoded image) while anything shows it, plus a minute (switching
// tabs back shows it at once, no initial letter flashing first).

const KEEP_MS = 60_000;
const keyOfArray = new WeakMap<Uint8Array, string>();
const byKey = new Map<string, { url: string; refs: number; timer: ReturnType<typeof setTimeout> | null }>();

/** Content key: length + two 32-bit hashes — no collisions in practice for a party's selfies. */
export function bytesKey(b: Uint8Array): string {
  let k = keyOfArray.get(b);
  if (k === undefined) {
    let h1 = 0x811c9dc5;
    let h2 = 0x2545f491;
    for (let i = 0; i < b.length; i++) {
      const x = b[i] as number;
      h1 = Math.imul(h1 ^ x, 0x01000193);
      h2 = Math.imul(h2 + x, 0x5bd1e995) ^ (h2 >>> 13);
    }
    k = `${b.length}.${(h1 >>> 0).toString(36)}.${(h2 >>> 0).toString(36)}`;
    keyOfArray.set(b, k);
  }
  return k;
}

function dropLater(key: string): void {
  const e = byKey.get(key);
  if (!e || e.refs > 0 || e.timer) return;
  e.timer = setTimeout(() => {
    e.timer = null;
    if (e.refs > 0) return;
    byKey.delete(key);
    URL.revokeObjectURL(e.url);
  }, KEEP_MS);
}

function urlFor(key: string, bytes: Uint8Array, type: string): string {
  let e = byKey.get(key);
  if (!e) {
    e = { url: URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type })), refs: 0, timer: null };
    byKey.set(key, e);
    dropLater(key); // made during a render that may never commit
  }
  return e.url;
}

/** Object URL for small inline bytes (player thumbs), the same one for the same picture. */
export function useBytesUrl(bytes: Uint8Array | undefined, type = 'image/jpeg'): string | null {
  const key = bytes && bytes.length ? `${type}|${bytesKey(bytes)}` : null;
  const url = key && bytes ? urlFor(key, bytes, type) : null;
  useEffect(() => {
    if (!key) return;
    const e = byKey.get(key);
    if (!e) return;
    e.refs++;
    if (e.timer) {
      clearTimeout(e.timer);
      e.timer = null;
    }
    return () => {
      e.refs--;
      dropLater(key);
    };
  }, [key]);
  return url;
}
