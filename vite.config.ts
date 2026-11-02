import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react(), tailwind()],
  build: {
    rollupOptions: {
      input: {
        dashboard: resolve('dashboard.html'),
        popup: resolve('popup.html'),
        sidepanel: resolve('sidepanel.html'),
        devtools: resolve('devtools.html'),
        panel: resolve('panel.html'),
        collection: resolve('collection.html'),
        background: resolve('src/extension/background.ts'),
        dom: resolve('src/extension/dom.ts'),
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
      },
    },
    chunkSizeWarningLimit: 1100,
  },
});
