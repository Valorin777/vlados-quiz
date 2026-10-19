// WebAudio synth from the prototype: every sound is synthesized (no files to download).
// Nothing is created until `audio.unlock()` runs inside a user gesture (iOS/Safari rule);
// `audio.armOnFirstGesture()` does that automatically on the first tap/key.
// Master mute persists in localStorage `vlados.sound` ("on" | "off").

type Ctx = AudioContext;

const SOUND_KEY = 'vlados.sound';

function readMuted(fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(SOUND_KEY);
    return v === null ? fallback : v === 'off';
  } catch {
    return fallback;
  }
}

class Synth {
  private ctx: Ctx | null = null;
  private out!: GainNode;
  private wet!: GainNode;
  private dry!: GainNode;
  private droneGain: GainNode | null = null;
  private droneNodes: OscillatorNode[] = [];
  private muted: boolean;
  private lastPing = 0;
  private musicTimer: ReturnType<typeof setInterval> | null = null;
  private hurry = false;
  private nextBeat = 0;
  private step = 0;
  private listeners = new Set<() => void>();
  private armed = false;
  /** The organizer's mix (Settings.sound via setMix); defaults = everything on, full level. */
  private sfxOn = true;
  private musicOn = true;
  private level = 1;
  /** True while the music scheduler plays its notes (they are music, not effects). */
  private inMusic = false;
  /** The organizer's «стоп-экран»: total silence (context suspended, nothing new starts) until released. */
  private held = false;
  /** A video plays its own soundtrack (the video after the final): the game's sound is faded out. */
  private ducked = false;

  constructor() {
    this.muted = readMuted(false);
  }

  /** Default for devices that never chose (e.g. phones start muted, the TV starts audible). */
  setDefaultMuted(m: boolean): void {
    this.muted = readMuted(m);
    this.applyGain();
    this.emit();
  }

  /** True once the context exists and is running. */
  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running' && !this.held;
  }

  /** The «стоп-экран» silence is on (see hold()). */
  get isHeld(): boolean {
    return this.held;
  }

  /** The AudioContext's state ('none' before unlock) — for checks and tests. */
  get state(): AudioContextState | 'none' {
    return this.ctx?.state ?? 'none';
  }

  /**
   * «Стоп-экран»: total silence. The context is suspended — the lobby pad and every sound in flight
   * freeze where they are — and nothing new is scheduled (the music loop idles). It stays silent
   * whatever happens meanwhile: the tab hidden and shown again, a key press (unlock). Releasing
   * resumes the context (when the page is visible) with the organizer's mix and the device mute as
   * they are now. Idempotent.
   */
  hold(on: boolean): void {
    if (on === this.held) return;
    this.held = on;
    const c = this.ctx;
    if (c) {
      if (on) void c.suspend().catch(() => undefined);
      else if (!document.hidden) {
        this.nextBeat = c.currentTime + 0.05;
        void c.resume().then(() => this.emit(), () => undefined);
      }
    }
    this.applyGain();
    this.emit();
  }

  /**
   * A video with its own soundtrack takes over (the video after the final): the game's music stops
   * and everything the synth plays fades out over ~1 s and stays silent; released, the sound fades
   * back in (~1.5 s). The device mute and the «стоп-экран» still win. Idempotent.
   */
  duck(on: boolean): void {
    if (on === this.ducked) return;
    this.ducked = on;
    if (on) this.music(false);
    this.applyGain(on ? 0.3 : 0.5);
    this.emit();
  }

  get isDucked(): boolean {
    return this.ducked;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Audible right now (unlocked and not muted). */
  get on(): boolean {
    return this.ready && !this.muted;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Create/resume the context. Call from a click/tap/key handler. Returns false without WebAudio. */
  unlock(): boolean {
    if (typeof window === 'undefined') return false;
    if (!this.ctx) {
      const C =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!C) return false;
      let c: Ctx;
      try {
        c = new C({ latencyHint: 'interactive' });
      } catch {
        return false;
      }
      this.ctx = c;
      this.out = c.createGain();
      this.out.gain.value = 0;
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.ratio.value = 5;
      this.out.connect(comp);
      comp.connect(c.destination);
      const conv = c.createConvolver();
      conv.buffer = this.impulse(3.2);
      this.wet = c.createGain();
      this.wet.gain.value = 0.5;
      this.wet.connect(conv);
      conv.connect(this.out);
      this.dry = c.createGain();
      this.dry.connect(this.out);
      this.nextBeat = c.currentTime + 0.5;
      document.addEventListener('visibilitychange', () => {
        if (!this.ctx) return;
        if (document.hidden) void this.ctx.suspend();
        else if (!this.held) void this.ctx.resume();
      });
    }
    // A gesture is what unlocks the context (Safari): resume it even while held, then suspend again.
    const c = this.ctx;
    void c.resume().then(() => {
      if (this.held) void c.suspend().catch(() => undefined);
      this.emit();
    }, () => undefined);
    this.applyGain();
    this.emit();
    return true;
  }

  /**
   * The context back after the browser suspended it (a tab switch, Safari's interruption): resumed
   * when the page is visible and not held. Once unlocked by a gesture no new gesture is needed.
   */
  wake(): void {
    const c = this.ctx;
    if (!c || this.held || document.hidden || c.state === 'running' || c.state === 'closed') return;
    this.nextBeat = c.currentTime + 0.05;
    void c.resume().then(() => this.emit(), () => undefined);
  }

  /** Unlock on the first pointer/key gesture anywhere (idempotent). */
  armOnFirstGesture(): void {
    if (this.armed || typeof window === 'undefined') return;
    this.armed = true;
    const go = () => {
      this.unlock();
      removeEventListener('pointerdown', go, true);
      removeEventListener('keydown', go, true);
    };
    addEventListener('pointerdown', go, true);
    addEventListener('keydown', go, true);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    try {
      localStorage.setItem(SOUND_KEY, m ? 'off' : 'on');
    } catch {
      /* ignore */
    }
    if (!m) this.unlock();
    this.applyGain();
    this.emit();
  }

  toggleMuted(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /**
   * The organizer's sound settings (admin → Settings.sound, TV only): effects on/off, music
   * on/off, overall volume 0..1. The device mute (M key / setMuted) still wins.
   */
  setMix(mix: { sfx: boolean; music: boolean; volume: number }): void {
    const level = Number.isFinite(mix.volume) ? Math.min(1, Math.max(0, mix.volume)) : 1;
    if (mix.sfx === this.sfxOn && mix.music === this.musicOn && level === this.level) return;
    this.sfxOn = mix.sfx;
    this.musicOn = mix.music;
    this.level = level;
    if (!mix.music) {
      this.music(false);
      this.drone(false);
    }
    this.applyGain();
    this.emit();
  }

  private applyGain(tc = 0.25): void {
    const c = this.ctx;
    if (!c) return;
    this.out.gain.cancelScheduledValues(c.currentTime);
    this.out.gain.setTargetAtTime(this.muted || this.held || this.ducked ? 0 : 0.85 * this.level, c.currentTime, tc);
  }

  // ---------- plumbing ----------

  private impulse(sec: number): AudioBuffer {
    const c = this.ctx as Ctx;
    const n = Math.floor(c.sampleRate * sec);
    const b = c.createBuffer(2, n, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        lp += (Math.random() * 2 - 1 - lp) * 0.18;
        d[i] = lp * Math.pow(1 - i / n, 3);
      }
    }
    return b;
  }

  private env(g: GainNode, t: number, a: number, p: number, d: number): void {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(p, 0.0002), t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  private send(n: AudioNode, w: number): void {
    const c = this.ctx as Ctx;
    n.connect(this.dry);
    if (w) {
      const g = c.createGain();
      g.gain.value = w;
      n.connect(g);
      g.connect(this.wet);
    }
  }

  private noise(d: number): AudioBufferSourceNode {
    const c = this.ctx as Ctx;
    const b = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * d)), c.sampleRate);
    const x = b.getChannelData(0);
    for (let i = 0; i < x.length; i++) x[i] = Math.random() * 2 - 1;
    const s = c.createBufferSource();
    s.buffer = b;
    return s;
  }

  /** Only when audible: skip the node graph entirely otherwise (saves CPU on 90 phones). */
  private live(): Ctx | null {
    return this.on && (this.sfxOn || this.inMusic) ? this.ctx : null;
  }

  // ---------- voices ----------

  /** Low evolving pad (lobby ambience). */
  drone(on = true): void {
    const c = this.ctx;
    if (!c) return;
    if (!on) {
      if (this.droneGain) {
        const g = this.droneGain;
        const nodes = this.droneNodes;
        g.gain.setTargetAtTime(0.0001, c.currentTime, 0.4);
        for (const o of nodes) o.stop(c.currentTime + 2.5);
        setTimeout(() => g.disconnect(), 2600);
        this.droneGain = null;
        this.droneNodes = [];
      }
      return;
    }
    if (this.droneGain || !this.musicOn) return;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, c.currentTime);
    g.gain.setTargetAtTime(0.07, c.currentTime, 0.8);
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 170;
    f.Q.value = 7;
    const l = c.createOscillator();
    const lg = c.createGain();
    l.frequency.value = 0.06;
    lg.gain.value = 70;
    l.connect(lg);
    lg.connect(f.frequency);
    l.start();
    this.droneNodes = [l];
    [55, 55.35, 82.6].forEach((fr, i) => {
      const o = c.createOscillator();
      o.type = i === 2 ? 'triangle' : 'sawtooth';
      o.frequency.value = fr;
      o.connect(f);
      o.start();
      this.droneNodes.push(o);
    });
    f.connect(g);
    this.send(g, 0.5);
    this.droneGain = g;
  }

  /** Liquid droplet "plip". `p` pitch multiplier, `v` volume. */
  drop(p = 1, v = 0.4, when = 0): void {
    const c = this.live();
    if (!c) return;
    const t = c.currentTime + when;
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(560 * p, t);
    o.frequency.exponentialRampToValueAtTime(120 * p, t + 0.17);
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1100;
    f.Q.value = 5;
    const g = c.createGain();
    this.env(g, t, 0.006, v, 0.24);
    o.connect(f);
    f.connect(g);
    this.send(g, 0.35);
    o.start(t);
    o.stop(t + 0.35);
  }

  /** FM bell. */
  bell(fr: number, v = 0.15, d = 1.6, when = 0): void {
    const c = this.live();
    if (!c) return;
    const t = c.currentTime + Math.max(0, when);
    const o = c.createOscillator();
    const m = c.createOscillator();
    const mg = c.createGain();
    const g = c.createGain();
    o.frequency.value = fr;
    m.frequency.value = fr * 2.76;
    mg.gain.setValueAtTime(fr * 2.4, t);
    mg.gain.exponentialRampToValueAtTime(fr * 0.04, t + d);
    m.connect(mg);
    mg.connect(o.frequency);
    o.connect(g);
    this.env(g, t, 0.004, v, d);
    this.send(g, 0.7);
    o.start(t);
    m.start(t);
    o.stop(t + d + 0.1);
    m.stop(t + d + 0.1);
  }

  /** Clock tick (hurry seconds). */
  tick(v = 0.4, when = 0): void {
    const c = this.live();
    if (!c) return;
    const t = c.currentTime + Math.max(0, when);
    const o = c.createOscillator();
    o.frequency.setValueAtTime(96, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
    const g = c.createGain();
    this.env(g, t, 0.003, v, 0.16);
    o.connect(g);
    this.send(g, 0.2);
    o.start(t);
    o.stop(t + 0.25);
    const n = this.noise(0.03);
    const hp = c.createBiquadFilter();
    hp.type = 'bandpass';
    hp.frequency.value = 2400;
    hp.Q.value = 3;
    const ng = c.createGain();
    this.env(ng, t, 0.001, v * 0.35, 0.03);
    n.connect(hp);
    hp.connect(ng);
    this.send(ng, 0.1);
    n.start(t);
  }

  /** Wrong answer: a sagging, draining slide. */
  melt(v = 0.35): void {
    const c = this.live();
    if (!c) return;
    const t = c.currentTime;
    const n = this.noise(1.6);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 9;
    bp.frequency.setValueAtTime(1500, t);
    bp.frequency.exponentialRampToValueAtTime(160, t + 1.4);
    const g = c.createGain();
    this.env(g, t, 0.05, v, 1.4);
    n.connect(bp);
    bp.connect(g);
    this.send(g, 0.5);
    n.start(t);
    const o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(190, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 1.3);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    const og = c.createGain();
    this.env(og, t, 0.03, v * 0.5, 1.3);
    o.connect(lp);
    lp.connect(og);
    this.send(og, 0.4);
    o.start(t);
    o.stop(t + 1.5);
  }

  /** Correct answer: bright arpeggio + drop. */
  shine(): void {
    if (!this.on) return;
    [0, 7, 12, 16, 19].forEach((s, i) => this.bell(261.6 * Math.pow(2, s / 12), 0.09, 2.6, i * 0.045));
    this.drop(0.5, 0.5);
  }

  /** Filter sweep riser (before a reveal). */
  rise(d = 0.9): void {
    const c = this.live();
    if (!c) return;
    const t = c.currentTime;
    const o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(55, t);
    o.frequency.exponentialRampToValueAtTime(220, t + d);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(200, t);
    lp.frequency.exponentialRampToValueAtTime(1600, t + d);
    lp.Q.value = 8;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.2, t + d * 0.9);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.15);
    o.connect(lp);
    lp.connect(g);
    this.send(g, 0.5);
    o.start(t);
    o.stop(t + d + 0.2);
  }

  /** Champion: sub drop + shine + low bell. */
  boom(): void {
    const c = this.live();
    if (!c) return;
    const t = c.currentTime;
    const o = c.createOscillator();
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(28, t + 1.4);
    const g = c.createGain();
    this.env(g, t, 0.01, 0.7, 1.6);
    o.connect(g);
    this.send(g, 0.4);
    o.start(t);
    o.stop(t + 1.8);
    this.shine();
    this.bell(110, 0.16, 3.2);
  }

  /** Selfie capture. */
  shutter(): void {
    const c = this.live();
    if (!c) return;
    const t = c.currentTime;
    const n = this.noise(0.12);
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3000;
    const g = c.createGain();
    this.env(g, t, 0.002, 0.25, 0.1);
    n.connect(hp);
    hp.connect(g);
    this.send(g, 0.3);
    n.start(t);
    this.bell(880, 0.07, 0.7);
    this.drop(0.8, 0.3, 0.05);
  }

  // ---------- «Сюрприз»: the broadcast breaks down ----------

  /** A hard-clipped staircase: the bit-crusher of the breakdown's buzz. */
  private crusher(levels: number): WaveShaperNode {
    const c = this.ctx as Ctx;
    const ws = c.createWaveShaper();
    const n = 1024;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.round(Math.max(-1, Math.min(1, x * 2.2)) * levels) / levels;
    }
    ws.curve = curve;
    return ws;
  }

  /**
   * The TV's «сбой эфира» (~2.6 s, see screens/tv/surprise): a hitch click, a bit-crushed buzz that
   * stutters and grows, static bursts, a harsh static blast, then a pitch-dropping «power-down» and
   * the CRT's thunk — and silence. `fromS`: joined this far in (a late start plays the rest). The
   * game's music stops. Effects must be on (the device mute and the organizer's «Эффекты» win).
   */
  breakdown(fromS = 0, durS = 2.6, seed = 1): void {
    this.music(false);
    this.drone(false);
    const c = this.live();
    if (!c) return;
    const k = durS / 2.6;
    const t0 = c.currentTime - Math.max(0, fromS);
    const at = (s: number) => t0 + s * k;
    const alive = (s: number) => at(s) >= c.currentTime - 0.005;
    let r = seed >>> 0 || 1;
    const R = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 4294967296);
    const out = c.createGain();
    out.gain.value = 0.9;
    out.connect(this.dry);

    // the hitch: a dry digital click as the picture freezes
    if (alive(0)) {
      const n = this.noise(0.03);
      const hp = c.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2500;
      const g = c.createGain();
      this.env(g, at(0), 0.001, 0.5, 0.03);
      n.connect(hp);
      hp.connect(g);
      g.connect(out);
      n.start(at(0));
    }

    // the buzz: square + saw through a bit-crusher, gated in stutters, growing
    const endBuzz = at(2.02);
    if (endBuzz > c.currentTime) {
      const o1 = c.createOscillator();
      o1.type = 'square';
      o1.frequency.setValueAtTime(55, t0);
      const o2 = c.createOscillator();
      o2.type = 'sawtooth';
      o2.frequency.setValueAtTime(110.7, t0);
      o2.frequency.linearRampToValueAtTime(96, endBuzz);
      const crush = this.crusher(5);
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(700, t0);
      bp.frequency.exponentialRampToValueAtTime(1900, endBuzz);
      bp.Q.value = 0.9;
      const gate = c.createGain();
      gate.gain.setValueAtTime(0, t0);
      for (let s = 0.16; s < 2.0; ) {
        const on = 0.03 + R() * 0.09;
        const lvl = (0.06 + 0.3 * Math.pow(s / 2, 1.6)) * (0.6 + R() * 0.4);
        gate.gain.setValueAtTime(lvl, at(s));
        gate.gain.setValueAtTime(R() < 0.35 ? 0 : lvl * 0.35, at(s + on));
        s += on + 0.01 + R() * 0.05;
      }
      gate.gain.setValueAtTime(0, endBuzz);
      o1.connect(crush);
      o2.connect(crush);
      crush.connect(bp);
      bp.connect(gate);
      gate.connect(out);
      o1.start(Math.max(c.currentTime, t0));
      o2.start(Math.max(c.currentTime, t0));
      o1.stop(endBuzz + 0.05);
      o2.stop(endBuzz + 0.05);
    }

    // static: noise bursts, denser towards the blast
    const endStatic = at(2.12);
    if (endStatic > c.currentTime) {
      const n = this.noise(2.3 * k);
      const hp = c.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 900;
      const g = c.createGain();
      g.gain.setValueAtTime(0, t0);
      for (let s = 0.3; s < 1.8; ) {
        const len = 0.02 + R() * 0.07;
        g.gain.setValueAtTime(0.05 + 0.25 * (s / 1.8) * R(), at(s));
        g.gain.setValueAtTime(0, at(s + len));
        s += len + 0.04 + R() * 0.16 * (1 - s / 2);
      }
      // the blast: the picture shatters
      g.gain.setValueAtTime(0.42, at(1.82));
      g.gain.setValueAtTime(0.2, at(1.95));
      g.gain.linearRampToValueAtTime(0, endStatic);
      n.connect(hp);
      hp.connect(g);
      g.connect(out);
      n.start(Math.max(c.currentTime, t0), Math.max(0, c.currentTime - t0));
      n.stop(endStatic + 0.05);
    }

    // power-down: a falling saw whose filter closes
    const pd0 = at(1.94);
    const pd1 = at(2.52);
    if (pd1 > c.currentTime) {
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(240, pd0);
      o.frequency.exponentialRampToValueAtTime(24, pd1);
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(3200, pd0);
      lp.frequency.exponentialRampToValueAtTime(140, pd1);
      lp.Q.value = 6;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, pd0);
      g.gain.exponentialRampToValueAtTime(0.32, pd0 + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, pd1);
      o.connect(lp);
      lp.connect(g);
      g.connect(out);
      o.start(Math.max(c.currentTime, pd0));
      o.stop(pd1 + 0.05);
    }

    // the CRT goes off: a low thunk
    if (alive(2.15)) {
      const o = c.createOscillator();
      o.frequency.setValueAtTime(92, at(2.15));
      o.frequency.exponentialRampToValueAtTime(30, at(2.15) + 0.22);
      const g = c.createGain();
      this.env(g, at(2.15), 0.004, 0.55, 0.26);
      o.connect(g);
      g.connect(out);
      this.send(g, 0.25);
      o.start(at(2.15));
      o.stop(at(2.15) + 0.35);
    }
    setTimeout(() => out.disconnect(), Math.max(0, (at(2.8) - c.currentTime) * 1000));
  }

  /** A phone's short glitch (~0.8 s): a crushed buzz and a burst of static. */
  glitchBlip(): void {
    const c = this.live();
    if (!c) return;
    const t = c.currentTime;
    const o = c.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(82, t);
    const crush = this.crusher(4);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1100;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    for (const [s, v] of [[0, 0.2], [0.07, 0], [0.12, 0.25], [0.2, 0.05], [0.28, 0.3], [0.4, 0], [0.46, 0.22], [0.62, 0]] as const) g.gain.setValueAtTime(v, t + s);
    o.connect(crush);
    crush.connect(bp);
    bp.connect(g);
    this.send(g, 0);
    o.start(t);
    o.stop(t + 0.7);
    const n = this.noise(0.8);
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1500;
    const ng = c.createGain();
    this.env(ng, t + 0.05, 0.01, 0.2, 0.7);
    n.connect(hp);
    hp.connect(ng);
    this.send(ng, 0);
    n.start(t);
  }

  /** Soft rate-limited bell for bursts (joins, answers lighting up). */
  ping(p = 1): void {
    if (!this.on) return;
    const n = performance.now();
    if (n - this.lastPing < 70) return;
    this.lastPing = n;
    this.bell(392 * p, 0.045, 0.7);
  }

  // ---------- music ----------

  /** Start the question music loop (a sparse bell ostinato); `hurry` doubles tempo + ticks. */
  music(on: boolean, hurry = false): void {
    this.hurry = hurry;
    if (!on) {
      if (this.musicTimer) clearInterval(this.musicTimer);
      this.musicTimer = null;
      return;
    }
    if (this.musicTimer) return;
    this.step = 0;
    if (this.ctx) this.nextBeat = this.ctx.currentTime + 0.05;
    this.musicTimer = setInterval(() => this.schedule(), 50);
  }

  setHurry(h: boolean): void {
    this.hurry = h;
  }

  private schedule(): void {
    const c = this.ctx;
    if (!c || !this.on || !this.musicOn) return;
    const bt = this.hurry ? 0.36 : 0.72;
    if (this.nextBeat < c.currentTime - 0.3) this.nextBeat = c.currentTime + 0.05;
    while (this.nextBeat < c.currentTime + 0.12) {
      const sc = [146.8, 174.6, 220, 261.6, 293.7, 220, 196, 174.6];
      const f = (sc[(this.step * 3 + (this.step >> 2)) % sc.length] ?? 220) * (this.step % 8 === 0 ? 0.5 : 1);
      const when = this.nextBeat - c.currentTime;
      this.inMusic = true;
      try {
        if (this.step % 2 === 0 || this.hurry) this.bell(f, this.hurry ? 0.05 : 0.035, this.hurry ? 0.5 : 1.6, when);
        if (this.hurry) this.tick(0.35, when);
      } finally {
        this.inMusic = false;
      }
      this.step++;
      this.nextBeat += bt;
    }
  }
}

/** The one synth for the page. */
export const audio = new Synth();
