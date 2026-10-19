#!/usr/bin/env node
// Publishes the app to GitHub Pages: https://valorin777.github.io/vlados/
//
//   npm run deploy              build, copy into vlados/, commit, push, wait until Pages serves it
//   npm run deploy -- --no-wait push without waiting for Pages
//   npm run deploy -- --dry-run build and stage in runtime/pages, but do not commit or push
//
// 1. `vite build` → dist/app (app/public/og-image.png and the fonts are copied in by Vite).
// 2. Clone (first run) or fast-forward git@github.com:Valorin777/Valorin777.github.io.git into
//    runtime/pages (gitignored).
// 3. Replace ONLY the vlados/ folder of that repo with dist/app. Refuses to commit if anything
//    outside vlados/ changed — the rest of the site belongs to the owner.
// 4. Commit "Deploy vlados <short sha>" and push over SSH.
// 5. Poll the live URL (cache-busting query) until the new index.html is served (≤ 3 min).

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'git@github.com:Valorin777/Valorin777.github.io.git';
const BRANCH = 'main';
const PAGES = join(ROOT, 'runtime', 'pages');
const SUB = 'vlados';
const DIST = join(ROOT, 'dist', 'app');
const LIVE = 'https://valorin777.github.io/vlados/';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const wait = !args.has('--no-wait') && !dryRun;

const say = (m) => console.log(`deploy: ${m}`);

function sh(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8', cwd: opts.cwd ?? ROOT, env: process.env });
  if (r.status !== 0) {
    const err = opts.capture ? `\n${r.stderr || r.stdout}` : '';
    throw new Error(`${cmd} ${argv.join(' ')} failed (${r.status})${err}`);
  }
  return (r.stdout ?? '').trim();
}
const git = (argv, cwd = PAGES, capture = true) => sh('git', argv, { cwd, capture });

// ---------------------------------------------------------------- 1. build
const sha = git(['rev-parse', '--short', 'HEAD'], ROOT);
const dirty = git(['status', '--porcelain', '--untracked-files=no'], ROOT) !== '';
const version = dirty ? `${sha}+local` : sha;
say(`building ${version}…`);
sh(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'warn']);
const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const entry = /src="\.\/assets\/(index-[\w-]+\.js)"/.exec(html)?.[1];
if (!entry) throw new Error('dist/app/index.html has no ./assets/index-*.js entry — build looks wrong');
if (!existsSync(join(DIST, 'og-image.png'))) throw new Error('dist/app/og-image.png missing — run `npm run og-image` first');
// a tiny stamp so anyone can check what is live: https://valorin777.github.io/vlados/version.txt
writeFileSync(join(DIST, 'version.txt'), `${version}\n${new Date().toISOString()}\n`);

// ---------------------------------------------------------------- 2. clone / update
if (!existsSync(join(PAGES, '.git'))) {
  say(`cloning ${REPO} → runtime/pages`);
  mkdirSync(dirname(PAGES), { recursive: true });
  sh('git', ['clone', '--branch', BRANCH, REPO, PAGES]);
} else {
  const left = git(['status', '--porcelain']).split('\n').filter(Boolean);
  if (left.some((l) => !l.slice(3).replace(/^"/, '').startsWith(`${SUB}/`))) {
    throw new Error('runtime/pages has uncommitted changes outside vlados/ — look at them (git -C runtime/pages status) and clean up first');
  }
  if (left.length) {
    // leftovers of a --dry-run (or an aborted deploy): vlados/ is rebuilt from dist anyway
    git(['reset', '--quiet', '--', SUB]);
    git(['checkout', '--quiet', '--', '.']);
    git(['clean', '-fdq', '--', SUB]);
  }
  say('updating runtime/pages');
  git(['checkout', BRANCH]);
  git(['pull', '--ff-only', 'origin', BRANCH]);
}

// ---------------------------------------------------------------- 3. replace only vlados/
rmSync(join(PAGES, SUB), { recursive: true, force: true });
cpSync(DIST, join(PAGES, SUB), { recursive: true });
git(['add', '--all', '--', SUB]);
const changed = git(['status', '--porcelain']).split('\n').filter(Boolean);
const outside = changed.filter((l) => !l.slice(3).replace(/^"/, '').startsWith(`${SUB}/`));
if (outside.length) {
  throw new Error(`refusing to deploy: changes outside ${SUB}/ in runtime/pages:\n${outside.join('\n')}`);
}
if (changed.length === 0) {
  say('nothing changed in vlados/ — already live');
} else if (dryRun) {
  say(`dry run: ${changed.length} staged changes in runtime/pages/${SUB} (not committed)`);
} else {
  // ---------------------------------------------------------------- 4. commit + push
  const name = git(['config', 'user.name'], ROOT);
  const email = git(['config', 'user.email'], ROOT);
  const msg = `Deploy vlados ${version}\n`;
  git(['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '--quiet', '-m', msg]);
  say(`committed ${changed.length} changes; pushing…`);
  git(['push', '--quiet', 'origin', BRANCH], PAGES, false);
  say(`pushed ${git(['rev-parse', '--short', 'HEAD'])}`);
}

// ---------------------------------------------------------------- 5. wait for Pages
if (wait) {
  say(`waiting for ${LIVE} to serve ${entry} (Pages usually takes 30–90 s)…`);
  const t0 = Date.now();
  let ok = false;
  while (Date.now() - t0 < 180_000) {
    try {
      const r = await fetch(`${LIVE}?cb=${Date.now()}`, { cache: 'no-store', headers: { 'cache-control': 'no-cache' } });
      const body = await r.text();
      if (r.ok && body.includes(entry)) {
        ok = true;
        break;
      }
    } catch {
      // network hiccup: keep polling
    }
    await new Promise((res) => setTimeout(res, 8000));
  }
  const s = Math.round((Date.now() - t0) / 1000);
  if (!ok) {
    say(`not live after ${s} s — GitHub Pages may still be building; check ${LIVE}version.txt in a minute`);
    process.exit(2);
  }
  say(`live after ${s} s: ${LIVE} (${version})`);
}
