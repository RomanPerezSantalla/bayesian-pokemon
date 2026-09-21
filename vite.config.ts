import {defineConfig} from 'vitest/config';
import react from '@vitejs/plugin-react';

// `base: './'` keeps the build relocatable (GitHub Pages, any static host).
export default defineConfig({
  base: './',
  plugins: [react()],
  // Most of the bundle is @smogon/calc's data for every generation.
  build: {chunkSizeWarningLimit: 1200},
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
