// One Host + one content store per signed-in admin page. Screens read AdminView (live game) and
// the content draft (editor); commands go through run() so every tab reports errors the same way.

import type { User } from 'firebase/auth';
import { createContext, useContext, useEffect, useReducer, useState, type ReactNode } from 'react';
import { getFb } from '../../../fb/app';
import { currentEnv } from '../../../fb/env';
import { Host, type AdminView, type CmdResult, type HostCommand } from '../../../host';
import { workerWake } from '../../../host/wake';
import { toast } from '../../../visual';
import { firebaseBackend, type AdminBackend, type AdminUser, type HostLike } from './backend';
import { ContentStore } from './content';

export interface AdminSession {
  user: AdminUser;
  host: HostLike;
  content: ContentStore;
  backend: AdminBackend;
  /** Sends a command; toasts a friendly error. Resolves true on success. */
  run: (cmd: HostCommand, okText?: string) => Promise<boolean>;
}

const Ctx = createContext<AdminSession | null>(null);

export function useAdmin(): AdminSession {
  const s = useContext(Ctx);
  if (!s) throw new Error('useAdmin outside AdminProvider');
  return s;
}

const CMD_ERRORS: Record<string, string> = {
  stale: 'Кто-то уже нажал раньше — экран обновился',
  invalid: 'Сейчас эта команда не к месту',
  forbidden: 'Нет прав организатора — перезайди',
  offline: 'Нет связи — проверь интернет и нажми ещё раз',
  not_found: 'Игра не найдена',
  not_leader: 'Эту команду выполняет ведущий экран',
  failed: 'Не получилось — попробуй ещё раз',
};

export const cmdErrorText = (r: CmdResult): string => (r.ok ? '' : (CMD_ERRORS[r.error] ?? `Ошибка: ${r.error}`));

/** Builds the session object around a host and a backend (real or rehearsal). */
export function makeSession(user: AdminUser, host: HostLike, backend: AdminBackend): AdminSession {
  const content = new ContentStore(host, (doc) => backend.writeContent(doc));
  const run = async (cmd: HostCommand, okText?: string) => {
    const r = await host.command(cmd);
    if (!r.ok) toast(cmdErrorText(r), { tone: 'bad' });
    else if (okText) toast(okText, { tone: 'good' });
    return r.ok;
  };
  return { user, host, content, backend, run };
}

export function SessionProvider({ session, children }: { session: AdminSession; children: ReactNode }) {
  return <Ctx.Provider value={session}>{children}</Ctx.Provider>;
}

/** A hidden admin tab keeps driving the game on time (host/wake.ts). */
function wakeOpt(): { wake?: (fn: () => void) => () => void } {
  const wake = workerWake();
  return wake ? { wake } : {};
}

/** DEV only (`?env=dev&game=<id>`): the panel drives a separate test game, like the TV page. */
function devGame(): string | null {
  if (currentEnv() !== 'dev') return null;
  try {
    return new URLSearchParams(location.search).get('game');
  } catch {
    return null;
  }
}

/** The real thing: a standby Host on Firestore for the signed-in organizer. */
export function AdminProvider({ user, children, fallback }: { user: User; children: ReactNode; fallback: ReactNode }) {
  const [session, setSession] = useState<AdminSession | null>(null);

  useEffect(() => {
    const fb = getFb();
    let host: Host | null = null;
    let s: AdminSession | null = null;
    // Deferred one task: StrictMode's mount → unmount → mount never starts a Host it then drops.
    const t = setTimeout(() => {
      const game = devGame();
      host = new Host({ db: fb.db, uid: user.uid, label: 'admin', reactions: false, ...wakeOpt(), ...(game ? { followCurrent: false } : {}) });
      s = makeSession(user, host, firebaseBackend(fb));
      s.content.attach();
      void host.start(game ?? undefined);
      setSession(s);
    }, 0);
    const onHide = () => void host?.stop();
    addEventListener('pagehide', onHide);
    return () => {
      clearTimeout(t);
      removeEventListener('pagehide', onHide);
      s?.content.detach();
      void host?.stop();
      setSession(null);
    };
  }, [user]);

  if (!session) return <>{fallback}</>;
  return <SessionProvider session={session}>{children}</SessionProvider>;
}

/** Re-renders on every host change and on a ticker (timers). */
export function useAdminView(tickMs = 500): AdminView {
  const { host } = useAdmin();
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const un = host.subscribe(() => force());
    const id = tickMs > 0 ? setInterval(force, tickMs) : null;
    return () => {
      un();
      if (id) clearInterval(id);
    };
  }, [host, tickMs]);
  return host.adminView();
}

/** A value derived from the host, re-rendering only when it changes (compared as JSON). */
export function useHostValue<T>(pick: (h: HostLike) => T, tickMs = 0): T {
  const { host } = useAdmin();
  const [v, setV] = useState(() => pick(host));
  useEffect(() => {
    let last = JSON.stringify(pick(host));
    const check = () => {
      const next = pick(host);
      const j = JSON.stringify(next);
      if (j !== last) {
        last = j;
        setV(next);
      }
    };
    check();
    const un = host.subscribe(check);
    const id = tickMs > 0 ? setInterval(check, tickMs) : null;
    return () => {
      un();
      if (id) clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, tickMs]);
  return v;
}
