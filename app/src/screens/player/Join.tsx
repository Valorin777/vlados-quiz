// Before the game and at the door: the pre-game countdown («Зарегистрируйся заранее»), the name,
// the selfie (or a chrome initial), joining — with friendly copy for every way it can fail.

import { gsap } from 'gsap';
import { useEffect, useRef, useState } from 'react';
import type { JoinError } from '../../host/player';
import type { PlayerView } from '../../host/views';
import {
  Avatar,
  ChromeBlock,
  ChromeButton,
  ChromeField,
  ChromeText,
  Countdown,
  SelfieViewfinder,
  audio,
  beats,
  ease,
  generateChromeAvatar,
  type SelfieResult,
} from './vx';
import { partyDate } from './format';
import { useEntrance } from './hooks';
import { loadDraft, loadProfile, photoOf, saveDraft, selfieOf, type JoinDraft, type StoredPhoto } from './joinDraft';
import { HeroTitle, Hud } from './parts';
import type { PlayerActions } from './types';

type Step = 'name' | 'selfie' | 'joining' | 'failed';

function joinErrorText(e: JoinError, view: PlayerView): string {
  switch (e) {
    case 'bad_name':
      return 'С таким именем не пустят: нужно от 1 до 20 символов, без странных значков.';
    case 'closed':
      return view.texts.joinClosed;
    case 'no_game':
      return 'Игру ещё не создали. Загляни чуть позже — ссылка та же.';
    case 'offline':
      return 'Связь шалит, и сервер нас не услышал. Проверь интернет и жми ещё раз.';
    case 'too_big':
      return 'Фото получилось тяжеловатым. Попробуй ещё раз — или без селфи.';
    case 'forbidden':
    case 'failed':
      return 'Что-то пошло не так. Попробуй ещё раз — обычно со второго раза залетает.';
  }
}

// ------------------------------------------------------------------ pre-game

function Pregame({ view, actions, onGo }: { view: PlayerView; actions: PlayerActions; onGo: () => void }) {
  const root = useRef<HTMLDivElement | null>(null);
  const hero = useRef<HTMLElement | null>(null);
  const pub = view.pub;
  useEntrance(() => {
    const q = gsap.utils.selector(root);
    const tl = gsap.timeline();
    tl.add(beats.fadeUp(q('.pl-f1')), 0.05);
    tl.add(beats.riseLetters(hero.current), 0.4);
    tl.add(beats.fadeUp(q('.pl-f2'), { stagger: 0.08 }), 0.8);
    tl.add(beats.popIn(q('.pl-p'), { stagger: 0.08 }), 1.1);
    return tl;
  });
  if (!pub) return null;
  return (
    <div className="pl-screen pl-pre" ref={root}>
      <Hud view={view} />
      <p className="vx-kick pl-f1">{partyDate(pub.startsAt)}</p>
      <HeroTitle title={pub.title} heroRef={(el) => (hero.current = el)} />
      <ChromeBlock shape="pill" film={0.55} tone="band" className="pl-puddle pl-p" />
      {pub.subtitle ? <p className="vx-body pl-note pl-f2">{pub.subtitle}</p> : null}
      <div className="pl-pre-mid">
        <p className="vx-kick pl-f2">{view.texts.preGameCountdown}</p>
        <Countdown target={pub.startsAt} now={actions.now} onDone={onGo} className="pl-count pl-f2" />
      </div>
      <div className="pl-foot">
        <p className="vx-small pl-f2 pl-center">Займи имя и сделай селфи сейчас — в день игры останется только отвечать.</p>
        <ChromeButton block className="pl-p" variant="film" onClick={onGo}>
          Зарегистрируйся заранее
        </ChromeButton>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ name

function NameStep({
  view,
  actions,
  name,
  setName,
  error,
  setError,
  onNext,
}: {
  view: PlayerView;
  actions: PlayerActions;
  name: string;
  setName: (v: string) => void;
  error: string | null;
  setError: (v: string | null) => void;
  onNext: (clean: string) => void;
}) {
  const root = useRef<HTMLDivElement | null>(null);
  const hero = useRef<HTMLElement | null>(null);
  const puddle = useRef<HTMLDivElement | null>(null);
  const pub = view.pub;
  const early = pub !== null && view.phase === 'lobby' && view.now < pub.startsAt;
  const late = view.phase !== null && view.phase !== 'lobby';

  useEntrance((engine) => {
    const q = gsap.utils.selector(root);
    const tl = gsap.timeline();
    tl.add(beats.fadeUp(q('.pl-f1')), 0.05);
    tl.add(beats.riseLetters(hero.current), 0.5);
    tl.add(beats.fadeUp(q('.pl-f2')), 0.8);
    tl.add(beats.popIn(q('.pl-p'), { stagger: 0.08 }), 1.0);
    const pu = puddle.current;
    if (pu) tl.fromTo(pu, { scaleX: 0, scaleY: 0 }, { scaleX: 1, scaleY: 1, duration: 1.1, ease: ease.elastic }, 0.62);
    if (engine && pu) {
      const p = engine.measure(pu);
      const d = engine.add({ x: p.x, y: -60, r: 20, film: 0.6, prio: 1 });
      tl.to(d, { y: p.y - 4, duration: 0.6, ease: 'power2.in' }, 0.02);
      tl.to(d, { ay: -24, duration: 0.3, yoyo: true, repeat: 1 }, 0.2);
      tl.to(d, { r: 0, duration: 0.3, ease: 'power2.in', onComplete: () => engine.remove(d) }, 0.62);
      tl.call(() => engine.ripple(p.x, p.y, 1), undefined, 0.62);
    }
    return tl;
  });

  const submit = () => {
    const clean = actions.checkName(name);
    if (!clean) {
      setError(name.trim() ? 'Такое имя не подойдёт: от 1 до 20 символов, без странных значков.' : 'Напиши хоть что-нибудь — хоть «Владос-2»');
      actions.haptic('bad');
      return;
    }
    setError(null);
    audio.drop(0.7, 0.35);
    onNext(clean);
  };

  return (
    <div className="pl-screen pl-join" ref={root}>
      <Hud view={view} />
      <p className="vx-kick pl-f1">{pub ? partyDate(pub.startsAt) : ''}</p>
      {pub ? <HeroTitle title={pub.title} heroRef={(el) => (hero.current = el)} /> : null}
      <ChromeBlock ref={puddle} shape="pill" film={0.55} tone="band" className="pl-puddle" />
      <p className="vx-body pl-note pl-f2">
        {late
          ? 'Игра уже идёт — залетай, ещё не поздно! Отвечаешь с телефона, вопросы на большом экране.'
          : early
            ? 'Регистрация открыта заранее. Имя и селфи сейчас — вопросы в день игры.'
            : 'Живой квиз на днюхе. Отвечаешь с телефона, все смотрят на большой экран.'}
      </p>
      <form
        className="pl-foot"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="pl-p">
          <ChromeField
            label={view.texts.joinTitle}
            value={name}
            onChange={(v) => {
              setName(v);
              if (error) setError(null);
            }}
            placeholder="Например, Димон"
            maxLength={20}
            enterKeyHint="go"
            autoComplete="nickname"
            autoCapitalize="words"
            spellCheck={false}
            error={error}
          />
        </div>
        <ChromeButton type="submit" block className="pl-p">
          Дальше
        </ChromeButton>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------ the whole door

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function Join({ view, actions }: { view: PlayerView; actions: PlayerActions }) {
  const pub = view.pub;
  const early = pub !== null && view.phase === 'lobby' && view.now < pub.startsAt;
  // What this tab had typed/shot before a reload (the draft), or what this device joined with
  // last time (the profile): nobody enters the name and the selfie twice (joinDraft.ts).
  const [init] = useState(() => {
    const draft = loadDraft();
    const profile = loadProfile();
    const photo = draft?.photo ?? profile?.photo ?? null;
    return { draft, profile, photo, selfie: photo ? selfieOf(photo) : null };
  });
  const draft = init.draft;
  const [pre, setPre] = useState(early && !draft);
  const [step, setStep] = useState<Step>(draft?.step === 'sent' ? 'joining' : draft?.step === 'selfie' ? 'selfie' : 'name');
  const [name, setName] = useState(draft?.name ?? init.profile?.name ?? '');
  const [clean, setClean] = useState(draft && draft.step !== 'name' ? draft.name : '');
  const [error, setError] = useState<string | null>(null);
  const [selfie, setSelfie] = useState<SelfieResult | null>(init.selfie);
  /** The selfie step shows the viewfinder although a photo is on hand («Новое селфи»). */
  const [reshoot, setReshoot] = useState(false);
  const [failure, setFailure] = useState<JoinError | null>(null);
  /** The join write is queued but the server has not answered yet (slow network). */
  const [slow, setSlow] = useState(false);
  const alive = useRef(true);
  const selfieRef = useRef<SelfieResult | null>(selfie);
  selfieRef.current = selfie;
  /** base64 of the current selfie, for the draft. */
  const photoRef = useRef<StoredPhoto | null>(init.photo);

  const typing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const persist = (st: JoinDraft['step'], n: string) => {
    clearTimeout(typing.current);
    saveDraft({ name: n, step: st, photo: photoRef.current });
  };
  /** Keystrokes: written once the typing pauses (the draft may carry a 50 KB photo). */
  const persistTyped = (n: string) => {
    clearTimeout(typing.current);
    typing.current = setTimeout(() => persist('name', n), 400);
  };

  const send = async (who: string, s: SelfieResult | null) => {
    setStep('joining');
    setFailure(null);
    setSlow(false);
    persist('sent', who);
    let r = await actions.join(who, s);
    // 'offline': the write is queued and PlayerSession keeps it — the lobby shows as soon as it
    // lands. Keep waiting on the same write (join() is idempotent) instead of asking again.
    while (!r.ok && r.error === 'offline' && alive.current) {
      setSlow(true);
      await pause(1_500);
      if (!alive.current) return;
      r = await actions.join(who, s);
    }
    if (!alive.current) return; // joined: the lobby took over (live.ts clears the draft)
    if (r.ok) {
      actions.haptic('good');
      return; // the view switches to the lobby by itself
    }
    actions.haptic('bad');
    if (r.error === 'bad_name') {
      setError(joinErrorText('bad_name', view));
      setStep('name');
      persist('name', who);
      return;
    }
    setFailure(r.error);
    setStep('failed');
  };

  const takeSelfie = async (r: SelfieResult) => {
    const old = selfieRef.current;
    if (old && old !== r) URL.revokeObjectURL(old.url);
    selfieRef.current = r;
    setSelfie(r);
    setStep('joining'); // straight on (not via the «Это ты?» confirm)
    setReshoot(false);
    photoRef.current = await photoOf(r); // a few ms; the draft must hold it before the write goes
    if (alive.current) void send(clean, r);
  };

  useEffect(() => {
    alive.current = true;
    // Reloaded after «Готово»: send the same name + selfie again by itself.
    if (draft?.step === 'sent') void send(draft.name, selfieRef.current);
    return () => {
      alive.current = false;
      clearTimeout(typing.current);
      // Deferred: StrictMode's dev re-mount runs this cleanup and the effect again at once.
      const s = selfieRef.current;
      setTimeout(() => {
        if (!alive.current && s) URL.revokeObjectURL(s.url);
      }, 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const back = (
    <button type="button" className="pl-back" onClick={() => (setStep('name'), persist('name', clean))}>
      ← {clean}
    </button>
  );

  if (pre && step === 'name') return <Pregame view={view} actions={actions} onGo={() => setPre(false)} />;

  if (step === 'selfie' && selfie && !reshoot) {
    // A photo is on hand (from before a reload or the last game): one tap instead of a new shot.
    return (
      <div className="pl-screen pl-center pl-joining pl-confirm" key="confirm">
        <Hud view={view} left={back} />
        <Avatar name={clean} src={selfie.url} size={150} liquid you />
        <p className="pl-me-name">{clean}</p>
        <p className="vx-body pl-sub">Это ты? Селфи уже есть — залетай с ним или сделай новое.</p>
        <ChromeButton onClick={() => void send(clean, selfie)}>Залетаем</ChromeButton>
        <ChromeButton variant="ghost" onClick={() => setReshoot(true)}>
          Новое селфи
        </ChromeButton>
      </div>
    );
  }

  if (step === 'selfie') {
    return (
      <div className="pl-screen pl-selfie" key="selfie">
        <Hud view={view} left={back} />
        <p className="vx-kick">последний шаг</p>
        <ChromeText as="h2" size="h2" className="pl-h2">
          Теперь селфи
        </ChromeText>
        <p className="vx-body pl-sub">{view.texts.selfieHint}. Можно пропустить — отольём тебя из ртути.</p>
        <SelfieViewfinder name={clean} autoStart={false} className="pl-vf" onDone={(r) => void takeSelfie(r)} />
      </div>
    );
  }

  if (step === 'joining' || step === 'failed') {
    const retry = async () => {
      let s = selfie;
      if (failure === 'too_big') {
        // Too heavy even after the encoder did its best: fall back to the chrome initial.
        s = await generateChromeAvatar(clean).catch(() => null);
        if (s) {
          selfieRef.current = s;
          setSelfie(s);
          photoRef.current = await photoOf(s);
        }
      }
      void send(clean, s);
    };
    return (
      <div className="pl-screen pl-center pl-joining" key="joining">
        <Hud view={view} />
        <Avatar name={clean} src={selfie?.url ?? null} size={150} liquid you />
        <p className="pl-me-name">{clean}</p>
        {step === 'joining' ? (
          <>
            <p className="vx-small pl-dots" aria-live="polite">
              залетаем в игру
            </p>
            {slow ? <p className="vx-small pl-sub">Связь медленная — место за тобой. Не закрывай страницу, залетишь сам.</p> : null}
          </>
        ) : (
          <>
            <p className="vx-body pl-err" role="alert">
              {failure ? joinErrorText(failure, view) : ''}
            </p>
            {failure === 'closed' || failure === 'no_game' ? null : (
              <ChromeButton onClick={() => void retry()}>Попробовать ещё раз</ChromeButton>
            )}
            <ChromeButton variant="ghost" onClick={() => (setStep('name'), persist('name', clean))}>
              Изменить имя
            </ChromeButton>
          </>
        )}
      </div>
    );
  }

  return (
    <NameStep
      view={view}
      actions={actions}
      name={name}
      setName={(v) => {
        setName(v);
        persistTyped(v);
      }}
      error={error}
      setError={setError}
      onNext={(c) => {
        setClean(c);
        setName(c);
        setStep('selfie');
        persist('selfie', c);
      }}
    />
  );
}
