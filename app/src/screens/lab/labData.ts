// Fake data for the design-system Lab (names, scores, a procedural mercury portrait).

export const GUESTS =
  'Соня Макс Юля Кирилл Настя Димон Лёха Катя Серёга Ваня Лиза Паша Аня Гоша Вика Женя Марина Стас Оля Никита Даша Рома Полина Егор Алина Миша Ксюша Саня Вера Федя Лена Толик Маша Глеб Ира Боря Таня Витя Света Костя Надя'.split(
    ' ',
  );

export const YOU = 'Тёма';

export const QUESTION = {
  n: 4,
  total: 12,
  title: 'Куда Владос сбежит, если выиграет миллион?',
  options: ['На Бали', 'В Норильск', 'Купит PS6 и не выйдет из дома', 'В Диснейленд'],
  correct: 2,
  vlados: 0,
  counts: [9, 5, 17, 10],
};

export interface BoardRow {
  id: string;
  name: string;
  before: number;
  gain: number;
  you?: boolean;
}

export const BOARD: BoardRow[] = [
  { id: 'b0', name: 'Макс', before: 8120, gain: 1210 },
  { id: 'b1', name: 'Соня', before: 7980, gain: 1840 },
  { id: 'b2', name: 'Кирилл', before: 7710, gain: 0 },
  { id: 'b3', name: 'Юля', before: 7450, gain: 1180 },
  { id: 'b4', name: 'Димон', before: 7300, gain: 1060 },
  { id: 'b5', name: 'Настя', before: 7040, gain: 420 },
  { id: 'b6', name: YOU, before: 6890, gain: 1920, you: true },
  { id: 'b7', name: 'Лёха', before: 6420, gain: 0 },
];

let portrait: string | null = null;

/** The prototype's "cast in mercury" portrait (a stand-in selfie), as a PNG data URL. */
export function mercuryPortrait(): string {
  if (portrait) return portrait;
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d');
  if (!x) return '';
  const TAU = Math.PI * 2;
  let g = x.createLinearGradient(0, 0, 0, S);
  g.addColorStop(0, '#454b57');
  g.addColorStop(1, '#0d0f13');
  x.fillStyle = g;
  x.fillRect(0, 0, S, S);
  x.fillStyle = '#6b727d';
  x.beginPath();
  x.ellipse(128, 300, 124, 92, 0, 0, TAU);
  x.fill();
  x.fillStyle = '#2c3038';
  x.beginPath();
  x.moveTo(96, 214);
  x.lineTo(128, 256);
  x.lineTo(160, 214);
  x.closePath();
  x.fill();
  g = x.createLinearGradient(104, 0, 152, 0);
  g.addColorStop(0, '#50555e');
  g.addColorStop(0.5, '#a0a7b1');
  g.addColorStop(1, '#474b54');
  x.fillStyle = g;
  x.fillRect(106, 150, 44, 72);
  x.fillStyle = '#7d848f';
  x.beginPath();
  x.ellipse(79, 124, 9, 15, 0, 0, TAU);
  x.ellipse(177, 124, 9, 15, 0, 0, TAU);
  x.fill();
  g = x.createRadialGradient(108, 96, 8, 128, 120, 80);
  g.addColorStop(0, '#f6f8fa');
  g.addColorStop(0.55, '#aeb5bf');
  g.addColorStop(1, '#474c55');
  x.fillStyle = g;
  x.beginPath();
  x.ellipse(128, 118, 50, 62, 0, 0, TAU);
  x.fill();
  x.fillStyle = '#1b1e24';
  x.beginPath();
  x.moveTo(74, 118);
  x.bezierCurveTo(62, 52, 116, 30, 152, 42);
  x.bezierCurveTo(190, 52, 194, 90, 182, 118);
  x.bezierCurveTo(172, 86, 148, 76, 122, 80);
  x.bezierCurveTo(100, 83, 86, 96, 74, 118);
  x.fill();
  x.strokeStyle = '#22252c';
  x.lineWidth = 5;
  x.lineCap = 'round';
  x.beginPath();
  x.moveTo(98, 105);
  x.quadraticCurveTo(110, 98, 121, 104);
  x.moveTo(135, 104);
  x.quadraticCurveTo(147, 98, 158, 105);
  x.stroke();
  x.fillStyle = '#14161b';
  x.beginPath();
  x.ellipse(110, 120, 6.5, 4.8, 0, 0, TAU);
  x.ellipse(146, 120, 6.5, 4.8, 0, 0, TAU);
  x.fill();
  x.fillStyle = '#fff';
  x.beginPath();
  x.arc(112, 118, 1.8, 0, TAU);
  x.arc(148, 118, 1.8, 0, TAU);
  x.fill();
  x.strokeStyle = 'rgba(30,33,40,.5)';
  x.lineWidth = 3;
  x.beginPath();
  x.moveTo(128, 124);
  x.quadraticCurveTo(121, 143, 131, 147);
  x.stroke();
  x.strokeStyle = '#1d2026';
  x.lineWidth = 4;
  x.beginPath();
  x.moveTo(108, 157);
  x.quadraticCurveTo(128, 173, 149, 156);
  x.stroke();
  // chrome tone-map + thin-film tint
  const im = x.getImageData(0, 0, S, S);
  const d = im.data;
  const st: [number, number[]][] = [
    [0, [10, 12, 16]],
    [0.28, [48, 54, 64]],
    [0.47, [150, 158, 170]],
    [0.6, [238, 242, 246]],
    [0.7, [112, 120, 132]],
    [0.83, [214, 220, 228]],
    [1, [255, 255, 255]],
  ];
  for (let i = 0; i < d.length; i += 4) {
    const L = ((d[i] ?? 0) * 0.3 + (d[i + 1] ?? 0) * 0.55 + (d[i + 2] ?? 0) * 0.15) / 255;
    let k = 0;
    while (k < st.length - 2 && L > (st[k + 1] as [number, number[]])[0]) k++;
    const a = st[k] as [number, number[]];
    const b = st[k + 1] as [number, number[]];
    const t = Math.min(1, Math.max(0, (L - a[0]) / (b[0] - a[0])));
    const py = (i >> 2) / S / S;
    const h = L * 2.3 + py * 0.9;
    const w = 4 * L * (1 - L) * 0.22;
    for (let c2 = 0; c2 < 3; c2++) {
      const base = (a[1][c2] ?? 0) + ((b[1][c2] ?? 0) - (a[1][c2] ?? 0)) * t;
      const f = (0.55 + 0.45 * Math.cos(TAU * (h + c2 * 0.33))) * 255;
      d[i + c2] = base + (f * (base / 200 + 0.3) - base) * w;
    }
  }
  x.putImageData(im, 0, 0);
  portrait = c.toDataURL('image/jpeg', 0.85);
  return portrait;
}
