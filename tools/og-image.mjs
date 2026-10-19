#!/usr/bin/env node
// Renders the link-preview card (`#/og`, app/src/screens/og/OgCard.tsx) with the real design system
// and saves it as app/public/og-image.png (1200 × 630), which the build copies next to index.html.
//
//   npm run og-image              dark card (default)
//   npm run og-image -- light     light card
//
// Starts a throwaway Vite dev server, opens the card in headless Chromium with WebGL (so the liquid
// chrome is the real one, not the CSS fallback), waits for `html[data-og-ready]` and screenshots.
// No Firebase: the card is static.

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'app', 'public', 'og-image.png');
const mode = process.argv[2] === 'light' ? 'light' : 'dark';

const server = await createServer({
  configFile: join(ROOT, 'vite.config.ts'),
  logLevel: 'warn',
  server: { port: 0, strictPort: false, host: '127.0.0.1' },
});
await server.listen();
const addr = server.httpServer?.address();
const port = typeof addr === 'object' && addr ? addr.port : 5173;

const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1, colorScheme: mode });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/?mode=${mode}#/og`);
  await page.waitForSelector('html[data-og-ready]', { timeout: 30_000 });
  const tier = await page.evaluate(() => document.documentElement.dataset.ogReady);
  mkdirSync(dirname(OUT), { recursive: true });
  await page.screenshot({ path: OUT, clip: { x: 0, y: 0, width: 1200, height: 630 } });
  if (errors.length) console.warn('page errors:\n' + errors.join('\n'));
  console.log(`og-image: ${OUT} (${mode}, liquid tier ${tier}${tier === '0' ? ' — CSS chrome fallback, no WebGL' : ''})`);
} finally {
  await browser.close();
  await server.close();
}
