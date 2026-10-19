// Editor of one question. Every change autosaves (debounced) — the «Сохранено» chip in the frame
// shows when it reached the server.

import { numberAccuracy } from '@shared/scoring';
import type { ChoiceQ, Item, NumberQ, OrderingQ, QMedia, Question, QuestionType, Settings } from '@shared/types';
import { useRef, useState } from 'react';
import { ChromeBlock, cx } from '../../../visual';
import { fmtNum, KEYS, TYPE_HINT } from '../core/format';
import type { UploadedMedia } from '../core/media';
import type { Problem } from '../core/readiness';
import { useAdmin } from '../core/session';
import { Btn, Card, Chips, Field, IconBtn, NumInput, showUndo, TextArea, TextInput, Toggle } from '../ui/kit';
import { Icon } from '../ui/icons';
import { SortableList, moveItem, useSortableRow } from '../ui/sortable';
import { ItemImage, MediaSlot, PhonesMode } from './MediaSlot';
import { SurpriseCard } from './SurpriseCard';
import { TIME_CHIPS, TYPE_UI, canAddItem, canAddOption, canRemoveItem, canRemoveOption, convertQuestion, newItem, remember, suggestZeroAt, type TypeMemory } from './model';
import { TypeSwitch } from './TypeSwitch';

/** Undo-bar text after a type switch. */
function switchText(to: QuestionType, dropped: string[], note: string | undefined): string {
  if (dropped.length) return `Тип изменён — убрано: ${dropped.join(', ')}`;
  return note ?? `Тип: «${TYPE_UI[to].label}»`;
}

type Patch = (fn: (q: Question) => Question | void, delayMs?: number) => void;

const toQMedia = (m: UploadedMedia | null, prev: QMedia | undefined): QMedia | undefined =>
  m ? { mediaId: m.id, onPhones: m.kind === 'image' ? (prev?.onPhones ?? true) : false } : undefined;

// ---------------------------------------------------------------- choice

function ChoiceEditor({ q, patch }: { q: ChoiceQ; patch: Patch }) {
  const set = (fn: (q: ChoiceQ) => void, delay?: number) => patch((x) => void (x.type === 'choice' && fn(x)), delay);
  const needCorrect = !q.options.some((o) => o.id === q.correctId);
  return (
    <Card kicker="Ответы" title="Варианты ответа" icon="choice">
      <div className={cx('ad-opts', needCorrect && 'is-need')}>
        {q.options.map((o, i) => {
          const correct = o.id === q.correctId;
          return (
            <div key={o.id} className={cx('ad-opt', correct && 'is-correct')}>
              <ChromeBlock shape="circle" className="ad-opt-key" liquid={false} film={correct ? 1 : 0.3} tone={correct ? 'film' : 'chrome'}>
                {KEYS[i]}
              </ChromeBlock>
              <TextInput
                value={o.text ?? ''}
                maxLength={140}
                placeholder={o.mediaId ? 'Подпись (можно без неё)' : `Вариант ${KEYS[i]}`}
                aria-label={`Вариант ${KEYS[i]}`}
                onChange={(t) =>
                  set((x) => {
                    const it = x.options[i];
                    if (it) it.text = t;
                  })
                }
              />
              <ItemImage
                mediaId={o.mediaId}
                onChange={(id) =>
                  set((x) => {
                    const it = x.options[i];
                    if (!it) return;
                    if (id) it.mediaId = id;
                    else delete it.mediaId;
                  }, 0)
                }
              />
              <button type="button" className={cx('ad-correct', correct && 'is-on')} aria-pressed={correct} onClick={() => set((x) => void (x.correctId = o.id), 0)}>
                <i>{correct ? <Icon name="check" size={13} /> : null}</i>
                <span>{correct ? 'Верный' : 'Верный?'}</span>
              </button>
              <IconBtn
                icon="trash"
                label="Удалить вариант"
                tone="danger"
                size="s"
                disabled={!canRemoveOption(q)}
                onClick={() =>
                  set((x) => {
                    x.options.splice(i, 1);
                    if (x.correctId === o.id) x.correctId = '';
                  }, 0)
                }
              />
            </div>
          );
        })}
      </div>
      <div className="ad-row" style={{ marginTop: 12 }}>
        <Btn size="s" icon="plus" disabled={!canAddOption(q)} onClick={() => set((x) => void x.options.push(newItem()), 0)}>
          Добавить вариант
        </Btn>
        {needCorrect ? (
          <span className="ad-need">
            <Icon name="alert" size={14} />
            Отметь верный — «Верный?» у нужного варианта
          </span>
        ) : (
          <span className="ad-hint">От 2 до 6. Картинка вместо текста — тоже можно.</span>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- number

function Curve({ q, settings }: { q: NumberQ; settings: Settings }) {
  const sc = settings.scoring;
  const base = sc.base * (q.double ? 2 : 1);
  const W = 320;
  const H = 120;
  const pad = { l: 34, r: 8, t: 10, b: 20 };
  const span = Math.max(q.zeroAt * 1.25, q.step * 4, 1);
  const N = 64;
  const pts: [number, number][] = [];
  for (let k = 0; k <= N; k++) {
    const err = (k / N) * span;
    const acc = numberAccuracy(q, q.answer + err, sc.number.curve);
    pts.push([err, Math.round(base * sc.number.accuracyShare * acc)]);
  }
  const maxY = base * sc.number.accuracyShare || 1;
  const x = (e: number) => pad.l + (e / span) * (W - pad.l - pad.r);
  const y = (p: number) => pad.t + (1 - p / maxY) * (H - pad.t - pad.b);
  const line = pts.map(([e, p], k) => `${k ? 'L' : 'M'}${x(e).toFixed(1)},${y(p).toFixed(1)}`).join(' ');
  const area = `${line} L${x(span)},${y(0)} L${x(0)},${y(0)} Z`;
  const u = q.unit ? ` ${q.unit}` : '';
  const sample = (err: number) => Math.round(base * sc.number.accuracyShare * numberAccuracy(q, q.answer + err, sc.number.curve));
  const mid = q.tolerance + (q.zeroAt - q.tolerance) / 2;
  return (
    <div>
      <svg className="ad-curve" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Очки за точность в зависимости от ошибки">
        <defs>
          <linearGradient id="ad-curve-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity="0.35" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line className="grid" x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} />
        <line className="grid" x1={pad.l} x2={W - pad.r} y1={y(maxY)} y2={y(maxY)} />
        <path className="area" d={area} />
        <path className="line" d={line} />
        {q.tolerance > 0 ? <line className="mark" x1={x(q.tolerance)} x2={x(q.tolerance)} y1={pad.t} y2={y(0)} /> : null}
        <line className="mark" x1={x(q.zeroAt)} x2={x(q.zeroAt)} y1={pad.t} y2={y(0)} />
        <text className="axis" x={2} y={y(maxY) + 4}>
          {Math.round(maxY)}
        </text>
        <text className="axis" x={2} y={y(0)}>
          0
        </text>
        <text className="axis" x={pad.l} y={H - 4}>
          точно
        </text>
        <text className="axis" x={x(q.zeroAt)} y={H - 4} textAnchor="middle">
          ±{fmtNum(q.zeroAt)}
        </text>
      </svg>
      <p className="ad-hint">
        Ошибся на {fmtNum(q.tolerance || 0)}
        {u} — {sample(q.tolerance)} очк. · на {fmtNum(Math.round(mid * 100) / 100)}
        {u} — {sample(mid)} · на {fmtNum(q.zeroAt)}
        {u} и больше — 0. Плюс {Math.round(sc.base * sc.number.closestShare * (q.double ? 2 : 1))} тому, кто ближе всех, и чуть меньше за медленный ответ.
      </p>
    </div>
  );
}

function NumberEditor({ q, patch, settings, askAnswer, onAnswer }: { q: NumberQ; patch: Patch; settings: Settings; askAnswer: boolean; onAnswer: () => void }) {
  const set = (fn: (q: NumberQ) => void) => patch((x) => void (x.type === 'number' && fn(x)));
  const rangeBad = q.min !== undefined && q.max !== undefined && q.min >= q.max;
  const outOfRange = (q.min !== undefined && q.answer < q.min) || (q.max !== undefined && q.answer > q.max);
  return (
    <Card kicker="Ответ" title="Правильное число" icon="number">
      <div className="ad-grid-2n">
        <Field label="Правильный ответ" error={askAnswer ? 'Впиши правильное число' : outOfRange ? 'Ответ вне диапазона' : null}>
          <NumInput
            value={q.answer}
            onChange={(v) => {
              if (v === undefined) return;
              onAnswer();
              set((x) => void (x.answer = v));
            }}
            ariaLabel="Правильный ответ"
          />
        </Field>
        <Field label="Единица" hint="«лет», «см» — можно пусто">
          <TextInput value={q.unit ?? ''} maxLength={20} placeholder="—" onChange={(t) => set((x) => (t ? (x.unit = t) : delete x.unit))} />
        </Field>
        <Field label="Минимум" hint="Для ползунка на телефоне" error={rangeBad ? 'Минимум ≥ максимума' : null}>
          <NumInput value={q.min} optional placeholder="нет" onChange={(v) => set((x) => (v === undefined ? delete x.min : (x.min = v)))} />
        </Field>
        <Field label="Максимум">
          <NumInput value={q.max} optional placeholder="нет" onChange={(v) => set((x) => (v === undefined ? delete x.max : (x.max = v)))} />
        </Field>
        <Field label="Допуск (полные очки)" hint="Ошибка в пределах — как точный ответ">
          <NumInput value={q.tolerance} min={0} onChange={(v) => v !== undefined && set((x) => void (x.tolerance = v))} />
        </Field>
        <Field
          label="Ноль очков при ошибке"
          error={q.zeroAt <= q.tolerance ? 'Должно быть больше допуска' : null}
          aside={
            <button type="button" className="ad-link" style={{ fontSize: 12 }} onClick={() => set((x) => void (x.zeroAt = suggestZeroAt(x)))}>
              подобрать
            </button>
          }
        >
          <NumInput value={q.zeroAt} min={0} onChange={(v) => v !== undefined && set((x) => void (x.zeroAt = v))} />
        </Field>
        <Field label="Шаг" hint="1 — целые, 0,5 — половинки">
          <NumInput value={q.step} min={0.000001} onChange={(v) => v !== undefined && v > 0 && set((x) => void (x.step = v))} />
        </Field>
      </div>
      <hr className="ad-sep" />
      <Curve q={q} settings={settings} />
    </Card>
  );
}

// ---------------------------------------------------------------- ordering

function OrderRow({ it, i, q, set }: { it: Item; i: number; q: OrderingQ; set: (fn: (q: OrderingQ) => void, delay?: number) => void }) {
  const row = useSortableRow(it.id);
  return (
    <div ref={row.ref} style={row.style} className={cx('ad-item', row.dragging && 'is-dragging')}>
      <button type="button" className="ad-qi-grip" aria-label={`Перетащить пункт ${i + 1}`} {...row.handle}>
        <Icon name="grip" size={18} />
      </button>
      <span className="ad-item-n">{i + 1}</span>
      <TextInput
        value={it.text ?? ''}
        maxLength={140}
        placeholder={i === 0 ? `Самое «${q.firstLabel || 'первое'}»` : i === q.items.length - 1 ? `Самое «${q.lastLabel || 'последнее'}»` : `Пункт ${i + 1}`}
        onChange={(t) =>
          set((x) => {
            const y = x.items[i];
            if (y) y.text = t;
          })
        }
      />
      <ItemImage
        mediaId={it.mediaId}
        onChange={(id) =>
          set((x) => {
            const y = x.items[i];
            if (!y) return;
            if (id) y.mediaId = id;
            else delete y.mediaId;
          }, 0)
        }
      />
      <IconBtn icon="trash" label="Удалить пункт" tone="danger" size="s" disabled={!canRemoveItem(q)} onClick={() => set((x) => void x.items.splice(i, 1), 0)} />
    </div>
  );
}

function OrderingEditor({ q, patch }: { q: OrderingQ; patch: Patch }) {
  const set = (fn: (q: OrderingQ) => void, delay?: number) => patch((x) => void (x.type === 'ordering' && fn(x)), delay);
  return (
    <Card kicker="Ответ" title="Пункты — в правильном порядке" icon="order">
      <p className="ad-hint" style={{ marginTop: -6, marginBottom: 12 }}>
        Пиши сверху вниз, как должно быть. Гостям пункты покажутся перемешанными. Перетаскивай за ⠿.
      </p>
      <div className="ad-grid-2" style={{ marginBottom: 12 }}>
        <Field label="Подпись сверху">
          <TextInput value={q.firstLabel} maxLength={40} placeholder="Раньше" onChange={(t) => set((x) => void (x.firstLabel = t))} />
        </Field>
        <Field label="Подпись снизу">
          <TextInput value={q.lastLabel} maxLength={40} placeholder="Позже" onChange={(t) => set((x) => void (x.lastLabel = t))} />
        </Field>
      </div>
      <SortableList ids={q.items.map((it) => it.id)} onMove={(a, b) => set((x) => void (x.items = moveItem(x.items, a, b)), 0)}>
        <div className="ad-items">
          {q.items.map((it, i) => (
            <OrderRow key={it.id} it={it} i={i} q={q} set={set} />
          ))}
        </div>
      </SortableList>
      <div className="ad-row" style={{ marginTop: 12 }}>
        <Btn size="s" icon="plus" disabled={!canAddItem(q)} onClick={() => set((x) => void x.items.push(newItem()), 0)}>
          Добавить пункт
        </Btn>
        {q.items.filter((it) => it.text?.trim() || it.mediaId).length < 3 ? (
          <span className="ad-need">
            <Icon name="alert" size={14} />
            Заполни хотя бы 3 пункта
          </span>
        ) : (
          <span className="ad-hint">От 3 до 6.</span>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- the editor

export function Editor({
  q,
  index,
  settings,
  problems,
  isLast = true,
  otherSurprises = 0,
  onBack,
  onDuplicate,
  onDelete,
  onPreview,
}: {
  q: Question;
  index: number;
  settings: Settings;
  problems: Problem[];
  /** The last enabled question (a surprise ends the quiz). */
  isLast?: boolean;
  /** Other enabled questions with a surprise on. */
  otherSurprises?: number;
  onBack: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onPreview: () => void;
}) {
  const { content } = useAdmin();
  const patch: Patch = (fn, delay) => content.updateQuestion(q.id, fn, delay);
  const [customTime, setCustomTime] = useState(!TIME_CHIPS.includes(q.timeLimitS as (typeof TIME_CHIPS)[number]));
  const isChip = TIME_CHIPS.includes(q.timeLimitS as (typeof TIME_CHIPS)[number]);
  // Versions of this question in the other types (this session): switching back restores them.
  const memory = useRef<TypeMemory>({});
  // After a switch to «Угадай число» with nothing to take the number from: 0 is a placeholder.
  const [askAnswer, setAskAnswer] = useState(false);

  const switchType = (to: QuestionType) => {
    if (to === q.type) return;
    const prev = structuredClone(q);
    memory.current = remember(memory.current, prev);
    const r = convertQuestion(prev, to, memory.current);
    patch(() => r.q, 0);
    setAskAnswer(r.needsAnswer);
    showUndo(switchText(to, r.dropped, r.note), () => {
      patch(() => prev, 0);
      setAskAnswer(false);
    });
  };
  const shown: Problem[] = askAnswer && q.type === 'number' ? [{ qid: q.id, level: 'block', text: 'Впиши правильное число — сейчас там 0' }, ...problems] : problems;

  return (
    <div className="ad-editor">
      <div className="ad-editor-bar">
        <IconBtn icon="chevronL" label="К списку" onClick={onBack} className="ad-only-phone" />
        <span className="vx-kick">Вопрос {index + 1}</span>
        {q.disabled ? <span className="ad-tag is-hot">выключен</span> : null}
        <span className="ad-spacer" />
        <IconBtn size="s" icon="phone" label="Превью: как увидят гости" onClick={onPreview} className="ad-only-narrow" />
        <IconBtn size="s" icon={q.disabled ? 'eye' : 'eyeOff'} label={q.disabled ? 'Включить в игру' : 'Выключить (не показывать в игре)'} onClick={() => patch((x) => (x.disabled ? void delete x.disabled : void (x.disabled = true)), 0)} />
        <IconBtn size="s" icon="copy" label="Дублировать" onClick={onDuplicate} />
        <IconBtn size="s" icon="trash" label="Удалить (в корзину)" tone="danger" onClick={onDelete} />
      </div>

      <TypeSwitch value={q.type} onChange={switchType} />

      {shown.length ? (
        <div className="ad-help ad-editor-problems" role="status">
          {shown.map((p) => (
            <div key={p.text}>
              <Icon name="alert" size={15} />
              {p.text}
            </div>
          ))}
        </div>
      ) : null}

      <Card kicker={TYPE_HINT[q.type]} title="Вопрос" icon="text">
        <div className="ad-stack">
          <Field label="Текст вопроса" hint={`${q.title.length}/300 · видят все: на ТВ и в телефонах`}>
            <TextArea className="ad-title-input" value={q.title} maxLength={300} minRows={2} placeholder="Например: Какое блюдо Владос закажет в любом ресторане?" onChange={(t) => patch((x) => void (x.title = t))} />
          </Field>
          <Field label="Заметка для ведущего" hint="Гостям не видно — подсказка себе: что рассказать после ответа.">
            <TextArea value={q.notes ?? ''} maxLength={4000} minRows={1} placeholder="Например: рассказать историю про шаурму в Сочи" onChange={(t) => patch((x) => (t ? void (x.notes = t) : void delete x.notes))} />
          </Field>
        </div>
      </Card>

      <Card kicker="Картинка или видео" title="Медиа" icon="image">
        <MediaSlot
          pasteTarget
          mediaId={q.media?.mediaId}
          onChange={(m) =>
            patch((x) => {
              const next = toQMedia(m, x.media);
              if (next) x.media = next;
              else delete x.media;
            }, 0)
          }
        />
        {q.media ? <PhonesMode mediaId={q.media.mediaId} onPhones={q.media.onPhones} onChange={(v) => patch((x) => void (x.media && (x.media.onPhones = v)), 0)} /> : null}
      </Card>

      <div key={q.type} className="ad-qt-swap">
        {q.type === 'choice' ? <ChoiceEditor q={q} patch={patch} /> : null}
        {q.type === 'number' ? <NumberEditor q={q} patch={patch} settings={settings} askAnswer={askAnswer} onAnswer={() => setAskAnswer(false)} /> : null}
        {q.type === 'ordering' ? <OrderingEditor q={q} patch={patch} /> : null}
      </div>

      <Card kicker="Таймер и очки" title="Сколько думать" icon="clock">
        <div className="ad-stack">
          <Chips
            label="Время на ответ"
            value={customTime ? -1 : isChip ? q.timeLimitS : -1}
            onChange={(v) => {
              if (v === -1) setCustomTime(true);
              else {
                setCustomTime(false);
                patch((x) => void (x.timeLimitS = v), 0);
              }
            }}
            options={[...TIME_CHIPS.map((s) => ({ value: s as number, label: `${s} с` })), { value: -1, label: 'Своё' }]}
          />
          {customTime ? (
            <Field label="Своё время, секунд" hint="От 5 до 600">
              <NumInput value={q.timeLimitS} integer min={5} max={600} suffix="с" onChange={(v) => v !== undefined && patch((x) => void (x.timeLimitS = v))} />
            </Field>
          ) : null}
          <Toggle label="Двойные очки ×2" hint="Для финального или самого сложного вопроса." checked={q.double} onChange={(v) => patch((x) => void (x.double = v), 0)} />
        </div>
      </Card>

      <SurpriseCard q={q} patch={patch} isLast={isLast} others={otherSurprises} />

      <Card kicker="После ответа" title="Раскрытие" icon="sparkle">
        <div className="ad-stack">
          <Field label="Текст после ответа" hint="Появится вместе с правильным ответом: шутка, история, факт.">
            <TextArea value={q.revealText ?? ''} maxLength={1000} minRows={2} placeholder="Например: Конечно, шаурма! Проверено годами." onChange={(t) => patch((x) => (t ? void (x.revealText = t) : void delete x.revealText))} />
          </Field>
          <MediaSlot
            title="Фото или видео для ответа"
            hint="Необязательно: например, настоящее фото маленького Владоса."
            mediaId={q.revealMedia?.mediaId}
            onChange={(m) =>
              patch((x) => {
                const next = toQMedia(m, x.revealMedia);
                if (next) x.revealMedia = { ...next, onPhones: m?.kind === 'image' };
                else delete x.revealMedia;
              }, 0)
            }
          />
        </div>
      </Card>
    </div>
  );
}
