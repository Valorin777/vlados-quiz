// Russian labels and formatting for the organizer's panel.

import type { Phase, QuestionType } from '@shared/types';
import { currentEnv } from '../../../fb/env';
import { plural } from '../../../visual';

export const PHASE_LABEL: Record<Phase, string> = {
  lobby: 'Лобби — гости собираются',
  intro: 'Заставка вопроса',
  open: 'Идёт вопрос',
  locked: 'Время вышло',
  reveal: 'Правильный ответ',
  board: 'Таблица лидеров',
  final: 'Финал',
};

export const PHASE_SHORT: Record<Phase, string> = {
  lobby: 'Лобби',
  intro: 'Заставка',
  open: 'Вопрос',
  locked: 'Стоп',
  reveal: 'Ответ',
  board: 'Таблица',
  final: 'Финал',
};

export const TYPE_LABEL: Record<QuestionType, string> = {
  choice: 'Выбор варианта',
  number: 'Число',
  ordering: 'По порядку',
};

export const TYPE_HINT: Record<QuestionType, string> = {
  choice: 'От 2 до 6 вариантов, один верный. Можно с картинками.',
  number: 'Гости вводят число. Чем ближе — тем больше очков.',
  ordering: 'Расставить пункты по порядку: события, рост, возраст…',
};

export const KEYS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

/** "~18 мин", "1 ч 05 мин" */
export function fmtDuration(sec: number): string {
  const m = Math.max(1, Math.round(sec / 60));
  if (m < 60) return `${m}\u00a0мин`;
  const h = Math.floor(m / 60);
  return `${h}\u00a0ч ${String(m % 60).padStart(2, '0')}\u00a0мин`;
}

export const fmtSeconds = (s: number): string => `${s} ${plural(s, ['секунда', 'секунды', 'секунд'])}`;

/** "только что", "12 с назад", "3 мин назад" */
export function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 3) return 'только что';
  if (s < 60) return `${s} с назад`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин назад`;
  return `${Math.round(m / 60)} ч назад`;
}

export const nQuestions = (n: number): string => `${n} ${plural(n, ['вопрос', 'вопроса', 'вопросов'])}`;
export const nPlayers = (n: number): string => `${n} ${plural(n, ['гость', 'гостя', 'гостей'])}`;
export const nPoints = (n: number): string => `${plural(n, ['очко', 'очка', 'очков'])}`;

// ---------- Moscow time (the party is in MSK; the organizer's laptop may be anywhere) ----------

const MSK_OFFSET_MIN = 180;

/** ISO timestamp → value for <input type="datetime-local"> in Moscow time. */
export function isoToMskInput(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t + MSK_OFFSET_MIN * 60_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** datetime-local value (Moscow time) → ISO with +03:00; null when incomplete. */
export function mskInputToIso(v: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return null;
  return `${v}:00+03:00`;
}

/** "суббота, 26 сентября, 19:00 (МСК)" */
export function fmtMskDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const f = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
  return `${f.format(t)} (МСК)`;
}

/** "через 3 дня 4 часа", "через 12 минут", "уже началась" */
export function fmtUntil(ms: number): string {
  if (ms <= 0) return 'время пришло';
  const min = Math.floor(ms / 60_000);
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d} ${plural(d, ['день', 'дня', 'дней'])}`);
  if (h) parts.push(`${h} ${plural(h, ['час', 'часа', 'часов'])}`);
  if (!d && m) parts.push(`${m} ${plural(m, ['минуту', 'минуты', 'минут'])}`);
  return parts.length ? `через ${parts.join(' ')}` : 'меньше минуты';
}

/** Parses "1,5" or "1.5" or "−3"; empty → undefined; garbage → NaN. */
export function parseNum(raw: string): number | undefined {
  const s = raw.trim().replace(/\s/g, '').replace(',', '.').replace('−', '-');
  if (s === '' || s === '-') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : Number.NaN;
}

export const fmtNum = (n: number | undefined | null): string =>
  n === undefined || n === null || !Number.isFinite(n) ? '' : String(n).replace('.', ',');

/** Base URL of this app (keeps ?env=dev), e.g. for the TV link. */
export function appUrl(hash: string): string {
  const u = new URL(location.href);
  u.hash = hash;
  u.search = currentEnv() === 'dev' ? '?env=dev' : '';
  return u.toString();
}
