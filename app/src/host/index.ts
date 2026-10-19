// The game host (docs/firebase.md → Host) and the player API. Framework-free; runs in the browser
// and in Node 22 (bots, tests). Screens consume only the view models from ./views.

export * from './model';
export * from './pure';
export * from './views';
export { Host, type HostOptions } from './driver';
export { PlayerSession, type PlayerOptions, type JoinResult, type AnswerResult, type ReactResult, type UpdateResult } from './player';
export { runCommand, runTick, patchGame, totalsRef, leaseRef, clearLease, type HostCtx } from './commands';
