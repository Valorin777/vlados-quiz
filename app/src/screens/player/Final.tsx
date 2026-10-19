// The finale on the phone, in step with the TV: drumroll → bronze → silver → gold (and your own
// place) → Vlados vs. his friends → thanks → (the video after the final: «Смотри на экран» while
// it plays on the TV, Finale.tsx; then this screen again). Nothing is spoiled before the TV shows it.

import { gsap } from 'gsap';
import { useEffect, useRef } from 'react';
import type { PodiumRow } from '@shared/fbtypes';
import type { PlayerView } from '../../host/views';
import { Avatar, ChromeBlock, ChromeText, audio, beats, cx, ease, plural, useLiquid } from './vx';
import { fmtNum } from './format';
import { useBytesUrl, useEntrance } from './hooks';
import { Hud } from './parts';
import { FinaleWatch, preloadFinalePoster } from './Finale';
import { Reactions } from './Reactions';
import type { PlayerActions } from './types';

const STEP_OF_RANK: Record<number, number> = { 3: 1, 2: 2, 1: 3 };

function PodiumCol({ row, rank, shown, me }: { row: PodiumRow | undefined; rank: number; shown: boolean; me: boolean }) {
  const src = useBytesUrl(shown ? row?.thumb : undefined);
  const el = useRef<HTMLDivElement | null>(null);
  const was = useRef(shown);
  useEffect(() => {
    if (shown && !was.current && el.current) {
      gsap.fromTo(el.current, { y: -120, opacity: 0 }, { y: 0, opacity: 1, duration: 0.9, ease: ease.bounce });
      audio.drop(rank === 1 ? 0.5 : 0.8, 0.4);
    }
    was.current = shown;
  }, [shown, rank]);
  return (
    <div className={cx('pl-pod-col', `is-r${rank}`, shown && 'is-shown', me && 'is-me')}>
      <div ref={el} className="pl-pod-who">
        {shown && row ? (
          <>
            <Avatar name={row.name} src={src} size={rank === 1 ? 64 : 52} you={me} decorative />
            <b className="pl-pod-name">{row.name}</b>
            <span className="pl-pod-s vx-mono">{fmtNum(row.score)}</span>
          </>
        ) : (
          <span className="pl-pod-q" aria-hidden="true">
            ?
          </span>
        )}
      </div>
      <div className="pl-pod-bar">
        <span className="vx-eng">{rank}</span>
      </div>
    </div>
  );
}

export function Final({ view, actions }: { view: PlayerView; actions: PlayerActions }) {
  const f = view.final;
  const root = useRef<HTMLDivElement | null>(null);
  const block = useRef<HTMLDivElement | null>(null);
  const av = useRef<HTMLDivElement | null>(null);
  const { engine } = useLiquid();
  const me = view.me;
  const src = useBytesUrl(me?.avatar);
  const step = f?.step ?? 0;
  const vlados = me?.isVlados === true;
  const mine = f?.mine ?? null;
  const onPodium = mine?.rank !== null && mine?.rank !== undefined && mine.rank <= 3;
  // the video after the final is on the TV (FinaleWatch); this screen comes back (entrance again) after it
  const watching = !!view.finale && view.finale.stage !== 'after';

  useEntrance(() => {
    const s = gsap.utils.selector(root);
    const tl = gsap.timeline();
    tl.add(beats.fadeUp(s('.pl-f'), { stagger: 0.07 }), 0.05);
    if (step === 0 && engine) {
      tl.to(engine.scene, { agit: 0.6, heat: 0.4, duration: 1.2 }, 0);
      tl.call(() => {
        for (let k = 0; k < 8; k++) audio.tick(0.25 + k * 0.03, k * 0.14);
      }, undefined, 0.3);
    }
    return () => {
      tl.kill();
      if (engine) gsap.to(engine.scene, { agit: 0, heat: 0, duration: 0.8 });
    };
  }, [step === 0, watching]);

  // Your place lands at step 3 (with the gold): block rises, avatar drops in, mercury erupts.
  useEntrance(() => {
    if (step < 3 || !block.current) return;
    const tl = gsap.timeline();
    tl.fromTo(block.current, { scaleY: 0.05, opacity: 0 }, { scaleY: 1, opacity: 1, duration: 1, ease: 'back.out(1.5)' }, 0.3);
    if (av.current) tl.fromTo(av.current, { y: -300, opacity: 0 }, { y: 0, opacity: 1, duration: 0.9, ease: ease.bounce }, 0.75);
    tl.call(() => {
      if (!engine || !av.current) return;
      const p = engine.measure(av.current);
      engine.ripple(p.x, p.y + 40, 0.8);
      audio.drop(0.5, 0.45);
      if (onPodium) {
        engine.flash(0.3);
        beats.mercuryFountain(engine, p.x, p.y + 60, { n: 12, width: 160 });
        audio.shine();
        actions.haptic('good');
      }
    }, undefined, 1.1);
    return tl;
  }, [step >= 3, watching]);

  // Keep the newest part in view on small phones.
  useEffect(() => {
    const el = root.current?.querySelector<HTMLElement>(`[data-step="${step}"]`);
    if (el && step > 0) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [step]);

  // the mosaic on the TV: the video after the final may come next — its poster, ready
  useEffect(() => {
    if (step === 5) preloadFinalePoster();
  }, [step]);

  if (!f) return null;
  // the video after the final plays on the TV (the final screen underneath comes back afterwards)
  if (watching) return <FinaleWatch view={view} actions={actions} />;
  const pod = (r: number) => f.podium.find((p) => p.rank === r);
  const texts = view.texts;
  const cap =
    step === 0
      ? 'барабанная дробь… смотри на большой экран'
      : step === 1
        ? `${texts.podiumThird} — уже на экране`
        : step === 2
          ? `${texts.podiumSecond} — тоже. Осталось самое главное`
          : step === 3
            ? texts.podiumFirst
            : step === 4
              ? texts.vladosTitle
              : 'вот и всё — игра окончена';
  const vl = f.vlados ?? null;
  const verdict = vl ? (vl.verdict === 'best' ? texts.vladosVerdictBest : vl.verdict === 'middle' ? texts.vladosVerdictMiddle : texts.vladosVerdictWorst) : null;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const total = view.counts.ranked ?? view.counts.players;

  return (
    <div className={cx('pl-screen pl-final', `is-step${step}`)} ref={root}>
      <Hud view={view} game />
      <p className="vx-kick pl-f">{view.question ? `${view.question.total} ${plural(view.question.total, ['вопрос', 'вопроса', 'вопросов'])} позади` : 'вопросы позади'}</p>
      <ChromeText as="h2" size="hero" className="pl-f pl-f-h">
        Финал
      </ChromeText>
      <p className="pl-f-cap pl-f" aria-live="polite">
        {cap}
      </p>

      {step === 0 ? (
        <div className="pl-f-drum">
          <ChromeBlock shape="circle" film={0.7} className="pl-f-drop" />
        </div>
      ) : (
        <div className="pl-pod" data-step={step <= 2 ? step : undefined}>
          {[2, 1, 3].map((r) => (
            <PodiumCol key={r} rank={r} row={pod(r)} shown={step >= (STEP_OF_RANK[r] ?? 3)} me={pod(r)?.uid === me?.uid} />
          ))}
        </div>
      )}

      {step >= 3 && me ? (
        <div className="pl-f-mine" data-step={3}>
          <div ref={av} className="pl-f-av">
            <Avatar name={me.name} src={src} size={84} liquid you />
          </div>
          <ChromeBlock ref={block} shape="box" radius={24} film={onPodium ? 0.8 : 0.35} className="pl-f-block">
            {vlados || !mine || mine.rank === null ? (
              <>
                <span className="pl-f-out vx-eng">{vlados ? texts.outOfCompetition : 'без места'}</span>
                <span className="pl-f-of vx-eng">{fmtNum(mine?.tot ?? view.score?.tot ?? 0)} очков</span>
              </>
            ) : (
              <>
                <span className="pl-f-num vx-eng">{mine.rank}</span>
                <span className="pl-f-of vx-eng">
                  место {total > 0 ? `из ${total}` : ''}
                </span>
                <span className="pl-f-of vx-eng">{fmtNum(mine.tot)} {plural(mine.tot, ['очко', 'очка', 'очков'])}</span>
              </>
            )}
          </ChromeBlock>
          {onPodium ? <p className="pl-f-yay">Ты на подиуме! Иди за аплодисментами 🏆</p> : null}
        </div>
      ) : null}

      {step >= 4 && vl ? (
        <div className="pl-f-vs" data-step={4}>
          <p className="vx-kick pl-hot">{vlados ? 'ты против друзей' : `${vl.name} против друзей`}</p>
          <div className="pl-vs-row">
            <div>
              <b className="vx-mono">{pct(vl.vladosAccuracy)}</b>
              <span>{vlados ? 'ты про себя' : `${vl.name} про себя`}</span>
            </div>
            <div>
              <b className="vx-mono">{pct(vl.guestsAccuracy)}</b>
              <span>гости в среднем</span>
            </div>
            {vl.best ? (
              <div>
                <b className="vx-mono">{pct(vl.best.accuracy)}</b>
                <span>{vl.best.uid === me?.uid ? 'ты — лучший знаток' : `лучший знаток — ${vl.best.name}`}</span>
              </div>
            ) : null}
          </div>
          {verdict ? <p className="vx-lead pl-vs-verdict">{verdict}</p> : null}
        </div>
      ) : null}

      {step >= 5 ? (
        <p className="pl-f-thanks" data-step={5}>
          {texts.thanks}
        </p>
      ) : null}

      {step >= 3 ? <Reactions view={view} actions={actions} className="pl-f-react" /> : null}
    </div>
  );
}
