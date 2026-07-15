import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@extractionstack/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  server: {
    host: true,
    port: 5173,
    strictPort: false,
    fs: {
      allow: [
        path.resolve(__dirname),
        path.resolve(__dirname, '../../packages/shared/dist'),
        path.resolve(__dirname, '../../packages/shared/src'),
      ],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  optimizeDeps: {
    include: ['@extractionstack/shared'],
  },
  build: {
    commonjsOptions: {
      include: [/@extractionstack\/shared/, /node_modules/],
      transformMixedEsModules: true,
    },
  },
  envPrefix: 'VITE_',
  define: {
    'import.meta.env.VITE_API_BASE_URL': JSON.stringify(
      process.env.VITE_API_BASE_URL ?? 'http://localhost:3001',
    ),
  },
});
