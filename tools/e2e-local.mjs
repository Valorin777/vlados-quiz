#!/usr/bin/env node
// The live E2E (tools/e2e-live.ts, DEV project only) against a LOCAL production build:
//   vite build → vite preview on http://localhost:4173/ → e2e-live with E2E_BASE → preview stopped.
//
//   npm run e2e:local                      (E2E_SHOTS=… passes through; E2E_SKIP_BUILD=1 reuses dist/app)
//   npm run e2e:local -- --manual          the «Автопилот» off: Space for every step (E2E_MANUAL=1 too)
//   E2E_PORT=4180 npm run e2e:local
//
// Exit code = the E2E's (0 = ALL OK). Nothing is deployed; localhost is an authorized Firebase domain.

import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.E2E_PORT ?? '4173';
const BASE = `http://localhost:${PORT}/`;
const bin = (n) => join(ROOT, 'node_modules', '.bin', n);

if (!process.env.E2E_SKIP_BUILD) {
  const b = spawnSync(bin('vite'), ['build'], { cwd: ROOT, stdio: 'inherit' });
  if (b.status !== 0) process.exit(b.status ?? 1);
}

const preview = spawn(bin('vite'), ['preview', '--port', PORT, '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
const stop = () => {
  if (preview.exitCode === null) preview.kill();
};
process.on('SIGINT', () => {
  stop();
  process.exit(130);
});
preview.on('exit', (code) => {
  if (code && code !== 0) console.error(`vite preview exited with ${code}`);
});

let up = false;
for (let i = 0; i < 100 && !up && preview.exitCode === null; i++) {
  up = await fetch(BASE).then(
    (r) => r.ok,
    () => false,
  );
  if (!up) await new Promise((r) => setTimeout(r, 200));
}
if (!up) {
  console.error(`vite preview did not answer on ${BASE}`);
  stop();
  process.exit(1);
}
console.log(`serving dist/app on ${BASE}`);

const run = spawn(bin('tsx'), ['tools/e2e-live.ts', ...process.argv.slice(2)], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, E2E_BASE: BASE } });
run.on('exit', (code) => {
  stop();
  process.exit(code ?? 1);
});
