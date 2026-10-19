// Media in Firestore (docs/firebase.md → Media): `media/{id}` meta + `media/{id}/c/{i}` chunks of
// ≤ 900 KB Bytes. Upload writes every chunk first and the meta LAST, so a meta doc means complete.
// Download assembles a Blob and keeps it in the Cache API under `/vlados-media/<id>` (media are
// immutable: a new file gets a new id), so a device reads each file from Firestore at most once.
// Image resizing / video transcoding happen before this layer (admin media pipeline).

import { FB_LIMITS, isFbId, type MediaKind, type MediaMetaDoc } from '@shared/fbtypes';
import { newId } from '@shared/util';
import { deleteDoc, getDoc, getDocs, serverTimestamp, setDoc } from 'firebase/firestore';
import type { FbRefs } from './refs';

export const MEDIA_CACHE = 'vlados-media';
export const mediaCacheKey = (id: string): string => `/vlados-media/${id}`;

export const newMediaId = (): string => newId(16);

// ---------- Chunking ----------

/** Splits bytes into ≤ `max` pieces (views, no copies). */
export function splitChunks(bytes: Uint8Array, max: number = FB_LIMITS.chunkMaxBytes): Uint8Array[] {
  if (max <= 0) throw new Error('chunk size must be positive');
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += max) out.push(bytes.subarray(at, Math.min(bytes.length, at + max)));
  return out;
}

export function joinChunks(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// ---------- Local cache (Cache API, falls back to memory) ----------

const memory = new Map<string, Blob>();

async function openCache(): Promise<Cache | null> {
  try {
    return typeof caches === 'undefined' ? null : await caches.open(MEDIA_CACHE);
  } catch {
    // Insecure context, private mode, storage blocked.
    return null;
  }
}

async function cacheGet(id: string): Promise<Blob | null> {
  const hit = memory.get(id);
  if (hit) return hit;
  try {
    const res = await (await openCache())?.match(mediaCacheKey(id));
    if (!res) return null;
    const blob = await res.blob();
    memory.set(id, blob);
    return blob;
  } catch {
    return null;
  }
}

async function cachePut(id: string, blob: Blob): Promise<void> {
  memory.set(id, blob);
  try {
    await (await openCache())?.put(
      mediaCacheKey(id),
      new Response(blob, { headers: { 'Content-Type': blob.type, 'Content-Length': String(blob.size) } }),
    );
  } catch {
    // Quota or unavailable: the memory copy still serves this page load.
  }
}

/** True when the file is already on this device (no Firestore reads needed). */
export const isMediaCached = async (id: string): Promise<boolean> => (await cacheGet(id)) !== null;

// ---------- Upload (admins) ----------

export interface UploadMediaInput {
  kind: MediaKind;
  /** Encoded file: JPEG for images, MP4 (H.264/AAC) for video. */
  blob: Blob;
  w: number;
  h: number;
  durationS?: number;
  posterId?: string;
  /** Defaults to a new random id. */
  id?: string;
  onProgress?: (done: number, total: number) => void;
}

export async function uploadMedia(refs: FbRefs, input: UploadMediaInput): Promise<{ id: string; meta: MediaMetaDoc }> {
  const id = input.id ?? newMediaId();
  if (!isFbId(id)) throw new Error(`bad media id: ${id}`);
  const mime = input.blob.type || (input.kind === 'image' ? 'image/jpeg' : 'video/mp4');
  const bytes = new Uint8Array(await input.blob.arrayBuffer());
  if (bytes.length === 0) throw new Error('empty file');
  if (bytes.length > FB_LIMITS.mediaMaxBytes) throw new Error(`file too large: ${bytes.length} bytes`);
  const chunks = splitChunks(bytes);
  if (chunks.length > FB_LIMITS.maxChunks) throw new Error(`too many chunks: ${chunks.length}`);

  input.onProgress?.(0, chunks.length);
  for (const [i, d] of chunks.entries()) {
    await setDoc(refs.mediaChunk(id, i), { d });
    input.onProgress?.(i + 1, chunks.length);
  }
  const meta: MediaMetaDoc = {
    kind: input.kind,
    mime,
    w: Math.round(input.w),
    h: Math.round(input.h),
    bytes: bytes.length,
    chunks: chunks.length,
    createdAt: Date.now(),
    ...(input.durationS !== undefined ? { durationS: input.durationS } : {}),
    ...(input.posterId ? { posterId: input.posterId } : {}),
  };
  await setDoc(refs.mediaMeta(id), { ...meta, createdAt: serverTimestamp() });
  // The uploader never needs to download its own file.
  await cachePut(id, new Blob([bytes], { type: mime }));
  return { id, meta };
}

/** Admins: removes the chunks, then the meta. */
export async function deleteMedia(refs: FbRefs, id: string): Promise<void> {
  const chunks = await getDocs(refs.mediaChunks(id));
  await Promise.all(chunks.docs.map((d) => deleteDoc(d.ref)));
  await deleteDoc(refs.mediaMeta(id));
  memory.delete(id);
  try {
    await (await openCache())?.delete(mediaCacheKey(id));
  } catch {
    // ignore
  }
}

// ---------- Download ----------

const inflight = new Map<string, Promise<Blob>>();
const CHUNK_PARALLEL = 3;

async function download(refs: FbRefs, id: string): Promise<Blob> {
  const metaSnap = await getDoc(refs.mediaMeta(id));
  const meta = metaSnap.data();
  if (!meta) throw new Error(`media not found: ${id}`);
  const parts: Uint8Array[] = new Array<Uint8Array>(meta.chunks);
  let next = 0;
  const worker = async () => {
    while (next < meta.chunks) {
      const i = next++;
      const d = (await getDoc(refs.mediaChunk(id, i))).data()?.d;
      if (!d) throw new Error(`media ${id}: chunk ${i} missing`);
      parts[i] = d;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHUNK_PARALLEL, meta.chunks) }, worker));
  const bytes = joinChunks(parts);
  if (bytes.length !== meta.bytes) throw new Error(`media ${id}: size ${bytes.length} ≠ ${meta.bytes}`);
  return new Blob([bytes], { type: meta.mime });
}

/** The file as a Blob: from this device's cache, else from Firestore (then cached). */
export function loadMedia(refs: FbRefs, id: string): Promise<Blob> {
  const running = inflight.get(id);
  if (running) return running;
  const p = (async () => {
    const cached = await cacheGet(id);
    if (cached) return cached;
    const blob = await download(refs, id);
    await cachePut(id, blob);
    return blob;
  })().finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

const objectUrls = new Map<string, string>();

/** An object URL for <img>/<video>; one per id for the page's lifetime. */
export async function mediaUrl(refs: FbRefs, id: string): Promise<string> {
  const have = objectUrls.get(id);
  if (have) return have;
  const url = URL.createObjectURL(await loadMedia(refs, id));
  const raced = objectUrls.get(id);
  if (raced) {
    URL.revokeObjectURL(url);
    return raced;
  }
  objectUrls.set(id, url);
  return url;
}

/** Warms the cache one file at a time (lobby/board → next question); failures are ignored. */
export async function prefetchMedia(refs: FbRefs, ids: readonly string[]): Promise<void> {
  for (const id of new Set(ids)) {
    if (!isFbId(id)) continue;
    try {
      await loadMedia(refs, id);
    } catch {
      // The screen will try again (and show a fallback) when it needs the file.
    }
  }
}

/** Test helper: forgets the in-memory copies (the Cache API is left alone). */
export function clearMediaMemory(): void {
  memory.clear();
  for (const url of objectUrls.values()) URL.revokeObjectURL(url);
  objectUrls.clear();
}
