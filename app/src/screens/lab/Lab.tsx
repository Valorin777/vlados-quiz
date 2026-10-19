// #/lab — the design-system lab: every primitive, the key moments (phone + TV) in both modes,
// replayable beats, tier switcher, sound board. Built only from app/src/visual.

import { gsap } from 'gsap';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import {
  Avatar,
  AvatarOrbit,
  AvatarStack,
  Badge,
  ChromeButton,
  ChromeField,
  ChromeText,
  Countdown,
  LiquidStage,
  Modal,
  ModeToggle,
  NumberInput,
  Odometer,
  OptionTile,
  OrderList,
  QRCode,
  ReactionBar,
  ReactionLayer,
  SelfieViewfinder,
  Sheet,
  TimerBar,
  TimerTube,
  ToastHost,
  audio,
  beats,
  forceReducedMotion,
  generateChromeAvatar,
  reducedMotion,
  saveTier,
  savedTier,
  toast,
  useAppearance,
  type EngineStats,
  type LiquidEngine,
  type OptionState,
  type OrbitPlayer,
  type ReactionItem,
  type SelfieResult,
  type Tier,
} from '../../visual';
import { HeroDrops } from './HeroDrops';
import { Switch } from './Switch';
import { GUESTS, QUESTION, YOU, mercuryPortrait } from './labData';
import { Moments } from './moments/Moments';
import './lab.css';

const PARTY = Date.parse('2026-09-26T19:00:00+03:00');

function Card({ n, title, note, wide, children }: { n: string; title: string; note?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <section className={`lab-card${wide ? ' is-wide' : ''}`} aria-label={title}>
      <header className="lab-card-h">
        <span className="vx-kick">{n}</span>
        <h3 className="lab-card-t">{title}</h3>
      </header>
      {note ? <p className="vx-small lab-card-note">{note}</p> : null}
      <div className="lab-card-b">{children}</div>
    </section>
  );
}

/**
 * Masonry for the primitives grid: cards keep their natural height and each spans as many
 * 4-px rows as it needs (grid-auto-flow: dense backfills the holes next to wide cards).
 */
function useMasonry(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const grid = ref.current;
    if (!grid || typeof ResizeObserver !== 'function') return;
    const cards = Array.from(grid.children) as HTMLElement[];
    // rows are 4 px with no row gap; the vertical gap is each card's margin-bottom
    const fit = (el: HTMLElement) => {
      const h = el.getBoundingClientRect().height + (parseFloat(getComputedStyle(el).marginBottom) || 0);
      el.style.gridRowEnd = `span ${Math.max(1, Math.ceil(h / 4))}`;
    };
    const ro = new ResizeObserver((es) => {
      for (const e of es) fit(e.target as HTMLElement);
    });
    for (const c of cards) {
      fit(c);
      ro.observe(c);
    }
    grid.classList.add('is-masonry');
    return () => {
      ro.disconnect();
      grid.classList.remove('is-masonry');
    };
  }, [ref]);
}

function useSound(): boolean {
  return useSyncExternalStore(
    (f) => audio.subscribe(f),
    () => audio.on,
    () => false,
  );
}

// ------------------------------------------------------------------ cards

function TypeCard() {
  const hero = useRef<HTMLElement | null>(null);
  return (
    <Card n="02" title="Шрифты и роли" note="Unbounded — заголовки, Geologica — текст, JetBrains Mono — цифры и подписи. Самохостинг: latin + кириллица.">
      <div className="lab-type">
        <ChromeText ref={hero} split="chars" size="hero" className="lab-type-hero">
          ВЛАДОС
        </ChromeText>
        <ChromeButton size="s" variant="ghost" onClick={() => beats.riseLetters(hero.current)}>
          ↻ буквы всплывают
        </ChromeButton>
        <p className="vx-h1">Заголовок H1</p>
        <p className="vx-h2">Заголовок H2</p>
        <p className="vx-h3">Заголовок H3 — вопрос</p>
        <p className="vx-lead">Лид: Куда Владос сбежит, если выиграет миллион?</p>
        <p className="vx-body">Текст: живой квиз на днюхе. Отвечаешь с телефона, все смотрят на большой экран. Кто быстрее, тому больше очков.</p>
        <p className="vx-small">Мелкий: смотри на экран — там решается всё</p>
        <p className="vx-kick">Кикер · вопрос 4 из 12 · 26.09</p>
        <p className="vx-mono lab-mono">0123456789 · 8 810 очков · 0:23</p>
      </div>
    </Card>
  );
}

const SWATCHES = ['--bg', '--bg-raised', '--bg-sunken', '--line', '--fg-strong', '--fg', '--fg-2', '--fg-muted', '--accent', '--hot', '--bad', '--on-chrome'];

function Swatch({ v }: { v: string }) {
  const el = useRef<HTMLDivElement | null>(null);
  const [val, setVal] = useState('');
  const { mode } = useAppearance();
  useEffect(() => {
    const t = setTimeout(() => el.current && setVal(getComputedStyle(el.current).getPropertyValue(v).trim()), 700);
    return () => clearTimeout(t);
  }, [v, mode]);
  return (
    <div className="lab-sw" ref={el}>
      <i style={{ background: `var(${v})` }} />
      <span className="vx-mono">{v}</span>
      <small className="vx-mono">{val}</small>
    </div>
  );
}

function TokensCard() {
  return (
    <Card n="03" title="Токены цвета" note="Светлая тема — не инверсия: жемчужный фон, тёмная полоса горизонта в отражениях, гравировка графитом, плёнка сильнее. Весь текст ≥ 4.5:1.">
      <div className="lab-sws">
        {SWATCHES.map((v) => (
          <Swatch key={v} v={v} />
        ))}
      </div>
      <div className="lab-fills">
        <div className="lab-fill" style={{ background: 'var(--chrome)' }}>
          <span className="vx-eng">--chrome</span>
        </div>
        <div className="lab-fill" style={{ background: 'var(--chrome-band)' }}>
          <span className="vx-eng">--chrome-band</span>
        </div>
        <div className="lab-fill" style={{ background: 'var(--film-fill)' }}>
          <span className="vx-eng">--film-fill</span>
        </div>
        <div className="lab-fill" style={{ background: 'var(--tarnish)' }}>
          <span style={{ color: 'var(--on-tarnish)' }}>--tarnish</span>
        </div>
      </div>
    </Card>
  );
}

function ButtonsCard() {
  const [busy, setBusy] = useState(false);
  return (
    <Card n="04" title="Кнопки и бейджи" note="Жидкая таблетка: проседает под пальцем, отпружинивает с волной. Film — радужная для особых действий.">
      <div className="lab-stack">
        <ChromeButton block>Дальше</ChromeButton>
        <div className="lab-row">
          <ChromeButton size="m" variant="film">
            Начать игру
          </ChromeButton>
          <ChromeButton size="m" disabled>
            Недоступно
          </ChromeButton>
        </div>
        <div className="lab-row">
          <ChromeButton
            size="m"
            loading={busy}
            onClick={() => {
              setBusy(true);
              setTimeout(() => setBusy(false), 1800);
            }}
          >
            Отправить
          </ChromeButton>
          <ChromeButton size="s">Маленькая</ChromeButton>
          <ChromeButton variant="ghost">Пропустить</ChromeButton>
        </div>
        <div className="lab-row">
          <Badge liquid>×2</Badge>
          <Badge size="l">×2</Badge>
          <Badge tone="chrome">ты</Badge>
          <Badge tone="hot">осталось 10 с</Badge>
          <Badge tone="quiet">Владос</Badge>
        </div>
      </div>
    </Card>
  );
}

function FieldCard() {
  const [v, setV] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <Card n="05" title="Поле ввода" note="Каждое нажатие — блик и капля. Ошибка — встряска и потускнение.">
      <form
        className="lab-stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!v.trim()) setErr('Напиши хоть что-нибудь — хоть «Владос-2»');
          else {
            setErr(null);
            toast(`Привет, ${v.trim()}!`, { tone: 'good' });
          }
        }}
      >
        <ChromeField label="Как подписать тебя на экране?" value={v} onChange={(x) => { setV(x); setErr(null); }} placeholder="Например, Димон" maxLength={20} error={err} hint="от 1 до 20 символов, можно эмодзи" enterKeyHint="go" autoComplete="off" />
        <ChromeButton type="submit" block>
          Проверить
        </ChromeButton>
      </form>
    </Card>
  );
}

const STATES: OptionState[] = ['idle', 'selected', 'locked', 'correct', 'wrong', 'melting'];
const STATE_RU: Record<OptionState, string> = { idle: 'idle', selected: 'selected (мой)', locked: 'locked', correct: 'correct', wrong: 'wrong', melting: 'melting' };

function OptionsCard() {
  const [live, setLive] = useState<OptionState>('idle');
  const people = useMemo(() => GUESTS.slice(0, 9).map((name, i) => ({ id: `p${i}`, name, src: i === 2 ? mercuryPortrait() : null })), []);
  return (
    <Card n="06" title="Варианты ответа" note="Состояния: idle / selected / locked / correct (вспышка + фонтан) / wrong / melting (тускнеет, оседает, капает). Счётчик и аватары — на раскрытии.">
      <div className="lab-stack">
        {STATES.map((s, i) => (
          <OptionTile key={s} label={`${QUESTION.options[i % 4]} · ${STATE_RU[s]}`} state={s} count={s === 'correct' || s === 'wrong' ? [17, 5][i % 2] : undefined} people={s === 'correct' ? people : undefined} onSelect={() => toast('Выбрано')} />
        ))}
        <p className="vx-kick lab-mt">живой вариант — переключай состояния</p>
        <OptionTile label="Купит PS6 и не выйдет из дома" keyLabel="C" state={live} count={live === 'correct' ? 17 : undefined} people={live === 'correct' ? people : undefined} onSelect={() => setLive('selected')} />
        <div className="lab-row lab-wrap">
          {STATES.map((s) => (
            <button key={s} type="button" className={`lab-chip${live === s ? ' is-on' : ''}`} onClick={() => setLive(s)}>
              {s}
            </button>
          ))}
        </div>
      </div>
    </Card>
  );
}

function NumberCard() {
  const [v, setV] = useState<number | null>(null);
  return (
    <Card n="07" title="Ввод числа" note="Клавиатура + ртутный ползунок, оба правят одно значение. Отправка зажимает в [min, max].">
      <NumberInput value={v} onChange={setV} min={1995} max={2026} onSubmit={(x) => toast(`Ответ: ${x}`, { tone: 'good' })} label="В каком году Владос сел за руль?" />
    </Card>
  );
}

const ORDER_ITEMS = [
  { id: 'l1', text: 'Первый раз пошёл в школу', plain: 'Первый раз пошёл в школу' },
  { id: 'l2', text: 'Получил права', plain: 'Получил права' },
  { id: 'l3', text: 'Устроился на первую работу', plain: 'Устроился на первую работу' },
  { id: 'l4', text: 'Переехал в свою квартиру', plain: 'Переехал в свою квартиру' },
];

function OrderCard() {
  const [order, setOrder] = useState(['l3', 'l1', 'l4', 'l2']);
  return (
    <Card n="08" title="Порядок" note="Тяни (dnd-kit: палец, мышь, клавиатура) или коснись двух пунктов — поменяются местами с FLIP-перетеканием.">
      <OrderList items={ORDER_ITEMS} order={order} onChange={setOrder} />
    </Card>
  );
}

function TimersCard() {
  const [ends, setEnds] = useState(() => Date.now() + 20_000);
  const [hot, setHot] = useState(false);
  return (
    <Card n="09" title="Таймеры" note="Телефон: ртутная полоска. ТВ: термометр, секунды едут по мениску. За 10 с — горячий режим: тиканье, закипание сцены." wide>
      <div className="lab-timers">
        <div className="lab-stack lab-grow">
          <TimerBar endsAt={ends} total={20} onHurry={setHot} sound />
          <div className="lab-row">
            <ChromeButton size="s" onClick={() => setEnds(Date.now() + 20_000)}>
              ↻ 20 секунд
            </ChromeButton>
            <ChromeButton size="s" onClick={() => setEnds(Date.now() + 11_000)}>
              сразу к 10 с
            </ChromeButton>
            {hot ? <Badge tone="hot">горячо</Badge> : null}
          </div>
          <p className="vx-kick lab-mt">до начала вечеринки</p>
          <Countdown target={PARTY} />
        </div>
        <div className="lab-tube">
          <TimerTube endsAt={ends} total={20} height={300} marks={[20, 15, 10, 5, 0]} />
        </div>
      </div>
    </Card>
  );
}

function OdometerCard() {
  const [n, setN] = useState(8810);
  return (
    <Card n="10" title="Одометр" note="Цифры прокатываются с перелётом; новые разряды растут слева.">
      <div className="lab-stack">
        <div className="lab-odo">
          <Odometer value={n} chrome />
        </div>
        <div className="lab-row lab-wrap">
          <ChromeButton size="s" onClick={() => setN((x) => x + 137)}>
            +137
          </ChromeButton>
          <ChromeButton size="s" onClick={() => setN((x) => x + 1720)}>
            +1 720
          </ChromeButton>
          <ChromeButton size="s" onClick={() => setN((x) => Math.max(0, x - 50))}>
            −50
          </ChromeButton>
          <ChromeButton size="s" onClick={() => setN(Math.round(Math.random() * 99999))}>
            случайно
          </ChromeButton>
        </div>
      </div>
    </Card>
  );
}

function AvatarsCard() {
  const [gen, setGen] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    void generateChromeAvatar('Лёша').then((r) => {
      url = r.url;
      setGen(r.url);
    });
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, []);
  const people = useMemo(() => GUESTS.slice(0, 7).map((name, i) => ({ id: `a${i}`, name, src: i === 1 ? mercuryPortrait() : null })), []);
  return (
    <Card n="11" title="Аватары" note="Хромовая сфера с селфи или гравированной буквой. Жидкими делаем только «героев», толпа — CSS-хром.">
      <div className="lab-stack">
        <div className="lab-row lab-av-row">
          <Avatar name="Маша" size="xs" />
          <Avatar name="Лёха" size="s" />
          <Avatar name="Катя" size="m" />
          <Avatar name={YOU} src={mercuryPortrait()} size="l" liquid you />
          <Avatar name="Лёша" src={gen} size="xl" liquid />
        </div>
        <div className="lab-row lab-av-row">
          <Avatar name="Ещё не ответил" size="m" tar={0.9} />
          <Avatar name="🚀 Артём" size="m" />
          <AvatarStack people={people} max={4} size={28} />
        </div>
      </div>
    </Card>
  );
}

function OrbitCard() {
  const [players, setPlayers] = useState<OrbitPlayer[]>(() => GUESTS.slice(0, 16).map((name, i) => ({ id: `o${i}`, name, src: i === 3 ? mercuryPortrait() : null })));
  const [hi, setHi] = useState<string | null>(null);
  return (
    <Card n="12" title="Созвездие лобби (ТВ)" note="Ядро растёт с каждым гостем; новые влетают кометой, брызгают и уходят на орбиту. До ~120 гостей на 4 кольцах." wide>
      <div className="lab-orbit">
        <AvatarOrbit players={players} highlightId={hi}>
          <b className="vx-eng lab-orbit-n">
            <Odometer value={players.length} />
          </b>
          <span className="vx-eng vx-kick">в игре</span>
        </AvatarOrbit>
      </div>
      <div className="lab-row lab-wrap">
        <ChromeButton size="s" variant="film" onClick={() => setPlayers((p) => [...p, { id: `o${p.length}-${Date.now()}`, name: GUESTS[p.length % GUESTS.length] ?? 'Гость' }])}>
          + гость
        </ChromeButton>
        <ChromeButton
          size="s"
          onClick={() => {
            const id = `you-${Date.now()}`;
            setHi(id);
            setPlayers((p) => [...p, { id, name: YOU, src: mercuryPortrait() }]);
          }}
        >
          + ты (большой всплеск)
        </ChromeButton>
        <ChromeButton size="s" variant="ghost" onClick={() => setPlayers((p) => p.slice(0, 8))}>
          сброс
        </ChromeButton>
      </div>
    </Card>
  );
}

function QRCard() {
  return (
    <Card n="13" title="QR на хромовой пластине" note="Настоящий QR (пакет qrcode грузится лениво — телефоны его не качают), чёткий SVG на светлой грани.">
      <div className="lab-center">
        <QRCode value="https://valorin777.github.io/vlados/" size={200} />
        <p className="vx-mono lab-mono">valorin777.github.io/vlados</p>
      </div>
    </Card>
  );
}

function ReactionsCard() {
  const [items, setItems] = useState<ReactionItem[]>([]);
  const seq = useRef(0);
  const push = (e: number, name: string) => {
    seq.current += 1;
    const id = `x${seq.current}`;
    setItems((xs) => [...xs.slice(-30), { id, e, name }]);
  };
  return (
    <Card n="14" title="Реакции" note="Телефон: капли-кнопки, эмодзи брызгают вверх. ТВ: летят снизу с именем, качаются, по жидкости — круги." wide>
      <div className="lab-rx">
        <ReactionLayer items={items} from={0.08} to={0.92} />
        <p className="vx-kick lab-rx-cap">слой реакций большого экрана</p>
      </div>
      <div className="lab-row lab-wrap">
        <ReactionBar onReact={(i) => push(i, YOU)} className="lab-grow" />
        <ChromeButton size="s" variant="ghost" onClick={() => GUESTS.slice(0, 12).forEach((n, k) => setTimeout(() => push(k % 8, n), k * 120))}>
          залп от гостей
        </ChromeButton>
      </div>
    </Card>
  );
}

function OverlaysCard() {
  const [sheet, setSheet] = useState(false);
  const [modal, setModal] = useState(false);
  const [v, setV] = useState('');
  return (
    <Card n="15" title="Тосты, шторка, модалка" note="Всё, что парит над контентом, — CSS-хром и стекло (жидкость внутри выключена: LiquidOff).">
      <div className="lab-row lab-wrap">
        <ChromeButton size="s" onClick={() => toast('Ответ принят')}>
          тост
        </ChromeButton>
        <ChromeButton size="s" onClick={() => toast('+860 очков!', { tone: 'good' })}>
          тост: успех
        </ChromeButton>
        <ChromeButton size="s" onClick={() => toast('Связь пропала, возвращаемся…', { tone: 'bad' })}>
          тост: беда
        </ChromeButton>
        <ChromeButton size="s" variant="film" onClick={() => setSheet(true)}>
          шторка
        </ChromeButton>
        <ChromeButton size="s" onClick={() => setModal(true)}>
          модалка
        </ChromeButton>
      </div>
      <Sheet open={sheet} onClose={() => setSheet(false)} title="Настройки">
        <p className="vx-body">Тема и звук — на этом устройстве.</p>
        <ModeToggle />
        <ChromeField label="Имя" value={v} onChange={setV} placeholder="Например, Димон" />
        <ChromeButton block onClick={() => setSheet(false)}>
          Готово
        </ChromeButton>
      </Sheet>
      <Modal open={modal} onClose={() => setModal(false)} title="Пауза">
        <p className="vx-body">Организатор поставил игру на паузу. Сейчас продолжим.</p>
        <ChromeButton block variant="film" onClick={() => setModal(false)}>
          Понятно
        </ChromeButton>
      </Modal>
    </Card>
  );
}

function SelfieCard() {
  const [res, setRes] = useState<SelfieResult | null>(null);
  const [k, setK] = useState(0);
  useEffect(() => () => {
    if (res) URL.revokeObjectURL(res.url);
  }, [res]);
  return (
    <Card n="16" title="Селфи" note="Круглый ртутный видоискатель, фронтальная камера. 256 px JPEG ≤ 40 КБ + превью 64 px ≤ 6 КБ. Нет камеры → выбор фото; «Пропустить» → буква из ртути.">
      {res ? (
        <div className="lab-center lab-stack">
          <Avatar name={YOU} src={res.url} size={140} liquid />
          <p className="vx-mono lab-mono">
            {res.kind === 'photo' ? 'фото' : 'сгенерировано'} · {Math.round(res.avatar.size / 102.4) / 10} КБ · превью {Math.round(res.thumb.size / 102.4) / 10} КБ
          </p>
          <ChromeButton size="s" onClick={() => { setRes(null); setK((x) => x + 1); }}>
            заново
          </ChromeButton>
        </div>
      ) : (
        <SelfieViewfinder key={k} name={YOU} onDone={setRes} autoStart={false} />
      )}
    </Card>
  );
}

const VOICES: { label: string; play: () => void }[] = [
  { label: 'drop', play: () => audio.drop(1, 0.4) },
  { label: 'bell', play: () => audio.bell(523, 0.12, 1.6) },
  { label: 'tick', play: () => audio.tick(0.5) },
  { label: 'melt', play: () => audio.melt(0.35) },
  { label: 'shine', play: () => audio.shine() },
  { label: 'rise', play: () => audio.rise(0.9) },
  { label: 'boom', play: () => audio.boom() },
  { label: 'shutter', play: () => audio.shutter() },
];

function SoundCard() {
  const on = useSound();
  const [drone, setDrone] = useState(false);
  const [music, setMusic] = useState<'off' | 'calm' | 'hurry'>('off');
  useEffect(() => () => {
    audio.music(false);
    audio.drone(false);
  }, []);
  return (
    <Card n="17" title="Звук" note="Всё синтезируется WebAudio (без файлов), стартует только после жеста пользователя. Общий mute хранится на устройстве.">
      <div className="lab-stack">
        <div className="lab-row lab-wrap">
          <ChromeButton size="s" variant={on ? 'film' : 'chrome'} onClick={() => audio.setMuted(on)}>
            {on ? 'звук включён' : 'включить звук'}
          </ChromeButton>
          <ChromeButton
            size="s"
            onClick={() => {
              audio.unlock();
              audio.drone(!drone);
              setDrone(!drone);
            }}
          >
            {drone ? 'гул: выкл' : 'гул лобби'}
          </ChromeButton>
          <ChromeButton
            size="s"
            onClick={() => {
              audio.unlock();
              const next = music === 'off' ? 'calm' : music === 'calm' ? 'hurry' : 'off';
              setMusic(next);
              audio.music(next !== 'off', next === 'hurry');
            }}
          >
            музыка: {music === 'off' ? 'выкл' : music === 'calm' ? 'спокойно' : 'спешка'}
          </ChromeButton>
        </div>
        <div className="lab-row lab-wrap">
          {VOICES.map((v) => (
            <button
              key={v.label}
              type="button"
              className="lab-chip"
              onClick={() => {
                audio.unlock();
                v.play();
              }}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ page

/** Live engine numbers; subscribes on its own so the page doesn't re-render every second. */
function StatsLine({ engine }: { engine: LiquidEngine | null }) {
  const [s, setS] = useState<EngineStats | null>(() => engine?.stats ?? null);
  useEffect(() => {
    setS(engine?.stats ?? null);
    return engine?.onStats(setS);
  }, [engine]);
  return (
    <p className="vx-mono lab-stats" aria-live="off">
      {s && engine ? `уровень ${s.tier} · ${s.fps} fps · ${s.frameMs || '–'} мс · ${s.blobs} капель · dpr ${s.dpr}${s.lost ? ' · контекст потерян' : ''}` : 'уровень 0 · CSS-хром'}
    </p>
  );
}

const TIERS: { v: Tier | 'auto'; label: string }[] = [
  { v: 'auto', label: 'авто' },
  { v: 0, label: '0 · CSS' },
  { v: 1, label: '1 · эконом' },
  { v: 2, label: '2 · телефон' },
  { v: 3, label: '3 · ТВ' },
];

export function Lab() {
  const [tier, setTier] = useState<Tier | 'auto'>(() => savedTier());
  const [engine, setEngine] = useState<LiquidEngine | null>(null);
  const [rm, setRm] = useState(() => reducedMotion());
  const hero = useRef<HTMLElement | null>(null);
  const grid = useRef<HTMLDivElement | null>(null);
  const on = useSound();
  const [profile] = useState<'phone' | 'tv'>(() => (innerWidth < 800 ? 'phone' : 'tv'));
  useMasonry(grid);

  useEffect(() => {
    audio.setDefaultMuted(true);
    audio.armOnFirstGesture();
    const q = gsap.utils.selector('.lab-hero');
    const t = gsap.timeline();
    t.add(beats.riseLetters(hero.current), 0.2);
    t.add(beats.fadeUp(q('.lab-hero-lead, .lab-rig > *'), { stagger: 0.07 }), 0.75);
    return () => {
      t.kill();
    };
  }, []);

  const pickTier = (t: Tier | 'auto') => {
    saveTier(t);
    setTier(t);
  };

  return (
    <div className="vx lab">
      <LiquidStage profile={profile} tier={tier} onEngine={setEngine}>
        <header className="lab-hero">
          <div className="lab-hero-copy">
            <p className="vx-kick">кто лучше знает владоса · дизайн-система · 26.09</p>
            <ChromeText ref={hero} as="h1" split="chars" className="lab-title">
              Жидкий хром
            </ChromeText>
            <p className="vx-lead lab-hero-lead">Интерфейс вечеринки из ртути, которая слушается пальца: телефон гостя, большой экран и два десятка деталей — живые в обеих темах.</p>
          </div>
          <HeroDrops />
          <div className="lab-rig">
            <div className="lab-rig-g">
              <span className="vx-kick" id="lab-tier-l">
                качество
              </span>
              <div className="lab-seg" role="radiogroup" aria-labelledby="lab-tier-l">
                {TIERS.map((t) => (
                  <button key={String(t.v)} type="button" role="radio" aria-checked={tier === t.v} className={`lab-chip${tier === t.v ? ' is-on' : ''}`} onClick={() => pickTier(t.v)}>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="lab-rig-g">
              <ChromeButton size="s" variant={on ? 'film' : 'chrome'} onClick={() => audio.setMuted(on)} aria-pressed={on}>
                {on ? 'звук включён' : 'включить звук'}
              </ChromeButton>
              <Switch
                checked={rm}
                onChange={(v) => {
                  forceReducedMotion(v ? true : null);
                  setRm(reducedMotion());
                }}
              >
                меньше движения
              </Switch>
            </div>
            <StatsLine engine={engine} />
          </div>
        </header>

        <main className="lab-main">
          <Moments tier={tier} onSolo={(open) => (open ? engine?.pause() : engine?.resume())} />
          <div className="lab-sec-head lab-sec-2">
            <div>
              <p className="vx-kick">02 — 17 · примитивы</p>
              <h2 className="vx-h2">Детали</h2>
            </div>
            <p className="vx-body lab-sec-note">Каждый примитив управляется только пропсами. Жидкое тело — WebGL-капля, приклеенная к элементу; без WebGL (уровень 0) — CSS-хром с бегущим бликом.</p>
          </div>
          <div className="lab-grid" ref={grid}>
            <TypeCard />
            <TokensCard />
            <ButtonsCard />
            <FieldCard />
            <OptionsCard />
            <NumberCard />
            <OrderCard />
            <TimersCard />
            <OdometerCard />
            <AvatarsCard />
            <OrbitCard />
            <QRCard />
            <ReactionsCard />
            <OverlaysCard />
            <SelfieCard />
            <SoundCard />
          </div>
          <footer className="lab-foot">
            <p className="vx-small">
              «Жидкий хром» · app/src/visual · #/lab ·{' '}
              <button type="button" className="lab-link" onClick={() => gsap.globalTimeline.timeScale(gsap.globalTimeline.timeScale() === 1 ? 0.25 : 1)}>
                замедлить всё ×¼
              </button>
            </p>
          </footer>
        </main>
      </LiquidStage>
      <ToastHost />
    </div>
  );
}
