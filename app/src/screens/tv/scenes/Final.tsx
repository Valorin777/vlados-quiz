// The finale, one organizer tap per step: 0 drumroll · 1 bronze · 2 silver · 3 gold (boom,
// fountain, confetti) · 4 Vlados vs friends · 5 the selfie mosaic + «С днём рождения!» ·
// 6 the video after the final (Finale.tsx): the mosaic gathers into a droplet that opens into the
// video; when it ends the mosaic comes back with confetti and the music.

import type { FinalVlados, PodiumRow } from '@shared/fbtypes';
import { gsap } from 'gsap';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Avatar, ChromeBlock, ChromeText, audio, beats, cx, ease, fmtInt, initialOf, useLiquid } from '../../../visual';
import type { TvPlayer, TvView } from '../../../host';
import { avatarUrl } from '../media';
import { confetti, useBeat, useTvEnv } from '../common';
import { FinaleVideo, GATHER } from './Finale';

const BASE = 668;
const SLOTS = [
  { x: 640, h: 300 },
  { x: 372, h: 214 },
  { x: 908, h: 156 },
];

function slotted(podium: PodiumRow[]): { row: PodiumRow; pos: number }[] {
  const seen = new Map<number, number>();
  return podium
    .slice()
    .sort((a, b) => a.rank - b.rank)
    .map((row) => {
      const dup = seen.get(row.rank) ?? 0;
      seen.set(row.rank, dup + 1);
      return { row, pos: Math.min(2, row.rank - 1 + dup) };
    });
}

// ------------------------------------------------------------------ podium

function Column({ row, pos, src, animate, label }: { row: PodiumRow; pos: number; src: string | null; animate: boolean; label: string }) {
  const { engine } = useLiquid();
  const col = useRef<HTMLDivElement | null>(null);
  const av = useRef<HTMLDivElement | null>(null);
  const lab = useRef<HTMLDivElement | null>(null);
  const s = SLOTS[pos] ?? SLOTS[2]!;
  useEffect(() => {
    const c = col.current;
    if (!c) return;
    if (!animate) {
      gsap.set(c, { height: s.h });
      gsap.set([av.current, lab.current], { opacity: 1 });
      return;
    }
    const tl = gsap.timeline();
    tl.call(() => audio.rise(0.55), undefined, 0);
    tl.fromTo(c, { height: 0 }, { height: s.h, duration: 1.05, ease: 'back.out(1.5)' }, 0.1);
    tl.fromTo(lab.current, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.5 }, 0.7);
    tl.set(av.current, { opacity: 1 }, 0.62);
    tl.fromTo(av.current, { y: -BASE }, { y: 0, duration: 0.85, ease: ease.bounce, immediateRender: false }, 0.62);
    tl.call(
      () => {
        audio.drop(0.6 - pos * 0.08, 0.5);
        audio.bell([294, 247, 196][pos] ?? 196, 0.12, 1.8);
        engine?.ripple(s.x, BASE - s.h, 0.9);
      },
      undefined,
      1.05,
    );
    if (pos === 0) {
      tl.call(
        () => {
          audio.boom();
          if (engine) {
            engine.flash(0.6);
            engine.ripple(s.x, BASE - s.h, 1.9);
            beats.mercuryFountain(engine, s.x, BASE - s.h - 30, { n: 11 });
          }
        },
        undefined,
        1.45,
      );
    }
    return () => void tl.kill();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <ChromeBlock ref={col} shape="box" radius={22} film={pos === 0 ? 0.85 : 0.34} className={cx('tf-col', `p${pos}`)} style={{ left: s.x - 112, bottom: 720 - BASE, height: animate ? 0 : s.h }}>
        <div ref={lab} className="tf-lab" style={{ opacity: animate ? 0 : 1 }}>
          <span className="tf-place vx-eng">{row.rank}</span>
          <span className="tf-score vx-eng">{fmtInt(row.score)}</span>
        </div>
      </ChromeBlock>
      <div ref={av} className={cx('tf-av', `p${pos}`)} style={{ left: s.x - 56, top: BASE - s.h - 150, opacity: animate ? 0 : 1 }}>
        <Avatar name={row.name} src={src} size={pos === 0 ? 112 : 92} liquid you={pos === 0} />
        <p className="tf-name">{row.name}</p>
        <p className="tf-medal">{label}</p>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ Vlados vs friends

function Versus({ v, vLabel, texts, src }: { v: FinalVlados | null | undefined; vLabel: string; texts: Record<string, string>; src: string | null }) {
  const root = useRef<HTMLDivElement | null>(null);
  useBeat((engine) => {
    const qs = gsap.utils.selector(root);
    const tl = gsap.timeline();
    tl.fromTo(qs('.tv-v-h'), { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.8, ease: 'power3.out' }, 0);
    tl.fromTo(qs('.tv-v-row'), { opacity: 0, x: -30 }, { opacity: 1, x: 0, duration: 0.6, stagger: 0.2 }, 0.4);
    qs('.tv-v-fill').forEach((el, k) => {
      const w = Number((el as HTMLElement).dataset.w ?? 0);
      tl.fromTo(el, { width: 40 }, { width: 40 + w * 640, duration: 1.4, ease: ease.elastic }, 1 + k * 0.35);
      tl.call(() => audio.drop(0.7 + k * 0.15, 0.4), undefined, 1.1 + k * 0.35);
    });
    tl.call(() => audio.rise(0.7), undefined, 2.4);
    tl.fromTo(qs('.tv-v-verdict'), { opacity: 0, scale: 0.7 }, { opacity: 1, scale: 1, duration: 0.9, ease: ease.back }, 3.1);
    tl.call(() => {
      audio.shine();
      engine?.flash(0.3);
      engine?.ripple(640, 600, 1.4);
    }, undefined, 3.2);
    return tl;
  }, []);
  if (!v) {
    return (
      <div className="tv-versus" ref={root}>
        <ChromeText as="h2" className="tv-v-h">
          {`${vLabel} сегодня болел за вас`}
        </ChromeText>
        <p className="tv-v-verdict">А вы отлично его знаете — это видно по очкам!</p>
      </div>
    );
  }
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const verdict = v.verdict === 'best' ? texts.vladosVerdictBest : v.verdict === 'middle' ? texts.vladosVerdictMiddle : texts.vladosVerdictWorst;
  const rows = [
    { k: 'v', label: `${vLabel} о себе`, x: v.vladosAccuracy, hot: true },
    { k: 'g', label: 'Друзья в среднем', x: v.guestsAccuracy, hot: false },
    ...(v.best ? [{ k: 'b', label: `Лучший из друзей — ${v.best.name}`, x: v.best.accuracy, hot: false }] : []),
  ];
  return (
    <div className="tv-versus" ref={root}>
      <ChromeText as="h2" className="tv-v-h">
        {texts.vladosTitle || `А знает ли ${vLabel} себя?`}
      </ChromeText>
      <div className="tv-v-rows">
        {rows.map((r) => (
          <div key={r.k} className={cx('tv-v-row', r.hot && 'is-v')}>
            <span className="tv-v-l">
              {r.k === 'v' ? <Avatar name={vLabel} src={src} size={44} decorative /> : null}
              {r.label}
            </span>
            <span className="tv-v-track">
              <ChromeBlock shape="pill" film={r.hot ? 0.9 : 0.34} className="tv-v-fill" style={{ width: 40 }} {...{ 'data-w': r.x }} />
              <b className="vx-mono">{pct(r.x)}</b>
            </span>
          </div>
        ))}
      </div>
      <p className="tv-v-verdict">{verdict}</p>
      <p className="tv-v-foot vx-kick">точность ответов за вечер</p>
    </div>
  );
}

// ------------------------------------------------------------------ mosaic

function splitThanks(thanks: string, vLabel: string): { hero: string; sub: string } {
  const parts = thanks.split(/(?<=[.!?…])\s+/).filter(Boolean);
  const k = parts.findIndex((p) => /рожд/i.test(p));
  if (k < 0) return { hero: `С днём рождения, ${vLabel}!`, sub: thanks };
  const hero = parts[k] ?? '';
  return { hero, sub: parts.filter((_, i) => i !== k).join(' ') };
}

function Mosaic({ players, thanks, vLabel, gather = false }: { players: TvPlayer[]; thanks: string; vLabel: string; gather?: boolean }) {
  const root = useRef<HTMLDivElement | null>(null);
  const hero = useRef<HTMLElement | null>(null);
  const env = useTvEnv();
  const gathering = useRef(gather);
  gathering.current = gather;
  const n = Math.max(1, players.length);
  const cols = Math.max(4, Math.ceil(Math.sqrt((n * 16) / 9)));
  const rows = Math.ceil(n / cols);
  const cell = Math.min(1280 / cols, 720 / rows);
  const ox = (1280 - cols * cell) / 2;
  const oy = (720 - rows * cell) / 2;
  const { hero: heroText, sub } = splitThanks(thanks, vLabel);
  useBeat((engine) => {
    const qs = gsap.utils.selector(root);
    const tl = gsap.timeline();
    const cells = qs('.tf-m-cell');
    tl.fromTo(
      cells,
      { opacity: 0, scale: 0.2 },
      {
        opacity: 1,
        scale: 1,
        duration: 0.9,
        ease: ease.back,
        stagger: { each: 0.018, from: 'center', grid: [rows, cols] },
      },
      0,
    );
    tl.fromTo(qs('.tf-m-band'), { opacity: 0, scaleY: 0.3 }, { opacity: 1, scaleY: 1, duration: 0.8, ease: 'power3.out' }, 1.2);
    tl.add(beats.riseLetters(hero.current, { stagger: 0.035 }), 1.4);
    tl.fromTo(qs('.tf-m-sub'), { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.7 }, 2.4);
    tl.call(() => {
      audio.boom();
      [523, 659, 784, 1047].forEach((f, k) => audio.bell(f, 0.09, 2.2, k * 0.12));
      if (engine) {
        engine.flash(0.5);
        beats.mercuryFountain(engine, 320, 720, { n: 8 });
        beats.mercuryFountain(engine, 960, 720, { n: 8 });
      }
    }, undefined, 1.5);
    const stopConf = confetti(root.current, 90);
    const fount = window.setInterval(() => {
      if (!engine || gathering.current) return;
      beats.mercuryFountain(engine, 160 + Math.random() * 960, 730, { n: 6 });
    }, 3200);
    return () => {
      tl.kill();
      stopConf();
      clearInterval(fount);
    };
  }, []);
  // the video after the final: every selfie flows into one point low on the stage — the mercury
  // droplet that opens into the video swells out of it (Finale.tsx)
  useEffect(() => {
    if (!gather) return;
    const qs = gsap.utils.selector(root);
    const cells = qs('.tf-m-cell') as HTMLElement[];
    gsap.killTweensOf(cells);
    const tl = gsap.timeline();
    tl.to(qs('.tf-m-band'), { opacity: 0, scale: 0.94, duration: 0.55, ease: 'power2.in' }, 0);
    tl.to(
      cells,
      {
        x: (_: number, el: HTMLElement) => GATHER.x - (el.offsetLeft + el.offsetWidth / 2),
        y: (_: number, el: HTMLElement) => GATHER.y - (el.offsetTop + el.offsetHeight / 2),
        scale: 0.1,
        opacity: 0,
        duration: 0.9,
        ease: 'power3.in',
        stagger: { each: Math.min(0.012, 0.55 / Math.max(1, cells.length)), from: 'edges' },
      },
      0.05,
    );
    return () => void tl.kill();
  }, [gather]);
  return (
    <div className="tf-mosaic" ref={root}>
      {players.map((p, i) => {
        const src = env.avatars.get(p.uid) ?? null;
        const c = i % cols;
        const r = Math.floor(i / cols);
        // an unfinished last row sits centred under the others
        const rowOx = r === rows - 1 ? ox + ((cols - (n - r * cols)) * cell) / 2 : ox;
        return (
          <div
            key={p.uid}
            className="tf-m-cell"
            style={{ left: rowOx + c * cell + cell * 0.06, top: oy + r * cell + cell * 0.06, width: cell * 0.88, height: cell * 0.88, '--d': `${((c + r) * 0.09).toFixed(2)}s` } as CSSProperties}
          >
            {src ? <img src={src} alt="" /> : <b style={{ fontSize: cell * 0.36 }}>{initialOf(p.name)}</b>}
          </div>
        );
      })}
      <div className="tf-m-band">
        <ChromeText ref={hero} as="h1" split="words" className="tf-m-hero">
          {heroText}
        </ChromeText>
        {sub ? <p className="tf-m-sub">{sub}</p> : null}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ scene

export function Final({ view }: { view: TvView }) {
  const env = useTvEnv();
  const f = view.final;
  const step = f?.step ?? 0;
  const root = useRef<HTMLDivElement | null>(null);
  const mountStep = useRef(step);
  const [conf, setConf] = useState(0);
  const vLabel = view.pub?.vladosLabel || 'Владос';
  const podium = useMemo(() => slotted(f?.podium ?? []), [f?.podium]);
  const texts = env.texts;
  const medal = (pos: number) => ['Золото', texts.podiumSecond || 'Серебро', texts.podiumThird || 'Бронза'][pos] ?? '';

  // drumroll: accelerating ticks under a rising tone
  useEffect(() => {
    if (step !== 0) return;
    const timers: number[] = [];
    let t = 0;
    for (let k = 0; k < 34; k++) {
      t += Math.max(45, 190 - k * 5);
      timers.push(window.setTimeout(() => audio.tick(0.25 + k * 0.012), t));
    }
    timers.push(window.setTimeout(() => audio.rise(1.2), t - 900));
    return () => timers.forEach(clearTimeout);
  }, [step]);

  useBeat(() => {
    const qs = gsap.utils.selector(root);
    const tl = gsap.timeline();
    if (step === 0) {
      tl.fromTo(qs('.tf-roll-h'), { opacity: 0, scale: 0.8 }, { opacity: 1, scale: 1, duration: 1.2, ease: 'power3.out' }, 0);
      tl.fromTo(qs('.tf-q'), { opacity: 0, y: 30 }, { opacity: 0.9, y: 0, duration: 0.8, stagger: 0.2, ease: ease.back }, 0.6);
    } else if (step <= 3) {
      tl.fromTo(qs('.tf-head'), { opacity: 0, y: -14 }, { opacity: 1, y: 0, duration: 0.6 }, 0);
    }
    return tl;
  }, [step <= 3 ? Math.min(step, 1) : step]);

  useEffect(() => {
    if (step === 3 && mountStep.current < 3) {
      const id = window.setTimeout(() => setConf((c) => c + 1), 1500);
      return () => clearTimeout(id);
    }
  }, [step]);
  useEffect(() => {
    if (!conf) return;
    return confetti(root.current, 110);
  }, [conf]);

  // the video after the final (step 6): the mosaic gathers into it; when it ended (or the TV was
  // reloaded after it) the mosaic comes back — a fresh one, with its entrance and confetti
  const finale = view.finale;
  const [after, setAfter] = useState(false);
  const anchor = useRef<HTMLElement | null>(null);
  const onFinaleEnded = useCallback(() => setAfter(true), []);
  // the music comes back under the mosaic after the video (the lobby's pad; «Музыка» decides)
  useEffect(() => {
    if (!after) return;
    audio.drone(true);
    return () => audio.drone(false);
  }, [after]);

  const vSrc = (() => {
    const uid = f?.vlados?.uid ?? view.vladosUid;
    if (!uid) return null;
    return env.avatars.get(uid) ?? null;
  })();

  return (
    <div className={cx('tv-scene tv-final', `s${Math.min(step, 5)}`)} ref={root}>
      {step === 0 ? (
        <div className="tf-roll">
          <i className="tf-beam b1" />
          <i className="tf-beam b2" />
          <ChromeText as="h2" className="tf-roll-h">
            {texts.podiumTitle || 'И лучше всех Владоса знает…'}
          </ChromeText>
          <div className="tf-qs">
            <span className="tf-q">?</span>
            <span className="tf-q">?</span>
            <span className="tf-q">?</span>
          </div>
        </div>
      ) : null}
      {step >= 1 && step <= 3 ? (
        <>
          <div className="tf-head">
            <p className="vx-kick">финал</p>
            <ChromeText as="h2" className="tf-h">
              {texts.podiumTitle || 'И лучше всех Владоса знает…'}
            </ChromeText>
          </div>
          <div className="tf-floor" />
          {podium.map(({ row, pos }) => {
            const revealedAt = 3 - pos;
            const src = env.avatars.get(row.uid) ?? avatarUrl(`thumb:${row.uid}`, row.thumb);
            return <Column key={row.uid} row={row} pos={pos} src={src} animate={revealedAt > mountStep.current} label={medal(pos)} />;
          })}
          {step === 3 ? (
            <p className="tf-champ">
              <span>{texts.podiumFirst || 'Главный знаток Владоса!'}</span>
            </p>
          ) : null}
        </>
      ) : null}
      {step === 4 ? <Versus v={f?.vlados} vLabel={vLabel} texts={texts} src={vSrc} /> : null}
      {step >= 5 ? (
        <Mosaic
          key={after ? 'mosaic-after' : 'mosaic'}
          players={f?.mosaic ?? view.players}
          thanks={texts.thanks || `Спасибо, что играли! С днём рождения, ${vLabel}!`}
          vLabel={vLabel}
          gather={step >= 6 && finale !== null && !after}
        />
      ) : null}
      {step >= 6 && finale ? (
        <>
          <i ref={anchor} className="tfv-anchor" style={{ left: GATHER.x, top: GATHER.y }} />
          <FinaleVideo finale={finale} from={() => anchor.current} onEnded={onFinaleEnded} />
        </>
      ) : null}
    </div>
  );
}
