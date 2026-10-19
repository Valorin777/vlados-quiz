// Frame of the panel: rail (laptop) / top bar + dock (phone), with a liquid chrome thumb that
// flows to the active section; the save chip; routes of the five sections.

import { gsap } from 'gsap';
import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Redirect, Route, Switch, useLocation } from 'wouter';
import { ChromeBlock, LiquidOff, ModeToggle, cx, reducedMotion, useChromeBlob } from '../../../visual';
import { useContent } from '../core/content';
import { PHASE_SHORT, nPlayers } from '../core/format';
import { useAdmin, useHostValue } from '../core/session';
import { LiveTab } from '../live/LiveTab';
import { PlayersTab } from '../players/PlayersTab';
import { QuestionsTab } from '../questions/QuestionsTab';
import { REHEARSAL_PATH, RehearsalRoute } from '../rehearsal/RehearsalButton';
import { ResultsTab } from '../results/ResultsTab';
import { SettingsTab } from '../settings/SettingsTab';
import { Dot, UndoBar } from '../ui/kit';
import { Icon, type IconName } from '../ui/icons';
import { PHONE_QUERY, useMedia } from '../ui/media-query';
import { Onboarding } from './Onboarding';

interface Section {
  path: string;
  label: string;
  short: string;
  icon: IconName;
}

const SECTIONS: readonly Section[] = [
  { path: '/live', label: 'Эфир', short: 'Эфир', icon: 'live' },
  { path: '/questions', label: 'Вопросы', short: 'Вопросы', icon: 'list' },
  { path: '/players', label: 'Игроки', short: 'Игроки', icon: 'users' },
  { path: '/results', label: 'Итоги', short: 'Итоги', icon: 'trophy' },
  { path: '/settings', label: 'Настройки', short: 'Настройки', icon: 'gear' },
];

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <a className="ad-brand" href="#/admin/live" aria-label="Пульт — эфир">
      <ChromeBlock shape="circle" className="ad-brand-drop" film={0.9} liquid={!compact} />
      <span className="ad-brand-t">
        <span className="ad-brand-name vx-chr">Пульт</span>
        {!compact ? <span className="ad-brand-sub">Кто лучше знает Владоса</span> : null}
      </span>
    </a>
  );
}

export function SaveChip() {
  const { content } = useAdmin();
  const c = useContent(content);
  if (c.status !== 'ready') return null;
  const map = {
    idle: ['Всё сохранено', 'is-saved'],
    pending: ['Изменено…', 'is-saving'],
    saving: ['Сохраняю…', 'is-saving'],
    saved: ['Сохранено', 'is-saved'],
    error: ['Не сохранилось — повторю', 'is-error'],
  } as const;
  const [text, cls] = map[c.save];
  return (
    <span className={cx('ad-savechip', cls)} role="status" aria-live="polite" title={c.error ?? undefined}>
      <i />
      {text}
    </span>
  );
}

/** Phase + players + who drives the game; compact for the phone top bar. */
function LiveStatus({ compact = false }: { compact?: boolean }) {
  const st = useHostValue((h) => {
    const s = h.snapshot();
    const now = h.now();
    const lease = s.lease;
    const kicked = new Set(s.game?.kicked ?? []);
    const players = Object.entries(s.players).filter(([uid, p]) => !p.kicked && !kicked.has(uid)).length;
    const leaseOk = !!lease && lease.until > now;
    return {
      phase: s.game?.phase ?? null,
      players,
      paused: !!s.game?.pause,
      n: s.game?.round?.n ?? (s.game?.round ? s.game.round.i + 1 : null),
      total: s.game?.round?.total ?? null,
      leaseOk,
      leaseLabel: leaseOk ? (lease.session === s.session ? 'этот пульт' : lease.label === 'tv' ? 'экран ТВ' : 'другой пульт') : null,
      online: s.health.listeners.game === 'live',
    };
  }, 2000);
  const tone = !st.online ? 'bad' : st.leaseOk ? 'good' : 'warn';
  if (compact) {
    return (
      <span className="ad-savechip" title={st.online ? 'Связь есть' : 'Нет связи'}>
        <Dot tone={tone} />
        {st.phase ? PHASE_SHORT[st.phase] : '…'}
        {st.paused ? ' · пауза' : ''}
      </span>
    );
  }
  return (
    <div className="ad-status">
      <div className="ad-status-row">
        <Dot tone={tone} />
        <span className="ad-status-phase">
          {st.phase ? PHASE_SHORT[st.phase] : 'Подключаюсь…'}
          {st.phase && st.phase !== 'lobby' && st.phase !== 'final' && st.n ? ` · ${st.n}${st.total ? `/${st.total}` : ''}` : ''}
          {st.paused ? ' · пауза' : ''}
        </span>
      </div>
      <div className="ad-status-row">
        <Icon name="users" size={15} />
        <b>{nPlayers(st.players)}</b>
      </div>
      <div className="ad-status-row">
        <Icon name="tv" size={15} />
        <span>{!st.online ? 'Нет связи с базой' : st.leaseLabel ? `Ведёт: ${st.leaseLabel}` : 'Ведущий не выбран'}</span>
      </div>
    </div>
  );
}

/** A liquid chrome thumb that flows between the items of a nav. */
function useFlowThumb(active: number, axis: 'x' | 'y') {
  const wrap = useRef<HTMLDivElement | null>(null);
  const thumb = useRef<HTMLSpanElement | null>(null);
  const items = useRef<(HTMLElement | null)[]>([]);
  const first = useRef(true);
  const blob = useChromeBlob(thumb, { shape: 'box', film: 0.55, cr: axis === 'y' ? 15 : 21 });

  const place = useCallback(
    (animate: boolean) => {
      const t = thumb.current;
      const el = items.current[active];
      if (!t) return;
      if (!el) {
        gsap.set(t, { opacity: 0 });
        return;
      }
      const pos = axis === 'y' ? { y: el.offsetTop, x: 0, width: el.offsetWidth, height: el.offsetHeight } : { x: el.offsetLeft, y: 0, width: el.offsetWidth };
      gsap.killTweensOf(t);
      if (!animate || reducedMotion()) {
        gsap.set(t, { ...pos, opacity: 1 });
        return;
      }
      const key = axis === 'y' ? 'y' : 'x';
      const size = axis === 'y' ? 'height' : 'width';
      const from = Number(gsap.getProperty(t, key)) || 0;
      const fromSize = Number(gsap.getProperty(t, size)) || (axis === 'y' ? el.offsetHeight : el.offsetWidth);
      const to = axis === 'y' ? el.offsetTop : el.offsetLeft;
      const toSize = axis === 'y' ? el.offsetHeight : el.offsetWidth;
      const lo = Math.min(from, to);
      const hi = Math.max(from + fromSize, to + toSize);
      gsap
        .timeline()
        .set(t, { opacity: 1 })
        .to(t, { [key]: lo, [size]: hi - lo, duration: 0.18, ease: 'power2.in' })
        .to(t, { ...pos, duration: 0.75, ease: 'elastic.out(1,0.62)' });
      if (blob.current) gsap.fromTo(blob.current, { glow: 0.35 }, { glow: 0, duration: 0.9 });
    },
    [active, axis, blob],
  );

  useLayoutEffect(() => {
    place(!first.current);
    first.current = false;
  }, [place]);

  useEffect(() => {
    const w = wrap.current;
    if (!w || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(() => place(false));
    ro.observe(w);
    return () => ro.disconnect();
  }, [place]);

  return { wrap, thumb, items };
}

function useBadges(): Record<string, number> {
  const players = useHostValue((h) => Object.values(h.snapshot().players).filter((p) => !p.kicked).length, 0);
  return { '/players': players };
}

function RailNav({ active, go }: { active: number; go: (p: string) => void }) {
  const { wrap, thumb, items } = useFlowThumb(active, 'y');
  const badges = useBadges();
  return (
    <nav ref={wrap} className="ad-nav" aria-label="Разделы">
      <span ref={thumb} className="ad-nav-thumb lq" aria-hidden="true" />
      {SECTIONS.map((s, i) => (
        <button
          key={s.path}
          ref={(n) => {
            items.current[i] = n;
          }}
          type="button"
          className={cx('ad-nav-item', i === active && 'is-on')}
          aria-current={i === active ? 'page' : undefined}
          onClick={() => go(s.path)}
        >
          <Icon name={s.icon} size={19} />
          {s.label}
          {badges[s.path] ? <span className="ad-nav-badge">{badges[s.path]}</span> : null}
        </button>
      ))}
    </nav>
  );
}

function Dock({ active, go }: { active: number; go: (p: string) => void }) {
  const { wrap, thumb, items } = useFlowThumb(active, 'x');
  return (
    <nav ref={wrap} className="ad-dock" aria-label="Разделы">
      <span ref={thumb} className="ad-dock-thumb lq" aria-hidden="true" />
      {SECTIONS.map((s, i) => (
        <button
          key={s.path}
          ref={(n) => {
            items.current[i] = n;
          }}
          type="button"
          className={cx('ad-dock-item', i === active && 'is-on')}
          aria-current={i === active ? 'page' : undefined}
          onClick={() => go(s.path)}
        >
          <Icon name={s.icon} size={21} />
          {s.short}
        </button>
      ))}
    </nav>
  );
}

export function Shell() {
  const { backend, user, content } = useAdmin();
  const c = useContent(content);
  const [loc, navigate] = useLocation();
  const active = SECTIONS.findIndex((s) => loc === s.path || loc.startsWith(`${s.path}/`));
  const phone = useMedia(PHONE_QUERY);
  const go = (p: string) => {
    navigate(p);
    window.scrollTo({ top: 0 });
  };
  // «Прогнать игру» owns the whole screen (the panel's frame stays out of the way)
  if (loc === REHEARSAL_PATH) return <RehearsalRoute />;

  let body: ReactNode;
  if (c.status === 'loading')
    body = (
      <div className="ad-loading" style={{ padding: '18vh 0' }}>
        <ChromeBlock shape="circle" className="ad-loading-drop" film={0.7} />
        <p className="vx-kick">Загружаю вопросы… если долго — проверь интернет</p>
      </div>
    );
  else if (c.status === 'missing') body = <Onboarding />;
  else
    body = (
      <Switch>
        <Route path="/live" component={LiveTab} />
        <Route path="/questions/:id?" component={QuestionsTab} />
        <Route path="/players" component={PlayersTab} />
        <Route path="/results" component={ResultsTab} />
        <Route path="/settings" component={SettingsTab} />
        <Route>
          <Redirect to="/live" replace />
        </Route>
      </Switch>
    );

  return (
    <div className="ad-shell">
      {!phone ? (
        <aside className="ad-rail">
          <Brand />
          <RailNav active={active} go={go} />
          <div className="ad-rail-foot">
            <LiveStatus />
            <div className="ad-row" style={{ justifyContent: 'space-between' }}>
              <SaveChip />
              <ModeToggle size="s" labels={false} />
            </div>
            <div className="ad-me">
              <Icon name="lock" size={14} />
              <span title={user.email ?? ''}>{user.email}</span>
              <button type="button" className="ad-ibtn is-s" aria-label="Выйти" title="Выйти" onClick={() => void backend.signOut()}>
                <Icon name="logout" size={16} />
              </button>
            </div>
          </div>
        </aside>
      ) : (
        <header className="ad-top">
          <LiquidOff>
            <Brand compact />
          </LiquidOff>
          <div className="ad-top-right">
            <SaveChip />
            <LiveStatus compact />
          </div>
        </header>
      )}
      <main className="ad-main">
        <div className="ad-page">{body}</div>
      </main>
      {phone ? (
        <LiquidOff>
          <Dock active={active} go={go} />
        </LiquidOff>
      ) : null}
      <UndoBar />
    </div>
  );
}
