// Choice reveal: every guest's selfie flies from the crowd onto the option they picked (counts tick
// up), Vlados's crown lands on his pick, the surface trembles, wrong options melt and drip away,
// the right one ignites with a fountain, then the numbers of the round.

import { gsap } from 'gsap';
import { useMemo, useRef, useState } from 'react';
import { ChromeText, audio, beats, cx, ease, initialOf, plural } from '../../../visual';
import type { QuestionView, TvView } from '../../../host';
import { ChoiceGrid, useGridRefs, type TileLook } from '../choice';
import { Crowd, RevealMedia, QTop, crowdLayout, fmtSec, revealMediaAt, titleSize, useBeat, useTvEnv } from '../common';
import { designRect } from '../TvStage';

export function RevealChoice({ view, q }: { view: TvView; q: QuestionView }) {
  const env = useTvEnv();
  const rv = view.reveal;
  const root = useRef<HTMLDivElement | null>(null);
  const flyLayer = useRef<HTMLDivElement | null>(null);
  const crown = useRef<HTMLDivElement | null>(null);
  const crowdEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const refs = useGridRefs();
  const options = q.options ?? [];
  const correctId = typeof rv?.correct === 'string' ? rv.correct : null;
  const correctIdx = options.findIndex((o) => o.id === correctId);
  const [looks, setLooks] = useState<TileLook[]>(() => options.map(() => ({ state: 'locked' })));
  const [stage, setStage] = useState<'fly' | 'done'>('fly');
  const [showMedia, setShowMedia] = useState(false);
  const answered = useMemo(() => new Set((rv?.answers ?? []).map((a) => a.uid)), [rv]);
  const L = crowdLayout(view.players.length);

  const answers = rv?.answers ?? [];
  const guestAnswers = answers.filter((a) => !a.isVlados);
  const count = rv?.count ?? guestAnswers.length;
  const right = correctId ? (rv?.dist[correctId] ?? 0) : 0;
  const fastest = guestAnswers.filter((a) => a.ok).sort((a, b) => a.e - b.e)[0] ?? null;
  const vPick = rv?.vlados && rv.vlados.t === 'choice' ? rv.vlados.id : null;
  const vIdx = vPick ? options.findIndex((o) => o.id === vPick) : -1;
  const vLabel = view.pub?.vladosLabel || 'Владос';
  const vText = vIdx >= 0 ? (options[vIdx]?.text ?? `вариант ${'ABCDEF'[vIdx]}`) : null;

  useBeat(
    (engine) => {
      const qs = gsap.utils.selector(root);
      const layer = flyLayer.current;
      const tl = gsap.timeline();
      const made: HTMLElement[] = [];
      const counts = options.map(() => 0);
      const perOpt = options.map(() => 0);
      const totalPer = options.map((o) => answers.filter((a) => a.p.t === 'choice' && a.p.id === o.id).length);
      let flush = 0;
      const push = () => {
        if (flush) return;
        flush = requestAnimationFrame(() => {
          flush = 0;
          setLooks((ls) => ls.map((l, k) => ({ ...l, count: counts[k] })));
        });
      };
      tl.fromTo(qs('.tv-top, .trc-title'), { opacity: 0, y: -10 }, { opacity: 1, y: 0, duration: 0.5, stagger: 0.08 }, 0);

      // 1. the crowd flies to its picks
      const idxOf = new Map(view.players.map((p, i) => [p.uid, i]));
      const flyers: { el: HTMLElement; opt: number }[] = [];
      answers.forEach((a, j) => {
        if (a.p.t !== 'choice' || !layer) return;
        const choiceId = a.p.id;
        const opt = options.findIndex((o) => o.id === choiceId);
        const tile = designRect(refs.tiles[opt]);
        const i = idxOf.get(a.uid);
        if (opt < 0 || !tile || i === undefined) return;
        const from = L.at(i);
        const slot = perOpt[opt] ?? 0;
        perOpt[opt] = slot + 1;
        const n = totalPer[opt] ?? 1;
        const step = Math.min(17, (tile.w - 90) / Math.max(1, n));
        const tx = tile.x + 46 + slot * step;
        const ty = tile.y + tile.h - 2;
        const el = document.createElement('div');
        el.className = cx('tv-fly', a.isVlados && 'is-vlados');
        const src = env.avatars.get(a.uid);
        if (src) {
          const img = document.createElement('img');
          img.src = src;
          img.alt = '';
          el.appendChild(img);
        } else {
          const b = document.createElement('b');
          b.textContent = initialOf(a.name);
          el.appendChild(b);
        }
        layer.appendChild(el);
        made.push(el);
        flyers.push({ el, opt });
        const at = 0.5 + (answers.length > 1 ? (j / (answers.length - 1)) * 1.7 : 0);
        const peak = Math.min(from.y, ty) - 90 - Math.random() * 80;
        const p = { u: 0 };
        gsap.set(el, { x: from.x - 11, y: from.y - 11, scale: 1.1, opacity: 0 });
        tl.set(el, { opacity: 1 }, at);
        tl.call(() => crowdEls.current.get(a.uid)?.classList.add('is-gone'), undefined, at);
        tl.to(
          p,
          {
            u: 1,
            duration: 0.75,
            ease: 'power1.inOut',
            onUpdate: () => {
              const u = p.u;
              const x = from.x + (tx - from.x) * u;
              const y = (1 - u) * (1 - u) * from.y + 2 * (1 - u) * u * peak + u * u * ty;
              gsap.set(el, { x: x - 11, y: y - 11, scale: 1.1 - 0.25 * u });
            },
          },
          at,
        );
        tl.call(
          () => {
            // tiles count the guests (Vlados is «вне конкурса», like reveal.dist)
            if (!a.isVlados) counts[opt] = (counts[opt] ?? 0) + 1;
            push();
            audio.drop(0.8 + (opt % 4) * 0.12, 0.18);
          },
          undefined,
          at + 0.75,
        );
      });
      const tFly = answers.length ? 0.5 + 1.7 + 0.8 : 0.4;
      tl.to(qs('.tv-crowd'), { opacity: 0, y: 30, duration: 0.6 }, tFly);

      // 2. Vlados's crown drops onto his pick
      if (vIdx >= 0 && crown.current) {
        const tile = designRect(refs.tiles[vIdx]);
        if (tile) {
          gsap.set(crown.current, { x: tile.x + tile.w - 132, y: tile.y - 34, opacity: 0 });
          tl.set(crown.current, { opacity: 1 }, tFly + 0.1);
          tl.fromTo(crown.current, { yPercent: -260 }, { yPercent: 0, duration: 0.9, ease: ease.bounce }, tFly + 0.1);
          tl.call(() => audio.bell(523, 0.1, 1.2), undefined, tFly + 0.5);
        }
      }

      // 3. suspense
      const tS = tFly + (vIdx >= 0 ? 1 : 0.3);
      tl.call(() => audio.rise(0.7), undefined, tS);
      if (engine) {
        tl.to(engine.scene, { agit: 0.9, duration: 0.5, ease: 'power2.in' }, tS + 0.1);
        tl.to(engine.scene, { agit: 0, duration: 0.6, ease: 'power2.out' }, tS + 0.7);
      }
      tl.fromTo(refs.tiles.filter(Boolean), { scale: 1 }, { scale: 1.04, duration: 0.4, yoyo: true, repeat: 1, ease: 'power2.in' }, tS + 0.1);

      // 4. wrong options tarnish, sag and drip (they stay readable), their flyers go dull
      const tM = tS + 0.9;
      options.forEach((_, k) => {
        if (k === correctIdx) return;
        const at = tM + k * 0.16;
        tl.call(() => {
          const el = refs.tiles[k];
          if (el?.classList.contains('tv-pic')) beats.meltWrong(engine, refs.blobs[k]?.current, { mode: 'sag', el, drips: 3 });
          setLooks((ls) => ls.map((l, j) => (j === k ? { ...l, count: counts[j], state: el?.classList.contains('tv-pic') ? 'wrong' : 'melting' } : l)));
        }, undefined, at);
        const mine = flyers.filter((f) => f.opt === k).map((f) => f.el);
        if (mine.length) tl.to(mine, { y: '+=10', opacity: 0.35, filter: 'grayscale(1)', duration: 0.8, ease: 'power2.in', stagger: 0.008 }, at + 0.3);
      });
      if (vIdx >= 0 && vIdx !== correctIdx && crown.current) tl.to(crown.current, { rotation: 30, y: '+=40', opacity: 0, duration: 0.8, ease: 'power2.in' }, tM + 0.4);

      // 5. the right one ignites
      const tC = tM + 0.8 + options.length * 0.1;
      // no per-answer rows (e.g. the TV reloaded mid-reveal): fall back to the public counts
      const final = answers.length ? counts : options.map((o) => rv?.dist[o.id] ?? 0);
      tl.call(() => {
        setLooks((ls) => ls.map((l, k) => ({ ...l, count: final[k], state: k === correctIdx ? 'correct' : l.state })));
        const el = refs.tiles[correctIdx];
        if (el) gsap.fromTo(el, { scale: 1 }, { scale: 1.05, duration: 0.5, ease: ease.back });
        if (el?.classList.contains('tv-pic')) beats.igniteCorrect(engine, refs.blobs[correctIdx]?.current, { label: el.querySelector('.tv-pic-t'), width: el.offsetWidth * 0.8 });
        if (!engine) audio.shine();
      }, undefined, tC);
      const good = flyers.filter((f) => f.opt === correctIdx).map((f) => f.el);
      if (good.length) tl.to(good, { y: '-=22', duration: 0.28, yoyo: true, repeat: 3, ease: 'power2.out', stagger: 0.02 }, tC + 0.2);
      if (vIdx === correctIdx && crown.current) tl.fromTo(crown.current, { scale: 1 }, { scale: 1.25, duration: 0.35, yoyo: true, repeat: 1, ease: 'power2.out' }, tC + 0.3);

      // 6. the numbers of the round
      tl.call(() => setStage('done'), undefined, tC + 1.2);
      tl.fromTo(qs('.trc-sum > *'), { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.7, stagger: 0.25, ease: 'power3.out' }, tC + 1.3);
      // the picture / video that comes with the answer: a video right after the right option lights
      // up (the organizer: «после правильного ответа, ну или одновременно»), a photo once the room's
      // numbers have been read
      if (rv?.media) tl.call(() => setShowMedia(true), undefined, revealMediaAt(rv.media, tC, { video: 1.2, image: 3.5 }));

      return () => {
        tl.kill();
        if (flush) cancelAnimationFrame(flush);
        made.forEach((el) => el.remove());
        if (engine) gsap.to(engine.scene, { agit: 0, duration: 0.4 });
      };
    },
    [rv?.i],
  );

  if (!rv) return null;
  const pct = Math.round((rv.pct ?? 0) * 100);

  return (
    <div className={cx('tv-scene tv-rc', stage === 'done' && 'is-done', showMedia && 'is-media')} ref={root}>
      <QTop q={q} suffix="ответ" />
      <div className="tq-body trc-body" style={{ bottom: 720 - L.top + 18 }}>
        <h2 className={cx('tq-title trc-title', titleSize(q.title))}>{q.title}</h2>
        <div className="tq-main">
          <ChoiceGrid options={options} looks={looks} column={false} refs={refs} />
        </div>
      </div>
      <Crowd players={view.players} answered={answered} onEls={(m) => (crowdEls.current = m)} />
      <div ref={flyLayer} className="tv-flylayer" aria-hidden="true" />
      {vIdx >= 0 ? (
        <div ref={crown} className="trc-crown" style={{ opacity: 0 }}>
          <span aria-hidden="true">👑</span> выбор {vLabel}
        </div>
      ) : null}
      <div className="trc-sum" aria-live="polite">
        <ChromeText as="p" className="trc-big">
          {count === 0 ? 'Никто не успел ответить' : `${right} из ${count} ${plural(right, ['угадал', 'угадали', 'угадали'])}`}
        </ChromeText>
        {count > 0 ? (
          <p className="trc-line">
            {right === 0 ? (
              <>Ни одного попадания — Владос умеет удивлять</>
            ) : fastest ? (
              <>
                Быстрее всех — <b>{fastest.name}</b>, {fmtSec(fastest.e)} с · в точку {pct}%
              </>
            ) : (
              <>В точку {pct}%</>
            )}
          </p>
        ) : null}
        {vText ? (
          <p className="trc-v">
            {env.texts.vladosAnswer || `А ${vLabel} ответил:`} <b>«{vText}»</b> {vIdx === correctIdx ? '— и попал!' : '— мимо!'}
          </p>
        ) : null}
        {rv.text ? <p className="trc-note">{rv.text}</p> : null}
      </div>
      {showMedia && rv.media ? <RevealMedia key={rv.i} media={rv.media} text={rv.text} rev={view.phaseRev} from={() => refs.tiles[correctIdx]} /> : null}
    </div>
  );
}
