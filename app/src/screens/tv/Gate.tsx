// Before the show: the organizer's one-time login on the Mac, then the «Начать шоу» gate (one
// click = fullscreen + sound + the unlocked video element).

import { useEffect, useRef, useState } from 'react';
import { ChromeButton, ChromeField, ChromeText, beats, cx, plural } from '../../visual';
import { getFb } from '../../fb/app';
import { authErrorCode, resetPassword, signInAdmin, signOutUser, type AuthErr } from '../../fb/auth';
import type { TvView } from '../../host';
import { useBeat } from './common';

const AUTH_TEXT: Record<AuthErr, string> = {
  invalid_email: 'Похоже, в почте опечатка',
  wrong_credentials: 'Почта или пароль не подходят',
  email_in_use: 'Эта почта уже занята',
  weak_password: 'Пароль слишком простой',
  too_many_requests: 'Слишком много попыток — подожди минутку',
  network: 'Нет интернета — проверь Wi-Fi на Mac',
  disabled: 'Этот вход отключён',
  unknown: 'Не получилось войти — попробуй ещё раз',
};

export function TvLogin() {
  const root = useRef<HTMLDivElement | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useBeat(() => beats.fadeUp(Array.from(root.current?.querySelectorAll('.tg-fade') ?? []), { stagger: 0.08 }), []);

  const submit = async () => {
    if (busy) return;
    if (!email.trim() || !password) {
      setErr('Введи почту и пароль организатора');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await signInAdmin(getFb().auth, email, password);
    } catch (e) {
      setErr(AUTH_TEXT[authErrorCode(e)]);
      setBusy(false);
    }
  };
  const reset = async () => {
    if (!email.trim()) {
      setErr('Сначала впиши почту — пришлём ссылку для нового пароля');
      return;
    }
    try {
      await resetPassword(getFb().auth, email);
      setNote(`Письмо со ссылкой для нового пароля ушло на ${email.trim()}`);
      setErr(null);
    } catch (e) {
      setErr(AUTH_TEXT[authErrorCode(e)]);
    }
  };

  return (
    <div className="tv-scene tv-gate" ref={root}>
      <div className="tg-col">
        <p className="vx-kick tg-fade">большой экран</p>
        <ChromeText as="h1" className="tg-h tg-fade">
          Вход организатора
        </ChromeText>
        <p className="tg-p tg-fade">Один раз на этом Mac — дальше экран сам всё запомнит.</p>
        <form
          className="tg-form tg-fade"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <ChromeField value={email} onChange={setEmail} label="Почта" type="email" autoComplete="username" inputMode="email" autoFocus />
          <ChromeField value={password} onChange={setPassword} label="Пароль" type="password" autoComplete="current-password" onSubmit={() => void submit()} error={err} />
          <ChromeButton type="submit" size="l" block loading={busy}>
            Войти
          </ChromeButton>
          <ChromeButton variant="ghost" size="s" onClick={() => void reset()}>
            Забыл пароль
          </ChromeButton>
          {note ? <p className="tg-note">{note}</p> : null}
        </form>
        <p className="tg-foot tg-fade">
          Ещё нет входа? Создай его в админке: <b>{location.host}{location.pathname}#/admin</b>
        </p>
      </div>
    </div>
  );
}

export function TvNotAdmin({ email }: { email: string | null }) {
  return (
    <div className="tv-scene tv-gate">
      <div className="tg-col">
        <p className="vx-kick">большой экран</p>
        <ChromeText as="h1" className="tg-h">
          Это не вход организатора
        </ChromeText>
        <p className="tg-p">
          {email ? <b>{email}</b> : 'Этот аккаунт'} не может вести игру. Войди с почтой организатора или добавь эту почту в админке → «Организаторы».
        </p>
        <ChromeButton onClick={() => void signOutUser(getFb().auth)}>Выйти и войти заново</ChromeButton>
      </div>
    </div>
  );
}

export function TvWait({ text, sub, action }: { text: string; sub?: string; action?: { label: string; run: () => void } }) {
  return (
    <div className="tv-scene tv-gate">
      <div className="tg-col is-center">
        <i className="tv-drop-spin" aria-hidden="true" />
        <ChromeText as="h2" className="tg-h2">
          {text}
        </ChromeText>
        {sub ? <p className="tg-p">{sub}</p> : null}
        {action ? <ChromeButton onClick={action.run}>{action.label}</ChromeButton> : null}
      </div>
    </div>
  );
}

function statusLine(v: TvView | null): string {
  if (!v || !v.phase) return 'Подключаемся к игре…';
  const n = v.players.length;
  const guests = `${n} ${plural(n, ['гость', 'гостя', 'гостей'])}`;
  const q = v.question;
  switch (v.phase) {
    case 'lobby':
      return `Лобби открыто · ${guests}`;
    case 'intro':
    case 'open':
    case 'locked':
      return `Идёт вопрос ${q?.n ?? ''} из ${q?.total ?? ''} · ${guests}`;
    case 'reveal':
      return `Ответ на вопрос ${q?.n ?? ''} · ${guests}`;
    case 'board':
      return `Таблица после вопроса ${q?.n ?? ''} · ${guests}`;
    case 'final':
      return `Финал · ${guests}`;
  }
}

export function StartGate({
  view,
  email,
  media,
  video,
  onStart,
}: {
  view: TvView | null;
  email: string | null;
  media: { done: number; total: number; failed: number } | null;
  /** The big built-in video of a question (loaded whole into memory; neutral words: it is a surprise). */
  video?: { state: 'idle' | 'loading' | 'ready' | 'failed'; done: number; total: number };
  onStart: () => void;
}) {
  const root = useRef<HTMLDivElement | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);
  useBeat(() => {
    const els = Array.from(root.current?.querySelectorAll('.tg-fade') ?? []);
    const tl = beats.fadeUp(els, { stagger: 0.08 });
    if (btn.current) tl.add(beats.popIn(btn.current, { from: 0.5 }), 0.3);
    return tl;
  }, []);
  useEffect(() => btn.current?.focus({ preventScroll: true }), []);
  const pct = media && media.total ? Math.round((media.done / media.total) * 100) : 100;
  return (
    <div className="tv-scene tv-gate" ref={root}>
      <div className="tg-col is-center">
        <p className="vx-kick tg-fade">большой экран готов</p>
        <ChromeText as="h1" className="tg-h tg-fade">
          {view?.pub?.title || 'Кто лучше знает Владоса'}
        </ChromeText>
        <p className="tg-status tg-fade">{statusLine(view)}</p>
        <ChromeButton ref={btn} size="l" variant="film" className="tg-go" onClick={onStart}>
          Начать шоу
        </ChromeButton>
        <p className="tg-p tg-fade">Экран развернётся на весь экран, включится звук и видео.</p>
        {media && media.total > 0 ? (
          <div className={cx('tg-media tg-fade', media.done >= media.total && 'is-done')}>
            <span>
              {media.done >= media.total
                ? media.failed
                  ? `Медиа загружены, кроме ${media.failed} — проверь их в админке`
                  : `Все фото и видео уже на этом Mac (${media.total})`
                : `Загружаем фото и видео заранее: ${media.done} из ${media.total}`}
            </span>
            <i style={{ transform: `scaleX(${pct / 100})` }} />
          </div>
        ) : null}
        {video && video.state !== 'idle' ? (
          <div className={cx('tg-media tg-fade', video.state === 'ready' && 'is-done')}>
            <span>
              {video.state === 'ready'
                ? `Большое видео уже в памяти этого Mac (${Math.round(video.total / 1048576)} МБ)`
                : video.state === 'failed'
                  ? 'Большое видео не загрузилось заранее — сыграет прямо с сайта'
                  : `Загружаем большое видео в память: ${Math.round(video.done / 1048576)}${video.total ? ` из ${Math.round(video.total / 1048576)}` : ''} МБ`}
            </span>
            <i style={{ transform: `scaleX(${video.state === 'ready' ? 1 : video.total ? video.done / video.total : 0})` }} />
          </div>
        ) : null}
        <p className="tg-keys tg-fade">
          <kbd>Пробел</kbd> дальше · <kbd>P</kbd> пауза · <kbd>M</kbd> звук · <kbd>F</kbd> весь экран · <kbd>H</kbd> подсказка
        </p>
        {email ? (
          <p className="tg-foot tg-fade">
            Вход: {email} ·{' '}
            <button type="button" className="tg-link" onClick={() => void signOutUser(getFb().auth)}>
              выйти
            </button>
          </p>
        ) : null}
      </div>
    </div>
  );
}
