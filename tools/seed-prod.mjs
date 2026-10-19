#!/usr/bin/env node
// PROD first-run seed (vlados-2609): creates the template game ONLY IF admin/content does not
// exist yet. It never overwrites anything: every write is a create with an exists=false
// precondition in one atomic commit, and nothing at all is written when admin/content exists.
//   admin/content, and whichever of config/current, games/main, games/main/private/totals are missing.
//
//   npm run seed:prod -- --yes     (= tsx tools/seed-prod.mjs --yes)
//
// Uses the firebase CLI login (project owner) over the Firestore REST API, so no admin password
// is needed; security rules do not apply to owner credentials, which is why the preconditions do
// the guarding here.

import { PROD_PROJECT } from './lib/fbproject.mjs';
import { seedCreateOnly } from './lib/seed.mjs';

if (!process.argv.includes('--yes')) {
  console.error(`seed-prod writes to PROD (${PROD_PROJECT}) if admin/content is missing. Re-run with --yes to do it.`);
  process.exit(2);
}

seedCreateOnly(PROD_PROJECT).then(
  (r) => {
    if (r.skipped) console.log(`PROD ${PROD_PROJECT}: ${r.skipped}`);
    else console.log(`PROD ${PROD_PROJECT}: created ${r.created.join(', ')}`);
    process.exit(0);
  },
  (e) => {
    console.error('seed-prod failed (nothing was written if a precondition failed):', e?.message ?? e);
    process.exit(1);
  },
);
