import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const PORT = Number(process.env.PORT ?? 8787);

export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022' },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': `http://localhost:${PORT}`,
      '/ws': { target: `ws://localhost:${PORT}`, ws: true },
    },
  },
});
