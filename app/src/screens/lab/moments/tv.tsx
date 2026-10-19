// TV halves of the Lab moments (1280 × 720 design px).

import { gsap } from 'gsap';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { flushSync } from 'react-dom';
import {
  Avatar,
  AvatarOrbit,
  Badge,
  ChromeBlock,
  ChromeText,
  Odometer,
  OptionTile,
  QRCode,
  ReactionLayer,
  TimerTube,
  audio,
  beats,
  ease,
  fmtInt,
  useLiquid,
  type Blob,
  type OptionState,
  type OrbitPlayer,
  type ReactionItem,
} from '../../../visual';
import { BOARD, GUESTS, QUESTION, YOU, mercuryPortrait } from '../labData';
import { useReplay } from './common';

const OPT_POS = [
  { x: 76, y: 264 },
  { x: 556, y: 264 },
  { x: 76, y: 412 },
  { x: 556, y: 412 },
];

// ------------------------------------------------------------------ lobby

export function TvLobby({ run, players, highlightId, reactions, onLand }: { run: number; players: OrbitPlayer[]; highlightId: string | null; reactions: ReactionItem[]; onLand: (p: OrbitPlayer) => void }) {
  const root = useRef<HTMLDivElement | null>(null);
  const hero = useRef<HTMLElement | null>(null);
  const [tick, setTick] = useState<{ name: string; you: boolean } | null>(null);
  useReplay(run, () => {
    const q = gsap.utils.selector(root);
    const tl = gsap.timeline();
    tl.add(beats.riseLetters(hero.current, { stagger: 0.045 }), 0.15);
    tl.add(beats.fadeUp(q('.t-fade'), { stagger: 0.06 }), 0.2);
    tl.fromTo(q('.t-qr'), { opacity: 0, scale: 0.9 }, { opacity: 1, scale: 1, duration: 0.8, ease: ease.back }, 0.3);
    return tl;
  });
  return (
    <div className="t-root" ref={root}>
      <p className="t-ab t-kick t-fade">кто лучше знает</p>
      <ChromeText ref={hero} split="chars" className="t-ab t-hero">
        ВЛАДОСА
      </ChromeText>
      <p className="t-ab t-meta vx-kick t-fade">26.09 · 19:00 · днюха</p>
      <div className="t-ab t-qr">
        <QRCode value="https://valorin777.github.io/vlados/" size={238} />
      </div>
      <p className="t-ab t-lnk t-fade">valorin777.github.io/vlados</p>
      <p className="t-ab t-lnk2 t-fade">наведи камеру или открой ссылку из чата</p>
      <div className="t-ab t-cnt t-fade">
        <p className="vx-kick">уже в игре</p>
        <Odometer value={players.length} chrome className="t-cnt-n" />
        <p className="t-cnt-of">из 42 приглашённых</p>
      </div>
      <div className="t-ab t-orbit">
        <AvatarOrbit
          players={players}
          highlightId={highlightId}
          onLand={(p) => {
            setTick({ name: p.name, you: p.id === highlightId });
            onLand(p);
          }}
        />
      </div>
      <p className="t-ab t-tick" aria-live="polite">
        {tick ? (
          <>
            <b>{tick.name}</b> <i>{tick.you ? 'влетает в игру' : '— в игре'}</i>
          </>
        ) : (
          <i>ждём гостей…</i>
        )}
      </p>
      <ReactionLayer items={reactions} />
    </div>
  );
}

// ------------------------------------------------------------------ question

function useFakeAnswers(run: number, active: boolean) {
  const [lit, setLit] = useState<Set<number>>(new Set());
  useEffect(() => {
    setLit(new Set());
    if (!active) return;
    const ids: number[] = [];
    const timers: number[] = [];
    for (let i = 0; i < 41; i++) {
      if (i === 12) continue; // "you" answers from the phone
      ids.push(i);
    }
    ids.forEach((i) => {
      const at = 900 + Math.pow(Math.random(), 1.6) * 9000;
      timers.push(
        window.setTimeout(() => {
          setLit((s) => new Set(s).add(i));
          audio.ping(1 + (i % 7) * 0.09);
        }, at),
      );
    });
    return () => timers.forEach(clearTimeout);
  }, [run, active]);
  return [lit, setLit] as const;
}

const ROWX = (i: number) => 86 + (i % 21) * 44.5;
const ROWY = (i: number) => (i < 21 ? 610 : 656);

export function TvQuestion({ run, youPicked }: { run: number; youPicked: number | null }) {
  const root = useRef<HTMLDivElement | null>(null);
  const title = useRef<HTMLElement | null>(null);
  const [endsAt, setEndsAt] = useState(() => Date.now() + 60_000);
  const [lit] = useFakeAnswers(run, true);
  const avBlobs = useRef<{ current: Blob | null }[]>(Array.from({ length: 42 }, () => ({ current: null })));
  const { engine } = useLiquid();
  const people = useMemo(() => ['Владос', ...GUESTS.slice(0, 11), YOU, ...GUESTS.slice(11, 40)], []);
  const answered = lit.size + (youPicked !== null ? 1 : 0);

  useEffect(() => setEndsAt(Date.now() + 60_000), [run]);
  useReplay(run, () => {
    const q = gsap.utils.selector(root);
    const tl = gsap.timeline();
    tl.add(beats.riseLetters(title.current, { stagger: 0.06 }), 0.15);
    tl.fromTo(q('.t-q-top'), { opacity: 0, x: -12 }, { opacity: 1, x: 0, duration: 0.5 }, 0.1);
    tl.add(beats.popIn(q('.t-opt'), { from: 0.3, stagger: 0.11 }), 0.55);
    tl.call(() => audio.rise(0.6), undefined, 1);
    tl.fromTo(q('.t-tube'), { opacity: 0 }, { opacity: 1, duration: 0.6 }, 0.9);
    return tl;
  });

  // answers light up: tarnish → chrome, glow, ripple
  const prev = useRef<Set<number>>(new Set());
  useEffect(() => {
    const now = new Set(lit);
    if (youPicked !== null) now.add(12);
    for (const i of now) {
      if (prev.current.has(i)) continue;
      const b = avBlobs.current[i]?.current;
      if (b) {
        beats.pulse(b, 1, 0.9);
        engine?.ripple(b.x, b.y, i === 12 ? 0.9 : 0.28);
      }
    }
    prev.current = now;
  }, [lit, youPicked, engine]);

  return (
    <div className="t-root" ref={root}>
      <div className="t-ab t-q-top">
        <span className="vx-kick">
          вопрос {QUESTION.n} из {QUESTION.total}
        </span>
        <Badge liquid size="m">
          ×2
        </Badge>
        <span className="t-x2l">очки удваиваются</span>
      </div>
      <ChromeText ref={title} as="h2" split="words" className="t-ab t-q-title">
        {QUESTION.title}
      </ChromeText>
      {QUESTION.options.map((o, i) => (
        <div key={i} className="t-ab t-opt" style={{ left: OPT_POS[i]?.x, top: OPT_POS[i]?.y }}>
          <OptionTile label={o} keyLabel={'ABCD'[i]} state="locked" className="t-optile" />
        </div>
      ))}
      <div className="t-ab t-tube">
        <TimerTube key={run} endsAt={endsAt} total={60} height={540} driveScene sound />
      </div>
      <div className="t-ab t-ans">
        <b>
          <Odometer value={answered} />
        </b>
        <span>/ 42 ответили</span>
      </div>
      {people.map((n, i) => {
        const on = lit.has(i) || (i === 12 && youPicked !== null) || i === 0;
        return (
          <div key={i} className="t-ab t-row-av" style={{ left: ROWX(i) - 12.5, top: ROWY(i) - 12.5 }}>
            <Avatar name={n} src={i === 12 ? mercuryPortrait() : null} size={25} liquid tar={on ? 0 : 0.85} film={on ? 0.35 : 0.15} blobRef={avBlobs.current[i]} decorative />
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ reveal

export function TvReveal({ run }: { run: number }) {
  const root = useRef<HTMLDivElement | null>(null);
  const tiles = useRef<(HTMLButtonElement | null)[]>([]);
  const blobs = useRef<{ current: Blob | null }[]>(QUESTION.options.map(() => ({ current: null })));
  const [states, setStates] = useState<OptionState[]>(['locked', 'locked', 'locked', 'locked']);
  const [counts, setCounts] = useState<(number | undefined)[]>([undefined, undefined, undefined, undefined]);
  const crowd = useMemo(() => QUESTION.counts.map((n, o) => GUESTS.slice(o * 10, o * 10 + n).map((name, k) => ({ id: `${o}-${k}`, name }))), []);
  useReplay(run, (engine) => {
    setStates(['locked', 'locked', 'locked', 'locked']);
    setCounts([undefined, undefined, undefined, undefined]);
    const q = gsap.utils.selector(root);
    gsap.set(q('.t-rv, .t-rv-v, .t-vlad'), { opacity: 0 });
    gsap.set(tiles.current.filter(Boolean), { clearProps: 'transform,opacity' });
    gsap.set(q('.vx-opt-label'), { clearProps: 'all' });
    const tl = gsap.timeline();
    QUESTION.counts.forEach((n, o) => {
      tl.call(() => {
        setCounts((c) => c.map((v, i) => (i === o ? n : v)));
        audio.drop(0.7 + o * 0.12, 0.3);
      }, undefined, 0.5 + o * 0.12);
    });
    tl.set(q('.t-vlad'), { opacity: 1 }, 1.4);
    tl.fromTo(q('.t-vlad'), { y: -80 }, { y: 0, duration: 0.9, ease: ease.bounce }, 1.4);
    tl.call(() => audio.bell(523, 0.1, 1.2), undefined, 1.7);
    // suspense: the whole surface trembles
    if (engine) {
      tl.call(() => audio.rise(0.55), undefined, 1.9);
      tl.to(engine.scene, { agit: 0.9, duration: 0.45, ease: 'power2.in' }, 2);
      tl.to(engine.scene, { agit: 0, duration: 0.5, ease: 'power2.out' }, 2.5);
    }
    tl.fromTo(tiles.current.filter(Boolean), { scale: 1 }, { scale: 1.05, duration: 0.45, yoyo: true, repeat: 1, ease: 'power2.in' }, 2);
    const wrong = [0, 1, 3];
    wrong.forEach((o, w) => {
      tl.call(() => {
        const el = tiles.current[o];
        beats.meltWrong(engine, blobs.current[o]?.current, { mode: 'away', label: el?.querySelector('.vx-opt-label'), drips: 2 });
        if (el) gsap.to(el.querySelectorAll('.vx-opt-meta, .vx-opt-key'), { opacity: 0, y: 30, duration: 0.6, ease: 'power2.in', delay: 0.4 });
      }, undefined, 2.7 + w * 0.2);
    });
    tl.to(q('.t-vlad'), { rotation: 34, y: 20, opacity: 0, duration: 0.8, ease: 'power2.in' }, 3.3);
    tl.call(() => {
      setStates(['wrong', 'wrong', 'correct', 'wrong']);
    }, undefined, 3.85);
    const c = QUESTION.correct;
    tl.add(() => {
      const el = tiles.current[c];
      const box = el?.parentElement;
      if (!el || !box) return;
      const dx = 640 - (box.offsetLeft + box.offsetWidth / 2);
      const dy = 330 - (box.offsetTop + box.offsetHeight / 2);
      gsap.to(el, { x: dx, y: dy, scale: 1.4, duration: 1.15, ease: 'power3.inOut', delay: 0.75 });
    }, 3.85);
    tl.fromTo(q('.t-rv'), { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.7, ease: 'power3.out' }, 5.4);
    tl.fromTo(q('.t-rv-v'), { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.7 }, 6.1);
    return tl;
  });
  return (
    <div className="t-root" ref={root}>
      <div className="t-ab t-q-top">
        <span className="vx-kick">
          вопрос {QUESTION.n} из {QUESTION.total} · ответ
        </span>
      </div>
      <h2 className="t-ab t-q-title t-q-title-s">{QUESTION.title}</h2>
      {QUESTION.options.map((o, i) => (
        <div key={i} className="t-ab t-opt" style={{ left: OPT_POS[i]?.x, top: OPT_POS[i]?.y }}>
          <OptionTile
            ref={(n) => {
              tiles.current[i] = n;
            }}
            blobRef={blobs.current[i]}
            label={o}
            keyLabel={'ABCD'[i]}
            state={states[i]}
            count={counts[i]}
            people={counts[i] !== undefined ? crowd[i] : undefined}
            className="t-optile"
          />
        </div>
      ))}
      <div className="t-ab t-vlad" style={{ left: OPT_POS[QUESTION.vlados]?.x, top: (OPT_POS[QUESTION.vlados]?.y ?? 0) - 44 }}>
        <Badge tone="hot" size="m">
          выбор Владоса
        </Badge>
      </div>
      <div className="t-ab t-rv">
        <ChromeText as="p" className="t-rv-1">
          {`${QUESTION.counts[QUESTION.correct]} из 41 угадали`}
        </ChromeText>
        <p className="t-rv-2">
          Быстрее всех — <b>Соня</b>, 3,1 сек. Держит планку весь вечер.
        </p>
      </div>
      <p className="t-ab t-rv-v">
        Сам Владос ткнул <b>«На Бали»</b>. Выходит, он себя знает хуже вас.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ leaderboard

const barW = (s: number) => 60 + ((s - 6000) / 4000) * 560;

export function TvBoard({ run }: { run: number }) {
  const root = useRef<HTMLDivElement | null>(null);
  const [order, setOrder] = useState<string[]>(() => BOARD.map((r) => r.id));
  const [phase, setPhase] = useState<'before' | 'after'>('before');
  const bars = useRef(new Map<string, HTMLDivElement | null>());
  const scores = useRef(new Map<string, HTMLElement | null>());
  const mine = useRef<Blob | null>(null);
  const after = useMemo(() => BOARD.slice().sort((a, b) => b.before + b.gain - (a.before + a.gain)).map((r) => r.id), []);
  const rankOf = (id: string, ids: string[]) => ids.indexOf(id);
  // Moments remounts this scene per replay (key={run}), so it always starts from the 'before' order.
  useReplay(run, () => {
    const q = gsap.utils.selector(root);
    const tl = gsap.timeline();
    tl.fromTo(q('.t-b-title'), { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.7 }, 0.05);
    BOARD.forEach((r, k) => {
      const bar = bars.current.get(r.id);
      const sc = scores.current.get(r.id);
      if (sc) sc.textContent = fmtInt(r.before);
      tl.fromTo(q(`[data-flip-id="${r.id}"]`), { opacity: 0, x: -20 }, { opacity: 1, x: 0, duration: 0.4 }, 0.2 + k * 0.06);
      if (bar) tl.fromTo(bar, { width: 44 }, { width: barW(r.before), duration: 1.1, ease: ease.elastic }, 0.2 + k * 0.06);
    });
    tl.call(() => audio.rise(0.7), undefined, 1.4);
    BOARD.forEach((r) => {
      if (!r.gain) return;
      const bar = bars.current.get(r.id);
      if (bar) tl.to(bar, { width: barW(r.before + r.gain), duration: 1, ease: ease.elastic }, 1.5);
      tl.add(
        beats.countTo(r.before, r.before + r.gain, (v) => {
          const sc = scores.current.get(r.id);
          if (sc) sc.textContent = fmtInt(v);
        }, { duration: 1, step: 10 }),
        1.5,
      );
    });
    tl.add(() => {
      const rows = Array.from(root.current?.querySelectorAll('.t-b-row') ?? []);
      beats.boardReorder({
        rows,
        mutate: () =>
          flushSync(() => {
            setOrder(after);
            setPhase('after');
          }),
        badges: () => Array.from(root.current?.querySelectorAll('.t-b-dl') ?? []),
        mine: mine.current,
      });
    }, 2.6);
    return tl;
  });
  const byId = new Map(BOARD.map((r) => [r.id, r]));
  return (
    <div className="t-root" ref={root}>
      <div className="t-ab t-b-title">
        <ChromeText as="h2" className="t-b-h">
          Кто впереди
        </ChromeText>
        <p className="vx-kick">после {QUESTION.n} вопросов</p>
      </div>
      <ol className="t-ab t-b-list">
        {order.map((id) => {
          const r = byId.get(id);
          if (!r) return null;
          const k0 = rankOf(id, BOARD.map((x) => x.id));
          const k1 = rankOf(id, after);
          const d = k0 - k1;
          return (
            <li key={id} data-flip-id={id} className={`t-b-row${r.you ? ' is-me' : ''}`}>
              <span className={`t-b-dl ${phase === 'after' ? (d > 0 ? 'up' : d < 0 ? 'dn' : 'eq') : ''}`}>{phase === 'after' ? (d > 0 ? `▲${d}` : d < 0 ? `▼${-d}` : '—') : ''}</span>
              <span className="t-b-rk">{(phase === 'after' ? k1 : k0) + 1}</span>
              <span className="t-b-nm">{r.name}</span>
              <span className="t-b-barwrap">
                <BoardBar
                  set={(el) => bars.current.set(id, el)}
                  you={!!r.you}
                  out={r.you ? mine : undefined}
                  width={barW(phase === 'after' ? r.before + r.gain : r.before)}
                />
                <b
                  className="t-b-sc"
                  ref={(el) => {
                    scores.current.set(id, el);
                  }}
                >
                  {fmtInt(phase === 'after' ? r.before + r.gain : r.before)}
                </b>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function BoardBar({ set, you, out, width }: { set: (el: HTMLDivElement | null) => void; you: boolean; out?: { current: Blob | null }; width: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  return (
    <ChromeBlock
      ref={(el) => {
        ref.current = el;
        set(el);
      }}
      shape="pill"
      film={you ? 0.8 : 0.34}
      blobRef={out}
      className="t-b-bar"
      style={{ width } as CSSProperties}
    />
  );
}

// ------------------------------------------------------------------ podium

const PODIUM = [
  { name: 'Соня', score: 9820, x: 640, h: 300 },
  { name: 'Макс', score: 9330, x: 360, h: 214 },
  { name: YOU, score: 8810, x: 920, h: 150, you: true },
];
const BASE = 690;

export function TvPodium({ run }: { run: number }) {
  const root = useRef<HTMLDivElement | null>(null);
  const cols = useRef<(HTMLDivElement | null)[]>([]);
  const labels = useRef<(HTMLDivElement | null)[]>([]);
  const avs = useRef<(HTMLDivElement | null)[]>([]);
  const champ = useRef<HTMLParagraphElement | null>(null);
  useReplay(run, (engine) => {
    const q = gsap.utils.selector(root);
    gsap.set([q('.t-verdict'), champ.current], { opacity: 0 });
    const tl = gsap.timeline();
    tl.fromTo(q('.t-f-title'), { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.7 }, 0.05);
    const { tl: pod, blobs } = beats.podiumRise(
      engine,
      PODIUM.map((p, k) => ({ x: p.x, height: p.h, el: cols.current[k], label: labels.current[k], avatarEl: avs.current[k] })),
      {
        baseY: BASE,
        onClimax: () => {
          if (champ.current) gsap.fromTo(champ.current, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.6 });
        },
      },
    );
    tl.add(pod, 0.4);
    tl.fromTo(q('.t-verdict'), { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.9, ease: 'power3.out' }, 4.4);
    return () => {
      tl.kill();
      pod.kill();
      if (engine) for (const b of blobs) engine.remove(b);
    };
  });
  return (
    <div className="t-root" ref={root}>
      <div className="t-ab t-f-title">
        <ChromeText as="h2" className="t-f-h">
          Кто лучше знает Владоса
        </ChromeText>
        <p className="vx-kick">финал · 12 вопросов</p>
      </div>
      <div className="t-ab t-verdict">
        <p className="vx-kick t-hot">Владос против друзей</p>
        <p className="t-vd-1">Друзья знают Владоса лучше, чем он сам</p>
        <p className="t-vd-2">Про себя он угадал 7 из 12. Вы в среднем — 8,3.</p>
      </div>
      {PODIUM.map((p, k) => (
        <div key={k}>
          <ChromeBlock
            ref={(el) => {
              cols.current[k] = el;
            }}
            shape="box"
            radius={20}
            film={k === 0 ? 0.6 : 0.34}
            className="t-pod-col"
            style={{ left: p.x - 112, bottom: 720 - BASE, height: 0 }}
          />
          <div
            ref={(el) => {
              labels.current[k] = el;
            }}
            className="t-pod-label"
          >
            <span className="t-pod-n vx-eng">{k + 1}</span>
            <span className="t-pod-nm vx-eng">{p.name}</span>
            <span className="t-pod-s vx-eng">{fmtInt(p.score)}</span>
          </div>
          <div
            ref={(el) => {
              avs.current[k] = el;
            }}
            className="t-pod-av"
            style={{ left: p.x - 34, top: BASE - p.h - 68 }}
          >
            <Avatar name={p.name} src={p.you ? mercuryPortrait() : null} size={68} liquid you={!!p.you} />
          </div>
        </div>
      ))}
      <p ref={champ} className="t-champ" style={{ left: 640 - 180, top: BASE - 300 - 118 }}>
        чемпион вечера
      </p>
    </div>
  );
}
