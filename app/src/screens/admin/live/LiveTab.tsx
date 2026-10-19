// «Эфир» — the live control. One huge context button (what comes next in the show), the timer
// with the answered ring, pause / +15 с / skip, live distribution, who has not answered yet,
// the queue, «Сказать всем» (the «стоп-экран»: a text on the TV and the whole show paused) and
// the health of the host. At the top: «Автопилот: вкл/выкл» (the show moves on by itself).

import { autopilotOn } from '@shared/engine/showTimings';
import { FB_LIMITS } from '@shared/fbtypes';
import type { AnswerPayload } from '@shared/types';
import { useEffect, useState, type ReactNode } from 'react';
import type { AdminView, CmdResult } from '../../../host';
import { ChromeButton, cx, fmtClock, plural, toast } from '../../../visual';
import type { HostLike } from '../core/backend';
import { useContent } from '../core/content';
import { appUrl, fmtAgo, fmtMskDate, fmtUntil, KEYS, nPlayers, PHASE_LABEL, TYPE_LABEL } from '../core/format';
import { autoStepText, heroAction, type HeroAction } from '../core/live';
import { cmdErrorText, useAdmin, useAdminView } from '../core/session';
import { RehearsalButton } from '../rehearsal/RehearsalButton';
import { Btn, Card, Dot, Empty, HoldButton, PageHead, TextInput, Toggle } from '../ui/kit';
import { Icon, type IconName } from '../ui/icons';
import { PersonChip, PlayerAvatar } from '../ui/people';

// ---------------------------------------------------------------- the big button

/**
 * A video question: the answers (and their timer) open only after the video. The TV reports its
 * end by itself; this button is for when it cannot (no TV page, the video would not play).
 */
function watchHero(v: AdminView): HeroAction | null {
  const w = v.watch;
  if (v.phase !== 'intro' || !w || v.pause) return null;
  if (w.stage === 'beat') return { label: 'Ответы открываются', sub: '3-2-1 на экране — дальше таймер' };
  if (!v.can.watchEnd) return null;
  const left = Math.max(0, w.untilAt - v.now);
  const auto = `само откроется через ${fmtClock(left / 1000)}`;
  return {
    label: 'Видео досмотрели — старт',
    sub: !v.tvOnAir ? `ТВ нет · ${auto}` : w.stage === 'play' ? `видео на экране · ${auto}` : 'сейчас начнётся видео',
    cmd: { type: 'watchEnd', phaseRev: v.phaseRev },
    film: true,
  };
}

/**
 * No TV on air: nobody plays a question's video (phones never do) and this very tab drives the
 * game — a hidden or locked tab used to leave the guests without options (organizer, 2026-09-23).
 */
function TvAlert({ v }: { v: AdminView }) {
  if (v.tvOnAir || v.phase === null || v.phase === 'lobby' || v.phase === 'final') return null;
  const onAir = v.phase === 'intro' || v.phase === 'open' || v.phase === 'locked';
  // a question's video, or the «Сюрприз» (coming or on air): only the TV plays them
  const video = onAir && (v.question?.media?.kind === 'video' || v.surprise !== null || v.surpriseIn !== null);
  const driving = v.lease.mine;
  if (!video && !driving) return null;
  return (
    <div className="ad-alert" role="alert">
      <Icon name="alert" size={20} />
      <div>
        <b>{video ? 'ТВ не подключён — видео никто не увидит' : 'Экрана ТВ нет — игру ведёт этот пульт'}</b>
        <span className="ad-hint">
          {video ? (v.watch ? 'Гости видят «Смотри видео на большом экране». Открой экран ТВ или жми «Видео досмотрели — старт». ' : 'Видео играет только на экране ТВ. ') : ''}
          {driving ? 'Пока нет ТВ, не сворачивай эту вкладку и не блокируй экран — иначе ответы откроются с опозданием.' : ''}
        </span>
      </div>
    </div>
  );
}

/**
 * «Автопилот: вкл/выкл» at the top of «Эфир» (Settings.autopilot, shared/engine/showTimings.ts):
 * on, the host moves the show on by itself with the pace of «Прогнать игру» and the big button
 * shows what comes next and when; off, every step waits for the button.
 */
function AutopilotSwitch({ v }: { v: AdminView }) {
  const { content } = useAdmin();
  const c = useContent(content);
  // the draft (instant after a tap); before it loads, what the host runs with
  const on = c.doc ? autopilotOn(c.doc.settings) : v.autopilot.on;
  const a = v.autopilot.on ? v.autopilot.next : null;
  return (
    <Card tone={on ? 'accent' : 'quiet'} className="ad-autopilot">
      <Toggle
        checked={on}
        disabled={!c.doc}
        onChange={(x) => {
          navigator.vibrate?.(12);
          content.updateSettings((st) => void (st.autopilot = x), 0);
          toast(x ? 'Автопилот включён — игра пойдёт сама' : 'Автопилот выключен — каждый шаг по кнопке', { tone: 'good' });
        }}
        label={
          <span className="ad-row" style={{ gap: 8 }}>
            <Icon name="bolt" size={17} />
            Автопилот: {on ? 'вкл' : 'выкл'}
          </span>
        }
        hint={on ? (a && !a.held ? `Дальше само: ${autoStepText(a, !!v.vladosUid).toLowerCase()}.` : 'Игра идёт сама, в темпе «Прогнать игру».') : 'Каждый шаг — по большой кнопке.'}
      />
    </Card>
  );
}

function Hero({ v }: { v: AdminView }) {
  const { run } = useAdmin();
  const [busy, setBusy] = useState(false);
  const a = watchHero(v) ?? heroAction(v);
  if (!a.cmd) {
    return (
      <div className="ad-hero-wait" role="status">
        <b>{a.label}</b>
        {a.sub ? <span className="ad-hint">{a.sub}</span> : null}
      </div>
    );
  }
  const cmd = a.cmd;
  return (
    <ChromeButton
      variant={a.film ? 'film' : 'chrome'}
      block
      className="ad-hero-btn"
      loading={busy}
      onClick={async () => {
        if (busy) return;
        navigator.vibrate?.(12);
        setBusy(true);
        await run(cmd);
        setBusy(false);
      }}
    >
      <span className="ad-hero-main">{a.label}</span>
      {a.sub ? <span className="ad-hero-sub">{a.sub}</span> : null}
    </ChromeButton>
  );
}

// ---------------------------------------------------------------- now on air

function Ring({ v }: { v: AdminView }) {
  const t = v.timer;
  const R = 74;
  const r = 58;
  const C = 2 * Math.PI * R;
  const c = 2 * Math.PI * r;
  const timeFrac = t && t.totalMs > 0 ? t.remainingMs / t.totalMs : 0;
  const ansFrac = v.counts.players ? v.counts.answered / v.counts.players : 0;
  const sec = t ? t.remainingMs / 1000 : 0;
  const hot = !!t && t.kind === 'answer' && !t.paused && sec <= 10 && sec > 0;
  const video = (!t && v.watch?.stage === 'play') || v.surprise !== null;
  return (
    <div className={cx('ad-ring', hot && 'is-hot')} role="timer" aria-label={t ? `Осталось ${Math.ceil(sec)} секунд` : 'Таймер не идёт'}>
      <svg viewBox="0 0 168 168" aria-hidden="true">
        <defs>
          <linearGradient id="ad-ring-film" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#8fede4" />
            <stop offset="0.45" stopColor="#e58ad6" />
            <stop offset="1" stopColor="#f2c77a" />
          </linearGradient>
        </defs>
        <circle className="trk" cx="84" cy="84" r={R} />
        <circle className="time" cx="84" cy="84" r={R} strokeDasharray={C} strokeDashoffset={C * (1 - timeFrac)} />
        <circle className="trk" cx="84" cy="84" r={r} style={{ strokeWidth: 5 }} />
        <circle className="ans" cx="84" cy="84" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - ansFrac)} />
      </svg>
      <div className="ad-ring-center">
        <span className="ad-ring-sec">{v.surprise ? (v.pause ? '❚❚' : '🎬') : t ? (t.paused ? '❚❚' : fmtClock(sec)) : video ? (v.pause ? '❚❚' : '▶') : '—'}</span>
        <span className="ad-ring-sub">{v.surprise ? 'сюрприз' : t ? (t.paused ? 'пауза' : t.kind === 'intro' ? 'до старта' : 'осталось') : video ? 'идёт видео' : 'таймер'}</span>
      </div>
    </div>
  );
}

function correctText(v: AdminView): string | null {
  const c = v.correct;
  const q = v.question;
  if (!c || !q) return null;
  if (c.t === 'choice') {
    const i = q.options?.findIndex((o) => o.id === c.id) ?? -1;
    return `${KEYS[i] ?? '?'} — ${c.text ?? 'картинка'}`;
  }
  if (c.t === 'number') return `${c.v}${c.unit ? ` ${c.unit}` : ''}${c.tolerance ? ` (±${c.tolerance})` : ''}`;
  const byId = new Map((q.items ?? []).map((it) => [it.id, it.text ?? 'картинка']));
  return c.ids.map((id, k) => `${k + 1}. ${byId.get(id) ?? '?'}`).join('  ');
}

function answerText(v: AdminView, p: AnswerPayload | null): string {
  if (!p) return 'ещё не ответил';
  if (p.t === 'choice') {
    const i = v.question?.options?.findIndex((o) => o.id === p.id) ?? -1;
    const o = v.question?.options?.[i];
    return `${KEYS[i] ?? '?'} — ${o?.text ?? 'картинка'}`;
  }
  if (p.t === 'number') return String(p.v);
  const byId = new Map((v.question?.items ?? []).map((it) => [it.id, it.text ?? '🖼']));
  return p.ids.map((id) => byId.get(id) ?? '?').join(' → ');
}

function NowCard({ v }: { v: AdminView }) {
  const q = v.question;
  if (v.phase === 'lobby' || v.phase === null) {
    const starts = v.pub?.startsAt ?? 0;
    const recent = [...v.players].reverse().slice(0, 14);
    return (
      <Card kicker={v.phase ? PHASE_LABEL.lobby : 'Подключение'} icon="users">
        <div className="ad-bigstat">
          <b>{v.counts.players}</b>
          <span>{plural(v.counts.players, ['гость в игре', 'гостя в игре', 'гостей в игре'])}</span>
        </div>
        {recent.length ? (
          <div className="ad-people" style={{ marginTop: 12 }}>
            {recent.map((p) => (
              <PersonChip key={p.uid} p={p} />
            ))}
          </div>
        ) : (
          <p className="ad-hint" style={{ marginTop: 8 }}>
            Пока никого. Гости заходят по QR-коду с экрана ТВ.
          </p>
        )}
        {starts ? (
          <p className="ad-hint" style={{ marginTop: 12 }}>
            Старт по плану: {fmtMskDate(new Date(starts).toISOString())} — {fmtUntil(starts - v.now)}
          </p>
        ) : null}
      </Card>
    );
  }
  if (v.phase === 'final') {
    const podium = [...(v.final?.podium ?? [])].sort((a, b) => a.rank - b.rank);
    return (
      <Card
        kicker={
          (v.final?.step ?? 0) >= 6
            ? v.finale && v.finale.stage !== 'after'
              ? 'Финал · идёт финальное видео'
              : 'Финал · всё показано'
            : (v.final?.step ?? 0) >= v.finalLast
              ? 'Финал · всё показано'
              : `Финал · шаг ${(v.final?.step ?? 0) + 1} из ${v.finalLast}`
        }
        icon="trophy"
      >
        {podium.length ? (
          <table className="ad-table">
            <tbody>
              {podium.map((p) => (
                <tr key={p.uid}>
                  <td style={{ width: 40 }}>
                    <span className={cx('ad-rank', `is-${p.rank}`)}>{p.rank}</span>
                  </td>
                  <td className="ad-strong">{p.name}</td>
                  <td className="num ad-mono">{p.score}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="ad-hint">Подиум появится, когда будут очки.</p>
        )}
        {v.final?.vlados ? (
          <p className="ad-hint" style={{ marginTop: 10 }}>
            Владос: {Math.round(v.final.vlados.vladosAccuracy * 100)}% точности, гости — {Math.round(v.final.vlados.guestsAccuracy * 100)}%.
          </p>
        ) : null}
      </Card>
    );
  }
  const correct = correctText(v);
  return (
    <Card>
      <div className="ad-now">
        <div className="ad-now-top">
          <span className="vx-kick">
            Вопрос {q?.n ?? '—'}
            {q?.total ? ` из ${q.total}` : ''} · {PHASE_LABEL[v.phase]}
          </span>
          {q ? <span className="ad-tag">{TYPE_LABEL[q.type]}</span> : null}
          {q?.double ? <span className="ad-tag is-film">×2</span> : null}
          {v.pause ? <span className="ad-tag is-hot">{v.hold ? 'Стоп-экран' : 'Пауза'}</span> : null}
        </div>
        <h2 className="ad-now-title">{q?.title ?? '—'}</h2>
        {correct ? (
          <div className="ad-now-correct" title="Видно только организатору">
            <Icon name="check" size={18} />
            <span>{correct}</span>
          </div>
        ) : null}
        <div className="ad-dial">
          <Ring v={v} />
          <div className="ad-dial-stats">
            <div className="ad-bigstat">
              <b>{v.counts.answered}</b>
              <span>из {v.counts.players} ответили</span>
            </div>
            {v.vladosUid ? (
              <p className="ad-hint">
                <b className="ad-strong">Владос:</b> {answerText(v, v.vladosAnswer)}
              </p>
            ) : (
              <p className="ad-hint">Владос не отмечен — отметь его во вкладке «Игроки».</p>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- controls

function Controls({ v }: { v: AdminView }) {
  const { run } = useAdmin();
  const paused = !!v.pause;
  return (
    <>
      <div className="ad-controls">
        {paused ? (
          <Btn icon="play" tone="accent" disabled={!v.can.resume} onClick={() => void run({ type: 'resume' })}>
            Продолжить
          </Btn>
        ) : (
          <Btn icon="pause" disabled={!v.can.pause} onClick={() => void run({ type: 'pause' })}>
            Пауза
          </Btn>
        )}
        <Btn icon="clock" disabled={!v.can.addTime} onClick={() => void run({ type: 'addTime', ms: 15_000 }, '+15 секунд')}>
          +15 с
        </Btn>
        <HoldButton icon="skip" tone="plain" disabled={!v.can.skip} onConfirm={() => void run({ type: 'skip', phaseRev: v.phaseRev }, 'Вопрос пропущен')}>
          Пропуск
        </HoldButton>
      </div>
      {v.can.end && v.phase !== 'lobby' ? (
        <HoldButton icon="flag" tone="plain" className="ad-btn-wide" onConfirm={() => void run({ type: 'end' }, 'Переходим к финалу')}>
          Сразу к финалу
        </HoldButton>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- distribution

function Dist({ v }: { v: AdminView }) {
  const q = v.question;
  const live = v.liveDist;
  const rv = v.reveal;
  if (!q || !(live || rv)) return null;
  const total = live?.total ?? rv?.count ?? 0;
  let body: ReactNode = null;

  if (q.type === 'choice') {
    const counts: Record<string, number> = live?.t === 'choice' ? live.counts : (rv?.dist ?? {});
    const correctId = live?.t === 'choice' ? live.correctId : typeof rv?.correct === 'string' ? rv.correct : null;
    const max = Math.max(1, ...Object.values(counts));
    body = (
      <div className="ad-dist">
        {(q.options ?? []).map((o, i) => {
          const n = counts[o.id] ?? 0;
          return (
            <div key={o.id} className={cx('ad-dist-row', o.id === correctId && 'is-correct')}>
              <span className="ad-dist-key">{KEYS[i]}</span>
              <div className="ad-dist-bar">
                <i style={{ transform: `scaleX(${n / max})` }} />
                <span>{o.text ?? 'картинка'}</span>
              </div>
              <span className="ad-dist-n">{n}</span>
            </div>
          );
        })}
      </div>
    );
  } else if (q.type === 'number') {
    const dist = live?.t === 'number' ? live.dist : (rv?.dist ?? {});
    const bin = live?.t === 'number' ? live.bin : rv?.bin;
    const answer = live?.t === 'number' ? live.answer : typeof rv?.correct === 'number' ? rv.correct : null;
    const keys = Object.keys(dist).sort((a, b) => Number(a) - Number(b));
    const max = Math.max(1, ...Object.values(dist));
    const hit = (k: string) => answer !== null && (bin ? answer >= Number(k) && answer < Number(k) + bin : Number(k) === answer);
    body = keys.length ? (
      <>
        <div className="ad-hist" aria-hidden="true">
          {keys.map((k) => (
            <i key={k} className={cx('ad-hist-col', hit(k) && 'is-hit')} style={{ height: `${Math.max(4, ((dist[k] ?? 0) / max) * 100)}%` }} title={`${k}: ${dist[k]}`} />
          ))}
        </div>
        <div className="ad-row ad-hint" style={{ justifyContent: 'space-between', marginTop: 6 }}>
          <span className="ad-mono">{keys[0]}</span>
          {live?.t === 'number' && live.median !== null ? <span>медиана {live.median}</span> : null}
          <span className="ad-mono">{bin ? Number(keys[keys.length - 1]) + bin : keys[keys.length - 1]}</span>
        </div>
      </>
    ) : (
      <p className="ad-hint">Пока нет ответов.</p>
    );
  } else {
    if (live?.t === 'ordering') {
      const items = q.items ?? [];
      const correct = v.correct?.t === 'ordering' ? v.correct.ids : items.map((it) => it.id);
      const byId = new Map(items.map((it) => [it.id, it.text ?? 'картинка']));
      body = (
        <div className="ad-dist">
          <p className="ad-hint">
            Всё верно у <b className="ad-strong">{live.exact}</b> из {live.total}. По местам:
          </p>
          {correct.map((id, k) => {
            const n = live.positionHits[k] ?? 0;
            return (
              <div key={id} className="ad-dist-row is-correct">
                <span className="ad-dist-key">{k + 1}</span>
                <div className="ad-dist-bar">
                  <i style={{ transform: `scaleX(${live.total ? n / live.total : 0})` }} />
                  <span>{byId.get(id)}</span>
                </div>
                <span className="ad-dist-n">{n}</span>
              </div>
            );
          })}
        </div>
      );
    } else if (rv) {
      const keys = Object.keys(rv.dist).sort((a, b) => Number(a) - Number(b));
      const max = Math.max(1, ...Object.values(rv.dist));
      body = (
        <div className="ad-dist">
          {keys.map((k) => (
            <div key={k} className={cx('ad-dist-row', Number(k) === (q.items?.length ?? -1) && 'is-correct')}>
              <span className="ad-dist-key">{k}</span>
              <div className="ad-dist-bar">
                <i style={{ transform: `scaleX(${(rv.dist[k] ?? 0) / max})` }} />
                <span>{plural(Number(k), ['пункт на месте', 'пункта на месте', 'пунктов на месте'])}</span>
              </div>
              <span className="ad-dist-n">{rv.dist[k]}</span>
            </div>
          ))}
        </div>
      );
    }
  }

  return (
    <Card
      kicker={live ? 'Ответы гостей — видно только тебе' : 'Итог вопроса'}
      title={`${total} ${plural(total, ['ответ', 'ответа', 'ответов'])}${rv ? ` · верно ${Math.round(rv.pct * 100)}%` : ''}`}
      icon="signal"
    >
      {body}
    </Card>
  );
}

function NotAnswered({ v }: { v: AdminView }) {
  if (v.phase !== 'open' && v.phase !== 'locked') return null;
  const list = v.notAnswered.filter((p) => p.uid !== v.vladosUid);
  return (
    <Card kicker="Ещё думают" title={list.length ? nPlayers(list.length) : 'Ответили все!'} icon="clock">
      {list.length ? (
        <div className="ad-people">
          {list.slice(0, 60).map((p) => (
            <PersonChip key={p.uid} p={p} />
          ))}
          {list.length > 60 ? <span className="ad-hint">и ещё {list.length - 60}</span> : null}
        </div>
      ) : (
        <p className="ad-hint">Можно показывать ответ — ждать больше некого.</p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- queue

function Queue({ v }: { v: AdminView }) {
  const { run } = useAdmin();
  const [open, setOpen] = useState(false);
  const current = v.question?.qid;
  const shown = open ? v.questions : v.questions.filter((q) => q.qid === current || q.qid === v.next?.qid);
  const nextN = v.next ? v.questions.findIndex((q) => q.qid === v.next?.qid) + 1 : 0;
  return (
    <Card
      kicker="Очередь"
      // the question itself is the highlighted row below: a long title in the display face
      // would squeeze into a one-word column next to the button on a phone
      title={v.next ? (nextN > 0 ? `Дальше — вопрос ${nextN}` : 'Дальше') : 'Вопросы закончились'}
      icon="list"
      actions={
        <Btn size="s" tone="ghost" icon={open ? 'chevronD' : 'chevronR'} onClick={() => setOpen(!open)}>
          {open ? 'Свернуть' : `Все ${v.questions.length}`}
        </Btn>
      }
    >
      {v.next ? (
        <p className="ad-hint" style={{ marginTop: -6, marginBottom: 10 }}>
          {TYPE_LABEL[v.next.type]}. Порядок меняется во вкладке «Вопросы» — перетаскиванием.
        </p>
      ) : null}
      <ul className="ad-queue">
        {shown.map((q) => {
          const idx = v.questions.findIndex((x) => x.qid === q.qid);
          const isNow = q.qid === current;
          const isNext = q.qid === v.next?.qid;
          return (
            <li key={q.qid} className={cx(q.played && !isNow && 'is-done', isNext && 'is-next')}>
              <span className="ad-queue-n">{idx + 1}</span>
              <span title={q.title}>
                {q.title || 'Без текста'}
                {q.disabled ? ' · выключен' : ''}
              </span>
              {isNow ? (
                <span className="ad-tag is-film">сейчас</span>
              ) : q.scored ? (
                <span className="ad-tag">сыгран</span>
              ) : q.disabled ? null : (
                <HoldButton size="s" tone="accent" holdMs={900} disabled={!v.can.jumpTo} onConfirm={() => void run({ type: 'jumpTo', qid: q.qid }, 'Запускаю этот вопрос')}>
                  Сейчас
                </HoldButton>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// ---------------------------------------------------------------- «Сказать всем» = стоп-экран

const QUICK_TEXTS = [
  '🎂 Несём торт — небольшая пауза',
  '📱 Кто ещё не в игре — наведите камеру на QR-код',
  '🥂 Тост! Продолжим через минуту',
  '📸 Общее фото — все к экрану!',
  '🤫 Тишина — Владос отвечает',
  '🔋 Не гасите телефоны — впереди финал',
];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The «стоп-экран» is one phaseRev-guarded transaction (text + the whole show paused). When the
 * show moved on between the tap and the write (the host opened the answers that very second), it
 * is tried again on the fresh phase: the organizer wants it to stop NOW, whatever is on.
 */
async function sendHold(host: HostLike, text: string): Promise<CmdResult> {
  let r: CmdResult = { ok: false, error: 'stale' };
  for (let k = 0; k < 4 && !r.ok && r.error === 'stale'; k++) {
    if (k) await sleep(300);
    r = await host.command({ type: 'hold', phaseRev: host.adminView().phaseRev, text });
  }
  return r;
}

/**
 * The held card appears at the top of «Эфир», but «Показать» was pressed further down (a phone
 * scrolls): bring it into view once, so the organizer sees the stop and the button to go on.
 */
function ScrollIntoView({ id }: { id: string }) {
  useEffect(() => {
    const el = document.getElementById(id);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.top > innerHeight * 0.6) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [id]);
  return null;
}

/** Quick texts + an own text; every one of them puts the show on hold with it. */
function HoldTexts({ busy, onSend, submit = 'Показать', onCancel }: { busy: boolean; onSend: (t: string) => void; submit?: string; onCancel?: () => void }) {
  const [text, setText] = useState('');
  return (
    <>
      <div className="ad-banner-chips">
        {QUICK_TEXTS.map((t) => (
          <button key={t} type="button" disabled={busy} onClick={() => onSend(t)}>
            {t}
          </button>
        ))}
      </div>
      <form
        className="ad-row"
        style={{ marginTop: 12, flexWrap: 'nowrap' }}
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim() && !busy) onSend(text.trim());
        }}
      >
        <TextInput value={text} onChange={setText} placeholder="Свой текст…" maxLength={FB_LIMITS.bannerMax} className="ad-grow" />
        <Btn type="submit" tone="chrome" disabled={!text.trim()} busy={busy}>
          {submit}
        </Btn>
      </form>
      {onCancel ? (
        <Btn tone="ghost" size="s" icon="x" style={{ marginTop: 10 }} onClick={onCancel}>
          Оставить как есть
        </Btn>
      ) : null}
    </>
  );
}

/**
 * «Сказать всем»: «Показать» and every quick text put the show on HOLD — the TV shows only the
 * text (no sound, no timer, no reactions), every timer freezes with its time left, the guests see
 * «Пауза — смотри на экран». Held, the card turns into the big state with «Убрать надпись и
 * продолжить» (the show goes on exactly where it stopped) and «Сменить текст».
 */
function SayAll({ v }: { v: AdminView }) {
  const { host, run } = useAdmin();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const hold = v.hold;
  const send = async (t: string) => {
    if (busy) return;
    navigator.vibrate?.(12);
    setBusy(true);
    const again = hold !== null;
    const r = await sendHold(host, t);
    setBusy(false);
    if (!r.ok) {
      toast(cmdErrorText(r), { tone: 'bad' });
      return;
    }
    setEditing(false);
    toast(again ? 'Текст на экране поменяли' : 'Стоп-экран: игра стоит, на ТВ только надпись', { tone: 'good' });
  };
  const release = async () => {
    if (busy) return;
    navigator.vibrate?.(12);
    setBusy(true);
    await run({ type: 'unhold' }, 'Продолжаем с того же места');
    setBusy(false);
  };

  if (hold) {
    const left = v.timer && v.timer.remainingMs > 0 ? ` · на таймере ${fmtClock(v.timer.remainingMs / 1000)}` : '';
    return (
      <Card id="ad-hold" tone="accent" className="ad-hold" kicker="Сказать всем" title="Стоп-экран включён" icon="tv">
        <ScrollIntoView id="ad-hold" />
        <p className="ad-hold-text">{hold.text || 'Небольшая пауза'}</p>
        <p className="ad-hint">
          Игра стоит {fmtClock(Math.max(0, v.now - hold.at) / 1000)}: таймеры замерли, звука и видео нет, реакции выключены. У гостей — «Пауза, смотри на экран».
        </p>
        {editing ? (
          <div style={{ marginTop: 14 }}>
            <HoldTexts busy={busy} onSend={(t) => void send(t)} submit="Сменить" onCancel={() => setEditing(false)} />
          </div>
        ) : (
          <>
            <ChromeButton variant="film" block className="ad-hero-btn ad-hold-go" loading={busy} onClick={() => void release()}>
              <span className="ad-hero-main">Убрать надпись и продолжить</span>
              <span className="ad-hero-sub">с того же места{left}</span>
            </ChromeButton>
            <Btn icon="edit" tone="plain" className="ad-btn-wide" style={{ marginTop: 10 }} disabled={busy} onClick={() => setEditing(true)}>
              Сменить текст
            </Btn>
          </>
        )}
      </Card>
    );
  }
  return (
    <Card kicker="Стоп-экран на ТВ" title="Сказать всем" icon="message">
      {v.banner ? (
        <div className="ad-banner-live" style={{ marginBottom: 12 }}>
          <Icon name="tv" size={18} />
          <span>{v.banner}</span>
          <Btn size="s" tone="plain" icon="x" onClick={() => void run({ type: 'unhold' })}>
            Убрать
          </Btn>
        </div>
      ) : null}
      <p className="ad-hint" style={{ marginTop: -4, marginBottom: 12 }}>
        Надпись встанет на весь экран ТВ, а игра — на паузу: таймеры замрут, звук и видео выключатся, у гостей «смотри на экран».
      </p>
      <HoldTexts busy={busy} onSend={(t) => void send(t)} />
    </Card>
  );
}

// ---------------------------------------------------------------- health

function Health({ v }: { v: AdminView }) {
  const h = v.health;
  const lease = v.lease;
  const leaseOk = lease.holder && (lease.expiresInMs ?? 0) > 0;
  const holder = lease.mine ? 'этот пульт' : lease.holder?.label === 'tv' ? 'экран ТВ' : lease.holder?.label === 'admin' ? 'другой пульт' : (lease.holder?.label ?? '—');
  const online = h.listeners.game === 'live';
  const rows: [IconName, string, ReactNode, 'good' | 'warn' | 'bad' | 'idle'][] = [
    ['tv', 'Ведёт игру', leaseOk ? `${holder}${lease.holder?.preferred ? ' ★' : ''}` : 'никто — первый пульт подхватит', leaseOk ? 'good' : 'warn'],
    ['signal', 'Связь с базой', online ? 'в сети' : h.listeners.game === 'cache' ? 'нет сети — жду' : 'подключаюсь', online ? 'good' : 'bad'],
    ['clock', 'Часы', h.clock.syncedAt ? `сверены, ±${Math.round((h.clock.rttMs ?? 0) / 2)} мс` : 'сверяю…', h.clock.syncedAt ? 'good' : 'idle'],
  ];
  return (
    <Card kicker="Техника" title="Всё под контролем?" icon="bolt" tone="quiet">
      <dl className="ad-kv">
        {rows.map(([icon, k, val, tone]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt className="ad-row" style={{ gap: 6 }}>
              <Icon name={icon} size={15} />
              {k}
            </dt>
            <dd>
              <Dot tone={tone} />
              <span className="ad-clip">{val}</span>
            </dd>
          </div>
        ))}
        {h.lastError ? (
          <>
            <dt>Последняя ошибка</dt>
            <dd>
              <span className="ad-clip ad-muted" title={h.lastError.msg}>
                {fmtAgo(v.now - h.lastError.at)}: {h.lastError.msg}
              </span>
            </dd>
          </>
        ) : null}
      </dl>
      {h.warnings.length ? (
        <p className="ad-hint is-error" style={{ marginTop: 10 }}>
          {h.warnings.length} {plural(h.warnings.length, ['файл не найден', 'файла не найдены', 'файлов не найдено'])} — проверь вопросы.
        </p>
      ) : null}
      <p className="ad-hint" style={{ marginTop: 10 }}>
        Игру ведёт экран ТВ. Если он отключится, через 15 секунд её подхватит любой открытый пульт — гости ничего не заметят.
      </p>
    </Card>
  );
}

function TvLinks() {
  const tv = appUrl('#/tv');
  const guests = appUrl('#/');
  const copy = async (u: string, what: string) => {
    try {
      await navigator.clipboard.writeText(u);
      toast(`${what} скопирована`, { tone: 'good' });
    } catch {
      toast(u, { ms: 8000 });
    }
  };
  return (
    <>
      <Btn icon="external" onClick={() => window.open(tv, '_blank', 'noopener')}>
        Открыть экран ТВ
      </Btn>
      <Btn icon="link" tone="ghost" onClick={() => void copy(guests, 'Ссылка для гостей')}>
        Ссылка для гостей
      </Btn>
    </>
  );
}

export function LiveTab() {
  const v = useAdminView(250);
  const empty = v.phase === 'lobby' && !v.questions.length;
  return (
    <>
      <PageHead
        compact
        kicker={v.phase ? PHASE_LABEL[v.phase] : 'Подключаюсь'}
        title="Эфир"
        actions={
          <>
            {v.phase === 'lobby' && v.questions.length ? <RehearsalButton from="/live" /> : null}
            <TvLinks />
          </>
        }
      />
      {empty ? (
        <Card>
          <Empty icon="list" title="В игре пока нет вопросов" text="Добавь их во вкладке «Вопросы» — и здесь появится кнопка «Начать игру».">
            <Btn tone="chrome" icon="plus" onClick={() => (location.hash = '#/admin/questions')}>
              К вопросам
            </Btn>
          </Empty>
        </Card>
      ) : null}
      <div className="ad-live">
        <div className="ad-cockpit">
          <AutopilotSwitch v={v} />
          {/* held: the big «стоп-экран» state takes the hero's place (nothing else moves the show) */}
          {v.hold ? <SayAll v={v} /> : null}
          <NowCard v={v} />
          <TvAlert v={v} />
          {v.hold ? null : (
            <>
              <Hero v={v} />
              <Controls v={v} />
            </>
          )}
          <Queue v={v} />
        </div>
        <div className="ad-stack">
          <Dist v={v} />
          <NotAnswered v={v} />
          {v.hold ? null : <SayAll v={v} />}
          {v.phase === 'lobby' && v.players.length ? <LobbyFaces v={v} /> : null}
          <Health v={v} />
        </div>
      </div>
    </>
  );
}

function LobbyFaces({ v }: { v: AdminView }) {
  return (
    <Card kicker="В лобби" title={nPlayers(v.players.length)} icon="users" tone="quiet">
      <div className="ad-row" style={{ gap: 6 }}>
        {v.players.slice(-40).map((p) => (
          <span key={p.uid} title={p.name}>
            <PlayerAvatar p={p} size={36} />
          </span>
        ))}
      </div>
    </Card>
  );
}
