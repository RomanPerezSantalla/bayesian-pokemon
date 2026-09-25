/**
 * `npm run voice-pack -- [dir]`: the voice model's files, ready for the app to download
 * (src/speech/store.ts). Puts them in `dir` (default .cache/voice/pack, which `npm run dev` and
 * `npm run phone` serve at /voice/), split into parts of at most 16 MiB with a manifest listing
 * each part's size and SHA-256. For the deployed site, run it into the build: dist/voice.
 *
 * The sources are fetched once into .cache/voice/ and checked against the hashes pinned here:
 *   - the speech model: NVIDIA Parakeet TDT-CTC 110M (CC-BY-4.0), its CTC half as 8-bit ONNX, from
 *     the sherpa-onnx project's release;
 *   - the speech detector: Silero VAD (MIT);
 *   - the ONNX runtime's WebAssembly, from node_modules (onnxruntime-web, MIT).
 */
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, '.cache', 'voice');
const out = path.resolve(root, process.argv[2] ?? path.join('.cache', 'voice', 'pack'));
const PART = 16 << 20;
const MODEL_ID = 'parakeet-tdt-ctc-110m-int8';

const MODEL_DIR = 'sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8';
const SOURCES = {
  tarball: {
    file: 'parakeet.tar.bz2',
    url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_DIR}.tar.bz2`,
    sha256: '17f945007b52ccd8b7200ffc7c5652e9e8e961dfdf479cefcabd06cf5703630b',
  },
  vad: {
    file: 'silero_vad.onnx',
    url: 'https://raw.githubusercontent.com/snakers4/silero-vad/bfdc0193023f121ea5b3cc7b176dbed570a68a59/src/silero_vad/data/silero_vad.onnx',
    sha256: '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3',
  },
};
const EXTRACTED = {
  'model.int8.onnx': '9177a9146cf32ee0cc8152276ef95116f312018d316be37ccf57f7efea81fc1a',
  'tokens.txt': '450e56bd2f036fe5b6aa821865838cc5aa9d8b0106134ce9a9ba0664abe6cd10',
};

const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rel = p => path.relative(root, p).replaceAll('\\', '/');

async function fetchTo(url, file) {
  console.log(`  downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

async function source({file, url, sha256}) {
  const p = path.join(src, file);
  if (!fs.existsSync(p) || sha(p) !== sha256) await fetchTo(url, p);
  if (sha(p) !== sha256) throw new Error(`${rel(p)} isn't the file expected (SHA-256 differs)`);
  return p;
}

fs.mkdirSync(src, {recursive: true});
await source(SOURCES.tarball);
const dir = path.join(src, MODEL_DIR);
if (Object.entries(EXTRACTED).some(([f, h]) => !fs.existsSync(path.join(dir, f)) || sha(path.join(dir, f)) !== h)) {
  console.log('  unpacking the speech model');
  // bsdtar (Windows 10+) and GNU tar both read .tar.bz2.
  const r = spawnSync('tar', ['-xjf', SOURCES.tarball.file], {cwd: src, stdio: 'inherit'});
  if (r.status !== 0) throw new Error('tar failed to unpack the speech model');
  for (const [f, h] of Object.entries(EXTRACTED)) if (sha(path.join(dir, f)) !== h) throw new Error(`${f} isn't the file expected`);
}
const vad = await source(SOURCES.vad);
const ortDir = path.join(root, 'node_modules', 'onnxruntime-web');
const ortVersion = JSON.parse(fs.readFileSync(path.join(ortDir, 'package.json'), 'utf8')).version;

const files = [
  ['model.int8.onnx', path.join(dir, 'model.int8.onnx')],
  ['tokens.txt', path.join(dir, 'tokens.txt')],
  ['silero_vad.onnx', vad],
  ['ort-wasm-simd-threaded.wasm', path.join(ortDir, 'dist', 'ort-wasm-simd-threaded.wasm')],
];

fs.rmSync(out, {recursive: true, force: true});
fs.mkdirSync(out, {recursive: true});
const manifest = {id: MODEL_ID, ort: ortVersion, files: [], size: 0};
for (const [name, file] of files) {
  const data = fs.readFileSync(file);
  const entry = {name, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), parts: []};
  for (let at = 0, k = 0; at < data.length; at += PART, k++) {
    const part = data.subarray(at, Math.min(at + PART, data.length));
    // A file in one part keeps its name; the parts of a bigger one are numbered.
    const partName = data.length > PART ? `${name}.${String(k).padStart(3, '0')}` : name;
    fs.writeFileSync(path.join(out, partName), part);
    entry.parts.push({path: partName, size: part.length, sha256: crypto.createHash('sha256').update(part).digest('hex')});
  }
  manifest.files.push(entry);
  manifest.size += data.length;
}
fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
console.log(`  voice pack: ${rel(out)} (${Math.round(manifest.size / 1e6)} MB in ${manifest.files.reduce((n, f) => n + f.parts.length, 0)} parts)`);
