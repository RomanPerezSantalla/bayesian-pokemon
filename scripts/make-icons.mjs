#!/usr/bin/env node
// Renders the app icons (a Poké Ball) to PNG with no dependencies: `node scripts/make-icons.mjs`.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = path.resolve(import.meta.dirname, '..', 'public', 'icons');

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = buf => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BG = [17, 20, 24, 255];
const RED = [229, 72, 77, 255];
const WHITE = [245, 246, 248, 255];
const INK = [17, 17, 17, 255];

/** Poké Ball of radius `r` (fraction of size) on a square background. */
function ball(size, r) {
  const c = size / 2;
  const R = r * size;
  return (x, y) => {
    const dx = x - c;
    const dy = y - c;
    const d = Math.hypot(dx, dy);
    if (d > R) return BG;
    if (d > R * 0.93) return INK;
    if (Math.abs(dy) < R * 0.07) return INK;
    if (d < R * 0.3) return d > R * 0.22 ? INK : WHITE;
    return dy < 0 ? RED : WHITE;
  };
}

fs.mkdirSync(OUT, {recursive: true});
fs.writeFileSync(path.join(OUT, 'icon-192.png'), png(192, ball(192, 0.46)));
fs.writeFileSync(path.join(OUT, 'icon-512.png'), png(512, ball(512, 0.46)));
// Maskable icons get cropped to a circle/squircle: keep the ball inside the safe zone.
fs.writeFileSync(path.join(OUT, 'maskable-512.png'), png(512, ball(512, 0.34)));
fs.writeFileSync(path.join(OUT, 'apple-touch-icon.png'), png(180, ball(180, 0.44)));
console.log('Icons written to public/icons');
