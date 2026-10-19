// Web Storage that never throws: Safari private mode, blocked site data and quota errors all
// degrade to "nothing stored" instead of breaking the game.

type Area = 'local' | 'session';

function area(which: Area): Storage | null {
  try {
    return which === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readJson<T>(which: Area, key: string, guard: (v: unknown) => v is T): T | null {
  try {
    const raw = area(which)?.getItem(key);
    if (raw == null) return null;
    const v: unknown = JSON.parse(raw);
    return guard(v) ? v : null;
  } catch {
    return null;
  }
}

export function writeJson(which: Area, key: string, value: unknown): void {
  try {
    area(which)?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable or full: the value just won't survive a reload.
  }
}

export function readString(which: Area, key: string): string | null {
  try {
    return area(which)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeString(which: Area, key: string, value: string): void {
  try {
    area(which)?.setItem(key, value);
  } catch {
    // See writeJson.
  }
}

export function remove(which: Area, key: string): void {
  try {
    area(which)?.removeItem(key);
  } catch {
    // See writeJson.
  }
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const isStringRecord = (v: unknown): v is Record<string, string> =>
  isRecord(v) && Object.values(v).every((x) => typeof x === 'string');

/** Storage keys in one place so nothing collides. */
export const KEYS = {
  /** sessionStorage: 'prod' | 'dev' (see env.ts). */
  env: 'vlados.env',
  /** Legacy (Socket.IO era), still read by app/src/net until the screens move to app/src/fb. */
  identities: 'vlados.identity',
  localKey: 'vlados.key',
  adminSession: 'vlados.adminSession',
  /** localStorage: when this device last needed forced long polling (netwatch.ts). */
  longPolling: 'vlados.fb.longPolling',
  /** sessionStorage: times of the watchdog's automatic reloads in this tab (netwatch.ts). */
  netReloads: 'vlados.fb.netReloads',
  /** sessionStorage: the phone's join form until the join is confirmed (screens/player/joinDraft.ts). */
  joinDraft: 'vlados.join.draft',
  /** localStorage: name + selfie of the last confirmed join on this device (joinDraft.ts). */
  playerProfile: 'vlados.player.profile',
  /** localStorage, legacy: the last joined name (before playerProfile). */
  playerName: 'vlados.player.name',
} as const;
