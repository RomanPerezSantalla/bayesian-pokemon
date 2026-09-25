/**
 * The voice model on this device: downloaded once, when you first turn voice on and agree, into
 * the browser's Cache Storage, and read from there from then on (offline too). The files are
 * served in parts of at most 16 MiB (Cloudflare Pages takes files up to 25 MiB), each checked
 * against its SHA-256 as it arrives.
 */

export const CACHE = 'voice-model-v1';
/** What this app's code reads; a pack built for another is downloaded again. */
export const MODEL_ID = 'parakeet-tdt-ctc-110m-int8';

export interface Part {
  path: string;
  size: number;
  sha256: string;
}

export interface PackFile {
  name: string;
  size: number;
  sha256: string;
  parts: Part[];
}

export interface Manifest {
  id: string;
  /** onnxruntime-web version the runtime file belongs to. */
  ort: string;
  files: PackFile[];
  size: number;
  /** Where the parts were downloaded from (absolute). */
  base?: string;
}

const MANIFEST_KEY = 'manifest.json';

/** A part is stored under its hash too, so a part that changed in a later version is fetched again. */
const partKey = (p: Part, base: string) => `${new URL(p.path, base).href}?sha=${p.sha256.slice(0, 16)}`;

/** Where the pack is served: voice/ next to the app. */
export const packBase = () => new URL('voice/', typeof document !== 'undefined' ? document.baseURI : self.location.href).href;

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');

async function sha256(data: ArrayBuffer) {
  return hex(await crypto.subtle.digest('SHA-256', data));
}

const hasCaches = () => typeof caches !== 'undefined';

/** The installed pack's manifest, if every part of it is there. */
export async function installedManifest(): Promise<Manifest | null> {
  if (!hasCaches()) return null;
  try {
    const cache = await caches.open(CACHE);
    const res = await cache.match(new URL(MANIFEST_KEY, packBase()).href);
    if (!res) return null;
    const m = (await res.json()) as Manifest;
    if (m.id !== MODEL_ID || !m.base) return null;
    for (const f of m.files) for (const p of f.parts) if (!(await cache.match(partKey(p, m.base)))) return null;
    return m;
  } catch {
    return null;
  }
}

export async function fetchManifest(base = packBase()): Promise<Manifest> {
  const res = await fetch(new URL(MANIFEST_KEY, base).href, {cache: 'no-cache'});
  if (!res.ok) throw new Error(`The voice model isn’t available here (${res.status})`);
  const m = (await res.json()) as Manifest;
  if (m.id !== MODEL_ID) throw new Error('The voice model here doesn’t match this version of the app: reload and try again');
  return {...m, base};
}

export interface Progress {
  done: number;
  total: number;
}

/** Downloads what isn't already stored, checking each part; the manifest goes in last, so a half-done download never counts. */
export async function install(onProgress: (p: Progress) => void, signal?: AbortSignal, base = packBase()): Promise<Manifest> {
  if (!hasCaches()) throw new Error('This browser can’t store the voice model (no Cache Storage)');
  const m = await fetchManifest(base);
  const cache = await caches.open(CACHE);
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.quota && est.usage !== undefined && est.quota - est.usage < m.size * 1.1) {
      throw new Error(`Not enough space for the voice model: it needs ${mb(m.size)}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Not enough')) throw err;
  }
  navigator.storage?.persist?.().catch(() => {});
  let done = 0;
  onProgress({done, total: m.size});
  for (const f of m.files) {
    for (const p of f.parts) {
      const url = new URL(p.path, base).href;
      const key = partKey(p, base);
      if (await cache.match(key)) {
        done += p.size;
        onProgress({done, total: m.size});
        continue;
      }
      const data = await download(url, p.size, n => onProgress({done: done + n, total: m.size}), signal);
      if ((await sha256(data)) !== p.sha256) throw new Error('The voice model download was damaged: try again');
      await cache.put(key, new Response(data, {headers: {'Content-Type': 'application/octet-stream', 'Content-Length': String(data.byteLength)}}));
      done += p.size;
      onProgress({done, total: m.size});
    }
  }
  await cache.put(new URL(MANIFEST_KEY, base).href, new Response(JSON.stringify(m), {headers: {'Content-Type': 'application/json'}}));
  // Parts of an older version that this one doesn't use.
  const keep = new Set([new URL(MANIFEST_KEY, base).href, ...m.files.flatMap(f => f.parts.map(p => partKey(p, base)))]);
  for (const req of await cache.keys()) if (!keep.has(req.url)) await cache.delete(req);
  return m;
}

async function download(url: string, size: number, onBytes: (n: number) => void, signal?: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(url, {signal, cache: 'no-store'});
  if (!res.ok || !res.body) throw new Error(`The voice model download failed (${res.status})`);
  const out = new Uint8Array(size);
  const reader = res.body.getReader();
  let n = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    if (n + value.length > size) throw new Error('The voice model download was damaged: try again');
    out.set(value, n);
    n += value.length;
    onBytes(n);
  }
  if (n !== size) throw new Error('The voice model download stopped part-way: try again');
  return out.buffer;
}

/** A stored file, its parts put back together. */
export async function readFile(m: Manifest, name: string): Promise<Uint8Array> {
  const f = m.files.find(x => x.name === name);
  if (!f || !m.base) throw new Error(`The voice model is missing ${name}: download it again`);
  const cache = await caches.open(CACHE);
  const out = new Uint8Array(f.size);
  let at = 0;
  for (const p of f.parts) {
    const res = await cache.match(partKey(p, m.base));
    if (!res) throw new Error(`The voice model is missing part of ${name}: download it again`);
    const buf = new Uint8Array(await res.arrayBuffer());
    out.set(buf, at);
    at += buf.length;
  }
  if (at !== f.size) throw new Error(`The voice model’s ${name} is damaged: download it again`);
  return out;
}

export async function uninstall() {
  if (hasCaches()) await caches.delete(CACHE);
}

export const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;
