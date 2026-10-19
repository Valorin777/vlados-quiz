// Number reveal: a chrome number line; every guess rains down onto it as a selfie droplet (stacked
// where people agree), the answer drops from the sky as a mercury blade with a boom, the closest
// guesses get a ring and a name tag.

import { gsap } from 'gsap';
import { useMemo, useRef, useState } from 'react';
import { ChromeBlock, ChromeText, audio, cx, ease, initialOf, plural } from '../../../visual';
import type { QuestionView, TvAnswer, TvView } from '../../../host';
import { RevealMedia, QTop, fmtNum, revealMediaAt, titleSize, useBeat, useTvEnv } from '../common';

const X0 = 110;
const X1 = 1170;
const AXIS_Y = 452;
const COL = 25;
const DROP = 24;
const BLADE = 222;

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (i - lo);
}

/** Axis domain: the question's range if set, else the bulk of the guesses (outliers pin to the edges). */
function domain(q: QuestionView, values: number[], correct: number): { lo: number; hi: number } {
  const s = [...values].sort((a, b) => a - b);
  let lo = q.number?.min ?? (s.length >= 8 ? quantile(s, 0.04) : (s[0] ?? correct));
  let hi = q.number?.max ?? (s.length >= 8 ? quantile(s, 0.96) : (s[s.length - 1] ?? correct));
  if (q.number?.min === undefined || q.number?.max === undefined) {
    lo = Math.min(lo, correct);
    hi = Math.max(hi, correct);
  }
  if (hi - lo < 1e-9) {
    const pad = Math.max(Math.abs(correct) * 0.1, q.number?.step ?? 1, 1);
    lo -= pad;
    hi += pad;
  }
  const pad = (hi - lo) * 0.04;
  return { lo: lo - pad, hi: hi + pad };
}

function niceTicks(lo: number, hi: number, n = 7): number[] {
  const raw = (hi - lo) / n;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((w) => w >= raw) ?? 10 * pow;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

interface Drop {
  a: TvAnswer;
  v: number;
  x: number;
  y: number;
  clipped: -1 | 0 | 1;
  closest: boolean;
}

export function RevealNumber({ view, q }: { view: TvView; q: QuestionView }) {
  const env = useTvEnv();
  const rv = view.reveal;
  const root = useRef<HTMLDivElement | null>(null);
  const blade = useRef<HTMLDivElement | null>(null);
  const [done, setDone] = useState(false);
  const [showMedia, setShowMedia] = useState(false);
  const correct = typeof rv?.correct === 'number' ? rv.correct : 0;
  const unit = q.number?.unit;
  const answers = useMemo(() => (rv?.answers ?? []).filter((a) => a.p.t === 'number'), [rv]);
  const values = answers.map((a) => (a.p.t === 'number' ? a.p.v : 0));
  const { lo, hi } = useMemo(() => domain(q, values, correct), [q, values.join(','), correct]); // eslint-disable-line react-hooks/exhaustive-deps
  const xOf = (v: number) => X0 + ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (X1 - X0);
  const ticks = useMemo(() => niceTicks(lo, hi), [lo, hi]);

  const drops = useMemo<Drop[]>(() => {
    const cols = new Map<number, number>();
    const byX = answers
      .map((a) => ({ a, v: a.p.t === 'number' ? a.p.v : 0 }))
      .sort((p, r) => Math.abs(p.v - correct) - Math.abs(r.v - correct));
    const out: Drop[] = [];
    for (const { a, v } of byX) {
      const x = xOf(v);
      const c = Math.round((x - X0) / COL);
      const k = cols.get(c) ?? 0;
      cols.set(c, k + 1);
      out.push({ a, v, x: X0 + c * COL, y: k, clipped: v < lo ? -1 : v > hi ? 1 : 0, closest: !!rv?.me[a.uid]?.cl });
    }
    const tallest = Math.max(1, ...cols.values());
    const gap = Math.min(DROP - 2, 250 / tallest);
    for (const d of out) d.y = AXIS_Y - 16 - d.y * gap;
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answers, lo, hi, correct]);

  const guests = answers.filter((a) => !a.isVlados);
  const closest = drops.filter((d) => d.closest && !d.a.isVlados);
  const vDrop = drops.find((d) => d.a.isVlados) ?? null;
  const vLabel = view.pub?.vladosLabel || 'Владос';
  const sortedGuests = guests.map((a) => (a.p.t === 'number' ? a.p.v : 0)).sort((a, b) => a - b);
  const median = sortedGuests.length ? quantile(sortedGuests, 0.5) : null;
  const exact = guests.filter((a) => a.ok).length;
  const cx0 = xOf(correct);

  useBeat(
    (engine) => {
      const qs = gsap.utils.selector(root);
      const tl = gsap.timeline();
      tl.fromTo(qs('.tv-top, .trn-title'), { opacity: 0, y: -10 }, { opacity: 1, y: 0, duration: 0.5, stagger: 0.08 }, 0);
      tl.fromTo(qs('.trn-axis'), { scaleX: 0 }, { scaleX: 1, duration: 0.9, ease: 'power3.inOut' }, 0.2);
      tl.fromTo(qs('.trn-tick'), { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.4, stagger: 0.04 }, 0.6);
      // guesses rain down, fastest first
      const els = qs('.trn-drop');
      const n = els.length;
      els.forEach((el, k) => {
        const at = 0.9 + (n > 1 ? (k / (n - 1)) * 1.8 : 0);
        tl.fromTo(el, { y: -420 - Math.random() * 120, opacity: 1 }, { y: 0, duration: 0.7, ease: ease.bounce }, at);
        if (k % 2 === 0) tl.call(() => audio.drop(0.7 + Math.random() * 0.5, 0.2), undefined, at + 0.45);
      });
      const tA = 0.9 + (n > 1 ? 1.8 : 0) + 0.9;
      // suspense, then the answer blade
      tl.call(() => audio.rise(0.8), undefined, tA);
      if (engine) {
        tl.to(engine.scene, { agit: 0.8, duration: 0.5 }, tA + 0.1);
        tl.to(engine.scene, { agit: 0, duration: 0.5 }, tA + 0.8);
      }
      if (blade.current) {
        tl.fromTo(blade.current, { y: -560 }, { y: 0, duration: 0.55, ease: 'power4.in' }, tA + 0.5);
        tl.call(
          () => {
            audio.boom();
            if (engine) {
              engine.flash(0.45);
              engine.ripple(cx0, AXIS_Y, 1.8);
              engine.fountain(cx0, AXIS_Y - 6, 60, 10, { sp: 620, r: 7, glow: 0.3 });
            }
          },
          undefined,
          tA + 1.05,
        );
      }
      tl.fromTo(qs('.trn-ans'), { opacity: 0, scale: 0.5 }, { opacity: 1, scale: 1, duration: 0.8, ease: ease.back }, tA + 1.1);
      // the closest get their rings
      tl.call(() => {
        setDone(true);
        if (closest.length) audio.shine();
      }, undefined, tA + 1.7);
      tl.fromTo(qs('.trn-tag'), { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.5, stagger: 0.12 }, tA + 1.8);
      tl.fromTo(qs('.trn-sum > *'), { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.6, stagger: 0.2 }, tA + 2.2);
      if (rv?.media) tl.call(() => setShowMedia(true), undefined, revealMediaAt(rv.media, tA, { video: 1.9, image: 4.5 }));
      return () => {
        tl.kill();
        if (engine) gsap.to(engine.scene, { agit: 0, duration: 0.4 });
      };
    },
    [rv?.i],
  );

  if (!rv) return null;
  const fmtU = (v: number) => `${fmtNum(v)}${unit ? ` ${unit}` : ''}`;

  return (
    <div className={cx('tv-scene tv-rn', done && 'is-done', showMedia && 'is-media')} ref={root}>
      <QTop q={q} suffix="ответ" />
      <h2 className={cx('trn-title', titleSize(q.title))}>{q.title}</h2>
      <div className="trn-axis" style={{ left: X0 - 20, width: X1 - X0 + 40, top: AXIS_Y }} />
      {ticks.map((t) => (
        <span key={t} className="trn-tick" style={{ left: xOf(t), top: AXIS_Y + 14 }}>
          {fmtNum(t)}
        </span>
      ))}
      {drops.map((d) => {
        const src = env.avatars.get(d.a.uid);
        return (
          <div
            key={d.a.uid}
            className={cx('trn-drop', d.closest && 'is-closest', d.a.isVlados && 'is-vlados', d.clipped !== 0 && 'is-clipped')}
            style={{ left: d.x - DROP / 2, top: d.y - DROP / 2 }}
            title={`${d.a.name}: ${fmtNum(d.v)}`}
          >
            {src ? <img src={src} alt="" /> : <b>{initialOf(d.a.name)}</b>}
          </div>
        );
      })}
      <div ref={blade} className="trn-blade" style={{ left: cx0 - 10, top: AXIS_Y - BLADE }}>
        <ChromeBlock shape="pill" film={0.8} className="trn-blade-b" />
      </div>
      <div className="trn-ans" style={{ left: Math.max(170, Math.min(1110, cx0)), top: AXIS_Y - BLADE - 88 }}>
        <ChromeText as="span" className="trn-ans-v">
          {fmtNum(correct)}
        </ChromeText>
        {unit ? <span className="trn-ans-u">{unit}</span> : null}
      </div>
      {closest.slice(0, 3).map((d, k) => (
        <div key={d.a.uid} className="trn-tag" style={{ left: Math.max(90, Math.min(1190, d.x)), top: AXIS_Y + 44 + k * 34 }}>
          <b>{d.a.name}</b> · {fmtU(d.v)}
        </div>
      ))}
      {vDrop ? (
        <div className="trn-tag is-v" style={{ left: Math.max(90, Math.min(1190, vDrop.x)), top: vDrop.y - 50 }}>
          👑 {vLabel}: {fmtU(vDrop.v)}
        </div>
      ) : null}
      <div className="trn-sum">
        <p className="trn-sum-1">
          {guests.length === 0 ? (
            'Никто не успел ответить'
          ) : closest.length ? (
            <>
              Ближе всех — <b>{closest.slice(0, 3).map((d) => d.a.name).join(', ')}</b>
              {closest.length > 3 ? ` и ещё ${closest.length - 3}` : ''}
            </>
          ) : (
            'Никто не подобрался близко'
          )}
        </p>
        {guests.length ? (
          <p className="trn-sum-2">
            {exact ? `В яблочко: ${exact} ${plural(exact, ['человек', 'человека', 'человек'])}` : 'В яблочко — никто'}
            {median !== null ? ` · мнение зала (медиана): ${fmtU(Math.round(median * 100) / 100)}` : ''}
          </p>
        ) : null}
        {rv.text ? <p className="trn-note">{rv.text}</p> : null}
      </div>
      {showMedia && rv.media ? <RevealMedia key={rv.i} media={rv.media} text={rv.text} rev={view.phaseRev} from={() => root.current?.querySelector('.trn-ans')} /> : null}
    </div>
  );
}
