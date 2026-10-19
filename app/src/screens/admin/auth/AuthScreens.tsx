// Sign-in for the organizer: «Войти» / «Создать вход организатора» → «Проверь почту» →
// «Я подтвердил». Also password reset and the «не организатор» dead end with a way out.

import type { User } from 'firebase/auth';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { authErrorCode, createOrganizer, resetPassword, signInAdmin, signOutUser, type AuthErr } from '../../../fb/auth';
import { getFb } from '../../../fb/app';
import { ChromeBlock, ChromeButton, ChromeField, ChromeText, ModeToggle, beats, toast } from '../../../visual';
import { sendVerification } from '../core/auth';
import { Icon } from '../ui/icons';

const ERR: Record<AuthErr, string> = {
  invalid_email: 'Проверь адрес почты',
  wrong_credentials: 'Почта или пароль не подходят',
  email_in_use: 'Такой вход уже есть — просто войди',
  weak_password: 'Пароль слишком простой: минимум 6 символов',
  too_many_requests: 'Слишком много попыток — подожди минутку',
  network: 'Нет связи с сервером — проверь интернет',
  disabled: 'Этот способ входа выключен',
  unknown: 'Что-то пошло не так — попробуй ещё раз',
};

function AuthFrame({ children, lead, title = 'Пульт организатора' }: { children: ReactNode; lead?: ReactNode; title?: string }) {
  const hero = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = hero.current?.querySelector<HTMLElement>('.ad-auth-title');
    if (el) beats.riseLetters(el);
  }, []);
  return (
    <div className="ad-center">
      <div className="ad-auth">
        <div ref={hero} className="ad-auth-hero">
          <p className="vx-kick">Кто лучше знает Владоса · 26.09</p>
          <ChromeText as="h1" className="ad-auth-title" split="chars">
            {title}
          </ChromeText>
          {lead ? <p className="ad-auth-lead">{lead}</p> : null}
        </div>
        {children}
        <div className="ad-auth-foot">
          <ModeToggle size="s" labels={false} />
        </div>
      </div>
    </div>
  );
}

export function LoginScreen() {
  const fb = getFb();
  const [mode, setMode] = useState<'login' | 'create'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!email.includes('@')) return setError(ERR.invalid_email);
    if (password.length < 6) return setError(ERR.weak_password);
    if (mode === 'create' && password !== password2) return setError('Пароли не совпадают');
    setBusy(true);
    try {
      if (mode === 'login') await signInAdmin(fb.auth, email, password);
      else {
        const user = await createOrganizer(fb.auth, email, password);
        try {
          await sendVerification(user);
        } catch {
          // the verify screen has «Отправить ещё раз»
        }
      }
    } catch (e) {
      const code = authErrorCode(e);
      if (code === 'email_in_use') setMode('login');
      setError(mode === 'login' && code === 'wrong_credentials' ? `${ERR.wrong_credentials}. Первый раз здесь? Создай вход ↓` : ERR[code]);
    } finally {
      setBusy(false);
    }
  };

  const forgot = async () => {
    setError(null);
    if (!email.includes('@')) return setError('Впиши почту — пришлём ссылку для нового пароля');
    try {
      await resetPassword(fb.auth, email);
      toast('Письмо со ссылкой отправлено — загляни в почту', { tone: 'good', ms: 5000 });
    } catch (e) {
      setError(ERR[authErrorCode(e)]);
    }
  };

  return (
    <AuthFrame lead={mode === 'login' ? 'Вопросы, настройки и кнопка «Поехали!» — всё здесь.' : 'Придумай пароль — им будешь входить с телефона и ноутбука. Потом подтвердишь почту.'}>
      <div className="ad-card ad-auth-card">
        <div className="ad-auth-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'login'} onClick={() => setMode('login')}>
            Войти
          </button>
          <button type="button" role="tab" aria-selected={mode === 'create'} onClick={() => setMode('create')}>
            Создать вход
          </button>
        </div>
        <ChromeField
          label="Почта"
          type="email"
          autoComplete="email"
          inputMode="email"
          value={email}
          onChange={setEmail}
          placeholder="you@mail.ru"
          onSubmit={() => void submit()}
        />
        <ChromeField
          label="Пароль"
          type="password"
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          value={password}
          onChange={setPassword}
          placeholder="••••••••"
          onSubmit={() => void submit()}
        />
        {mode === 'create' ? (
          <ChromeField label="Пароль ещё раз" type="password" autoComplete="new-password" value={password2} onChange={setPassword2} placeholder="••••••••" onSubmit={() => void submit()} />
        ) : null}
        {error ? (
          <p className="ad-hint is-error" role="alert">
            {error}
          </p>
        ) : null}
        <ChromeButton variant="film" block loading={busy} onClick={() => void submit()}>
          {mode === 'login' ? 'Войти в пульт' : 'Создать вход организатора'}
        </ChromeButton>
        {mode === 'login' ? (
          <button type="button" className="ad-link" style={{ alignSelf: 'center' }} onClick={() => void forgot()}>
            Забыл пароль
          </button>
        ) : (
          <p className="ad-hint" style={{ textAlign: 'center' }}>
            Пульт откроется только для адресов из списка организаторов — после подтверждения почты.
          </p>
        )}
      </div>
    </AuthFrame>
  );
}

export function VerifyScreen({ user, recheck }: { user: User; recheck: () => Promise<boolean> }) {
  const fb = getFb();
  const [busy, setBusy] = useState(false);
  const [sentAt, setSentAt] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);

  // The link is usually opened on the phone: keep checking while this page is visible.
  useEffect(() => {
    // reload() is an Auth call (no Firestore read); the rules are asked only once it flips.
    const id = setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      const u = fb.auth.currentUser;
      await u?.reload().catch(() => undefined);
      if (fb.auth.currentUser?.emailVerified) void recheck();
    }, 5000);
    return () => clearInterval(id);
  }, [fb, recheck]);

  const confirm = async () => {
    setBusy(true);
    setMsg(null);
    const ok = await recheck();
    setBusy(false);
    if (!ok) setMsg(fb.auth.currentUser?.emailVerified ? 'Почта подтверждена, но этого адреса нет в списке организаторов.' : 'Пока не видно подтверждения. Открой ссылку из письма и нажми ещё раз.');
  };

  const resend = async () => {
    if (Date.now() - sentAt < 30_000) return setMsg('Письмо только что ушло — подожди полминуты');
    try {
      await sendVerification(user);
      setSentAt(Date.now());
      toast('Отправили ещё одно письмо', { tone: 'good' });
    } catch (e) {
      setMsg(ERR[authErrorCode(e)]);
    }
  };

  return (
    <AuthFrame title="Проверь почту" lead="Мы отправили письмо со ссылкой. Открой его (можно с телефона), нажми ссылку — и возвращайся сюда.">
      <div className="ad-card ad-auth-card">
        <ChromeBlock shape="circle" className="ad-mailart" film={0.8}>
          <Icon name="mail" size={40} />
        </ChromeBlock>
        <p className="ad-envline">{user.email}</p>
        <p className="ad-hint" style={{ textAlign: 'center' }}>
          Нет письма? Загляни в «Спам» или «Рассылки». Страница сама заметит подтверждение.
        </p>
        {msg ? (
          <p className="ad-hint is-error" role="alert" style={{ textAlign: 'center' }}>
            {msg}
          </p>
        ) : null}
        <ChromeButton variant="film" block loading={busy} onClick={() => void confirm()}>
          Я подтвердил
        </ChromeButton>
        <div className="ad-row" style={{ justifyContent: 'center' }}>
          <button type="button" className="ad-link" onClick={() => void resend()}>
            Отправить ещё раз
          </button>
          <span className="ad-muted">·</span>
          <button type="button" className="ad-link" onClick={() => void signOutUser(fb.auth)}>
            Другой адрес
          </button>
        </div>
      </div>
    </AuthFrame>
  );
}

export function NotAdminScreen({ user, offline, recheck }: { user: User; offline?: boolean; recheck: () => Promise<boolean> }) {
  const fb = getFb();
  const [busy, setBusy] = useState(false);
  return (
    <AuthFrame
      title={offline ? 'Нет связи' : 'Это не пульт'}
      lead={
        offline
          ? 'Не получилось проверить доступ — похоже, пропал интернет.'
          : 'Этот адрес не в списке организаторов. Попроси главного организатора добавить его в «Настройки → Организаторы».'
      }
    >
      <div className="ad-card ad-auth-card">
        <p className="ad-envline">{user.email}</p>
        <ChromeButton
          block
          loading={busy}
          onClick={async () => {
            setBusy(true);
            await recheck();
            setBusy(false);
          }}
        >
          Проверить ещё раз
        </ChromeButton>
        <ChromeButton variant="ghost" block onClick={() => void signOutUser(fb.auth)}>
          Выйти и войти с другой почтой
        </ChromeButton>
      </div>
    </AuthFrame>
  );
}

export function LoadingScreen({ text = 'Открываю пульт…' }: { text?: string }) {
  return (
    <div className="ad-center">
      <div className="ad-loading">
        <ChromeBlock shape="circle" className="ad-loading-drop" film={0.7} />
        <p className="vx-kick">{text}</p>
      </div>
    </div>
  );
}
