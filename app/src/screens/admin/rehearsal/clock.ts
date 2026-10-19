// The rehearsal's virtual clock: server-ms time that runs at ×1/×2/×4, pauses, and jumps. It can
// also be held for a moment while it plays (the TV waits for its video to load, like live).

export class VirtualClock {
  private base: number;
  private anchor = performance.now();
  private rate_ = 1;
  private playing_ = false;
  private held = false;
  /** The show's end: the clock stops there. */
  end = Number.POSITIVE_INFINITY;

  constructor(start: number) {
    this.base = start;
  }

  /** Stable function (TvShow / phone actions keep a reference). */
  readonly now = (): number => {
    const t = this.playing_ && !this.held ? this.base + (performance.now() - this.anchor) * this.rate_ : this.base;
    return Math.min(t, this.end);
  };

  get playing(): boolean {
    return this.playing_;
  }

  /** Playing, but held (waiting for the TV's video). */
  get holding(): boolean {
    return this.playing_ && this.held;
  }

  get rate(): number {
    return this.rate_;
  }

  set(t: number): void {
    this.base = Math.min(t, this.end);
    this.anchor = performance.now();
  }

  play(): void {
    if (this.playing_) return;
    this.set(this.now());
    this.playing_ = true;
  }

  pause(): void {
    if (!this.playing_) return;
    this.set(this.now());
    this.playing_ = false;
  }

  /** Stops the time without leaving «play» (true), then lets it run on from there (false). */
  hold(on: boolean): void {
    if (on === this.held) return;
    this.set(this.now());
    this.held = on;
  }

  setRate(r: number): void {
    const t = this.now();
    this.rate_ = r;
    this.set(t);
  }
}
