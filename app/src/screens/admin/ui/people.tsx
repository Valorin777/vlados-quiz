import type { TvPlayer } from '../../../host';
import { Avatar } from '../../../visual';
import { useBytesUrl } from '../core/media';

/** A guest's selfie thumb (or the engraved initial). */
export function PlayerAvatar({ p, size = 32, big = false }: { p: Pick<TvPlayer, 'name' | 'thumb' | 'avatar'>; size?: number; big?: boolean }) {
  const src = useBytesUrl(big ? (p.avatar ?? p.thumb) : (p.thumb ?? p.avatar));
  return <Avatar name={p.name} src={src} size={size} decorative />;
}

export function PersonChip({ p }: { p: TvPlayer }) {
  return (
    <span className="ad-person" title={p.name}>
      <PlayerAvatar p={p} size={24} />
      <span>{p.name}</span>
    </span>
  );
}
