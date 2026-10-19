// One question on air: intro (kinetic title, ×2 slam, type hint) → open (options, media, mercury
// timer, the crowd lighting up as they answer, hurry mode) → locked (time is up / all answered).
// A video question has the watch stage inside its intro: the video plays big with sound, its end
// is reported to the host, then a 3-2-1 and only then the answers (and their timer) open.

import { gsap } from 'gsap';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, ChromeBlock, ChromeText, Odometer, TimerTube, audio, beats, cx, ease, fmtInt, plural, useLiquid } from '../../../visual';
import type { QuestionView, TvView } from '../../../host';
import { ChoiceGrid, KEYS, useGridRefs, type TileLook } from '../choice';
import { Crowd, ItemPic, MediaFrame, QTop, crowdLayout, fmtNum, titleSize, useBeat, useTvEnv } from '../common';

export const TYPE_HINT: Record<QuestionView['type'], string> = {
  choice: 'выбери вариант',
  number: 'угадай число',
  ordering: 'расставь по порядку',
};

// ------------------------------------------------------------------ bodies

export function NumberBody({ q, answer }: { q: QuestionView; answer?: number | null }) {
  const n = q.number;
  const hasRange = n?.min !== undefined && n?.max !== undefined && (n.max as number) > (n.min as number);
  return (
    <div className="tq-num">
      <p className="vx-kick">ответ — число{n?.unit ? `, ${n.unit}` : ''}</p>
      <div className="tq-num-q">
        <ChromeText as="span" className="tq-num-big">
          {answer !== undefined && answer !== null ? fmtNum(answer) : '?'}
        </ChromeText>
      </div>
      {hasRange ? (
        <div className="tq-num-range">
          <span>{fmtNum(n?.min as number)}</span>
          <i className="tq-num-line" />
          <span>{fmtNum(n?.max as number)}</span>
        </div>
      ) : (
        <p className="tq-num-free">вводи на телефоне</p>
      )}
    </div>
  );
}

/** Row height of an ordering list on the TV (question and reveal share it). */
export function orderRowH(n: number): number {
  return n > 5 ? 56 : n > 4 ? 64 : 72;
}

/**
 * One ordering item on the TV: a chrome pill, the key / place number in an engraved coin on the
 * left, the text engraved on the chrome (the phone's OrderList row, TV-sized). Fills its row.
 */
export function OrderPill({
  no,
  text,
  mediaId,
  film = 0.34,
  tar = 0,
  glow = 0,
}: {
  no: string | number;
  text?: string;
  mediaId?: string;
  film?: number;
  tar?: number;
  glow?: number;
}) {
  return (
    <ChromeBlock shape="pill" film={film} tar={tar} glow={glow} className="tv-ord-pill">
      <span className="tv-ord-no">{no}</span>
      {mediaId ? <ItemPic id={mediaId} /> : null}
      {text ? <span className="tv-ord-t vx-eng">{text}</span> : null}
    </ChromeBlock>
  );
}

export function OrderBody({ q, locked = false }: { q: QuestionView; locked?: boolean }) {
  const items = q.items ?? [];
  const n = items.length;
  const rowH = orderRowH(n);
  return (
    <div className={cx('tq-ord', n > 4 && 'is-dense')}>
      <div className="tq-ord-axis" aria-hidden="true">
        <span>{q.firstLabel || 'Раньше'}</span>
        <i />
        <span>{q.lastLabel || 'Позже'}</span>
      </div>
      <ol className={cx('tq-ord-list tv-ord-list', n > 4 && 'is-dense', n > 5 && 'is-denser')}>
        {items.map((it, k) => (
          <li key={it.id} className="tq-ord-it tv-ord-row" style={{ height: rowH }}>
            <OrderPill no={KEYS[k] ?? String(k + 1)} text={it.text} mediaId={it.mediaId} film={locked ? 0.12 : 0.34} tar={locked ? 0.22 : 0} />
          </li>
        ))}
      </ol>
    </div>
  );
}

// ------------------------------------------------------------------ scene

export function Question({ view, q }: { view: TvView; q: QuestionView }) {
  const env = useTvEnv();
  const { engine } = useLiquid();
  const root = useRef<HTMLDivElement | null>(null);
  const introTitle = useRef<HTMLElement | null>(null);
  const openTitle = useRef<HTMLElement | null>(null);
  const x2 = useRef<HTMLDivElement | null>(null);
  const refs = useGridRefs();
  const phase = view.phase;
  const intro = phase === 'intro';
  const locked = phase === 'locked';
  const timer = view.timer;
  const paused = !!view.pause;
  const answered = useMemo(() => new Set(view.answeredIds), [view.answeredIds]);
  const guests = view.players.filter((p) => !p.isVlados);
  const answeredGuests = guests.filter((p) => answered.has(p.uid)).length;
  const hurry = phase === 'open' && !paused && timer !== null && timer.kind === 'answer' && timer.remainingMs > 0 && timer.remainingMs <= 10_000;
  const allIn = phase !== 'intro' && view.counts.players > 0 && view.counts.answered >= view.counts.players;
  const hasVideo = q.media?.kind === 'video';
  // the video was the watch stage: it does not play again next to the options
  const watched = hasVideo && (q.media?.watchMs ?? 0) > 0;
  const w = intro ? view.watch : null;
  const wStage = w?.stage ?? null;
  const inWatch = wStage === 'play' || wStage === 'beat';
  const beatSec = wStage === 'beat' && timer ? Math.max(1, Math.ceil(timer.remainingMs / 1000)) : null;
  const [shownOpen, setShownOpen] = useState(!intro);
  const L = crowdLayout(view.players.length);

  // ---- the video ended here: tell the host (retried while it has not moved on, e.g. offline)
  const envRef = useRef(env);
  envRef.current = env;
  const revRef = useRef(view.phaseRev);
  revRef.current = view.phaseRev;
  const [endedAt, setEndedAt] = useState<number | null>(null);
  const onVideoEnded = useCallback(() => setEndedAt((t) => t ?? Date.now()), []);
  useEffect(() => {
    if (endedAt === null || wStage !== 'play' || paused) return;
    envRef.current.onWatchEnded?.(revRef.current);
    const t = setTimeout(() => setEndedAt(Date.now()), 4_000);
    return () => clearTimeout(t);
  }, [endedAt, wStage, paused]);

  // ---- the 3-2-1 before the answers open
  useEffect(() => {
    if (beatSec === null) return;
    audio.bell(beatSec === 1 ? 784 : 523, 0.08, 0.8);
    engine?.ripple(640, 400, 0.6);
  }, [beatSec, engine]);

  // ---- intro: kicker, words rise, ×2 slams in
  useBeat(
    (eng) => {
      if (!intro) return;
      const qs = gsap.utils.selector(root);
      const tl = gsap.timeline();
      tl.fromTo(qs('.tq-i-kick'), { opacity: 0, y: -16 }, { opacity: 1, y: 0, duration: 0.6, ease: 'power3.out' }, 0);
      tl.fromTo(qs('.tq-i-n'), { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1, duration: 0.9, ease: ease.elastic }, 0.05);
      tl.add(beats.riseLetters(introTitle.current, { stagger: 0.07 }), 0.3);
      tl.fromTo(qs('.tq-i-hint'), { opacity: 0 }, { opacity: 1, duration: 0.6 }, 0.9);
      tl.call(() => audio.rise(0.8), undefined, 0.1);
      if (q.double && x2.current) {
        tl.set(x2.current, { opacity: 1 }, 1.25);
        tl.fromTo(x2.current, { scale: 4.2, rotate: -18 }, { scale: 1, rotate: -6, duration: 0.55, ease: 'power4.in' }, 1.25);
        tl.call(
          () => {
            audio.boom();
            eng?.flash(0.55);
            if (eng) eng.ripple(640, 470, 1.6);
            if (root.current) gsap.fromTo(root.current, { x: -14 }, { x: 0, duration: 0.7, ease: 'elastic.out(1.2,0.25)' });
          },
          undefined,
          1.8,
        );
      }
      return tl;
    },
    [intro],
  );

  // ---- open: the intro layer flies off, the question assembles
  useBeat(
    (eng) => {
      if (intro) return;
      const qs = gsap.utils.selector(root);
      const tl = gsap.timeline();
      const fromIntro = !shownOpen;
      if (fromIntro) {
        tl.to(qs('.tq-intro'), { opacity: 0, y: -60, scale: 0.9, duration: 0.45, ease: 'power2.in' }, 0);
        tl.call(() => setShownOpen(true), undefined, 0.46);
        tl.call(() => {
          audio.drop(0.7, 0.4);
          eng?.ripple(640, 360, 1.1);
        }, undefined, 0.2);
      }
      const t0 = fromIntro ? 0.3 : 0;
      tl.fromTo(qs('.tv-top'), { opacity: 0, x: -14 }, { opacity: 1, x: 0, duration: 0.5 }, t0);
      tl.add(beats.riseLetters(openTitle.current, { stagger: 0.035 }), t0 + 0.05);
      tl.fromTo(qs('.tq-media'), { opacity: 0, scale: 0.94 }, { opacity: 1, scale: 1, duration: 0.8, ease: ease.back }, t0 + 0.25);
      // the answers stay invisible until their own pop (not a shrunken copy under the flying intro)
      const cells = qs('.tv-cell, .tq-ord-it, .tq-num');
      tl.fromTo(cells, { opacity: 0 }, { opacity: 1, duration: 0.22, stagger: 0.08, ease: 'power1.out' }, t0 + 0.35);
      tl.add(beats.popIn(cells, { from: 0.3, stagger: 0.08 }), t0 + 0.35);
      tl.fromTo(qs('.tq-tube, .tq-ans'), { opacity: 0 }, { opacity: 1, duration: 0.6 }, t0 + 0.6);
      tl.fromTo(qs('.tv-cav'), { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.4, stagger: 0.006 }, t0 + 0.5);
      return tl;
    },
    [intro],
  );

  // ---- question music (a video playing next to the options carries its own sound)
  const videoInOpen = hasVideo && !watched;
  useEffect(() => {
    const on = phase === 'open' && !paused && env.sound.music && !videoInOpen;
    audio.music(on, hurry);
    return () => audio.music(false);
  }, [phase, paused, env.sound.music, videoInOpen, hurry]);

  // ---- time is up: the room holds its breath
  useEffect(() => {
    if (!locked) return;
    const qs = gsap.utils.selector(root);
    const tl = gsap.timeline();
    tl.fromTo(qs('.tq-up'), { opacity: 0, scale: 2.2 }, { opacity: 1, scale: 1, duration: 0.5, ease: 'power4.in' });
    tl.call(() => {
      audio.drop(0.5, 0.5);
      engine?.ripple(640, 360, 1.2);
    });
    if (engine) {
      tl.to(engine.scene, { agit: 0.55, duration: 0.8 }, 0.4);
    }
    return () => {
      tl.kill();
      if (engine) gsap.to(engine.scene, { agit: 0, duration: 0.6 });
    };
  }, [locked, engine]);

  // ---- everyone answered: a small fanfare before the early lock
  const fanfared = useRef(false);
  useEffect(() => {
    if (!allIn || fanfared.current || intro) return;
    fanfared.current = true;
    audio.bell(523, 0.1, 1.4);
    audio.bell(659, 0.08, 1.4, 0.09);
    audio.bell(784, 0.08, 1.8, 0.18);
    engine?.flash(0.25);
    const el = root.current?.querySelector('.tq-all');
    if (el) gsap.fromTo(el, { opacity: 0, y: 20, scale: 0.8 }, { opacity: 1, y: 0, scale: 1, duration: 0.8, ease: ease.back });
  }, [allIn, intro, engine]);

  const looks: TileLook[] = (q.options ?? []).map(() => ({ state: locked ? ('locked' as const) : ('idle' as const) }));
  const tSize = titleSize(q.title);
  // the whole thermometer (bulb included) from under the top line down to just above the crowd
  const tubeH = Math.min(560, L.top - 92);

  return (
    <div className={cx('tv-scene tv-q', intro && 'is-intro', inWatch && 'is-watch', hurry && 'is-hurry', locked && 'is-locked', q.media && 'has-media')} ref={root}>
      {/* ---------------- intro layer */}
      {intro || !shownOpen ? (
        <div className="tq-intro">
          <p className="tq-i-kick vx-kick">
            вопрос {q.n} из {q.total}
          </p>
          <ChromeText as="span" className="tq-i-n">
            {String(q.n)}
          </ChromeText>
          <ChromeText ref={introTitle} as="h2" split="words" className={cx('tq-i-title', tSize)}>
            {q.title}
          </ChromeText>
          <p className="tq-i-hint">
            <span className="vx-kick">{TYPE_HINT[q.type]}</span>
          </p>
          {q.double ? (
            <div ref={x2} className="tq-x2" style={{ opacity: 0 }}>
              <Badge liquid size="l">
                ×2
              </Badge>
              <span>{env.texts.doubleBadge || 'Двойные очки ×2'}</span>
            </div>
          ) : null}
          {intro && timer ? <i key={q.i} className="tq-i-bar" style={{ animationDuration: `${Math.max(300, timer.remainingMs)}ms`, animationPlayState: paused ? 'paused' : 'running' }} /> : null}
        </div>
      ) : null}

      {/* ---------------- watch layer: the video big, with sound; then the 3-2-1 over its last frame */}
      {inWatch && w && q.media ? (
        <div className="tq-watch">
          <div className="tq-w-top">
            <span className="vx-kick">
              вопрос {q.n} из {q.total}
            </span>
            <span className="vx-kick tq-w-hint">{wStage === 'beat' ? 'ответы открываются' : paused ? 'пауза' : 'смотрим видео — ответы после него'}</span>
          </div>
          <ChromeText as="h2" className={cx('tq-w-title', tSize)}>
            {q.title}
          </ChromeText>
          <MediaFrame media={q.media} play={wStage === 'play' && !paused} hold watch={{ fromMs: w.posMs, onEnded: onVideoEnded }} className="tq-w-media" />
          {beatSec !== null ? (
            <div className="tq-beat" aria-live="polite">
              <ChromeText key={beatSec} as="span" className="tq-beat-n">
                {String(beatSec)}
              </ChromeText>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ---------------- question layer */}
      {!intro ? (
        <>
          <QTop q={q} />
          <div className="tq-body" style={{ bottom: 720 - L.top + 18 }}>
            <ChromeText ref={openTitle} as="h2" split="words" className={cx('tq-title', tSize)}>
              {q.title}
            </ChromeText>
            <div className="tq-main">
              {q.media ? <MediaFrame media={q.media} play={phase === 'open' && !paused && !watched} className="tq-media" /> : null}
              {q.type === 'choice' ? <ChoiceGrid options={q.options ?? []} looks={looks} column={!!q.media} refs={refs} /> : null}
              {q.type === 'number' ? <NumberBody q={q} /> : null}
              {q.type === 'ordering' ? <OrderBody q={q} locked={locked} /> : null}
            </div>
          </div>
          {timer ? (
            <div className="tq-tube">
              <TimerTube
                key={q.i}
                endsAt={timer.endsAt}
                total={Math.max(1, timer.totalMs / 1000)}
                now={env.now}
                frozenAt={locked ? 0 : paused ? timer.remainingMs / 1000 : null}
                height={tubeH}
                driveScene
                sound
              />
            </div>
          ) : null}
          <div className="tq-ans">
            <b>
              <Odometer value={answeredGuests} />
            </b>
            <span>
              из {fmtInt(guests.length)} {plural(answeredGuests, ['ответил', 'ответили', 'ответили'])}
            </span>
            {allIn ? <span className="tq-all">Все ответили!</span> : null}
          </div>
          {locked ? (
            <div className="tq-up">
              <ChromeText as="span">{allIn ? 'Ответы приняты' : 'Время вышло'}</ChromeText>
              <small>смотрим, кто угадал…</small>
            </div>
          ) : null}
          <Crowd players={view.players} answered={answered} />
        </>
      ) : null}
    </div>
  );
}
