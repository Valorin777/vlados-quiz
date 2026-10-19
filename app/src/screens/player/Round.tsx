// One question on the phone, from «Приготовься!» to «Ответ принят» (intro → question → answered /
// time_up). Keyed by the round, so the commit animation can finish across the view's switch to
// 'answered' (the orb blooms out of the tapped option).

import { gsap } from 'gsap';
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import type { AnswerError } from '../../host/pure';
import type { PlayerView, QuestionView } from '../../host/views';
import type { AnswerPayload } from '@shared/types';
import {
  Badge,
  ChromeBlock,
  ChromeButton,
  NumberInput,
  OptionTile,
  TimerBar,
  audio,
  beats,
  cx,
  fmtClock,
  toast,
  useLiquid,
  type Blob,
} from './vx';
import { answerText, itemText, LETTERS, players } from './format';
import { useEntrance } from './hooks';
import { Hud, MediaImg, QuestionMedia } from './parts';
import type { PlayerActions } from './types';
import { Watch } from './Watch';

const loadOrderList = () => import('../../visual/ui/OrderList').then((m) => ({ default: m.OrderList }));
const OrderList = lazy(loadOrderList);

/** Fetch the drag-and-drop list in the background once the guest is in (see Shell): a guest who
 *  (re)joins right into an ordering question should not watch the list pop in a second later. */
export function preloadOrderList(): void {
  void loadOrderList().catch(() => undefined);
}

interface Commit {
  p: AnswerPayload;
  morphed: boolean;
}

function answerErrorText(e: AnswerError): string {
  switch (e) {
    case 'late':
      return 'Чуть-чуть не успел — время вышло';
    case 'closed':
      return 'Приём ответов уже закрыт';
    case 'kicked':
      return 'Организатор убрал тебя из игры';
    case 'offline':
      return 'Связь шалит — ответ уйдёт, как только появится сеть';
    case 'invalid':
      return 'Что-то не так с ответом — попробуй ещё раз';
    default:
      return 'Не получилось отправить — попробуй ещё раз';
  }
}

// ------------------------------------------------------------------ pieces

/** Long texts get a tighter type size, so a question still fits a phone screen (the editor allows
 *  a 300-character title, six 140-character options). */
const textLen = (it: { text?: string | undefined }): number => (it.text ?? '').trim().length;
const denseChoice = (q: QuestionView): boolean => (q.options?.length ?? 0) >= 5 || (q.options ?? []).some((o) => textLen(o) > 56);
const denseOrder = (q: QuestionView): boolean => (q.items?.length ?? 0) >= 5 || (q.items ?? []).some((o) => textLen(o) > 48);
function titleSize(t: string): string | null {
  const n = t.trim().length;
  return n > 190 ? 'is-xlong' : n > 110 ? 'is-long' : null;
}

function QTop({ q, view, children }: { q: QuestionView; view: PlayerView; children?: ReactNode }) {
  return (
    <div className="pl-q-top">
      <p className="vx-kick">
        вопрос {q.n} из {q.total}
      </p>
      {q.double ? (
        <Badge liquid title={view.texts.doubleBadge}>
          ×2
        </Badge>
      ) : null}
      {children}
    </div>
  );
}

/** m:ss left on the server clock (frozen while paused). */
function Remaining({ view, actions }: { view: PlayerView; actions: PlayerActions }) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 250);
    return () => clearInterval(id);
  }, []);
  const t = view.timer;
  if (!t) return null;
  const ms = t.paused ? t.remainingMs : Math.max(0, t.endsAt - actions.now());
  return <b className="vx-mono">{fmtClock(ms / 1000)}</b>;
}

// ------------------------------------------------------------------ intro

function Intro({ view, actions, q }: { view: PlayerView; actions: PlayerActions; q: QuestionView }) {
  const root = useRef<HTMLDivElement | null>(null);
  const [sec, setSec] = useState<number | null>(null);
  useEntrance(() => {
    const s = gsap.utils.selector(root);
    const tl = gsap.timeline();
    tl.add(beats.fadeUp(s('.pl-f'), { stagger: 0.08 }), 0.05);
    tl.add(beats.popIn(s('.pl-intro-drop')), 0.2);
    tl.call(() => audio.rise(0.8), undefined, 0.1);
    return tl;
  });
  useEffect(() => {
    if (q.type === 'ordering') void loadOrderList();
    const tick = () => {
      const t = view.timer;
      if (!t) return;
      const ms = t.paused ? t.remainingMs : t.endsAt - actions.now();
      setSec(Math.max(0, Math.ceil(ms / 1000)));
    };
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [actions, q.type, view.timer]);
  return (
    <div className="pl-screen pl-intro" ref={root}>
      <Hud view={view} game />
      <QTop q={q} view={view} />
      <div className="pl-intro-mid">
        <p className="vx-kick pl-f">{q.double ? view.texts.doubleBadge : 'сейчас будет вопрос'}</p>
        <ChromeBlock shape="circle" film={q.double ? 0.95 : 0.5} className="pl-intro-drop">
          <b className="vx-eng pl-intro-n" key={sec ?? -1}>
            {sec === null ? '' : sec > 0 ? sec : '!'}
          </b>
        </ChromeBlock>
        <p className="pl-intro-ready pl-f">{view.texts.getReady}</p>
      </div>
      <p className="vx-lead pl-q-title pl-f">{q.title}</p>
      {q.media ? (
        <div className="pl-f">
          <QuestionMedia actions={actions} media={q.media} title={q.title} />
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ answer inputs

function ChoiceAnswer({ view, actions, q, commit, onCommit }: { view: PlayerView; actions: PlayerActions; q: QuestionView; commit: Commit | null; onCommit: (p: AnswerPayload, from: { els: HTMLElement[]; picked: number; blobs?: (Blob | null)[] }) => void }) {
  const opts = q.options ?? [];
  const els = useRef<(HTMLButtonElement | null)[]>([]);
  const blobs = useRef<{ current: Blob | null }[]>([]);
  if (blobs.current.length !== opts.length) blobs.current = opts.map(() => ({ current: null }));
  const picked = commit?.p.t === 'choice' ? commit.p.id : null;
  return (
    <div className={cx('pl-q-opts', denseChoice(q) && 'is-dense')}>
      {opts.map((o, i) => (
        <OptionTile
          key={o.id}
          radius={30}
          ref={(n) => {
            els.current[i] = n;
          }}
          blobRef={blobs.current[i]}
          keyLabel={LETTERS[i]}
          label={o.text?.trim() || (o.mediaId ? '' : '—')}
          media={o.mediaId ? <MediaImg actions={actions} id={o.mediaId} alt={itemText(o, i)} /> : undefined}
          state={picked === null ? 'idle' : picked === o.id ? 'selected' : 'locked'}
          disabled={!view.canAnswer || picked !== null}
          onSelect={() => {
            if (picked !== null || !view.canAnswer) return;
            onCommit(
              { t: 'choice', id: o.id },
              { els: els.current.filter((e): e is HTMLButtonElement => !!e), picked: i, blobs: blobs.current.map((b) => b.current) },
            );
          }}
        />
      ))}
    </div>
  );
}

function NumberAnswer({ view, q, commit, onCommit }: { view: PlayerView; q: QuestionView; commit: Commit | null; onCommit: (p: AnswerPayload, from: { els: HTMLElement[]; picked: number }) => void }) {
  const cfg = q.number ?? { step: 1 };
  const ranged = cfg.min !== undefined && cfg.max !== undefined && cfg.max > cfg.min;
  const min = cfg.min ?? (cfg.max !== undefined && cfg.max < 0 ? -999_999 : 0);
  const max = cfg.max ?? Math.max(min + 1, 999_999);
  const [v, setV] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);
  return (
    <div ref={wrap} className={`pl-q-num${ranged ? '' : ' no-slider'}`}>
      <NumberInput
        value={v}
        onChange={setV}
        min={min}
        max={max}
        step={cfg.step || 1}
        {...(cfg.unit ? { unit: cfg.unit } : {})}
        disabled={!view.canAnswer || commit !== null}
        submitLabel="Ответить"
        onSubmit={(x) => {
          if (commit || !view.canAnswer || !wrap.current) return;
          const plate = wrap.current.querySelector<HTMLElement>('.vx-numin-plate') ?? wrap.current;
          onCommit({ t: 'number', v: x }, { els: [plate], picked: 0 });
        }}
      />
    </div>
  );
}

function OrderingAnswer({ view, actions, q, commit, onCommit }: { view: PlayerView; actions: PlayerActions; q: QuestionView; commit: Commit | null; onCommit: (p: AnswerPayload, from: { els: HTMLElement[]; picked: number }) => void }) {
  const items = q.items ?? [];
  const [order, setOrder] = useState<string[]>(() => items.map((it) => it.id));
  const wrap = useRef<HTMLDivElement | null>(null);
  const list = items.map((it, i) => ({
    id: it.id,
    text: it.text?.trim() || itemText(it, i),
    plain: itemText(it, i),
    ...(it.mediaId ? { media: <MediaImg actions={actions} id={it.mediaId} alt={itemText(it, i)} /> } : {}),
  }));
  const off = !view.canAnswer || commit !== null;
  return (
    <div ref={wrap} className="pl-q-ord">
      <Suspense fallback={<div className="pl-ord-wait" aria-busy="true" />}>
        <OrderList
          items={list}
          order={order}
          onChange={setOrder}
          disabled={off}
          className={cx(denseOrder(q) && 'is-dense')}
          {...(q.firstLabel ? { firstLabel: q.firstLabel } : {})}
          {...(q.lastLabel ? { lastLabel: q.lastLabel } : {})}
        />
      </Suspense>
      <ChromeButton
        block
        disabled={off}
        onClick={() => {
          if (off || !wrap.current) return;
          const rows = Array.from(wrap.current.querySelectorAll<HTMLElement>('.vx-ord-row'));
          onCommit({ t: 'ordering', ids: order }, { els: rows.length ? rows : [wrap.current], picked: 0 });
        }}
      >
        Готово — отправить порядок
      </ChromeButton>
    </div>
  );
}

// ------------------------------------------------------------------ question

function Question({ view, actions, q, commit, onCommit }: { view: PlayerView; actions: PlayerActions; q: QuestionView; commit: Commit | null; onCommit: (p: AnswerPayload, from: { els: HTMLElement[]; picked: number; blobs?: (Blob | null)[] }) => void }) {
  const root = useRef<HTMLDivElement | null>(null);
  const t = view.timer;
  useEntrance(() => {
    const s = gsap.utils.selector(root);
    const tl = gsap.timeline();
    tl.add(beats.fadeUp(s('.pl-f'), { stagger: 0.06 }), 0.02);
    tl.add(beats.popIn(s('.vx-opt, .vx-numin-plate, .vx-ord-row'), { from: 0.4, stagger: 0.07 }), 0.15);
    tl.call(() => audio.drop(1.1, 0.3), undefined, 0.15);
    return tl;
  });
  const vlados = view.me?.isVlados === true;
  return (
    <div className={`pl-screen pl-q is-${q.type}${q.media ? ' has-media' : ''}`} ref={root}>
      <Hud view={view} game />
      <div className="pl-f">
        <QTop q={q} view={view} />
      </div>
      {t ? (
        <TimerBar
          key={q.i}
          className="pl-f pl-q-timer"
          label={t.paused ? 'пауза' : 'осталось'}
          endsAt={t.endsAt}
          total={Math.max(1, t.totalMs / 1000)}
          now={actions.now}
          frozenAt={t.paused ? t.remainingMs / 1000 : null}
          driveScene
          sound
        />
      ) : null}
      <p className={cx('vx-lead pl-q-title pl-f', titleSize(q.title))}>{q.title}</p>
      {q.media ? (
        <div className="pl-f pl-q-media">
          {/* the video was just watched on the TV: a one-line note, so the options fit */}
          <QuestionMedia actions={actions} media={q.media} title={q.title} compact={(q.media.watchMs ?? 0) > 0} />
        </div>
      ) : null}
      <p className="vx-small pl-q-hint pl-f">
        {vlados
          ? `Ты — ${view.pub?.vladosLabel ?? 'Владос'}: отвечай про себя честно, ты ${view.texts.outOfCompetition}`
          : q.type === 'choice'
            ? 'жми, пока ртуть не утекла — одно касание, и ответ ушёл'
            : q.type === 'number'
              ? 'набери число или потяни ползунок'
              : 'расставь по порядку и жми «Готово»'}
      </p>
      {q.type === 'choice' ? (
        <ChoiceAnswer view={view} actions={actions} q={q} commit={commit} onCommit={onCommit} />
      ) : q.type === 'number' ? (
        <NumberAnswer view={view} q={q} commit={commit} onCommit={onCommit} />
      ) : (
        <OrderingAnswer view={view} actions={actions} q={q} commit={commit} onCommit={onCommit} />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ answered / time up

function Answered({ view, actions, q, p, orbRef }: { view: PlayerView; actions: PlayerActions; q: QuestionView; p: AnswerPayload | null; orbRef: RefObject<HTMLDivElement | null> }) {
  const sending = view.answer?.status === 'sending';
  const [head = 'Ответ принят', ...rest] = view.texts.answerAccepted.split(/(?<=[!.…])\s+/u);
  const locked = view.phase === 'locked' || (view.timer !== null && !view.timer.paused && view.timer.remainingMs <= 0);
  const vlados = view.me?.isVlados === true;
  const blob = useRef<Blob | null>(null);
  const was = useRef(sending);
  useEffect(() => {
    // queued answer landed: a little glint
    if (was.current && !sending) beats.pulse(blob.current, 0.8, 1);
    was.current = sending;
  }, [sending]);
  return (
    <div className="pl-screen pl-acc">
      <Hud view={view} game />
      <QTop q={q} view={view} />
      <div className="pl-acc-mid">
        <ChromeBlock ref={orbRef} shape="circle" film={sending ? 0.2 : 0.5} tar={sending ? 0.25 : 0} blobRef={blob} className="pl-orb" aria-live="polite">
          <b className="vx-eng">{sending ? 'Отправляем…' : head.replace(/[!.…]+$/u, '')}</b>
          {p ? <span className="vx-eng">{answerText(q, p)}</span> : null}
        </ChromeBlock>
        {sending ? (
          <p className="pl-wait">Связь медленная — ответ уйдёт сам. Не закрывай страницу.</p>
        ) : locked ? (
          <p className="pl-wait">Время вышло — считаем очки…</p>
        ) : view.pause ? (
          <p className="pl-wait">Пауза — таймер стоит</p>
        ) : (
          <p className="pl-wait">
            ещё <Remaining view={view} actions={actions} /> — {rest.join(' ').toLocaleLowerCase('ru-RU') || 'ждём остальных'}
          </p>
        )}
        {view.counts.players > 0 ? (
          <p className="vx-small pl-wait-n">
            ответили {view.counts.answered} из {players(view.counts.players)}
          </p>
        ) : null}
        {vlados ? <p className="vx-small pl-vlados-tag">вне зачёта — но все ждут, что ты ответил</p> : null}
      </div>
    </div>
  );
}

function TimeUp({ view, q }: { view: PlayerView; q: QuestionView }) {
  const blob = useRef<Blob | null>(null);
  const el = useRef<HTMLDivElement | null>(null);
  useEntrance((engine) => {
    return beats.meltWrong(engine, blob.current, { mode: 'sag', el: el.current, drips: 3, delay: 0.15 });
  });
  return (
    <div className="pl-screen pl-acc pl-up">
      <Hud view={view} game />
      <QTop q={q} view={view} />
      <div className="pl-acc-mid">
        <ChromeBlock ref={el} shape="circle" film={0.18} tar={1} tone="tarnish" blobRef={blob} className="pl-orb is-tar">
          <b className="vx-eng">{view.texts.timeUp.replace(/!$/u, '')}</b>
        </ChromeBlock>
        <p className="pl-wait">{view.texts.noAnswer}</p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ the round

export function Round({ view, actions }: { view: PlayerView; actions: PlayerActions }) {
  const q = view.question;
  const [commit, setCommit] = useState<Commit | null>(null);
  const orb = useRef<HTMLDivElement | null>(null);
  const { engine } = useLiquid();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // Safety net: if the commit animation never reaches its morph (killed, hidden tab), show the orb anyway.
  useEffect(() => {
    if (!commit || commit.morphed) return;
    const id = setTimeout(() => setCommit((c) => (c && !c.morphed ? { ...c, morphed: true } : c)), 1_600);
    return () => clearTimeout(id);
  }, [commit]);

  if (!q) return null;
  // A video question: «Смотри видео на большом экране» while the TV plays it, then «Варианты
  // появятся через 3…2…1»; at openAt the options with the full timer.
  if (view.screen === 'intro') return view.watch ? <Watch view={view} actions={actions} q={q} /> : <Intro view={view} actions={actions} q={q} />;

  const onCommit = (p: AnswerPayload, from: { els: HTMLElement[]; picked: number; blobs?: (Blob | null)[] }) => {
    if (commit || !view.canAnswer) return;
    actions.haptic('commit');
    setCommit({ p, morphed: false });
    const round = q.i;
    void actions.answer(round, p).then((r) => {
      if (!alive.current || r.ok) return;
      if (r.error === 'offline') {
        toast(answerErrorText('offline'), { tone: 'info', ms: 3500 });
        return; // queued: the view shows «Отправляем…» and flips once it lands
      }
      toast(answerErrorText(r.error), { tone: 'bad', ms: 3500 });
      actions.haptic('bad');
      setCommit(null);
    });
    beats.answerCommit(engine, {
      options: from.els,
      picked: from.picked,
      ...(from.blobs ? { blobs: from.blobs } : {}),
      orb: () => orb.current,
      onMorph: () => {
        if (alive.current) flushSync(() => setCommit((c) => (c ? { ...c, morphed: true } : c)));
      },
    });
  };

  const sent = view.answer && view.answer.status !== 'rejected' ? view.answer : null;
  // While the commit animation runs, the question stays up (the view already says 'answered').
  if (commit && !commit.morphed) return <Question view={view} actions={actions} q={q} commit={commit} onCommit={onCommit} />;
  if (commit || view.screen === 'answered') return <Answered view={view} actions={actions} q={q} p={sent?.p ?? commit?.p ?? null} orbRef={orb} />;
  if (view.screen === 'time_up') return <TimeUp view={view} q={q} />;
  return <Question view={view} actions={actions} q={q} commit={commit} onCommit={onCommit} />;
}
