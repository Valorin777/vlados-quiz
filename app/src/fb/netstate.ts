// Connection stage of this page's Firestore client, published by netwatch.ts for the screens.
// No Firebase import: the phone's first chunk renders it before the live chunk has arrived.

export type NetStage = 'ok' | 'connecting' | 'reconnecting';

export interface NetState {
  /** 'reconnecting': no server snapshot for ≥ 10 s (see NET_WATCH). */
  stage: NetStage;
  /** Network restarts done while down (resets when the connection is live again). */
  restarts: number;
  /** A reload with forced long polling is about to happen. */
  reloading: boolean;
}

let state: NetState = { stage: 'ok', restarts: 0, reloading: false };
const subs = new Set<() => void>();

export const netState = {
  get: (): NetState => state,
  set(patch: Partial<NetState>): void {
    const next = { ...state, ...patch };
    if (next.stage === state.stage && next.restarts === state.restarts && next.reloading === state.reloading) return;
    state = next;
    for (const fn of subs) fn();
  },
  subscribe(fn: () => void): () => void {
    subs.add(fn);
    return () => subs.delete(fn);
  },
};
