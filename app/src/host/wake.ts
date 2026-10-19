// Wake-ups for the host's driver loop that keep their pace in a hidden tab (HostOptions.wake).
//
// The organizer ran a game with the admin page as the only host and its tab in the background:
// the page's timers slowed down (Chrome: at most once a minute after 5 min hidden; Safari and
// Firefox throttle too), the intro → open tick came ~20 s late and the guests never saw the
// options. A dedicated worker's timers are not throttled like that, and its messages wake the page.
// While the tab is visible the driver's own timers are exact, so the worker's ticks are ignored.

export function workerWake(everyMs = 500): ((fn: () => void) => () => void) | undefined {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof document === 'undefined') return undefined;
  return (fn) => {
    let worker: Worker | null = null;
    try {
      const url = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${Math.max(100, Math.round(everyMs))});`], { type: 'text/javascript' }));
      worker = new Worker(url);
      URL.revokeObjectURL(url);
      worker.onmessage = () => {
        if (document.visibilityState === 'hidden') fn();
      };
    } catch {
      worker = null; // blocked (CSP, private mode quirks): the page's own timers still run
    }
    return () => worker?.terminate();
  };
}
