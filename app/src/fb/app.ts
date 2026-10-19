// The page's single Firebase app (browser only; tests build their own instances with fbRefs()).
//
// - Auth persists in localStorage (browserLocalPersistence) with an in-memory fallback for Safari
//   private mode; initializeAuth instead of getAuth keeps the popup/redirect code out of the bundle.
// - Firestore uses the MEMORY cache so reads are predictable (no stale IndexedDB state, no
//   multi-tab leader election). Transport: WebChannel streaming with the SDK's automatic fallback
//   to long polling for proxies that buffer it; a device whose first connect failed reloads with
//   forced long polling (netwatch.ts, remembered for 12 h; `?lp=1` forces it by hand).

import type { FbEnv } from '@shared/fbtypes';
import { initializeApp, type FirebaseApp } from 'firebase/app';
import { browserLocalPersistence, inMemoryPersistence, initializeAuth, type Auth } from 'firebase/auth';
import { initializeFirestore, memoryLocalCache, type Firestore } from 'firebase/firestore';
import { currentEnv, firebaseConfig } from './env';
import { firestoreTransport, pageForcesLongPolling } from './netwatch';
import { fbRefs, type FbRefs } from './refs';

export interface Fb {
  env: FbEnv;
  projectId: string;
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  refs: FbRefs;
}

let instance: Fb | null = null;

export function getFb(): Fb {
  if (instance) return instance;
  const env = currentEnv();
  const config = firebaseConfig(env);
  const app = initializeApp(config);
  const auth = initializeAuth(app, { persistence: [browserLocalPersistence, inMemoryPersistence] });
  auth.languageCode = 'ru';
  const db = initializeFirestore(app, {
    localCache: memoryLocalCache(),
    ...firestoreTransport(pageForcesLongPolling()),
    ignoreUndefinedProperties: true,
  });
  instance = { env, projectId: config.projectId, app, auth, db, refs: fbRefs(db) };
  return instance;
}
