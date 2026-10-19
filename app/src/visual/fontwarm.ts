// Start the fonts every screen needs as soon as the app's JS runs. index.html preloads only the
// two Cyrillic files; the Latin subsets carry the space, digits, «», — and … (every Russian line
// uses them), and the mono face sets every label and timer — the browser found those only at the
// first layout, ~1.2 s later on a 4G phone, and swapped them in mid-screen (lines re-wrapped:
// measured CLS 0.02–0.04 on the answered / sending screens).

const FACES: readonly [font: string, text: string][] = [
  ['600 16px Geologica', ' 0«»—…'],
  ['700 16px Unbounded', ' 0«»—…'],
  ['600 16px "JetBrains Mono"', ' 0:вопрос'],
];

let warmed = false;

export function warmFonts(): void {
  if (warmed || typeof document === 'undefined') return;
  warmed = true;
  const set = document.fonts as FontFaceSet | undefined;
  if (!set || typeof set.load !== 'function') return;
  for (const [font, text] of FACES) void set.load(font, text).catch(() => undefined);
}

warmFonts();
