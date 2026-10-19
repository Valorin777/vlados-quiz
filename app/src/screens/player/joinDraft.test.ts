// The join form's draft (sessionStorage) and the device profile (localStorage) round-trip, expire
// and survive broken storage — what keeps a reload from asking for the name and selfie again.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DRAFT_TTL_MS, base64ToBytes, bytesToBase64, clearDraft, loadDraft, loadProfile, photoOf, saveDraft, saveProfile, selfieOf } from './joinDraft';

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

const g = globalThis as unknown as { window?: unknown };
beforeEach(() => {
  g.window = { localStorage: memStorage(), sessionStorage: memStorage() };
});
afterEach(() => {
  delete g.window;
});

const jpeg = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);

describe('join draft', () => {
  it('round-trips the step, the name and the photo; clears', async () => {
    expect(loadDraft()).toBeNull();
    const selfie = { kind: 'photo' as const, avatar: new Blob([jpeg(30_000)], { type: 'image/jpeg' }), thumb: new Blob([jpeg(4_000, 2)], { type: 'image/jpeg' }), url: 'blob:x' };
    const photo = await photoOf(selfie);
    expect(photo).not.toBeNull();
    saveDraft({ name: 'Валера', step: 'sent', photo });
    const d = loadDraft();
    expect(d).toMatchObject({ name: 'Валера', step: 'sent' });
    const back = selfieOf(d!.photo!);
    expect(back?.kind).toBe('photo');
    expect(new Uint8Array(await back!.avatar.arrayBuffer())).toEqual(jpeg(30_000));
    expect(new Uint8Array(await back!.thumb.arrayBuffer())).toEqual(jpeg(4_000, 2));
    if (back) URL.revokeObjectURL(back.url);
    clearDraft();
    expect(loadDraft()).toBeNull();
  });

  it('expires, and a sent draft needs a name', () => {
    saveDraft({ name: 'Валера', step: 'name', photo: null });
    expect(loadDraft(Date.now() + DRAFT_TTL_MS + 1)).toBeNull();
    saveDraft({ name: '  ', step: 'sent', photo: null });
    expect(loadDraft()).toBeNull();
  });

  it('ignores junk and works without storage', () => {
    (g.window as { sessionStorage: Storage }).sessionStorage.setItem('vlados.join.draft', '{"name":1}');
    expect(loadDraft()).toBeNull();
    delete g.window;
    saveDraft({ name: 'x', step: 'name', photo: null });
    expect(loadDraft()).toBeNull();
    expect(loadProfile()).toBeNull();
  });
});

describe('player profile', () => {
  it('remembers name + selfie; falls back to the legacy name key', () => {
    (g.window as { localStorage: Storage }).localStorage.setItem('vlados.player.name', 'Старое');
    expect(loadProfile()).toMatchObject({ name: 'Старое', photo: null });
    saveProfile('Валера', { kind: 'photo', avatar: bytesToBase64(jpeg(100)), thumb: bytesToBase64(jpeg(10)) });
    const p = loadProfile();
    expect(p?.name).toBe('Валера');
    expect(base64ToBytes(p!.photo!.avatar)).toEqual(jpeg(100));
  });

  it('base64 survives large arrays', () => {
    const big = jpeg(70_000, 5);
    expect(base64ToBytes(bytesToBase64(big))).toEqual(big);
  });
});
