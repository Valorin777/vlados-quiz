import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useChromeBlob } from '../liquid';
import { cx } from './util';

export interface QRCodeProps {
  /** the URL to encode */
  value: string;
  /** rendered size of the code face (px) */
  size?: number;
  /** chrome plate around the code (liquid when the engine runs) */
  plate?: boolean;
  /** error correction: M is plenty for a short URL on a TV */
  level?: 'L' | 'M' | 'Q' | 'H';
  className?: string;
  label?: string;
}

interface Built {
  n: number;
  d: string;
}

/** Row-run-length SVG path of the dark modules (one `M…h…v1h…z` per run). */
function toPath(data: Uint8Array | ArrayLike<number>, n: number, quiet: number): string {
  let d = '';
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      if (!data[y * n + x]) {
        x++;
        continue;
      }
      const s = x;
      while (x < n && data[y * n + x]) x++;
      d += `M${s + quiet} ${y + quiet}h${x - s}v1h${s - x}z`;
    }
  }
  return d;
}

/**
 * A real, scannable QR code (qrcode package, lazy-loaded so phones never download it) drawn as
 * crisp SVG on a light face, framed by a chrome plate.
 */
export function QRCode({ value, size = 270, plate = true, level = 'M', className, label = 'QR-код для входа в игру' }: QRCodeProps) {
  const [qr, setQr] = useState<Built | null>(null);
  const plateEl = useRef<HTMLDivElement | null>(null);
  useChromeBlob(plateEl, { shape: 'box', film: 0.14, cr: 26, enabled: plate });
  useEffect(() => {
    let alive = true;
    import('qrcode')
      .then((m) => {
        const lib = (m as unknown as { default?: typeof m }).default ?? m;
        const code = lib.create(value, { errorCorrectionLevel: level });
        const n = code.modules.size;
        const bits = code.modules.data as unknown as Uint8Array;
        if (alive) setQr({ n, d: toPath(bits, n, 2) });
      })
      .catch(() => alive && setQr(null));
    return () => {
      alive = false;
    };
  }, [value, level]);
  const face = (
    <div className="vx-qr-face" style={{ width: size, height: size }}>
      {qr ? (
        <svg viewBox={`0 0 ${qr.n + 4} ${qr.n + 4}`} shapeRendering="crispEdges" role="img" aria-label={`${label}: ${value}`}>
          <path d={qr.d} />
        </svg>
      ) : (
        <span className="vx-qr-wait" aria-label="Готовим QR-код" />
      )}
    </div>
  );
  if (!plate) return <div className={cx('vx-qr', className)}>{face}</div>;
  return (
    <div ref={plateEl} className={cx('vx-qr vx-qr-plate lq', className)} style={{ '--qr': `${size}px` } as CSSProperties}>
      {face}
    </div>
  );
}
