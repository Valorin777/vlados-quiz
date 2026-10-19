// Which Firebase project this page talks to (docs/firebase.md → Projects).
// Prod by default; `?env=dev` switches to dev for this tab (remembered in sessionStorage, so hash
// navigation and reloads stay on dev); `?env=prod` switches back.

import { FB_PROJECTS, type FbEnv, type FbProjectConfig } from '@shared/fbtypes';
import { KEYS, readString, writeString } from './storage';

export const ENV_PARAM = 'env';

const isEnv = (v: unknown): v is FbEnv => v === 'prod' || v === 'dev';

/** Pure resolution: an explicit `?env=` wins and should be remembered; else the remembered one; else prod. */
export function pickEnv(search: string, remembered: string | null): { env: FbEnv; remember: FbEnv | null } {
  let param: string | null = null;
  try {
    param = new URLSearchParams(search).get(ENV_PARAM);
  } catch {
    param = null;
  }
  if (isEnv(param)) return { env: param, remember: param };
  return { env: isEnv(remembered) ? remembered : 'prod', remember: null };
}

let resolved: FbEnv | null = null;

/** The environment of this page load (resolved once). */
export function currentEnv(): FbEnv {
  if (resolved) return resolved;
  const search = typeof location === 'undefined' ? '' : location.search;
  const { env, remember } = pickEnv(search, readString('session', KEYS.env));
  if (remember) writeString('session', KEYS.env, remember);
  resolved = env;
  return env;
}

export const firebaseConfig = (env: FbEnv): FbProjectConfig => FB_PROJECTS[env];
