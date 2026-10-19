// Motion preferences, eases and a tiny deterministic RNG shared by the liquid engine and beats.

const rmQuery: MediaQueryList | null =
  typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

let forced: boolean | null = null;

/** True when the viewer asked for less motion (or the Lab forces it). Read it at call time. */
export function reducedMotion(): boolean {
  return forced ?? rmQuery?.matches ?? false;
}

/** Lab/testing override; `null` follows the OS setting again. */
export function forceReducedMotion(v: boolean | null): void {
  forced = v;
  for (const fn of rmListeners) fn(reducedMotion());
}

const rmListeners = new Set<(rm: boolean) => void>();
rmQuery?.addEventListener('change', () => {
  for (const fn of rmListeners) fn(reducedMotion());
});

export function onReducedMotion(fn: (rm: boolean) => void): () => void {
  rmListeners.add(fn);
  return () => rmListeners.delete(fn);
}

/** Overshooting "liquid" eases from the prototype, downgraded when motion is reduced. */
export const ease = {
  /** back-out: settles with one overshoot */
  get back(): string {
    return reducedMotion() ? 'power2.out' : 'back.out(1.7)';
  },
  /** elastic: wobbly liquid settle */
  get elastic(): string {
    return reducedMotion() ? 'power2.out' : 'elastic.out(1,0.55)';
  },
  get bounce(): string {
    return reducedMotion() ? 'power2.out' : 'bounce.out';
  },
};

/** Duration scaled down for reduced motion (never zero, so onComplete callbacks still run in order). */
export const dur = (s: number): number => (reducedMotion() ? Math.min(s, 0.5) * 0.6 : s);

export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const TAU = Math.PI * 2;

/** Park–Miller RNG; deterministic per seed so choreography is repeatable in the Lab. */
export function rng(seed = 26092026): () => number {
  let s = Math.max(1, Math.floor(Math.abs(seed)) % 2147483647);
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** Shared default stream for decorative randomness. */
export const rnd = rng();

export function backOut(x: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}
