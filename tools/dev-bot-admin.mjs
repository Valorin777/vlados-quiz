#!/usr/bin/env node
// DEV-ONLY test fixture: makes sure the admin test user bot-admin@vlados.test exists in the DEV
// project (vlados-2609-dev) and that its password is in runtime/dev-bot-admin.json (gitignored).
// firestore.dev.rules treat that email as an admin; firestore.rules (prod) do not.
// ensureDevBotUser() does the same for bot-user@vlados.test, an email account that is NOT an admin
// (tests use it for the config/admins path and role detection).
//
//   node tools/dev-bot-admin.mjs     create or sign in; prints the uid, never the password
//
// Uses the Firebase JS SDK against DEV. If the user already exists but the password file was lost,
// the password is reset through the Identity Toolkit admin API with the firebase-tools login
// (DEV project only).

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deleteApp, initializeApp } from 'firebase/app';
import { createUserWithEmailAndPassword, getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { DEV_BOT_ADMIN_EMAIL, DEV_BOT_ADMIN_FILE, DEV_BOT_USER_EMAIL, DEV_BOT_USER_FILE, DEV_PROJECT, FBCONFIG, ROOT } from './lib/fbproject.mjs';

const DEV = FBCONFIG.projects.dev;
if (DEV.projectId !== DEV_PROJECT || DEV_PROJECT.endsWith('-dev') === false) {
  throw new Error('dev-bot-admin: refusing to run against a non-dev project');
}

/** @returns {{ email: string, password: string, uid?: string } | null} */
function loadCreds(email, file) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    if (v && v.projectId === DEV_PROJECT && v.email === email && typeof v.password === 'string') return v;
  } catch {
    // missing or unreadable → create
  }
  return null;
}

function saveCreds(email, file, password, uid) {
  mkdirSync(dirname(file), { recursive: true });
  const body = { projectId: DEV_PROJECT, email, password, uid, updatedAt: new Date().toISOString() };
  writeFileSync(file, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
}

const newPassword = () => randomBytes(24).toString('base64url');

/**
 * Updates an existing DEV user with the firebase-tools OAuth login (project owner) through the
 * Identity Toolkit admin API. DEV project only.
 */
async function updateDevUserWithCli(email, patch) {
  const require = createRequire(import.meta.url);
  const lib = (p) => require(join(ROOT, 'node_modules', 'firebase-tools', 'lib', p));
  const account = lib('auth').getGlobalDefaultAccount();
  if (!account) throw new Error('firebase-tools is not logged in');
  await lib('requireAuth').requireAuth({ user: account.user, tokens: account.tokens });
  const { Client } = lib('apiv2');
  const it = new Client({ urlPrefix: 'https://identitytoolkit.googleapis.com', apiVersion: 'v1' });
  const found = await it.post(`/projects/${DEV_PROJECT}/accounts:lookup`, { email: [email] });
  const localId = found.body?.users?.[0]?.localId;
  if (!localId) throw new Error(`${email} not found in ${DEV_PROJECT}`);
  await it.post(`/projects/${DEV_PROJECT}/accounts:update`, { localId, ...patch });
}

/** Sets the password of an existing DEV user. */
const resetPasswordWithCli = (email, password) => updateDevUserWithCli(email, { password });

const DEV_TEST_EMAILS = [DEV_BOT_ADMIN_EMAIL, DEV_BOT_USER_EMAIL];

/**
 * Marks a DEV test account's email as verified (or not). The rules only trust VERIFIED emails for
 * the admin list, so tests flip bot-user@vlados.test to check both sides. Callers must refresh
 * the ID token (getIdToken(true)) afterwards.
 * @param {string} email one of the DEV bot accounts
 * @param {boolean} verified
 */
export async function setDevEmailVerified(email, verified) {
  if (!DEV_TEST_EMAILS.includes(email)) throw new Error(`setDevEmailVerified: ${email} is not a DEV bot account`);
  await updateDevUserWithCli(email, { emailVerified: verified === true });
}

const BAD_CREDENTIALS = ['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found', 'auth/invalid-login-credentials'];

/** Creates (or signs in) a DEV email/password account whose random password lives in `file`. */
async function ensureDevAccount(email, file) {
  const app = initializeApp(DEV, `dev-account-${randomBytes(4).toString('hex')}`);
  const auth = getAuth(app);
  try {
    const saved = loadCreds(email, file);
    if (saved) {
      try {
        const { user } = await signInWithEmailAndPassword(auth, email, saved.password);
        if (saved.uid !== user.uid) saveCreds(email, file, saved.password, user.uid);
        return { email, password: saved.password, uid: user.uid };
      } catch (e) {
        if (!BAD_CREDENTIALS.includes(/** @type {{ code?: string }} */ (e).code ?? '')) throw e;
      }
    }
    const password = newPassword();
    try {
      const { user } = await createUserWithEmailAndPassword(auth, email, password);
      saveCreds(email, file, password, user.uid);
      return { email, password, uid: user.uid };
    } catch (e) {
      if (/** @type {{ code?: string }} */ (e).code !== 'auth/email-already-in-use') throw e;
    }
    await resetPasswordWithCli(email, password);
    const { user } = await signInWithEmailAndPassword(auth, email, password);
    saveCreds(email, file, password, user.uid);
    return { email, password, uid: user.uid };
  } finally {
    await deleteApp(app);
  }
}

/**
 * Ensures the DEV bot admin exists and returns its credentials (for tests; do not log them).
 * @returns {Promise<{ email: string, password: string, uid: string }>}
 */
export const ensureDevBotAdmin = () => ensureDevAccount(DEV_BOT_ADMIN_EMAIL, DEV_BOT_ADMIN_FILE);

/**
 * Ensures the DEV non-admin email account exists (for tests; do not log the password).
 * @returns {Promise<{ email: string, password: string, uid: string }>}
 */
export const ensureDevBotUser = () => ensureDevAccount(DEV_BOT_USER_EMAIL, DEV_BOT_USER_FILE);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.all([ensureDevBotAdmin(), ensureDevBotUser()]).then(
    ([adminUser, plainUser]) => {
      console.log(`DEV bot admin ready: ${adminUser.email} (uid ${adminUser.uid}) in ${DEV_PROJECT}; password in runtime/dev-bot-admin.json`);
      console.log(`DEV non-admin user ready: ${plainUser.email} (uid ${plainUser.uid}); password in runtime/dev-bot-user.json`);
      process.exit(0);
    },
    (e) => {
      console.error('dev-bot-admin failed:', e?.code ?? '', e?.message ?? e);
      process.exit(1);
    },
  );
}
