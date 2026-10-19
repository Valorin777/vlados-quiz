// Small shared pieces of the phone screens: top bar, status pills, question media, hero title.

import { useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import type { PubMedia } from '@shared/fbtypes';
import type { PlayerView } from '../../host/views';
import {
  APPEARANCE_KEY,
  APPEARANCE_OPTIONS,
  Avatar,
  ChromeText,
  FitImage,
  LiquidOff,
  ModeToggle,
  Odometer,
  audio,
  cx,
  setAppearance,
  setAppearanceOverride,
  useAppearance,
  useDecoded,
  type AppearancePref,
} from './vx';
import { heroSize, splitTitle } from './format';
import { useBytesUrl, useMediaUrl } from './hooks';
import type { PlayerActions } from './types';

// ------------------------------------------------------------------ top bar

/** True once this device picked a look itself (then the organizer's default no longer applies). */
export function hasOwnAppearance(): boolean {
  try {
    return localStorage.getItem(APPEARANCE_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Светлая / Тёмная / Авто (icons). Shows the organizer's default (an override) until the guest
 * picks; picking clears the override and wipes the new look in from the tapped segment.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const a = useAppearance();
  const value = a.override ?? a.pref;
  const pick = (v: AppearancePref) => {
    const k = APPEARANCE_OPTIONS.findIndex((o) => o.value === v);
    const btn = document.querySelectorAll<HTMLElement>('.pl-mode .vx-mode-opt')[k];
    const r = btn?.getBoundingClientRect();
    setAppearanceOverride(null);
    setAppearance(v, r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : undefined);
  };
  return <ModeToggle size="s" labels={false} label="Оформление" value={value} onChange={pick} className={cx('pl-mode', className)} />;
}

function useMuted(): boolean {
  return useSyncExternalStore(
    (fn) => audio.subscribe(fn),
    () => audio.isMuted,
    () => true,
  );
}

export function SoundToggle() {
  const muted = useMuted();
  return (
    <button
      type="button"
      className={cx('pl-sound', !muted && 'is-on')}
      aria-pressed={!muted}
      aria-label={muted ? 'Включить звук' : 'Выключить звук'}
      onClick={() => {
        const m = audio.toggleMuted();
        if (!m) audio.drop(1.2, 0.35);
      }}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z" />
        {muted ? <path d="m16 9.5 5 5m0-5-5 5" /> : <path d="M16 8.8a4.6 4.6 0 0 1 0 6.4M18.6 6.4a8 8 0 0 1 0 11.2" />}
      </svg>
    </button>
  );
}

/**
 * The corner of every screen: who you are (+ score during the game) on the left, the theme
 * switch (and sound, in game) on the right. Part of the flow, so it never covers content.
 */
export function Hud({ view, game = false, left }: { view: PlayerView; game?: boolean; left?: ReactNode }) {
  const me = view.me;
  const thumb = useBytesUrl(me?.thumb ?? me?.avatar);
  return (
    <header className="pl-hud">
      <div className="pl-hud-l">
        {left ??
          (me && game ? (
            <span className="pl-chip">
              <Avatar name={me.name} src={thumb} size={26} decorative />
              <span className="pl-chip-name">{me.name}</span>
              {view.score && !me.isVlados ? (
                <b className="pl-chip-score vx-mono">
                  <Odometer value={view.score.tot} />
                </b>
              ) : null}
              {me.isVlados ? <i className="pl-chip-rank is-out">вне зачёта</i> : view.score?.rank ? <i className="pl-chip-rank">#{view.score.rank}</i> : null}
            </span>
          ) : null)}
      </div>
      <div className="pl-hud-r">
        {game ? <SoundToggle /> : null}
        <ThemeToggle />
      </div>
    </header>
  );
}

// ------------------------------------------------------------------ status pills (never block the UI)

export function StatusPills({ view, osOnline }: { view: PlayerView; osOnline: boolean }) {
  const offline = view.screen !== 'loading' && (!view.online || !osOnline);
  // the «стоп-экран» says it itself (Status.Hold)
  const paused = view.pause !== null && view.hold === null && !offline;
  if (!offline && !paused) return null;
  return (
    <LiquidOff>
      <div className="pl-pills" role="status" aria-live="polite">
        {offline ? (
          <p className="pl-pill is-off">
            <i aria-hidden="true" />
            {view.texts.reconnecting}
          </p>
        ) : (
          <p className="pl-pill is-pause">
            <i aria-hidden="true" />
            {view.texts.paused}
          </p>
        )}
      </div>
    </LiquidOff>
  );
}

// ------------------------------------------------------------------ media

/** A small picture (option / ordering item thumbnail, cropped to its square): shown once decoded. */
export function MediaImg({ actions, id, alt, className }: { actions: PlayerActions; id: string; alt: string; className?: string }) {
  const { url, failed } = useMediaUrl(actions, id);
  const dec = useDecoded(url);
  const ready = !!url && dec.ar !== null;
  const bad = failed || dec.failed;
  return (
    <span className={cx('pl-img', !ready && !bad && 'is-loading', bad && 'is-failed', className)}>
      {ready ? <img src={url} alt={alt} /> : bad ? <span className="pl-img-miss">картинка не загрузилась</span> : null}
    </span>
  );
}

/**
 * A photo that is never cropped (the question's picture, the reveal picture): see FitImage. `w`/`h`
 * (PubMedia) reserve its box before the file is decoded, so nothing below it jumps when it lands.
 */
export function MediaFit({ actions, id, alt, className, w, h }: { actions: PlayerActions; id: string; alt: string; className?: string; w?: number | undefined; h?: number | undefined }) {
  const { url, failed } = useMediaUrl(actions, id);
  return <FitImage src={url} alt={alt} failed={failed} fit="box" {...(w && h ? { w, h } : {})} {...(className ? { className } : {})} />;
}

/**
 * The question's picture; a video shows its poster whatever «на телефонах» says — videos play ONLY
 * on the TV (organizer, 2026-09-23). `compact`: a one-line note instead of the poster (the options
 * right after a watched video must fit on a small phone without scrolling).
 */
export function QuestionMedia({ actions, media, title, compact = false }: { actions: PlayerActions; media: PubMedia; title: string; compact?: boolean }) {
  if (media.kind === 'video' ? !media.posterId || compact : !media.onPhones) {
    return (
      <div className="pl-qm is-tv">
        <span className="pl-qm-eye" aria-hidden="true">
          ◉
        </span>
        <span>{media.kind === 'video' ? 'Видео — на большом экране' : 'Картинка — на большом экране'}</span>
      </div>
    );
  }
  if (media.kind === 'video') {
    return (
      <figure className="pl-qm is-video">
        {media.posterId ? <MediaFit actions={actions} id={media.posterId} alt={title} w={media.w} h={media.h} /> : <span className="pl-img" />}
        <figcaption>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 5.5v13l10.5-6.5z" />
          </svg>
          Видео — на большом экране
        </figcaption>
      </figure>
    );
  }
  return (
    <figure className="pl-qm">
      <MediaFit actions={actions} id={media.mediaId} alt={title} w={media.w} h={media.h} />
    </figure>
  );
}

// ------------------------------------------------------------------ hero title

export function HeroTitle({ title, className, heroRef, max }: { title: string; className?: string; heroRef?: (el: HTMLElement | null) => void; max?: number }) {
  const { lead, hero } = splitTitle(title);
  return (
    <h1 className={cx('pl-title', className)}>
      {lead ? <span className="pl-title-lead">{lead}</span> : null}
      <ChromeText ref={heroRef} split="chars" className="pl-title-hero" style={{ fontSize: heroSize(hero, max) } as CSSProperties}>
        {hero}
      </ChromeText>
    </h1>
  );
}
