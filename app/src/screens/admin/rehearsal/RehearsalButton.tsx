// «▶ Прогнать игру»: the button that opens the rehearsal (#/admin/rehearsal) — the whole show on
// the real TV and phone screens, with fake guests, on a virtual clock — and the route itself.
// Tiny on purpose: the page is lazy (it pulls the TV and phone screens in).

import { lazy, Suspense } from 'react';
import { useLocation } from 'wouter';
import { audio } from '../../../visual';
import { tvVideo, unlockVideo } from '../../tv/media';
import { LoadingScreen } from '../auth/AuthScreens';
import { Btn } from '../ui/kit';

export const REHEARSAL_PATH = '/rehearsal';

const RehearsalPage = lazy(() => import('./RehearsalPage').then((m) => ({ default: m.RehearsalPage })));

let openedFrom: string | null = null;

/** Where «Закрыть» goes back to (the tab the organizer came from). */
export const rehearsalReturn = (): string => openedFrom ?? '/questions';

/**
 * Inside the click (a user gesture): the sound engine and the TV's one video element get unlocked
 * now, so the rehearsal can later turn the sound on mid-video. Only a fresh element is unlocked —
 * one that already holds a question's video would start playing it off-screen.
 */
function primeSound(): void {
  try {
    audio.unlock();
    const v = tvVideo();
    if (!v.src && !v.isConnected) unlockVideo();
  } catch {
    /* the rehearsal works silently too */
  }
}

export function RehearsalButton({ from, size = 'm', label = 'Прогнать игру' }: { from: string; size?: 's' | 'm'; label?: string }) {
  const [, navigate] = useLocation();
  return (
    <Btn
      tone="accent"
      size={size}
      icon="play"
      title="Вся игра с первого вопроса: экран ТВ и телефон гостя, с ответами и таблицей — понарошку, в базу ничего не уходит"
      onClick={() => {
        openedFrom = from;
        primeSound();
        navigate(REHEARSAL_PATH);
      }}
    >
      {label}
    </Btn>
  );
}

/** #/admin/rehearsal: full screen, instead of the panel's frame. */
export function RehearsalRoute() {
  return (
    <Suspense fallback={<LoadingScreen text="Готовлю прогон…" />}>
      <RehearsalPage />
    </Suspense>
  );
}
