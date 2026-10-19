// Admin commands and timed transitions as Firestore transactions (docs/firebase.md → Host).
//
// Every phase change is ONE transaction that reads games/{g} + private/totals (+ the lease for
// timed transitions), runs the pure step() on what it read, and writes both docs. Firestore retries
// the transaction when another page wrote in between, and step() then sees the new state: a double
// tap gets 'stale', a second host's tick finds nothing due. Players and answers come from this
// page's listeners (they only grow, and the reveal waits a grace period for the last answers).

import { FB_PATHS, type AnswerDoc, type GameDoc, type PlayerDoc, type ServerMs } from '@shared/fbtypes';
import type { EngineEvent } from '@shared/engine/reduce';
import { newId } from '@shared/util';
import {
  deleteDoc,
  doc,
  runTransaction,
  updateDoc,
  type DocumentData,
  type DocumentReference,
  type Firestore,
} from 'firebase/firestore';
import { converter, toFirestorePatch, type FbRefs } from '../fb/refs';
import type { LeaseDoc, MediaIndex, TotalsDoc } from './model';
import {
  answersLive,
  checkedName,
  emptyTotals,
  hostEvent,
  leaseAction,
  leaseHeld,
  newLease,
  sameValue,
  step,
  stripUndefined,
  tvOnAir,
  type CmdError,
  type CmdResult,
  type HostCommand,
  type HostContent,
  type StepOut,
} from './pure';

/** Typed refs of the host's private docs. */
export const totalsRef = (db: Firestore, g: string): DocumentReference<TotalsDoc, DocumentData> =>
  doc(db, FB_PATHS.gameTotals(g)).withConverter(converter<TotalsDoc>());
export const leaseRef = (db: Firestore, g: string): DocumentReference<LeaseDoc, DocumentData> =>
  doc(db, FB_PATHS.gameLease(g)).withConverter(converter<LeaseDoc>());

/** What a command needs from the page that sends it (the Host implements it). */
export interface HostCtx {
  db: Firestore;
  refs: FbRefs;
  gameId: string;
  session: string;
  uid: string;
  label: string;
  preferred: boolean;
  now(): ServerMs;
  content(): HostContent;
  media(): MediaIndex;
  players(): Readonly<Record<string, PlayerDoc>>;
  /** Answers of round `i` if this page has them in sync with the server, else null. */
  answersFor(i: number): readonly AnswerDoc[] | null;
}

export type TxResult = CmdResult & { out?: StepOut };

const TX_TIMEOUT_MS = 20_000;

/** Firestore error → command error. */
export function cmdErrorOf(e: unknown): CmdError {
  const code = typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : '';
  switch (code) {
    case 'permission-denied':
    case 'unauthenticated':
      return 'forbidden';
    case 'unavailable':
    case 'deadline-exceeded':
    case 'timeout':
      return 'offline';
    case 'aborted':
    case 'failed-precondition':
      return 'stale';
    case 'not-found':
      return 'not_found';
    default:
      return 'failed';
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('transaction timed out'), { code: 'timeout' })), ms);
  });
  try {
    return await Promise.race([p, t]);
  } finally {
    clearTimeout(timer);
  }
}

const secureRandomU32 = (): number => globalThis.crypto.getRandomValues(new Uint32Array(1))[0] as number;

/**
 * Runs one engine event (a command or a tick) as a transaction.
 * `requireLease`: only the lease holder may do it (timed transitions).
 */
export async function runStep(
  ctx: HostCtx,
  ev: EngineEvent,
  opts: { requireLease?: boolean; newGameId?: string } = {},
): Promise<TxResult> {
  const g = ctx.gameId;
  const gameRef = ctx.refs.game(g);
  const tRef = totalsRef(ctx.db, g);
  const lRef = leaseRef(ctx.db, g);
  // Secret seed for a new ordering round's shuffle (see StepCtx.shuffleSeed).
  const shuffleSeed = secureRandomU32();
  try {
    return await withTimeout(
      runTransaction(
        ctx.db,
        async (tx): Promise<TxResult> => {
          // The lease also says whether a TV is on air (a video round without one gets a short fallback).
          const [gs, ts, ls] = await Promise.all([tx.get(gameRef), tx.get(tRef), tx.get(lRef)]);
          const game = gs.data();
          if (!game) return { ok: false, error: 'not_found' };
          const now = ctx.now();
          const lease = ls.data();
          if (opts.requireLease && !leaseHeld(lease, ctx.session, now)) return { ok: false, error: 'not_leader' };
          let answers: readonly AnswerDoc[] = [];
          if (answersLive(game, now) && game.round) {
            const a = ctx.answersFor(game.round.i);
            // This page is behind (another admin moved the game on): let the listeners catch up.
            if (a === null) return { ok: false, error: 'stale' };
            answers = a;
          }
          const players = ctx.players();
          const out = step(
            { gameId: g, game, totals: ts.data() ?? null, players, answers },
            ev,
            now,
            {
              content: ctx.content(),
              players,
              media: ctx.media(),
              shuffleSeed,
              tv: tvOnAir(lease, now),
              ...(opts.newGameId ? { newGameId: opts.newGameId } : {}),
            },
          );
          if (!out.ok) return { ok: false, error: out.error ?? 'invalid' };
          if (!out.changed) return { ok: true, phaseRev: game.phaseRev, out };
          if (out.newGame) {
            tx.set(ctx.refs.game(out.gameId), stripUndefined(out.game));
            tx.set(totalsRef(ctx.db, out.gameId), stripUndefined(out.totals));
            tx.set(ctx.refs.configCurrent(), { gameId: out.gameId });
            return { ok: true, phaseRev: out.game.phaseRev, gameId: out.gameId, out };
          }
          tx.set(gameRef, stripUndefined(out.game));
          tx.set(tRef, stripUndefined(out.totals));
          for (const k of out.kicked) tx.update(ctx.refs.player(g, k.uid), { kicked: k.kicked });
          return { ok: true, phaseRev: out.game.phaseRev, out };
        },
        { maxAttempts: 5 },
      ),
      TX_TIMEOUT_MS,
    );
  } catch (e) {
    return { ok: false, error: cmdErrorOf(e) };
  }
}

/** Sends an admin command. */
export async function runCommand(ctx: HostCtx, cmd: HostCommand, totals: TotalsDoc | null): Promise<TxResult> {
  if (cmd.type === 'rename') return renamePlayer(ctx, cmd.uid, cmd.name);
  const ev = hostEvent(cmd, totals);
  if (!ev) return { ok: false, error: 'invalid' };
  return runStep(ctx, ev.t === 'cmd' ? { ...ev, by: ctx.label } : ev, cmd.type === 'newGame' ? { newGameId: newId(12) } : {});
}

/** rename: only the player doc changes (names are not unique in the Firebase version). */
async function renamePlayer(ctx: HostCtx, uid: string, raw: string): Promise<TxResult> {
  const name = checkedName(raw);
  if (!name || !ctx.players()[uid]) return { ok: false, error: 'invalid' };
  try {
    await withTimeout(updateDoc(ctx.refs.player(ctx.gameId, uid), { name }), TX_TIMEOUT_MS);
    return { ok: true, phaseRev: -1 };
  } catch (e) {
    return { ok: false, error: cmdErrorOf(e) };
  }
}

/** The timed transition due now (lease holder only). */
export const runTick = (ctx: HostCtx): Promise<TxResult> => runStep(ctx, { t: 'tick' }, { requireLease: true });

/**
 * Patches fields of the public doc (throttled counts, refreshed pub/next) unless the phase moved
 * on meanwhile. Resolves true when written.
 */
export async function patchGame(
  ctx: HostCtx,
  expect: { phaseRev: number; round: number | null },
  patch: Partial<Pick<GameDoc, 'answered' | 'players' | 'pub' | 'next'>>,
): Promise<boolean> {
  const gameRef = ctx.refs.game(ctx.gameId);
  try {
    return await withTimeout(
      runTransaction(ctx.db, async (tx) => {
        const game = (await tx.get(gameRef)).data();
        if (!game || game.phaseRev !== expect.phaseRev || (game.round?.i ?? null) !== expect.round) return false;
        const changed = Object.entries(patch).filter(([k, v]) => !sameValue(game[k as keyof GameDoc], v));
        if (!changed.length) return false;
        tx.update(gameRef, toFirestorePatch(stripUndefined(Object.fromEntries(changed))));
        return true;
      }),
      TX_TIMEOUT_MS,
    );
  } catch {
    return false;
  }
}

/**
 * Acquires, renews or takes over the lease when leaseAction() says so (re-checked on fresh data).
 * Resolves with the lease now in the doc (null when unknown).
 */
export async function maintainLease(ctx: HostCtx, active: boolean): Promise<{ lease: LeaseDoc | null; wrote: boolean; error?: CmdError }> {
  const ref = leaseRef(ctx.db, ctx.gameId);
  const me = { session: ctx.session, preferred: ctx.preferred, label: ctx.label, uid: ctx.uid };
  try {
    return await withTimeout(
      runTransaction(ctx.db, async (tx) => {
        const cur = (await tx.get(ref)).data() ?? null;
        const now = ctx.now();
        if (leaseAction(cur, me, now, active) === 'none') return { lease: cur, wrote: false };
        const next = newLease(me, now, active);
        tx.set(ref, next);
        return { lease: next, wrote: true };
      }),
      TX_TIMEOUT_MS,
    );
  } catch (e) {
    return { lease: null, wrote: false, error: cmdErrorOf(e) };
  }
}

/** Gives the lease up (page closing) so another page can take over at once. */
export async function releaseLease(ctx: HostCtx): Promise<void> {
  const ref = leaseRef(ctx.db, ctx.gameId);
  try {
    await withTimeout(
      runTransaction(ctx.db, async (tx) => {
        const cur = (await tx.get(ref)).data();
        if (cur?.session === ctx.session) tx.delete(ref);
      }),
      5_000,
    );
  } catch {
    // Best effort: the lease expires by itself.
  }
}

/** Creates the game doc (lobby) and its totals if they do not exist yet. */
export async function ensureGame(ctx: HostCtx, initial: GameDoc): Promise<boolean> {
  const gameRef = ctx.refs.game(ctx.gameId);
  const tRef = totalsRef(ctx.db, ctx.gameId);
  return withTimeout(
    runTransaction(ctx.db, async (tx) => {
      const [gs, ts] = await Promise.all([tx.get(gameRef), tx.get(tRef)]);
      let wrote = false;
      if (!gs.exists()) {
        tx.set(gameRef, stripUndefined(initial));
        wrote = true;
      }
      if (!ts.exists()) {
        tx.set(tRef, emptyTotals(ctx.now()));
        wrote = true;
      }
      return wrote;
    }),
    TX_TIMEOUT_MS,
  );
}

/** Test/DEV helper: removes the lease doc regardless of holder. */
export const clearLease = (db: Firestore, g: string): Promise<void> => deleteDoc(leaseRef(db, g));
