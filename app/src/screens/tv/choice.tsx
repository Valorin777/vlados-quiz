// Answer options on the TV (question and reveal share this grid so the tiles never jump): text
// options are liquid OptionTiles, picture options are chrome boxes with the photo inside.

import type { PubItem } from '@shared/fbtypes';
import { useRef, type RefObject } from 'react';
import { AvatarStack, ChromeBlock, OptionTile, cx, type Blob, type OptionState } from '../../visual';
import { ItemFit } from './common';

export const KEYS = 'ABCDEF';

export interface TileLook {
  state: OptionState;
  count?: number;
  people?: readonly { id: string; name: string; src?: string | null }[];
}

export interface GridRefs {
  tiles: (HTMLElement | null)[];
  blobs: { current: Blob | null }[];
}

export function useGridRefs(n = 6): GridRefs {
  const r = useRef<GridRefs | null>(null);
  if (!r.current) r.current = { tiles: Array.from({ length: n }, () => null), blobs: Array.from({ length: n }, () => ({ current: null })) };
  return r.current;
}

function gridShape(n: number, column: boolean, pics: boolean): { cols: number; rows: number } {
  if (column) return { cols: 1, rows: n };
  if (pics) return n <= 3 ? { cols: n, rows: 1 } : n === 4 ? { cols: 2, rows: 2 } : { cols: 3, rows: 2 };
  if (n === 3) return { cols: 1, rows: 3 };
  return { cols: 2, rows: Math.ceil(n / 2) };
}

const PIC_LOOK: Record<OptionState, { film: number; tar: number; glow: number }> = {
  idle: { film: 0.34, tar: 0, glow: 0 },
  locked: { film: 0.14, tar: 0.2, glow: 0 },
  selected: { film: 0.75, tar: 0, glow: 0.2 },
  correct: { film: 0.9, tar: 0, glow: 0.12 },
  wrong: { film: 0.2, tar: 1, glow: 0 },
  melting: { film: 0.2, tar: 1, glow: 0 },
};

function PicTile({ item, k, look, setEl, blob }: { item: PubItem; k: number; look: TileLook; setEl: (el: HTMLElement | null) => void; blob: { current: Blob | null } }) {
  const l = PIC_LOOK[look.state];
  return (
    <ChromeBlock
      ref={(n) => setEl(n)}
      blobRef={blob as RefObject<Blob | null>}
      shape="box"
      radius={22}
      film={l.film}
      tar={l.tar}
      glow={l.glow}
      className={cx('tv-pic', `is-${look.state}`)}
    >
      <span className="tv-pic-img">{item.mediaId ? <ItemFit id={item.mediaId} /> : null}</span>
      <span className="tv-pic-row">
        <span className="vx-opt-key vx-mono">{KEYS[k]}</span>
        {item.text ? <span className="tv-pic-t vx-opt-label">{item.text}</span> : null}
        {look.count !== undefined || look.people?.length ? (
          <span className="vx-opt-meta">
            {look.people?.length ? <AvatarStack people={look.people} max={3} size={22} /> : null}
            {look.count !== undefined ? <b className="vx-opt-count vx-mono">{look.count}</b> : null}
          </span>
        ) : null}
      </span>
    </ChromeBlock>
  );
}

export function ChoiceGrid({ options, looks, column = false, refs, className }: { options: readonly PubItem[]; looks: readonly TileLook[]; column?: boolean; refs: GridRefs; className?: string }) {
  const pics = options.some((o) => !!o.mediaId);
  const { cols, rows } = gridShape(options.length, column, pics);
  return (
    <div
      className={cx('tv-grid', pics && 'has-pics', column && 'is-column', `n${options.length}`, className)}
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
    >
      {options.map((o, k) => {
        const look = looks[k] ?? { state: 'locked' as const };
        const blob = refs.blobs[k] ?? { current: null };
        return (
          <div key={o.id} className="tv-cell">
            {pics ? (
              <PicTile item={o} k={k} look={look} blob={blob} setEl={(n) => (refs.tiles[k] = n)} />
            ) : (
              <OptionTile
                ref={(n) => {
                  refs.tiles[k] = n;
                }}
                blobRef={blob as RefObject<Blob | null>}
                label={o.text ?? ''}
                keyLabel={KEYS[k]}
                state={look.state}
                count={look.count}
                people={look.people}
                className="tv-opt"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
