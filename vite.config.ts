import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Static SPA (GitHub Pages) talking to Firebase directly — no game server, no proxy (docs/firebase.md).
export default defineConfig({
  root: fileURLToPath(new URL('./app', import.meta.url)),
  base: './',
  plugins: [react()],
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('./shared', import.meta.url)) },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/app', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    port: 5173,
    strictPort: true,
    host: true,
  },
});
