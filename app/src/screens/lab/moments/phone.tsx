// Phone halves of the Lab moments (390 × 844 design px).

import { gsap } from 'gsap';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  Avatar,
  Badge,
  ChromeBlock,
  ChromeButton,
  ChromeField,
  ChromeText,
  Odometer,
  OptionTile,
  ReactionBar,
  SelfieViewfinder,
  TimerBar,
  audio,
  beats,
  ease,
  fmtClock,
  useLiquid,
  type Blob,
  type SelfieResult,
} from '../../../visual';
import { QUESTION, YOU } from '../labData';
import { useReplay } from './common';

// ------------------------------------------------------------------ join

export function PhoneJoin({ run, onJoined }: { run: number; onJoined: (name: string, src: string | null) => void }) {
  const [step, setStep] = useState<'a' | 'b' | 'c'>('a');
  const [nick, setNick] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [me, setMe] = useState<{ name: string; src: string | null } | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const hero = useRef<HTMLElement | null>(null);
  const puddle = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setStep('a');
    setNick('');
    setErr(null);
  }, [run]);

  useReplay(
    run,
    (engine) => {
      if (step !== 'a') return;
      const q = gsap.utils.selector(root);
      const tl = gsap.timeline();
      tl.add(beats.fadeUp(q('.m-fade-1')), 0.1);
      tl.add(beats.riseLetters(hero.current), 0.8);
      tl.add(beats.fadeUp(q('.m-fade')), 1.1);
      tl.add(beats.popIn(q('.m-pop')), 1.4);
      const pu = puddle.current;
      if (pu) tl.fromTo(pu, { scaleX: 0, scaleY: 0 }, { scaleX: 1, scaleY: 1, duration: 1.1, ease: ease.elastic }, 0.72);
      if (engine && pu) {
        const p = engine.measure(pu);
        const d = engine.add({ x: p.x, y: -60, r: 22, film: 0.6, prio: 1 });
        tl.to(d, { y: p.y - 4, duration: 0.62, ease: 'power2.in' }, 0.12);
        tl.to(d, { ay: -26, duration: 0.3, yoyo: true, repeat: 1 }, 0.3);
        tl.to(d, { r: 0, duration: 0.3, ease: 'power2.in', onComplete: () => engine.remove(d) }, 0.72);
        tl.call(() => {
          engine.ripple(p.x, p.y, 1);
          audio.drop(0.55, 0.5);
        }, undefined, 0.72);
      }
      tl.call(() => {
        audio.drop(1.1, 0.3);
        audio.drop(1.3, 0.25, 0.12);
      }, undefined, 1.4);
      return tl;
    },
    [step],
  );

  const next = () => {
    const v = nick.trim();
    if (!v) {
      setErr('Напиши хоть что-нибудь — хоть «Владос-2»');
      return;
    }
    setErr(null);
    audio.drop(0.7, 0.35);
    setStep('b');
  };

  const done = (r: SelfieResult) => {
    const name = nick.trim() || YOU;
    setMe({ name, src: r.url });
    setStep('c');
    onJoined(name, r.url);
  };

  if (step === 'b') {
    return (
      <div className="m-ph" key="b">
        <p className="vx-kick">последний шаг</p>
        <ChromeText as="h2" size="h2" className="m-h2">
          Теперь селфи
        </ChromeText>
        <p className="vx-body m-sub">Засветишься на большом экране, когда ответишь. Можно пропустить — отольём тебя из ртути.</p>
        <SelfieViewfinder name={nick.trim() || YOU} onDone={done} autoStart={false} className="m-grow" />
      </div>
    );
  }
  if (step === 'c' && me) {
    return (
      <div className="m-ph m-center" key="c">
        <p className="vx-kick">готово</p>
        <ChromeText as="h2" size="h1" split="words" className="m-done-hero">
          Ты в игре
        </ChromeText>
        <Avatar name={me.name} src={me.src} size={150} liquid you />
        <p className="vx-lead">{me.name}</p>
        <p className="vx-small">смотри на большой экран — ты уже там</p>
      </div>
    );
  }
  return (
    <div className="m-ph" ref={root} key="a">
      <p className="vx-kick m-fade-1">суббота · 26.09 · 19:00</p>
      <h1 className="m-j-title">
        <span className="m-j-t1 m-fade-1">Кто лучше знает</span>
        <ChromeText ref={hero} split="chars" className="m-j-hero">
          ВЛАДОСА
        </ChromeText>
      </h1>
      <ChromeBlock ref={puddle} shape="pill" film={0.55} className="m-puddle" />
      <p className="vx-body m-note m-fade">Живой квиз на днюхе. Отвечаешь с телефона, все смотрят на большой экран.</p>
      <form
        className="m-j-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          next();
        }}
      >
        <div className="m-pop">
          <ChromeField
            label="Как подписать тебя на экране?"
            value={nick}
            onChange={(v) => {
              setNick(v);
              if (err) setErr(null);
            }}
            placeholder="Например, Димон"
            maxLength={20}
            enterKeyHint="go"
            autoComplete="off"
            spellCheck={false}
            error={err}
          />
        </div>
        <ChromeButton type="submit" block className="m-pop">
          Дальше
        </ChromeButton>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------ lobby

export function PhoneLobby({ run, count, you, drop, onReact }: { run: number; count: number; you: { name: string; src: string | null }; drop: { n: number; big: boolean }; onReact: (i: number) => void }) {
  const root = useRef<HTMLDivElement | null>(null);
  const hero = useRef<HTMLElement | null>(null);
  const pool = useRef<Blob | null>(null);
  const poolEl = useRef<HTMLDivElement | null>(null);
  const { engine } = useLiquid();
  useReplay(run, () => {
    const q = gsap.utils.selector(root);
    const tl = gsap.timeline();
    tl.add(beats.riseLetters(hero.current, { stagger: 0.09 }), 0.1);
    tl.add(beats.fadeUp(q('.m-fade')), 0.3);
    tl.add(beats.popIn(q('.m-me'), { from: 0.2 }), 0.35);
    tl.add(beats.popIn(poolEl.current, { from: 0.3 }), 0.5);
    tl.add(beats.popIn(q('.vx-rb'), { stagger: 0.06 }), 0.7);
    return tl;
  });
  const lastDrop = useRef(drop.n);
  useEffect(() => {
    if (drop.n === lastDrop.current) return;
    lastDrop.current = drop.n;
    beats.poolDrop(engine, pool.current, drop.big);
  }, [drop, engine]);
  return (
    <div className="m-ph" ref={root}>
      <p className="vx-kick m-fade">ждём, пока соберутся все</p>
      <ChromeText ref={hero} as="h2" split="words" className="m-l-hero">
        Ты в игре
      </ChromeText>
      <div className="m-me-row">
        <div className="m-me">
          <Avatar name={you.name} src={you.src} size={112} liquid />
        </div>
        <div className="m-fade">
          <p className="m-me-name">{you.name}</p>
          <p className="vx-small">уже на большом экране</p>
        </div>
      </div>
      <p className="vx-body m-fade m-l-sub">Вопросы — на большом экране, отвечаешь здесь. Кто быстрее, тому больше очков.</p>
      <div className="m-l-mid">
        <ChromeBlock ref={poolEl} shape="circle" film={0.55} blobRef={pool} className="m-pool">
          <b className="vx-eng">
            <Odometer value={count} />
          </b>
          <span className="vx-eng">в игре</span>
        </ChromeBlock>
      </div>
      <ReactionBar onReact={onReact} />
    </div>
  );
}

// ------------------------------------------------------------------ question → answer commit

function Remaining({ endsAt }: { endsAt: number }) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 250);
    return () => clearInterval(id);
  }, []);
  return <b>{fmtClock((endsAt - Date.now()) / 1000)}</b>;
}

export function PhoneQuestion({ run, onPick, autoPick }: { run: number; onPick: (i: number) => void; /** «Показ вечера»: the guest taps this option by itself */ autoPick?: number }) {
  const [picked, setPicked] = useState<number | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [endsAt, setEndsAt] = useState(() => Date.now() + 60_000);
  const opts = useRef<(HTMLButtonElement | null)[]>([]);
  const blobs = useRef<{ current: Blob | null }[]>(QUESTION.options.map(() => ({ current: null })));
  const orb = useRef<HTMLDivElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const { engine } = useLiquid();

  useEffect(() => {
    setPicked(null);
    setAccepted(false);
    setEndsAt(Date.now() + 60_000);
  }, [run]);

  useReplay(
    run,
    () => {
      if (accepted) return;
      const q = gsap.utils.selector(root);
      const tl = gsap.timeline();
      tl.add(beats.fadeUp(q('.m-fade'), { stagger: 0.07 }), 0.2);
      tl.add(beats.popIn(q('.vx-opt'), { from: 0.4, stagger: 0.09 }), 0.5);
      if (autoPick !== undefined) tl.call(() => pickRef.current(autoPick), undefined, 3.4);
      return tl;
    },
    [],
  );

  const pickRef = useRef<(i: number) => void>(() => undefined);
  const pick = (i: number) => {
    if (picked !== null) return;
    setPicked(i);
    onPick(i);
    const els = opts.current.filter((e): e is HTMLButtonElement => !!e);
    beats.answerCommit(engine, {
      options: els,
      picked: i,
      blobs: blobs.current.map((b) => b.current),
      orb: () => orb.current,
      onMorph: () => flushSync(() => setAccepted(true)),
    });
  };
  pickRef.current = pick;

  if (accepted && picked !== null) {
    return (
      <div className="m-ph m-acc">
        <ChromeBlock ref={orb} shape="circle" film={0.45} className="m-orb" aria-live="polite">
          <b className="vx-eng">Ответ принят</b>
          <span className="vx-eng">{QUESTION.options[picked]}</span>
        </ChromeBlock>
        <p className="m-wait">
          ещё <Remaining endsAt={endsAt} /> — ждём остальных
        </p>
      </div>
    );
  }
  return (
    <div className="m-ph" ref={root}>
      <div className="m-q-top m-fade">
        <p className="vx-kick">
          вопрос {QUESTION.n} из {QUESTION.total}
        </p>
        <Badge liquid>×2</Badge>
      </div>
      <TimerBar key={run} endsAt={endsAt} total={60} className="m-fade m-q-timer" />
      <p className="vx-lead m-q-text m-fade">{QUESTION.title}</p>
      <p className="vx-small m-q-hint m-fade">жми, пока ртуть не утекла</p>
      <div className="m-q-opts">
        {QUESTION.options.map((o, i) => (
          <OptionTile
            key={i}
            ref={(n) => {
              opts.current[i] = n;
            }}
            blobRef={blobs.current[i]}
            label={o}
            state={picked === null ? 'idle' : picked === i ? 'selected' : 'locked'}
            onSelect={() => pick(i)}
          />
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ result

export function PhoneResult({ run, good }: { run: number; good: boolean }) {
  const flood = useRef<HTMLDivElement | null>(null);
  const fb = useRef<Blob | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const x2 = useRef<HTMLSpanElement | null>(null);
  const rank = useRef<HTMLElement | null>(null);
  const [pts, setPts] = useState(0);
  useReplay(
    run,
    (engine) => {
      const q = gsap.utils.selector(root);
      const tl = gsap.timeline();
      setPts(0);
      if (flood.current) tl.fromTo(flood.current, { scale: 0.22 }, { scale: 1, duration: 1, ease: 'elastic.out(1,0.7)' }, 0);
      if (good) {
        tl.call(() => {
          if (fb.current) beats.pulse(fb.current, 1, 1.6);
          engine?.flash(0.3);
          audio.shine();
          if (engine && fb.current) engine.ripple(fb.current.x, fb.current.y, 1.2);
        }, undefined, 0.15);
        tl.fromTo(q('.m-r-in > *'), { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.5, stagger: 0.08 }, 0.35);
        tl.add(beats.countTo(0, 860, setPts, { duration: 1, step: 10 }), 0.55);
        tl.fromTo(x2.current, { scale: 1.8, rotation: -14, opacity: 0 }, { scale: 1, rotation: 0, opacity: 1, duration: 0.6, ease: ease.back }, 1.7);
        tl.call(() => audio.drop(1.3, 0.4), undefined, 1.7);
        tl.to(x2.current, { x: -60, scale: 0.2, opacity: 0, duration: 0.45, ease: 'power3.in' }, 2.6);
        tl.call(() => {
          if (fb.current) beats.pulse(fb.current, 0.6, 1);
          audio.bell(659, 0.12, 1.4);
        }, undefined, 2.9);
        tl.add(beats.countTo(860, 1720, setPts, { duration: 0.8, step: 10 }), 2.95);
        tl.fromTo(rank.current, { scale: 1.8, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.7, ease: ease.back }, 3.4);
      } else {
        tl.call(() => audio.melt(0.35), undefined, 0.1);
        tl.fromTo(q('.m-r-in > *'), { opacity: 0, y: -10 }, { opacity: 1, y: 0, duration: 0.5, stagger: 0.08 }, 0.4);
        tl.call(() => {
          const b = fb.current;
          if (!engine || !b) return;
          const bottom = b.y + b.hh - 6;
          for (let k = 0; k < 5; k++) beats.drip(engine, b.x - b.hw * 0.7 + k * b.hw * 0.35 + (Math.random() - 0.5) * 20, bottom, { delay: k * 0.15, r: 9 + Math.random() * 6 });
        }, undefined, 0.6);
      }
      return tl;
    },
    [good],
  );
  return (
    <div className={`m-res ${good ? 'is-good' : 'is-bad'}`} ref={root}>
      <ChromeBlock ref={flood} shape="box" radius={46} film={good ? 0.24 : 0.2} tar={good ? 0 : 1} tone={good ? 'chrome' : 'tarnish'} blobRef={fb} className="m-flood" />
      <div className="m-r-in">
        <p className="vx-kick m-r-t">вопрос {QUESTION.n} · двойные очки</p>
        <h2 className="m-r-word m-r-t">{good ? 'В точку!' : 'Мимо'}</h2>
        <div className="m-r-pts m-r-t">
          <span>+</span>
          <Odometer value={good ? pts : 0} />
          {good ? (
            <span ref={x2} className="m-r-x2">
              <Badge size="l">×2</Badge>
            </span>
          ) : null}
        </div>
        <p className="m-r-calc m-r-t">{good ? '860 за скорость, вопрос двойной' : `Правильно — «${QUESTION.options[QUESTION.correct]}»`}</p>
        <div className="m-r-rank m-r-t">
          <span>было #7</span>
          <b ref={rank}>{good ? '#3' : '#9'}</b>
        </div>
        <p className="m-r-note m-r-t">{good ? 'Четверо остались позади. Кирилл нервничает.' : 'Владос тоже промахнулся — ты в хорошей компании.'}</p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ board (your place)

export function PhoneBoard({ run }: { run: number }) {
  const [rank, setRank] = useState(7);
  const [score, setScore] = useState(6890);
  const root = useRef<HTMLDivElement | null>(null);
  const plate = useRef<Blob | null>(null);
  useReplay(run, () => {
    setRank(7);
    setScore(6890);
    const q = gsap.utils.selector(root);
    const tl = gsap.timeline();
    tl.add(beats.fadeUp(q('.m-fade')), 0.1);
    tl.add(beats.countTo(6890, 8810, setScore, { duration: 1.2, step: 10 }), 1.4);
    tl.call(() => setRank(3), undefined, 2.6);
    tl.call(() => beats.pulse(plate.current, 0.8, 1.2), undefined, 2.6);
    return tl;
  });
  return (
    <div className="m-ph" ref={root}>
      <p className="vx-kick m-fade">после вопроса {QUESTION.n}</p>
      <ChromeText as="h2" size="h1" className="m-fade m-b-h">
        Твоё место
      </ChromeText>
      <ChromeBlock shape="box" radius={30} film={0.4} blobRef={plate} className="m-b-plate">
        <span className="m-b-rank vx-eng">
          #<Odometer value={rank} />
        </span>
        <span className="m-b-score vx-eng">
          <Odometer value={score} /> очков
        </span>
      </ChromeBlock>
      <p className="vx-lead m-fade">Обогнал четверых за один вопрос.</p>
      <p className="vx-body m-fade">До #2 — 530 очков. Соня уже оглядывается.</p>
    </div>
  );
}

// ------------------------------------------------------------------ final

export function PhoneFinal({ run, you }: { run: number; you: { name: string; src: string | null } }) {
  const root = useRef<HTMLDivElement | null>(null);
  const block = useRef<HTMLDivElement | null>(null);
  const av = useRef<HTMLDivElement | null>(null);
  const [cap, setCap] = useState('смотри на экран — там решается всё');
  const { engine } = useLiquid();
  useReplay(
    run,
    () => {
      setCap('смотри на экран — там решается всё');
      const q = gsap.utils.selector(root);
      const tl = gsap.timeline();
      tl.add(beats.fadeUp(q('.m-fade'), { stagger: 0.08 }), 0.2);
      tl.set([block.current, av.current], { opacity: 0 }, 0);
      tl.set(q('.m-f-block > *'), { opacity: 0 }, 0);
      tl.set(q('.m-f-vs'), { opacity: 0 }, 0);
      tl.set(block.current, { opacity: 1 }, 1.2);
      tl.fromTo(block.current, { scaleY: 0.05 }, { scaleY: 1, duration: 1, ease: 'back.out(1.5)' }, 1.2);
      tl.to(q('.m-f-block > *'), { opacity: 1, duration: 0.5, stagger: 0.1 }, 1.7);
      tl.call(() => setCap('ты на подиуме — третье место!'), undefined, 1.2);
      tl.set(av.current, { opacity: 1 }, 1.65);
      tl.fromTo(av.current, { y: -340 }, { y: 0, duration: 0.9, ease: ease.bounce }, 1.65);
      tl.call(() => {
        if (!engine || !av.current) return;
        const p = engine.measure(av.current);
        engine.ripple(p.x, p.y + 40, 0.8);
        audio.drop(0.5, 0.45);
      }, undefined, 2.0);
      tl.call(() => engine?.flash(0.2), undefined, 3.2);
      tl.fromTo(q('.m-f-vs'), { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.8 }, 3.4);
      return tl;
    },
    [],
  );
  return (
    <div className="m-ph" ref={root}>
      <p className="vx-kick m-fade">12 вопросов позади</p>
      <ChromeText as="h2" size="hero" className="m-fade m-f-h">
        Финал
      </ChromeText>
      <p className="m-f-cap m-fade">{cap}</p>
      <div className="m-f-stage">
        <div ref={av} className="m-f-av">
          <Avatar name={you.name} src={you.src} size={96} liquid />
        </div>
        <ChromeBlock ref={block} shape="box" radius={24} film={0.35} className="m-f-block">
          <span className="m-f-num vx-eng">3</span>
          <span className="m-f-of vx-eng">место из 42</span>
          <span className="m-f-of vx-eng">8 810 очков</span>
        </ChromeBlock>
      </div>
      <div className="m-f-vs">
        <p className="vx-kick m-hot">Владос против друзей</p>
        <p className="vx-body">Про себя Владос угадал 7 из 12, вы в среднем — 8,3. Друзья знают его лучше.</p>
      </div>
    </div>
  );
}
