// Live preview of the question being edited: a phone and the TV, drawn with the same
// design-system primitives as the game (CSS chrome, no extra WebGL context). «Вопрос» shows
// what guests see; «Ответ» shows the reveal.

import { correctOrder } from '@shared/scoring';
import type { Question, Settings } from '@shared/types';
import { shownOrder } from '@shared/engine/select';
import { hashSeed } from '@shared/util';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Badge, Emerge, FitImage, LiquidOff, NumberInput, OptionTile, OrderList, TimerBar, cx, useDecoded } from '../../../visual';
import { KEYS } from '../core/format';
import { useMediaMeta, useMediaUrl } from '../core/media';
import { Chips } from '../ui/kit';
import { Icon } from '../ui/icons';

type Mode = 'question' | 'answer';

function Frame({ kind, width, mode, children }: { kind: 'phone' | 'tv'; width: number; mode?: 'light' | 'dark'; children: ReactNode }) {
  const W = kind === 'phone' ? 390 : 1280;
  const H = kind === 'phone' ? 844 : 720;
  const pad = kind === 'phone' ? 7 : 5;
  const inner = width - pad * 2;
  const s = inner / W;
  return (
    <div className={cx('ad-frame', `ad-frame-${kind}`)} style={{ width }}>
      <div className="ad-frame-inner" style={{ width: inner, height: H * s }}>
        <div className="ad-frame-screen" data-mode={mode} style={{ width: W, height: H, transform: `scale(${s})` } as CSSProperties}>
          <LiquidOff>{children}</LiquidOff>
        </div>
      </div>
    </div>
  );
}

function Img({ id, fallback }: { id: string | undefined; fallback?: ReactNode }) {
  const meta = useMediaMeta(id);
  const src = useMediaUrl(meta?.kind === 'video' ? meta.posterId : id).url;
  if (!id) return <>{fallback ?? null}</>;
  return src ? <img src={src} alt="" /> : <Icon name={meta?.kind === 'video' ? 'video' : 'image'} size={40} />;
}

/**
 * The reveal video in the TV frame of «Ответ»: starts (muted — the editor is no place for sudden
 * sound; the speaker button turns it on) when the droplet splashes open, like the TV plays it.
 */
function PvVideo({ id, landed }: { id: string; landed: boolean }) {
  const { url } = useMediaUrl(id);
  const v = useRef<HTMLVideoElement | null>(null);
  const [sound, setSound] = useState(false);
  useEffect(() => {
    const el = v.current;
    if (!el || !url || !landed) return;
    el.muted = true;
    void el.play().catch(() => undefined);
  }, [url, landed]);
  useEffect(() => {
    if (v.current) v.current.muted = !sound;
  }, [sound]);
  return (
    <>
      {url ? <video ref={v} className="pv-video" src={url} playsInline muted preload="auto" /> : null}
      <button
        type="button"
        className={cx('pv-sound', sound && 'is-on')}
        aria-pressed={sound}
        aria-label={sound ? 'Выключить звук видео' : 'Включить звук видео'}
        onClick={(e) => {
          e.stopPropagation();
          const el = v.current;
          if (!sound && el) {
            el.muted = false;
            if (el.paused) void el.play().catch(() => undefined);
          }
          setSound(!sound);
        }}
      >
        <Icon name="sound" size={16} />
      </button>
    </>
  );
}

/**
 * The question's / the reveal's picture, whole (FitImage: contain on a blurred copy, the box by the
 * photo's proportions). In «Ответ» it emerges from a droplet out of the right answer, like on the
 * phones and the TV (replayed every time «Ответ» is picked). A reveal VIDEO plays in the TV frame
 * (`play`); the phone shows its poster with «▶ на большом экране» (videos are TV-only).
 */
function Pic({ id, fit, reveal, from, play = false }: { id: string; fit: 'box' | 'fill'; reveal: boolean; from: () => Element | null | undefined; play?: boolean }) {
  const meta = useMediaMeta(id);
  const video = meta?.kind === 'video';
  const poster = meta?.kind === 'video' ? meta.posterId : undefined;
  const { url, failed } = useMediaUrl(meta === undefined ? undefined : (poster ?? (video ? undefined : id)));
  const size = meta ? { w: meta.w, h: meta.h } : {};
  const dec = useDecoded(url);
  const [landed, setLanded] = useState(false);
  const onLand = useCallback(() => setLanded(true), []);
  if (video && !poster && !(reveal && play)) {
    return (
      <span className="pv-media-ph">
        <Icon name="video" size={40} />
      </span>
    );
  }
  const img = poster || !video ? <FitImage src={url} failed={failed || meta === null} fit={fit} failLabel="нет картинки" {...size} /> : <span className="pv-media-ph" />;
  if (!reveal) return img;
  return (
    <Emerge
      key={id}
      ready={video && play ? !!meta : dec.ar !== null}
      from={from}
      sound={false}
      radius={fit === 'box' ? 22 : 30}
      className={cx('pv-emerge', `is-${fit}`, video && 'is-video')}
      onLand={onLand}
    >
      {img}
      {video && play ? <PvVideo id={id} landed={landed} /> : null}
      {video && !play ? (
        <span className="pv-tvbadge">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 5.5v13l10.5-6.5z" />
          </svg>
          на большом экране
        </span>
      ) : null}
    </Emerge>
  );
}

const noop = () => undefined;

function PhoneScene({ q, mode, n, total }: { q: Question; mode: Mode; n: number; total: number }) {
  const root = useRef<HTMLDivElement | null>(null);
  const meta = useMediaMeta(q.media?.mediaId);
  const revealMeta = useMediaMeta(q.revealMedia?.mediaId);
  // like the phones: a reveal photo only when shown on phones, a reveal video as its poster
  const revealOnPhone = !!q.revealMedia && (revealMeta?.kind === 'video' || q.revealMedia.onPhones);
  const showMedia = mode === 'answer' ? (revealOnPhone ? (q.revealMedia ?? null) : null) : (q.media ?? null);
  const tvOnly = showMedia && (!showMedia.onPhones || meta?.kind === 'video') && mode === 'question';
  const title = q.title.trim() || 'Текст вопроса появится здесь';
  let answers: ReactNode = null;
  if (q.type === 'choice') {
    const withImg = q.options.some((o) => o.mediaId);
    answers = (
      <div className={cx('pv-answers', withImg && 'is-grid')}>
        {q.options.map((o, i) => (
          <OptionTile
            key={o.id}
            keyLabel={KEYS[i]}
            label={o.text?.trim() || (o.mediaId ? '' : `Вариант ${KEYS[i]}`)}
            media={o.mediaId ? <Img id={o.mediaId} /> : undefined}
            state={mode === 'answer' ? (o.id === q.correctId ? 'correct' : 'wrong') : 'idle'}
            liquid={false}
            onSelect={noop}
          />
        ))}
      </div>
    );
  } else if (q.type === 'number') {
    answers =
      mode === 'answer' ? (
        <div className="pv-answers">
          <p className="vx-kick" style={{ textAlign: 'center' }}>
            Правильный ответ
          </p>
          <p className="pv-numbig vx-chr">
            {q.answer}
            {q.unit ? <small style={{ fontSize: 28 }}> {q.unit}</small> : null}
          </p>
        </div>
      ) : (
        <div className="pv-answers">
          <NumberInput value={null} onChange={noop} min={q.min ?? 0} max={q.max ?? Math.max(100, q.answer * 2)} step={q.step} unit={q.unit} onSubmit={noop} submitLabel="Ответить" />
        </div>
      );
  } else {
    const order = mode === 'answer' ? correctOrder(q) : q.items.length >= 3 ? shownOrder(q, hashSeed(`${q.id}:0`)) : correctOrder(q);
    const items = q.items.map((it, k) => ({ id: it.id, text: it.text?.trim() || `Пункт ${k + 1}`, media: it.mediaId ? <Img id={it.mediaId} /> : undefined }));
    answers = (
      <div className="pv-answers">
        <OrderList items={items} order={order} onChange={noop} firstLabel={q.firstLabel} lastLabel={q.lastLabel} disabled={mode === 'answer'} />
      </div>
    );
  }
  const correctEl = () => root.current?.querySelector('.vx-opt.is-correct, .pv-numbig, .vx-ord');
  return (
    <div className="pv-phone" ref={root}>
      <div className="pv-top">
        <span className="vx-kick">
          Вопрос {n} из {total}
        </span>
        {q.double ? <Badge size="s">×2</Badge> : null}
      </div>
      {mode === 'question' ? <TimerBar endsAt={0} total={q.timeLimitS} frozenAt={q.timeLimitS} /> : null}
      {showMedia ? (
        tvOnly ? (
          <div className="pv-media is-tvonly">
            <Icon name="tv" size={22} /> Смотри на большой экран
          </div>
        ) : (
          <div className="pv-media">
            <Pic key={mode} id={showMedia.mediaId} fit="box" reveal={mode === 'answer'} from={correctEl} />
          </div>
        )
      ) : null}
      <h2 className="pv-title">{title}</h2>
      {mode === 'answer' && q.revealText ? <p className="pv-reveal">{q.revealText}</p> : null}
      {answers}
    </div>
  );
}

function TvScene({ q, mode, n, total }: { q: Question; mode: Mode; n: number; total: number }) {
  const root = useRef<HTMLDivElement | null>(null);
  const media = mode === 'answer' ? (q.revealMedia ?? q.media) : q.media;
  const correctEl = () => root.current?.querySelector('.vx-opt.is-correct, .pv-tv-num, .pv-tv-items');
  const title = q.title.trim() || 'Текст вопроса появится здесь';
  let body: ReactNode = null;
  if (q.type === 'choice') {
    body = (
      <div className="pv-tv-opts">
        {q.options.map((o, i) => (
          <OptionTile
            key={o.id}
            keyLabel={KEYS[i]}
            label={o.text?.trim() || `Вариант ${KEYS[i]}`}
            media={o.mediaId ? <Img id={o.mediaId} /> : undefined}
            state={mode === 'answer' ? (o.id === q.correctId ? 'correct' : 'wrong') : 'idle'}
            liquid={false}
            disabled
          />
        ))}
      </div>
    );
  } else if (q.type === 'number') {
    body =
      mode === 'answer' ? (
        <div className="pv-tv-num">
          <b className="vx-chr">{q.answer}</b>
          {q.unit ?? ''}
        </div>
      ) : (
        <div className="pv-tv-num">
          Введи число{q.unit ? ` (${q.unit})` : ''}
          {q.min !== undefined && q.max !== undefined ? ` от ${q.min} до ${q.max}` : ''}
        </div>
      );
  } else {
    const order = mode === 'answer' ? correctOrder(q) : q.items.length >= 3 ? shownOrder(q, hashSeed(`${q.id}:0`)) : correctOrder(q);
    const byId = new Map(q.items.map((it, k) => [it.id, it.text?.trim() || `Пункт ${k + 1}`]));
    body = (
      <div className="pv-tv-items">
        {order.map((id, k) => (
          <div key={id} className="pv-tv-item lq">
            <b className="vx-eng">{mode === 'answer' ? k + 1 : '•'}</b>
            <span className="vx-eng">{byId.get(id)}</span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="pv-tv" ref={root}>
      <div className="pv-tv-head">
        <span className="vx-kick" style={{ fontSize: 16 }}>
          Вопрос {n} из {total}
        </span>
        {q.double ? <Badge size="l">×2 двойные очки</Badge> : null}
        <span style={{ flex: 1 }} />
        {mode === 'question' ? <span className="vx-kick" style={{ fontSize: 16 }}>{q.timeLimitS} c</span> : <span className="vx-kick" style={{ fontSize: 16 }}>Правильный ответ</span>}
      </div>
      <div className={cx('pv-tv-body', media && 'has-media')}>
        {media ? (
          <div className="pv-tv-media">
            <Pic key={mode} id={media.mediaId} fit="fill" reveal={mode === 'answer'} play={mode === 'answer' && !!q.revealMedia} from={correctEl} />
          </div>
        ) : null}
        <div>
          <h2 className="pv-tv-title">{title}</h2>
          {mode === 'answer' && q.revealText ? <p className="pv-reveal" style={{ marginTop: 18, fontSize: 24 }}>{q.revealText}</p> : null}
          {body}
        </div>
      </div>
      {mode === 'question' ? <TimerBar endsAt={0} total={q.timeLimitS} frozenAt={q.timeLimitS} /> : <span />}
    </div>
  );
}

export function Preview({ q, n, total, settings, width = 320 }: { q: Question; n: number; total: number; settings: Settings; width?: number }) {
  const [mode, setMode] = useState<Mode>('question');
  const tvMode = settings.tvAppearance === 'system' ? undefined : settings.tvAppearance;
  return (
    <div className="ad-preview">
      <div className="ad-frame-cap">
        <span className="vx-kick">Превью</span>
        <Chips
          size="s"
          label="Что показать"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'question', label: 'Вопрос' },
            { value: 'answer', label: 'Ответ' },
          ]}
        />
      </div>
      <Frame kind="tv" width={width} mode={tvMode}>
        <TvScene q={q} mode={mode} n={n} total={total} />
      </Frame>
      <Frame kind="phone" width={Math.round(width * 0.62)}>
        <PhoneScene q={q} mode={mode} n={n} total={total} />
      </Frame>
    </div>
  );
}
