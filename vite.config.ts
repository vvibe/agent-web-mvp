import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Read PORT from .env so vite proxy and the Node server stay aligned.
// Vite doesn't load .env automatically at config time — call loadEnv() with
// '' to surface every key (we want plain PORT, not VITE_PORT).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const serverPort = Number(env.PORT ?? process.env.PORT ?? 8787);
  const httpTarget = `http://localhost:${serverPort}`;
  const wsTarget = `ws://localhost:${serverPort}`;

  return {
    root: path.resolve(__dirname, 'web'),
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/ws': { target: wsTarget, ws: true },
        '/api': { target: httpTarget, changeOrigin: true },
        '/auth': { target: httpTarget, changeOrigin: true },
        '/install.sh': { target: httpTarget, changeOrigin: true },
        '/install.ps1': { target: httpTarget, changeOrigin: true },
      },
    },
    build: {
      outDir: path.resolve(__dirname, 'dist/web'),
      emptyOutDir: true,
    },
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, 'shared'),
      },
    },
  };
});
