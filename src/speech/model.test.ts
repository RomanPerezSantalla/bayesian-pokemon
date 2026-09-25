/**
 * The voice model itself, run as the phone runs it (onnxruntime's WebAssembly), where it has been
 * downloaded (npm run voice-pack; not in CI): its own sample clips read right, and none of the
 * Pokémon at team preview put into plain English.
 */
import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {spokenNames} from '../ui/battle/voice/preview';
import {MELS, melFeatures} from './features';
import {PhraseCache, readLine} from './read';
import type {Manifest} from './store';
import {parseVocab} from './vocab';

const PACK = path.resolve('.cache/voice/pack');
const CLIPS = path.resolve('.cache/voice/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8/test_wavs');
const here = fs.existsSync(path.join(PACK, 'manifest.json')) && fs.existsSync(CLIPS);

function file(m: Manifest, name: string) {
  const f = m.files.find(x => x.name === name)!;
  return Buffer.concat(f.parts.map(p => fs.readFileSync(path.join(PACK, p.path))));
}

function wav(p: string) {
  const b = fs.readFileSync(p);
  let at = 12;
  while (b.toString('ascii', at, at + 4) !== 'data') at += 8 + b.readUInt32LE(at + 4);
  const n = b.readUInt32LE(at + 4) / 2;
  return Float32Array.from({length: n}, (_, i) => b.readInt16LE(at + 8 + i * 2) / 32768);
}

describe.skipIf(!here)('the voice model (where it has been downloaded)', () => {
  it('reads plain English right, and puts no Pokémon into it', async () => {
    const ort = await import('onnxruntime-web');
    ort.env.wasm.numThreads = 1;
    const m = JSON.parse(fs.readFileSync(path.join(PACK, 'manifest.json'), 'utf8')) as Manifest;
    const session = await ort.InferenceSession.create(file(m, 'model.int8.onnx'));
    const vocab = parseVocab(file(m, 'tokens.txt').toString('utf8'));
    const structure = JSON.parse(fs.readFileSync('public/data/structure-doubles.json', 'utf8')) as {preview: Record<string, string[]>};
    const everyone = new PhraseCache(vocab).get(Object.keys(structure.preview).flatMap(spokenNames));
    const read = async (clip: string) => {
      const {data, frames} = melFeatures(wav(path.join(CLIPS, clip)));
      const r = await session.run({
        audio_signal: new ort.Tensor('float32', data, [1, MELS, frames]),
        length: new ort.Tensor('int64', BigInt64Array.from([BigInt(frames)]), [1]),
      });
      return readLine({data: r.logprobs.data as Float32Array, frames: r.logprobs.dims[1], size: r.logprobs.dims[2]}, vocab, everyone);
    };
    const a = await read('0.wav');
    expect(a.plain).toBe("Well, I don't wish to see it any more, observed Phoebe, turning away her eyes. It is certainly very like the old portrait.");
    expect(a.text).toBe(a.plain);
    const b = await read('1.wav');
    expect(b.text).toBe('I love you.');
  }, 60_000);
});
