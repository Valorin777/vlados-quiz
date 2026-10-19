import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Offline unit tests only. Tests that talk to the DEV Firebase project live in tests/*.dev.test.ts
// and run with `npm run test:rules` (vitest.rules.config.ts).
export default defineConfig({
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('./shared', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['shared/**/*.test.ts', 'app/src/**/*.test.ts', 'tools/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'tests/**'],
    passWithNoTests: true,
  },
});
