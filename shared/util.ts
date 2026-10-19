import { customAlphabet, nanoid } from 'nanoid';
import type { Appearance, ColorMode } from './types';

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** URL-safe random id for players, questions, items, games. */
export const newId = (size = 12): string => nanoid(size);

/** Secret player / session token. */
export const newToken = (): string => nanoid(32);

const digits4 = customAlphabet('0123456789', 4);

/** 4-digit recovery code, avoiding codes already in use when possible. */
export function newCode(taken?: ReadonlySet<string>): string {
  for (let i = 0; i < 50; i++) {
    const c = digits4();
    if (!taken?.has(c)) return c;
  }
  return digits4();
}

// ---------- Names ----------

export const NAME_MAX = 20;

// Missing in browsers older than ~2024 Firefox; this module is in the player bundle, so a
// top-level `new Intl.Segmenter` would crash the whole page there.
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('ru', { granularity: 'grapheme' }) : null;

/** Length in user-perceived characters (an emoji with modifiers counts as one). */
export const graphemeLength = (s: string): number => {
  if (!segmenter) return [...s].length; // code points: close enough for a length cap
  let n = 0;
  for (const _ of segmenter.segment(s)) n++;
  return n;
};

// Control, surrogate, private-use and format characters (bidi overrides, zero-width spaces…),
// except ZWJ (U+200D) and tag characters that emoji sequences (families, subdivision flags) need.
const CONTROL_RE = /[\p{Cc}\p{Cs}\p{Co}]|(?![‍\u{E0020}-\u{E007F}])\p{Cf}/gu;

/**
 * Trim, strip control chars, collapse whitespace. Returns null unless the result is 1–20 graphemes.
 * Emoji-only names are allowed.
 */
export function normalizeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // Whitespace first so tabs/newlines become spaces instead of gluing words together.
  const s = raw.normalize('NFC').replace(/\s+/gu, ' ').replace(CONTROL_RE, '').replace(/ {2,}/g, ' ').trim();
  const len = graphemeLength(s);
  return len >= 1 && len <= NAME_MAX ? s : null;
}

/** Comparison key for name uniqueness and «Я уже играл»: case-, ё- and spacing-insensitive. */
export const nameKey = (name: string): string =>
  (normalizeName(name) ?? '').toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/ /g, '');

// ---------- Deterministic randomness ----------

/** FNV-1a 32-bit hash → unsigned int, used to derive seeds from strings. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Random unsigned 32-bit seed. */
export const randomSeed = (): number => Math.floor(Math.random() * 0x1_0000_0000);

/** mulberry32: small deterministic PRNG returning floats in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

/** Fisher–Yates on a copy. */
export function shuffle<T>(arr: readonly T[], rand: () => number = Math.random): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** Shuffle that never returns the original order (for ordering questions with ≥ 2 items). */
export function shuffleNotIdentity<T>(arr: readonly T[], rand: () => number = Math.random): T[] {
  if (arr.length < 2) return arr.slice();
  for (let i = 0; i < 20; i++) {
    const out = shuffle(arr, rand);
    if (out.some((v, k) => v !== arr[k])) return out;
  }
  // Astronomically unlikely fallback: rotate by one.
  return [...arr.slice(1), arr[0] as T];
}

// ---------- Appearance ----------

export const resolveAppearance = (a: Appearance, systemPrefersDark: boolean): ColorMode =>
  a === 'system' ? (systemPrefersDark ? 'dark' : 'light') : a;

export const isAppearance = (v: unknown): v is Appearance => v === 'system' || v === 'light' || v === 'dark';
