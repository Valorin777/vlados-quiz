// The Lab «Экраны» tab: every phone state from fixtures in a 390 × 844 frame (one liquid canvas),
// with a link to open it full-screen (`?fx=<id>`), which is what screenshot runs use.

import { useMemo, useState, type CSSProperties } from 'react';
import { PlayerShell } from '../Shell';
import { fixtureActions, fixtures } from './fixtures';
import './preview.css';

const KEY = 'vlados.lab.fx';

function readSaved(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function PlayerPreview() {
  const all = useMemo(fixtures, []);
  const [id, setId] = useState(() => readSaved() ?? all[0]?.id ?? '');
  const f = all.find((x) => x.id === id) ?? all[0];
  const actions = useMemo(() => (f ? fixtureActions(f.view) : null), [f]);
  const pick = (next: string) => {
    try {
      sessionStorage.setItem(KEY, next);
    } catch {
      /* ignore */
    }
    setId(next);
  };
  const scale = Math.min(1, (innerHeight - 120) / 844);
  return (
    <div className="plp vx">
      <nav className="plp-list" aria-label="Состояния телефона">
        {all.map((x) => (
          <button key={x.id} type="button" aria-pressed={x.id === f?.id} onClick={() => pick(x.id)}>
            {x.label}
          </button>
        ))}
      </nav>
      {f && actions ? (
        <figure className="plp-dev">
          <div className="plp-box" style={{ width: 390 * scale, height: 844 * scale } as CSSProperties}>
            <div className="plp-screen" style={{ transform: `scale(${scale})` }}>
              <PlayerShell key={f.id} view={f.view} actions={actions} contained />
            </div>
          </div>
          <figcaption>
            <code>{f.id}</code> · <a href={`?fx=${f.id}#/`}>на весь экран</a>
          </figcaption>
        </figure>
      ) : null}
    </div>
  );
}
