// First run: admin/content does not exist yet. The same documents as tools/lib/seed.mjs
// (seedContent() without `media`, config/current), written from the browser in one transaction
// that never overwrites existing content. The Host creates games/{g} (lobby) by itself.

import { seedContent } from '@shared/defaults';
import { DEFAULT_GAME_ID, type AdminContentDoc } from '@shared/fbtypes';
import { runTransaction } from 'firebase/firestore';
import type { Fb } from '../../../fb/app';
import { stripUndefined } from '../../../host/pure';

export function seedDoc(withTemplates: boolean, now = Date.now()): AdminContentDoc {
  const { rev, settings, questions, trash } = seedContent();
  return stripUndefined({ rev, settings, questions: withTemplates ? questions : [], trash, updatedAt: now });
}

/** Resolves 'created', or 'exists' when someone else created the content meanwhile. */
export async function seedContentDoc(fb: Fb, withTemplates: boolean): Promise<'created' | 'exists'> {
  const contentRef = fb.refs.adminContent();
  const currentRef = fb.refs.configCurrent();
  return runTransaction(fb.db, async (tx) => {
    const [c, cur] = await Promise.all([tx.get(contentRef), tx.get(currentRef)]);
    if (c.exists()) return 'exists' as const;
    tx.set(contentRef, seedDoc(withTemplates));
    if (!cur.exists()) tx.set(currentRef, { gameId: DEFAULT_GAME_ID });
    return 'created' as const;
  });
}
