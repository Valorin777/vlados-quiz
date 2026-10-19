// Light / dark / system for this device. Persists `vlados.appearance` (same key and values as
// app/index.html's pre-paint script) and writes `data-mode` on <html>. Everything visual reads
// `data-mode` (CSS tokens, the liquid engine), so whoever sets it stays in charge.
//
// Switching with an `origin` (the tap point) runs a circular "liquid wipe" via the View
// Transitions API where available; elsewhere colors cross-fade and the chrome env map morphs.

import { useSyncExternalStore } from 'react';
import { reducedMotion } from './motion';

export type AppearancePref = 'system' | 'light' | 'dark';
export type ColorMode = 'light' | 'dark';

export const APPEARANCE_KEY = 'vlados.appearance';
export const APPEARANCE_OPTIONS: readonly { value: AppearancePref; label: string }[] = [
  { value: 'light', label: 'Светлая' },
  { value: 'dark', label: 'Тёмная' },
  { value: 'system', label: 'Авто' },
];

const isPref = (v: unknown): v is AppearancePref => v === 'system' || v === 'light' || v === 'dark';

const darkQuery = (): MediaQueryList | null =>
  typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

function readPref(): AppearancePref {
  try {
    const v = localStorage.getItem(APPEARANCE_KEY);
    return isPref(v) ? v : 'system';
  } catch {
    return 'system';
  }
}

export function resolveMode(pref: AppearancePref): ColorMode {
  if (pref === 'system') return darkQuery()?.matches ? 'dark' : 'light';
  return pref;
}

interface State {
  pref: AppearancePref;
  /** A screen-level override (the TV follows the organizer's setting); wins over `pref`. */
  override: AppearancePref | null;
  mode: ColorMode;
}

let state: State = { pref: 'system', override: null, mode: 'dark' };
let inited = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

function currentDomMode(): ColorMode | null {
  if (typeof document === 'undefined') return null;
  const m = document.documentElement.dataset.mode;
  return m === 'light' || m === 'dark' ? m : null;
}

function init(): void {
  if (inited || typeof document === 'undefined') return;
  inited = true;
  const pref = readPref();
  state = { pref, override: null, mode: currentDomMode() ?? resolveMode(pref) };
  darkQuery()?.addEventListener('change', () => apply());
  addEventListener('storage', (e) => {
    if (e.key !== APPEARANCE_KEY) return;
    state = { ...state, pref: readPref() };
    apply();
  });
  // Someone else (another module, devtools) changed data-mode: follow it.
  new MutationObserver(() => {
    const m = currentDomMode();
    if (m && m !== state.mode) {
      state = { ...state, mode: m };
      emit();
    }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
  apply();
}

export interface Origin {
  x: number;
  y: number;
}

type VTDocument = Document & {
  startViewTransition?: (cb: () => void) => { ready: Promise<void>; finished: Promise<void> };
};

function writeDom(mode: ColorMode): void {
  const root = document.documentElement;
  root.dataset.mode = mode;
  root.style.colorScheme = mode;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = mode === 'dark' ? '#0e1015' : '#eceef2';
}

function apply(origin?: Origin): void {
  const mode = resolveMode(state.override ?? state.pref);
  const changed = mode !== currentDomMode();
  if (mode !== state.mode) state = { ...state, mode };
  emit();
  if (!changed) return;
  const root = document.documentElement;
  const doc = document as VTDocument;
  if (origin && doc.startViewTransition && !reducedMotion()) {
    root.classList.add('vx-vt');
    try {
      const vt = doc.startViewTransition(() => writeDom(mode));
      vt.ready
        .then(() => {
          const r = Math.hypot(Math.max(origin.x, innerWidth - origin.x), Math.max(origin.y, innerHeight - origin.y));
          root.animate(
            {
              clipPath: [`circle(0px at ${origin.x}px ${origin.y}px)`, `circle(${r}px at ${origin.x}px ${origin.y}px)`],
            },
            { duration: 820, easing: 'cubic-bezier(.62,0,.28,1)', pseudoElement: '::view-transition-new(root)' },
          );
        })
        .catch(() => undefined);
      vt.finished.finally(() => root.classList.remove('vx-vt')).catch(() => undefined);
      return;
    } catch {
      root.classList.remove('vx-vt');
    }
  }
  root.classList.add('vx-mode-anim');
  writeDom(mode);
  setTimeout(() => root.classList.remove('vx-mode-anim'), 720);
}

/** Persist this device's choice and apply it (optionally wiping from the tap point). */
export function setAppearance(pref: AppearancePref, origin?: Origin): void {
  init();
  try {
    localStorage.setItem(APPEARANCE_KEY, pref);
  } catch {
    /* private mode: still apply for this session */
  }
  state = { ...state, pref };
  apply(origin);
}

/** Screen-level override (e.g. TV set to dark by the organizer). `null` returns to the device choice. */
export function setAppearanceOverride(override: AppearancePref | null): void {
  init();
  if (state.override === override) return;
  state = { ...state, override };
  apply();
}

export function getAppearance(): Readonly<State> {
  init();
  return state;
}

function subscribe(fn: () => void): () => void {
  init();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** `{ pref, mode }` for components; re-renders on changes from any source. */
export function useAppearance(): Readonly<State> {
  return useSyncExternalStore(subscribe, getAppearance, getAppearance);
}
