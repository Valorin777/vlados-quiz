// «Шпаргалка»: what the host needs to know about the question on screen — the right answer, the
// text after the reveal, the organizer's notes — and how the (fake) room did at this moment.

import { correctOrder } from '@shared/scoring';
import type { AnswerPayload, Question } from '@shared/types';
import type { TvView } from '../../../host';
import type { Position, Timeline } from '../../../host/rehearsal';
import { cx, plural } from '../../../visual';
import { KEYS, TYPE_LABEL, fmtDuration } from '../core/format';
import { Icon } from '../ui/icons';
import { TYPE_ICON } from './icons';

const num = (v: number): string => v.toLocaleString('ru-RU', { maximumFractionDigits: 6 });

function answerText(q: Question, p: AnswerPayload | null | undefined): string {
  if (!p) return 'не ответил';
  if (p.t === 'choice' && q.type === 'choice') {
    const k = q.options.findIndex((o) => o.id === p.id);
    return k >= 0 ? `${KEYS[k]} — ${q.options[k]?.text?.trim() || 'картинка'}` : '?';
  }
  if (p.t === 'number') return `${num(p.v)}${q.type === 'number' && q.unit ? ` ${q.unit}` : ''}`;
  if (p.t === 'ordering' && q.type === 'ordering') {
    const byId = new Map(q.items.map((it, k) => [it.id, it.text?.trim() || `Пункт ${k + 1}`]));
    return p.ids.map((id) => byId.get(id) ?? '?').join(' → ');
  }
  return '?';
}

function Correct({ q }: { q: Question }) {
  if (q.type === 'choice') {
    return (
      <ol className="rh-sh-opts">
        {q.options.map((o, k) => (
          <li key={o.id} className={cx(o.id === q.correctId && 'is-ok')}>
            <b>{KEYS[k]}</b>
            <span>{o.text?.trim() || (o.mediaId ? 'картинка' : `Вариант ${KEYS[k]}`)}</span>
            {o.id === q.correctId ? <Icon name="check" size={16} /> : null}
          </li>
        ))}
      </ol>
    );
  }
  if (q.type === 'number') {
    return (
      <div className="rh-sh-num">
        <b className="vx-chr">
          {num(q.answer)}
          {q.unit ? <small> {q.unit}</small> : null}
        </b>
        <span>
          {q.tolerance > 0 ? `±${num(q.tolerance)} — полные очки за точность; ` : 'только точный ответ — полные очки; '}
          ошибка {num(q.zeroAt)} и больше — ноль за точность
          {q.min !== undefined && q.max !== undefined ? ` · вводят от ${num(q.min)} до ${num(q.max)}` : ''}
        </span>
      </div>
    );
  }
  const byId = new Map(q.items.map((it, k) => [it.id, it.text?.trim() || (it.mediaId ? 'картинка' : `Пункт ${k + 1}`)]));
  return (
    <div>
      <p className="rh-sh-axis">
        {q.firstLabel || 'Раньше'} → {q.lastLabel || 'Позже'}
      </p>
      <ol className="rh-sh-opts is-order">
        {correctOrder(q).map((id, k) => (
          <li key={id} className="is-ok">
            <b>{k + 1}</b>
            <span>{byId.get(id)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Stats({ tl, tv, q }: { tl: Timeline; tv: TvView; q: Question }) {
  const rv = tv.reveal;
  if (!rv) {
    if (tv.phase === 'intro') return <p className="rh-sh-live">{tv.watch ? 'Видео на экране — ответы откроются после него' : 'Заставка — ответы ещё не открылись'}</p>;
    // like the TV: the guests, Vlados apart
    const answered = new Set(tv.answeredIds);
    const guests = tv.players.filter((p) => !p.isVlados);
    const vlados = tv.players.find((p) => p.isVlados);
    return (
      <p className="rh-sh-live">
        Ответили <b>{guests.filter((p) => answered.has(p.uid)).length}</b> из {guests.length}
        {vlados ? ` · ${tl.settings.vladosLabel} ${answered.has(vlados.uid) ? 'ответил' : 'ещё думает'}` : ''}
      </p>
    );
  }
  const guests = rv.answers.filter((a) => !a.isVlados);
  const fastest = guests.find((a) => a.ok);
  const me = rv.answers.find((a) => a.uid === tl.meUid);
  const vlados = tl.vladosUid ? rv.answers.find((a) => a.uid === tl.vladosUid) : undefined;
  return (
    <dl className="rh-sh-stats">
      <dt>Верно</dt>
      <dd>
        <b>{Math.round(rv.pct * 100)}%</b> из {rv.count ?? guests.length} {plural(rv.count ?? guests.length, ['ответившего', 'ответивших', 'ответивших'])}
      </dd>
      {fastest ? (
        <>
          <dt>Быстрее всех</dt>
          <dd>
            {fastest.name} · {(fastest.e / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} c · +{fastest.pts}
          </dd>
        </>
      ) : null}
      {tl.vladosUid ? (
        <>
          <dt>{tl.settings.vladosLabel}</dt>
          <dd>{answerText(q, vlados?.p)}</dd>
        </>
      ) : null}
      <dt>Ты</dt>
      <dd>
        {answerText(q, me?.p)}
        {me ? ` · ${me.ok ? 'верно' : 'мимо'} · +${me.pts}` : ''}
      </dd>
    </dl>
  );
}

export function CheatSheet({ tl, tv, pos, onClose }: { tl: Timeline; tv: TvView; pos: Position; onClose: () => void }) {
  const r = pos.k !== null ? tl.rounds[pos.k] : undefined;
  let body;
  if (r) {
    const q = r.q;
    body = (
      <>
        <p className="rh-sh-kick">
          <Icon name={r.video ? 'video' : TYPE_ICON[q.type]} size={14} />
          Вопрос {r.n} из {tl.rounds.length} · {TYPE_LABEL[q.type]} · {q.timeLimitS} c{q.double ? ' · ×2' : ''}
        </p>
        <h3 className="rh-sh-title">{q.title.trim() || 'Без текста'}</h3>
        <section>
          <h4>Правильный ответ</h4>
          <Correct q={q} />
        </section>
        {q.revealText?.trim() ? (
          <section>
            <h4>После ответа на экране</h4>
            <p>{q.revealText}</p>
          </section>
        ) : null}
        {q.notes?.trim() ? (
          <section className="rh-sh-notes">
            <h4>Заметки ведущего</h4>
            <p>{q.notes}</p>
          </section>
        ) : null}
        <section>
          <h4>Сейчас в зале</h4>
          <Stats tl={tl} tv={tv} q={q} />
        </section>
      </>
    );
  } else if (pos.stage === 'final') {
    const podium = [...(tv.final?.podium ?? [])].sort((a, b) => a.rank - b.rank);
    const v = tv.final?.vlados;
    body = (
      <>
        <p className="rh-sh-kick">
          <Icon name="trophy" size={14} /> Финал · шаг {(pos.step ?? 0) + 1} из 6
        </p>
        <h3 className="rh-sh-title">Подиум</h3>
        <ol className="rh-sh-opts is-order">
          {podium.map((p) => (
            <li key={p.uid} className="is-ok">
              <b>{p.rank}</b>
              <span>
                {p.name} · {p.score}
              </span>
            </li>
          ))}
        </ol>
        {podium.length < 3 ? <p className="rh-sh-live">Остальные места открываются по шагам</p> : null}
        {v ? (
          <section>
            <h4>{tl.settings.vladosLabel} против гостей</h4>
            <p>
              точность {Math.round(v.vladosAccuracy * 100)}% · гости {Math.round(v.guestsAccuracy * 100)}%
              {v.best ? ` · лучший — ${v.best.name}, ${Math.round(v.best.accuracy * 100)}%` : ''}
            </p>
          </section>
        ) : null}
      </>
    );
  } else {
    const secs = Math.round((tl.end - tl.t0) / 1000);
    body = (
      <>
        <p className="rh-sh-kick">
          <Icon name="users" size={14} /> Лобби
        </p>
        <h3 className="rh-sh-title">
          {tl.rounds.length} {plural(tl.rounds.length, ['вопрос', 'вопроса', 'вопросов'])} · ~{fmtDuration(secs)}
        </h3>
        <p>
          {Object.keys(tl.players).length} гостей понарошку, среди них {tl.settings.vladosLabel} и «Ты» — это телефон справа. Ответы гостей
          выдуманы, очки считает настоящая логика игры.
        </p>
        <ol className="rh-sh-opts is-order">
          {tl.rounds.map((x) => (
            <li key={x.qid}>
              <b>{x.n}</b>
              <span>{x.q.title.trim() || 'Без текста'}</span>
              <Icon name={x.video ? 'video' : TYPE_ICON[x.type]} size={15} />
            </li>
          ))}
        </ol>
      </>
    );
  }
  return (
    <aside className="rh-sheet" aria-label="Шпаргалка ведущего">
      <header>
        <span>Шпаргалка</span>
        <button type="button" className="rh-ib is-s" aria-label="Скрыть шпаргалку" onClick={onClose}>
          <Icon name="x" size={15} />
        </button>
      </header>
      <div className="rh-sheet-in">{body}</div>
    </aside>
  );
}
