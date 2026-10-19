// `#/?fx=<id>`: one fixture state full-screen, exactly as a phone renders it (no Firebase).
// `?fx=` alone lists them. Handy for screenshots in both modes (`?fx=reveal-good&lq=2`).
// `&clock=run`: the clock runs from the state's moment on (the timer drains) — performance runs.
// `?fx=@game[&ms=700][&loops=1]`: an accelerated 15-question game through the same PlayerShell
// (screens remount per round like the live page does); `window.__fxDone` turns true at the end.
// Memory / leak runs measure it.

import { useEffect, useMemo, useState } from 'react';
import type { PlayerView } from '../../../host/views';
import { PlayerShell } from '../Shell';
import { fixtureActions, fixtures, type Fixture } from './fixtures';

function param(k: string): string | null {
  try {
    return new URLSearchParams(location.search).get(k);
  } catch {
    return null;
  }
}

const ROUNDS: readonly (readonly string[])[] = [
  ['intro', 'question', 'answered', 'reveal-good', 'board'],
  ['intro', 'number', 'reveal-close', 'board'],
  ['intro', 'ordering', 'reveal-order', 'board'],
  ['intro', 'photo-portrait', 'answered', 'reveal-photo', 'board'],
  ['watch', 'watch-beat', 'question', 'reveal-video', 'board'],
];

/** lobby → 15 rounds (choice, number, ordering, photo, video …) → the whole final. */
export function gameSequence(rounds = 15): string[] {
  const seq = ['lobby'];
  for (let k = 0; k < rounds; k++) seq.push(...(ROUNDS[k % ROUNDS.length] as readonly string[]));
  seq.push('final-0', 'final-1', 'final-3', 'final-4', 'final-5', 'final-6', 'final-6-after');
  return seq;
}

function GameCycle({ all }: { all: Fixture[] }) {
  const seq = useMemo(() => {
    const loops = Math.max(1, Number(param('loops')) || 1);
    const one = gameSequence();
    return Array.from({ length: loops }, () => one).flat();
  }, []);
  const ms = Math.max(50, Number(param('ms')) || 700);
  const [k, setK] = useState(0);
  useEffect(() => {
    const w = window as unknown as { __fxDone?: boolean; __fxStep?: number };
    w.__fxStep = k;
    if (k >= seq.length - 1) {
      w.__fxDone = true;
      return;
    }
    const id = setTimeout(() => setK(k + 1), ms);
    return () => clearTimeout(id);
  }, [k, ms, seq.length]);
  const f = all.find((x) => x.id === seq[k]) ?? all[0];
  const actions = useMemo(() => (f ? fixtureActions(f.view, true) : null), [f]);
  if (!f || !actions) return null;
  return <PlayerShell view={f.view} actions={actions} />;
}

/** `&tick=250`: a fresh view object every 250 ms like the live page's ticker (re-render cost runs). */
function useTicked(view: PlayerView | undefined): PlayerView | undefined {
  const every = Number(param('tick')) || 0;
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!every) return;
    const id = setInterval(() => setN((k) => k + 1), every);
    return () => clearInterval(id);
  }, [every]);
  return useMemo(() => (view && n ? { ...view, now: view.now + n * every } : view), [view, n, every]);
}

export function FixturePlayer({ id }: { id: string }) {
  const all = useMemo(fixtures, []);
  const f = all.find((x) => x.id === id);
  const run = useMemo(() => param('clock') === 'run', []);
  const actions = useMemo(() => (f ? fixtureActions(f.view, run) : null), [f, run]);
  const view = useTicked(f?.view);
  if (id === '@game') return <GameCycle all={all} />;
  if (!f || !actions) {
    return (
      <nav className="vx pl-fx-index" aria-label="Состояния телефона">
        <h1>Состояния телефона</h1>
        <ol>
          {all.map((x) => (
            <li key={x.id}>
              <a href={`?fx=${x.id}#/`}>{x.label}</a> <code>{x.id}</code>
            </li>
          ))}
          <li>
            <a href="?fx=@game#/">Вся игра подряд (15 вопросов, ускоренно)</a> <code>@game</code>
          </li>
        </ol>
      </nav>
    );
  }
  return <PlayerShell view={view ?? f.view} actions={actions} />;
}
