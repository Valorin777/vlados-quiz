// «Итоги»: standings, per-question statistics, «исправить ответ и пересчитать», CSV for Excel,
// and the danger zone (reset scores / new game — hold to confirm).

import type { Question } from '@shared/types';
import { useState } from 'react';
import { Modal, cx, plural, toast } from '../../../visual';
import { KEYS, TYPE_LABEL } from '../core/format';
import { roundStats, standings, standingsCsv, type RoundStat } from '../core/results';
import { useAdmin, useHostValue } from '../core/session';
import { Btn, Card, Chips, Empty, Field, HoldButton, Meter, NumInput, PageHead } from '../ui/kit';
import { Icon } from '../ui/icons';
import { SortableList, moveItem, useSortableRow } from '../ui/sortable';

function OrderFixRow({ id, text, n }: { id: string; text: string; n: number }) {
  const row = useSortableRow(id);
  return (
    <div ref={row.ref} style={row.style} className={cx('ad-item', row.dragging && 'is-dragging')}>
      <button type="button" className="ad-qi-grip" aria-label={`Перетащить ${text}`} {...row.handle}>
        <Icon name="grip" size={18} />
      </button>
      <span className="ad-item-n">{n}</span>
      <span>{text}</span>
      <span />
      <span />
    </div>
  );
}

function FixModal({ round, onClose }: { round: RoundStat | null; onClose: () => void }) {
  const { content, run } = useAdmin();
  const [draft, setDraft] = useState<Question | null>(null);
  const [busy, setBusy] = useState(false);
  const [forQid, setForQid] = useState<string | null>(null);
  const source = round ? content.get().doc?.questions.find((q) => q.id === round.qid) : undefined;
  if (round && round.qid !== forQid) {
    setForQid(round.qid);
    setDraft(source ? structuredClone(source) : null);
  }

  const save = async () => {
    if (!round || !draft) return;
    setBusy(true);
    try {
      content.updateQuestion(draft.id, () => draft, 0);
      await content.flush();
      const rev = content.get().doc?.rev ?? 0;
      await content.hostCaughtUp(rev);
      if (await run({ type: 'rescoreRound', round: round.i }, 'Очки пересчитаны')) onClose();
    } finally {
      setBusy(false);
    }
  };

  let body = null;
  if (round && !source) body = <p className="ad-hint is-error">Этот вопрос удалён. Верни его из корзины во вкладке «Вопросы», чтобы пересчитать.</p>;
  else if (draft?.type === 'choice') {
    body = (
      <Field label="Правильный вариант">
        <Chips
          value={draft.correctId}
          onChange={(id) => setDraft({ ...draft, correctId: id })}
          options={draft.options.map((o, i) => ({ value: o.id, label: `${KEYS[i]} · ${o.text || 'картинка'}` }))}
        />
      </Field>
    );
  } else if (draft?.type === 'number') {
    body = (
      <div className="ad-grid-2">
        <Field label="Правильный ответ">
          <NumInput value={draft.answer} onChange={(v) => v !== undefined && setDraft({ ...draft, answer: v })} suffix={draft.unit} />
        </Field>
        <Field label="Допуск">
          <NumInput value={draft.tolerance} min={0} onChange={(v) => v !== undefined && setDraft({ ...draft, tolerance: v })} />
        </Field>
      </div>
    );
  } else if (draft?.type === 'ordering') {
    const d = draft;
    body = (
      <Field label="Правильный порядок" hint="Перетащи пункты.">
        <SortableList ids={d.items.map((it) => it.id)} onMove={(a, b) => setDraft({ ...d, items: moveItem(d.items, a, b) })}>
          <div className="ad-items">
            {d.items.map((it, k) => (
              <OrderFixRow key={it.id} id={it.id} n={k + 1} text={it.text || 'картинка'} />
            ))}
          </div>
        </SortableList>
      </Field>
    );
  }

  return (
    <Modal open={!!round} onClose={onClose} title={round ? `Исправить ответ · вопрос ${round.n ?? ''}` : ''}>
      <div className="ad-sheet-stack">
        {round ? <p className="ad-strong" style={{ margin: 0, fontWeight: 600 }}>{round.title}</p> : null}
        {body}
        <p className="ad-hint">Ответ исправится и в самом вопросе. Очки всех гостей за этот вопрос пересчитаются, таблица обновится.</p>
        <div className="ad-sheet-actions">
          <Btn tone="ghost" onClick={onClose}>
            Отмена
          </Btn>
          <Btn tone="chrome" icon="refresh" busy={busy} disabled={!draft} onClick={() => void save()}>
            Сохранить и пересчитать
          </Btn>
        </div>
      </div>
    </Modal>
  );
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function ResultsTab() {
  const { run } = useAdmin();
  const data = useHostValue((h) => {
    const s = h.snapshot();
    return { rows: standings(s), rounds: roundStats(s), phase: s.game?.phase ?? null, gameId: s.gameId };
  }, 2000);
  const [fix, setFix] = useState<RoundStat | null>(null);
  const [all, setAll] = useState(false);
  const rows = all ? data.rows : data.rows.slice(0, 15);
  const scored = data.rounds.filter((r) => r.revealed && !r.skipped);

  return (
    <>
      <PageHead
        kicker={`${scored.length} ${plural(scored.length, ['вопрос сыгран', 'вопроса сыграно', 'вопросов сыграно'])}`}
        title="Итоги"
        actions={
          <Btn
            icon="download"
            disabled={!data.rows.length}
            onClick={() => {
              download(`vlados-itogi-${new Date().toISOString().slice(0, 10)}.csv`, standingsCsv(data.rows, data.rounds));
              toast('Таблица скачана — открывается в Excel и Numbers', { tone: 'good' });
            }}
          >
            Скачать CSV
          </Btn>
        }
      />
      <div className="ad-two">
        <Card kicker="Таблица" title="Кто лидирует" icon="trophy">
          {data.rows.length ? (
            <div className="ad-table-wrap">
              <table className="ad-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Имя</th>
                    <th className="num">Очки</th>
                    <th className="num">Верно</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.uid}>
                      <td style={{ width: 44 }}>{r.rank ? <span className={cx('ad-rank', r.rank <= 3 && `is-${r.rank}`)}>{r.rank}</span> : <span className="ad-tag is-film">вне</span>}</td>
                      <td className="ad-strong">
                        {r.name}
                        {r.isVlados ? <span className="ad-muted"> · Владос</span> : null}
                      </td>
                      <td className="num ad-mono ad-strong">{r.score}</td>
                      <td className="num ad-mono">
                        {r.correct}/{scored.length}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.rows.length > 15 ? (
                <Btn tone="ghost" size="s" onClick={() => setAll(!all)} style={{ marginTop: 8 }}>
                  {all ? 'Свернуть' : `Показать всех ${data.rows.length}`}
                </Btn>
              ) : null}
            </div>
          ) : (
            <Empty icon="trophy" title="Пока пусто" text="Очки появятся после первого вопроса." />
          )}
        </Card>

        <Card kicker="По вопросам" title="Как отвечали" icon="signal">
          {data.rounds.length ? (
            <div className="ad-table-wrap">
              <table className="ad-table">
                <thead>
                  <tr>
                    <th>№</th>
                    <th>Вопрос</th>
                    <th>Верно</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.rounds.map((r) => (
                    <tr key={r.i}>
                      <td className="ad-mono">{r.n ?? '—'}</td>
                      <td>
                        <div className="ad-strong" style={{ fontWeight: 600 }}>
                          {r.title}
                        </div>
                        <div className="ad-hint">
                          {TYPE_LABEL[r.type]}
                          {r.skipped ? ' · пропущен' : !r.revealed ? ' · идёт сейчас' : ` · ответили ${r.answered} · в среднем ${r.avgPoints} очк.`}
                          {r.fastestName ? ` · быстрее всех ${r.fastestName} (${((r.fastestMs ?? 0) / 1000).toFixed(1).replace('.', ',')} с)` : ''}
                        </div>
                      </td>
                      <td>
                        {r.revealed && !r.skipped ? (
                          <div className="ad-pct">
                            <Meter value={r.correctPct} />
                            <span className="ad-mono">{Math.round(r.correctPct * 100)}%</span>
                          </div>
                        ) : null}
                      </td>
                      <td className="num">
                        {r.revealed && !r.skipped ? (
                          <Btn size="s" tone="ghost" icon="edit" onClick={() => setFix(r)}>
                            Исправить
                          </Btn>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty icon="signal" title="Ещё ни одного вопроса" text="Здесь будет статистика по каждому вопросу: кто быстрее, сколько верных." />
          )}
        </Card>
      </div>

      <Card kicker="Осторожно" title="Опасная зона" icon="alert" tone="danger" style={{ marginTop: 18 }}>
        <div className="ad-danger">
          <div className="ad-danger-row">
            <p className="ad-hint">
              <b className="ad-strong">Обнулить очки.</b> Все гости остаются в игре, игра возвращается в лобби, вопросы можно сыграть заново. Удобно после репетиции.
            </p>
            <HoldButton icon="refresh" onConfirm={() => void run({ type: 'resetScores' }, 'Очки обнулены, игра в лобби')}>
              Обнулить очки
            </HoldButton>
          </div>
          <hr className="ad-sep" style={{ margin: 0 }} />
          <div className="ad-danger-row">
            <p className="ad-hint">
              <b className="ad-strong">Новая игра.</b> Чистое лобби: гости заходят заново по QR-коду, очки и игроки старой игры остаются в архиве. Вопросы и настройки не меняются.
            </p>
            <HoldButton icon="sparkle" holdMs={2000} onConfirm={() => void run({ type: 'newGame' }, 'Новая игра создана')}>
              Новая игра
            </HoldButton>
          </div>
        </div>
      </Card>
      <FixModal round={fix} onClose={() => setFix(null)} />
    </>
  );
}
