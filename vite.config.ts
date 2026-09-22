import {execSync} from 'node:child_process';
import type {Plugin} from 'vite';
import {defineConfig} from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Link previews need absolute URLs, so the page's address and image are added only when the
 * build knows where the site lives: SITE_URL, e.g. https://example.com/ (set it in Cloudflare Pages).
 */
function linkPreview(): Plugin {
  const site = process.env.SITE_URL?.trim().replace(/\/*$/, '/');
  return {
    name: 'link-preview',
    transformIndexHtml: () => (site
      ? [
        {tag: 'link', attrs: {rel: 'canonical', href: site}, injectTo: 'head'},
        {tag: 'meta', attrs: {property: 'og:url', content: site}, injectTo: 'head'},
        {tag: 'meta', attrs: {property: 'og:image', content: `${site}icons/icon-512.png`}, injectTo: 'head'},
      ]
      : []),
  };
}

/** The commit and date of this build, for bug reports (Cloudflare Pages passes the commit in). */
function buildId() {
  let sha = process.env.CF_PAGES_COMMIT_SHA ?? '';
  if (!sha) {
    try {
      sha = execSync('git rev-parse HEAD', {stdio: ['ignore', 'pipe', 'ignore']}).toString().trim();
    } catch {
      // Not a git checkout.
    }
  }
  const date = new Date().toISOString().slice(0, 10);
  return sha ? `${sha.slice(0, 7)} ${date}` : date;
}

/** What functions/official does on Cloudflare Pages, for `npm run dev` and `npm run preview` (without the edge cache). */
const official = {
  '/official': {
    target: 'https://championsbattledata.com',
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/official/, '/data/meta'),
  },
};

// `base: './'` keeps the build relocatable (any static host, any path).
export default defineConfig({
  base: './',
  plugins: [react(), linkPreview()],
  // __TEST_LOG__ is turned on only by `npm run phone` (scripts/phone.mjs).
  define: {__APP_BUILD__: JSON.stringify(buildId()), __TEST_LOG__: 'false'},
  // Lets a Cloudflare quick tunnel reach the dev server (HTTPS on a phone, for voice).
  server: {allowedHosts: ['.trycloudflare.com'], proxy: official},
  preview: {proxy: official},
  // Most of the bundle is @smogon/calc's data for every generation.
  build: {chunkSizeWarningLimit: 1200},
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
