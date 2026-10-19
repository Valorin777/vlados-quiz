import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Security-rules tests against the real DEV project (vlados-2609-dev). Never points at prod.
export default defineConfig({
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('./shared', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.dev.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
