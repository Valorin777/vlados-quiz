// A picture that is never cropped: the photo sits whole (object-fit: contain) on a blurred,
// theme-tinted copy of itself, so a portrait on a wide slot (or a panorama on a tall one) has no
// black bars and no cut-off faces. It appears only once the file is decoded (no half-drawn or
// shifted JPEG while the chunked Blob is still being painted) and fades in.
//
//   fit="box"  — the element sizes itself: width 100%, height by the photo's aspect ratio, capped
//                by --fit-max-h (portraits get a taller box, landscapes stay wide)
//   fit="fill" — fills a parent that owns the size (TV frames, preview slots)

import { useEffect, useState, type CSSProperties, type Ref } from 'react';
import { cx } from './util';

// ------------------------------------------------------------------ decode cache

const aspects = new Map<string, number>();
const pending = new Map<string, Promise<number>>();

function loaded(im: HTMLImageElement): Promise<void> {
  return new Promise((res, rej) => {
    if (im.complete && im.naturalWidth > 0) return res();
    im.addEventListener('load', () => res(), { once: true });
    im.addEventListener('error', () => rej(new Error('image failed to load')), { once: true });
  });
}

/** Decodes an image URL once per page; resolves with its aspect ratio (w / h). */
export function decodeImage(src: string): Promise<number> {
  const have = aspects.get(src);
  if (have !== undefined) return Promise.resolve(have);
  const busy = pending.get(src);
  if (busy) return busy;
  const im = new Image();
  im.decoding = 'async';
  im.src = src;
  // decode() can reject for a picture that is fine (Safari, a detached image): fall back to load.
  // It also waits for rendering, so in a hidden tab (or a WebKit that never settles it) it may not
  // resolve at all: once the file has loaded (all bytes are local — no half-drawn picture) give it
  // a moment more, then go on without it.
  const decoded = typeof im.decode === 'function' ? im.decode().catch(() => loaded(im)) : loaded(im);
  const late = loaded(im).then(() => new Promise<void>((res) => setTimeout(res, 900)));
  const job = Promise.race([decoded, late]).then(() => {
    const ar = im.naturalWidth > 0 && im.naturalHeight > 0 ? im.naturalWidth / im.naturalHeight : 0;
    if (!ar) throw new Error('empty image');
    aspects.set(src, ar);
    return ar;
  });
  pending.set(src, job);
  const done = () => pending.delete(src);
  job.then(done, done);
  return job;
}

/** Aspect ratio of a decoded picture (null while decoding; `failed` when it cannot be shown). */
export function useDecoded(src: string | null | undefined): { ar: number | null; failed: boolean } {
  const [st, set] = useState<{ src: string | null; ar: number | null; failed: boolean }>(() => ({
    src: src ?? null,
    ar: src ? (aspects.get(src) ?? null) : null,
    failed: false,
  }));
  useEffect(() => {
    if (!src) return;
    const have = aspects.get(src);
    if (have !== undefined) {
      set({ src, ar: have, failed: false });
      return;
    }
    let alive = true;
    set({ src, ar: null, failed: false });
    decodeImage(src).then(
      (ar) => alive && set({ src, ar, failed: false }),
      () => alive && set({ src, ar: null, failed: true }),
    );
    return () => {
      alive = false;
    };
  }, [src]);
  if (!src) return { ar: null, failed: false };
  if (st.src !== src) return { ar: aspects.get(src) ?? null, failed: false };
  return { ar: st.ar, failed: st.failed };
}

// ------------------------------------------------------------------ component

export interface FitImageProps {
  /** object URL / data URL; null while the file is still downloading */
  src: string | null | undefined;
  alt?: string;
  fit?: 'box' | 'fill';
  /** known pixel size (admin meta): sizes the box before the file is decoded */
  w?: number;
  h?: number;
  /** the file could not be downloaded */
  failed?: boolean;
  failLabel?: string;
  /** box mode: the aspect ratio is clamped to [minAr, maxAr] (a 4:1 panorama still gets some height) */
  minAr?: number;
  maxAr?: number;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<HTMLSpanElement>;
}

export const fitOrientation = (ar: number | null): 'is-portrait' | 'is-landscape' | 'is-square' | null =>
  ar === null ? null : ar < 0.9 ? 'is-portrait' : ar > 1.15 ? 'is-landscape' : 'is-square';

export function FitImage({ src, alt = '', fit = 'box', w, h, failed, failLabel = 'картинка не загрузилась', minAr = 0.56, maxAr = 2.2, className, style, ref }: FitImageProps) {
  const dec = useDecoded(src);
  const known = w && h ? w / h : null;
  const ar = dec.ar ?? known;
  const ready = !!src && dec.ar !== null;
  const bad = failed || dec.failed;
  const box = ar ? Math.min(maxAr, Math.max(minAr, ar)) : null;
  return (
    <span
      ref={ref}
      className={cx('vx-fit', `vx-fit-${fit}`, ready && 'is-ready', !ready && !bad && 'is-loading', bad && 'is-failed', fitOrientation(ar), className)}
      style={{ ...(box ? ({ '--fit-ar': box } as CSSProperties) : null), ...style }}
    >
      {ready ? (
        <>
          <img className="vx-fit-bg" src={src} alt="" aria-hidden="true" draggable={false} />
          <img className="vx-fit-img" src={src} alt={alt} draggable={false} />
        </>
      ) : bad ? (
        <span className="vx-fit-miss">{failLabel}</span>
      ) : null}
    </span>
  );
}
