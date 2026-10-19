import type { Appearance, Content, NumberQ, ScoringParams, Settings, TextKey } from './types';

// ---------- Network & limits (docs/architecture.md → Stack, Protocol) ----------

export const NET = {
  port: 5178,
  pingIntervalMs: 10_000,
  pingTimeoutMs: 8_000,
  maxHttpBufferSize: 512 * 1024,
  answeredBatchMs: 150,
  reactionsBatchMs: 100,
  tvReactionsPerSec: 25,
  clockSyncPings: 5,
  clockResyncMs: 30_000,
} as const;

export const LIMITS = {
  nameMax: 20,
  avatarMaxBytes: 64 * 1024,
  choiceOptions: { min: 2, max: 6 },
  orderingItems: { min: 3, max: 6 },
  reactionBurst: 3,
  reactionRefillMs: 1_500,
  joinsPerSec: 20,
  recoverPerMin: 5,
  /** A player counts as active if seen within this window. */
  activeWindowMs: 15_000,
  massDisconnectShare: 0.3,
  massDisconnectWindowMs: 5_000,
  /** At least this many drops are needed, so one locked phone in a tiny test game does not pause it. */
  massDisconnectMinCount: 3,
  /** Minimum remaining time when resuming a round after a crash. */
  recoveredMinRemainingMs: 10_000,
  /** Last final step without the video after the final (engine/finale.ts adds step 6). */
  finalSteps: 5,
} as const;

// ---------- Appearance ----------

/** localStorage key of the per-device choice. */
export const APPEARANCE_KEY = 'vlados.appearance';
export const APPEARANCES: readonly Appearance[] = ['system', 'light', 'dark'];
export const APPEARANCE_LABELS: Record<Appearance, string> = {
  system: 'Как в системе',
  light: 'Светлая',
  dark: 'Тёмная',
};

// ---------- Scoring & settings ----------

export const DEFAULT_SCORING: ScoringParams = {
  base: 1000,
  choice: { speedWeight: 0.5 },
  number: { speedWeight: 0.2, accuracyShare: 0.8, closestShare: 0.2, curve: 1.5 },
  ordering: { speedWeight: 0.3, partialCap: 0.7, gamma: 2 },
  maxLatencyCreditMs: 3000,
};

export const DEFAULT_SETTINGS: Settings = {
  title: 'Кто лучше знает Владоса',
  subtitle: 'Большая игра в честь дня рождения',
  vladosLabel: 'Владос',
  themeId: 'tbd',
  tvAppearance: 'dark',
  gameStartsAt: '2026-09-26T21:00:00+03:00',
  texts: {},
  introMs: 4000,
  lockMs: 1500,
  allAnsweredDelayMs: 1200,
  defaultTimeLimitS: 60,
  autopilot: true,
  autoAdvance: { revealToBoardS: null, boardToNextS: null, finalStepS: null },
  autoPauseOnMassDisconnect: true,
  reactions: true,
  lateJoin: true,
  maxPlayers: 150,
  sound: { sfx: true, music: true, volume: 0.8 },
  qrMode: 'direct',
  scoring: DEFAULT_SCORING,
  finaleVideo: 'builtin',
};

/** Fresh deep copy, safe to mutate. */
export const defaultSettings = (): Settings => structuredClone(DEFAULT_SETTINGS);

// ---------- Editable texts ----------

export interface TextKeyDef {
  /** Label in admin Settings. */
  label: string;
  group: 'phone' | 'tv' | 'final' | 'system';
  def: string;
}

/** `{vlados}` in a text is replaced with Settings.vladosLabel. */
export const TEXT_KEYS: Record<TextKey, TextKeyDef> = {
  joinTitle: { group: 'phone', label: 'Вход: заголовок', def: 'Как тебя зовут?' },
  joinButton: { group: 'phone', label: 'Вход: кнопка', def: 'Я в игре!' },
  selfieHint: { group: 'phone', label: 'Вход: подсказка к селфи', def: 'Сделай селфи — оно прилетит на большой экран' },
  recoverTitle: { group: 'phone', label: 'Вход: «уже играл»', def: 'Я уже играл — вернуть мои очки' },
  lobbyHint: { group: 'tv', label: 'Лобби на экране: подсказка', def: 'Наведи камеру на QR-код и залетай в игру' },
  waitingText: { group: 'phone', label: 'Лобби на телефоне', def: 'Ты в игре! Смотри на большой экран — скоро начнём' },
  preGameCountdown: { group: 'phone', label: 'До начала игры', def: 'Игра начнётся через' },
  getReady: { group: 'phone', label: 'Перед вопросом', def: 'Приготовься!' },
  doubleBadge: { group: 'tv', label: 'Двойной вопрос', def: 'Двойные очки ×2' },
  answerAccepted: { group: 'phone', label: 'Ответ принят', def: 'Ответ принят! Ждём остальных…' },
  timeUp: { group: 'phone', label: 'Время вышло', def: 'Время вышло!' },
  noAnswer: { group: 'phone', label: 'Не успел ответить', def: 'Не успел — в следующий раз быстрее!' },
  verdictCorrect: { group: 'phone', label: 'Верный ответ', def: 'В точку!' },
  verdictWrong: { group: 'phone', label: 'Неверный ответ', def: 'Мимо!' },
  verdictClose: { group: 'phone', label: 'Почти (число, порядок)', def: 'Почти! Очень близко' },
  verdictClosest: { group: 'phone', label: 'Ближе всех (число)', def: 'Ближе всех!' },
  vladosAnswer: { group: 'tv', label: 'Подпись к ответу Владоса', def: 'А {vlados} ответил:' },
  outOfCompetition: { group: 'phone', label: 'Владос в таблице', def: 'вне конкурса' },
  boardTitle: { group: 'tv', label: 'Таблица: заголовок', def: 'Кто лидирует' },
  podiumTitle: { group: 'final', label: 'Финал: заголовок', def: 'И лучше всех Владоса знает…' },
  podiumThird: { group: 'final', label: 'Финал: 3 место', def: 'Бронза' },
  podiumSecond: { group: 'final', label: 'Финал: 2 место', def: 'Серебро' },
  podiumFirst: { group: 'final', label: 'Финал: 1 место', def: 'Главный знаток Владоса!' },
  vladosTitle: { group: 'final', label: 'Финал: сравнение с Владосом', def: 'А знает ли {vlados} себя?' },
  vladosVerdictBest: { group: 'final', label: 'Вердикт: Владос лучше всех', def: '{vlados} знает себя лучше всех — никаких сюрпризов!' },
  vladosVerdictMiddle: {
    group: 'final',
    label: 'Вердикт: Владос в середине',
    def: '{vlados} знает себя лучше большинства — но кое-кто знает его ещё лучше!',
  },
  vladosVerdictWorst: { group: 'final', label: 'Вердикт: друзья лучше', def: 'Друзья знают его лучше, чем он сам себя!' },
  thanks: { group: 'final', label: 'Финал: спасибо', def: 'Спасибо, что играли! С днём рождения, {vlados}!' },
  paused: { group: 'system', label: 'Пауза', def: 'Небольшая пауза — не уходи' },
  reconnecting: { group: 'system', label: 'Переподключение', def: 'Связь пропала, возвращаемся в игру…' },
  joinClosed: { group: 'system', label: 'Вход закрыт', def: 'Вход в игру уже закрыт' },
};

export const TEXT_KEY_LIST = Object.keys(TEXT_KEYS) as TextKey[];

/** Organizer's text (or the default) with `{vlados}` substituted. */
export function getText(settings: Pick<Settings, 'texts' | 'vladosLabel'>, key: TextKey): string {
  const raw = settings.texts[key]?.trim() || TEXT_KEYS[key].def;
  return raw.replaceAll('{vlados}', settings.vladosLabel);
}

export function resolveTexts(settings: Pick<Settings, 'texts' | 'vladosLabel'>): Record<TextKey, string> {
  return Object.fromEntries(TEXT_KEY_LIST.map((k) => [k, getText(settings, k)])) as Record<TextKey, string>;
}

// ---------- Reactions ----------

export const REACTIONS = ['🔥', '😂', '😱', '👏', '❤️', '🤯', '🎉', '🤔'] as const;

// ---------- Questions ----------

/** Doc formula: (max−min)/4 if a range is set, else max(|answer|·0.3, step·10). */
export function defaultZeroAt(q: Pick<NumberQ, 'answer' | 'min' | 'max' | 'step'>): number {
  if (q.min !== undefined && q.max !== undefined && q.max > q.min) return (q.max - q.min) / 4;
  return Math.max(Math.abs(q.answer) * 0.3, q.step * 10);
}

const TEMPLATE_NOTE = 'ШАБЛОН — замени текст, варианты и правильный ответ на настоящие (или удали вопрос).';

/** Initial content: 6 template questions the organizer will replace. Ids are stable for tests. */
export function seedContent(): Content {
  const settings = defaultSettings();
  const T = settings.defaultTimeLimitS;
  return {
    rev: 1,
    settings,
    trash: [],
    media: {},
    questions: [
      {
        id: 'tpl-food',
        type: 'choice',
        title: 'Что Владос закажет, если ему дать выбрать любое блюдо? (шаблон)',
        options: [
          { id: 'tpl-food-a', text: 'Шаурму с двойным сыром' },
          { id: 'tpl-food-b', text: 'Пасту карбонару' },
          { id: 'tpl-food-c', text: 'Бабушкин борщ' },
          { id: 'tpl-food-d', text: 'Сет роллов на троих' },
        ],
        correctId: 'tpl-food-a',
        revealText: 'Конечно, шаурма! Проверено годами.',
        timeLimitS: T,
        double: false,
        notes: TEMPLATE_NOTE,
      },
      {
        id: 'tpl-year',
        type: 'number',
        title: 'В каком году Владос впервые сел за руль? (шаблон)',
        answer: 2015,
        min: 1995,
        max: 2026,
        step: 1,
        tolerance: 1,
        zeroAt: 8,
        revealText: 'И с тех пор ни одного поцарапанного бампера (почти).',
        timeLimitS: T,
        double: false,
        notes: `${TEMPLATE_NOTE} Допуск ±1 год даёт полные очки за точность, ошибка в 8 лет — ноль.`,
      },
      {
        id: 'tpl-baby',
        type: 'choice',
        title: 'Кто из них — маленький Владос? (шаблон)',
        options: [
          { id: 'tpl-baby-a', text: 'Малыш в панамке' },
          { id: 'tpl-baby-b', text: 'Малыш с тортом' },
          { id: 'tpl-baby-c', text: 'Малыш на велосипеде' },
          { id: 'tpl-baby-d', text: 'Малыш с котом' },
        ],
        correctId: 'tpl-baby-b',
        revealText: 'Уже тогда знал толк в праздниках!',
        timeLimitS: T,
        double: false,
        notes: `${TEMPLATE_NOTE} Вопрос с картинками: добавь фото в каждый вариант. Пока фото нет, показывается текст.`,
      },
      {
        id: 'tpl-life',
        type: 'ordering',
        title: 'Расставь события жизни Владоса по порядку (шаблон)',
        items: [
          { id: 'tpl-life-a', text: 'Первый раз пошёл в школу' },
          { id: 'tpl-life-b', text: 'Получил права' },
          { id: 'tpl-life-c', text: 'Устроился на первую работу' },
          { id: 'tpl-life-d', text: 'Переехал в свою квартиру' },
        ],
        firstLabel: 'Раньше',
        lastLabel: 'Позже',
        timeLimitS: T,
        double: false,
        notes: `${TEMPLATE_NOTE} Пункты вводятся в ПРАВИЛЬНОМ порядке — игрокам они покажутся перемешанными.`,
      },
      {
        id: 'tpl-coffee',
        type: 'number',
        title: 'Сколько чашек кофе Владос выпивает в день? (шаблон)',
        answer: 3,
        unit: 'чашек',
        min: 0,
        max: 15,
        step: 1,
        tolerance: 0,
        zeroAt: 4,
        revealText: 'Кофе — это не напиток, это образ жизни.',
        timeLimitS: T,
        double: false,
        notes: `${TEMPLATE_NOTE} Точный ответ — полные очки, ошибка на 4 чашки и больше — ноль за точность.`,
      },
      {
        id: 'tpl-wish',
        type: 'choice',
        title: 'Финал ×2: что Владос загадает, задувая свечи? (шаблон)',
        options: [
          { id: 'tpl-wish-a', text: 'Путешествие вокруг света' },
          { id: 'tpl-wish-b', text: 'Чтобы все друзья были рядом' },
          { id: 'tpl-wish-c', text: 'Новую машину' },
          { id: 'tpl-wish-d', text: 'Наконец-то выспаться' },
        ],
        correctId: 'tpl-wish-b',
        revealText: 'И сегодня это желание уже сбылось — вы все здесь!',
        timeLimitS: T,
        double: true,
        notes: `${TEMPLATE_NOTE} Финальный вопрос с двойными очками.`,
      },
    ],
  };
}
