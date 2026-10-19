// Organizer sign-in state (docs/firebase.md → Auth & roles). Whether an account is an admin is
// decided by the security rules alone (detectRole reads admin/content); the rules also require a
// VERIFIED email, so a fresh account first goes through «Проверь почту».

import { sendEmailVerification, type User } from 'firebase/auth';
import { useCallback, useEffect, useRef, useState } from 'react';
import { detectRole, watchUser } from '../../../fb/auth';
import { getFb } from '../../../fb/app';

export type AdminAuth =
  | { s: 'loading' }
  | { s: 'signedOut' }
  | { s: 'unverified'; user: User }
  | { s: 'notAdmin'; user: User }
  | { s: 'offline'; user: User }
  | { s: 'admin'; user: User };

/** Where the verification link sends the organizer back (must be an authorized domain). */
function continueUrl(): string {
  const u = new URL(location.href);
  u.hash = '#/admin';
  return u.toString();
}

export async function sendVerification(user: User): Promise<void> {
  try {
    await sendEmailVerification(user, { url: continueUrl() });
  } catch (e) {
    const code = typeof e === 'object' && e && 'code' in e ? String((e as { code: unknown }).code) : '';
    // A continue URL on an unlisted domain is refused: send the plain link instead.
    if (code === 'auth/unauthorized-continue-uri' || code === 'auth/invalid-continue-uri') await sendEmailVerification(user);
    else throw e;
  }
}

export function useAdminAuth(): { auth: AdminAuth; recheck: () => Promise<boolean> } {
  const fb = getFb();
  const [auth, setAuth] = useState<AdminAuth>({ s: 'loading' });
  const seq = useRef(0);

  const resolve = useCallback(
    async (user: User | null, forceToken = false): Promise<AdminAuth> => {
      const my = ++seq.current;
      let next: AdminAuth;
      if (!user || user.isAnonymous) next = { s: 'signedOut' };
      else {
        try {
          if (forceToken) await user.getIdToken(true);
          const role = await detectRole(fb.refs, user);
          if (role === 'admin') next = { s: 'admin', user };
          else next = user.emailVerified ? { s: 'notAdmin', user } : { s: 'unverified', user };
        } catch {
          next = { s: 'offline', user };
        }
      }
      if (my === seq.current) setAuth(next);
      return next;
    },
    [fb],
  );

  useEffect(() => watchUser(fb.auth, (u) => void resolve(u)), [fb, resolve]);

  /** After «Я подтвердил» / reconnect: reload the user, refresh the token, ask the rules again. */
  const recheck = useCallback(async (): Promise<boolean> => {
    const u = fb.auth.currentUser;
    if (!u) return false;
    try {
      await u.reload();
    } catch {
      // offline: resolve() reports it
    }
    const r = await resolve(fb.auth.currentUser, true);
    return r.s === 'admin';
  }, [fb, resolve]);

  return { auth, recheck };
}
