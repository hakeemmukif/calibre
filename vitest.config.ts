import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  test: {
    environment: 'node',
    // PGlite-backed repo suites run 500ms-1s each; under full-suite parallelism
    // the default 5s trips spurious timeouts. Raised so the gate is deterministic.
    testTimeout: 20000,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['src/**/*.smoke.test.ts', 'src/**/*.live.test.ts', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/**/__fixtures__/**', 'src/**/__test-utils__/**'],
    },
  },
});
