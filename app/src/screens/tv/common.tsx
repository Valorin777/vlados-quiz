// Shared pieces of the TV scenes: the environment context, the beat hook, the guests' crowd band,
// the media frame (image / the persistent video), the question header.

import type { PubMedia } from '@shared/fbtypes';
import type { TextKey } from '@shared/types';
import { gsap } from 'gsap';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Badge, ChromeBlock, Emerge, FitImage, audio, cx, fitOrientation, initialOf, useDecoded, useLiquid, type LiquidEngine } from '../../visual';
import type { QuestionView, TvPlayer } from '../../host';
import { cancelVideoOutro, playVideo, tvVideo, useMediaUrl, videoOutro } from './media';

// ------------------------------------------------------------------ environment

export interface TvEnvValue {
  /** Server clock (the TimerView time base). */
  now: () => number;
  /** uid → selfie URL. */
  avatars: ReadonlyMap<string, string>;
  texts: Record<TextKey, string>;
  vladosUid: string | null;
  /** Settings.sound (music gates the ambient loops; volume goes to the video). */
  sound: { sfx: boolean; music: boolean; volume: number };
  muted: boolean;
  /** «Стоп-экран»: nothing may play (videos stay paused whatever their scene wants). */
  held?: boolean;
  /** The question's video ended on this screen (live TV: host command 'watchEnd'; demo: none). */
  onWatchEnded?: (phaseRev: number) => void;
  /** The «Сюрприз» video ended on this screen (live TV: host command 'surpriseEnd'). */
  onSurpriseEnded?: (phaseRev: number) => void;
  /** The reveal video ended on this screen (live TV: host command 'revealMediaEnd'; demo: none). */
  onRevealMediaEnded?: (phaseRev: number) => void;
}

export const TvEnv = createContext<TvEnvValue>({
  now: Date.now,
  avatars: new Map(),
  texts: {} as Record<TextKey, string>,
  vladosUid: null,
  sound: { sfx: true, music: true, volume: 0.8 },
  muted: false,
});

export const useTvEnv = (): TvEnvValue => useContext(TvEnv);

/**
 * Runs a choreography once the liquid engine settled (or definitively won't) and again when
 * `deps` change; kills it on change/unmount. The callback may return a timeline or a cleanup.
 *
 * A layout effect: the timeline's from-states (hidden options, letters below their line) are set
 * before the browser paints the new DOM — a passive effect let one frame of the finished layout
 * through first (the options flashed at full size, then collapsed and popped in again). The engine
 * is read when the beat starts, not a dependency: the governor dropping to tier 0 mid-entrance
 * (engine → null in the context) used to kill the timeline and replay the whole entrance.
 */
export function useBeat(fn: (engine: LiquidEngine | null) => gsap.core.Animation | (() => void) | void, deps: unknown[]): void {
  const { engine, ready } = useLiquid();
  const cb = useRef(fn);
  cb.current = fn;
  const eng = useRef(engine);
  eng.current = engine;
  useLayoutEffect(() => {
    if (!ready) return;
    const r = cb.current(eng.current);
    return () => {
      if (typeof r === 'function') r();
      else r?.kill();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, ...deps]);
}

/** Title size class by length (the organizer writes anything from 3 words to a paragraph). */
export function titleSize(t: string): string {
  const n = t.length;
  if (n <= 36) return 'is-xl';
  if (n <= 70) return 'is-l';
  if (n <= 120) return 'is-m';
  return 'is-s';
}

/** The first words of the title become the kicker, the last word the chrome hero. */
export function splitTitle(title: string): { kicker: string; hero: string } {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) return { kicker: '', hero: words[0] ?? '' };
  const hero = words[words.length - 1] ?? '';
  return { kicker: words.slice(0, -1).join(' '), hero };
}

export const fmtSec = (ms: number): string => (ms / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1, minimumFractionDigits: 1 });

/** Russian number: decimal comma; thin-space groups only from 5 digits (years stay «2015»). */
export const fmtNum = (v: number): string =>
  v.toLocaleString('ru-RU', { maximumFractionDigits: 2, useGrouping: Math.abs(v) >= 10_000 }).replace(/\s/g, '\u202f');

// ------------------------------------------------------------------ question header

export function QTop({ q, suffix, className }: { q: QuestionView; suffix?: string; className?: string }) {
  const { texts } = useTvEnv();
  return (
    <div className={cx('tv-top', className)}>
      <span className="vx-kick">
        вопрос {q.n} из {q.total}
        {suffix ? ` · ${suffix}` : ''}
      </span>
      {q.double ? (
        <>
          <Badge liquid size="m">
            ×2
          </Badge>
          <span className="tv-x2l">{texts.doubleBadge || 'очки удваиваются'}</span>
        </>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ crowd band

export interface CrowdLayout {
  size: number;
  at: (i: number) => { x: number; y: number };
  top: number;
}

/** Up to 36 per row, rows stacked up from the bottom edge, every row centred. */
export function crowdLayout(n: number): CrowdLayout {
  const big = n <= 24;
  const perRow = big ? 24 : 36;
  const gap = big ? 46 : 31.5;
  const size = big ? 36 : 26;
  const rows = Math.max(1, Math.ceil(n / perRow));
  const bottom = 686;
  return {
    size,
    top: bottom - (rows - 1) * gap - size / 2,
    at: (i) => {
      const r = Math.floor(i / perRow);
      const inRow = r === rows - 1 ? n - r * perRow : perRow;
      const k = i - r * perRow;
      return { x: 640 + (k - (inRow - 1) / 2) * gap, y: bottom - (rows - 1 - r) * gap };
    },
  };
}

export function CrowdAvatar({ p, src, size, x, y, on, setEl, className, style }: { p: Pick<TvPlayer, 'uid' | 'name' | 'isVlados'>; src: string | null; size: number; x: number; y: number; on: boolean; setEl?: (uid: string, el: HTMLDivElement | null) => void; className?: string; style?: CSSProperties }) {
  return (
    <div
      ref={(n) => setEl?.(p.uid, n)}
      className={cx('tv-cav', on && 'is-on', p.isVlados && 'is-vlados', className)}
      style={{ left: x - size / 2, top: y - size / 2, width: size, height: size, ...style }}
      title={p.name}
    >
      {src ? <img src={src} alt="" draggable={false} /> : <b>{initialOf(p.name)}</b>}
    </div>
  );
}

/**
 * The guests along the bottom edge: tarnished until they answer, then they light up with a pulse
 * ring, a ripple on the liquid and a soft ping.
 */
export function Crowd({ players, answered, hidden = false, className, onEls }: { players: readonly TvPlayer[]; answered: ReadonlySet<string>; hidden?: boolean; className?: string; onEls?: (m: Map<string, HTMLDivElement>) => void }) {
  const { avatars } = useTvEnv();
  const { engine } = useLiquid();
  const els = useRef(new Map<string, HTMLDivElement>());
  const prev = useRef<Set<string> | null>(null);
  const L = crowdLayout(players.length);
  const setEl = (uid: string, el: HTMLDivElement | null) => {
    if (el) els.current.set(uid, el);
    else els.current.delete(uid);
  };
  useLayoutEffect(() => {
    onEls?.(els.current);
  });
  useEffect(() => {
    const was = prev.current;
    prev.current = new Set(answered);
    if (!was) return;
    let k = 0;
    for (const uid of answered) {
      if (was.has(uid)) continue;
      const el = els.current.get(uid);
      if (!el) continue;
      el.classList.remove('is-ping');
      void el.offsetWidth;
      el.classList.add('is-ping');
      if (engine) {
        const m = engine.measure(el);
        engine.ripple(m.x, m.y, 0.3);
      }
      audio.ping(1 + ((k++ + answered.size) % 7) * 0.09);
    }
  }, [answered, engine]);
  return (
    <div className={cx('tv-crowd', hidden && 'is-hidden', className)} aria-hidden="true">
      {players.map((p, i) => {
        const { x, y } = L.at(i);
        return <CrowdAvatar key={p.uid} p={p} src={avatars.get(p.uid) ?? null} size={L.size} x={x} y={y} on={answered.has(p.uid)} setEl={setEl} />;
      })}
    </div>
  );
}

// ------------------------------------------------------------------ media

function Shimmer({ label }: { label: string }) {
  return (
    <div className="tv-media-wait">
      <i />
      <span>{label}</span>
    </div>
  );
}

interface VideoWatch {
  /** Where the video should be when this slot starts it, ms after startAtS (a reload mid-video). */
  fromMs: number;
  /** The video played to its end (or cannot play at all). */
  onEnded: () => void;
}

function VideoSlot({ media, play, hold, watch, outro = false, onEnded }: { media: PubMedia; play: boolean; hold?: boolean; watch?: VideoWatch; outro?: boolean; onEnded?: () => void }) {
  const host = useRef<HTMLDivElement | null>(null);
  const out = useRef(outro);
  out.current = outro;
  const { url, failed } = useMediaUrl(media.mediaId);
  const poster = useMediaUrl(media.posterId);
  const { muted, sound, held = false } = useTvEnv();
  const w = useRef(watch);
  w.current = watch;
  const watching = watch !== undefined;
  // the position when this slot appeared: 0 in the normal flow (even if the file arrives late),
  // mid-video after a reload of the TV page
  const from0 = useRef(watch?.fromMs ?? 0);

  // the ONE unlocked element moves into this slot and back out (`outro`: a reveal video still
  // playing when the scene goes fades out over the next one instead of stopping dead)
  useLayoutEffect(() => {
    const v = tvVideo();
    const el = host.current;
    cancelVideoOutro();
    el?.appendChild(v);
    return () => {
      if (out.current && videoOutro(el)) return;
      v.pause();
      v.remove();
    };
  }, []);

  useEffect(() => {
    const v = tvVideo();
    if (!url) return;
    // the watch stage: from the start (or where the show is after a reload), the others: startAtS
    const at = (media.startAtS ?? 0) + (watching ? from0.current / 1000 : 0);
    const seek = (slack: number) => {
      if (w.current && Number.isFinite(v.duration) && v.duration > 0 && at >= v.duration - 0.25) {
        w.current.onEnded();
        return;
      }
      if (Math.abs(v.currentTime - at) > slack && (at > 0 || watching)) v.currentTime = at;
    };
    if (v.src !== url) {
      v.src = url;
      v.addEventListener('loadedmetadata', () => seek(0.3), { once: true });
      v.load();
    } else if (watching && v.readyState >= 1) seek(1.5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, media.startAtS, watching]);

  // the watch stage ends with the video: 'ended', or a file this browser cannot play / load
  useEffect(() => {
    if (!watching) return;
    const v = tvVideo();
    const end = () => {
      if (url && v.src === url) w.current?.onEnded();
    };
    v.addEventListener('ended', end);
    v.addEventListener('error', end);
    return () => {
      v.removeEventListener('ended', end);
      v.removeEventListener('error', end);
    };
  }, [watching, url]);
  useEffect(() => {
    if (!watching || !failed) return;
    const t = setTimeout(() => w.current?.onEnded(), 2_500);
    return () => clearTimeout(t);
  }, [watching, failed]);

  // a reveal video played to its end here (the host's autopilot goes on to the board soon after)
  const endedCb = useRef(onEnded);
  endedCb.current = onEnded;
  const reportsEnd = onEnded !== undefined && !watching;
  useEffect(() => {
    if (!reportsEnd || !play || !url) return;
    const v = tvVideo();
    const end = () => {
      if (v.src === url) endedCb.current?.();
    };
    v.addEventListener('ended', end);
    return () => v.removeEventListener('ended', end);
  }, [reportsEnd, play, url]);

  useEffect(() => {
    const v = tvVideo();
    v.volume = Math.max(0, Math.min(1, sound.volume));
    v.muted = muted;
  }, [muted, sound.volume]);

  useEffect(() => {
    const v = tvVideo();
    if (!url) return;
    if (play && !held) {
      void playVideo(v, muted);
      audio.music(false);
    } else v.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [play, url, held]);

  return (
    <div className="tv-media-in">
      {poster.url ? <FitImage src={poster.url} fit="fill" className="tv-media-poster" /> : null}
      <div ref={host} className={cx('tv-video-host', (play || hold) && url ? 'is-on' : null)} />
      {!url ? <Shimmer label={failed ? 'Видео не загрузилось' : 'Загружаем видео…'} /> : null}
    </div>
  );
}

function ImageSlot({ id }: { id: string }) {
  const { url, failed } = useMediaUrl(id);
  const dec = useDecoded(url);
  return (
    <div className="tv-media-in">
      {url && !dec.failed ? <FitImage src={url} fit="fill" /> : null}
      {!url || dec.ar === null ? <Shimmer label={failed || dec.failed ? 'Картинка не загрузилась' : 'Загружаем…'} /> : null}
    </div>
  );
}

/** The frame's picture (the image, or the video's poster): decoded aspect ratio, else the published pixel size. */
function useMediaShape(media: PubMedia): { ar: number | null; decoded: boolean } {
  const { url } = useMediaUrl(media.kind === 'video' ? media.posterId : media.mediaId);
  const dec = useDecoded(url).ar;
  return { ar: dec ?? (media.w && media.h ? media.w / media.h : null), decoded: dec !== null };
}

const useMediaAspect = (media: PubMedia): number | null => useMediaShape(media).ar;

/**
 * A liquid chrome frame around the question's picture or video (video plays while `play`; `hold`
 * keeps its frame on screen while stopped; `watch`: the watch stage — position + end report).
 * The picture is never cropped (FitImage); the frame gets `is-portrait` / `--media-ar` so a layout
 * can give a portrait a narrower, taller slot.
 */
export function MediaFrame({
  media,
  play,
  hold,
  watch,
  outro,
  onEnded,
  liquid = true,
  className,
  style,
}: {
  media: PubMedia;
  play: boolean;
  hold?: boolean;
  watch?: VideoWatch;
  /** a video still playing when this frame unmounts fades out (see media.videoOutro) */
  outro?: boolean;
  /** a (non-watch) video played to its end in this frame */
  onEnded?: () => void;
  liquid?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const ar = useMediaAspect(media);
  return (
    <ChromeBlock
      shape="box"
      radius={26}
      film={0.3}
      liquid={liquid}
      className={cx('tv-media', fitOrientation(ar), className)}
      style={{ ...(ar ? ({ '--media-ar': Math.min(2.2, Math.max(0.56, ar)) } as CSSProperties) : null), ...style }}
    >
      {media.kind === 'video' ? <VideoSlot media={media} play={play} {...(hold !== undefined ? { hold } : {})} {...(watch ? { watch } : {})} {...(outro ? { outro } : {})} {...(onEnded ? { onEnded } : {})} /> : <ImageSlot id={media.mediaId} />}
    </ChromeBlock>
  );
}

/** When the reveal scenes bring in the picture / video that comes with the right answer (s after `base`). */
export const revealMediaAt = (media: PubMedia, base: number, o: { video: number; image: number }): number => base + (media.kind === 'video' ? o.video : o.image);

/**
 * The picture or video that comes with the right answer, big and centre stage: a mercury droplet
 * swells out of the right answer (`from`), flies to the middle of the screen and spreads into the
 * frame with an iridescent sheen (drop / shine sounds). The frame takes the media's own
 * proportions (poster / published size; never cropped, no black bars). A video starts playing,
 * with sound, the moment the droplet splashes open, on the persistent unlocked element; if the
 * host moves on while it plays, it fades out over the next scene. The text after the answer
 * (`text`) stands next to it. `rev` (the reveal's phaseRev): a video that played to its end is
 * reported to the host (env.onRevealMediaEnded → 'revealMediaEnd': the autopilot's board 2 s later).
 */
export function RevealMedia({ media, from, text, rev }: { media: PubMedia; from?: () => Element | null | undefined; text?: string | undefined; rev?: number }) {
  const { ar, decoded } = useMediaShape(media);
  const video = media.kind === 'video';
  const [landed, setLanded] = useState(false);
  // a video with neither a poster nor a known size: go after a moment in 16:9
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!video || ar !== null) return;
    const t = setTimeout(() => setLate(true), 1_200);
    return () => clearTimeout(t);
  }, [video, ar]);
  const ready = video ? ar !== null || late : decoded;
  const { sound, onRevealMediaEnded } = useTvEnv();
  const box = ar ? Math.min(2.2, Math.max(0.56, ar)) : 16 / 9;
  const onLand = useCallback(() => setLanded(true), []);
  const reported = useRef(false);
  const onEnded = useCallback(() => {
    if (reported.current || rev === undefined) return;
    reported.current = true;
    onRevealMediaEnded?.(rev);
  }, [onRevealMediaEnded, rev]);
  const note = text?.trim();
  return (
    <div className={cx('trc-media', video && 'is-video', note && 'has-text', landed && 'is-landed', fitOrientation(box))} data-outro="">
      <Emerge size="tv" ready={ready} from={from ?? null} sound={sound.sfx} radius={30} className="trc-media-e" style={{ '--media-ar': box } as CSSProperties} onLand={onLand}>
        <MediaFrame media={media} play={video && landed} hold outro liquid={false} className="trc-media-f" {...(video && rev !== undefined && onRevealMediaEnded ? { onEnded } : {})} />
      </Emerge>
      {note ? <p className="trc-media-text">{note}</p> : null}
    </div>
  );
}

/** Small picture inside an option / ordering item. */
export function ItemPic({ id }: { id: string }) {
  const { url } = useMediaUrl(id);
  return url ? <img className="tv-itempic" src={url} alt="" /> : <span className="tv-itempic is-wait" />;
}

/** A picture option's photo (big tile): whole, never cropped. */
export function ItemFit({ id }: { id: string }) {
  const { url, failed } = useMediaUrl(id);
  return <FitImage src={url} failed={failed} fit="fill" failLabel="" />;
}

/** Drops a few pieces of chrome/film confetti from the top of a host element. */
export function confetti(host: HTMLElement | null, n = 60): () => void {
  if (!host) return () => undefined;
  const nodes: HTMLElement[] = [];
  const colors = ['var(--film-c)', 'var(--film-m)', 'var(--film-g)', 'var(--mercury)', 'var(--spec)'];
  for (let i = 0; i < n; i++) {
    const s = document.createElement('i');
    s.className = 'tv-confetti';
    s.style.background = colors[i % colors.length] ?? '#fff';
    host.appendChild(s);
    nodes.push(s);
    const x = Math.random() * 1280;
    gsap.fromTo(
      s,
      { x, y: -30 - Math.random() * 200, rotation: Math.random() * 360, scaleX: 0.6 + Math.random() * 0.8 },
      {
        y: 760,
        x: x + (Math.random() - 0.5) * 300,
        rotation: `+=${360 + Math.random() * 720}`,
        duration: 2.6 + Math.random() * 2.2,
        delay: Math.random() * 0.9,
        ease: 'power1.in',
        onComplete: () => s.remove(),
      },
    );
  }
  return () => nodes.forEach((s) => s.remove());
}

export function Plate({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('tv-plate', className)}>{children}</div>;
}
