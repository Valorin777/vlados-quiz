// Every phone state as a real PlayerView: a small game is driven through the pure host (step())
// exactly like the live host does it, then buildPlayerView() makes the view for one guest.
// Used by `#/?fx=<id>` (full-screen, for screenshots) and the Lab «Экраны» tab.

import { defaultSettings } from '@shared/defaults';
import { WATCH } from '@shared/engine/watch';
import type { AnswerDoc, GameDoc, PlayerDoc } from '@shared/fbtypes';
import type { AnswerPayload, ChoiceQ, NumberQ, OrderingQ, Settings } from '@shared/types';
import type { TotalsDoc } from '../../../host/model';
import { SURPRISE } from '@shared/engine/surprise';
import { checkedName, emptyTotals, hostDeadline, hostEvent, initialGameDoc, publicRound, step, type HostCommand, type HostContent } from '../../../host/pure';
import { buildPlayerView, type MyAnswer, type PlayerView, type PlayerViewInput } from '../../../host/views';
import type { PlayerActions } from '../types';
import { fakePictureFor } from '../../tv/dev/faces';

const T0 = Date.parse('2026-09-26T19:05:00+03:00');

const Q1: ChoiceQ = {
  id: 'q-food',
  type: 'choice',
  title: 'Что Владос закажет, если дать ему выбрать любое блюдо в мире?',
  options: [
    { id: 'a', text: 'Шаурму с двойным сыром' },
    { id: 'b', text: 'Пасту карбонару' },
    { id: 'c', text: 'Бабушкин борщ' },
    { id: 'd', text: 'Роллы «Филадельфия»' },
  ],
  correctId: 'c',
  timeLimitS: 30,
  double: true,
};
const Q2: NumberQ = {
  id: 'q-age',
  type: 'number',
  title: 'Во сколько лет Владос впервые сел за руль?',
  answer: 16,
  unit: 'лет',
  min: 5,
  max: 40,
  step: 1,
  tolerance: 0,
  zeroAt: 8,
  timeLimitS: 30,
  double: false,
};
const Q3: OrderingQ = {
  id: 'q-trips',
  type: 'ordering',
  title: 'Расставь поездки Владоса от самой ранней к самой поздней',
  items: [
    { id: 'p', text: 'Питер на майские' },
    { id: 'k', text: 'Казань с универом' },
    { id: 's', text: 'Сочи с семьёй' },
    { id: 't', text: 'Стамбул на ДР' },
  ],
  firstLabel: 'Раньше всех',
  lastLabel: 'Позже всех',
  timeLimitS: 45,
  double: false,
};

const settings: Settings = { ...defaultSettings(), introMs: 4_000, lockMs: 1_500, allAnsweredDelayMs: 1_000 };
const CONTENT: HostContent = { rev: 1, settings, questions: [Q1, Q2, Q3] };

// --- the longest content the editor allows (title 300, option 140, unit 20, labels 40, name 20):
// every chrome pill / orb must keep its text inside at these lengths too
const QL1: ChoiceQ = {
  id: 'q-long',
  type: 'choice',
  title: 'Представь: суббота, утро, никаких планов, телефон сел, а в холодильнике только вчерашняя пицца. Что Владос сделает первым делом, пока все друзья ещё спят после вечеринки?',
  options: [
    { id: 'a', text: 'Доест пиццу холодной прямо из коробки, стоя у открытого холодильника, и пойдёт досыпать' },
    { id: 'b', text: 'Поставит телефон на зарядку и напишет всем в общий чат «кто живой?»' },
    { id: 'c', text: 'Пойдёт на пробежку вокруг района, потому что обещал себе ещё в понедельник, а потом купит кофе и круассаны на всех' },
    { id: 'd', text: 'Сделает яичницу' },
    { id: 'e', text: 'Разбудит соседа по квартире и уговорит поехать на море — прямо сейчас, без вещей' },
    { id: 'f', text: 'Включит сериал' },
  ],
  correctId: 'c',
  timeLimitS: 45,
  double: false,
};
const QL2: NumberQ = {
  id: 'q-long-n',
  type: 'number',
  title: 'Сколько километров Владос проехал за рулём за своё самое длинное путешествие на машине?',
  answer: 2400,
  unit: 'километров с копейками',
  min: 0,
  max: 10000,
  step: 50,
  tolerance: 0,
  zeroAt: 1000,
  timeLimitS: 30,
  double: false,
};
const QL3: OrderingQ = {
  id: 'q-long-o',
  type: 'ordering',
  title: 'Расставь события из жизни Владоса по порядку — от самого давнего к самому недавнему',
  items: [
    { id: 'p', text: 'Первый раз сам доехал на машине до дачи и ни разу не заглох на светофоре' },
    { id: 'k', text: 'Поступил в универ и в первую же неделю потерял студенческий' },
    { id: 's', text: 'Выиграл турнир по FIFA в общаге' },
    { id: 't', text: 'Устроился на первую работу — курьером на велосипеде по всему центру города' },
    { id: 'm', text: 'Прыгнул с парашютом' },
    { id: 'n', text: 'Научился готовить борщ по бабушкиному рецепту, записанному на обороте старого календаря' },
  ],
  firstLabel: 'Давным-давно, ещё в прошлой жизни',
  lastLabel: 'Совсем недавно, буквально вчера',
  timeLimitS: 60,
  double: false,
};
const LONG_CONTENT: HostContent = { rev: 1, settings, questions: [QL1, QL2, QL3] };

const NAMES = ['Соня', 'Кирилл', 'Даша', 'Макс', 'Лёша', 'Аня', 'Тимур', 'Вика', 'Гоша', 'Лиза', 'Артём', 'Полина'];

class World {
  constructor(readonly content: HostContent = CONTENT) {}
  game: GameDoc = initialGameDoc(settings);
  totals: TotalsDoc | null = emptyTotals(T0);
  players: Record<string, PlayerDoc> = {};
  answers: AnswerDoc[] = [];
  now = T0;

  input() {
    const i = this.game.round?.i;
    return { gameId: 'fx', game: this.game, totals: this.totals, players: this.players, answers: this.answers.filter((a) => a.round === i) };
  }
  private apply(out: ReturnType<typeof step>) {
    if (!out.changed) return;
    this.game = out.game;
    this.totals = out.totals;
  }
  join(uid: string, name: string) {
    this.players[uid] = { name, seed: uid.length * 7919, joinedAt: this.now, kicked: false, seenAt: this.now };
  }
  cmd(c: HostCommand) {
    const ev = hostEvent(c, this.totals);
    if (ev) this.apply(step(this.input(), ev, this.now, { content: this.content, players: this.players, media: {} }));
  }
  advance() {
    this.cmd({ type: 'advance', phaseRev: this.game.phaseRev });
  }
  until(t: number) {
    for (let k = 0; k < 30; k++) {
      const d = hostDeadline(this.input(), this.content);
      if (d === null || d > t) break;
      this.now = Math.max(this.now, d);
      this.apply(step(this.input(), { t: 'tick' }, this.now, { content: this.content, players: this.players, media: {} }));
    }
    this.now = Math.max(this.now, t);
  }
  answer(uid: string, p: AnswerPayload, afterOpenMs: number) {
    const r = this.game.round;
    if (r) this.answers.push({ uid, round: r.i, p, at: r.openAt + afterOpenMs });
  }
  get round() {
    const r = this.game.round;
    if (!r) throw new Error('no round');
    return r;
  }
}

export interface Fixture {
  id: string;
  label: string;
  view: PlayerView;
}

interface Opts {
  uid?: string;
  vlados?: boolean;
  answers?: Record<number, MyAnswer>;
  extra?: Partial<PlayerViewInput>;
  now?: number;
  game?: Partial<GameDoc>;
}

function viewOf(w: World, o: Opts = {}): PlayerView {
  const uid = o.uid ?? 'me';
  const game = { ...w.game, players: Object.keys(w.players).length, answered: 9, ...(o.game ?? {}) };
  const inp: PlayerViewInput = {
    uid,
    gameId: 'fx',
    game,
    gameState: 'live',
    me: w.players[uid] ?? null,
    meLoaded: true,
    answers: o.answers ?? {},
    lastScore: null,
    reactionsSent: [],
    ...(o.extra ?? {}),
  };
  return buildPlayerView(inp, o.now ?? w.now);
}

const crowd = (w: World) => NAMES.forEach((n, k) => w.join(`g${k}`, n));

/** Answers of the crowd for each question (me answers separately). */
function crowdAnswers(w: World, q: 'choice' | 'number' | 'ordering') {
  NAMES.forEach((_, k) => {
    if (k === NAMES.length - 1) return; // Полина never makes it in time
    const uid = `g${k}`;
    if (q === 'choice') w.answer(uid, { t: 'choice', id: k % 3 === 0 ? 'c' : k % 3 === 1 ? 'a' : 'b' }, 1_500 + k * 700);
    else if (q === 'number') w.answer(uid, { t: 'number', v: 12 + (k % 9) }, 3_000 + k * 500);
    else w.answer(uid, { t: 'ordering', ids: k % 2 ? ['k', 'p', 's', 't'] : ['p', 'k', 't', 's'] }, 6_000 + k * 600);
  });
}

let cache: Fixture[] | null = null;

export function fixtures(): Fixture[] {
  if (cache) return cache;
  const out: Fixture[] = [];
  const add = (id: string, label: string, view: PlayerView) => out.push({ id, label, view });

  // --- before the game / at the door
  {
    const w = new World();
    crowd(w);
    const early = { pub: { ...w.game.pub, startsAt: T0 + 2 * 86_400_000 + 3 * 3_600_000 + 17 * 60_000 } };
    add('pregame', 'До игры: зарегистрируйся заранее', viewOf(w, { game: early }));
    add('join', 'Вход: имя', viewOf(w));
    w.join('me', 'Валера');
    add('lobby', 'Лобби', viewOf(w));
    add('lobby-early', 'Лобби до начала (обратный отсчёт)', viewOf(w, { game: early }));
    w.join('vlad', 'Владос');
    w.cmd({ type: 'setVlados', uid: 'vlad' });
    add('lobby-vlados', 'Лобби: ты — Владос', viewOf(w, { uid: 'vlad' }));
    add('offline', 'Лобби: связь пропала (плашка)', viewOf(w, { extra: { gameState: 'cache' } }));
    w.cmd({ type: 'hold', phaseRev: w.game.phaseRev, text: '🎂 Выносим торт — все к столу, игра продолжится через пару минут!' });
    add('hold', 'Стоп-экран: текст организатора', viewOf(w));
  }

  // --- a full game: Q1 choice ×2, Q2 number, Q3 ordering
  const w = new World();
  crowd(w);
  w.join('me', 'Валера');
  w.join('vlad', 'Владос');
  w.cmd({ type: 'setVlados', uid: 'vlad' });
  w.cmd({ type: 'start' });
  add('intro', 'Перед вопросом (×2)', viewOf(w, { now: w.round.introAt + 1_300 }));
  w.until(w.round.openAt);
  const open1 = w.round.openAt;
  add('question', 'Вопрос: выбор варианта', viewOf(w, { now: open1 + 8_000 }));
  // the question's photo in every proportion (nothing may be cropped; no black bars)
  // like the live media meta: the pixel size comes with the id (the frame is sized before the file lands)
  const wh = (id: string) => {
    const m = /(\d+)x(\d+)$/.exec(id);
    return m ? { w: Number(m[1]), h: Number(m[2]) } : {};
  };
  const photo = (v: PlayerView, id: string): PlayerView =>
    v.question ? { ...v, question: { ...v.question, title: 'Какого цвета у Влада глаза?', media: { mediaId: id, kind: 'image', onPhones: true, ...wh(id) } } } : v;
  add('photo-portrait', 'Вопрос с фото: портрет 3:4', photo(viewOf(w, { now: open1 + 8_000 }), 'fx-pic-900x1200'));
  add('photo-tall', 'Вопрос с фото: портрет 9:16', photo(viewOf(w, { now: open1 + 8_000 }), 'fx-pic-720x1280'));
  add('photo-wide', 'Вопрос с фото: пейзаж 16:9', photo(viewOf(w, { now: open1 + 8_000 }), 'fx-pic-1280x720'));
  add('photo-square', 'Вопрос с фото: квадрат', photo(viewOf(w, { now: open1 + 8_000 }), 'fx-pic-1000x1000'));
  add('question-hurry', 'Вопрос: осталось 6 секунд', viewOf(w, { now: w.round.endsAt - 6_000 }));
  const mine1: Record<number, MyAnswer> = { [w.round.i]: { round: w.round.i, p: { t: 'choice', id: 'c' }, status: 'accepted' } };
  add('answered', 'Ответ принят', viewOf(w, { now: open1 + 9_000, answers: mine1 }));
  add('sending', 'Ответ уходит (медленная сеть)', viewOf(w, { now: open1 + 9_000, answers: { [w.round.i]: { ...mine1[w.round.i]!, status: 'sending' } } }));
  w.cmd({ type: 'pause' });
  add('paused', 'Пауза (плашка)', viewOf(w, { answers: mine1 }));
  w.cmd({ type: 'resume' });
  crowdAnswers(w, 'choice');
  w.answer('me', { t: 'choice', id: 'c' }, 2_100);
  w.answer('vlad', { t: 'choice', id: 'a' }, 4_000);
  w.until(w.round.endsAt);
  add('time_up', 'Время вышло (не ответил)', viewOf(w, { uid: 'g11', now: w.round.endsAt + 200 }));
  w.until(w.round.endsAt + 1_500 + 4_000);
  add('reveal-good', 'Результат: в точку (×2)', viewOf(w, { answers: mine1 }));
  add('reveal-bad', 'Результат: мимо + ответ Владоса', viewOf(w, { uid: 'g1', answers: { [w.round.i]: { round: w.round.i, p: { t: 'choice', id: 'a' }, status: 'accepted' } } }));
  add('reveal-none', 'Результат: без ответа', viewOf(w, { uid: 'g11' }));
  // the picture that comes with the right answer (emerges from a droplet; tap → full screen)
  const revealPic = (v: PlayerView, id: string): PlayerView => (v.reveal ? { ...v, reveal: { ...v.reveal, media: { mediaId: id, kind: 'image', onPhones: true, ...wh(id) } } } : v);
  add('reveal-photo', 'Результат + фото к ответу (портрет)', revealPic(viewOf(w, { answers: mine1 }), 'fx-pic-900x1200'));
  // a reveal VIDEO: TV-only — the phone shows its poster with «▶ на большом экране»
  const revealVid = (v: PlayerView): PlayerView =>
    v.reveal ? { ...v, reveal: { ...v.reveal, media: { mediaId: 'fx-video-reveal', kind: 'video', onPhones: true, posterId: 'fx-pic-464x848', w: 464, h: 848 } } } : v;
  add('reveal-video', 'Результат + видео к ответу (идёт на ТВ)', revealVid(viewOf(w, { answers: mine1 })));
  add('reveal-photo-bad', 'Результат мимо + фото к ответу (пейзаж)', revealPic(viewOf(w, { uid: 'g1', answers: { [w.round.i]: { round: w.round.i, p: { t: 'choice', id: 'a' }, status: 'accepted' } } }), 'fx-pic-1280x720'));
  add('reveal-vlados', 'Результат глазами Владоса', viewOf(w, { uid: 'vlad', answers: { [w.round.i]: { round: w.round.i, p: { t: 'choice', id: 'a' }, status: 'accepted' } } }));
  w.advance();
  add('board', 'Таблица: твоё место', viewOf(w, { uid: 'g4' }));
  w.advance();
  w.until(w.round.openAt);
  add('number', 'Вопрос: число', viewOf(w, { now: w.round.openAt + 5_000 }));
  crowdAnswers(w, 'number');
  w.answer('me', { t: 'number', v: 17 }, 4_000);
  w.answer('vlad', { t: 'number', v: 16 }, 3_000);
  w.until(w.round.endsAt + 1_500 + 4_000);
  add('reveal-close', 'Результат: почти (число)', viewOf(w, { answers: { [w.round.i]: { round: w.round.i, p: { t: 'number', v: 17 }, status: 'accepted' } } }));
  w.advance();
  w.advance();
  w.until(w.round.openAt);
  add('ordering', 'Вопрос: порядок', viewOf(w, { now: w.round.openAt + 7_000 }));
  crowdAnswers(w, 'ordering');
  w.answer('me', { t: 'ordering', ids: ['k', 'p', 's', 't'] }, 9_000);
  w.until(w.round.endsAt + 1_500 + 4_000);
  add('reveal-order', 'Результат: порядок', viewOf(w, { answers: { [w.round.i]: { round: w.round.i, p: { t: 'ordering', ids: ['k', 'p', 's', 't'] }, status: 'accepted' } } }));
  w.cmd({ type: 'end' });
  add('final-0', 'Финал: барабанная дробь', viewOf(w));
  w.advance();
  add('final-1', 'Финал: бронза', viewOf(w));
  w.advance();
  w.advance();
  add('final-3', 'Финал: золото и твоё место', viewOf(w));
  add('final-3-pod', 'Финал: ты на подиуме', viewOf(w, { uid: w.game.final?.podium[0]?.uid ?? 'me' }));
  w.advance();
  add('final-4', 'Финал: Владос против друзей', viewOf(w));
  w.advance();
  add('final-5', 'Финал: спасибо', viewOf(w));
  // the video after the final plays on the TV: «Смотри на экран» + its poster, then the final again
  w.advance();
  const fv = w.game.final?.video;
  if (fv) {
    add('final-6', 'Финал: видео на большом экране', viewOf(w, { now: fv.at + 4_000 }));
    add('final-6-after', 'Финал: после видео', viewOf(w, { now: fv.at + fv.ms + 5_000 }));
  }

  // --- a video question: it plays on the TV only; the phone waits, then «Варианты появятся через 3…2…1»
  {
    const v = new World();
    crowd(v);
    v.join('me', 'Валера');
    const QV: ChoiceQ = { ...Q1, id: 'q-video', title: 'Что Владос сделал в самом конце видео?', double: false, media: { mediaId: 'fx-video', onPhones: true } };
    const round = publicRound(QV, 0, 7, T0, settings, { media: { 'fx-video': { kind: 'video', durationS: 15 } }, tv: false });
    const game: Partial<GameDoc> = { phase: 'intro', phaseRev: 1, round };
    const startAt = round.openAt - WATCH.beatMs - (round.media?.watchMs ?? 0);
    add('watch', 'Видео: смотри на большом экране', viewOf(v, { game, now: startAt + 6_000 }));
    add('watch-beat', 'Видео: варианты через 3…2…1', viewOf(v, { game, now: round.openAt - 2_400 }));
  }

  // --- «Сюрприз»: the last question is interrupted by a video on the TV (the phone glitches, goes
  // black, then «Смотри на экран»); after it the answer — points if sent before the interrupt
  {
    const QS: ChoiceQ = {
      ...Q1,
      id: 'q-surprise',
      title: 'Кто лучше всех поздравил Владоса?',
      options: [
        { id: 'a', text: 'Мама и папа' },
        { id: 'b', text: 'Одноклассники' },
        { id: 'c', text: 'Лучший друг' },
        { id: 'd', text: 'Бабушка' },
      ],
      correctId: 'a',
      surprise: { on: true, src: 'builtin', afterS: 5 },
    };
    const s = new World({ rev: 1, settings, questions: [QS] });
    crowd(s);
    s.join('me', 'Валера');
    s.cmd({ type: 'start' });
    s.until(s.round.openAt);
    const open = s.round.openAt;
    add('surprise-question', 'Сюрприз: вопрос за секунду до сбоя', viewOf(s, { now: open + 4_000 }));
    s.answer('me', { t: 'choice', id: 'a' }, 2_200);
    NAMES.forEach((_, k) => k % 2 === 0 && s.answer(`g${k}`, { t: 'choice', id: k % 4 ? 'b' : 'a' }, 1_000 + k * 300));
    s.until(open + 5_000);
    const at = s.game.next?.surprise?.at ?? open + 5_000;
    const mineS: Record<number, MyAnswer> = { [s.round.i]: { round: s.round.i, p: { t: 'choice', id: 'a' }, status: 'accepted' } };
    add('surprise-glitch', 'Сюрприз: телефон «ломается»', viewOf(s, { now: at + 250, answers: mineS }));
    add('surprise-black', 'Сюрприз: чёрный экран', viewOf(s, { now: at + 1_800, answers: mineS }));
    add('surprise-watch', 'Сюрприз: смотри на экран (идёт видео)', viewOf(s, { now: at + SURPRISE.glitchMs + SURPRISE.blackMs + 30_000, answers: mineS }));
    add('surprise-watch-late', 'Сюрприз: не успел ответить (идёт видео)', viewOf(s, { uid: 'g1', now: at + SURPRISE.glitchMs + SURPRISE.blackMs + 30_000 }));
    s.now = at + SURPRISE.glitchMs + SURPRISE.blackMs + SURPRISE.builtin.ms;
    s.cmd({ type: 'surpriseEnd', phaseRev: s.game.phaseRev });
    add('surprise-reveal', 'Сюрприз: после видео — ответ (успел)', viewOf(s, { answers: mineS }));
    add('surprise-reveal-late', 'Сюрприз: после видео — не успел', viewOf(s, { uid: 'g1' }));
  }

  // --- the longest texts the editor allows (`-long` states): layout stress
  {
    const L = new World(LONG_CONTENT);
    NAMES.forEach((n, k) => L.join(`g${k}`, k % 3 === 0 ? `${n} Константинопольская`.slice(0, 20) : n));
    L.join('me', 'Александра-Анастасия');
    L.join('vlad', 'Владос');
    L.cmd({ type: 'setVlados', uid: 'vlad' });
    add('lobby-long', 'Лобби: имя в 20 букв', viewOf(L));
    L.cmd({ type: 'start' });
    add('intro-long', 'Перед вопросом: длинный вопрос', viewOf(L, { now: L.round.introAt + 1_300 }));
    L.until(L.round.openAt);
    const o1 = L.round.openAt;
    add('question-long', 'Вопрос: 6 длинных вариантов', viewOf(L, { now: o1 + 8_000 }));
    const mineL: Record<number, MyAnswer> = { [L.round.i]: { round: L.round.i, p: { t: 'choice', id: 'c' }, status: 'accepted' } };
    add('answered-long', 'Ответ принят: длинный вариант', viewOf(L, { now: o1 + 9_000, answers: mineL }));
    NAMES.forEach((_, k) => L.answer(`g${k}`, { t: 'choice', id: 'abcdef'[k % 6] as string }, 2_000 + k * 900));
    L.answer('me', { t: 'choice', id: 'c' }, 3_000);
    L.answer('vlad', { t: 'choice', id: 'a' }, 4_000);
    L.until(L.round.endsAt + 1_500 + 4_000);
    add('reveal-long', 'Результат: длинный вариант', viewOf(L, { answers: mineL }));
    add('reveal-long-bad', 'Результат мимо: длинные варианты', viewOf(L, { uid: 'g1', answers: { [L.round.i]: { round: L.round.i, p: { t: 'choice', id: 'b' }, status: 'accepted' } } }));
    L.advance();
    add('board-long', 'Таблица: длинные имена', viewOf(L));
    L.advance();
    L.until(L.round.openAt);
    add('number-long', 'Вопрос: число с длинной единицей', viewOf(L, { now: L.round.openAt + 5_000 }));
    NAMES.forEach((_, k) => L.answer(`g${k}`, { t: 'number', v: 1500 + k * 150 }, 3_000 + k * 500));
    L.answer('me', { t: 'number', v: 2350 }, 4_000);
    L.until(L.round.endsAt + 1_500 + 4_000);
    add('reveal-close-long', 'Результат: число с длинной единицей', viewOf(L, { answers: { [L.round.i]: { round: L.round.i, p: { t: 'number', v: 2350 }, status: 'accepted' } } }));
    L.advance();
    L.advance();
    L.until(L.round.openAt);
    add('ordering-long', 'Вопрос: 6 длинных пунктов', viewOf(L, { now: L.round.openAt + 7_000 }));
    const ord = ['k', 'p', 's', 't', 'm', 'n'];
    NAMES.forEach((_, k) => L.answer(`g${k}`, { t: 'ordering', ids: k % 2 ? ord : [...ord].reverse() }, 6_000 + k * 600));
    L.answer('me', { t: 'ordering', ids: ord }, 9_000);
    L.until(L.round.endsAt + 1_500 + 4_000);
    add('reveal-order-long', 'Результат: 6 длинных пунктов', viewOf(L, { answers: { [L.round.i]: { round: L.round.i, p: { t: 'ordering', ids: ord }, status: 'accepted' } } }));
    L.cmd({ type: 'end' });
    L.advance();
    L.advance();
    L.advance();
    add('final-3-long', 'Финал: длинные имена на подиуме', viewOf(L));
  }

  // --- no game to play
  {
    const k = new World();
    crowd(k);
    k.join('me', 'Валера');
    k.cmd({ type: 'kick', uid: 'me' });
    add('kicked', 'Удалён из игры', viewOf(k));
    add('no_game', 'Игры ещё нет', viewOf(k, { extra: { game: null, gameState: 'missing' } }));
    add('join_closed', 'Вход закрыт', viewOf(w, { uid: 'late' }));
  }

  cache = out;
  return out;
}

/**
 * Actions that do nothing (and a frozen clock, so timers hold still for screenshots). `run`: the
 * clock runs from the view's `now` on (performance runs: the timer drains, countdowns tick).
 */
export function fixtureActions(view: PlayerView, run = false): PlayerActions {
  const t0 = Date.now();
  return {
    checkName: checkedName,
    join: async () => ({ ok: false, error: 'offline' }),
    answer: async () => ({ ok: true }),
    react: async () => ({ ok: true }),
    now: run ? () => view.now + (Date.now() - t0) : () => view.now,
    media: async (id: string) => {
      const url = fakePictureFor(id);
      if (!url) throw new Error('no media in fixtures');
      // like the real download: the file arrives a moment later
      await new Promise((r) => setTimeout(r, 350));
      return url;
    },
    haptic: () => undefined,
  };
}
