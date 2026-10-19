// #/admin — the organizer's panel («Пульт»): sign-in → onboarding → Эфир / Вопросы / Игроки /
// Итоги / Настройки. Runs a standby Host (it takes the game over if the TV's lease expires).
// DEV only: `?env=dev&demo=1` opens the rehearsal (the same panel on an in-memory game).

import { lazy, Suspense } from 'react';
import { currentEnv } from '../../fb/env';
import { LiquidStage, ToastHost } from '../../visual';
import './admin.css';
import { LoadingScreen, LoginScreen, NotAdminScreen, VerifyScreen } from './auth/AuthScreens';
import { useAdminAuth } from './core/auth';
import { AdminProvider } from './core/session';
import { Shell } from './shell/Shell';

const Rehearsal = lazy(() => import('./demo/Rehearsal').then((m) => ({ default: m.Rehearsal })));

function isRehearsal(): boolean {
  try {
    return currentEnv() === 'dev' && new URLSearchParams(location.search).has('demo');
  } catch {
    return false;
  }
}

function RealAdmin() {
  const { auth, recheck } = useAdminAuth();
  switch (auth.s) {
    case 'loading':
      return <LoadingScreen />;
    case 'signedOut':
      return <LoginScreen />;
    case 'unverified':
      return <VerifyScreen user={auth.user} recheck={recheck} />;
    case 'notAdmin':
      return <NotAdminScreen user={auth.user} recheck={recheck} />;
    case 'offline':
      return <NotAdminScreen user={auth.user} offline recheck={recheck} />;
    case 'admin':
      return (
        <AdminProvider user={auth.user} fallback={<LoadingScreen text="Подключаюсь к игре…" />}>
          <Shell />
        </AdminProvider>
      );
  }
}

export function AdminApp() {
  return (
    <div className="vx ad">
      <LiquidStage profile="phone">
        {isRehearsal() ? (
          <Suspense fallback={<LoadingScreen text="Готовлю репетицию…" />}>
            <Rehearsal />
          </Suspense>
        ) : (
          <RealAdmin />
        )}
      </LiquidStage>
      <ToastHost />
    </div>
  );
}
