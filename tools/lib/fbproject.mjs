// Firebase project facts shared by the Node tools (single source: shared/fbconfig.json).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @type {{ projects: Record<'prod'|'dev', { apiKey: string, authDomain: string, projectId: string, appId: string, messagingSenderId: string }>, limits: Record<string, number> }} */
export const FBCONFIG = JSON.parse(readFileSync(join(ROOT, 'shared', 'fbconfig.json'), 'utf8'));

export const PROD_PROJECT = FBCONFIG.projects.prod.projectId;
export const DEV_PROJECT = FBCONFIG.projects.dev.projectId;

/** DEV-only admin used by automated tests. Never an admin in prod (not in firestore.rules). */
export const DEV_BOT_ADMIN_EMAIL = 'bot-admin@vlados.test';

/** Where tools/dev-bot-admin.mjs keeps the bot's random password (runtime/ is gitignored). */
export const DEV_BOT_ADMIN_FILE = join(ROOT, 'runtime', 'dev-bot-admin.json');

/** DEV-only email account that is NOT an admin (tests: config/admins, role detection). */
export const DEV_BOT_USER_EMAIL = 'bot-user@vlados.test';
export const DEV_BOT_USER_FILE = join(ROOT, 'runtime', 'dev-bot-user.json');

/** Rule files per environment; firebase.json deploys prod, firebase.dev.json deploys dev. */
export const RULES = {
  template: join(ROOT, 'firestore.rules.tmpl'),
  prod: { file: join(ROOT, 'firestore.rules'), config: join(ROOT, 'firebase.json'), project: PROD_PROJECT },
  dev: { file: join(ROOT, 'firestore.dev.rules'), config: join(ROOT, 'firebase.dev.json'), project: DEV_PROJECT },
};
