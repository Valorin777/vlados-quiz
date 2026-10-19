// The committed rule files must match the template, and only the DEV file may trust the bot admin.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

describe('firestore rules generation', () => {
  it('firestore.rules and firestore.dev.rules are up to date', () => {
    const out = execFileSync(process.execPath, ['tools/gen-rules.mjs', '--check'], { cwd: root, encoding: 'utf8' });
    expect(out).toContain('rules up to date');
  });

  it('prod rules never grant the DEV bot admin; dev rules gate it on the dev project id', () => {
    const prod = read('firestore.rules');
    const dev = read('firestore.dev.rules');
    expect(prod).not.toMatch(/email == 'bot-admin@vlados\.test'/);
    expect(prod).toContain("email in ['valeratcharygin@gmail.com']");
    expect(dev).toContain("(email == 'bot-admin@vlados.test' && request.auth.token.get('aud', '') == 'vlados-2609-dev')");
    // Listed emails (built-in and config/admins) count only once the address is verified.
    for (const f of [prod, dev]) {
      expect(f).toContain("request.auth.token.get('email_verified', false) == true");
      expect(f).toContain("(verified && (email in ['valeratcharygin@gmail.com'] || email in adminEmails()))");
    }
    for (const f of [prod, dev]) expect(f).not.toMatch(/\{\{\w+\}\}|@DEV_ADMIN@/);
  });

  it('the predeploy hook refuses to put dev rules on prod (and vice versa)', () => {
    const run = (target: string, project: string) => {
      try {
        execFileSync(process.execPath, ['tools/gen-rules.mjs', '--check', '--target', target], {
          cwd: root,
          env: { ...process.env, GCLOUD_PROJECT: project },
          stdio: 'pipe',
        });
        return 0;
      } catch (e) {
        return (e as { status?: number }).status ?? -1;
      }
    };
    expect(run('dev', 'vlados-2609')).toBe(1);
    expect(run('prod', 'vlados-2609-dev')).toBe(1);
    expect(run('dev', 'vlados-2609-dev')).toBe(0);
    expect(run('prod', 'vlados-2609')).toBe(0);
  });
});
