import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/extract/**/*.ts'],
      exclude: ['**/*.spec.ts', '**/__fixtures__/**'],
    },
  },
});
