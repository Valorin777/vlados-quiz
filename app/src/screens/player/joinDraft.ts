// What the guest typed and shot at the door, kept so nobody has to enter it twice:
//
// - the DRAFT (sessionStorage, this tab): the name, the step and — once taken — the selfie, until
//   the join is confirmed. A reload (the guest's own, iOS discarding the tab while the camera app
//   was open, the connection watchdog) comes back to the same step; a draft that was already sent
//   is sent again by itself (PlayerSession.join adopts the player if the first write had landed).
// - the PROFILE (localStorage, this device): name + selfie of the last confirmed join, offered
//   again on the next join form (a new game, another round of the party) — one tap instead of
//   typing and shooting again.
//
// Photos are stored as base64 JPEG (≤ 40 KB + 6 KB). Storage that is unavailable (private mode,
// blocked, full) just means nothing is remembered.

import { KEYS, isRecord, readJson, readString, remove, writeJson } from '../../fb/storage';
import type { SelfieResult } from './vx';

export interface StoredPhoto {
  kind: SelfieResult['kind'];
  /** base64 JPEG */
  avatar: string;
  thumb: string;
}

export interface JoinDraft {
  name: string;
  /** 'name': typing; 'selfie': the name is confirmed; 'sent': «Готово» was pressed. */
  step: 'name' | 'selfie' | 'sent';
  photo: StoredPhoto | null;
  /** Date.now() of the last change. */
  at: number;
}

export interface PlayerProfile {
  name: string;
  photo: StoredPhoto | null;
  at: number;
}

/** A draft older than this is a different evening: start clean. */
export const DRAFT_TTL_MS = 6 * 3_600_000;

const isPhoto = (v: unknown): v is StoredPhoto =>
  isRecord(v) && (v.kind === 'photo' || v.kind === 'generated') && typeof v.avatar === 'string' && typeof v.thumb === 'string' && v.avatar.length > 0 && v.thumb.length > 0;

export const isDraft = (v: unknown): v is JoinDraft =>
  isRecord(v) &&
  typeof v.name === 'string' &&
  (v.step === 'name' || v.step === 'selfie' || v.step === 'sent') &&
  (v.photo === null || isPhoto(v.photo)) &&
  typeof v.at === 'number';

const isProfile = (v: unknown): v is PlayerProfile =>
  isRecord(v) && typeof v.name === 'string' && v.name.length > 0 && (v.photo === null || isPhoto(v.photo)) && typeof v.at === 'number';

export function loadDraft(now = Date.now()): JoinDraft | null {
  const d = readJson('session', KEYS.joinDraft, isDraft);
  if (!d || now - d.at > DRAFT_TTL_MS || now < d.at - 60_000) return null;
  // 'selfie'/'sent' need a name; a sent draft without a name cannot be resent.
  if (d.step !== 'name' && !d.name.trim()) return null;
  return d;
}

export const saveDraft = (d: Omit<JoinDraft, 'at'>): void => writeJson('session', KEYS.joinDraft, { ...d, at: Date.now() });
export const clearDraft = (): void => remove('session', KEYS.joinDraft);

export function loadProfile(): PlayerProfile | null {
  const p = readJson('local', KEYS.playerProfile, isProfile);
  if (p) return p;
  const legacy = readString('local', KEYS.playerName);
  return legacy ? { name: legacy, photo: null, at: 0 } : null;
}

export function saveProfile(name: string, photo: StoredPhoto | null): void {
  writeJson('local', KEYS.playerProfile, { name, photo, at: Date.now() });
  // Without room for the photo, at least the name.
  if (!readJson('local', KEYS.playerProfile, isProfile)) writeJson('local', KEYS.playerProfile, { name, photo: null, at: Date.now() });
}

// ---------- JPEG ⇄ base64 ----------

export function bytesToBase64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

export async function photoOf(s: SelfieResult): Promise<StoredPhoto | null> {
  try {
    const [a, t] = await Promise.all([s.avatar.arrayBuffer(), s.thumb.arrayBuffer()]);
    return { kind: s.kind, avatar: bytesToBase64(new Uint8Array(a)), thumb: bytesToBase64(new Uint8Array(t)) };
  } catch {
    return null;
  }
}

/** A SelfieResult again (with a fresh object URL — the caller revokes it). */
export function selfieOf(p: StoredPhoto): SelfieResult | null {
  try {
    const avatar = new Blob([base64ToBytes(p.avatar)], { type: 'image/jpeg' });
    const thumb = new Blob([base64ToBytes(p.thumb)], { type: 'image/jpeg' });
    return { kind: p.kind, avatar, thumb, url: URL.createObjectURL(avatar) };
  } catch {
    return null;
  }
}
