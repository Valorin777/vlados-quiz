// Faces of the rehearsal's fake guests: most «took a selfie» (the TV demo's cartoon selfies), the
// rest skipped it and got the generated chrome avatar, exactly like guests who tap «без селфи».
// Made once per page (canvas → JPEG bytes) and cached.

import type { RehearsalGuest } from '../../../host/rehearsal';
import { generateChromeAvatar } from '../../../visual';
import { fakeSelfie } from '../../tv/dev/faces';

export type Faces = Record<string, { avatar: Uint8Array; thumb: Uint8Array }>;

const cache = new Map<string, Promise<{ avatar: Uint8Array; thumb: Uint8Array } | null>>();

const bytes = async (b: Blob): Promise<Uint8Array> => new Uint8Array(await b.arrayBuffer());

function faceOf(g: RehearsalGuest, k: number): Promise<{ avatar: Uint8Array; thumb: Uint8Array } | null> {
  // «Ты» and every third guest: the chrome avatar (no selfie); Vlados has a selfie, of course
  const chrome = g.isMe || (!g.isVlados && k % 3 === 2);
  const key = `${chrome ? 'c' : 's'}:${g.name}:${g.seed}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      try {
        if (chrome) {
          const r = await generateChromeAvatar(g.name);
          URL.revokeObjectURL(r.url);
          return { avatar: await bytes(r.avatar), thumb: await bytes(r.thumb) };
        }
        return await fakeSelfie((g.seed % 97) + 1);
      } catch {
        return null;
      }
    })();
    cache.set(key, p);
  }
  return p;
}

/** Avatars for every guest (a guest whose picture failed simply shows the initial). */
export async function makeFaces(guests: readonly RehearsalGuest[]): Promise<Faces> {
  const out: Faces = {};
  const all = await Promise.all(guests.map((g, k) => faceOf(g, k)));
  guests.forEach((g, k) => {
    const f = all[k];
    if (f) out[g.uid] = f;
  });
  return out;
}
