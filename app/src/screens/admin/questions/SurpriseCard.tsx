// «Сюрприз-видео» of a question (shared/engine/surprise.ts): while its options are on screen — N
// seconds after they appear, before everyone has answered — the TV «breaks down», goes black for 2 s
// and plays a video (the built-in congratulations, or an upload); after it the right answer, and
// ~10 s later the final: the quiz is over. With a preview player of the built-in video.

import { SURPRISE } from '@shared/engine/surprise';
import type { QSurprise, Question } from '@shared/types';
import { useMediaMeta } from '../core/media';
import { Card, Chips, Field, NumInput, Toggle } from '../ui/kit';
import { Icon } from '../ui/icons';
import { MediaSlot } from './MediaSlot';
import '../settings/finale-card.css';

/** A file of the site next to the admin page (/vlados/surprise.mp4 on GitHub Pages). */
const siteFile = (file: string): string => new URL(file, document.baseURI).href;

const fmtLen = (ms: number): string => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** A fresh surprise for a question with this time limit (4 s, or less for a very short question). */
export const newSurprise = (timeLimitS: number): QSurprise => ({ on: true, src: 'builtin', afterS: Math.max(SURPRISE.afterMinS, Math.min(SURPRISE.afterDefaultS, timeLimitS - 1)) });

export function SurpriseCard({
  q,
  patch,
  isLast,
  others,
}: {
  q: Question;
  patch: (fn: (q: Question) => Question | void, delayMs?: number) => void;
  /** It is the last enabled question (after the surprise the quiz ends). */
  isLast: boolean;
  /** How many other enabled questions have a surprise switched on. */
  others: number;
}) {
  const s = q.surprise;
  const on = s?.on === true;
  const meta = useMediaMeta(on && s?.src === 'custom' ? s.mediaId : undefined);
  const noFile = on && s?.src === 'custom' && (!s.mediaId || meta === null || (meta !== undefined && meta.kind !== 'video'));
  const set = (fn: (x: QSurprise) => void, delay?: number) =>
    patch((x) => {
      const cur = x.surprise ?? newSurprise(x.timeLimitS);
      fn(cur);
      x.surprise = cur;
    }, delay);
  const tooLate = on && s !== undefined && s.afterS >= q.timeLimitS;
  return (
    <Card id="q-surprise" kicker="Во время вопроса" title="Сюрприз-видео" icon="video" className="ad-surprise-card" tone={on ? 'accent' : undefined}>
      <div className="ad-stack">
        <Toggle
          label="Прервать этот вопрос видео"
          hint="Для последнего вопроса: гости выбирают ответ — и вдруг эфир «ломается»."
          checked={on}
          onChange={(v) => set((x) => void (x.on = v), 0)}
        />
        {on && s ? (
          <>
            <p className="ad-help">
              Когда варианты уже на экране — через <b>{s.afterS} с</b> после их появления, пока ответили не все — на ТВ <b>«сбой эфира»</b>: картинка ломается и гаснет,
              2 секунды <b>чёрный экран</b>, потом <b>видео со звуком</b> на весь экран. Телефоны тоже «сбоят», потом «Смотри на экран». Засчитываются ответы, отправленные до
              сбоя. Когда видео закончится — <b>правильный ответ</b>, и через 10 секунд <b>финал</b>: после видео игра заканчивается.
            </p>
            <Field
              label="Через сколько секунд после появления вариантов"
              hint={`От ${SURPRISE.afterMinS} с и меньше времени на ответ (${q.timeLimitS} с)`}
              error={tooLate ? `Должно быть меньше ${q.timeLimitS} с — иначе время на ответ кончится раньше` : null}
            >
              <NumInput value={s.afterS} integer min={SURPRISE.afterMinS} max={Math.max(SURPRISE.afterMinS, q.timeLimitS - 1)} suffix="с" onChange={(v) => v !== undefined && set((x) => void (x.afterS = v))} />
            </Field>
            <Field label="Какое видео">
              <Chips<QSurprise['src']>
                label="Какое видео"
                value={s.src}
                onChange={(v) => set((x) => void (x.src = v), 0)}
                options={[
                  { value: 'builtin', label: 'Встроенное (поздравления)', icon: 'video' },
                  { value: 'custom', label: 'Своё видео', icon: 'upload' },
                ]}
              />
            </Field>
            {s.src === 'builtin' ? (
              <div className="ad-finale-prev">
                <video
                  className="ad-finale-video"
                  src={siteFile(SURPRISE.builtin.file)}
                  poster={siteFile(SURPRISE.builtin.poster)}
                  controls
                  playsInline
                  preload="none"
                  style={{ aspectRatio: `${SURPRISE.builtin.w} / ${SURPRISE.builtin.h}` }}
                />
                <p className="ad-hint">
                  Вертикальное, {fmtLen(SURPRISE.builtin.ms)}, со своим звуком. Лежит на сайте вместе с игрой — экран ТВ целиком загружает его в память заранее (видно на экране «Начать
                  шоу»), так что в момент сюрприза интернет ему не нужен.
                </p>
              </div>
            ) : (
              <>
                <MediaSlot
                  className="ad-finale-slot"
                  accept="video"
                  title="Видео-сюрприз"
                  hint="Перетащи сюда или выбери видео. Сожмётся до 720p прямо в браузере; играет на ТВ со своим звуком."
                  mediaId={s.mediaId}
                  onChange={(m) => set((x) => (m ? void (x.mediaId = m.id) : void delete x.mediaId), 0)}
                />
                {noFile ? (
                  <p className="ad-hint ad-row" style={{ gap: 8, alignItems: 'flex-start' }}>
                    <Icon name="alert" size={16} />
                    <span>Пока своего видео нет — покажем встроенное.</span>
                  </p>
                ) : null}
              </>
            )}
            {!isLast ? (
              <p className="ad-need">
                <Icon name="alert" size={14} />
                После сюрприза игра заканчивается — вопросы после этого не покажутся. Поставь его последним.
              </p>
            ) : null}
            {others > 0 ? (
              <p className="ad-need">
                <Icon name="alert" size={14} />
                Сюрприз включён ещё у {others === 1 ? 'одного вопроса' : `${others} вопросов`} — игра закончится после первого из них.
              </p>
            ) : null}
            <p className="ad-hint">Досмотреть раньше — «Досмотрели — к ответу» в «Эфире» или пробел на ТВ. Прогнать всё со звуком — «Прогнать игру».</p>
          </>
        ) : null}
      </div>
    </Card>
  );
}
