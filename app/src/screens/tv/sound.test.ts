import { afterEach, describe, expect, it, vi } from 'vitest';
import { blessMedia, clearSoundBlock, onSoundBlocked, playVideo, soundBlocked, unblockSound, type MediaLike } from './sound';

const err = (name: string) => Object.assign(new Error(name), { name });

/**
 * A media element under Safari's rule: with sound it plays only once play() ran inside a gesture
 * (`gesture` true during the call); muted it always plays.
 */
function fakeVideo(opts: { blessed?: boolean; mutedToo?: boolean } = {}) {
  let blessed = opts.blessed ?? false;
  const v = {
    muted: false,
    paused: true,
    ended: false,
    isConnected: true,
    gesture: false,
    calls: [] as string[],
    play(): Promise<void> {
      this.calls.push(this.muted ? 'play-muted' : 'play');
      if (this.gesture) blessed = true;
      if ((!this.muted && !blessed) || (this.muted && opts.mutedToo && !blessed)) return Promise.reject(err('NotAllowedError'));
      this.paused = false;
      return Promise.resolve();
    },
    pause(): void {
      this.calls.push('pause');
      this.paused = true;
    },
  };
  return v satisfies MediaLike & { gesture: boolean };
}

afterEach(() => {
  clearSoundBlock();
  vi.restoreAllMocks();
});

describe('TV sound vs autoplay rules', () => {
  it('a blessed element plays with sound, no prompt', async () => {
    const v = fakeVideo({ blessed: true });
    expect(await playVideo(v, false)).toBe('sound');
    expect(v.muted).toBe(false);
    expect(soundBlocked()).toBe(false);
  });

  it('refused sound: plays muted AND raises the prompt (never silently muted)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const seen: boolean[] = [];
    const off = onSoundBlocked((b) => seen.push(b));
    const v = fakeVideo();
    expect(await playVideo(v, false)).toBe('muted');
    expect(v.muted).toBe(true);
    expect(v.paused).toBe(false);
    expect(soundBlocked()).toBe(true);
    expect(seen).toEqual([true]);
    // the click: unmuted, played inside the gesture, the prompt goes
    v.gesture = true;
    unblockSound(v, false);
    v.gesture = false;
    expect(v.muted).toBe(false);
    expect(v.paused).toBe(false);
    expect(soundBlocked()).toBe(false);
    // and the element keeps its sound for the next video
    v.pause();
    expect(await playVideo(v, false)).toBe('sound');
    off();
  });

  it('an interrupted play (AbortError) is not turned into muted playback', async () => {
    const v = fakeVideo({ blessed: true });
    v.play = () => Promise.reject(err('AbortError'));
    expect(await playVideo(v, false)).toBe('failed');
    expect(v.muted).toBe(false);
    expect(soundBlocked()).toBe(false);
  });

  it('refused even muted: the click starts it with sound', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const v = fakeVideo({ mutedToo: true });
    expect(await playVideo(v, false)).toBe('failed');
    expect(v.paused).toBe(true);
    expect(soundBlocked()).toBe(true);
    v.gesture = true;
    unblockSound(v, false);
    expect(v.paused).toBe(false);
    expect(v.muted).toBe(false);
  });

  it('blessing a paused element does not start it', () => {
    const v = fakeVideo();
    v.gesture = true;
    expect(blessMedia(v)).toBe(true);
    expect(v.calls).toEqual(['play', 'pause']);
    expect(v.paused).toBe(true);
    expect(v.muted).toBe(false);
  });

  it('a video that already ended is not started over by the click', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const v = fakeVideo();
    await playVideo(v, false);
    v.paused = true;
    v.ended = true;
    v.calls.length = 0;
    v.gesture = true;
    unblockSound(v, false);
    expect(v.calls).toEqual([]);
    expect(v.muted).toBe(false);
    expect(soundBlocked()).toBe(false);
  });

  it('the M key: muted playback needs no prompt', async () => {
    const v = fakeVideo();
    expect(await playVideo(v, true)).toBe('muted');
    expect(soundBlocked()).toBe(false);
  });
});
