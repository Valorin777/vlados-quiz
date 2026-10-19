// admin/content editing with autosave (docs/firebase.md → admin/content).
//
// The Host already listens to admin/content (it needs the questions to run the game), so the
// editor reads the same snapshot instead of opening a second listener. Local edits live in a
// draft that is written back (one setDoc of the whole doc) after a short pause in typing; while a
// save is pending or running, remote snapshots do not overwrite the draft.

import type { AdminContentDoc } from '@shared/fbtypes';
import type { Question, Settings } from '@shared/types';
import { useSyncExternalStore } from 'react';
import { normalizeSettings } from '../../../host/pure';
import type { HostLike } from './backend';

export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export interface ContentSnap {
  /** loading: waiting for the first snapshot · missing: admin/content does not exist yet */
  status: 'loading' | 'missing' | 'ready';
  doc: AdminContentDoc | null;
  save: SaveState;
  savedAt: number | null;
  error: string | null;
}

/** How many deleted questions the trash keeps (oldest fall out). */
export const TRASH_KEEP = 40;
const SAVE_DELAY_MS = 650;
const RETRY_MS = 4_000;

export class ContentStore {
  private snap: ContentSnap = { status: 'loading', doc: null, save: 'idle', savedAt: null, error: null };
  private subs = new Set<() => void>();
  private remote: AdminContentDoc | null | undefined = undefined;
  private dirty = false;
  private saving: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsub: (() => void) | null = null;
  private onHide = () => {
    if (document.visibilityState === 'hidden') void this.flush();
  };

  constructor(
    private readonly host: HostLike,
    private readonly write: (doc: AdminContentDoc) => Promise<void>,
  ) {}

  attach(): void {
    this.unsub = this.host.subscribe(() => this.onHost());
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onHide);
    this.onHost();
  }

  detach(): void {
    this.unsub?.();
    this.unsub = null;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onHide);
    void this.flush();
  }

  get = (): ContentSnap => this.snap;

  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  };

  private set(p: Partial<ContentSnap>): void {
    this.snap = { ...this.snap, ...p };
    for (const f of this.subs) f();
  }

  private onHost(): void {
    const s = this.host.snapshot();
    const state = s.health.listeners.content;
    if (state === 'loading' || state === 'error') return;
    // «Не существует» only counts when the server said so: an offline start sees an empty cache.
    if (!s.content && state !== 'live') return;
    if (s.content === this.remote && this.snap.status !== 'loading') return;
    this.remote = s.content;
    if (this.dirty || this.saving) return;
    this.set({ status: s.content ? 'ready' : 'missing', doc: s.content });
  }

  /** The current draft's settings (defaults merged). */
  settings(): Settings {
    return normalizeSettings(this.snap.doc?.settings);
  }

  /** Apply a change to a copy of the draft and schedule a save. */
  edit(fn: (d: AdminContentDoc) => void, delayMs = SAVE_DELAY_MS): void {
    const cur = this.snap.doc;
    if (!cur) return;
    const d = structuredClone(cur);
    fn(d);
    d.settings = normalizeSettings(d.settings);
    this.dirty = true;
    this.set({ doc: d, save: 'pending', error: null });
    this.schedule(delayMs);
  }

  updateQuestion(id: string, fn: (q: Question) => Question | void, delayMs?: number): void {
    this.edit((d) => {
      const i = d.questions.findIndex((q) => q.id === id);
      const q = d.questions[i];
      if (i < 0 || !q) return;
      const next = fn(q);
      if (next) d.questions[i] = next;
    }, delayMs);
  }

  updateSettings(fn: (s: Settings) => void, delayMs?: number): void {
    this.edit((d) => fn(d.settings), delayMs);
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save();
    }, ms);
  }

  /** Save now (and wait for it). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.saving) await this.saving;
    if (this.dirty) await this.save();
  }

  private async save(): Promise<void> {
    if (this.saving) {
      await this.saving;
      if (!this.dirty) return;
    }
    const cur = this.snap.doc;
    if (!cur || !this.dirty) return;
    this.dirty = false;
    const next: AdminContentDoc = { ...cur, rev: (cur.rev ?? 0) + 1, updatedAt: Date.now() };
    // Keep the bumped rev locally (later edits build on it) without marking the draft dirty.
    this.snap = { ...this.snap, doc: next };
    this.set({ save: 'saving' });
    const run = (async () => {
      try {
        await this.write({ rev: next.rev, settings: next.settings, questions: next.questions, trash: next.trash.slice(-TRASH_KEEP), updatedAt: next.updatedAt ?? Date.now() });
        this.set({ save: this.dirty ? 'pending' : 'saved', savedAt: Date.now(), error: null });
      } catch (e) {
        this.dirty = true;
        this.set({ save: 'error', error: e instanceof Error ? e.message : String(e) });
        this.schedule(RETRY_MS);
      }
    })();
    this.saving = run;
    try {
      await run;
    } finally {
      this.saving = null;
    }
    if (this.dirty && !this.timer) this.schedule(SAVE_DELAY_MS);
    // A snapshot that arrived while saving was held back: apply it now if nothing is pending.
    if (!this.dirty) this.onHost();
  }

  /** Waits until the Host's own listener has seen at least this rev (commands read the Host's content). */
  async hostCaughtUp(rev: number, timeoutMs = 6_000): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if ((this.host.snapshot().content?.rev ?? -1) >= rev) return true;
      await new Promise((r) => setTimeout(r, 120));
    }
    return false;
  }
}

export function useContent(store: ContentStore): ContentSnap {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
