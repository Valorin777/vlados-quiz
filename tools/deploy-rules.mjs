#!/usr/bin/env node
// Deploys Firestore rules + indexes to ONE environment, pairing the right rules file with the
// right project (the dev rules trust a test admin and must never reach prod).
//
//   node tools/deploy-rules.mjs dev     → firebase.dev.json → vlados-2609-dev
//   node tools/deploy-rules.mjs prod    → firebase.json     → vlados-2609
//
// Regenerates the rule files first. The predeploy hook in each firebase*.json re-checks the pairing.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, RULES } from './lib/fbproject.mjs';

const env = process.argv[2];
if (env !== 'dev' && env !== 'prod') {
  console.error('usage: node tools/deploy-rules.mjs dev|prod');
  process.exit(2);
}
const { config, project } = RULES[env];

execFileSync(process.execPath, [join(ROOT, 'tools', 'gen-rules.mjs')], { cwd: ROOT, stdio: 'inherit' });
execFileSync(
  join(ROOT, 'node_modules', '.bin', 'firebase'),
  ['deploy', '--only', 'firestore:rules,firestore:indexes', '--project', project, '--config', config, '--non-interactive'],
  { cwd: ROOT, stdio: 'inherit' },
);
console.log(`\nDeployed ${env} rules + indexes to ${project}.`);
