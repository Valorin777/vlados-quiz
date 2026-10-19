// Offline unit tests for the Firebase data layer (no network). The rules themselves are tested
// against DEV in tests/rules.dev.test.ts (npm run test:rules).

import { FB_LIMITS, FB_PROJECTS, answerId, fbNameOk, isFbId, reactionBucket, reactionId } from '@shared/fbtypes';
import { normalizeName } from '@shared/util';
import { Bytes, Timestamp, serverTimestamp } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import { ServerClock } from './clock';
import { pickEnv } from './env';
import { joinChunks, splitChunks } from './media';
import { fromFirestoreValue, newAnswerDoc, newPlayerDoc, toFirestoreValue, tsFromMs } from './refs';

describe('env', () => {
  it('defaults to prod, ?env= wins and is remembered, remembered dev sticks', () => {
    expect(pickEnv('', null)).toEqual({ env: 'prod', remember: null });
    expect(pickEnv('?env=dev', null)).toEqual({ env: 'dev', remember: 'dev' });
    expect(pickEnv('?x=1', 'dev')).toEqual({ env: 'dev', remember: null });
    expect(pickEnv('?env=prod', 'dev')).toEqual({ env: 'prod', remember: 'prod' });
    expect(pickEnv('?env=staging', 'nonsense')).toEqual({ env: 'prod', remember: null });
  });

  it('project configs are the documented ones', () => {
    expect(FB_PROJECTS.prod.projectId).toBe('vlados-2609');
    expect(FB_PROJECTS.dev.projectId).toBe('vlados-2609-dev');
    expect(FB_PROJECTS.dev.authDomain).toBe('vlados-2609-dev.firebaseapp.com');
  });
});

describe('ids and names', () => {
  it('answer and reaction ids', () => {
    expect(answerId(3, 'abc')).toBe('3_abc');
    expect(reactionBucket(FB_LIMITS.reactionBucketMs * 1000 + FB_LIMITS.reactionBucketMs - 1)).toBe(1000);
    expect(reactionBucket(FB_LIMITS.reactionBucketMs * 1001)).toBe(1001);
    expect(reactionId('abc', 1000)).toBe('abc_1000');
    expect(isFbId('rulestest-1_x')).toBe(true);
    expect(isFbId('bad id')).toBe(false);
    expect(isFbId('x'.repeat(65))).toBe(false);
  });

  it('fbNameOk counts UTF-16 units like the rules; normalizeName counts graphemes', () => {
    expect(fbNameOk('Ж'.repeat(FB_LIMITS.nameMax))).toBe(true);
    expect(fbNameOk('Ж'.repeat(FB_LIMITS.nameMax + 1))).toBe(false);
    expect(fbNameOk('')).toBe(false);
    const party = '🎉'.repeat(FB_LIMITS.nameMax);
    expect(normalizeName(party)).toBe(party);
    expect(fbNameOk(party)).toBe(false);
  });
});

describe('converters', () => {
  it('wire → app: Timestamp → ms and Bytes → Uint8Array, deeply', () => {
    const wire = {
      at: Timestamp.fromMillis(1_790_000_000_123),
      avatar: Bytes.fromUint8Array(new Uint8Array([1, 2, 3])),
      final: { podium: [{ uid: 'u', thumb: Bytes.fromUint8Array(new Uint8Array([9])) }] },
      n: 5,
      s: 'x',
      nil: null,
    };
    const app = fromFirestoreValue(wire) as Record<string, unknown>;
    expect(app.at).toBe(1_790_000_000_123);
    expect(app.avatar).toEqual(new Uint8Array([1, 2, 3]));
    expect(app.final).toEqual({ podium: [{ uid: 'u', thumb: new Uint8Array([9]) }] });
    expect(app.n).toBe(5);
    expect(app.nil).toBeNull();
  });

  it('app → wire: Uint8Array → Bytes (views included), sentinels untouched', () => {
    const buf = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const ts = serverTimestamp();
    const wire = toFirestoreValue({ d: buf.subarray(2, 5), at: ts, list: [new Uint8Array([7])] }) as Record<string, unknown>;
    expect(wire.d).toBeInstanceOf(Bytes);
    expect((wire.d as Bytes).toUint8Array()).toEqual(new Uint8Array([2, 3, 4]));
    expect(wire.at).toBe(ts);
    expect(((wire.list as unknown[])[0] as Bytes).toUint8Array()).toEqual(new Uint8Array([7]));
  });

  it('write builders pin server time and never set kicked', () => {
    const p = newPlayerDoc({ name: 'Вася', seed: 7 });
    expect(p.kicked).toBe(false);
    expect(p).not.toHaveProperty('avatar');
    expect(p.joinedAt).toEqual(serverTimestamp());
    const a = newAnswerDoc('u1', 2, { t: 'number', v: 42 });
    expect(a).toMatchObject({ uid: 'u1', round: 2, p: { t: 'number', v: 42 } });
    expect(tsFromMs(1500).toMillis()).toBe(1500);
  });
});

describe('media chunks', () => {
  it('splits at the chunk limit and joins back', () => {
    const size = FB_LIMITS.chunkMaxBytes * 2 + 10;
    const bytes = new Uint8Array(size).map((_, i) => i & 0xff);
    const parts = splitChunks(bytes);
    expect(parts.map((p) => p.length)).toEqual([FB_LIMITS.chunkMaxBytes, FB_LIMITS.chunkMaxBytes, 10]);
    expect(joinChunks(parts)).toEqual(bytes);
    expect(splitChunks(new Uint8Array(0))).toEqual([]);
    expect(splitChunks(new Uint8Array(5), 2).map((p) => p.length)).toEqual([2, 2, 1]);
  });
});

describe('server clock', () => {
  it('uses the midpoint of the write round trip and prefers faster samples', () => {
    const c = new ServerClock();
    // Server stamped 10_500 while the client wrote at t0=1_000 with a 200 ms round trip → offset 9_400.
    expect(c.offer({ serverMs: 10_500, t0: 1_000, rttMs: 200 }, 0)).toBe(true);
    expect(c.get().offsetMs).toBe(9_400);
    // Slower sample that agrees within the error bars: ignored.
    expect(c.offer({ serverMs: 20_600, t0: 11_000, rttMs: 600 }, 1_000)).toBe(false);
    expect(c.get().rttMs).toBe(200);
    // Faster sample: taken.
    expect(c.offer({ serverMs: 30_450, t0: 21_000, rttMs: 100 }, 2_000)).toBe(true);
    expect(c.get().offsetMs).toBe(9_400);
    // Device clock jumped by a minute: taken even though slower.
    expect(c.offer({ serverMs: 40_500, t0: -30_000, rttMs: 300 }, 3_000)).toBe(true);
    expect(c.get().offsetMs).toBe(70_350);
  });

  it('rejects absurd samples and refreshes stale ones', () => {
    const c = new ServerClock();
    expect(c.offer({ serverMs: 5, t0: 0, rttMs: 20_000 }, 0)).toBe(false);
    expect(c.offer({ serverMs: Number.NaN, t0: 0, rttMs: 10 }, 0)).toBe(false);
    expect(c.offer({ serverMs: 1_050, t0: 1_000, rttMs: 100 }, 0)).toBe(true);
    expect(c.offer({ serverMs: 1_200, t0: 1_000, rttMs: 400 }, 11 * 60_000)).toBe(true);
    expect(c.get().offsetMs).toBe(0);
  });

  it('measure() survives a failing probe', async () => {
    const c = new ServerClock();
    expect(await c.measure(() => Promise.reject(new Error('offline')), 2)).toBe(false);
    let n = 0;
    const probe = () => (++n === 2 ? Promise.reject(new Error('blip')) : Promise.resolve({ serverMs: 5_000, t0: 1_000, rttMs: 50 }));
    expect(await c.measure(probe, 3)).toBe(true);
    expect(c.get().offsetMs).toBe(3_975);
  });
});
