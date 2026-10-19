// The rehearsal's control strip (the approved prototype's chrome strip): question chips with type
// icons, stage chips, the transport (← ▶ → ↺, ×1/×2/×4), «Мой ответ», the phone's theme, sound,
// «Шпаргалка», «ТВ / Телефон» on narrow screens, «Закрыть»; under it a thin timeline to scrub.

import { useLayoutEffect, useRef, type MouseEvent, type ReactNode } from 'react';
import { markAt, type MyMode, type Position, type Stage, type Timeline } from '../../../host/rehearsal';
import { cx } from '../../../visual';
import { Icon, type IconName } from '../ui/icons';
import { TYPE_ICON } from './icons';

export type Speed = 1 | 2 | 4;
export type NarrowView = 'tv' | 'phone';

export interface StripProps {
  tl: Timeline;
  pos: Position;
  now: number;
  playing: boolean;
  speed: Speed;
  mode: MyMode;
  phoneMode: 'light' | 'dark';
  sound: boolean;
  sheet: boolean;
  narrow: boolean;
  view: NarrowView;
  onJump: (t: number) => void;
  onPrev: () => void;
  onNext: () => void;
  onPlay: () => void;
  onRestart: () => void;
  onSpeed: (s: Speed) => void;
  onMode: (m: MyMode) => void;
  onPhoneMode: () => void;
  onSound: () => void;
  onSheet: () => void;
  onView: (v: NarrowView) => void;
  onClose: () => void;
}

const MODES: { value: MyMode; label: string; short: string }[] = [
  { value: 'auto', label: 'Авто', short: 'Авто' },
  { value: 'right', label: 'Верный', short: 'Верно' },
  { value: 'wrong', label: 'Неверный', short: 'Мимо' },
  { value: 'none', label: 'Не успел', short: 'Нет' },
];

const FINAL_STEPS = ['Барабаны', '3 место', '2 место', '1 место', 'Владос', 'Спасибо', 'Видео'];

function Seg<T extends string | number>({ label, value, options, onChange, className }: { label: string; value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={cx('rh-seg', className)} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" aria-pressed={o.value === value} title={o.title} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function IB({ icon, label, onClick, pressed, className }: { icon: IconName; label: string; onClick: () => void; pressed?: boolean; className?: string }) {
  return (
    <button type="button" className={cx('rh-ib', className)} aria-label={label} title={label} aria-pressed={pressed} onClick={onClick}>
      <Icon name={icon} size={16} />
    </button>
  );
}

function Toggle({ on, label, icon, onClick }: { on: boolean; label: string; icon?: IconName; onClick: () => void }) {
  return (
    <button type="button" className="rh-tb" aria-pressed={on} onClick={onClick}>
      <i />
      {icon ? <Icon name={icon} size={15} /> : null}
      <span>{label}</span>
    </button>
  );
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Thin timeline: question / answer / board segments of every round, the final; click to jump. */
function Track({ tl, now, onJump }: { tl: Timeline; now: number; onJump: (t: number) => void }) {
  const span = Math.max(1, tl.end - tl.t0);
  const x = (t: number) => `${(((t - tl.t0) / span) * 100).toFixed(3)}%`;
  const w = (a: number, b: number) => `${(((b - a) / span) * 100).toFixed(3)}%`;
  const segs: { a: number; b: number; cls: string }[] = [];
  tl.rounds.forEach((r, k) => {
    const next = tl.rounds[k + 1]?.introAt ?? tl.finalAt ?? tl.end;
    const rv = r.revealAt ?? next;
    const bd = r.boardAt ?? next;
    segs.push({ a: r.introAt, b: rv, cls: 'is-q' }, { a: rv, b: bd, cls: 'is-a' }, { a: bd, b: next, cls: 'is-b' });
  });
  if (tl.finalAt !== null) segs.push({ a: tl.finalAt, b: tl.end, cls: 'is-f' });
  const click = (e: MouseEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    onJump(tl.t0 + ((e.clientX - box.left) / Math.max(1, box.width)) * span);
  };
  return (
    <div className="rh-track">
      <span className="rh-time">{clock(now - tl.t0)}</span>
      <div className="rh-bar" onClick={click} role="presentation">
        {segs.map((s, k) => (
          <i key={k} className={s.cls} style={{ left: x(s.a), width: w(s.a, s.b) }} />
        ))}
        <b style={{ left: x(now) }} />
      </div>
      <span className="rh-time">{clock(tl.end - tl.t0)}</span>
    </div>
  );
}

/** Keeps the chip on air visible in a scrolling chip row (question 17 of 30 is off to the right). */
function useCurrentChipInView(key: string) {
  const nav = useRef<HTMLElement | null>(null);
  const first = useRef(true);
  useLayoutEffect(() => {
    const n = nav.current;
    const chip = n?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!n || !chip || n.scrollWidth <= n.clientWidth + 1) return;
    const pad = 24;
    const box = n.getBoundingClientRect();
    const c = chip.getBoundingClientRect();
    const left = c.left - box.left + n.scrollLeft;
    const right = left + c.width;
    let to: number | null = null;
    if (left - pad < n.scrollLeft) to = left - pad;
    else if (right + pad > n.scrollLeft + n.clientWidth) to = right + pad - n.clientWidth;
    if (to !== null) n.scrollTo({ left: Math.max(0, to), behavior: first.current ? 'auto' : 'smooth' });
    first.current = false;
  }, [key]);
  return nav;
}

export function Strip(p: StripProps) {
  const { tl, pos } = p;
  const qNav = useCurrentChipInView(`${pos.stage === 'lobby' ? 'l' : pos.stage === 'final' ? 'f' : pos.k}:${p.narrow}`);
  const sNav = useCurrentChipInView(`${pos.stage}:${pos.step ?? ''}:${p.narrow}`);
  const inRound = pos.k !== null;
  const stageChips: { key: string; label: string; at: number | null; on: boolean }[] = inRound
    ? (['question', 'answer', 'board'] as const).map((s: Stage) => ({
        key: s,
        label: s === 'question' ? 'Вопрос' : s === 'answer' ? 'Ответ' : 'Таблица',
        at: markAt(tl, s, pos.k),
        on: pos.stage === s,
      }))
    : pos.stage === 'final'
      ? FINAL_STEPS.map((label, s) => ({ key: `f${s}`, label: s === 4 ? tl.settings.vladosLabel : label, at: markAt(tl, 'final', null, s), on: pos.step === s })).filter((c) => c.at !== null || c.key !== 'f6')
      : [{ key: 'lobby', label: 'Гости собираются', at: tl.t0, on: true }];

  const qchips = (
    <nav ref={qNav} className="rh-chips rh-qchips" aria-label="Вопросы">
      <button type="button" className="rh-chip" aria-current={pos.stage === 'lobby' ? 'step' : undefined} title="Лобби" aria-label="Лобби" onClick={() => p.onJump(tl.t0)}>
        <Icon name="users" size={14} />
      </button>
      {tl.rounds.map((r) => (
        <button key={r.qid} type="button" className="rh-chip" aria-current={pos.k === r.k ? 'step' : undefined} title={`${r.n}. ${r.q.title}`} onClick={() => p.onJump(r.introAt)}>
          <Icon name={r.video ? 'video' : TYPE_ICON[r.type]} size={13} />
          {r.n}
        </button>
      ))}
      {tl.finalAt !== null ? (
        <button type="button" className="rh-chip" aria-current={pos.stage === 'final' ? 'step' : undefined} title="Финал" onClick={() => p.onJump(tl.finalAt as number)}>
          <Icon name="trophy" size={14} />
          {!p.narrow ? 'Финал' : null}
        </button>
      ) : null}
    </nav>
  );
  const stages = (
    <nav ref={sNav} className="rh-chips rh-stages" aria-label="Этап">
      {stageChips.map((c) => (
        <button key={c.key} type="button" className="rh-chip" aria-current={c.on ? 'step' : undefined} disabled={c.at === null} onClick={() => c.at !== null && p.onJump(c.at)}>
          {c.label}
        </button>
      ))}
    </nav>
  );
  const restart = <IB icon="restore" label="С начала" onClick={p.onRestart} />;
  const transport = (
    <div className="rh-ctl">
      <IB icon="chevronL" label="Назад (←)" onClick={p.onPrev} />
      <IB icon={p.playing ? 'pause' : 'play'} label={p.playing ? 'Пауза (пробел)' : 'Играть (пробел)'} onClick={p.onPlay} className="is-main" pressed={p.playing} />
      <IB icon="chevronR" label="Дальше (→)" onClick={p.onNext} />
      {/* narrow: «с начала» sits next to «Закрыть», the row has no room */}
      {!p.narrow ? restart : null}
      <Seg<Speed>
        label="Скорость"
        value={p.speed}
        onChange={p.onSpeed}
        options={[
          { value: 1, label: '×1', title: 'Как на празднике' },
          { value: 2, label: '×2', title: 'Вдвое быстрее' },
          { value: 4, label: '×4', title: 'Вчетверо быстрее' },
        ]}
      />
    </div>
  );
  const mine = (
    <div className="rh-ctl rh-mine">
      {!p.narrow ? <span className="rh-lbl">Мой ответ</span> : null}
      <Seg<MyMode> label="Мой ответ на телефоне" value={p.mode} onChange={p.onMode} options={MODES.map((m) => ({ value: m.value, label: p.narrow ? m.short : m.label, title: `Мой ответ: ${m.label.toLowerCase()}` }))} />
    </div>
  );
  const phoneTheme = <IB icon={p.phoneMode === 'dark' ? 'sun' : 'eye'} label={p.phoneMode === 'dark' ? 'Телефон: светлая тема' : 'Телефон: тёмная тема'} onClick={p.onPhoneMode} />;
  const toggles = p.narrow ? (
    <div className="rh-ctl">
      {phoneTheme}
      <IB icon="sound" label={p.sound ? 'Выключить звук' : 'Включить звук'} pressed={p.sound} onClick={p.onSound} className="is-toggle" />
      <IB icon="note" label={p.sheet ? 'Скрыть шпаргалку' : 'Шпаргалка'} pressed={p.sheet} onClick={p.onSheet} className="is-toggle" />
    </div>
  ) : (
    <div className="rh-ctl">
      {phoneTheme}
      <Toggle on={p.sound} label="Звук" icon="sound" onClick={p.onSound} />
      <Toggle on={p.sheet} label="Шпаргалка" icon="note" onClick={p.onSheet} />
    </div>
  );

  if (p.narrow) {
    return (
      <header className="rh-strip is-narrow" role="toolbar" aria-label="Прогон игры">
        <div className="rh-row">
          {qchips}
          <div className="rh-ctl">
            {restart}
            <IB icon="x" label="Закрыть" onClick={p.onClose} />
          </div>
        </div>
        <div className="rh-row">{stages}</div>
        <div className="rh-row">
          {transport}
          <Seg<NarrowView>
            label="Что показать"
            value={p.view}
            onChange={p.onView}
            options={[
              { value: 'tv', label: 'ТВ' },
              { value: 'phone', label: 'Телефон' },
            ]}
          />
        </div>
        <div className="rh-row">
          {mine}
          {toggles}
        </div>
        <Track tl={tl} now={p.now} onJump={p.onJump} />
      </header>
    );
  }
  return (
    <header className="rh-strip" role="toolbar" aria-label="Прогон игры">
      <div className="rh-row">
        <div className="rh-brand">
          <i />
          Прогон игры
        </div>
        {qchips}
        {stages}
        <button type="button" className="rh-close" onClick={p.onClose} title="Закрыть (Esc)">
          <Icon name="x" size={16} />
          Закрыть
        </button>
      </div>
      <div className="rh-row">
        {transport}
        <span className="rh-sp" />
        {mine}
        {toggles}
      </div>
      <Track tl={tl} now={p.now} onJump={p.onJump} />
    </header>
  );
}
