import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@extractionstack/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  test: { include: ['src/**/*.spec.ts'], environment: 'node' },
});
