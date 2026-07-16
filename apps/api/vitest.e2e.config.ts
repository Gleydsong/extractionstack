import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@extractionstack/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  test: {
    include: ['test/**/*.e2e-spec.ts'],
    environment: 'node',
    hookTimeout: 10_000,
    testTimeout: 10_000,
  },
});
