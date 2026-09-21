import {defineConfig} from 'vitest/config';
import react from '@vitejs/plugin-react';

// `base: './'` keeps the build relocatable (GitHub Pages, any static host).
export default defineConfig({
  base: './',
  plugins: [react()],
  // Lets a Cloudflare quick tunnel reach the dev server (HTTPS on a phone, for voice).
  server: {allowedHosts: ['.trycloudflare.com']},
  // Most of the bundle is @smogon/calc's data for every generation.
  build: {chunkSizeWarningLimit: 1200},
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
