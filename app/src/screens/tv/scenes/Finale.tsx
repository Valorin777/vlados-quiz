// The video after the final on the TV (final step 6, shared/engine/finale.ts). The selfie mosaic
// gathers into a mercury droplet (Final.tsx → Mosaic `gather`), the droplet flies up and splashes
// open into a big frame of the video's own proportions over a blurred, glowing copy of its poster
// (never cropped, no black bars) — and the video plays WITH ITS OWN SOUND at full volume on the
// persistent unlocked element (tv/media.ts). The game's sound fades out first (audio.duck) and
// stays out while it plays. When it ends the frame melts away and Final brings the mosaic and
// «С днём рождения!» back with confetti; the sound fades back in.
//
// «Стоп-экран»: TvShow pauses + mutes every video (silenceMedia) and the scene's `held` keeps it so;
// released, it plays on from the same frame. A TV reloaded mid-video joins at the clock's position
// (FinaleView.posMs), without the droplet; reloaded after it, straight to the mosaic.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Emerge, FitImage, audio, cx } from '../../../visual';
import type { FinaleView } from '../../../host';
import { useTvEnv } from '../common';
import { BUILTIN_POSTER_ID, BUILTIN_VIDEO_ID, finaleOnAir, seedBuiltinFinale, softPoster } from '../finale';
import { cancelVideoOutro, playVideo, tvVideo, useMediaUrl } from '../media';
import '../finale.css';

seedBuiltinFinale();

/** Where the mosaic gathers (design px of the 1280×720 stage): the droplet rises from here. */
export const GATHER = { x: 640, y: 600 } as const;

/** The droplet starts this long after the step (the mosaic is still flowing into it). */
const DROP_DELAY_S = 0.9;
/** Nothing played at all (a file that never loads): back to the mosaic this long after its end. */
const GIVE_UP_MS = 8_000;

/** The poster pre-blurred for the backdrop (finale.ts softPoster); null until ready / unreadable. */
function useSoftPoster(src: string | null): string | null {
  const [soft, setSoft] = useState<{ src: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!src) return;
    let alive = true;
    void softPoster(src).then((url) => alive && setSoft({ src, url }));
    return () => {
      alive = false;
    };
  }, [src]);
  return soft && soft.src === src ? soft.url : null;
}

export function FinaleVideo({ finale, from, onEnded }: { finale: FinaleView; from: () => Element | null | undefined; onEnded: () => void }) {
  const env = useTvEnv();
  const { muted, held = false } = env;
  const custom = finale.videoId !== null;
  const { url, failed } = useMediaUrl(custom ? finale.videoId : BUILTIN_VIDEO_ID);
  const poster = useMediaUrl(custom ? finale.posterId : BUILTIN_POSTER_ID);
  const host = useRef<HTMLDivElement | null>(null);
  const soft = useSoftPoster(poster.url);
  // joined mid-video (a reloaded TV): no droplet, straight into the frame at the clock's position
  const joinMs = useRef(finale.stage === 'play' && finale.posMs > 1_000 ? finale.posMs : 0);
  const [landed, setLanded] = useState(joinMs.current > 0);
  const [on, setOn] = useState(false);
  const [done, setDone] = useState(false);
  const doneRef = useRef(false);
  const ended = useRef(onEnded);
  ended.current = onEnded;
  const finish = useRef(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    setDone(true);
    audio.duck(false);
    ended.current();
  });

  // reloaded after the video: the mosaic straight away
  useLayoutEffect(() => {
    if (finale.stage === 'after') finish.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // the game's music and effects fade out before the video and stay out while it plays
  useEffect(() => {
    if (doneRef.current) return;
    audio.music(false);
    audio.duck(true);
    return () => audio.duck(false);
  }, []);

  // the ONE unlocked element moves into this frame (and out again when the scene goes)
  useLayoutEffect(() => {
    const v = tvVideo();
    cancelVideoOutro();
    finaleOnAir(true);
    host.current?.appendChild(v);
    const playing = () => setOn(true);
    const end = () => finish.current();
    v.addEventListener('playing', playing);
    v.addEventListener('ended', end);
    return () => {
      v.removeEventListener('playing', playing);
      v.removeEventListener('ended', end);
      v.pause();
      v.remove();
      finaleOnAir(false);
    };
  }, []);

  useEffect(() => {
    const v = tvVideo();
    if (!url || doneRef.current) return;
    const seek = () => {
      const at = joinMs.current / 1000;
      if (at > 0 && Number.isFinite(v.duration) && at < v.duration - 0.3) v.currentTime = at;
    };
    if (v.src !== url) {
      setOn(false);
      v.src = url;
      v.addEventListener('loadedmetadata', seek, { once: true });
      v.load();
    } else if (v.readyState >= 1) seek();
    const bad = () => finish.current();
    v.addEventListener('error', bad);
    return () => v.removeEventListener('error', bad);
  }, [url]);

  // full volume: the video's own soundtrack is the music now (the TV's mute key still wins)
  useEffect(() => {
    const v = tvVideo();
    v.volume = 1;
    v.muted = muted;
  }, [muted]);

  // the droplet is late (a busy or throttled page, the rehearsal at ×4): the video goes on the clock
  const overdue = !landed && finale.stage !== 'gather' && finale.posMs > 1_500;
  useEffect(() => {
    if (overdue) setLanded(true);
  }, [overdue]);

  const play = landed && !done && url !== null;
  useEffect(() => {
    const v = tvVideo();
    if (!url) return;
    if (play && !held) void playVideo(v, muted);
    else v.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [play, held, url]);

  // a file that cannot be loaded, or never plays: back to the mosaic (not a frozen frame all night)
  useEffect(() => {
    if (!failed) return;
    const t = setTimeout(() => finish.current(), 2_500);
    return () => clearTimeout(t);
  }, [failed]);
  const late = !held && !done && finale.stage === 'after' && env.now() > finale.endAt + GIVE_UP_MS;
  useEffect(() => {
    if (!late) return;
    const v = tvVideo();
    if (v.paused || v.ended) finish.current();
  }, [late]);

  if (done && finale.stage === 'after' && !landed) return null;
  const ar = finale.w / finale.h;
  const box = Math.min(2.4, Math.max(0.45, ar));
  const frameIn = (
    <div className="tfv-in">
      {poster.url ? <FitImage src={poster.url} fit="fill" className="tfv-poster" /> : null}
      <div ref={host} className={cx('tfv-host', on && 'is-on')} />
    </div>
  );
  return (
    <div className={cx('tfv', landed && 'is-landed', on && 'is-playing', done && 'is-done', joinMs.current > 0 && 'is-joined', ar < 0.9 ? 'is-portrait' : 'is-wide')} aria-hidden={done || undefined}>
      <div className="tfv-back" style={soft ? ({ '--tfv-poster': `url("${soft}")` } as CSSProperties) : undefined} />
      <i className="tfv-glow" />
      <div className="tfv-stage" style={{ '--media-ar': box } as CSSProperties}>
        {joinMs.current > 0 ? (
          <div className="tfv-e tfv-plain">{frameIn}</div>
        ) : (
          <Emerge size="tv" ready from={from} delay={DROP_DELAY_S} sound={env.sound.sfx} radius={30} className="tfv-e" onLand={() => setLanded(true)}>
            {frameIn}
          </Emerge>
        )}
      </div>
    </div>
  );
}
