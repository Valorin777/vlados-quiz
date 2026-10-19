import { useSyncExternalStore } from 'react';

/** Live CSS media query (read on every render too, so it is never stale). */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = matchMedia(query);
      m.addEventListener('change', cb);
      addEventListener('resize', cb);
      return () => {
        m.removeEventListener('change', cb);
        removeEventListener('resize', cb);
      };
    },
    () => matchMedia(query).matches,
    () => false,
  );
}

export const PHONE_QUERY = '(max-width: 899px)';
