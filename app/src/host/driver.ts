// The game driver (docs/firebase.md → Host). Runs in the TV page (preferred), in admin pages
// (standby: takes over when the lease expires) and in Node for tests/bots — no DOM needed.
//
// It listens to games/{g}, private/totals, private/host (lease), players, the current round's
// answers, admin/content and (TV) reactions; keeps them as a local model; and, while it holds the
// lease, performs every timed transition exactly once (a transaction that re-checks the lease and
// re-reads the game, so a second host finds nothing to do). The answered/players counts go to the
// public doc at most every 5 s / 15 s. Any admin page can send commands (commands.ts).

import { DEFAULT_GAME_ID, type AdminContentDoc, type AnswerDoc, type PlayerDoc, type ServerMs } from '@shared/fbtypes';
import { newId } from '@shared/util';
import { getDoc, getDocsFromServer, onSnapshot, query, where, type Firestore, type Unsubscribe } from 'firebase/firestore';
import { adminClockProbe, clock as sharedClock, startClockSync, type ClockSync, type ServerClock } from '../fb/clock';
import { fbRefs, tsFromMs, type FbRefs } from '../fb/refs';
import {
  cmdErrorOf,
  ensureGame,
  leaseRef,
  maintainLease,
  patchGame,
  releaseLease,
  runCommand,
  runTick,
  totalsRef,
  type HostCtx,
  type TxResult,
} from './commands';
import {
  HOST_TIMING,
  type HostHealth,
  type HostInput,
  type HostSnapshot,
  type LeaseDoc,
  type ListenerState,
  type MediaInfo,
  type TotalsDoc,
} from './model';
import {
  answersLive,
  countsPushDue,
  hostContent,
  hostDeadline,
  initialGameDoc,
  leaseAction,
  leaseHeld,
  liveCounts,
  referencedMediaIds,
  refreshedGame,
  type CmdResult,
  type HostCommand,
  type HostContent,
} from './pure';
import { buildAdminView, buildTvView, type AdminView, type TvView } from './views';

export interface HostOptions {
  db: Firestore;
  /** The signed-in admin's uid (clock probe doc, lease owner). */
  uid: string;
  /** Defaults to the page-wide clock of app/src/fb/clock.ts (bots pass their own). */
  clock?: ServerClock;
  /** The TV: takes the lease over from a non-preferred holder. */
  preferred?: boolean;
  /** Shown in admin health ('tv', 'admin', 'bot'). */
  label?: string;
  /** Fixed content instead of listening to admin/content (tests, bots). */
  content?: AdminContentDoc;
  /** Listen to reactions (TV). Default true. */
  reactions?: boolean;
  /** Take part in the lease and run timed transitions. Default true. */
  drive?: boolean;
  /** Switch games when config/current changes (another page ran newGame). Default true. */
  followCurrent?: boolean;
  /** Measure the clock with config/clock_{uid} probes. Default true. */
  syncClock?: boolean;
  /**
   * Extra wake-ups of the driver loop: `fn` subscribes, returns the unsubscribe. The pages pass
   * workerWake() — a hidden tab's timers run at most once a minute (Chrome), a worker's are not
   * throttled, so an admin tab in the background still opens the answers on time.
   */
  wake?: (fn: () => void) => () => void;
  /** Create games/{g} (lobby) if it does not exist. Default true. */
  createGame?: boolean;
  log?: (msg: string) => void;
}

type Listener = (s: HostSnapshot) => void;

const LISTENERS = ['game', 'totals', 'lease', 'players', 'answers', 'content', 'reactions'] as const;
const REACTIONS_KEEP = 60;
const REACTIONS_WINDOW_MS = 60_000;

interface Model {
  game: HostSnapshot['game'];
  totals: TotalsDoc | null;
  lease: LeaseDoc | null;
  players: Record<string, PlayerDoc>;
  answers: AnswerDoc[];
  answersRound: number | null;
  answersSynced: boolean;
  reactions: HostSnapshot['reactions'];
  content: AdminContentDoc | null;
  media: Record<string, MediaInfo>;
  loaded: Set<string>;
}

const emptyModel = (): Model => ({
  game: null,
  totals: null,
  lease: null,
  players: {},
  answers: [],
  answersRound: null,
  answersSynced: false,
  reactions: [],
  content: null,
  media: {},
  loaded: new Set(),
});

export class Host {
  readonly session = newId(16);
  readonly label: string;
  readonly preferred: boolean;
  readonly clock: ServerClock;
  readonly refs: FbRefs;

  private readonly db: Firestore;
  private readonly uid: string;
  private readonly opts: HostOptions;
  private g: string | null = null;
  private m: Model = emptyModel();
  private health: HostHealth;
  private unsubs: Unsubscribe[] = [];
  private currentUnsub: Unsubscribe | null = null;
  private answersUnsub: Unsubscribe | null = null;
  private subs = new Set<Listener>();
  private loop: ReturnType<typeof setInterval> | null = null;
  private unwake: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private busy = false;
  private stopped = true;
  private epoch = 0;
  private clockSync: ClockSync | null = null;
  private lastCountsPushAt = 0;
  private lastRefreshAt = 0;
  private leaseRetryAt = 0;
  /** After a write, wait for the listener to deliver at least this totals rev before ticking again. */
  private minTotalsRev = -1;
  private minTotalsRevUntil = 0;
  private ensuring = false;
  private notifyQueued = false;
  /** Media ids looked up (Date.now()); a missing one is retried at most once a minute. */
  private mediaTriedAt = new Map<string, number>();

  constructor(opts: HostOptions) {
    this.opts = opts;
    this.db = opts.db;
    this.uid = opts.uid;
    this.refs = fbRefs(opts.db);
    this.clock = opts.clock ?? sharedClock;
    this.label = opts.label ?? (opts.preferred ? 'tv' : 'admin');
    this.preferred = opts.preferred === true;
    this.health = this.freshHealth();
  }

  // ---------- Public API ----------

  get gameId(): string | null {
    return this.g;
  }

  now(): ServerMs {
    return this.clock.now();
  }

  /** Starts listening (and driving) the given game, or the one in config/current. */
  async start(gameId?: string): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    if (this.opts.syncClock !== false) {
      this.clockSync = startClockSync(adminClockProbe(this.refs, this.uid), this.clock);
      await this.waitForClock(10_000);
    }
    const g = gameId ?? (await this.readCurrentGame()) ?? DEFAULT_GAME_ID;
    if (this.opts.followCurrent !== false) this.followCurrent();
    await this.attach(g);
    this.loop = setInterval(() => this.kick(), HOST_TIMING.loopMs);
    this.unwake = this.opts.wake?.(() => this.kick()) ?? null;
  }

  /** Stops everything and gives the lease up so another page can take over at once. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.loop) clearInterval(this.loop);
    if (this.timer) clearTimeout(this.timer);
    this.loop = this.timer = null;
    this.unwake?.();
    this.unwake = null;
    this.currentUnsub?.();
    this.currentUnsub = null;
    this.detach();
    this.clockSync?.stop();
    this.clockSync = null;
    if (this.g && leaseHeld(this.m.lease, this.session, this.now())) await releaseLease(this.ctx(this.g));
    await this.queue.catch(() => undefined);
  }

  subscribe(fn: Listener): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  snapshot(): HostSnapshot {
    const m = this.m;
    return {
      gameId: this.g ?? '',
      game: m.game,
      totals: m.totals,
      players: m.players,
      answers: m.answers,
      answersRound: m.answersRound,
      content: m.content,
      media: m.media,
      lease: m.lease,
      reactions: m.reactions,
      session: this.session,
      label: this.label,
      health: { ...this.health, leader: this.opts.drive !== false && this.isLeader(), clock: { ...this.clock.get() }, listeners: { ...this.health.listeners } },
    };
  }

  tvView(now: ServerMs = this.now()): TvView {
    return buildTvView(this.snapshot(), now);
  }

  adminView(now: ServerMs = this.now()): AdminView {
    return buildAdminView(this.snapshot(), now);
  }

  /** True once every listener delivered its first snapshot. */
  get ready(): boolean {
    return this.isLoaded();
  }

  /** Resolves when ready (or rejects after `timeoutMs`). */
  async whenReady(timeoutMs = 20_000): Promise<void> {
    const t0 = Date.now();
    while (!this.isLoaded()) {
      if (this.stopped) throw new Error('host stopped');
      if (Date.now() - t0 > timeoutMs) throw new Error('host: listeners did not load');
      await sleep(50);
    }
  }

  /** Sends an admin command (any admin page may, leader or not). */
  async command(cmd: HostCommand): Promise<CmdResult> {
    const g = this.g;
    if (!g || this.stopped) return { ok: false, error: 'not_found' };
    // A second tap on the same page: known stale without a round trip.
    if ('phaseRev' in cmd && this.m.game && cmd.phaseRev < this.m.game.phaseRev) return { ok: false, error: 'stale' };
    const round = this.m.game?.round;
    if (round && answersLive(this.m.game, this.now())) await this.ensureAnswers(round.i);
    const r = await this.enqueue(() => runCommand(this.ctx(g), cmd, this.m.totals));
    this.afterTx(r, 'command');
    if (r.ok && r.gameId && r.gameId !== this.g) await this.switchGame(r.gameId);
    this.kick();
    if (!r.ok) return { ok: false, error: r.error };
    // rename does not touch the game doc: report the phaseRev on screen.
    const phaseRev = r.phaseRev >= 0 ? r.phaseRev : (this.m.game?.phaseRev ?? 0);
    return { ok: true, phaseRev, ...(r.gameId ? { gameId: r.gameId } : {}) };
  }

  /** Runs the driver loop once now (tests). */
  async pumpNow(): Promise<void> {
    await this.pump();
  }

  // ---------- Game attach / switch ----------

  private async readCurrentGame(): Promise<string | null> {
    try {
      return (await getDoc(this.refs.configCurrent())).data()?.gameId ?? null;
    } catch {
      return null;
    }
  }

  private followCurrent(): void {
    this.currentUnsub = onSnapshot(
      this.refs.configCurrent(),
      (snap) => {
        const g = snap.data()?.gameId;
        if (g && this.g && g !== this.g && !this.stopped) void this.switchGame(g);
      },
      (e) => this.error(`config/current: ${e.message}`),
    );
  }

  private async switchGame(g: string): Promise<void> {
    if (g === this.g || this.stopped) return;
    const old = this.g;
    if (old && leaseHeld(this.m.lease, this.session, this.now())) void releaseLease(this.ctx(old));
    this.log(`switching game ${old} → ${g}`);
    await this.attach(g);
  }

  private detach(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.answersUnsub?.();
    this.answersUnsub = null;
  }

  private async attach(g: string): Promise<void> {
    this.detach();
    this.epoch++;
    const epoch = this.epoch;
    this.g = g;
    this.m = emptyModel();
    this.health = this.freshHealth();
    this.minTotalsRev = -1;
    this.mediaTriedAt.clear();
    const live = <T>(fn: (v: T) => void) => (v: T) => {
      if (epoch === this.epoch && !this.stopped) fn(v);
    };
    const failed = (name: (typeof LISTENERS)[number]) =>
      live((e: Error) => {
        this.health.listeners[name] = 'error';
        this.error(`${name} listener: ${e.message}`);
      });
    const state = (fromCache: boolean): ListenerState => (fromCache ? 'cache' : 'live');
    const r = this.refs;
    const meta = { includeMetadataChanges: true };

    this.unsubs.push(
      onSnapshot(
        r.game(g),
        meta,
        live((snap) => {
          this.m.game = snap.data() ?? null;
          this.loadedOne('game', state(snap.metadata.fromCache));
          const i = this.m.game?.round?.i ?? null;
          if (i !== this.m.answersRound) this.listenAnswers(g, i, epoch);
          this.changed();
        }),
        failed('game'),
      ),
      onSnapshot(
        totalsRef(this.db, g),
        meta,
        live((snap) => {
          this.m.totals = snap.data() ?? null;
          this.loadedOne('totals', state(snap.metadata.fromCache));
          void this.refreshMedia();
          this.changed();
        }),
        failed('totals'),
      ),
      onSnapshot(
        leaseRef(this.db, g),
        meta,
        live((snap) => {
          const next = snap.data() ?? null;
          // Our own write may resolve after the listener delivered a newer lease: keep the newest.
          if (!next || !this.m.lease || next.at >= this.m.lease.at || next.session !== this.m.lease.session) this.m.lease = next;
          this.loadedOne('lease', state(snap.metadata.fromCache));
          this.changed();
        }),
        failed('lease'),
      ),
      onSnapshot(
        r.players(g),
        meta,
        live((snap) => {
          const players: Record<string, PlayerDoc> = {};
          for (const d of snap.docs) players[d.id] = d.data();
          this.m.players = players;
          this.loadedOne('players', state(snap.metadata.fromCache));
          this.changed();
        }),
        failed('players'),
      ),
    );

    if (this.opts.content) {
      this.m.content = this.opts.content;
      this.loadedOne('content', 'live');
      void this.refreshMedia();
    } else {
      this.unsubs.push(
        onSnapshot(
          r.adminContent(),
          meta,
          live((snap) => {
            this.m.content = snap.data() ?? null;
            this.loadedOne('content', state(snap.metadata.fromCache));
            void this.refreshMedia();
            this.changed();
          }),
          failed('content'),
        ),
      );
    }

    if (this.opts.reactions !== false) {
      const since = tsFromMs(this.now() - 5_000);
      this.unsubs.push(
        onSnapshot(
          query(r.reactions(g), where('at', '>', since)),
          live((snap) => {
            const added = snap
              .docChanges()
              .filter((c) => c.type === 'added')
              .map((c) => ({ id: c.doc.id, ...c.doc.data() }));
            if (added.length) {
              const cutoff = this.now() - REACTIONS_WINDOW_MS;
              this.m.reactions = [...this.m.reactions, ...added]
                .filter((x) => x.at > cutoff)
                .sort((a, b) => a.at - b.at)
                .slice(-REACTIONS_KEEP);
            }
            this.health.listeners.reactions = state(snap.metadata.fromCache);
            this.changed();
          }),
          failed('reactions'),
        ),
      );
    } else {
      this.health.listeners.reactions = 'live';
    }

    try {
      await this.whenReady();
    } catch (e) {
      this.error(e instanceof Error ? e.message : String(e));
    }
    if (epoch !== this.epoch || this.stopped) return;
    if (!this.m.game && this.opts.createGame !== false) {
      try {
        await this.enqueue(() => ensureGame(this.ctx(g), initialGameDoc(this.content().settings)));
      } catch (e) {
        this.error(`create game ${g}: ${cmdErrorOf(e)}`);
      }
    }
    this.kick();
  }

  private listenAnswers(g: string, i: number | null, epoch: number): void {
    this.answersUnsub?.();
    this.answersUnsub = null;
    this.m.answers = [];
    this.m.answersRound = i;
    this.m.answersSynced = i === null;
    this.health.listeners.answers = i === null ? 'live' : 'loading';
    if (i === null) return;
    this.answersUnsub = onSnapshot(
      query(this.refs.answers(g), where('round', '==', i)),
      { includeMetadataChanges: true },
      (snap) => {
        if (epoch !== this.epoch || this.m.answersRound !== i) return;
        this.m.answers = snap.docs.map((d) => d.data());
        this.m.answersSynced = !snap.metadata.fromCache;
        this.health.listeners.answers = snap.metadata.fromCache ? 'cache' : 'live';
        this.changed();
      },
      (e) => {
        this.health.listeners.answers = 'error';
        this.error(`answers listener: ${e.message}`);
      },
    );
  }

  /** Makes sure answers of round i are complete (server fetch when the listener is not in sync). */
  private async ensureAnswers(i: number): Promise<void> {
    if (this.answersFor(i) !== null || this.ensuring || !this.g) return;
    this.ensuring = true;
    try {
      const snap = await getDocsFromServer(query(this.refs.answers(this.g), where('round', '==', i)));
      if (this.m.answersRound !== i) return;
      const byUid = new Map(this.m.answers.map((a) => [a.uid, a] as const));
      for (const d of snap.docs) byUid.set(d.data().uid, d.data());
      this.m.answers = [...byUid.values()];
      this.m.answersSynced = true;
    } catch (e) {
      this.error(`answers fetch: ${cmdErrorOf(e)}`);
    } finally {
      this.ensuring = false;
    }
  }

  private answersFor(i: number): readonly AnswerDoc[] | null {
    return this.m.answersRound === i && this.m.answersSynced ? this.m.answers : null;
  }

  private async refreshMedia(): Promise<void> {
    const c = this.m.content;
    if (!c) return;
    // Frozen rounds too: a question deleted mid-round keeps its media on air (see referencedMediaIds).
    const ids = referencedMediaIds(c, this.m.totals);
    const now = Date.now();
    // Runs on every content/totals snapshot: a missing file is looked up again at most once a minute.
    const missing = ids.filter((id) => !this.m.media[id] && now - (this.mediaTriedAt.get(id) ?? -Infinity) >= 60_000);
    if (!missing.length) return;
    for (const id of missing) this.mediaTriedAt.set(id, now);
    const epoch = this.epoch;
    const found = await Promise.all(
      missing.map(async (id) => {
        try {
          const meta = (await getDoc(this.refs.mediaMeta(id))).data();
          if (!meta) return null;
          const info: MediaInfo = { kind: meta.kind };
          if (meta.posterId) info.posterId = meta.posterId;
          if (typeof meta.durationS === 'number' && meta.durationS > 0) info.durationS = meta.durationS;
          if (meta.w > 0 && meta.h > 0) {
            info.w = meta.w;
            info.h = meta.h;
          }
          return [id, info] as const;
        } catch {
          return null;
        }
      }),
    );
    if (epoch !== this.epoch) return;
    const media = { ...this.m.media };
    for (const f of found) if (f) media[f[0]] = f[1];
    this.m.media = media;
    const unresolved = ids.filter((id) => !media[id]);
    this.health.warnings = unresolved.map((id) => `media ${id}: not found (the question will be shown without it)`);
    this.changed();
  }

  // ---------- Driver loop ----------

  private kick(): void {
    if (this.stopped) return;
    void this.pump();
  }

  private isLoaded(): boolean {
    return ['game', 'totals', 'lease', 'players', 'content'].every((k) => this.m.loaded.has(k));
  }

  private isLeader(now: ServerMs = this.now()): boolean {
    return leaseHeld(this.m.lease, this.session, now);
  }

  private input(): HostInput | null {
    const game = this.m.game;
    if (!this.g || !game) return null;
    const i = game.round?.i ?? null;
    return {
      gameId: this.g,
      game,
      totals: this.m.totals,
      players: this.m.players,
      answers: i !== null && this.m.answersRound === i ? this.m.answers : [],
    };
  }

  private content(): HostContent {
    return hostContent(this.m.content);
  }

  private async pump(): Promise<void> {
    if (this.busy || this.stopped || !this.g || !this.isLoaded()) return;
    this.busy = true;
    try {
      const inp = this.input();
      if (!inp) return;
      const content = this.content();
      const due = hostDeadline(inp, content);
      let now = this.now();

      if (this.opts.drive !== false && now >= this.leaseRetryAt) {
        const action = leaseAction(this.m.lease, { session: this.session, preferred: this.preferred }, now, due !== null);
        if (action !== 'none') {
          const r = await this.enqueue(() => maintainLease(this.ctx(inp.gameId), due !== null));
          if (r.error) {
            this.leaseRetryAt = this.now() + 2_000;
            this.error(`lease: ${r.error}`);
          } else if (r.lease && (!this.m.lease || r.lease.at >= this.m.lease.at || r.lease.session !== this.m.lease.session)) {
            this.m.lease = r.lease;
          }
          if (r.wrote && r.lease?.session === this.session && action !== 'renew') this.log(`lease ${action}d (${this.label})`);
        }
      }
      now = this.now();
      const leader = this.opts.drive !== false && this.isLeader(now);
      this.health.leader = leader;
      if (!leader) return;

      const waiting = (this.m.totals?.rev ?? -1) < this.minTotalsRev && Date.now() < this.minTotalsRevUntil;
      if (due !== null && due <= now && !waiting) {
        const round = inp.game.round;
        if (round && answersLive(inp.game, now)) await this.ensureAnswers(round.i);
        const r = await this.enqueue(() => runTick(this.ctx(inp.gameId)));
        this.health.lastTickAt = this.now();
        if (!r.ok || r.out?.changed) this.log(`tick ${inp.game.phase} → ${r.ok ? (r.out?.game.phase ?? '=') : r.error}`);
        this.afterTx(r, 'tick');
      } else if (!waiting) {
        const expect = { phaseRev: inp.game.phaseRev, round: inp.game.round?.i ?? null };
        const live = liveCounts(inp);
        const fresh = now - this.lastRefreshAt >= HOST_TIMING.refreshMs ? refreshedGame(inp, { content, media: this.m.media }) : null;
        if (fresh) {
          this.lastRefreshAt = now;
          this.lastCountsPushAt = now;
          const wrote = await this.enqueue(() => patchGame(this.ctx(inp.gameId), expect, { ...fresh, ...live }));
          if (wrote) this.health.lastWriteAt = this.now();
        } else if (countsPushDue(inp.game, live, this.lastCountsPushAt, now)) {
          this.lastCountsPushAt = now;
          const wrote = await this.enqueue(() => patchGame(this.ctx(inp.gameId), expect, live));
          if (wrote) this.health.lastWriteAt = this.now();
        }
      }
      this.schedule(hostDeadlineSafe(this.input(), content));
    } catch (e) {
      this.error(`driver: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.busy = false;
    }
  }

  private schedule(due: ServerMs | null): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (due === null || this.stopped) return;
    const ms = due - this.now();
    if (ms > HOST_TIMING.loopMs) return; // the loop interval will get there
    this.timer = setTimeout(() => this.kick(), Math.max(0, ms) + 5);
  }

  private afterTx(r: TxResult, what: string): void {
    if (r.ok) {
      if (r.out?.changed) {
        this.health.lastWriteAt = this.now();
        if (!r.out.newGame) {
          this.minTotalsRev = r.out.totals.rev;
          this.minTotalsRevUntil = Date.now() + 5_000;
        }
      }
    } else if (r.error !== 'stale' && r.error !== 'not_leader') {
      this.error(`${what}: ${r.error}`);
    }
  }

  // ---------- Plumbing ----------

  private ctx(g: string): HostCtx {
    return {
      db: this.db,
      refs: this.refs,
      gameId: g,
      session: this.session,
      uid: this.uid,
      label: this.label,
      preferred: this.preferred,
      now: () => this.now(),
      content: () => this.content(),
      media: () => this.m.media,
      players: () => this.m.players,
      answersFor: (i) => this.answersFor(i),
    };
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    this.health.pending++;
    const run = this.queue.catch(() => undefined).then(fn);
    this.queue = run.catch(() => undefined);
    void run.finally(() => {
      this.health.pending--;
    }).catch(() => undefined);
    return run;
  }

  private loadedOne(name: 'game' | 'totals' | 'lease' | 'players' | 'content', st: ListenerState): void {
    this.m.loaded.add(name);
    this.health.listeners[name] = st;
  }

  private changed(): void {
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      if (this.stopped) return;
      const snap = this.snapshot();
      for (const fn of this.subs) {
        try {
          fn(snap);
        } catch (e) {
          this.log(`subscriber failed: ${String(e)}`);
        }
      }
      this.kick();
    });
  }

  private async waitForClock(ms: number): Promise<void> {
    const t0 = Date.now();
    while (this.clock.get().syncedAt === null && Date.now() - t0 < ms && !this.stopped) await sleep(50);
  }

  private freshHealth(): HostHealth {
    return {
      listeners: Object.fromEntries(LISTENERS.map((k) => [k, 'loading'])) as HostHealth['listeners'],
      clock: { offsetMs: 0, rttMs: null, syncedAt: null },
      leader: false,
      lastTickAt: null,
      lastWriteAt: null,
      lastError: null,
      pending: 0,
      warnings: [],
    };
  }

  private error(msg: string): void {
    this.health.lastError = { at: this.now(), msg };
    this.log(msg);
  }

  private log(msg: string): void {
    this.opts.log?.(`[host ${this.label} ${this.session.slice(0, 4)}] ${msg}`);
  }
}

function hostDeadlineSafe(inp: HostInput | null, content: HostContent): ServerMs | null {
  return inp ? hostDeadline(inp, content) : null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
