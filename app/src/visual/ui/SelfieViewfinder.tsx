import { gsap } from 'gsap';
import { useEffect, useRef, useState } from 'react';
import { audio } from '../audio';
import { pulse } from '../beats';
import { useChromeBlob, useLiquid } from '../liquid';
import { reducedMotion } from '../motion';
import { ChromeButton } from './ChromeButton';
import { cx, initialOf } from './util';

export interface SelfieResult {
  kind: 'photo' | 'generated';
  /** 256×256 JPEG, ≤ 40 KB */
  avatar: globalThis.Blob;
  /** 64×64 JPEG, ≤ 6 KB */
  thumb: globalThis.Blob;
  /** object URL of `avatar` for immediate display (revoke when done) */
  url: string;
}

export interface SelfieViewfinderProps {
  /** player name — for the generated chrome avatar when skipping */
  name: string;
  onDone: (r: SelfieResult) => void;
  /** ask for the camera on mount (default) — otherwise a button starts it */
  autoStart?: boolean;
  className?: string;
}

type Phase = 'idle' | 'starting' | 'live' | 'nocam' | 'shot' | 'busy';

async function toJpeg(c: HTMLCanvasElement, max: number, qs: number[]): Promise<globalThis.Blob> {
  let last: globalThis.Blob | null = null;
  for (const q of qs) {
    last = await new Promise<globalThis.Blob | null>((res) => c.toBlob(res, 'image/jpeg', q));
    if (last && last.size <= max) return last;
  }
  if (!last) throw new Error('JPEG encoding failed');
  return last;
}

async function encodeSquare(src: CanvasImageSource, sx: number, sy: number, side: number, mirror: boolean): Promise<Omit<SelfieResult, 'kind'>> {
  const big = document.createElement('canvas');
  big.width = big.height = 256;
  const g = big.getContext('2d');
  if (!g) throw new Error('no 2d');
  if (mirror) {
    g.translate(256, 0);
    g.scale(-1, 1);
  }
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, sx, sy, side, side, 0, 0, 256, 256);
  const avatar = await toJpeg(big, 40_000, [0.82, 0.74, 0.66, 0.56, 0.46, 0.36]);
  const small = document.createElement('canvas');
  small.width = small.height = 64;
  const s = small.getContext('2d');
  if (!s) throw new Error('no 2d');
  s.imageSmoothingQuality = 'high';
  s.drawImage(big, 0, 0, 64, 64);
  const thumb = await toJpeg(small, 6_000, [0.72, 0.6, 0.5, 0.4, 0.3]);
  return { avatar, thumb, url: URL.createObjectURL(avatar) };
}

/** A chrome sphere with the engraved initial — the avatar for guests who skip the selfie. */
export async function generateChromeAvatar(name: string): Promise<SelfieResult> {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  if (!g) throw new Error('no 2d');
  try {
    await Promise.race([document.fonts.load('900 120px Unbounded'), new Promise((r) => setTimeout(r, 800))]);
  } catch {
    /* system font fallback */
  }
  const bg = g.createLinearGradient(0, 0, 0, 256);
  bg.addColorStop(0, '#2a2f38');
  bg.addColorStop(1, '#0e1015');
  g.fillStyle = bg;
  g.fillRect(0, 0, 256, 256);
  const sp = g.createRadialGradient(98, 78, 6, 128, 128, 132);
  sp.addColorStop(0, '#ffffff');
  sp.addColorStop(0.3, '#c6ccd4');
  sp.addColorStop(0.62, '#4a515c');
  sp.addColorStop(0.85, '#d5dae0');
  sp.addColorStop(1, '#8a919c');
  g.fillStyle = sp;
  g.beginPath();
  g.arc(128, 128, 124, 0, Math.PI * 2);
  g.fill();
  // thin-film sheen
  const film = g.createLinearGradient(40, 40, 216, 216);
  film.addColorStop(0, 'rgba(111,227,216,0)');
  film.addColorStop(0.45, 'rgba(111,227,216,.22)');
  film.addColorStop(0.55, 'rgba(222,108,203,.2)');
  film.addColorStop(0.65, 'rgba(239,184,96,.18)');
  film.addColorStop(1, 'rgba(239,184,96,0)');
  g.fillStyle = film;
  g.fill();
  const L = initialOf(name);
  g.font = '900 118px Unbounded, "Arial Black", system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = 'rgba(255,255,255,.6)';
  g.fillText(L, 128, 140);
  g.fillStyle = '#13151a';
  g.fillText(L, 128, 137);
  const r = await encodeSquare(c, 0, 0, 256, false);
  return { kind: 'generated', ...r };
}

/**
 * Selfie step: a circular mercury viewfinder around the front camera. «Снять» captures a 256 px
 * JPEG + 64 px thumb; without a camera it falls back to picking a photo; «Пропустить» makes a
 * chrome initial avatar.
 */
export function SelfieViewfinder({ name, onDone, autoStart = true, className }: SelfieViewfinderProps) {
  const frame = useRef<HTMLDivElement | null>(null);
  const lens = useRef<HTMLDivElement | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const file = useRef<HTMLInputElement | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [shot, setShot] = useState<SelfieResult | null>(null);
  const [cap, setCap] = useState('лицо в круг — и жми');
  const blob = useChromeBlob(frame, { shape: 'circle', film: 0.6 });
  const { engine } = useLiquid();

  const stop = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };

  const start = async () => {
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) {
      setPhase('nocam');
      setCap('камеры нет — выбери фото или пропусти');
      return;
    }
    setPhase('starting');
    setCap('проявляемся…');
    try {
      const s = await md.getUserMedia({ video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 720 } }, audio: false });
      stream.current = s;
      const v = video.current;
      if (v) {
        v.srcObject = s;
        await v.play().catch(() => undefined);
      }
      setPhase('live');
      setCap('лицо в круг — и жми');
    } catch {
      setPhase('nocam');
      setCap('камера недоступна — выбери фото или пропусти');
    }
  };

  useEffect(() => {
    if (autoStart) void start();
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // the preview URL is ours until handed over in onDone
  const owned = useRef<SelfieResult | null>(null);
  owned.current = shot;
  useEffect(
    () => () => {
      if (owned.current) URL.revokeObjectURL(owned.current.url);
    },
    [],
  );

  const flashIn = () => {
    audio.shutter();
    const l = lens.current;
    if (l && !reducedMotion()) {
      gsap
        .timeline()
        .to(l, { clipPath: 'circle(0% at 50% 50%)', duration: 0.22, ease: 'power3.in' })
        .call(() => {
          pulse(blob.current, 1, 1);
          if (engine && blob.current) {
            engine.flash(0.35);
            engine.ripple(blob.current.x, blob.current.y, 1);
          }
        })
        .to(l, { clipPath: 'circle(50% at 50% 50%)', duration: 0.6, ease: 'back.out(1.7)' }, '+=0.05');
    }
  };

  const capture = async () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    setPhase('busy');
    const side = Math.min(v.videoWidth, v.videoHeight);
    try {
      const r = await encodeSquare(v, (v.videoWidth - side) / 2, (v.videoHeight - side) / 2, side, true);
      flashIn();
      stop();
      setShot({ kind: 'photo', ...r });
      setPhase('shot');
      setCap('есть! так тебя и увидят на экране');
    } catch {
      setPhase('live');
    }
  };

  const fromFile = async (f: File | undefined) => {
    if (!f) return;
    setPhase('busy');
    try {
      let src: CanvasImageSource;
      let w: number;
      let h: number;
      if (typeof createImageBitmap === 'function') {
        const bmp = await createImageBitmap(f);
        src = bmp;
        w = bmp.width;
        h = bmp.height;
      } else {
        const url = URL.createObjectURL(f);
        const img = new Image();
        img.src = url;
        await img.decode();
        src = img;
        w = img.naturalWidth;
        h = img.naturalHeight;
        URL.revokeObjectURL(url);
      }
      const side = Math.min(w, h);
      const r = await encodeSquare(src, (w - side) / 2, (h - side) / 2, side, false);
      flashIn();
      setShot({ kind: 'photo', ...r });
      setPhase('shot');
      setCap('есть! так тебя и увидят на экране');
    } catch {
      setPhase('nocam');
      setCap('не получилось прочитать фото — попробуй другое');
    }
  };

  const skip = async () => {
    stop();
    setPhase('busy');
    setCap('ладно, будешь буквой из ртути');
    const r = await generateChromeAvatar(name);
    audio.drop(0.7, 0.35);
    onDone(r);
  };

  const done = () => {
    if (!shot) return;
    audio.drop(0.9, 0.4);
    // hand over ownership of the URL
    const s = shot;
    owned.current = null;
    setShot(null);
    onDone(s);
  };

  const retake = () => {
    if (shot) URL.revokeObjectURL(shot.url);
    setShot(null);
    void start();
  };

  const live = phase === 'live' || phase === 'busy';
  return (
    <div className={cx('vx-selfie', className)}>
      <div ref={frame} className={cx('vx-vf lq lq-circle', `is-${phase}`)}>
        <div ref={lens} className="vx-vf-lens">
          <video ref={video} className={cx('vx-vf-video', live && 'is-on')} playsInline muted autoPlay aria-label="Камера" />
          {shot ? <img className="vx-vf-shot" src={shot.url} alt="Твоё селфи" /> : null}
          <div className={cx('vx-vf-mercury', (live || shot) && 'is-clear')} aria-hidden="true" />
        </div>
        <i className="vx-vf-c tl" aria-hidden="true" />
        <i className="vx-vf-c tr" aria-hidden="true" />
        <i className="vx-vf-c bl" aria-hidden="true" />
        <i className="vx-vf-c br" aria-hidden="true" />
      </div>
      <p className="vx-vf-cap" aria-live="polite">
        {cap}
      </p>
      <div className="vx-vf-actions">
        {phase === 'shot' ? (
          <>
            <ChromeButton onClick={done}>Готово</ChromeButton>
            <ChromeButton variant="ghost" onClick={retake}>
              Переснять
            </ChromeButton>
          </>
        ) : phase === 'nocam' || phase === 'idle' ? (
          <>
            <ChromeButton onClick={() => (phase === 'idle' ? void start() : file.current?.click())}>{phase === 'idle' ? 'Включить камеру' : 'Выбрать фото'}</ChromeButton>
            <ChromeButton variant="ghost" onClick={() => void skip()}>
              Пропустить
            </ChromeButton>
          </>
        ) : (
          <>
            <ChromeButton onClick={() => void capture()} loading={phase !== 'live'} disabled={phase === 'starting'}>
              Снять
            </ChromeButton>
            <ChromeButton variant="ghost" onClick={() => void skip()}>
              Пропустить
            </ChromeButton>
          </>
        )}
      </div>
      <input
        ref={file}
        type="file"
        accept="image/*"
        capture="user"
        hidden
        onChange={(e) => {
          void fromFile(e.currentTarget.files?.[0]);
          e.currentTarget.value = '';
        }}
      />
    </div>
  );
}
