// Leaderboard: the top 10 as they stood before the round, the bars stretch to the new totals, then
// the rows flow to their new places (FLIP) with ▲▼ badges; the biggest climber gets a callout.

import type { BoardRow } from '@shared/fbtypes';
import { gsap } from 'gsap';
import { useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ChromeBlock, ChromeText, audio, beats, cx, ease, fmtInt, initialOf, plural } from '../../../visual';
import type { QuestionView, TvView } from '../../../host';
import { useBeat, useTvEnv } from '../common';

const BAR_MIN = 48;
const BAR_MAX = 420;

function beforeOrder(rows: BoardRow[]): string[] {
  return rows
    .slice()
    .sort((a, b) => {
      if (a.prev !== null && b.prev !== null) return a.prev - b.prev;
      if (a.prev !== null) return -1;
      if (b.prev !== null) return 1;
      return b.score - (b.delta ?? 0) - (a.score - (a.delta ?? 0));
    })
    .map((r) => r.uid);
}

export function Board({ view, q }: { view: TvView; q: QuestionView | null }) {
  const env = useTvEnv();
  const rows = useMemo(() => view.board ?? [], [view.board]);
  const root = useRef<HTMLDivElement | null>(null);
  const scores = useRef(new Map<string, HTMLElement | null>());
  const bars = useRef(new Map<string, HTMLDivElement | null>());
  const before = useMemo(() => beforeOrder(rows), [rows]);
  const after = useMemo(() => rows.slice().sort((a, b) => a.rank - b.rank).map((r) => r.uid), [rows]);
  const [order, setOrder] = useState<string[]>(before);
  const [phase, setPhase] = useState<'before' | 'after'>('before');
  const byId = new Map(rows.map((r) => [r.uid, r]));
  const top = Math.max(1, ...rows.map((r) => r.score));
  const barW = (s: number) => BAR_MIN + (Math.max(0, s) / top) * (BAR_MAX - BAR_MIN);
  const firstRound = rows.every((r) => r.prev === null);
  const climber = rows
    .filter((r) => r.prev !== null && r.prev - r.rank >= 2)
    .sort((a, b) => (b.prev as number) - b.rank - ((a.prev as number) - a.rank))[0];
  const leader = rows.find((r) => r.rank === 1);
  const key = rows.map((r) => `${r.uid}:${r.score}`).join('|');

  useBeat(
    (engine) => {
      const qs = gsap.utils.selector(root);
      const tl = gsap.timeline();
      tl.fromTo(qs('.tb-head'), { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.7 }, 0.05);
      before.forEach((uid, k) => {
        const r = byId.get(uid);
        const bar = bars.current.get(uid);
        const sc = scores.current.get(uid);
        if (!r) return;
        const from = r.score - (r.delta ?? 0);
        if (sc) sc.textContent = fmtInt(from);
        tl.fromTo(qs(`[data-flip-id="${uid}"]`), { opacity: 0, x: -24 }, { opacity: 1, x: 0, duration: 0.45 }, 0.2 + k * 0.06);
        if (bar) tl.fromTo(bar, { width: BAR_MIN * 0.8 }, { width: barW(from), duration: 1.1, ease: ease.elastic }, 0.25 + k * 0.06);
      });
      tl.call(() => audio.rise(0.7), undefined, 1.4);
      rows.forEach((r) => {
        const d = r.delta ?? 0;
        const bar = bars.current.get(r.uid);
        if (bar) tl.to(bar, { width: barW(r.score), duration: 1, ease: ease.elastic }, 1.5);
        if (d) {
          tl.add(
            beats.countTo(r.score - d, r.score, (v) => {
              const sc = scores.current.get(r.uid);
              if (sc) sc.textContent = fmtInt(v);
            }, { duration: 1, step: 10 }),
            1.5,
          );
        }
      });
      tl.fromTo(qs('.tb-delta'), { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1, duration: 0.5, ease: ease.back, stagger: 0.03 }, 1.55);
      tl.add(() => {
        const els = Array.from(root.current?.querySelectorAll('.tb-row') ?? []);
        beats.boardReorder({
          rows: els,
          mutate: () =>
            flushSync(() => {
              setOrder(after);
              setPhase('after');
            }),
          badges: () => Array.from(root.current?.querySelectorAll('.tb-move') ?? []),
        });
      }, 2.8);
      tl.fromTo(qs('.tb-call'), { opacity: 0, x: 30 }, { opacity: 1, x: 0, duration: 0.8, ease: 'power3.out' }, 4.1);
      tl.call(() => {
        const lead = root.current?.querySelector('.tb-row.is-lead .tb-av');
        if (engine && lead) {
          const m = engine.measure(lead);
          engine.ripple(m.x, m.y, 1);
        }
        audio.bell(659, 0.08, 1.4);
      }, undefined, 4.2);
      return tl;
    },
    [key],
  );

  return (
    <div className="tv-scene tv-board" ref={root}>
      <div className="tb-head">
        <ChromeText as="h2" className="tb-h">
          {env.texts.boardTitle || 'Кто лидирует'}
        </ChromeText>
        <p className="vx-kick">{q ? `после ${q.n} ${plural(q.n, ['вопроса', 'вопросов', 'вопросов'])} из ${q.total}` : 'таблица'}</p>
      </div>
      {rows.length === 0 ? (
        <p className="tb-empty">Очков пока ни у кого нет — всё впереди!</p>
      ) : (
        <ol className="tb-list">
          {order.map((uid) => {
            const r = byId.get(uid);
            if (!r) return null;
            const k0 = before.indexOf(uid);
            const k1 = after.indexOf(uid);
            const d = r.prev !== null ? r.prev - r.rank : 0;
            const src = env.avatars.get(uid);
            return (
              <li key={uid} data-flip-id={uid} className={cx('tb-row', r.rank === 1 && phase === 'after' && 'is-lead')}>
                <span className={cx('tb-move', phase === 'after' ? (r.prev === null ? 'new' : d > 0 ? 'up' : d < 0 ? 'dn' : 'eq') : null)}>
                  {phase === 'after' ? (r.prev === null ? (firstRound ? '' : 'new') : d > 0 ? `▲${d}` : d < 0 ? `▼${-d}` : '—') : ''}
                </span>
                <span className="tb-rk vx-mono">{(phase === 'after' ? k1 : k0) + 1}</span>
                <span className="tb-av">{src ? <img src={src} alt="" /> : <b>{initialOf(r.name)}</b>}</span>
                <span className="tb-nm">{r.name}</span>
                <span className="tb-barwrap">
                  <ChromeBlock
                    ref={(el) => {
                      bars.current.set(uid, el);
                    }}
                    shape="pill"
                    film={r.rank === 1 ? 0.85 : 0.34}
                    className="tb-bar"
                    style={{ width: barW(phase === 'after' ? r.score : r.score - (r.delta ?? 0)) }}
                  />
                  <b
                    className="tb-sc vx-mono"
                    ref={(el) => {
                      scores.current.set(uid, el);
                    }}
                  >
                    {fmtInt(phase === 'after' ? r.score : r.score - (r.delta ?? 0))}
                  </b>
                  {r.delta ? <span className="tb-delta vx-mono">+{fmtInt(r.delta)}</span> : null}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {climber ? (
        <div className="tb-call">
          <p className="vx-kick">рывок раунда</p>
          <p className="tb-call-n">{climber.name}</p>
          <p className="tb-call-d">
            ▲ {(climber.prev as number) - climber.rank} {plural((climber.prev as number) - climber.rank, ['место', 'места', 'мест'])} за вопрос
          </p>
        </div>
      ) : leader ? (
        <div className="tb-call">
          <p className="vx-kick">{firstRound ? 'первым вырывается' : leader.prev === 1 ? 'держит первое место' : 'новый лидер'}</p>
          <p className="tb-call-n">{leader.name}</p>
          <p className="tb-call-d">
            {fmtInt(leader.score)} {plural(leader.score, ['очко', 'очка', 'очков'])}
          </p>
        </div>
      ) : null}
    </div>
  );
}
