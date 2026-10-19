// The reveal picture's entrance: a mercury droplet swells out of the right answer, winds up, flies
// to the frame (stretching along the way), splashes into a tall capsule and spreads into the photo
// with a soft elastic bounce; the chrome skin melts away and an iridescent sheen sweeps across.
// DOM + GSAP only (transform, opacity, one clip-path), so it runs on tier 0 phones, inside the
// admin preview and over the TV's liquid canvas alike. Reduced motion: a gentle fade.

import { gsap } from 'gsap';
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { audio } from '../audio';
import { useLiquid } from '../liquid';
import { reducedMotion } from '../motion';
import { assignRef, cx } from './util';

export interface EmergeProps {
  children: ReactNode;
  /** start once the content can be shown (the picture is decoded) */
  ready: boolean;
  /** where the droplet swells from (the correct option / answer); omitted → rises from below */
  from?: (() => Element | null | undefined) | null;
  /** seconds after mount before it may start (it also waits for `ready`) */
  delay?: number;
  /** 'tv': a bigger droplet and a longer flight */
  size?: 'phone' | 'tv';
  /** drop / shine sounds (the audio mix decides whether they are heard) */
  sound?: boolean;
  /** final corner radius of the frame, px */
  radius?: number;
  className?: string;
  style?: CSSProperties;
  /** makes the picture a button (tap → full screen) */
  onOpen?: () => void;
  label?: string;
  /** the droplet has splashed into the frame and it is opening (a video starts playing here) */
  onLand?: () => void;
  onDone?: () => void;
  ref?: Ref<HTMLDivElement>;
}

const inset = (c: { t: number; r: number; b: number; l: number; rad: number }): string =>
  `inset(${c.t.toFixed(1)}px ${c.r.toFixed(1)}px ${c.b.toFixed(1)}px ${c.l.toFixed(1)}px round ${Math.max(0, c.rad).toFixed(1)}px)`;

export function Emerge({ children, ready, from, delay = 0, size = 'phone', sound = true, radius, className, style, onOpen, label, onLand, onDone, ref }: EmergeProps) {
  const root = useRef<HTMLDivElement | null>(null);
  const frame = useRef<HTMLDivElement | null>(null);
  const skin = useRef<HTMLElement | null>(null);
  const sheen = useRef<HTMLElement | null>(null);
  const drop = useRef<HTMLElement | null>(null);
  const { engine } = useLiquid();
  const [due, setDue] = useState(delay <= 0);
  const [stage, setStage] = useState<'wait' | 'run' | 'done'>('wait');
  const live = useRef({ from, engine, onLand, onDone, sound });
  live.current = { from, engine, onLand, onDone, sound };
  const tv = size === 'tv';
  const R = radius ?? (tv ? 30 : 22);

  useEffect(() => {
    if (delay <= 0) return;
    const t = setTimeout(() => setDue(true), delay * 1000);
    return () => clearTimeout(t);
  }, [delay]);

  const go = due && ready;
  useEffect(() => {
    const el = root.current;
    const fr = frame.current;
    const dr = drop.current;
    const sk = skin.current;
    const sh = sheen.current;
    if (!go || !el || !fr || !dr || !sk || !sh) return;
    const { engine: eng, sound: snd } = live.current;
    const finish = () => {
      fr.style.clipPath = '';
      fr.style.removeProperty('-webkit-clip-path');
      setStage('done');
      live.current.onDone?.();
    };
    setStage('run');
    const tl = gsap.timeline({ onComplete: finish });
    const land = () => live.current.onLand?.();

    if (reducedMotion()) {
      gsap.set(sk, { opacity: 0 });
      tl.fromTo(fr, { opacity: 0, visibility: 'visible' }, { opacity: 1, duration: 0.6, ease: 'power1.out' });
      if (snd && tv) tl.call(() => audio.shine(), undefined, 0.1);
      tl.call(land, undefined, 0.2);
      return () => {
        tl.kill();
      };
    }

    // geometry in the element's own (unscaled) pixels: the TV surface and the admin preview scale
    const rr = el.getBoundingClientRect();
    const k = rr.width / (el.offsetWidth || 1) || 1;
    const W = fr.offsetWidth;
    const H = fr.offsetHeight;
    const d = tv ? 86 : 36;
    let fx = W / 2;
    let fy = H + d * 1.5;
    const src = live.current.from?.();
    if (src) {
      const q = src.getBoundingClientRect();
      if (q.width > 0 && q.height > 0) {
        fx = (q.left + q.width / 2 - rr.left) / k;
        fy = (q.top + q.height / 2 - rr.top) / k;
      }
    }
    const dx = fx - W / 2;
    const dy = fy - H / 2;
    const angle = (Math.atan2(-dy, -dx) * 180) / Math.PI;
    const toClient = (x: number, y: number) => ({ x: rr.left + x * k, y: rr.top + y * k });
    const ripple = (x: number, y: number, s: number) => {
      if (!eng) return;
      const c = toClient(x, y);
      const p = eng.toLocal(c.x, c.y);
      eng.ripple(p.x, p.y, s);
    };

    const c = { t: H / 2 - d / 2, r: W / 2 - d / 2, b: H / 2 - d / 2, l: W / 2 - d / 2, rad: d / 2 };
    const apply = () => {
      const s = inset(c);
      fr.style.clipPath = s;
      fr.style.setProperty('-webkit-clip-path', s);
    };
    apply();
    gsap.set(fr, { visibility: 'hidden', opacity: 1, scale: 1 });
    gsap.set(sk, { opacity: 1 });
    gsap.set(sh, { x: -W * 0.75, skewX: -16, opacity: 1 });
    gsap.set(dr, { width: d, height: d, left: W / 2 - d / 2, top: H / 2 - d / 2, x: dx, y: dy, rotation: angle, scale: 0, visibility: 'visible', opacity: 1 });

    // 1. the droplet swells out of the right answer and wobbles
    tl.call(() => {
      if (snd) audio.drop(tv ? 1.15 : 1.35, 0.32);
      ripple(fx, fy, tv ? 1 : 0.6);
    }, undefined, 0);
    tl.to(dr, { scale: 1, duration: 0.6, ease: 'elastic.out(1,0.42)' }, 0);
    // 2. wind-up, then the flight: stretched along its path
    const T1 = 0.62;
    const fly = tv ? 0.66 : 0.5;
    tl.to(dr, { scaleX: 0.82, scaleY: 1.16, duration: 0.14, ease: 'sine.out' }, T1 - 0.1);
    tl.to(dr, { x: 0, y: 0, duration: fly, ease: 'back.in(1.3)' }, T1);
    tl.to(dr, { scaleX: 1.55, scaleY: 0.7, duration: fly * 0.7, ease: 'power2.in' }, T1 + 0.04);
    const T = T1 + fly;
    tl.to(dr, { scaleX: 0.6, scaleY: 1.3, duration: 0.07, ease: 'power1.out' }, T - 0.05);
    tl.set(dr, { visibility: 'hidden' }, T + 0.04);
    // 3. splash: a tall capsule first, then it spreads into the picture and settles with a bounce
    tl.set(fr, { visibility: 'visible' }, T);
    tl.call(() => {
      if (snd) audio.drop(tv ? 0.62 : 0.75, 0.45);
      ripple(W / 2, H / 2, tv ? 1.4 : 0.9);
    }, undefined, T);
    tl.to(c, { t: H * 0.14, b: H * 0.14, l: W / 2 - d * 0.36, r: W / 2 - d * 0.36, duration: 0.24, ease: 'power2.out', onUpdate: apply }, T);
    tl.to(c, { t: 0, b: 0, duration: 0.75, ease: 'elastic.out(1,0.75)', onUpdate: apply }, T + 0.18);
    tl.to(c, { l: 0, r: 0, rad: R, duration: 0.85, ease: 'elastic.out(1,0.62)', onUpdate: apply }, T + 0.22);
    tl.fromTo(fr, { scale: 0.9 }, { scale: 1, duration: 1.15, ease: 'elastic.out(1,0.5)' }, T + 0.1);
    // 4. the mercury skin melts into the photo, an iridescent sheen sweeps across it
    tl.call(land, undefined, T + 0.3);
    tl.to(sk, { opacity: 0, duration: 0.65, ease: 'power2.inOut' }, T + 0.4);
    tl.call(() => {
      if (snd) audio.shine();
      if (tv) eng?.flash(0.16);
    }, undefined, T + 0.55);
    tl.to(sh, { x: W * 1.2, duration: tv ? 1.3 : 1.05, ease: 'power2.inOut' }, T + 0.5);
    tl.set(sh, { opacity: 0 });
    return () => {
      tl.kill();
    };
  }, [go, tv, R]);

  const open = onOpen && stage === 'done' ? onOpen : undefined;
  return (
    <div
      ref={(n) => {
        root.current = n;
        assignRef(ref, n);
      }}
      className={cx('vx-emerge', tv && 'is-tv', `is-${stage}`, onOpen && 'is-openable', className)}
      style={{ '--em-r': `${R}px`, ...style } as CSSProperties}
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      aria-label={onOpen ? label : undefined}
      onClick={open}
      onKeyDown={
        open
          ? (e: KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                open();
              }
            }
          : undefined
      }
    >
      <div ref={frame} className="vx-emerge-frame">
        {children}
        <i ref={skin} className="vx-emerge-skin" aria-hidden="true" />
        <i ref={sheen} className="vx-emerge-sheen" aria-hidden="true" />
      </div>
      <i ref={drop} className="vx-emerge-drop" aria-hidden="true" />
    </div>
  );
}
