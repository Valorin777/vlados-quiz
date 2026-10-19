// Ordering reveal: the items as everyone saw them glide (FLIP) into the correct sequence, light up
// one by one with their place numbers; on the right — how many got the whole order exactly.

import { gsap } from 'gsap';
import { useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { AvatarStack, ChromeText, audio, beats, cx, ease, plural } from '../../../visual';
import type { QuestionView, TvView } from '../../../host';
import { KEYS } from '../choice';
import { RevealMedia, QTop, revealMediaAt, titleSize, useBeat, useTvEnv } from '../common';
import { OrderPill, orderRowH } from './Question';

export function RevealOrdering({ view, q }: { view: TvView; q: QuestionView }) {
  const env = useTvEnv();
  const rv = view.reveal;
  const root = useRef<HTMLDivElement | null>(null);
  const items = q.items ?? [];
  const correct = Array.isArray(rv?.correct) ? (rv.correct as string[]) : items.map((i) => i.id);
  const shown = items.map((i) => i.id);
  const [order, setOrder] = useState<string[]>(shown);
  const [sorted, setSorted] = useState(false);
  const [lit, setLit] = useState(0);
  const [pctShown, setPctShown] = useState(0);
  const [showMedia, setShowMedia] = useState(false);
  const byId = useMemo(() => new Map(items.map((it, k) => [it.id, { it, k }])), [items]);
  const n = correct.length;
  const count = rv?.count ?? 0;
  const perfect = rv?.dist[String(n)] ?? 0;
  const pct = count ? Math.round((perfect / count) * 100) : 0;
  const hist = Array.from({ length: n + 1 }, (_, h) => rv?.dist[String(h)] ?? 0);
  const histMax = Math.max(1, ...hist);
  const perfectPeople = (rv?.answers ?? [])
    .filter((a) => a.ok && !a.isVlados)
    .map((a) => ({ id: a.uid, name: a.name, src: env.avatars.get(a.uid) ?? null }));
  const vLabel = view.pub?.vladosLabel || 'Владос';
  const vHits = rv?.vlados && rv.vlados.t === 'ordering' ? correct.filter((id, k) => (rv.vlados as { ids: string[] }).ids[k] === id).length : null;

  useBeat(
    (engine) => {
      const qs = gsap.utils.selector(root);
      const tl = gsap.timeline();
      tl.fromTo(qs('.tv-top, .tro-title'), { opacity: 0, y: -10 }, { opacity: 1, y: 0, duration: 0.5, stagger: 0.08 }, 0);
      tl.add(beats.popIn(qs('.tro-row'), { from: 0.4, stagger: 0.07 }), 0.2);
      tl.fromTo(qs('.tro-axis'), { opacity: 0 }, { opacity: 1, duration: 0.6 }, 0.4);
      tl.call(() => audio.rise(0.7), undefined, 1.0);
      if (engine) {
        tl.to(engine.scene, { agit: 0.6, duration: 0.4 }, 1.1);
        tl.to(engine.scene, { agit: 0, duration: 0.6 }, 1.7);
      }
      tl.add(() => {
        beats.flipReorder(Array.from(root.current?.querySelectorAll('.tro-row') ?? []), () =>
          flushSync(() => {
            setOrder(correct);
            setSorted(true);
          }),
          { duration: 1.3, stagger: 0.05 },
        );
        audio.drop(0.6, 0.45);
        audio.drop(0.9, 0.35, 0.15);
      }, 1.6);
      correct.forEach((_, k) => {
        tl.call(() => {
          setLit(k + 1);
          audio.bell([392, 440, 494, 523, 587, 659][k] ?? 659, 0.07, 1.1);
          const el = root.current?.querySelectorAll('.tro-row')[k] as HTMLElement | undefined;
          if (engine && el) {
            const m = engine.measure(el);
            engine.ripple(m.x - m.w / 2 + 34, m.y, 0.6);
          }
        }, undefined, 3.2 + k * 0.32);
      });
      const tS = 3.2 + n * 0.32 + 0.4;
      tl.fromTo(qs('.tro-side > *'), { opacity: 0, x: 24 }, { opacity: 1, x: 0, duration: 0.6, stagger: 0.15, ease: 'power3.out' }, tS);
      tl.add(beats.countTo(0, pct, (v) => setPctShown(v), { duration: 1.2 }), tS + 0.2);
      tl.fromTo(qs('.tro-bar i'), { scaleY: 0 }, { scaleY: 1, duration: 0.9, ease: ease.elastic, stagger: 0.06 }, tS + 0.4);
      tl.call(() => (pct > 0 ? audio.shine() : audio.melt(0.3)), undefined, tS + 1.3);
      if (rv?.media) tl.call(() => setShowMedia(true), undefined, revealMediaAt(rv.media, tS, { video: 0.6, image: 3.5 }));
      return () => {
        tl.kill();
        if (engine) gsap.to(engine.scene, { agit: 0, duration: 0.4 });
      };
    },
    [rv?.i],
  );

  if (!rv) return null;
  const rowH = orderRowH(n);

  return (
    <div className={cx('tv-scene tv-ro', sorted && 'is-sorted', showMedia && 'is-media')} ref={root}>
      <QTop q={q} suffix="ответ" />
      <h2 className={cx('tro-title', titleSize(q.title))}>{q.title}</h2>
      <div className="tro-axis" style={{ height: n * (rowH + 18) - 18 }}>
        <span>{q.firstLabel || 'Раньше'}</span>
        <i />
        <span>{q.lastLabel || 'Позже'}</span>
      </div>
      <ol className={cx('tro-list tv-ord-list', n > 4 && 'is-dense', n > 5 && 'is-denser')}>
        {order.map((id, k) => {
          const e = byId.get(id);
          if (!e) return null;
          const on = sorted && k < lit;
          return (
            <li key={id} data-flip-id={id} className={cx('tro-row tv-ord-row', on && 'is-lit')} style={{ height: rowH }}>
              <OrderPill no={sorted ? k + 1 : (KEYS[e.k] ?? String(e.k + 1))} text={e.it.text} mediaId={e.it.mediaId} film={on ? 0.85 : 0.2} tar={sorted ? 0 : 0.25} glow={on ? 0.1 : 0} />
            </li>
          );
        })}
      </ol>
      <div className="tro-side">
        <p className="vx-kick">расставили идеально</p>
        <div className="tro-pct">
          <ChromeText as="span" className="tro-pct-n">
            {`${pctShown}%`}
          </ChromeText>
        </div>
        <p className="tro-of">
          {count === 0 ? 'никто не успел ответить' : `${perfect} из ${count} ${plural(count, ['гостя', 'гостей', 'гостей'])}`}
        </p>
        <div className="tro-hist" aria-label="Сколько пунктов на своём месте">
          {hist.map((v, h) => (
            <div key={h} className={cx('tro-bar', h === n && 'is-top')}>
              <b>{v}</b>
              <i style={{ height: `${Math.round((v / histMax) * 100)}%` }} />
              <span>{h}</span>
            </div>
          ))}
        </div>
        <p className="tro-hist-l">сколько пунктов на своём месте</p>
        {perfectPeople.length ? (
          <div className="tro-perfect">
            <AvatarStack people={perfectPeople} max={6} size={30} />
            <span>{perfectPeople.slice(0, 2).map((p) => p.name).join(', ')}{perfectPeople.length > 2 ? ` и ещё ${perfectPeople.length - 2}` : ''}</span>
          </div>
        ) : null}
        {vHits !== null ? (
          <p className="tro-v">
            👑 {vLabel}: <b>{vHits === n ? 'всё на своих местах!' : `${vHits} из ${n} на месте`}</b>
          </p>
        ) : null}
        {rv.text ? <p className="tro-note">{rv.text}</p> : null}
      </div>
      {showMedia && rv.media ? <RevealMedia key={rv.i} media={rv.media} text={rv.text} rev={view.phaseRev} from={() => root.current?.querySelector('.tro-list')} /> : null}
    </div>
  );
}
