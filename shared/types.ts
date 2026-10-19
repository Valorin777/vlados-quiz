// Core data model. See docs/architecture.md → "Data model".

export type Id = string;

// ---------- Media ----------

export interface MediaAsset {
  id: Id;
  kind: 'image' | 'video';
  /** Content-hashed file names, served from `<cdnBase>/m/<file>` with the Mac's `/m/<file>` as fallback. */
  files: { lg?: string; sm: string; poster?: string };
  w: number;
  h: number;
  durationS?: number;
  bytes: number;
  status: 'processing' | 'ready' | 'error';
  /** 0..1 while processing. */
  progress?: number;
  error?: string;
  cdn: 'pending' | 'queued' | 'pushing' | 'live' | 'failed';
  createdAt: number;
}

// ---------- Questions ----------

export interface Item {
  id: Id;
  text?: string;
  mediaId?: Id;
}

export interface QMedia {
  mediaId: Id;
  /** false → phones show «смотри на экран» instead of the media. */
  onPhones: boolean;
  startAtS?: number;
}

/**
 * The «Сюрприз» interrupt of a question (shared/engine/surprise.ts): while its options are on
 * screen the TV «breaks down», goes black and plays a video; then the answer and the final.
 */
export interface QSurprise {
  on: boolean;
  /** 'builtin': app/public/surprise.mp4 (the congratulations video) · 'custom': the uploaded `mediaId`. */
  src: 'builtin' | 'custom';
  /** 'custom': the uploaded video (media/{id}); kept when switching back, so it can come back. */
  mediaId?: Id;
  /** Seconds after the options appear (default 4, at least 2, less than the time limit). */
  afterS: number;
}

export interface QBase {
  id: Id;
  title: string;
  media?: QMedia;
  revealMedia?: QMedia;
  revealText?: string;
  timeLimitS: number;
  double: boolean;
  notes?: string;
  disabled?: boolean;
  /** «Сюрприз-видео»: interrupt this question with a video (see QSurprise). */
  surprise?: QSurprise;
}

export interface ChoiceQ extends QBase {
  type: 'choice';
  /** 2..6 options. */
  options: Item[];
  correctId: Id;
}

export interface NumberQ extends QBase {
  type: 'number';
  answer: number;
  unit?: string;
  min?: number;
  max?: number;
  step: number;
  /** Errors ≤ tolerance get full accuracy. */
  tolerance: number;
  /** Error at which accuracy reaches 0. Must be > tolerance. */
  zeroAt: number;
}

export interface OrderingQ extends QBase {
  type: 'ordering';
  /** 3..6 items, authored in the CORRECT order. */
  items: Item[];
  firstLabel: string;
  lastLabel: string;
}

export type Question = ChoiceQ | NumberQ | OrderingQ;
export type QuestionType = Question['type'];

// ---------- Settings ----------

export interface ScoringParams {
  /** 1000 */
  base: number;
  choice: { speedWeight: number /* 0.5 */ };
  number: { speedWeight: number /* 0.2 */; accuracyShare: number /* 0.8 */; closestShare: number /* 0.2 */; curve: number /* 1.5 */ };
  ordering: { speedWeight: number /* 0.3 */; partialCap: number /* 0.7 */; gamma: number /* 2 */ };
  /** 3000 */
  maxLatencyCreditMs: number;
}

/** Every organizer-editable UI string. Defaults and admin labels live in shared/defaults.ts (TEXT_KEYS). */
export type TextKey =
  | 'joinTitle'
  | 'joinButton'
  | 'selfieHint'
  | 'recoverTitle'
  | 'lobbyHint'
  | 'waitingText'
  | 'preGameCountdown'
  | 'getReady'
  | 'doubleBadge'
  | 'answerAccepted'
  | 'timeUp'
  | 'noAnswer'
  | 'verdictCorrect'
  | 'verdictWrong'
  | 'verdictClose'
  | 'verdictClosest'
  | 'vladosAnswer'
  | 'outOfCompetition'
  | 'boardTitle'
  | 'podiumTitle'
  | 'podiumThird'
  | 'podiumSecond'
  | 'podiumFirst'
  | 'vladosTitle'
  | 'vladosVerdictBest'
  | 'vladosVerdictMiddle'
  | 'vladosVerdictWorst'
  | 'thanks'
  | 'paused'
  | 'reconnecting'
  | 'joinClosed';

/** Per-device appearance choice ('system' follows prefers-color-scheme). */
export type Appearance = 'system' | 'light' | 'dark';
/** Resolved palette actually rendered: tokens live on `[data-theme=<id>][data-mode=light|dark]`. */
export type ColorMode = 'light' | 'dark';

export type QrMode = 'direct' | 'pages' | 'lan';

/**
 * The video after the final (shared/engine/finale.ts): 'builtin' the clip that ships with the site
 * (app/public/finale.mp4), 'custom' an uploaded video (`finaleMediaId`), 'off' none.
 */
export type FinaleMode = 'builtin' | 'custom' | 'off';

export interface Settings {
  title: string;
  subtitle: string;
  lobbyBgMediaId?: Id;
  /** The video after the final (default 'builtin'). */
  finaleVideo: FinaleMode;
  /** 'custom': the uploaded video (media/{id}). Kept when switching modes, so it can come back. */
  finaleMediaId?: Id;
  vladosLabel: string;
  themeId: string;
  /** Appearance of the TV screen (set from admin; phones/admin choose their own locally). */
  tvAppearance: Appearance;
  /** ISO timestamp, drives the pre-game countdown. */
  gameStartsAt: string;
  texts: Partial<Record<TextKey, string>>;
  introMs: number;
  lockMs: number;
  allAnsweredDelayMs: number;
  defaultTimeLimitS: number;
  /**
   * «Автопилот» (shared/engine/showTimings.ts): the host moves the show on by itself — answer →
   * board → next question → every final step — with the pace of «Прогнать игру». Undefined (older
   * settings) = on; false = every step by the organizer's button (and `autoAdvance` below).
   */
  autopilot?: boolean;
  /** Timed steps when the autopilot is off (null = the organizer's button). */
  autoAdvance: { revealToBoardS: number | null; boardToNextS: number | null; finalStepS: number | null };
  autoPauseOnMassDisconnect: boolean;
  reactions: boolean;
  lateJoin: boolean;
  maxPlayers: number;
  sound: { sfx: boolean; music: boolean; volume: number };
  qrMode: QrMode;
  wifi?: { ssid: string; password: string };
  scoring: ScoringParams;
}

export interface Content {
  rev: number;
  settings: Settings;
  questions: Question[];
  trash: { q: Question; at: number }[];
  media: Record<Id, MediaAsset>;
  /**
   * false: no TV is on air right now (nobody plays a question's video or reports its end), so a
   * video round starts with the short watch fallback (engine/watch.ts). Default: a TV is on air.
   */
  tvOnAir?: boolean;
}

// ---------- Live game ----------

export type AnswerPayload =
  | { t: 'choice'; id: Id }
  | { t: 'number'; v: number }
  | { t: 'ordering'; ids: Id[] };

export interface Answer {
  p: AnswerPayload;
  /** Effective elapsed time (client-reported, clamped by the server). */
  elapsedMs: number;
  /** Server receive time. */
  at: number;
  /** Client id of the answer (outbox dedup key). */
  cid: string;
}

export interface RoundResult {
  points: number;
  /** 0..1 */
  accuracy: number;
  correct: boolean;
  closest?: boolean;
}

export interface Round {
  qid: Id;
  /** Frozen copy of the question at the moment the round started. */
  q: Question;
  /** Ordering only: shared shuffled order shown to everyone. */
  shown?: Id[];
  introAt: number;
  openAt: number;
  endsAt: number;
  lockedAt?: number;
  revealedAt?: number;
  answers: Record<Id, Answer>;
  results?: Record<Id, RoundResult>;
  skipped?: boolean;
  /**
   * A «Сюрприз» round (shared/engine/surprise.ts), frozen when it started: the interrupt comes
   * `afterMs` after openAt; `ms` is the video's length. While it runs the phase is 'locked' and
   * lockedAt is its start.
   */
  surprise?: RoundSurprise;
  /**
   * «Автопилот»: how long the answer stays on screen before the board (ms from the reveal), frozen
   * when the round started — long enough for its text / photo / whole video (engine/showTimings.ts).
   */
  revealHoldMs?: number;
  /**
   * «Автопилот»: the TV reported the end of the reveal video (host command 'revealMediaEnd') this
   * long after the reveal began (ms from phaseAt, so a «стоп-экран» that shifts phaseAt keeps it):
   * the board comes SHOW.revealVideoEndedMs after it — never before the plain reveal hold, never
   * after the frozen revealHoldMs (the fallback when nobody reports it).
   */
  revealEndMs?: number;
}

/** The frozen «Сюрприз» of a round (Round.surprise). */
export interface RoundSurprise {
  /** From openAt to the interrupt, ms. */
  afterMs: number;
  /** The video's length, ms. */
  ms: number;
}

export interface Player {
  id: Id;
  token: string;
  /** 4 digits, used by «Я уже играл» on another device. */
  code: string;
  name: string;
  /** Selfie file name under /avatars/ (never leaves the Mac). */
  avatar?: string;
  /** Seed for the generated sigil avatar. */
  seed: number;
  joinedAt: number;
  lastSeen: number;
  online: boolean;
  kicked: boolean;
  bot?: boolean;
}

export type Phase = 'lobby' | 'intro' | 'open' | 'locked' | 'reveal' | 'board' | 'final';

/**
 * 'hold': the organizer's «стоп-экран» — the whole show stops in any phase, the TV shows only
 * `tvBanner` (silence, no timers, no reactions) until «Убрать надпись и продолжить».
 */
export type PauseReason = 'admin' | 'recovered' | 'mass-disconnect' | 'hold';

export interface GameState {
  gameId: Id;
  rev: number;
  phase: Phase;
  phaseRev: number;
  phaseAt: number;
  players: Record<Id, Player>;
  vladosId: Id | null;
  rounds: Round[];
  /** Index into rounds of the current round (-1 before the first one). */
  cur: number;
  pause: null | { at: number; remainingMs: number; reason: PauseReason };
  /**
   * 0 drumroll, 1 third, 2 second, 3 first+confetti, 4 Vlados comparison, 5 mosaic+thanks,
   * 6 the video after the final (only when Settings.finaleVideo is not 'off', engine/finale.ts).
   */
  finalStep: number;
  tvBanner: string | null;
  savedAt: number;
}
