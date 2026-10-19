// Seed documents shared by tools/seed-dev.mjs and tools/seed-prod.mjs (run them with tsx: they
// import the TypeScript sources). The docs are exactly what the app writes:
//   admin/content          ← shared/defaults.ts seedContent() (6 template questions), without `media`
//   config/current         ← { gameId }
//   games/{g}              ← a lobby game doc (app/src/host/pure.ts initialGameDoc)
//   games/{g}/private/totals ← empty host totals

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { DEFAULT_GAME_ID } from '../../shared/fbtypes.ts';
import { seedContent } from '../../shared/defaults.ts';
import { emptyTotals, hostContent, initialGameDoc, stripUndefined } from '../../app/src/host/pure.ts';
import { ROOT } from './fbproject.mjs';

/**
 * @param {{ gameId?: string, now?: number }} [opts]
 * @returns {{ gameId: string, content: Record<string, unknown>, current: { gameId: string }, game: Record<string, unknown>, totals: Record<string, unknown> }}
 */
export function seedDocs(opts = {}) {
  const gameId = opts.gameId ?? DEFAULT_GAME_ID;
  const now = opts.now ?? Date.now();
  const { rev, settings, questions, trash } = seedContent();
  // admin/content holds no `media` (media live in media/{id}); the rules refuse unknown keys.
  const content = stripUndefined({ rev, settings, questions, trash, updatedAt: now });
  return {
    gameId,
    content,
    current: { gameId },
    game: stripUndefined(initialGameDoc(hostContent(content).settings)),
    totals: emptyTotals(now),
  };
}

// ---------- Firestore REST (owner credentials of the logged-in firebase CLI) ----------

/** JS value → Firestore REST Value (integers stay integers, like the JS SDK writes them). */
export function toRestValue(v) {
  if (v === null) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isSafeInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (v instanceof Uint8Array) return { bytesValue: Buffer.from(v).toString('base64') };
  if (Array.isArray(v)) return { arrayValue: v.length ? { values: v.map(toRestValue) } : {} };
  if (typeof v === 'object') {
    /** @type {Record<string, unknown>} */
    const fields = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) fields[k] = toRestValue(x);
    return { mapValue: Object.keys(fields).length ? { fields } : {} };
  }
  throw new Error(`cannot encode ${typeof v}`);
}

/** Firestore REST Value → JS value (for read-backs in checks). */
export function fromRestValue(v) {
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return Date.parse(v.timestampValue);
  if ('bytesValue' in v) return new Uint8Array(Buffer.from(v.bytesValue, 'base64'));
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(fromRestValue);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, fromRestValue(x)]));
  throw new Error(`cannot decode ${Object.keys(v).join()}`);
}

/** An authorized Firestore REST client for `projectId` using the firebase CLI login (owner). */
export async function restClient(projectId) {
  const require = createRequire(import.meta.url);
  const lib = (p) => require(join(ROOT, 'node_modules', 'firebase-tools', 'lib', p));
  const account = lib('auth').getGlobalDefaultAccount();
  if (!account) throw new Error('firebase-tools is not logged in');
  await lib('requireAuth').requireAuth({ user: account.user, tokens: account.tokens });
  const { Client } = lib('apiv2');
  const api = new Client({ urlPrefix: 'https://firestore.googleapis.com', apiVersion: 'v1' });
  const root = `projects/${projectId}/databases/(default)/documents`;
  return {
    root,
    /** Resolves the decoded doc, or null when it does not exist. */
    async get(path) {
      try {
        const res = await api.get(`/${root}/${path}`);
        return fromRestValue({ mapValue: { fields: res.body.fields ?? {} } });
      } catch (e) {
        if (e?.context?.response?.statusCode === 404 || e?.status === 404) return null;
        throw e;
      }
    },
    /** Atomic commit of create-only writes: fails as a whole if any doc already exists. */
    async createAll(docs) {
      const writes = docs.map(({ path, data }) => ({
        update: { name: `${root}/${path}`, fields: toRestValue(data).mapValue.fields ?? {} },
        currentDocument: { exists: false },
      }));
      await api.post(`/${root}:commit`, { writes });
    },
    async remove(path) {
      await api.delete(`/${root}/${path}`);
    },
  };
}

/**
 * Create-only seeding over REST: does NOTHING if admin/content exists (never overwrites organizer
 * data); otherwise creates admin/content and whichever of config/current, games/{g},
 * games/{g}/private/totals are missing, in one atomic commit with exists=false preconditions.
 * `paths` lets checks run against scratch paths.
 */
export async function seedCreateOnly(projectId, opts = {}) {
  const docs = seedDocs(opts);
  const paths = {
    content: 'admin/content',
    current: 'config/current',
    game: `games/${docs.gameId}`,
    totals: `games/${docs.gameId}/private/totals`,
    ...(opts.paths ?? {}),
  };
  const rest = await restClient(projectId);
  if (await rest.get(paths.content)) return { created: [], skipped: 'admin/content exists — nothing written' };
  const want = [
    { path: paths.content, data: docs.content },
    { path: paths.current, data: docs.current },
    { path: paths.game, data: docs.game },
    { path: paths.totals, data: docs.totals },
  ];
  const missing = [];
  for (const d of want) if (d.path === paths.content || !(await rest.get(d.path))) missing.push(d);
  await rest.createAll(missing);
  return { created: missing.map((d) => d.path), skipped: null, rest };
}
