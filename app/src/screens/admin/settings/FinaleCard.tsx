// «Видео после финала»: which video the TV plays after the winners and the selfie mosaic (final
// step 6, shared/engine/finale.ts) — the built-in clip from the party folder (default), an uploaded
// one (the normal media upload → Settings.finaleMediaId), or none. With a preview player.

import { FINALE } from '@shared/engine/finale';
import type { FinaleMode, Settings } from '@shared/types';
import { useMediaMeta } from '../core/media';
import { MediaSlot } from '../questions/MediaSlot';
import { Card, Chips, Field } from '../ui/kit';
import { Icon } from '../ui/icons';
import './finale-card.css';

/** A file of the site next to the admin page (/vlados/finale.mp4 on GitHub Pages). */
const siteFile = (file: string): string => new URL(file, document.baseURI).href;

export function FinaleCard({ s, set }: { s: Settings; set: (fn: (s: Settings) => void, delay?: number) => void }) {
  const mode: FinaleMode = s.finaleVideo ?? 'builtin';
  const meta = useMediaMeta(mode === 'custom' ? s.finaleMediaId : undefined);
  const noFile = mode === 'custom' && (!s.finaleMediaId || meta === null || (meta !== undefined && meta.kind !== 'video'));
  return (
    <Card id="set-finale" kicker="В самом конце" title="Видео после финала" icon="video">
      <div className="ad-stack">
        <p className="ad-help">
          После подиума, «{s.vladosLabel} против друзей» и мозаики с «С днём рождения!» видео начинается <b>само через 5 секунд</b> (раньше — кнопка <b>«▶ Финальное видео»</b> в «Эфире» или пробел на ТВ). Мозаика собирается в каплю, из неё
          раскрывается видео на весь экран и играет <b>со своим звуком</b>, музыка игры затихает. На телефонах — «Смотри на экран». После видео мозаика и поздравление возвращаются с конфетти.
        </p>
        <Field label="Что показать">
          <Chips<FinaleMode>
            label="Видео после финала"
            value={mode}
            onChange={(v) => set((x) => void (x.finaleVideo = v), 0)}
            options={[
              { value: 'builtin', label: 'Встроенное (с праздника)', icon: 'video' },
              { value: 'custom', label: 'Своё видео', icon: 'upload' },
              { value: 'off', label: 'Не показывать', icon: 'x' },
            ]}
          />
        </Field>
        {mode === 'builtin' ? (
          <div className="ad-finale-prev">
            <video className="ad-finale-video" src={siteFile(FINALE.builtin.file)} poster={siteFile(FINALE.builtin.poster)} controls playsInline preload="metadata" style={{ aspectRatio: `${FINALE.builtin.w} / ${FINALE.builtin.h}` }} />
            <p className="ad-hint">
              Вертикальное, {Math.round(FINALE.builtin.ms / 1000)} с, со своей музыкой. Лежит на сайте вместе с игрой — экран ТВ загружает его при «Начать шоу», так что в конце вечера интернет ему не
              нужен.
            </p>
          </div>
        ) : mode === 'custom' ? (
          <>
            <MediaSlot
              className="ad-finale-slot"
              accept="video"
              title="Видео после финала"
              hint="Перетащи сюда или выбери видео. Сожмётся до 720p прямо в браузере; играет на ТВ со своим звуком."
              mediaId={s.finaleMediaId}
              onChange={(m) => set((x) => (m ? void (x.finaleMediaId = m.id) : void delete x.finaleMediaId), 0)}
            />
            {noFile ? (
              <p className="ad-hint ad-row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <Icon name="alert" size={16} />
                <span>Пока своего видео нет — в конце покажем встроенное.</span>
              </p>
            ) : null}
          </>
        ) : (
          <p className="ad-hint">Финал закончится мозаикой и «С днём рождения!» — без видео.</p>
        )}
      </div>
    </Card>
  );
}
