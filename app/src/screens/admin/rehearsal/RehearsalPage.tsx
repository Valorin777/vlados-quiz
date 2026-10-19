// #/admin/rehearsal — «Прогнать игру»: the whole show from the current questions on the REAL TV
// screen (TvShow) and the REAL phone screen (PlayerShell of the guest «Ты»), side by side like the
// approved prototype (phone-only with a «ТВ / Телефон» switch on narrow screens), driven by a
// virtual clock over a precomputed game (host/rehearsal.ts: the real host logic, fake guests).
//
// Reads admin/content (the editor's draft) and media only — nothing is ever written: no game doc,
// no players, no answers. Videos play on the TV exactly as live (watch stage, 3-2-1, options).

import { finaleCustomId } from '@shared/engine/finale';
import type { AdminContentDoc } from '@shared/fbtypes';
import type { AnswerPayload, Id } from '@shared/types';
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from 'react';
import { useLocation } from 'wouter';
import { buildPlayerView, buildTvView, type MediaIndex } from '../../../host';
import { checkedName, normalizeSettings, referencedMediaIds } from '../../../host/pure';
import {
  markAt,
  nextMark,
  playerInputAt,
  positionAt,
  prevMark,
  rehearsalGuests,
  remapTime,
  simulate,
  snapshotAt,
  type ManualAnswer,
  type MyMode,
  type RehearsalGuest,
  type Timeline,
} from '../../../host/rehearsal';
import { LiquidOff, LiquidStage, audio, cx } from '../../../visual';
import { PlayerShell } from '../../player/Shell';
import type { PlayerActions } from '../../player/types';
import { TvShow } from '../../tv/TvShow';
import { BUILTIN_VIDEO_ID } from '../../tv/finale';
import { SURPRISE_VIDEO_ID } from '../../tv/surprise/video';
import { mediaReady, seedMediaUrl, tvVideo } from '../../tv/media';
import '../../tv/tv.css';
import type { MediaBackend } from '../core/backend';
import { useContent } from '../core/content';
import { mediaMeta } from '../core/media';
import { useAdmin } from '../core/session';
import { Icon } from '../ui/icons';
import { CheatSheet } from './CheatSheet';
import { VirtualClock } from './clock';
import { makeFaces, type Faces } from './faces';
import { rehearsalReturn } from './RehearsalButton';
import { Strip, type NarrowView, type Speed } from './Strip';
import './rehearsal.css';

const SEED = 2609;
const NARROW_PX = 1000;
/** The guest's phone in the narrow «Телефон» view: design width (wider stages show a 390 phone)… */
const PHONE_W = 390;
const PHONE_W_MAX = 440;
/** …and the least height it gets (a 390-wide phone's visible screen in Safari), scaled to fit. */
const PHONE_MIN_H = 720;
const SHEET_KEY = 'vlados.rh.sheet';

// ---------- data: media index, faces, TV media URLs ----------

/** kind / poster / duration of every referenced file (media/{id} reads; the watch stage needs the duration). */
function useMediaIndex(doc: AdminContentDoc | null, mb: MediaBackend): { index: MediaIndex; ready: boolean } {
  const ids = useMemo(() => (doc ? referencedMediaIds(doc, null).sort().join(',') : ''), [doc]);
  const [st, setSt] = useState<{ ids: string | null; index: MediaIndex; ready: boolean }>({ ids: null, index: {}, ready: false });
  useEffect(() => {
    let alive = true;
    const list = ids ? ids.split(',') : [];
    // a slow network never keeps the rehearsal from starting (the files appear when they arrive)
    const t = setTimeout(() => alive && setSt((s) => ({ ...s, ready: true })), 5_000);
    void Promise.all(list.map(async (id) => [id, await mediaMeta(mb, id)] as const)).then((rows) => {
      if (!alive) return;
      const index: Record<string, MediaIndex[string]> = {};
      for (const [id, m] of rows) {
        if (!m) continue;
        index[id] = {
          kind: m.kind,
          ...(m.posterId ? { posterId: m.posterId } : {}),
          ...(typeof m.durationS === 'number' && m.durationS > 0 ? { durationS: m.durationS } : {}),
          ...(m.w > 0 && m.h > 0 ? { w: m.w, h: m.h } : {}),
        };
      }
      setSt({ ids, index, ready: true });
    });
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [ids, mb]);
  return { index: st.index, ready: st.ready };
}

/**
 * The TV scenes load question media by id; hand them the admin's own URLs (the same files — and
 * in the DEV rehearsal the in-memory uploads), in show order so the first questions come first.
 */
function useTvMedia(doc: AdminContentDoc | null, index: MediaIndex, mb: MediaBackend): void {
  const ids = useMemo(() => {
    const out: string[] = [];
    if (!doc) return '';
    if (doc.settings.lobbyBgMediaId) out.push(doc.settings.lobbyBgMediaId);
    // the uploaded video after the final (the built-in clip is a file of the site)
    const fin = finaleCustomId(doc.settings);
    if (fin) {
      const poster = index[fin]?.posterId;
      if (poster) out.push(poster);
      out.push(fin);
    }
    for (const q of doc.questions) {
      if (q.disabled) continue;
      // an uploaded «Сюрприз» video (the built-in one is a file of the site)
      const sv = q.surprise?.on && q.surprise.src === 'custom' ? q.surprise.mediaId : undefined;
      if (sv) {
        const poster = index[sv]?.posterId;
        if (poster) out.push(poster);
        out.push(sv);
      }
      for (const m of [q.media, q.revealMedia]) {
        if (!m) continue;
        const poster = index[m.mediaId]?.posterId;
        if (poster) out.push(poster);
        out.push(m.mediaId);
      }
      const items = q.type === 'choice' ? q.options : q.type === 'ordering' ? q.items : [];
      for (const it of items) if (it.mediaId) out.push(it.mediaId);
    }
    return [...new Set(out)].join(',');
  }, [doc, index]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      for (const id of ids ? ids.split(',') : []) {
        if (!alive) return;
        try {
          const url = await mb.url(id);
          if (alive) seedMediaUrl(id, url);
        } catch {
          /* the TV shows «не загрузилось» for it, like live */
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [ids, mb]);
}

function useFaces(guests: readonly RehearsalGuest[]): Faces | null {
  const [faces, setFaces] = useState<Faces | null>(null);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => alive && setFaces((f) => f ?? {}), 4_000);
    void makeFaces(guests).then((f) => alive && setFaces(f));
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [guests]);
  return faces;
}

// ---------- layout ----------

function useBox(): [(el: HTMLElement | null) => void, { w: number; h: number }] {
  const [box, setBox] = useState({ w: 0, h: 0 });
  const ro = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    ro.current?.disconnect();
    if (!el) return;
    const measure = () => setBox((b) => (b.w === el.clientWidth && b.h === el.clientHeight ? b : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    ro.current = new ResizeObserver(measure);
    ro.current.observe(el);
  }, []);
  return [ref, box];
}

function useNarrow(): boolean {
  const [n, setN] = useState(() => innerWidth < NARROW_PX);
  useEffect(() => {
    const on = () => setN(innerWidth < NARROW_PX);
    addEventListener('resize', on);
    return () => removeEventListener('resize', on);
  }, []);
  return n;
}

const systemDark = (): boolean => {
  try {
    return matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return true;
  }
};

function readSheet(): boolean {
  try {
    return localStorage.getItem(SHEET_KEY) === '1';
  } catch {
    return false;
  }
}

function saveSheet(on: boolean): void {
  try {
    localStorage.setItem(SHEET_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}

// ---------- the rehearsal ----------

interface Props {
  doc: AdminContentDoc;
  media: MediaIndex;
  faces: Faces;
  guests: RehearsalGuest[];
  mb: MediaBackend;
  onClose: () => void;
}

/** Where a fresh rehearsal starts: a moment of the full lobby, then question 1. */
const startOf = (tl: Timeline): number => Math.max(tl.t0, (tl.rounds[0]?.introAt ?? tl.t0) - 3_000);

/** The show waits this long (real time) for a question's video to load before it goes on without it. */
const VIDEO_WAIT_MS = 30_000;
/** …and this long for a reveal video to play to its end before the board (×2/×4 would cut it). */
const REVEAL_WAIT_MS = 120_000;

/** Video lengths the TV's element reported, for files whose media doc has none. */
function withDurations(media: MediaIndex, learned: Readonly<Record<string, number>>): MediaIndex {
  const ids = Object.keys(learned).filter((id) => media[id] && !((media[id]?.durationS ?? 0) > 0));
  if (!ids.length) return media;
  const out = { ...media };
  for (const id of ids) out[id] = { ...(media[id] as MediaIndex[string]), durationS: learned[id] as number };
  return out;
}

function Rehearsal({ doc, media, faces, guests, mb, onClose }: Props) {
  const [mode, setMode] = useState<MyMode>('auto');
  const [manual, setManual] = useState<Record<Id, ManualAnswer | null>>({});
  const [learned, setLearned] = useState<Record<string, number>>({});
  const mediaAll = useMemo(() => withDurations(media, learned), [media, learned]);
  const tl = useMemo(() => simulate({ content: doc, media: mediaAll, guests, faces, me: { mode, manual }, seed: SEED }), [doc, mediaAll, guests, faces, mode, manual]);

  const clockRef = useRef<VirtualClock | null>(null);
  if (!clockRef.current) {
    clockRef.current = new VirtualClock(startOf(tl));
    clockRef.current.play();
  }
  const clock = clockRef.current;
  // A re-simulated show (another «Мой ответ», a tap, edited questions): stay on the same stage.
  const shown = useRef(tl);
  if (shown.current !== tl) {
    clock.end = tl.end;
    clock.set(remapTime(shown.current, tl, clock.now()));
    shown.current = tl;
  }
  clock.end = tl.end;
  const tlRef = useRef(tl);
  tlRef.current = tl;

  const [, force] = useReducer((n: number) => n + 1, 0);
  const [epoch, setEpoch] = useState({ tv: 0, phone: 0 });
  const [speed, setSpeed] = useState<Speed>(1);
  const [sound, setSound] = useState(false);
  const [sheet, setSheet] = useState(readSheet);
  const [phoneMode, setPhoneMode] = useState<'light' | 'dark'>(() => (systemDark() ? 'dark' : 'light'));
  const narrow = useNarrow();
  const [view, setView] = useState<NarrowView>(() => (innerWidth > innerHeight * 1.15 ? 'tv' : 'phone'));

  // The TV's video on air during the watch stage (set on every render, read by the ticker).
  const watchRef = useRef<{ key: string | null; mediaId: string | null }>({ key: null, mediaId: null });
  // The reveal on air with a video: the board waits until the TV has played it (like live, where the
  // organizer lets it finish); `boardAt` is when the simulated organizer presses on.
  const revealRef = useRef<{ key: string | null; boardAt: number | null }>({ key: null, boardAt: null });
  const revealEnded = useRef(new Set<string>());
  const holdRef = useRef<{ since: number; gaveUp: string | null; why: 'load' | 'reveal' }>({ since: 0, gaveUp: null, why: 'load' });
  const mediaRef = useRef(mediaAll);
  mediaRef.current = mediaAll;

  useEffect(() => {
    const id = setInterval(() => {
      // Like live, where the TV reports the video's end: the show waits while the video loads
      // (a big file from the base, a slow decoder) instead of running past a frozen frame.
      const { key, mediaId } = watchRef.current;
      const v = tvVideo();
      const h = holdRef.current;
      const loading = mediaId !== null && !mediaReady(mediaId);
      const buffering = v.isConnected && !v.error && !v.ended && !v.paused && v.readyState < 3;
      const watchWant = key !== null && (loading || buffering);
      const r = revealRef.current;
      const revealWant = r.key !== null && r.boardAt !== null && clock.now() >= r.boardAt - 400 && !revealEnded.current.has(r.key) && !v.error;
      const holdKey = watchWant ? key : revealWant ? r.key : null;
      const want = holdKey !== null && clock.playing && holdKey !== h.gaveUp;
      if (want && !clock.holding) {
        h.since = performance.now();
        h.why = watchWant ? 'load' : 'reveal';
      }
      const wait = want && performance.now() - h.since < (h.why === 'reveal' ? REVEAL_WAIT_MS : VIDEO_WAIT_MS);
      if (want && !wait) h.gaveUp = holdKey;
      clock.hold(wait);
      // a video whose media doc has no length: take it from the element (the show is re-planned)
      if (mediaId && v.isConnected && Number.isFinite(v.duration) && v.duration > 0 && !((mediaRef.current[mediaId]?.durationS ?? 0) > 0)) {
        const d = Math.round(v.duration * 10) / 10;
        setLearned((l) => (l[mediaId] === d ? l : { ...l, [mediaId]: d }));
      }
      force();
    }, 120);
    return () => clearInterval(id);
  }, [clock]);

  // «Ты»'s reactions from the phone fly over the TV like live
  const [sent, setSent] = useState<{ e: number; at: number }[]>([]);

  let now = clock.now();
  if (clock.playing && now >= tl.end) {
    clock.pause();
    now = clock.now();
  }
  const pos = positionAt(tl, now);
  const snap = snapshotAt(tl, now);
  const mine = sent.filter((r) => r.at <= now);
  const flying = mine.filter((r) => r.at > now - 60_000).map((r) => ({ id: `${tl.meUid}_${r.at}`, uid: tl.meUid, e: r.e, at: r.at }));
  const tv = buildTvView(flying.length ? { ...snap, reactions: [...snap.reactions, ...flying] } : snap, now);
  const pv = buildPlayerView({ ...playerInputAt(tl, now), reactionsSent: mine.map((r) => r.at) }, now);
  // (only while the TV is on screen: the phone-only view has no video to wait for)
  const onAir = (!narrow || view === 'tv') && tv.watch?.stage === 'play' && tv.question?.media?.kind === 'video' ? tv.question.media.mediaId : null;
  // …and the video after the final (it plays for its whole length, like live)
  const finAir = (!narrow || view === 'tv') && tv.finale?.stage === 'play' ? (tv.finale.videoId ?? BUILTIN_VIDEO_ID) : null;
  // …and the «Сюрприз» video (the whole of it, like live; → skips it)
  const surAir = (!narrow || view === 'tv') && tv.surprise?.stage === 'play' ? (tv.surprise.videoId ?? SURPRISE_VIDEO_ID) : null;
  watchRef.current =
    onAir && tv.question
      ? { key: `${tv.question.i}:${epoch.tv}`, mediaId: onAir }
      : finAir
        ? { key: `finale:${epoch.tv}`, mediaId: finAir }
        : surAir
          ? { key: `surprise:${epoch.tv}`, mediaId: surAir }
          : { key: null, mediaId: null };
  const rvOnAir = (!narrow || view === 'tv') && tv.phase === 'reveal' && tv.reveal?.media?.kind === 'video' ? tv.reveal : null;
  revealRef.current = rvOnAir ? { key: `rv${rvOnAir.i}:${epoch.tv}`, boardAt: tl.rounds.find((x) => x.i === rvOnAir.i)?.boardAt ?? null } : { key: null, boardAt: null };

  // ---- sound: off by default; the page's own mute setting comes back on close
  useEffect(() => {
    const was = audio.isMuted;
    return () => audio.setMuted(was);
  }, []);
  useEffect(() => audio.setMuted(!sound), [sound]);

  // ---- the TV's video follows the virtual clock: ×2/×4, pause
  const pausedByUs = useRef(false);
  const playing = clock.playing;
  const watchPlay = tv.watch?.stage === 'play' || tv.surprise?.stage === 'play';
  useEffect(() => {
    const v = tvVideo();
    v.defaultPlaybackRate = speed;
    if (v.playbackRate !== speed) v.playbackRate = speed;
    if (!v.isConnected) return;
    if (!playing && !v.paused) {
      v.pause();
      pausedByUs.current = true;
    } else if (playing && pausedByUs.current) {
      pausedByUs.current = false;
      void v.play().catch(() => undefined);
    }
  });
  useEffect(() => {
    // the watch stage was jumped into while paused: the TV starts it when the clock runs again
    if (!watchPlay) pausedByUs.current = false;
  }, [watchPlay]);
  useEffect(
    () => () => {
      const v = tvVideo();
      v.pause();
      v.defaultPlaybackRate = 1;
      v.playbackRate = 1;
    },
    [],
  );
  // the reveal video played to its end (or cannot play): the board may come
  useEffect(() => {
    const v = tvVideo();
    const done = () => {
      const key = revealRef.current.key;
      if (key && v.closest('.trc-media')) revealEnded.current.add(key);
    };
    v.addEventListener('ended', done);
    v.addEventListener('error', done);
    return () => {
      v.removeEventListener('ended', done);
      v.removeEventListener('error', done);
    };
  }, []);

  // ---- navigation
  const jump = useCallback(
    (t: number) => {
      const l = tlRef.current;
      clock.set(Math.max(l.t0, Math.min(l.end, t)));
      pausedByUs.current = false;
      setEpoch((e) => ({ ...e, tv: e.tv + 1 }));
      force();
    },
    [clock],
  );
  const togglePlay = useCallback(() => {
    const l = tlRef.current;
    if (clock.playing) clock.pause();
    else {
      if (clock.now() >= l.end - 50) {
        clock.set(startOf(l));
        setEpoch((e) => ({ tv: e.tv + 1, phone: e.phone + 1 }));
      }
      clock.play();
    }
    force();
  }, [clock]);
  const restart = useCallback(() => {
    setManual({});
    setSent([]);
    clock.set(startOf(tlRef.current));
    clock.play();
    setEpoch((e) => ({ tv: e.tv + 1, phone: e.phone + 1 }));
    force();
  }, [clock]);
  const prev = useCallback(() => jump(prevMark(tlRef.current, clock.now())), [jump, clock]);
  const next = useCallback(() => jump(nextMark(tlRef.current, clock.now())), [jump, clock]);
  const changeSpeed = useCallback(
    (s: Speed) => {
      clock.setRate(s);
      setSpeed(s);
    },
    [clock],
  );
  const changeMode = useCallback((m: MyMode) => {
    setMode(m);
    setManual({});
    // the phone shows the new answer from its start (a verdict animates on mount)
    setEpoch((e) => ({ ...e, phone: e.phone + 1 }));
  }, []);
  const toggleSound = useCallback(() => {
    setSound((on) => {
      if (!on) {
        // inside the click: the sound engine may start, the video may play with sound
        audio.unlock();
        const v = tvVideo();
        if (v.isConnected) v.muted = false;
      }
      return !on;
    });
  }, []);
  const toggleSheet = useCallback(() => {
    setSheet((s) => {
      saveSheet(!s);
      return !s;
    });
  }, []);

  // ---- keys: space ▶/❚❚, ← →, 1…9 questions, Esc closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat) togglePlay();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        prev();
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        next();
      } else if (e.code === 'Escape') onClose();
      else if (/^Digit[1-9]$/.test(e.code)) {
        const at = markAt(tlRef.current, 'question', Number(e.code.slice(5)) - 1);
        if (at !== null) jump(at);
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [togglePlay, prev, next, jump, onClose]);

  // ---- the phone: «Ты» can tap too (an answer at this moment of the show)
  const actions = useMemo<PlayerActions>(
    () => ({
      checkName: checkedName,
      join: async () => ({ ok: true }),
      answer: async (round: number, p: AnswerPayload) => {
        const r = tlRef.current.rounds.find((x) => x.i === round);
        if (r) setManual((m) => ({ ...m, [r.qid]: { p, at: Math.round(clock.now()) } }));
        return { ok: true };
      },
      react: async (e: number) => {
        const at = Math.round(clock.now());
        setSent((s) => [...s.filter((r) => r.at < at), { e, at }]);
        return { ok: true };
      },
      now: clock.now,
      media: (id: string) => mb.url(id),
      haptic: () => undefined,
    }),
    [clock, mb],
  );

  // ---- layout
  const [stageRef, box] = useBox();
  const tvMode = tl.settings.tvAppearance === 'system' ? (systemDark() ? 'dark' : 'light') : tl.settings.tvAppearance;
  const sheetW = sheet && !narrow ? Math.min(340, Math.max(260, box.w * 0.24)) : 0;
  const gap = Math.round(Math.max(24, Math.min(56, box.w * 0.03)));
  let tvS = 0.5;
  let phS = 0.5;
  if (!narrow) {
    // TV and phone share one height; around them: the stage padding (24 + 24), the gaps, the
    // sheet, the TV's frame (10 px a side) and the phone's bezel (~11 px a side at full size)
    const aw = box.w - 48 - gap - (sheetW ? sheetW + gap : 0) - 20 - 22;
    const ah = box.h - 32 - 26 - 20;
    const h = Math.max(160, Math.min(ah, aw / (16 / 9 + 390 / 844)));
    tvS = h / 720;
    phS = h / 844;
  } else if (view === 'tv') {
    tvS = Math.max(0.1, Math.min((box.w - 24) / 1280, (box.h - 24) / 720));
  }
  // narrow «Телефон»: the guest's phone at its own width (390 on a tablet) and at least a phone's
  // height, scaled down to the stage — the strip leaves ~630 px on a 390×844 phone, and the lobby's
  // reactions row sat below the cut
  const phFit = (() => {
    const dw = box.w <= PHONE_W_MAX ? Math.max(1, box.w) : PHONE_W;
    const s = Math.max(0.2, Math.min(1, box.w / dw, box.h / ((PHONE_MIN_H * dw) / PHONE_W)));
    return { dw, dh: Math.max(1, box.h / s), s };
  })();
  const showTv = !narrow || view === 'tv';
  const showPhone = !narrow || view === 'phone';

  const tvEl = showTv ? (
    <figure className="rh-dev rh-dev-tv">
      <div className="rh-tvbox" style={{ width: 1280 * tvS, height: 720 * tvS, '--s': tvS } as CSSProperties}>
        <div className="rh-screen vx" data-mode={tvMode}>
          <LiquidStage contained profile="tv" designWidth={1280} className="tv-stage" style={{ width: 1280 * tvS, height: 720 * tvS }}>
            <div className="tv-surface" style={{ transform: `scale(${tvS})` }}>
              <TvShow key={epoch.tv} view={tv} now={clock.now} muted={!sound} />
            </div>
          </LiquidStage>
        </div>
      </div>
      {!narrow ? <figcaption>{clock.holding ? (holdRef.current.why === 'reveal' ? 'Экран ТВ · прогон ждёт, пока доиграет видео ответа…' : 'Экран ТВ · прогон ждёт, пока загрузится видео…') : 'Экран ТВ'}</figcaption> : null}
    </figure>
  ) : null;

  const phone = <PlayerShell key={epoch.phone} view={pv} actions={actions} contained />;
  const phoneEl = showPhone ? (
    narrow ? (
      <div className={cx('rh-phfull', (phFit.s < 0.999 || phFit.dw < box.w - 1) && 'is-fit')} data-mode={phoneMode} style={{ width: phFit.dw * phFit.s, height: phFit.dh * phFit.s }}>
        <div className="rh-phfit" style={{ width: phFit.dw, height: phFit.dh, transform: phFit.s < 0.999 ? `scale(${phFit.s})` : undefined }}>
          {phone}
        </div>
      </div>
    ) : (
      <figure className="rh-dev rh-dev-ph">
        <div className="rh-phbox" style={{ width: 390 * phS, height: 844 * phS, '--ps': phS } as CSSProperties}>
          <div className="rh-phscreen" data-mode={phoneMode} style={{ transform: `scale(${phS})` }}>
            {phone}
          </div>
        </div>
        <figcaption>Телефон гостя · «Ты»</figcaption>
      </figure>
    )
  ) : null;

  return (
    <div className={cx('rh', narrow && 'is-narrow')} data-mode="dark">
      <LiquidOff>
        <Strip
          tl={tl}
          pos={pos}
          now={now}
          playing={clock.playing}
          speed={speed}
          mode={mode}
          phoneMode={phoneMode}
          sound={sound}
          sheet={sheet}
          narrow={narrow}
          view={view}
          onJump={jump}
          onPrev={prev}
          onNext={next}
          onPlay={togglePlay}
          onRestart={restart}
          onSpeed={changeSpeed}
          onMode={changeMode}
          onPhoneMode={() => setPhoneMode((m) => (m === 'dark' ? 'light' : 'dark'))}
          onSound={toggleSound}
          onSheet={toggleSheet}
          onView={setView}
          onClose={onClose}
        />
      </LiquidOff>
      <main className={cx('rh-stage', narrow && `is-${view}`)} ref={stageRef} style={!narrow ? { gap } : undefined}>
        {box.w > 0 ? (
          <>
            {tvEl}
            {phoneEl}
          </>
        ) : null}
        {sheet ? (
          <LiquidOff>
            <div className={cx('rh-sheetwrap', narrow && 'is-over')} style={!narrow ? { width: sheetW } : undefined}>
              <CheatSheet tl={tl} tv={tv} pos={pos} onClose={toggleSheet} />
            </div>
          </LiquidOff>
        ) : null}
        {!clock.playing && now >= tl.end - 50 ? (
          <button type="button" className="rh-again" onClick={restart}>
            <Icon name="restore" size={18} />
            Ещё раз с начала
          </button>
        ) : null}
      </main>
    </div>
  );
}

// ---------- the route ----------

function Wait({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div className="rh rh-wait" data-mode="dark">
      <i className="rh-wait-drop" aria-hidden="true" />
      <p>{text}</p>
      <button type="button" className="rh-close" onClick={onClose}>
        <Icon name="x" size={16} />
        Закрыть
      </button>
    </div>
  );
}

export function RehearsalPage() {
  const { content, backend } = useAdmin();
  const c = useContent(content);
  const doc = c.doc;
  const [, navigate] = useLocation();
  const onClose = useCallback(() => navigate(rehearsalReturn()), [navigate]);
  const vladosLabel = normalizeSettings(doc?.settings).vladosLabel;
  const guests = useMemo(() => rehearsalGuests(24, SEED, vladosLabel), [vladosLabel]);
  const media = useMediaIndex(doc, backend.media);
  const faces = useFaces(guests);
  useTvMedia(doc, media.index, backend.media);

  // the page scrolls under nothing: the rehearsal owns the viewport while it is open
  useLayoutEffect(() => {
    const root = document.documentElement;
    const was = root.style.overflow;
    root.style.overflow = 'hidden';
    return () => {
      root.style.overflow = was;
    };
  }, []);

  if (c.status === 'loading') return <Wait text="Загружаю вопросы…" onClose={onClose} />;
  if (!doc || !doc.questions.some((q) => !q.disabled)) return <Wait text="Нет включённых вопросов — добавь их во вкладке «Вопросы», и прогон покажет всю игру." onClose={onClose} />;
  if (!media.ready || !faces) return <Wait text="Готовлю прогон: гости рассаживаются…" onClose={onClose} />;
  return <Rehearsal doc={doc} media={media.index} faces={faces} guests={guests} mb={backend.media} onClose={onClose} />;
}
