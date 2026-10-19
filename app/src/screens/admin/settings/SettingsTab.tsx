// «Настройки»: the game's title and date, lobby photo, every text guests see, timings, scoring
// (in plain words), sound, reactions, late join, the TV look, co-organizers and this account.

import { DEFAULT_SCORING, TEXT_KEYS, TEXT_KEY_LIST } from '@shared/defaults';
import { autopilotOn } from '@shared/engine/showTimings';
import { FB_LIMITS } from '@shared/fbtypes';
import type { Settings, TextKey } from '@shared/types';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { normalizeEmail } from '../../../fb/auth';
import { normalizeSettings } from '../../../host/pure';
import { ModeToggle, toast } from '../../../visual';
import { useContent } from '../core/content';
import { fmtMskDate, fmtUntil, isoToMskInput, mskInputToIso } from '../core/format';
import { useAdmin } from '../core/session';
import { MediaSlot } from '../questions/MediaSlot';
import { AutopilotCard } from './AutopilotCard';
import { FinaleCard } from './FinaleCard';
import { Btn, Card, Chips, Field, IconBtn, PageHead, TextInput, Toggle } from '../ui/kit';
import { Icon, type IconName } from '../ui/icons';

const SECTIONS: { id: string; label: string; icon: IconName }[] = [
  { id: 'set-game', label: 'Игра', icon: 'star' },
  { id: 'set-auto', label: 'Автопилот', icon: 'bolt' },
  { id: 'set-texts', label: 'Тексты', icon: 'text' },
  { id: 'set-time', label: 'Время', icon: 'clock' },
  { id: 'set-score', label: 'Очки', icon: 'trophy' },
  { id: 'set-guests', label: 'Звук и гости', icon: 'sound' },
  { id: 'set-tv', label: 'Экран ТВ', icon: 'tv' },
  { id: 'set-finale', label: 'Видео в конце', icon: 'video' },
  { id: 'set-admins', label: 'Организаторы', icon: 'users' },
  { id: 'set-me', label: 'Аккаунт', icon: 'lock' },
];

const GROUPS: { id: 'phone' | 'tv' | 'final' | 'system'; label: string }[] = [
  { id: 'phone', label: 'На телефонах гостей' },
  { id: 'tv', label: 'На большом экране' },
  { id: 'final', label: 'Финал' },
  { id: 'system', label: 'Служебные' },
];

function Range({
  label,
  help,
  value,
  min,
  max,
  step,
  fmt,
  onChange,
}: {
  label: string;
  help: ReactNode;
  value: number;
  min: number;
  max: number;
  step: number;
  fmt: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <Field label={label} hint={help}>
      <div className="ad-range">
        <input type="range" min={min} max={max} step={step} value={value} aria-label={label} onChange={(e) => onChange(Number(e.currentTarget.value))} />
        <output>{fmt(value)}</output>
      </div>
    </Field>
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const secs = (v: number) => `${Math.round(v * 10) / 10} с`;

/** «Вручную» or N seconds. */
function AutoChips({ value, options, onChange, label }: { value: number | null; options: number[]; onChange: (v: number | null) => void; label: string }) {
  return (
    <Chips
      size="s"
      label={label}
      value={value ?? 0}
      onChange={(v) => onChange(v === 0 ? null : v)}
      options={[{ value: 0, label: 'Вручную' }, ...options.map((s) => ({ value: s, label: `через ${s} с` }))]}
    />
  );
}

function Admins() {
  const { backend, user } = useAdmin();
  const [emails, setEmails] = useState<string[] | null>(null);
  const [add, setAdd] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    backend.getAdmins().then(setEmails, () => setEmails([]));
  }, [backend]);
  const save = async (next: string[]) => {
    setBusy(true);
    try {
      await backend.setAdmins(next);
      setEmails(next);
      toast('Список организаторов обновлён', { tone: 'good' });
    } catch {
      toast('Не получилось сохранить — проверь интернет', { tone: 'bad' });
    } finally {
      setBusy(false);
    }
  };
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(add.trim());
  return (
    <Card id="set-admins" kicker="Доступ к пульту" title="Организаторы" icon="users">
      <p className="ad-help">
        Второй организатор (например, соведущий) создаёт вход на этой же странице со своей почтой и подтверждает её по ссылке из письма. Главный организатор входит всегда.
      </p>
      <div className="ad-emails" style={{ marginTop: 12 }}>
        <div className="ad-email">
          <Icon name="crown" size={15} />
          <span>{user.email}</span>
          <span className="ad-tag">это ты</span>
        </div>
        {(emails ?? []).filter((e) => e !== user.email).map((e) => (
          <div key={e} className="ad-email">
            <Icon name="mail" size={15} />
            <span>{e}</span>
            <IconBtn icon="x" label={`Убрать ${e}`} tone="danger" size="s" disabled={busy} onClick={() => void save((emails ?? []).filter((x) => x !== e))} />
          </div>
        ))}
      </div>
      <form
        className="ad-row"
        style={{ marginTop: 12, flexWrap: 'nowrap' }}
        onSubmit={(e) => {
          e.preventDefault();
          const em = normalizeEmail(add);
          if (!valid || !emails) return;
          if (emails.includes(em)) return toast('Этот адрес уже в списке');
          if (emails.length >= FB_LIMITS.adminEmailsMax) return toast('Слишком много организаторов', { tone: 'bad' });
          void save([...emails, em]).then(() => setAdd(''));
        }}
      >
        <TextInput value={add} onChange={setAdd} type="email" inputMode="email" placeholder="почта соорганизатора" icon="mail" className="ad-grow" />
        <Btn type="submit" tone="chrome" icon="plus" disabled={!valid || busy || emails === null}>
          Добавить
        </Btn>
      </form>
    </Card>
  );
}

export function SettingsTab() {
  const { content, backend, user } = useAdmin();
  const c = useContent(content);
  const s = useMemo(() => normalizeSettings(c.doc?.settings), [c.doc?.settings]);
  const set = (fn: (s: Settings) => void, delay?: number) => content.updateSettings(fn, delay);
  const [dateRaw, setDateRaw] = useState(() => isoToMskInput(s.gameStartsAt));
  const startMs = Date.parse(s.gameStartsAt);
  const textCount = TEXT_KEY_LIST.filter((k) => s.texts[k]?.trim()).length;

  return (
    <>
      <PageHead kicker="Всё, что видят гости" title="Настройки" sub="Каждое изменение сохраняется само и через несколько секунд появляется у гостей и на экране." />
      <div className="ad-set">
        <nav className="ad-set-nav" aria-label="Разделы настроек">
          {SECTIONS.map((x) => (
            <a
              key={x.id}
              href={`#${x.id}`}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(x.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
            >
              <Icon name={x.icon} size={16} />
              {x.label}
            </a>
          ))}
        </nav>
        <div>
          <Card id="set-game" kicker="Главное" title="Игра" icon="star">
            <div className="ad-stack">
              <div className="ad-grid-2">
                <Field label="Название игры" hint="Крупно в лобби и на телефонах">
                  <TextInput value={s.title} maxLength={80} placeholder="Кто лучше знает Владоса" onChange={(t) => set((x) => void (x.title = t))} />
                </Field>
                <Field label="Подзаголовок">
                  <TextInput value={s.subtitle} maxLength={120} placeholder="Большая игра в честь дня рождения" onChange={(t) => set((x) => void (x.subtitle = t))} />
                </Field>
              </div>
              <div className="ad-grid-2">
                <Field
                  label="Начало игры (по Москве)"
                  hint={Number.isFinite(startMs) ? `${fmtMskDate(s.gameStartsAt)} — ${fmtUntil(startMs - Date.now())}. До этого момента в лобби идёт обратный отсчёт.` : 'Выбери дату и время'}
                >
                  <TextInput
                    type="datetime-local"
                    value={dateRaw}
                    onChange={(v) => {
                      setDateRaw(v);
                      const iso = mskInputToIso(v);
                      if (iso) set((x) => void (x.gameStartsAt = iso));
                    }}
                  />
                </Field>
                <Field label="Как зовут героя" hint="Подставляется вместо {vlados} во всех текстах">
                  <TextInput value={s.vladosLabel} maxLength={30} placeholder="Владос" onChange={(t) => set((x) => void (x.vladosLabel = t))} />
                </Field>
              </div>
              <Field label="Фото на фоне лобби" hint="Горизонтальное, будет слегка размыто под QR-кодом и лицами гостей.">
                <MediaSlot
                  className="ad-lobbybg"
                  accept="image"
                  title="Фото для лобби"
                  mediaId={s.lobbyBgMediaId}
                  onChange={(m) => set((x) => (m ? void (x.lobbyBgMediaId = m.id) : void delete x.lobbyBgMediaId), 0)}
                />
              </Field>
            </div>
          </Card>

          <AutopilotCard s={s} set={set} />

          <Card
            id="set-texts"
            kicker={textCount ? `Изменено: ${textCount}` : 'Все по умолчанию'}
            title="Тексты"
            icon="text"
            actions={
              textCount ? (
                <Btn size="s" tone="ghost" icon="undo" onClick={() => set((x) => void (x.texts = {}), 0)}>
                  Вернуть все
                </Btn>
              ) : null
            }
          >
            <p className="ad-help">
              Серым — текст по умолчанию. Впиши свой, чтобы заменить; сотри — вернётся стандартный. <b>{'{vlados}'}</b> превратится в «{s.vladosLabel}».
            </p>
            {GROUPS.map((g) => (
              <div key={g.id} className="ad-texts-group">
                <p className="vx-kick" style={{ margin: '18px 0 10px' }}>
                  {g.label}
                </p>
                <div className="ad-texts">
                  {TEXT_KEY_LIST.filter((k) => TEXT_KEYS[k].group === g.id).map((k: TextKey) => (
                    <Field key={k} label={TEXT_KEYS[k].label}>
                      <TextInput
                        value={s.texts[k] ?? ''}
                        maxLength={FB_LIMITS.textMax}
                        placeholder={TEXT_KEYS[k].def}
                        onChange={(t) =>
                          set((x) => {
                            if (t.trim()) x.texts[k] = t;
                            else delete x.texts[k];
                          })
                        }
                      />
                    </Field>
                  ))}
                </div>
              </div>
            ))}
          </Card>

          <Card id="set-time" kicker="Темп вечера" title="Время" icon="clock">
            <div className="ad-stack">
              <Field label="Заставка перед вопросом" hint="Сколько экран показывает вопрос, прежде чем гости смогут отвечать.">
                <Chips size="s" value={s.introMs} onChange={(v) => set((x) => void (x.introMs = v), 0)} options={[2000, 3000, 4000, 5000, 7000, 10000].map((ms) => ({ value: ms, label: `${ms / 1000} с` }))} />
              </Field>
              <Field label="Время на ответ для новых вопросов" hint="У каждого вопроса можно поставить своё.">
                <Chips size="s" value={s.defaultTimeLimitS} onChange={(v) => set((x) => void (x.defaultTimeLimitS = v), 0)} options={[15, 20, 30, 45, 60, 90].map((v) => ({ value: v, label: `${v} с` }))} />
              </Field>
              <Field label="Когда все ответили — закрыть вопрос через">
                <Chips size="s" value={s.allAnsweredDelayMs} onChange={(v) => set((x) => void (x.allAnsweredDelayMs = v), 0)} options={[500, 1200, 2500, 5000].map((ms) => ({ value: ms, label: secs(ms / 1000) }))} />
              </Field>
              <hr className="ad-sep" style={{ margin: '2px 0' }} />
              {autopilotOn(s) ? (
                <p className="ad-help">Переходы между экранами ведёт автопилот (карточка «Автопилот» выше) — в темпе «Прогнать игру».</p>
              ) : (
                <>
                  <p className="ad-help">Автопилот выключен. Автопереходы: если выбрать «через N с», экран сам перейдёт дальше. «Вручную» — ждёт твоей кнопки в «Эфире».</p>
                  <Field label="Ответ → таблица">
                    <AutoChips label="Ответ → таблица" value={s.autoAdvance.revealToBoardS} options={[6, 10, 15]} onChange={(v) => set((x) => void (x.autoAdvance.revealToBoardS = v), 0)} />
                  </Field>
                  <Field label="Таблица → следующий вопрос">
                    <AutoChips label="Таблица → следующий вопрос" value={s.autoAdvance.boardToNextS} options={[8, 12, 20]} onChange={(v) => set((x) => void (x.autoAdvance.boardToNextS = v), 0)} />
                  </Field>
                  <Field label="Шаги финала (3 → 2 → 1 место…)">
                    <AutoChips label="Шаги финала" value={s.autoAdvance.finalStepS} options={[5, 8, 12]} onChange={(v) => set((x) => void (x.autoAdvance.finalStepS = v), 0)} />
                  </Field>
                </>
              )}
              <Toggle
                label="Пауза, если многие отвалились"
                hint="Если за пару секунд пропадёт треть гостей (например, упал Wi-Fi), вопрос встанет на паузу."
                checked={s.autoPauseOnMassDisconnect}
                onChange={(v) => set((x) => void (x.autoPauseOnMassDisconnect = v), 0)}
              />
            </div>
          </Card>

          <Card
            id="set-score"
            kicker="Как считаются очки"
            title="Очки"
            icon="trophy"
            actions={
              <Btn size="s" tone="ghost" icon="undo" onClick={() => set((x) => void (x.scoring = structuredClone(DEFAULT_SCORING)), 0)}>
                Стандартные
              </Btn>
            }
          >
            <div className="ad-stack">
              <p className="ad-help">
                За идеальный ответ дают <b>{s.scoring.base}</b> очков (×2 в двойном вопросе). Быстрый ответ получает больше — медленный чуть меньше. Если сомневаешься — не трогай, всё уже сбалансировано.
              </p>
              <Range label="Очков за идеальный ответ" help="Просто масштаб: влияет на цифры, не на расклад." value={s.scoring.base} min={100} max={5000} step={100} fmt={String} onChange={(v) => set((x) => void (x.scoring.base = v))} />
              <p className="vx-kick" style={{ margin: '8px 0 0' }}>
                Выбор варианта
              </p>
              <Range
                label="Штраф за медлительность"
                help={`Верно, но в последнюю секунду — ${pct(1 - s.scoring.choice.speedWeight)} очков. Мгновенно — все 100%.`}
                value={s.scoring.choice.speedWeight}
                min={0}
                max={0.9}
                step={0.05}
                fmt={pct}
                onChange={(v) => set((x) => void (x.scoring.choice.speedWeight = v))}
              />
              <p className="vx-kick" style={{ margin: '8px 0 0' }}>
                Число
              </p>
              <Range
                label="Доля за точность"
                help={`${pct(s.scoring.number.accuracyShare)} очков — за близость к ответу, остальное (${pct(1 - s.scoring.number.accuracyShare)}) — бонус тому, кто ближе всех.`}
                value={s.scoring.number.accuracyShare}
                min={0.5}
                max={1}
                step={0.05}
                fmt={pct}
                onChange={(v) =>
                  set((x) => {
                    x.scoring.number.accuracyShare = v;
                    x.scoring.number.closestShare = Math.round((1 - v) * 100) / 100;
                  })
                }
              />
              <Range
                label="Строгость"
                help="Больше — очки быстрее тают с ошибкой (1 — плавно, 3 — только почти точные ответы что-то получают)."
                value={s.scoring.number.curve}
                min={1}
                max={3}
                step={0.1}
                fmt={(v) => v.toFixed(1)}
                onChange={(v) => set((x) => void (x.scoring.number.curve = v))}
              />
              <Range
                label="Штраф за медлительность"
                help={`Самый медленный точный ответ получит ${pct(1 - s.scoring.number.speedWeight)} от очков за точность.`}
                value={s.scoring.number.speedWeight}
                min={0}
                max={0.9}
                step={0.05}
                fmt={pct}
                onChange={(v) => set((x) => void (x.scoring.number.speedWeight = v))}
              />
              <p className="vx-kick" style={{ margin: '8px 0 0' }}>
                По порядку
              </p>
              <Range
                label="Максимум за «почти»"
                help={`Порядок почти верный — не больше ${pct(s.scoring.ordering.partialCap)} очков. Полностью верный — 100%.`}
                value={s.scoring.ordering.partialCap}
                min={0}
                max={0.95}
                step={0.05}
                fmt={pct}
                onChange={(v) => set((x) => void (x.scoring.ordering.partialCap = v))}
              />
              <Range
                label="Строгость"
                help="Больше — меньше очков за частично верный порядок."
                value={s.scoring.ordering.gamma}
                min={1}
                max={4}
                step={0.5}
                fmt={(v) => v.toFixed(1)}
                onChange={(v) => set((x) => void (x.scoring.ordering.gamma = v))}
              />
              <Range
                label="Штраф за медлительность"
                help={`Верный порядок в последнюю секунду — ${pct(1 - s.scoring.ordering.speedWeight)} очков.`}
                value={s.scoring.ordering.speedWeight}
                min={0}
                max={0.9}
                step={0.05}
                fmt={pct}
                onChange={(v) => set((x) => void (x.scoring.ordering.speedWeight = v))}
              />
            </div>
          </Card>

          <Card id="set-guests" kicker="Атмосфера" title="Звук и гости" icon="sound">
            <div className="ad-stack">
              <Toggle label="Звуковые эффекты на ТВ" hint="Тиканье таймера, «дзынь» правильного ответа, фанфары финала." checked={s.sound.sfx} onChange={(v) => set((x) => void (x.sound.sfx = v), 0)} />
              <Toggle label="Музыка на ТВ" hint="Фоновая музыка в лобби и во время вопросов." checked={s.sound.music} onChange={(v) => set((x) => void (x.sound.music = v), 0)} />
              <Range label="Громкость" help="Общая громкость экрана ТВ." value={s.sound.volume} min={0} max={1} step={0.05} fmt={pct} onChange={(v) => set((x) => void (x.sound.volume = v))} />
              <hr className="ad-sep" style={{ margin: '2px 0' }} />
              <Toggle label="Реакции" hint="Гости могут кидать эмодзи 🔥😂👏 — они летят по большому экрану." checked={s.reactions} onChange={(v) => set((x) => void (x.reactions = v), 0)} />
              <Toggle label="Можно зайти после начала" hint="Опоздавшие гости смогут присоединиться посреди игры (очки — с момента входа)." checked={s.lateJoin} onChange={(v) => set((x) => void (x.lateJoin = v), 0)} />
            </div>
          </Card>

          <Card id="set-tv" kicker="Оформление" title="Экран ТВ" icon="tv">
            <div className="ad-stack">
              <Field label="Тема большого экрана" hint="Телефоны гостей выбирают свою тему сами (по умолчанию — как в системе).">
                <Chips
                  value={s.tvAppearance}
                  onChange={(v) => set((x) => void (x.tvAppearance = v), 0)}
                  options={[
                    { value: 'dark', label: 'Тёмная', icon: 'eye' },
                    { value: 'light', label: 'Светлая', icon: 'sun' },
                    { value: 'system', label: 'Как в системе' },
                  ]}
                />
              </Field>
              <p className="ad-hint">В тёмной комнате с проектором лучше тёмная; днём у окна — светлая.</p>
            </div>
          </Card>

          <FinaleCard s={s} set={set} />

          <Admins />

          <Card id="set-me" kicker="Этот вход" title="Аккаунт" icon="lock">
            <div className="ad-stack">
              <div className="ad-email">
                <Icon name="mail" size={15} />
                <span>{user.email}</span>
                {user.emailVerified ? <span className="ad-tag is-good">подтверждена</span> : <span className="ad-tag">тестовый вход</span>}
              </div>
              <Field label="Тема пульта на этом устройстве">
                <ModeToggle size="s" />
              </Field>
              <div className="ad-row">
                <Btn icon="logout" onClick={() => void backend.signOut()}>
                  Выйти
                </Btn>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

