// DEV/demo only: colourful fake "selfies" (a head-and-shoulders silhouette on a gradient) as JPEG
// bytes, so rehearsals look like a real crowd instead of 60 identical initials.

export const BOT_NAMES = [
  'Соня', 'Макс', 'Артём', 'Катя', 'Лёша', 'Дима', 'Оля', 'Серёга', 'Настя', 'Паша', 'Юля', 'Вова',
  'Лиза', 'Гоша', 'Маша', 'Костя', 'Аня', 'Миша', 'Женя', 'Даша', 'Рома', 'Вика', 'Никита', 'Полина',
  'Тёма 🚀', 'Кира', 'Гриша', 'Алина', 'Стас', 'Ира', 'Егор', 'Лена', 'Боря', 'Вера', 'Федя', 'Ксюша',
  'Тимур', 'Света', 'Илья', 'Яна', 'Саня', 'Уля', 'Глеб', 'Зоя', 'Марк', 'Ева', 'Лёва', 'Тоня',
];

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const SKIN = ['#f1c9a5', '#e0ac85', '#c68863', '#8d5a3b', '#f5d7bd', '#d9a07a'];
const HAIR = ['#2b1d14', '#5a3a22', '#c9974f', '#1a1a1a', '#8c4a2f', '#e2c27a', '#6b6b6b'];
const BG: [string, string][] = [
  ['#6fe3d8', '#2a4d6e'],
  ['#de6ccb', '#3b2a55'],
  ['#efb860', '#7a3b2a'],
  ['#8fb3ff', '#27305a'],
  ['#9be38a', '#29503a'],
  ['#ff8f8f', '#5a2433'],
];

function draw(size: number, seed: number): HTMLCanvasElement {
  const r = rng(seed * 7919 + 13);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  // a CPU canvas: GPU readback (toDataURL) is very slow in a throttled background tab
  const g = c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  const k = size / 256;
  const [b0, b1] = BG[Math.floor(r() * BG.length)] ?? BG[0]!;
  const bg = g.createLinearGradient(0, 0, size, size);
  bg.addColorStop(0, b0);
  bg.addColorStop(1, b1);
  g.fillStyle = bg;
  g.fillRect(0, 0, size, size);
  // soft light blob
  const lg = g.createRadialGradient(size * 0.3, size * 0.25, 4, size * 0.3, size * 0.25, size * 0.7);
  lg.addColorStop(0, 'rgba(255,255,255,.45)');
  lg.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = lg;
  g.fillRect(0, 0, size, size);
  const skin = SKIN[Math.floor(r() * SKIN.length)] ?? '#e0ac85';
  const hair = HAIR[Math.floor(r() * HAIR.length)] ?? '#2b1d14';
  const shirt = `hsl(${Math.floor(r() * 360)},55%,${35 + Math.floor(r() * 25)}%)`;
  // shoulders
  g.fillStyle = shirt;
  g.beginPath();
  g.ellipse(128 * k, 290 * k, 118 * k, 92 * k, 0, 0, Math.PI * 2);
  g.fill();
  // neck
  g.fillStyle = skin;
  g.fillRect(108 * k, 168 * k, 40 * k, 40 * k);
  // head
  const hx = 128 * k + (r() - 0.5) * 16 * k;
  g.beginPath();
  g.ellipse(hx, 122 * k, 56 * k, 66 * k, 0, 0, Math.PI * 2);
  g.fill();
  // hair
  g.fillStyle = hair;
  g.beginPath();
  const long = r() > 0.5;
  g.ellipse(hx, (long ? 104 : 88) * k, 60 * k, (long ? 62 : 40) * k, 0, Math.PI, Math.PI * 2);
  g.fill();
  if (long) {
    g.fillRect(hx - 60 * k, 100 * k, 18 * k, 90 * k);
    g.fillRect(hx + 42 * k, 100 * k, 18 * k, 90 * k);
  }
  // eyes + smile
  g.fillStyle = '#1b1b1f';
  g.beginPath();
  g.arc(hx - 20 * k, 124 * k, 5.5 * k, 0, Math.PI * 2);
  g.arc(hx + 20 * k, 124 * k, 5.5 * k, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#7a2e2e';
  g.lineWidth = 5 * k;
  g.lineCap = 'round';
  g.beginPath();
  g.arc(hx, 146 * k, 20 * k, 0.15 * Math.PI, 0.85 * Math.PI);
  g.stroke();
  return c;
}

/** Synchronous (toDataURL): toBlob callbacks crawl in a throttled background tab. */
function toJpeg(c: HTMLCanvasElement, q: number): Uint8Array {
  const b64 = c.toDataURL('image/jpeg', q).split(',')[1] ?? '';
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function fakeSelfie(seed: number): Promise<{ avatar: Uint8Array; thumb: Uint8Array }> {
  const avatar = toJpeg(draw(256, seed), 0.72);
  const thumb = toJpeg(draw(64, seed), 0.6);
  return Promise.resolve({ avatar, thumb });
}

/** A 16:9 "photo" for demo media. */
export function fakePhoto(label: string, seed = 1): string {
  const c = document.createElement('canvas');
  c.width = 960;
  c.height = 540;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  const r = rng(seed);
  const bg = g.createLinearGradient(0, 0, 960, 540);
  bg.addColorStop(0, '#2d3a55');
  bg.addColorStop(0.5, '#6d4a7a');
  bg.addColorStop(1, '#e0a060');
  g.fillStyle = bg;
  g.fillRect(0, 0, 960, 540);
  for (let i = 0; i < 18; i++) {
    g.fillStyle = `rgba(255,255,255,${0.04 + r() * 0.1})`;
    g.beginPath();
    g.arc(r() * 960, r() * 540, 20 + r() * 120, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = 'rgba(255,255,255,.9)';
  g.font = '700 54px system-ui, sans-serif';
  g.textAlign = 'center';
  g.fillText(label, 480, 290);
  return c.toDataURL('image/jpeg', 0.8);
}

/**
 * A "portrait photo" of any proportions for framing checks (`w`×`h` px): a dark band on top, a
 * face with BLUE eyes in the middle, shoulders at the bottom, and a bright border + corner marks,
 * so a screenshot shows at once whether the whole picture is visible (nothing may be cropped).
 */
export function fakePicture(w: number, h: number, label = '', seed = 7): string {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  const r = rng(seed);
  const bg = g.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#07080a');
  bg.addColorStop(0.35, '#1d2533');
  bg.addColorStop(1, `hsl(${Math.floor(r() * 360)},45%,42%)`);
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  // the face: sized by the short side, centred a bit above the middle
  const s = Math.min(w, h) / 256;
  const cx = w / 2;
  const cy = h * 0.5;
  g.fillStyle = '#3a6ea5';
  g.beginPath();
  g.ellipse(cx, cy + 150 * s, 120 * s, 70 * s, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#e0ac85';
  g.fillRect(cx - 20 * s, cy + 50 * s, 40 * s, 40 * s);
  g.beginPath();
  g.ellipse(cx, cy, 58 * s, 70 * s, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#2b1d14';
  g.beginPath();
  g.ellipse(cx, cy - 36 * s, 62 * s, 42 * s, 0, Math.PI, Math.PI * 2);
  g.fill();
  for (const ex of [-22, 22]) {
    g.fillStyle = '#fff';
    g.beginPath();
    g.ellipse(cx + ex * s, cy - 2 * s, 11 * s, 7 * s, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#1f7fe0';
    g.beginPath();
    g.arc(cx + ex * s, cy - 2 * s, 5.5 * s, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#0b0b10';
    g.beginPath();
    g.arc(cx + ex * s, cy - 2 * s, 2.4 * s, 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = '#7a2e2e';
  g.lineWidth = 4 * s;
  g.lineCap = 'round';
  g.beginPath();
  g.arc(cx, cy + 22 * s, 18 * s, 0.15 * Math.PI, 0.85 * Math.PI);
  g.stroke();
  // border + corner marks
  const b = Math.max(4, Math.round(Math.min(w, h) * 0.012));
  g.strokeStyle = '#ffd400';
  g.lineWidth = b * 2;
  g.strokeRect(0, 0, w, h);
  g.fillStyle = '#ff2d55';
  const m = Math.round(Math.min(w, h) * 0.08);
  for (const [x, y] of [
    [0, 0],
    [w - m, 0],
    [0, h - m],
    [w - m, h - m],
  ] as const)
    g.fillRect(x, y, m, m);
  if (label) {
    g.fillStyle = 'rgba(255,255,255,.92)';
    g.font = `700 ${Math.round(Math.min(w, h) * 0.07)}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.fillText(label, w / 2, h - m * 1.4);
  }
  return c.toDataURL('image/jpeg', 0.85);
}

/** `fx-pic-<w>x<h>` → a fakePicture of that size (fixtures / demo ids). */
export function fakePictureFor(id: string): string | null {
  const m = /^fx-pic-(\d+)x(\d+)$/.exec(id);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return fakePicture(w, h, `${w}×${h}`);
}

/**
 * A short test clip recorded in the page (canvas + a tone through MediaRecorder: WebM in Chrome,
 * MP4 in Safari) — for the demo's watch stage and reveal video, so the TV's persistent element,
 * its sound and the droplet entrance can be checked without Firebase. Records in real time.
 */
export async function fakeClip(w: number, h: number, ms: number, label: string, freq = 440): Promise<{ url: string; poster: string } | null> {
  if (typeof MediaRecorder === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g || typeof c.captureStream !== 'function') return null;
  const draw = (t: number) => {
    g.fillStyle = `hsl(${(200 + t * 90) % 360} 60% 38%)`;
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.textAlign = 'center';
    g.font = `800 ${Math.round(w / 7)}px system-ui, sans-serif`;
    g.fillText(label, w / 2, h * 0.42);
    g.font = `600 ${Math.round(w / 10)}px system-ui, sans-serif`;
    g.fillText(`${t.toFixed(1)} с`, w / 2, h * 0.42 + w / 6);
    g.beginPath();
    g.arc(w / 2 + Math.sin(t * 3) * w * 0.3, h * 0.78, w / 14, 0, Math.PI * 2);
    g.fill();
  };
  draw(0);
  const poster = c.toDataURL('image/jpeg', 0.85);
  const stream = c.captureStream(30);
  let ac: AudioContext | null = null;
  try {
    ac = new AudioContext();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    const dst = ac.createMediaStreamDestination();
    osc.frequency.value = freq;
    gain.gain.value = 0.15;
    osc.connect(gain).connect(dst);
    osc.start();
    for (const t of dst.stream.getAudioTracks()) stream.addTrack(t);
  } catch {
    /* a silent clip then */
  }
  const type = ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const parts: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size) parts.push(e.data);
  };
  const t0 = performance.now();
  const timer = setInterval(() => draw((performance.now() - t0) / 1000), 33);
  rec.start(250);
  await new Promise((r) => setTimeout(r, ms));
  await new Promise<void>((r) => {
    rec.onstop = () => r();
    rec.stop();
  });
  clearInterval(timer);
  void ac?.close();
  return parts.length ? { url: URL.createObjectURL(new Blob(parts, { type: rec.mimeType || type || 'video/webm' })), poster } : null;
}
