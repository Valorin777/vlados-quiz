#!/usr/bin/env node
// DEV ONLY: seeds the DEV project (vlados-2609-dev) with the template game.
//   admin/content            ← shared/defaults.ts seedContent() (6 template questions) — OVERWRITTEN
//   config/current           ← { gameId: 'main' }
//   games/main               ← lobby (players, answers, reactions and private docs are deleted)
//   games/main/private/totals← empty
//
//   npm run seed:dev            (= tsx tools/seed-dev.mjs; tsx is needed for the TS imports)
//
// Signs in as the DEV bot admin with the Firebase JS SDK, so every write goes through the same
// security rules the app uses (a doc the rules would refuse fails here too).

import { deleteApp, initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { collection, deleteDoc, doc, getDocs, initializeFirestore, memoryLocalCache, setDoc, terminate, writeBatch } from 'firebase/firestore';
import { ensureDevBotAdmin } from './dev-bot-admin.mjs';
import { DEV_PROJECT, FBCONFIG } from './lib/fbproject.mjs';
import { seedDocs } from './lib/seed.mjs';

const DEV = FBCONFIG.projects.dev;
if (DEV.projectId !== DEV_PROJECT || !DEV_PROJECT.endsWith('-dev')) throw new Error('seed-dev: refusing to run against a non-dev project');

async function main() {
  const docs = seedDocs();
  const g = docs.gameId;
  const bot = await ensureDevBotAdmin();
  const app = initializeApp(DEV, `seed-dev-${Date.now()}`);
  try {
    await signInWithEmailAndPassword(getAuth(app), bot.email, bot.password);
    const db = initializeFirestore(app, { localCache: memoryLocalCache() });
    let removed = 0;
    for (const sub of ['players', 'answers', 'reactions', 'private']) {
      const snap = await getDocs(collection(db, `games/${g}/${sub}`));
      for (let k = 0; k < snap.docs.length; k += 400) {
        const batch = writeBatch(db);
        for (const d of snap.docs.slice(k, k + 400)) batch.delete(d.ref);
        await batch.commit();
      }
      removed += snap.size;
    }
    await setDoc(doc(db, 'admin/content'), docs.content);
    await setDoc(doc(db, 'config/current'), docs.current);
    await setDoc(doc(db, `games/${g}`), docs.game);
    await setDoc(doc(db, `games/${g}/private/totals`), docs.totals);
    await deleteDoc(doc(db, `config/clock_${bot.uid}`)).catch(() => undefined);
    const qs = /** @type {{ type: string, double: boolean }[]} */ (docs.content.questions);
    console.log(`DEV ${DEV_PROJECT}: admin/content = ${qs.length} template questions (${qs.map((q) => q.type + (q.double ? '×2' : '')).join(', ')})`);
    console.log(`DEV ${DEV_PROJECT}: games/${g} in lobby, config/current → ${g}; removed ${removed} old docs under games/${g}`);
    await terminate(db);
  } finally {
    await deleteApp(app);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('seed-dev failed:', e?.code ?? '', e?.message ?? e);
    process.exit(1);
  },
);
