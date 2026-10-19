// The key moments of the evening, phone + TV side by side, replayable, in one or both modes.
// «Показ вечера» plays the whole evening on a loop; any device opens full screen
// (also straight from the URL: `?solo=phone|tv&m=lobby#/lab`).

import { gsap } from 'gsap';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { ChromeButton, audio, reducedMotion, useAppearance, useChromeBlob, type OrbitPlayer, type ReactionItem, type Tier } from '../../../visual';
import { Switch } from '../Switch';
import { GUESTS, YOU, mercuryPortrait } from '../labData';
import { DeviceFrame, SoloFrame } from './common';
import { PhoneBoard, PhoneFinal, PhoneJoin, PhoneLobby, PhoneQuestion, PhoneResult } from './phone';
import { TvBoard, TvLobby, TvPodium, TvQuestion, TvReveal } from './tv';

export type MomentId = 'join' | 'lobby' | 'answer' | 'reveal' | 'board' | 'final';
type Solo = 'phone' | 'tv' | null;

const MOMENTS: { id: MomentId; label: string; hint: string; show: number }[] = [
  { id: 'join', label: 'Вход', hint: 'Капля падает в лужу, буквы всплывают. Введи имя → селфи → ты влетаешь на экран с брызгами.', show: 7 },
  { id: 'lobby', label: 'Лобби', hint: 'Гости кометами падают в ядро и уходят на орбиту; реакции летят на экран, в телефоне капает в «бассейн».', show: 10 },
  { id: 'answer', label: 'Ответ', hint: 'Коснись варианта: остальные стекают в него и превращаются в сферу «Ответ принят». На ТВ загораются аватары.', show: 8 },
  { id: 'reveal', label: 'Раскрытие', hint: 'Неверные тускнеют, оплывают и стекают вниз; верный вспыхивает фонтаном и выезжает в центр.', show: 8.5 },
  { id: 'board', label: 'Таблица', hint: 'Полосы дотягиваются до новых очков, строки перетекают на новые места (FLIP), бейджи ▲▼.', show: 7 },
  { id: 'final', label: 'Подиум', hint: '3 → 2 → 1: колонны вырастают с перелётом, аватары падают сверху, у чемпиона — ртутный фонтан.', show: 9 },
];

function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(1200);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

const initialGuests = (): OrbitPlayer[] => GUESTS.slice(0, 12).map((name, i) => ({ id: `g${i}`, name }));

function readQuery(): { solo: Solo; m: MomentId | null } {
  try {
    const q = new URLSearchParams(location.search);
    const solo = q.get('solo');
    const m = q.get('m');
    return {
      solo: solo === 'phone' || solo === 'tv' ? solo : null,
      m: MOMENTS.some((x) => x.id === m) ? (m as MomentId) : null,
    };
  } catch {
    return { solo: null, m: null };
  }
}

// ------------------------------------------------------------------ the moment track

/** Numbered moments of the evening with a liquid thumb that flows between them. */
function MomentTrack({ value, onPick, show, progressKey }: { value: MomentId; onPick: (id: MomentId) => void; show: number; progressKey: number }) {
  const track = useRef<HTMLDivElement | null>(null);
  const thumb = useRef<HTMLSpanElement | null>(null);
  const btns = useRef<(HTMLButtonElement | null)[]>([]);
  const blob = useChromeBlob(thumb, { shape: 'pill', film: 0.5 });
  const first = useRef(true);
  const idx = MOMENTS.findIndex((x) => x.id === value);

  const place = useCallback(
    (animate: boolean) => {
      const t = thumb.current;
      const b = btns.current[idx];
      if (!t || !b) return;
      const x = b.offsetLeft;
      const y = b.offsetTop;
      const w = b.offsetWidth;
      const fromX = Number(gsap.getProperty(t, 'x')) || 0;
      const fromY = Number(gsap.getProperty(t, 'y')) || 0;
      const fromW = Number(gsap.getProperty(t, 'width')) || w;
      gsap.killTweensOf(t);
      if (!animate || reducedMotion() || Math.abs(fromY - y) > 2) {
        gsap.set(t, { x, y, width: w });
        return;
      }
      // stretch across both segments, then pull in: surface tension
      const left = Math.min(fromX, x);
      const right = Math.max(fromX + fromW, x + w);
      gsap
        .timeline()
        .to(t, { x: left, width: right - left, duration: 0.2, ease: 'power2.in' })
        .to(t, { x, width: w, duration: 0.75, ease: 'elastic.out(1,0.6)' });
      if (blob.current) gsap.fromTo(blob.current, { glow: 0.4 }, { glow: 0, duration: 0.9 });
    },
    [idx, blob],
  );

  useLayoutEffect(() => {
    place(!first.current);
    first.current = false;
  }, [place]);

  useEffect(() => {
    const el = track.current;
    if (!el || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(() => place(false));
    ro.observe(el);
    return () => ro.disconnect();
  }, [place]);

  return (
    <div ref={track} className="lab-track" role="tablist" aria-label="Момент вечера">
      <span ref={thumb} className="lab-track-thumb lq" aria-hidden="true">
        {show ? <i key={progressKey} className="lab-track-prog" style={{ animationDuration: `${show}s` }} /> : null}
      </span>
      {MOMENTS.map((x, i) => (
        <button
          key={x.id}
          ref={(n) => {
            btns.current[i] = n;
          }}
          type="button"
          role="tab"
          aria-selected={x.id === value}
          tabIndex={x.id === value ? 0 : -1}
          className={`lab-track-b${x.id === value ? ' is-on' : ''}`}
          onClick={() => onPick(x.id)}
          onKeyDown={(e) => {
            const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
            if (!d) return;
            e.preventDefault();
            const n = (i + d + MOMENTS.length) % MOMENTS.length;
            const next = MOMENTS[n];
            if (next) {
              onPick(next.id);
              btns.current[n]?.focus();
            }
          }}
        >
          <small>{String(i + 1).padStart(2, '0')}</small>
          <span>{x.label}</span>
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ moments

export function Moments({ tier, onSolo }: { tier: Tier | 'auto'; onSolo?: (open: boolean) => void }) {
  const [query] = useState(readQuery);
  const [m, setM] = useState<MomentId>(query.m ?? 'lobby');
  const [run, setRun] = useState(0);
  const [both, setBoth] = useState(false);
  const [good, setGood] = useState(true);
  const [show, setShow] = useState(false);
  const [solo, setSolo] = useState<Solo>(query.solo);
  const [players, setPlayers] = useState<OrbitPlayer[]>(initialGuests);
  const [you, setYou] = useState<{ name: string; src: string | null }>({ name: YOU, src: null });
  const [highlight, setHighlight] = useState<string | null>(null);
  const [reactions, setReactions] = useState<ReactionItem[]>([]);
  const [drop, setDrop] = useState({ n: 0, big: false });
  const [picked, setPicked] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);
  const width = useWidth(wrap);
  const { mode } = useAppearance();
  const other = mode === 'dark' ? 'light' : 'dark';
  const seq = useRef(0);
  const youRef = useRef(you);
  youRef.current = you;
  const soloCb = useRef(onSolo);
  soloCb.current = onSolo;

  useEffect(() => {
    setYou((y) => (y.src ? y : { ...y, src: mercuryPortrait() }));
  }, []);

  const pick = useCallback((id: MomentId) => {
    setM(id);
    setRun((r) => r + 1);
  }, []);
  const replay = () => setRun((r) => r + 1);
  const next = useCallback(() => {
    setM((cur) => {
      const i = MOMENTS.findIndex((x) => x.id === cur);
      return MOMENTS[(i + 1) % MOMENTS.length]?.id ?? cur;
    });
    setRun((r) => r + 1);
  }, []);

  // «Показ вечера»: the whole evening on a loop
  useEffect(() => {
    if (!show) return;
    const cur = MOMENTS.find((x) => x.id === m);
    const id = window.setTimeout(next, (cur?.show ?? 8) * 1000);
    return () => clearTimeout(id);
  }, [show, m, run, next]);

  // full screen: pause the page's own liquid underneath
  useEffect(() => {
    if (solo === null) return;
    soloCb.current?.(true);
    const html = document.documentElement;
    html.classList.add('lab-solo-open');
    return () => {
      html.classList.remove('lab-solo-open');
      soloCb.current?.(false);
    };
  }, [solo]);

  const addGuest = useCallback((name?: string, id?: string) => {
    setPlayers((ps) => {
      if (ps.length >= 41 && !id) return ps;
      const nm = name ?? GUESTS[ps.length % GUESTS.length] ?? 'Гость';
      return [...ps.filter((p) => !id || p.id !== id), { id: id ?? `g${ps.length}-${Date.now()}`, name: nm, src: id === 'you' ? youRef.current.src : null }];
    });
  }, []);

  const react = useCallback((e: number, name: string) => {
    seq.current += 1;
    const id = `r${seq.current}`;
    setReactions((rs) => [...rs.slice(-30), { id, e, name }]);
  }, []);

  // lobby / join: guests keep arriving and reacting while the moment is on
  useEffect(() => {
    setPicked(null);
    if (m !== 'lobby' && m !== 'join') return;
    setPlayers(initialGuests());
    setHighlight(null);
    const timers: number[] = [];
    const n = m === 'lobby' ? 14 : 6;
    for (let k = 0; k < n; k++) timers.push(window.setTimeout(() => addGuest(), 700 + k * (m === 'lobby' ? 420 : 900)));
    for (let k = 0; k < (m === 'lobby' ? 9 : 4); k++)
      timers.push(window.setTimeout(() => react(Math.floor(Math.random() * 8), GUESTS[Math.floor(Math.random() * 20)] ?? 'Гость'), 1000 + k * 750 + Math.random() * 300));
    if (m === 'lobby')
      timers.push(
        window.setTimeout(() => {
          setHighlight('you');
          addGuest(youRef.current.name, 'you');
        }, 700 + n * 420 + 400),
      );
    return () => timers.forEach(clearTimeout);
  }, [m, run, addGuest, react]);

  const wide = width >= 1100;
  const phones = both ? 2 : 1;
  const phoneScale = wide ? Math.min(0.7, (width * 0.34) / (390 * phones)) : Math.min(0.9, (width - 24 * (phones - 1)) / (390 * phones));
  const tvScale = wide ? Math.min(0.78, (width - 390 * phoneScale * phones - 28 * phones) / 1280) : Math.min(1, width / 1280);

  const phoneScene = (key: string) => {
    switch (m) {
      case 'join':
        return (
          <PhoneJoin
            key={key}
            run={run}
            onJoined={(name, src) => {
              if (key !== 'main') return;
              setYou({ name, src });
              setHighlight('you');
              setPlayers((ps) => [...ps.filter((p) => p.id !== 'you'), { id: 'you', name, src }]);
            }}
          />
        );
      case 'lobby':
        return <PhoneLobby key={key} run={run} count={players.length} you={you} drop={drop} onReact={(e) => react(e, you.name)} />;
      case 'answer':
        return <PhoneQuestion key={key} run={run} autoPick={show ? 2 : undefined} onPick={(i) => key === 'main' && setPicked(i)} />;
      case 'reveal':
        return <PhoneResult key={key} run={run} good={good} />;
      case 'board':
        return <PhoneBoard key={key} run={run} />;
      case 'final':
        return <PhoneFinal key={key} run={run} you={you} />;
    }
  };
  const tvScene = () => {
    switch (m) {
      case 'join':
      case 'lobby':
        return (
          <TvLobby
            run={run}
            players={players}
            highlightId={highlight}
            reactions={reactions}
            onLand={(p) => setDrop((d) => ({ n: d.n + 1, big: p.id === 'you' }))}
          />
        );
      case 'answer':
        return <TvQuestion run={run} youPicked={picked} />;
      case 'reveal':
        return <TvReveal run={run} />;
      case 'board':
        return <TvBoard key={run} run={run} />;
      case 'final':
        return <TvPodium run={run} />;
    }
  };
  const cur = MOMENTS.find((x) => x.id === m);
  const expand = (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );

  return (
    <section className="lab-moments" aria-labelledby="lab-moments-h">
      <div className="lab-sec-head">
        <div>
          <p className="vx-kick">01 · моменты вечера</p>
          <h2 id="lab-moments-h" className="vx-h2">
            Телефон и большой экран
          </h2>
        </div>
        <p className="vx-body lab-sec-note">{cur?.hint}</p>
      </div>
      <div className="lab-bar">
        <MomentTrack
          value={m}
          onPick={(id) => {
            audio.drop(1.2, 0.2);
            pick(id);
          }}
          show={show ? (cur?.show ?? 0) : 0}
          progressKey={run}
        />
        <div className="lab-bar-act">
          <ChromeButton
            size="s"
            variant={show ? 'film' : 'chrome'}
            aria-pressed={show}
            onClick={() => {
              if (!show) replay();
              setShow((v) => !v);
            }}
            icon={
              show ? (
                <svg viewBox="0 0 16 16">
                  <path d="M4.5 3h2.2v10H4.5zM9.3 3h2.2v10H9.3z" fill="currentColor" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16">
                  <path d="M4 2.8v10.4a.6.6 0 0 0 .9.5l8.2-5.2a.6.6 0 0 0 0-1L4.9 2.3a.6.6 0 0 0-.9.5z" fill="currentColor" />
                </svg>
              )
            }
          >
            {show ? 'пауза' : 'показ вечера'}
          </ChromeButton>
          <ChromeButton size="s" variant="ghost" onClick={replay}>
            ↻ повторить
          </ChromeButton>
          {m === 'lobby' || m === 'join' ? (
            <ChromeButton size="s" variant="ghost" onClick={() => addGuest()}>
              + гость
            </ChromeButton>
          ) : null}
          {m === 'reveal' ? (
            <ChromeButton
              size="s"
              variant="ghost"
              onClick={() => {
                setGood((g) => !g);
                replay();
              }}
            >
              {good ? 'показать «Мимо»' : 'показать «В точку»'}
            </ChromeButton>
          ) : null}
          <Switch checked={both} onChange={setBoth}>
            оба режима
          </Switch>
        </div>
      </div>
      <div ref={wrap} className={`lab-devices${wide ? ' is-wide' : ''}`}>
        {solo ? (
          <p className="vx-small lab-solo-note">Сейчас открыт полноэкранный показ.</p>
        ) : (
          <>
            <div className="lab-phones">
              <DeviceFrame
                kind="phone"
                scale={phoneScale}
                tier={tier}
                caption={both ? `телефон · ${mode === 'dark' ? 'тёмная' : 'светлая'}` : 'телефон гостя'}
                action={
                  <button type="button" className="lab-dev-x" onClick={() => setSolo('phone')} aria-label="Телефон на весь экран">
                    {expand}
                  </button>
                }
              >
                {phoneScene('main')}
              </DeviceFrame>
              {both ? (
                <DeviceFrame kind="phone" scale={phoneScale} tier={tier} mode={other} caption={`телефон · ${other === 'dark' ? 'тёмная' : 'светлая'}`}>
                  {phoneScene('alt')}
                </DeviceFrame>
              ) : null}
            </div>
            <DeviceFrame
              kind="tv"
              scale={tvScale}
              tier={tier}
              caption="большой экран · 16:9"
              action={
                <button type="button" className="lab-dev-x" onClick={() => setSolo('tv')} aria-label="Большой экран на весь экран">
                  {expand}
                </button>
              }
            >
              {tvScene()}
            </DeviceFrame>
          </>
        )}
      </div>
      {solo ? (
        <SoloFrame
          kind={solo}
          tier={tier}
          label={`${cur?.label ?? ''} · ${solo === 'phone' ? 'телефон' : 'большой экран'}`}
          onClose={() => setSolo(null)}
          onReplay={replay}
          onNext={next}
        >
          {solo === 'phone' ? phoneScene('main') : tvScene()}
        </SoloFrame>
      ) : null}
    </section>
  );
}
