// «Вопросы»: readiness meter, drag-to-reorder list, editor and live preview (laptop: three
// columns; phone: list → editor).

import type { Question, QuestionType } from '@shared/types';
import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { ChromeBlock, Modal, cx, plural, toast } from '../../../visual';
import { TRASH_KEEP, useContent } from '../core/content';
import { fmtDuration, nQuestions, TYPE_HINT } from '../core/format';
import { mediaMeta } from '../core/media';
import { mediaIdsOf, readiness, type Readiness } from '../core/readiness';
import { useAdmin } from '../core/session';
import { normalizeSettings } from '../../../host/pure';
import { RehearsalButton } from '../rehearsal/RehearsalButton';
import { Btn, Card, Dot, Empty, Meter, PageHead, showUndo } from '../ui/kit';
import { Icon } from '../ui/icons';
import { PHONE_QUERY, useMedia } from '../ui/media-query';
import { SortableList, moveItem, useSortableRow } from '../ui/sortable';
import { Editor } from './Editor';
import { duplicateQuestion, newQuestion, QUESTION_TYPES, TYPE_UI } from './model';
import { Preview } from './Preview';

/** Existence of every referenced media file (one meta read per id per page). */
function useMediaExists(questions: readonly Question[]): Record<string, boolean> {
  const media = useAdmin().backend.media;
  const [known, setKnown] = useState<Record<string, boolean>>({});
  const ids = useMemo(() => [...new Set(questions.flatMap(mediaIdsOf))].sort().join(','), [questions]);
  useEffect(() => {
    let alive = true;
    for (const id of ids ? ids.split(',') : []) {
      void mediaMeta(media, id).then((m) => {
        if (alive) setKnown((k) => (k[id] === (m !== null) ? k : { ...k, [id]: m !== null }));
      });
    }
    return () => {
      alive = false;
    };
  }, [ids, media]);
  return known;
}

function ReadyCard({ r, onJump }: { r: Readiness; onJump: (qid: string) => void }) {
  const blocks = r.problems.filter((p) => p.level === 'block').length;
  const warns = r.problems.length - blocks;
  const [open, setOpen] = useState(false);
  const phone = useMedia(PHONE_QUERY);
  const shown = open ? r.problems : r.problems.slice(0, phone ? 1 : 3);
  return (
    <Card className="ad-ready">
      <div className="ad-ready-top">
        <span className="ad-ready-big vx-chr">{Math.round(r.score * 100)}%</span>
        <span className="ad-ready-meta">
          готово к игре · {nQuestions(r.active)}
          {r.total !== r.active ? ` (+${r.total - r.active} выкл.)` : ''} · ~{fmtDuration(r.durationS)}
        </span>
      </div>
      <Meter value={r.score} tone={blocks ? 'hot' : 'film'} label="Готовность" />
      {r.problems.length ? (
        <>
          <p className="ad-hint" style={{ margin: 0 }}>
            {blocks ? `${blocks} ${plural(blocks, ['проблема', 'проблемы', 'проблем'])}` : ''}
            {blocks && warns ? ' · ' : ''}
            {warns ? `${warns} ${plural(warns, ['шаблон', 'шаблона', 'шаблонов'])} ещё не переделан${warns === 1 ? '' : 'о'}` : ''}
          </p>
          <ul className="ad-ready-list">
            {shown.map((p, k) => (
              <li key={`${p.qid}-${k}`}>
                <button type="button" onClick={() => p.qid && onJump(p.qid)} disabled={!p.qid}>
                  <Dot tone={p.level === 'block' ? 'bad' : 'warn'} />
                  <span>{p.text}</span>
                </button>
              </li>
            ))}
          </ul>
          {r.problems.length > shown.length || open ? (
            <button type="button" className="ad-link" style={{ fontSize: 12.5, alignSelf: 'flex-start' }} onClick={() => setOpen(!open)}>
              {open ? 'Свернуть' : `Показать все ${r.problems.length}`}
            </button>
          ) : null}
        </>
      ) : (
        <p className="ad-hint" style={{ margin: 0, color: 'var(--good)' }}>
          Всё готово — можно играть!
        </p>
      )}
    </Card>
  );
}

function Row({ q, n, active, level, onOpen }: { q: Question; n: number; active: boolean; level?: 'block' | 'warn'; onOpen: () => void }) {
  const row = useSortableRow(q.id);
  const opts = q.type === 'choice' ? q.options.length : q.type === 'ordering' ? q.items.length : null;
  return (
    <li
      ref={row.ref}
      style={row.style}
      className={cx('ad-qi', active && 'is-active', q.disabled && 'is-off', row.dragging && 'is-dragging')}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) onOpen();
      }}
      tabIndex={0}
      aria-current={active || undefined}
    >
      <button type="button" className="ad-qi-grip" aria-label={`Перетащить вопрос ${n}`} onClick={(e) => e.stopPropagation()} {...row.handle}>
        <Icon name="grip" size={18} />
      </button>
      <ChromeBlock shape="circle" className="ad-qi-n" liquid={false} film={q.double ? 1 : 0.3} tone={q.double ? 'film' : 'chrome'}>
        {n}
      </ChromeBlock>
      <div className="ad-qi-body">
        <span className={cx('ad-qi-title', !q.title.trim() && 'is-empty')}>{q.title.trim() || 'Новый вопрос без текста'}</span>
        <span className="ad-qi-meta">
          <span className="ad-qi-type">
            <Icon name={TYPE_UI[q.type].icon} size={12} />
            {TYPE_UI[q.type].label}
          </span>
          {opts ? `${opts} · ` : ''}
          {q.timeLimitS} с{q.double ? ' · ×2' : ''}
          {q.media ? <Icon name="image" size={13} /> : null}
          {q.disabled ? ' · выкл' : ''}
          {q.surprise?.on ? (
            <span className="ad-tag is-film ad-qi-sur" title={`Сюрприз-видео через ${q.surprise.afterS} с после вариантов`}>
              🎬 сюрприз
            </span>
          ) : null}
        </span>
      </div>
      <div className="ad-qi-side">{level ? <Dot tone={level === 'block' ? 'bad' : 'warn'} /> : <Icon name="chevronR" size={16} className="ad-muted" />}</div>
    </li>
  );
}

function TypePicker({ onPick }: { onPick: (t: QuestionType) => void }) {
  return (
    <div className="ad-typepick">
      {QUESTION_TYPES.map((t) => (
        <button key={t} type="button" onClick={() => onPick(t)}>
          <ChromeBlock shape="box" radius={13} className="ad-typepick-ico" liquid={false} film={t === 'choice' ? 0.9 : 0.4}>
            <Icon name={TYPE_UI[t].icon} size={20} />
          </ChromeBlock>
          {TYPE_UI[t].label}
          <span>{TYPE_HINT[t]}</span>
        </button>
      ))}
      <p className="ad-hint" style={{ gridColumn: '1 / -1', margin: 0 }}>
        Тип можно поменять потом — вверху редактора вопроса.
      </p>
    </div>
  );
}

export function QuestionsTab({ params }: { params: { id?: string } }) {
  const { content } = useAdmin();
  const c = useContent(content);
  const [, navigate] = useLocation();
  const wide = !useMedia(PHONE_QUERY);
  const [adding, setAdding] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const doc = c.doc;
  const questions = doc?.questions ?? [];
  const settings = useMemo(() => normalizeSettings(doc?.settings), [doc?.settings]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const exists = useMediaExists(questions);
  const ready = useMemo(() => readiness(questions, settings, (id) => exists[id]), [questions, settings, exists]);
  const selectedId = params.id ?? (wide ? questions[0]?.id : undefined);
  const index = questions.findIndex((q) => q.id === selectedId);
  const q = index >= 0 ? questions[index] : undefined;
  const open = (id: string) => navigate(`/questions/${id}`);
  // A switched-off question is left out of the meter, but its editor still says what is missing.
  const qProblems = useMemo(
    () => (!q ? [] : q.disabled ? readiness([{ ...q, disabled: false }], settings, (id) => exists[id]).problems : ready.problems.filter((p) => p.qid === q.id)),
    [q, ready, settings, exists],
  );

  const add = (type: QuestionType) => {
    const nq = newQuestion(type, settings.defaultTimeLimitS);
    content.edit((d) => void d.questions.push(nq), 0);
    setAdding(false);
    open(nq.id);
  };

  const remove = (qq: Question) => {
    const at = questions.findIndex((x) => x.id === qq.id);
    content.edit((d) => {
      d.questions = d.questions.filter((x) => x.id !== qq.id);
      d.trash = [...d.trash, { q: qq, at: Date.now() }].slice(-TRASH_KEEP);
    }, 0);
    const next = questions[at + 1] ?? questions[at - 1];
    navigate(next && wide ? `/questions/${next.id}` : '/questions');
    showUndo('Вопрос в корзине', () => {
      content.edit((d) => {
        d.trash = d.trash.filter((t) => t.q.id !== qq.id);
        if (!d.questions.some((x) => x.id === qq.id)) d.questions.splice(Math.min(at, d.questions.length), 0, qq);
      }, 0);
      open(qq.id);
    });
  };

  const duplicate = (qq: Question) => {
    const copy = duplicateQuestion(qq);
    content.edit((d) => {
      const at = d.questions.findIndex((x) => x.id === qq.id);
      d.questions.splice(at + 1, 0, copy);
    }, 0);
    open(copy.id);
    toast('Копия готова', { tone: 'good' });
  };

  const restore = (id: string) => {
    content.edit((d) => {
      const t = d.trash.find((x) => x.q.id === id);
      if (!t) return;
      d.trash = d.trash.filter((x) => x.q.id !== id);
      if (!d.questions.some((x) => x.id === id)) d.questions.push(t.q);
    }, 0);
    toast('Вопрос вернулся в конец списка', { tone: 'good' });
  };

  const trash = doc?.trash ?? [];

  return (
    <>
      <PageHead
        kicker={`${nQuestions(questions.length)} · ~${fmtDuration(ready.durationS)} шоу`}
        title="Вопросы"
        actions={
          <>
            {trash.length ? (
              <Btn tone="ghost" icon="trash" onClick={() => setTrashOpen(true)}>
                Корзина · {trash.length}
              </Btn>
            ) : null}
            <Btn tone="chrome" icon="plus" onClick={() => setAdding(true)}>
              Добавить вопрос
            </Btn>
            {questions.some((x) => !x.disabled) ? <RehearsalButton from={params.id ? `/questions/${params.id}` : '/questions'} /> : null}
          </>
        }
      />
      <div className={cx('ad-q-layout', params.id && 'is-editing')}>
        <div className="ad-q-listcol">
          <ReadyCard r={ready} onJump={open} />
          <div className="ad-q-scroll">
            {questions.length ? (
              <SortableList ids={questions.map((x) => x.id)} onMove={(a, b) => content.edit((d) => void (d.questions = moveItem(d.questions, a, b)), 0)}>
                <ul className="ad-qlist">
                  {questions.map((x, i) => (
                    <Row key={x.id} q={x} n={i + 1} active={x.id === selectedId} level={ready.byQid[x.id]} onOpen={() => open(x.id)} />
                  ))}
                </ul>
              </SortableList>
            ) : (
              <Card>
                <Empty icon="list" title="Пока ни одного вопроса" text="Начни с первого — это займёт минуту.">
                  <Btn tone="chrome" icon="plus" onClick={() => setAdding(true)}>
                    Добавить вопрос
                  </Btn>
                </Empty>
              </Card>
            )}
          </div>
        </div>
        <div className="ad-q-editcol">
          {q ? (
            <Editor
              key={q.id}
              q={q}
              index={index}
              settings={settings}
              problems={qProblems}
              isLast={!questions.slice(index + 1).some((x) => !x.disabled)}
              otherSurprises={questions.filter((x) => x.id !== q.id && !x.disabled && x.surprise?.on).length}
              onBack={() => navigate('/questions')}
              onDuplicate={() => duplicate(q)}
              onDelete={() => remove(q)}
              onPreview={() => setPreviewOpen(true)}
            />
          ) : params.id ? (
            <Card>
              <Empty icon="alert" title="Такого вопроса нет" text="Возможно, его удалили на другом устройстве.">
                <Btn onClick={() => navigate('/questions')}>К списку</Btn>
              </Empty>
            </Card>
          ) : null}
        </div>
        <div className="ad-preview-col">{q ? <Preview q={q} n={index + 1} total={ready.active || questions.length} settings={settings} width={312} /> : null}</div>
      </div>

      <Modal open={adding} onClose={() => setAdding(false)} title="Какой вопрос добавим?">
        <TypePicker onPick={add} />
      </Modal>
      <Modal open={previewOpen && !!q} onClose={() => setPreviewOpen(false)} title="Превью">
        {q ? <Preview q={q} n={index + 1} total={ready.active || questions.length} settings={settings} width={Math.min(330, innerWidth - 64)} /> : null}
      </Modal>
      <Modal open={trashOpen} onClose={() => setTrashOpen(false)} title="Корзина">
        <div className="ad-trash">
          {trash.length ? (
            [...trash].reverse().map((t) => (
              <div key={t.q.id} className="ad-trash-row">
                <Icon name={TYPE_UI[t.q.type].icon} size={16} />
                <span title={t.q.title}>{t.q.title || 'Без текста'}</span>
                <Btn size="s" icon="restore" onClick={() => restore(t.q.id)}>
                  Вернуть
                </Btn>
              </div>
            ))
          ) : (
            <p className="ad-hint">Пусто.</p>
          )}
          <p className="ad-hint">Хранятся последние {TRASH_KEEP} удалённых вопросов.</p>
        </div>
      </Modal>
    </>
  );
}
