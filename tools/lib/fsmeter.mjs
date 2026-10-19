// Firestore usage meter for Node tools (tools/swarm.mjs). Loaded INSTEAD of `firebase/firestore`
// through the resolve hook in fsmeter-hooks.mjs, so the app code (Host, PlayerSession) runs
// unchanged while every billable operation is counted the way Firestore bills it:
//   reads  — getDoc/getDocFromServer: 1 (not when served from the local cache);
//            getDocs/getDocsFromServer: max(1, docs);
//            listeners: the first server snapshot max(1, docs), then every added/modified doc
//            delivered by the server (metadata-only snapshots and cache replays are free);
//            transactions: every tx.get of every attempt.
//   writes — setDoc/updateDoc/addDoc and each op of a committed batch/transaction; deletes apart.
// Refused (permission-denied) and failed operations are not counted.
// Every count is attributed to the current meter.phase, a client label (meter.label(db, 'host'))
// and the area of the database it touched (game, totals, lease, players, answers, reactions, …).

import * as real from '@firebase/firestore';

export * from '@firebase/firestore';

const labels = new WeakMap();
/** @type {Map<string, { reads: number, writes: number, deletes: number }>} */
const counts = new Map();

export const meter = {
  phase: 'setup',
  /** @param {object} db @param {string} name */
  label(db, name) {
    labels.set(db, name);
  },
  /** Totals keyed "phase|label|area". */
  snapshot() {
    return Object.fromEntries([...counts].map(([k, v]) => [k, { ...v }]));
  },
  reset() {
    counts.clear();
  },
};

/** games/{g} → game, games/{g}/private/totals → totals, config/clock_x → clock, … */
export function areaOf(path) {
  const s = path.split('/');
  if (s[0] === 'games') {
    if (s.length <= 2) return 'game';
    if (s[2] === 'private') return s[3] === 'host' ? 'lease' : (s[3] ?? 'private');
    return s[2];
  }
  if (s[0] === 'config') return s[1]?.startsWith('clock_') ? 'clock' : 'config';
  return s[0] ?? '?';
}

function pathOf(ref) {
  if (typeof ref?.path === 'string') return ref.path;
  try {
    return ref?._query?.path?.canonicalString?.() ?? '?';
  } catch {
    return '?';
  }
}

function bump(ref, kind, n = 1, db = ref?.firestore) {
  if (!n) return;
  const key = `${meter.phase}|${labels.get(db) ?? '?'}|${areaOf(pathOf(ref))}`;
  let c = counts.get(key);
  if (!c) counts.set(key, (c = { reads: 0, writes: 0, deletes: 0 }));
  c[kind] += n;
}

// ---------- point reads & queries ----------

export async function getDoc(ref) {
  const s = await real.getDoc(ref);
  if (!s.metadata.fromCache) bump(ref, 'reads');
  return s;
}
export async function getDocFromServer(ref) {
  const s = await real.getDocFromServer(ref);
  bump(ref, 'reads');
  return s;
}
export async function getDocs(q) {
  const s = await real.getDocs(q);
  if (!s.metadata.fromCache) bump(q, 'reads', Math.max(1, s.size));
  return s;
}
export async function getDocsFromServer(q) {
  const s = await real.getDocsFromServer(q);
  bump(q, 'reads', Math.max(1, s.size));
  return s;
}

// ---------- listeners ----------

/** JSON with sorted keys (the server does not keep map-field order between two sends of a doc). */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object' && !ArrayBuffer.isView(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

export function onSnapshot(ref, ...args) {
  const isQuery = ref.type === 'query' || ref.type === 'collection';
  let seenServer = false;
  let last = null;
  const count = (snap) => {
    if (snap.metadata.fromCache) return;
    if (isQuery) {
      if (!seenServer) bump(ref, 'reads', Math.max(1, snap.size));
      else bump(ref, 'reads', snap.docChanges().filter((c) => c.type !== 'removed').length);
    } else {
      const sig = snap.exists() ? stable(snap.data()) : null;
      if (!seenServer || sig !== last) bump(ref, 'reads');
      last = sig;
    }
    seenServer = true;
  };
  const i = typeof args[0] === 'object' && args[0] !== null && !('next' in args[0]) && typeof args[1] !== 'undefined' ? 1 : 0;
  const head = args.slice(0, i);
  const obs = args[i];
  if (typeof obs === 'function') {
    return real.onSnapshot(ref, ...head, (s) => (count(s), obs(s)), ...args.slice(i + 1));
  }
  return real.onSnapshot(ref, ...head, {
    next: (s) => (count(s), obs.next?.(s)),
    error: (e) => obs.error?.(e),
    complete: () => obs.complete?.(),
  });
}

// ---------- writes ----------

export async function setDoc(ref, ...a) {
  await real.setDoc(ref, ...a);
  bump(ref, 'writes');
}
export async function updateDoc(ref, ...a) {
  await real.updateDoc(ref, ...a);
  bump(ref, 'writes');
}
export async function addDoc(ref, ...a) {
  const r = await real.addDoc(ref, ...a);
  bump(ref, 'writes');
  return r;
}
export async function deleteDoc(ref) {
  await real.deleteDoc(ref);
  bump(ref, 'deletes');
}

export function writeBatch(db) {
  const b = real.writeBatch(db);
  const ops = [];
  const w = {
    set: (ref, ...a) => (ops.push([ref, 'writes']), b.set(ref, ...a), w),
    update: (ref, ...a) => (ops.push([ref, 'writes']), b.update(ref, ...a), w),
    delete: (ref) => (ops.push([ref, 'deletes']), b.delete(ref), w),
    commit: async () => {
      await b.commit();
      for (const [ref, kind] of ops) bump(ref, kind);
    },
  };
  return w;
}

export function runTransaction(db, fn, options) {
  let ops = [];
  return real
    .runTransaction(
      db,
      (tx) => {
        ops = [];
        const t = {
          get: async (ref) => {
            const s = await tx.get(ref);
            bump(ref, 'reads');
            return s;
          },
          set: (ref, ...a) => (ops.push([ref, 'writes']), tx.set(ref, ...a), t),
          update: (ref, ...a) => (ops.push([ref, 'writes']), tx.update(ref, ...a), t),
          delete: (ref) => (ops.push([ref, 'deletes']), tx.delete(ref), t),
        };
        return fn(t);
      },
      options,
    )
    .then((r) => {
      for (const [ref, kind] of ops) bump(ref, kind);
      return r;
    });
}
