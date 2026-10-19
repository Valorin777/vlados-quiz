// Sign-in flows (docs/firebase.md → Auth & roles).
// Players/viewers: anonymous (uid = player id). Admins: email + password; whether an account is an
// admin is decided by the security rules alone, so the role is detected by asking Firestore for
// admin/content — the UI never hardcodes an admin email.

import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut,
  type Auth,
  type Unsubscribe,
  type User,
} from 'firebase/auth';
import { getDocFromServer } from 'firebase/firestore';
import type { FbRefs } from './refs';

export type FbRole = 'none' | 'anon' | 'admin' | 'user';

export type AuthErr =
  | 'invalid_email'
  | 'wrong_credentials'
  | 'email_in_use'
  | 'weak_password'
  | 'too_many_requests'
  | 'network'
  | 'disabled'
  | 'unknown';

/** Firebase error → short code the UI translates. */
export function authErrorCode(e: unknown): AuthErr {
  const code = typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : '';
  switch (code) {
    case 'auth/invalid-email':
    case 'auth/missing-email':
      return 'invalid_email';
    case 'auth/invalid-credential':
    case 'auth/invalid-login-credentials':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
    case 'auth/missing-password':
      return 'wrong_credentials';
    case 'auth/email-already-in-use':
      return 'email_in_use';
    case 'auth/weak-password':
    case 'auth/password-does-not-meet-requirements':
      return 'weak_password';
    case 'auth/too-many-requests':
    case 'auth/quota-exceeded':
      return 'too_many_requests';
    case 'auth/network-request-failed':
    case 'auth/timeout':
    case 'unavailable':
      return 'network';
    case 'auth/user-disabled':
    case 'auth/operation-not-allowed':
    case 'auth/admin-restricted-operation':
      return 'disabled';
    default:
      return 'unknown';
  }
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** Resolves once the persisted session (if any) has been restored. */
export async function currentUser(auth: Auth): Promise<User | null> {
  await auth.authStateReady();
  return auth.currentUser;
}

export const watchUser = (auth: Auth, cb: (u: User | null) => void): Unsubscribe => onAuthStateChanged(auth, cb);

/** Player/viewer identity: reuses whatever session this browser has, else signs in anonymously. */
export async function ensureSignedIn(auth: Auth): Promise<User> {
  const u = await currentUser(auth);
  if (u) return u;
  return (await signInAnonymously(auth)).user;
}

export async function signInAdmin(auth: Auth, email: string, password: string): Promise<User> {
  return (await signInWithEmailAndPassword(auth, normalizeEmail(email), password)).user;
}

/** First run «Создать вход организатора»: the organizer types his own email + password. */
export async function createOrganizer(auth: Auth, email: string, password: string): Promise<User> {
  return (await createUserWithEmailAndPassword(auth, normalizeEmail(email), password)).user;
}

export async function resetPassword(auth: Auth, email: string): Promise<void> {
  await sendPasswordResetEmail(auth, normalizeEmail(email));
}

export async function signOutUser(auth: Auth): Promise<void> {
  await signOut(auth);
}

const isPermissionDenied = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && 'code' in e && (e as { code: unknown }).code === 'permission-denied';

/**
 * 'admin' when the rules let this user read admin/content (1 read), 'user' for an email account
 * that is not an admin, 'anon' for anonymous players. Network errors are thrown, not guessed.
 */
export async function detectRole(refs: FbRefs, user: User | null): Promise<FbRole> {
  if (!user) return 'none';
  if (user.isAnonymous) return 'anon';
  try {
    await getDocFromServer(refs.adminContent());
    return 'admin';
  } catch (e) {
    if (isPermissionDenied(e)) return 'user';
    throw e;
  }
}
