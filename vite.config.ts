import {execSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type {Connect, Plugin} from 'vite';
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

/**
 * The screen reader's recogniser at /ocr/ for `npm run dev`, `npm run preview` and `npm run phone`: PP-OCRv5's English
 * model and its characters (from .cache/ocr) and ONNX Runtime's WebAssembly (from node_modules).
 */
function ocrFiles(): Plugin {
  const files: Record<string, [string, string]> = {
    'rec.onnx': [path.resolve('.cache/ocr/rec.onnx'), 'application/octet-stream'],
    'dict.txt': [path.resolve('.cache/ocr/dict.txt'), 'text/plain; charset=utf-8'],
    'ort-wasm-simd-threaded.wasm': [path.resolve('node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm'), 'application/wasm'],
  };
  const serve: Connect.NextHandleFunction = (req, res, next) => {
    const hit = files[decodeURIComponent((req.url ?? '').split('?')[0].replace(/^\//, ''))];
    if (!hit || !fs.existsSync(hit[0])) return next();
    res.setHeader('Content-Type', hit[1]);
    res.setHeader('Content-Length', String(fs.statSync(hit[0]).size));
    res.setHeader('Cache-Control', 'no-cache');
    fs.createReadStream(hit[0]).pipe(res);
  };
  return {
    name: 'ocr-files',
    configureServer: server => void server.middlewares.use('/ocr', serve),
    configurePreviewServer: server => void server.middlewares.use('/ocr', serve),
  };
}

/** The reading worker hands ONNX Runtime its WebAssembly from /ocr/, so the copy its bundle points at (14 MB) isn't built in. */
function ortWasmServed(): Plugin {
  return {
    name: 'ort-wasm-served',
    enforce: 'pre',
    transform(code, id) {
      if (!/onnxruntime-web[\\/]dist[\\/]ort\.wasm\.bundle/.test(id)) return;
      return code.replaceAll('new URL("ort-wasm-simd-threaded.wasm",import.meta.url).href', '"ort-wasm-simd-threaded.wasm"');
    },
  };
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
  plugins: [react(), linkPreview(), ocrFiles()],
  // __TEST_LOG__ is turned on only by `npm run phone` (scripts/phone.mjs).
  define: {__APP_BUILD__: JSON.stringify(buildId()), __TEST_LOG__: 'false'},
  // Lets a Cloudflare quick tunnel reach the dev server (HTTPS on a phone).
  server: {allowedHosts: ['.trycloudflare.com'], proxy: official},
  preview: {proxy: official},
  // Most of the bundle is @smogon/calc's data for every generation.
  build: {chunkSizeWarningLimit: 1200},
  // Module workers, like the inference one.
  worker: {format: 'es', plugins: () => [ortWasmServed()]},
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
