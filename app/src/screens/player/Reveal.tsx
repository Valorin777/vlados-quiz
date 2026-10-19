// The moment of truth on the phone: a full-screen flood of bright chrome (right / close) or
// tarnish that drips off the bottom (wrong / no answer), points rolling up, ×2 slamming in, the
// rank jump, the right answer and what Vlados said.

import { gsap } from 'gsap';
import { useRef, useState } from 'react';
import type { PubMedia } from '@shared/fbtypes';
import type { PlayerReveal, PlayerView, QuestionView, Verdict } from '../../host/views';
import { Badge, ChromeBlock, Emerge, FitImage, Lightbox, Odometer, audio, beats, cx, ease, useDecoded, type Blob } from './vx';
import { answerText, correctText, fmtNum, itemText, itemsOf } from './format';
import { useEntrance, useMediaUrl } from './hooks';
import { Hud } from './parts';
import type { PlayerActions } from './types';

const GOOD: ReadonlySet<Verdict> = new Set<Verdict>(['correct', 'closest', 'close']);

function verdictWord(v: Verdict, view: PlayerView): string {
  const t = view.texts;
  switch (v) {
    case 'correct':
      return t.verdictCorrect;
    case 'closest':
      return t.verdictClosest;
    case 'close':
      return t.verdictClose.split(/[!.]/u)[0] + '!';
    case 'wrong':
      return t.verdictWrong;
    case 'none':
      return 'Без ответа';
  }
}

function subline(v: Verdict, r: PlayerReveal, view: PlayerView): string {
  const acc = r.mine?.acc;
  switch (v) {
    case 'correct':
      return 'чем быстрее ответ, тем больше очков';
    case 'closest':
      return 'ближе всех к правде — бонус твой';
    case 'close':
      return acc !== undefined ? `точность ${Math.round(acc * 100)}% — ${view.texts.verdictClose.split(/[!.]\s*/u)[1]?.toLocaleLowerCase('ru-RU') || 'почти'}` : view.texts.verdictClose;
    case 'wrong':
      return r.mine && r.mine.pts > 0 ? 'немного очков всё-таки капнуло' : 'в следующий раз повезёт';
    case 'none':
      return view.texts.noAnswer;
  }
}

/** The right answer, and where the guest stood relative to it. */
function Truth({ q, r }: { q: QuestionView; r: PlayerReveal }) {
  if (q.type === 'ordering' && Array.isArray(r.correct)) {
    const items = itemsOf(q);
    const mine = r.myAnswer?.t === 'ordering' ? r.myAnswer.ids : null;
    return (
      <div className="pl-r-truth">
        <p className="pl-r-lbl">Правильный порядок</p>
        <ol className="pl-r-order">
          {r.correct.map((id, k) => {
            const i = items.findIndex((it) => it.id === id);
            const hit = mine ? mine[k] === id : null;
            return (
              <li key={id} className={cx(hit === true && 'is-hit', hit === false && 'is-miss')}>
                <span className="pl-r-n">{k + 1}</span>
                <span className="pl-r-it">{itemText(items[i], i)}</span>
                {hit === null ? null : <span className="pl-r-mark" aria-label={hit ? 'на месте' : 'не на месте'}>{hit ? '✓' : '·'}</span>}
              </li>
            );
          })}
        </ol>
      </div>
    );
  }
  const right = correctText(q, r.correct);
  const my = r.myAnswer ? answerText(q, r.myAnswer) : null;
  return (
    <div className="pl-r-truth">
      <p className="pl-r-lbl">Правильный ответ</p>
      <p className="pl-r-right">{right}</p>
      {my && my !== right ? <p className="pl-r-my">у тебя: {my}</p> : null}
    </div>
  );
}

/**
 * The picture that comes with the right answer: a mercury droplet swells out of «Правильный ответ»
 * once the points and the place have landed, and spreads into the photo (whole, never cropped).
 * Tap → full screen. A video plays ONLY on the TV (organizer): its poster emerges instead, with a
 * «▶ на большом экране» badge.
 */
function RevealPhoto({ actions, media, from, go }: { actions: PlayerActions; media: PubMedia; from: () => Element | null | undefined; go: boolean }) {
  const video = media.kind === 'video';
  const id = video ? media.posterId : media.mediaId;
  const { url, failed } = useMediaUrl(actions, id);
  const { ar, failed: bad } = useDecoded(url);
  const [open, setOpen] = useState(false);
  if (!id || failed || bad) return null;
  const size = media.w && media.h ? { w: media.w, h: media.h } : {};
  return (
    <>
      <Emerge
        className={cx('pl-r-photo', video && 'is-video')}
        ready={go && ar !== null}
        from={from}
        {...(video ? {} : { onOpen: () => setOpen(true), label: 'Открыть фото на весь экран' })}
      >
        <FitImage src={url} fit="box" {...size} />
        {video ? (
          <span className="pl-r-tv">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 5.5v13l10.5-6.5z" />
            </svg>
            на большом экране
          </span>
        ) : (
          <span className="pl-r-zoom" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />
            </svg>
          </span>
        )}
      </Emerge>
      {video ? null : <Lightbox src={url} open={open} onClose={() => setOpen(false)} />}
    </>
  );
}

export function Reveal({ view, actions }: { view: PlayerView; actions: PlayerActions }) {
  const r = view.reveal;
  const q = view.question;
  const root = useRef<HTMLDivElement | null>(null);
  const flood = useRef<HTMLDivElement | null>(null);
  const fb = useRef<Blob | null>(null);
  const x2 = useRef<HTMLSpanElement | null>(null);
  const rankEl = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(0);
  // the reveal picture starts once the points and the place have landed (on the entrance timeline,
  // so a slow phone whose timeline lags behind the wall clock still keeps the order)
  const [photoGo, setPhotoGo] = useState(false);
  const verdict = r?.verdict ?? 'none';
  const good = GOOD.has(verdict);
  const total = r?.mine?.pts ?? 0;
  const double = q?.double === true && total > 0;
  const vlados = view.me?.isVlados === true;
  const vladosLabel = view.pub?.vladosLabel ?? 'Владос';

  useEntrance(
    (engine) => {
      const s = gsap.utils.selector(root);
      const tl = gsap.timeline();
      setShown(0);
      setPhotoGo(false);
      actions.haptic(good ? 'good' : 'bad');
      if (flood.current) tl.fromTo(flood.current, { scale: 0.22 }, { scale: 1, duration: 1, ease: 'elastic.out(1,0.7)' }, 0);
      if (good) {
        tl.call(
          () => {
            if (fb.current) beats.pulse(fb.current, 1, 1.6);
            engine?.flash(verdict === 'close' ? 0.15 : 0.3);
            audio.shine();
            if (engine && fb.current) engine.ripple(fb.current.x, fb.current.y, 1.2);
          },
          undefined,
          0.15,
        );
        tl.fromTo(s('.pl-r-t'), { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.5, stagger: 0.07 }, 0.35);
      } else {
        tl.call(() => audio.melt(0.35), undefined, 0.1);
        tl.fromTo(s('.pl-r-t'), { opacity: 0, y: -10 }, { opacity: 1, y: 0, duration: 0.5, stagger: 0.07 }, 0.4);
        tl.call(
          () => {
            const b = fb.current;
            if (!engine || !b) return;
            const bottom = b.y + b.hh - 6;
            for (let k = 0; k < 5; k++) beats.drip(engine, b.x - b.hw * 0.7 + k * b.hw * 0.35 + (Math.random() - 0.5) * 20, bottom, { delay: k * 0.15, r: 9 + Math.random() * 6 });
          },
          undefined,
          0.6,
        );
      }
      if (total > 0) {
        const half = double ? Math.round(total / 2) : total;
        tl.add(beats.countTo(0, half, setShown, { duration: 1, step: 10 }), 0.55);
        if (double && x2.current) {
          tl.fromTo(x2.current, { scale: 1.8, rotation: -14, opacity: 0 }, { scale: 1, rotation: 0, opacity: 1, duration: 0.6, ease: ease.back }, 1.7);
          tl.call(() => audio.drop(1.3, 0.4), undefined, 1.7);
          tl.to(x2.current, { x: -60, scale: 0.2, opacity: 0, duration: 0.45, ease: 'power3.in' }, 2.6);
          tl.call(() => {
            if (fb.current) beats.pulse(fb.current, 0.6, 1);
            audio.bell(659, 0.12, 1.4);
          }, undefined, 2.9);
          tl.add(beats.countTo(half, total, setShown, { duration: 0.8, step: 10 }), 2.95);
        }
      } else setShown(0);
      if (rankEl.current) tl.fromTo(rankEl.current, { scale: 1.8, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.7, ease: ease.back }, double ? 3.4 : 1.7);
      tl.call(() => setPhotoGo(true), undefined, double ? 4 : 2.3);
      return tl;
    },
    [r?.i],
  );

  if (!r || !q) return null;
  const mine = r.mine;
  const rank = mine?.rank ?? null;
  const prev = mine?.prev ?? null;
  const up = rank !== null && prev !== null ? prev - rank : 0;
  const pct = Math.round(r.pct * 100);
  // a photo when it is shown on phones; a video's poster always (the video itself is TV-only)
  const media = r.media && (r.media.kind === 'video' ? !!r.media.posterId : r.media.onPhones) ? r.media : null;

  return (
    <div className={cx('pl-res', good ? 'is-good' : 'is-bad', verdict === 'close' && 'is-close')} ref={root}>
      <ChromeBlock
        ref={flood}
        shape="box"
        radius={46}
        film={good ? (verdict === 'close' ? 0.6 : 0.24) : 0.2}
        tar={good ? 0 : 1}
        tone={good ? (verdict === 'close' ? 'film' : 'chrome') : 'tarnish'}
        blobRef={fb}
        className="pl-flood"
      />
      <div className="pl-r-hud">
        <Hud view={view} game />
      </div>
      <div className="pl-r-in">
        <p className="vx-kick pl-r-t">
          вопрос {q.n}
          {q.double ? ' · двойные очки' : ''}
        </p>
        <h2 className="pl-r-word pl-r-t">{verdictWord(verdict, view)}</h2>
        <div className="pl-r-pts pl-r-t" aria-label={`${total} очков за вопрос`}>
          <span>+</span>
          <Odometer value={shown} />
          {double ? (
            <span ref={x2} className="pl-r-x2" aria-hidden="true">
              <Badge size="l">×2</Badge>
            </span>
          ) : null}
        </div>
        <p className="pl-r-calc pl-r-t">{subline(verdict, r, view)}</p>
        <div className="pl-r-rank pl-r-t">
          {vlados || (mine && mine.rank === null) ? (
            <>
              <span>{view.texts.outOfCompetition}</span>
              <b ref={rankEl}>{fmtNum(mine?.tot ?? 0)}</b>
            </>
          ) : rank !== null ? (
            <>
              <span>{prev !== null && prev !== rank ? `было #${prev}` : up === 0 && prev !== null ? 'держишь место' : 'твоё место'}</span>
              <b ref={rankEl}>#{rank}</b>
              {up > 0 ? <em className="pl-r-up">↑{up}</em> : up < 0 ? <em className="pl-r-down">↓{-up}</em> : null}
            </>
          ) : (
            <span>ты присоединился после этого вопроса</span>
          )}
        </div>
        <div className="pl-r-t">
          <Truth q={q} r={r} />
        </div>
        {media ? (
          <RevealPhoto
            key={`${r.i}:${media.mediaId}`}
            actions={actions}
            media={media}
            from={() => root.current?.querySelector('.pl-r-right, .pl-r-order')}
            go={photoGo}
          />
        ) : null}
        {!vlados && r.vlados !== undefined ? (
          <p className="pl-r-vl pl-r-t">
            {r.vlados === null ? (
              `${vladosLabel} не успел ответить 🙈`
            ) : (
              <>
                <span>{view.texts.vladosAnswer}</span> <b>{answerText(q, r.vlados)}</b>
              </>
            )}
          </p>
        ) : null}
        <p className="pl-r-stat pl-r-t">
          {r.count > 0 ? `${q.type === 'choice' ? 'угадали' : 'попали'} ${pct}% гостей` : 'никто не успел ответить'}
        </p>
        {r.text ? <p className="pl-r-note pl-r-t">{r.text}</p> : null}
      </div>
    </div>
  );
}
