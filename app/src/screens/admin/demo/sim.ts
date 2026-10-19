// «Репетиция» (DEV only): the whole panel on an in-memory game. The simulator runs the SAME pure
// host step() and view builders as the real Host, with a few bot guests who answer by themselves,
// so every button of «Эфир» behaves exactly like on the night — and nothing touches Firestore.

import { seedContent } from '@shared/defaults';
import type { AdminContentDoc, AnswerDoc, GameDoc, MediaMetaDoc, PlayerDoc } from '@shared/fbtypes';
import { correctOrder } from '@shared/scoring';
import type { AnswerPayload, Question } from '@shared/types';
import { newId, randomSeed, shuffle } from '@shared/util';
import type { EngineEvent } from '@shared/engine/reduce';
import {
  buildAdminView,
  emptyTotals,
  hostContent,
  hostDeadline,
  initialGameDoc,
  liveCounts,
  refreshedGame,
  step,
  type AdminView,
  type CmdResult,
  type HostCommand,
  type HostSnapshot,
  type MediaIndex,
  type TotalsDoc,
} from '../../../host';
import { checkedName, hostEvent, stripUndefined } from '../../../host/pure';
import type { AdminBackend, HostLike } from '../core/backend';

const BOT_NAMES = ['Аня', 'Кирилл', 'Маша 🌸', 'Дима', 'Лёша', 'Соня', 'Паша', 'Катя', 'Ваня', 'Лиза', 'Артём', 'Оля'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SimHost implements HostLike {
  readonly session = 'rehearsal';
  gameId = 'rehearsal';
  private game: GameDoc;
  private totals: TotalsDoc;
  private players: Record<string, PlayerDoc> = {};
  private answers: AnswerDoc[] = [];
  private content: AdminContentDoc | null;
  private media: Record<string, MediaIndex[string]> = {};
  private subs = new Set<(s: HostSnapshot) => void>();
  private loop: ReturnType<typeof setInterval> | null = null;
  private plan = new Map<string, number>();
  private lastTickAt: number | null = null;
  private lastWriteAt: number | null = null;

  constructor(content: AdminContentDoc | null) {
    this.content = content;
    const now = Date.now();
    this.game = initialGameDoc(hostContent(content).settings);
    this.totals = emptyTotals(now);
  }

  /** Runs the timed transitions and the bots (4× a second). */
  start(): void {
    this.loop ??= setInterval(() => this.tick(), 250);
  }

  stop(): void {
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
  }

  now(): number {
    return Date.now();
  }

  subscribe(fn: (s: HostSnapshot) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  private emit(): void {
    const s = this.snapshot();
    for (const f of this.subs) f(s);
  }

  snapshot(): HostSnapshot {
    const now = this.now();
    const i = this.game.round?.i ?? null;
    return {
      gameId: this.gameId,
      game: this.game,
      totals: this.totals,
      players: this.players,
      answers: i === null ? [] : this.answers.filter((a) => a.round === i),
      answersRound: i,
      content: this.content,
      media: this.media,
      lease: { session: this.session, until: now + 30_000, label: 'tv', preferred: true, uid: 'rehearsal', at: now },
      reactions: [],
      session: this.session,
      label: 'rehearsal',
      health: {
        listeners: { game: 'live', totals: 'live', lease: 'live', players: 'live', answers: 'live', content: 'live', reactions: 'live' },
        clock: { offsetMs: 0, rttMs: 16, syncedAt: now },
        leader: true,
        lastTickAt: this.lastTickAt,
        lastWriteAt: this.lastWriteAt,
        lastError: null,
        pending: 0,
        warnings: [],
      },
    };
  }

  adminView(now: number = this.now()): AdminView {
    return buildAdminView(this.snapshot(), now);
  }

  private input() {
    const i = this.game.round?.i;
    return { gameId: this.gameId, game: this.game, totals: this.totals, players: this.players, answers: this.answers.filter((a) => a.round === i) };
  }

  private apply(ev: EngineEvent, newGameId?: string): CmdResult {
    const now = this.now();
    const out = step(this.input(), ev, now, {
      content: hostContent(this.content),
      players: this.players,
      media: this.media,
      ...(newGameId ? { newGameId } : {}),
    });
    if (!out.ok) return { ok: false, error: out.error ?? 'invalid' };
    if (out.changed) {
      if (out.newGame) {
        this.gameId = out.gameId;
        this.players = {};
        this.answers = [];
      }
      this.game = stripUndefined(out.game);
      this.totals = stripUndefined(out.totals);
      for (const k of out.kicked) {
        const p = this.players[k.uid];
        if (p) this.players[k.uid] = { ...p, kicked: k.kicked };
      }
      this.lastWriteAt = now;
      this.emit();
    }
    return { ok: true, phaseRev: this.game.phaseRev, ...(out.newGame ? { gameId: out.gameId } : {}) };
  }

  async command(cmd: HostCommand): Promise<CmdResult> {
    await sleep(140); // a transaction round trip, roughly
    if ('phaseRev' in cmd && cmd.phaseRev < this.game.phaseRev) return { ok: false, error: 'stale' };
    if (cmd.type === 'rename') {
      const name = checkedName(cmd.name);
      const p = this.players[cmd.uid];
      if (!name || !p) return { ok: false, error: 'invalid' };
      this.players = { ...this.players, [cmd.uid]: { ...p, name } };
      this.emit();
      return { ok: true, phaseRev: this.game.phaseRev };
    }
    // (watchEnd / surpriseEnd are engine events of their own, not admin commands)
    const ev = hostEvent(cmd, this.totals);
    if (!ev) return { ok: false, error: 'invalid' };
    return this.apply(ev.t === 'cmd' ? { ...ev, by: 'rehearsal' } : ev, cmd.type === 'newGame' ? newId(10) : undefined);
  }

  // ---------- content & media (what the in-memory backend writes) ----------

  setContent(doc: AdminContentDoc): void {
    this.content = structuredClone(doc);
    this.emit();
  }

  addMedia(id: string, meta: MediaMetaDoc): void {
    this.media = {
      ...this.media,
      [id]: {
        kind: meta.kind,
        ...(meta.posterId ? { posterId: meta.posterId } : {}),
        ...(typeof meta.durationS === 'number' && meta.durationS > 0 ? { durationS: meta.durationS } : {}),
        ...(meta.w > 0 && meta.h > 0 ? { w: meta.w, h: meta.h } : {}),
      },
    };
  }

  // ---------- bots ----------

  addBots(n: number): void {
    const now = this.now();
    const taken = new Set(Object.values(this.players).map((p) => p.name));
    const names = BOT_NAMES.filter((x) => !taken.has(x)).slice(0, n);
    names.forEach((name, k) => {
      this.players = { ...this.players, [`bot-${newId(8)}`]: { name, seed: randomSeed(), joinedAt: now + k, kicked: false, seenAt: now } };
    });
    this.emit();
  }

  private botAnswer(q: Question | undefined, round: NonNullable<GameDoc['round']>): AnswerPayload {
    const lucky = Math.random() < 0.55;
    if (round.type === 'choice') {
      const ids = (round.options ?? []).map((o) => o.id);
      const right = q?.type === 'choice' ? q.correctId : undefined;
      return { t: 'choice', id: lucky && right && ids.includes(right) ? right : (ids[Math.floor(Math.random() * ids.length)] ?? '') };
    }
    if (round.type === 'number') {
      const n = q?.type === 'number' ? q : null;
      const base = n ? n.answer : ((round.number?.min ?? 0) + (round.number?.max ?? 100)) / 2;
      const spread = n ? Math.max(n.zeroAt, n.step) * (lucky ? 0.3 : 1.2) : 20;
      const step = round.number?.step ?? 1;
      let v = Math.round((base + (Math.random() * 2 - 1) * spread) / step) * step;
      if (round.number?.min !== undefined) v = Math.max(round.number.min, v);
      if (round.number?.max !== undefined) v = Math.min(round.number.max, v);
      return { t: 'number', v: Math.round(v * 1e6) / 1e6 };
    }
    const correct = q?.type === 'ordering' ? correctOrder(q) : (round.items ?? []).map((it) => it.id);
    return { t: 'ordering', ids: lucky ? correct : shuffle(correct) };
  }

  private tickBots(now: number): void {
    const r = this.game.round;
    if (!r || this.game.phase !== 'open' || this.game.pause) return;
    const q = this.content?.questions.find((x) => x.id === r.qid);
    for (const [uid, p] of Object.entries(this.players)) {
      if (!uid.startsWith('bot-') || p.kicked) continue;
      const key = `${r.i}:${uid}`;
      if (this.answers.some((a) => a.round === r.i && a.uid === uid)) continue;
      let at = this.plan.get(key);
      if (at === undefined) {
        const T = Math.max(1, r.endsAt - r.openAt);
        // ~1 in 8 bots dozes off and never answers
        at = Math.random() < 0.12 ? Infinity : r.openAt + 1200 + Math.random() * T * 0.7;
        this.plan.set(key, at);
      }
      if (now >= at && now <= r.endsAt) this.answers = [...this.answers, { uid, round: r.i, p: this.botAnswer(q, r), at: now }];
    }
  }

  private tick(): void {
    const now = this.now();
    this.tickBots(now);
    const content = hostContent(this.content);
    const due = hostDeadline(this.input(), content);
    if (due !== null && due <= now) {
      this.lastTickAt = now;
      this.apply({ t: 'tick' });
    }
    const live = liveCounts(this.input());
    const refreshed = refreshedGame(this.input(), { content, media: this.media });
    if (live.answered !== this.game.answered || live.players !== this.game.players || refreshed) {
      this.game = { ...this.game, answered: live.answered, players: live.players, ...(refreshed ? stripUndefined(refreshed) : {}) };
      this.emit();
    } else if (this.game.phase === 'open' || this.game.phase === 'intro') {
      this.emit();
    }
  }
}

/** Files live in memory as Blobs for the rehearsal. */
export function rehearsalBackend(sim: SimHost, onSignOut: () => void): AdminBackend {
  const files = new Map<string, { blob: Blob; meta: MediaMetaDoc; url?: string }>();
  let admins: string[] = ['soveduschiy@example.com'];
  return {
    demo: true,
    media: {
      upload: async (input) => {
        const id = newId(16);
        // pretend to upload: ~0.5 s for the progress bar
        const chunks = Math.max(1, Math.ceil(input.blob.size / 900_000));
        for (let k = 0; k < chunks; k++) {
          await sleep(120);
          input.onProgress?.(k + 1, chunks);
        }
        const meta: MediaMetaDoc = {
          kind: input.kind,
          mime: input.blob.type || (input.kind === 'image' ? 'image/jpeg' : 'video/mp4'),
          w: Math.round(input.w),
          h: Math.round(input.h),
          bytes: input.blob.size,
          chunks,
          createdAt: Date.now(),
          ...(input.durationS !== undefined ? { durationS: input.durationS } : {}),
          ...(input.posterId ? { posterId: input.posterId } : {}),
        };
        files.set(id, { blob: input.blob, meta });
        sim.addMedia(id, meta);
        return { id, meta };
      },
      url: async (id) => {
        const f = files.get(id);
        if (!f) throw new Error('not found');
        f.url ??= URL.createObjectURL(f.blob);
        return f.url;
      },
      meta: async (id) => files.get(id)?.meta ?? null,
    },
    writeContent: async (doc) => {
      await sleep(250);
      sim.setContent(doc);
    },
    seed: async (withTemplates) => {
      const { rev, settings, questions, trash } = seedContent();
      sim.setContent({ rev, settings, questions: withTemplates ? questions : [], trash, updatedAt: Date.now() });
      return 'created';
    },
    getAdmins: async () => admins,
    setAdmins: async (emails) => {
      await sleep(200);
      admins = emails;
    },
    signOut: async () => onSignOut(),
  };
}
