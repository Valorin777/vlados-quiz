import { lazy, Suspense, useState } from 'react';
import { ModeToggle } from '../../visual';
import { Lab } from './Lab';

// Every phone state from fixtures (driven through the real pure host): screens/player/preview.
const PlayerPreview = lazy(() => import('../player/preview/PlayerPreview').then((m) => ({ default: m.PlayerPreview })));

const TAB_KEY = 'vlados.lab.tab';

type Tab = 'system' | 'screens';

function readTab(): Tab {
  try {
    return sessionStorage.getItem(TAB_KEY) === 'screens' ? 'screens' : 'system';
  } catch {
    return 'system';
  }
}

/**
 * `#/lab`: the liquid-chrome design system (default tab) and every player state rendered from
 * fixtures (second tab) — no server needed for either.
 */
export function LabApp() {
  const [tab, setTab] = useState<Tab>(readTab);
  const pick = (t: Tab) => {
    try {
      sessionStorage.setItem(TAB_KEY, t);
    } catch {
      /* ignore */
    }
    setTab(t);
  };
  return (
    <>
      {/* floating dock: section switch + theme, reachable by thumb on any screen */}
      <nav className="lab-tabs vx" aria-label="Лаборатория">
        <div className="lab-tabs-seg">
          <button type="button" aria-pressed={tab === 'system'} onClick={() => pick('system')}>
            Система
          </button>
          <button type="button" aria-pressed={tab === 'screens'} onClick={() => pick('screens')}>
            Экраны
          </button>
        </div>
        <ModeToggle className="lab-tabs-mode" labels={false} />
      </nav>
      {tab === 'system' ? <Lab /> : <PlayerFixtures />}
    </>
  );
}

/** Every phone state from fixtures, in a phone frame (links open each one full-screen). */
function PlayerFixtures() {
  return (
    <Suspense fallback={null}>
      <PlayerPreview />
    </Suspense>
  );
}
