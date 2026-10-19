// The live half of the phone page, code-split from the first paint: Firebase (auth + Firestore),
// the PlayerSession and the media store. PlayerApp imports this lazily, so the guest sees the
// chrome loader (and the pre-game screen) while this chunk is still on its way over 4G.

import { FB_LIMITS, type MediaMetaDoc, type PlayerDoc } from '@shared/fbtypes';
import { getDoc } from 'firebase/firestore';
import { getFb } from '../../fb/app';
import { ensureSignedIn } from '../../fb/auth';
import { isMediaCached, loadMedia, mediaUrl } from '../../fb/media';
import { startNetWatch } from '../../fb/netwatch';
import { PlayerSession } from '../../host/player';
import { checkedName } from '../../host/pure';
import { bytesToBase64, clearDraft, saveProfile } from './joinDraft';
import type { SelfieResult } from './vx';
import type { Haptic, PlayerActions } from './types';

export interface Live {
  session: PlayerSession;
  actions: PlayerActions;
  /** Warm the cache for the next question (images only; videos stay on the TV). */
  prefetch(ids: readonly string[]): void;
  env: 'prod' | 'dev';
}

const bytesOf = async (b: globalThis.Blob): Promise<Uint8Array> => new Uint8Array(await b.arrayBuffer());

/**
 * The JPEG as bytes within `max`: as it is when it fits (the viewfinder aims under the limits),
 * else re-encoded smaller — decoded with createImageBitmap and drawn on an OffscreenCanvas where
 * there is one, so the main thread stays free. null only when nothing fits (or it cannot decode).
 */
async function fitJpeg(blob: globalThis.Blob, max: number, sides: readonly number[]): Promise<Uint8Array | null> {
  const bytes = await bytesOf(blob);
  if (bytes.length <= max) return bytes;
  const bmp = await createImageBitmap(blob);
  try {
    for (const side of sides) {
      for (const q of [0.72, 0.55, 0.4]) {
        let out: globalThis.Blob | null;
        if (typeof OffscreenCanvas === 'function') {
          const c = new OffscreenCanvas(side, side);
          c.getContext('2d')?.drawImage(bmp, 0, 0, side, side);
          out = await c.convertToBlob({ type: 'image/jpeg', quality: q });
        } else {
          const c = document.createElement('canvas');
          c.width = c.height = side;
          c.getContext('2d')?.drawImage(bmp, 0, 0, side, side);
          out = await new Promise<globalThis.Blob | null>((r) => c.toBlob(r, 'image/jpeg', q));
        }
        if (out && out.size <= max) return bytesOf(out);
      }
    }
  } finally {
    bmp.close();
  }
  return null;
}

const VIBES: Record<Haptic, number | number[]> = { tap: 8, commit: 14, good: [18, 60, 26, 60, 40], bad: [70] };

function vibrate(kind: Haptic): void {
  try {
    navigator.vibrate?.(VIBES[kind]);
  } catch {
    /* iOS has no vibration API; some browsers throw without a gesture */
  }
}

/** Only on the DEV project: `?game=<id>` plays a specific game (isolated test runs). */
function testGameId(env: 'prod' | 'dev'): string | undefined {
  if (env !== 'dev') return undefined;
  try {
    const g = new URLSearchParams(location.search).get('game');
    return g && /^[A-Za-z0-9_-]{1,64}$/.test(g) ? g : undefined;
  } catch {
    return undefined;
  }
}

export async function startLive(): Promise<Live> {
  const fb = getFb();
  // Until the game doc arrives from the server: «переподключаемся» after 10 s, network restarts,
  // then one reload with forced long polling (fb/netwatch.ts). Runs for the page's lifetime,
  // counting from the moment the session listens (after the anonymous sign-in).
  let watched: PlayerSession | null = null;
  startNetWatch(fb.db, {
    isLive: () => {
      const st = watched?.snapshot().gameState;
      return st === 'live' || st === 'missing';
    },
    // Signing in first (no Firestore yet): nothing to restart. Counting that time made a slow
    // link's first restart abort the Firestore handshake that had only just begun.
    isIdle: () => watched === null,
    // Never reload under a guest who is joining or already in (the join form itself survives a
    // reload through its sessionStorage draft, see Join.tsx).
    allowReload: () => !watched?.joining && !watched?.snapshot().me,
  });
  const user = await ensureSignedIn(fb.auth);
  const gameId = testGameId(fb.env);
  const session = new PlayerSession({ db: fb.db, uid: user.uid, ...(gameId ? { gameId } : {}) });
  watched = session;
  // DEV: the session for the E2E tools (the phone's server clock and view, see tools/video-phone-dev.ts)
  if (fb.env === 'dev') (window as unknown as { __pl?: PlayerSession }).__pl = session;
  // Once the server knows this player (join confirmed, or found on load): the door's draft is
  // done, and the name + selfie are remembered for the next join form on this device.
  let known: PlayerDoc | null = null;
  session.subscribe(({ me }) => {
    if (!me || me === known) return;
    const prev = known;
    known = me;
    clearDraft();
    if (prev && prev.name === me.name && prev.avatar === me.avatar) return;
    saveProfile(me.name, me.avatar && me.thumb ? { kind: 'photo', avatar: bytesToBase64(me.avatar), thumb: bytesToBase64(me.thumb) } : null);
  });
  await session.start();

  // Media metadata (kind/size) so phones never pull a video or a huge file by accident.
  const metas = new Map<string, Promise<MediaMetaDoc | null>>();
  const meta = (id: string) => {
    let p = metas.get(id);
    if (!p) {
      p = getDoc(fb.refs.mediaMeta(id)).then(
        (s) => s.data() ?? null,
        () => {
          metas.delete(id);
          return null;
        },
      );
      metas.set(id, p);
    }
    return p;
  };
  let prefetching = '';
  const prefetch = (ids: readonly string[]) => {
    const key = ids.join(',');
    if (!key || key === prefetching) return;
    prefetching = key;
    void (async () => {
      for (const id of ids) {
        if (await isMediaCached(id)) continue;
        const m = await meta(id);
        if (!m || m.kind !== 'image' || m.bytes > 4_000_000) continue;
        await loadMedia(fb.refs, id).catch(() => undefined);
      }
    })();
  };

  const actions: PlayerActions = {
    checkName: checkedName,
    async join(name, selfie: SelfieResult | null) {
      let avatar: Uint8Array | undefined;
      let thumb: Uint8Array | undefined;
      if (selfie) {
        try {
          const [a, t] = await Promise.all([
            fitJpeg(selfie.avatar, FB_LIMITS.avatarMaxBytes, [224, 192, 160, 128]),
            fitJpeg(selfie.thumb, FB_LIMITS.thumbMaxBytes, [64, 48]),
          ]);
          if (a && t) {
            avatar = a;
            thumb = t;
          }
        } catch {
          /* unreadable blob: join without a picture */
        }
      }
      return session.join(name, avatar, thumb);
    },
    answer: (round, p) => session.answer(round, p),
    react: (e) => session.react(e),
    now: () => session.clock.now(),
    media: (id) => mediaUrl(fb.refs, id),
    haptic: vibrate,
  };
  return { session, actions, prefetch, env: fb.env };
}
