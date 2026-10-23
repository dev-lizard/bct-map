// Draws the app icons in web/icons/: a white bus front on teal, as PNGs for the web app manifest
// and iOS, plus an SVG for the browser tab. No image libraries: shapes are filled pixel by pixel
// (4×4 supersampled) and written as PNG with zlib. Rerun after changing the design.
//
// Usage: node scripts/make-icons.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = path.resolve(import.meta.dirname, '..', 'web', 'icons');
export const COLORS = { background: '#0f766e', bus: '#ffffff', glass: '#134e4a', lights: '#fbbf24' };

// The design on a 0–1 square: [shape, colour]. Rounded rectangles are [x0, y0, x1, y1, radius];
// circles are [cx, cy, r].
const BUS = [
  ['rect', [0.27, 0.2, 0.73, 0.76, 0.08], COLORS.bus], // body
  ['rect', [0.31, 0.72, 0.39, 0.83, 0.02], COLORS.bus], // wheels
  ['rect', [0.61, 0.72, 0.69, 0.83, 0.02], COLORS.bus],
  ['rect', [0.32, 0.29, 0.68, 0.5, 0.03], COLORS.glass], // windscreen
  ['rect', [0.37, 0.235, 0.63, 0.265, 0.01], COLORS.glass], // destination sign
  ['circle', [0.36, 0.64, 0.035], COLORS.lights], // headlights
  ['circle', [0.64, 0.64, 0.035], COLORS.lights],
];

// scale: the bus's size (maskable icons keep it inside the central safe zone). corner: the
// background's corner radius (0 for full-bleed maskable icons).
const ICONS = [
  { file: 'icon-192.png', size: 192, scale: 1, corner: 0.22 },
  { file: 'icon-512.png', size: 512, scale: 1, corner: 0.22 },
  { file: 'icon-maskable-512.png', size: 512, scale: 0.8, corner: 0 },
  { file: 'apple-touch-icon.png', size: 180, scale: 0.9, corner: 0 }, // iOS rounds the corners itself
];

const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));

function inside([kind, g], x, y) {
  if (kind === 'circle') return (x - g[0]) ** 2 + (y - g[1]) ** 2 <= g[2] ** 2;
  const [x0, y0, x1, y1, r] = g;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const dx = Math.max(x0 + r - x, 0, x - (x1 - r));
  const dy = Math.max(y0 + r - y, 0, y - (y1 - r));
  return dx * dx + dy * dy <= r * r;
}

// RGBA pixels for one icon.
function draw({ size, scale, corner }) {
  const shapes = [['rect', [0, 0, 1, 1, corner], COLORS.background], ...BUS.map(([kind, g, color]) => {
    const s = v => 0.5 + (v - 0.5) * scale;
    return [kind, kind === 'circle' ? [s(g[0]), s(g[1]), g[2] * scale] : [s(g[0]), s(g[1]), s(g[2]), s(g[3]), g[4] * scale], color];
  })];
  const N = 4; // samples per side
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let qx = 0; qx < size; qx++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const x = (qx + (sx + 0.5) / N) / size;
          const y = (py + (sy + 0.5) / N) / size;
          let color = null;
          for (const shape of shapes) if (inside(shape, x, y)) color = shape[2];
          if (!color) continue;
          const [r, g, b] = hex(color);
          acc[0] += r;
          acc[1] += g;
          acc[2] += b;
          acc[3] += 1;
        }
      }
      const i = (py * size + qx) * 4;
      if (acc[3]) {
        px[i] = Math.round(acc[0] / acc[3]);
        px[i + 1] = Math.round(acc[1] / acc[3]);
        px[i + 2] = Math.round(acc[2] / acc[3]);
      }
      px[i + 3] = Math.round((255 * acc[3]) / (N * N));
    }
  }
  return px;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function svg() {
  const n = v => Math.round(v * 1000) / 10;
  const parts = BUS.map(([kind, g, color]) => (kind === 'circle'
    ? `<circle cx="${n(g[0])}" cy="${n(g[1])}" r="${n(g[2])}" fill="${color}"/>`
    : `<rect x="${n(g[0])}" y="${n(g[1])}" width="${n(g[2] - g[0])}" height="${n(g[3] - g[1])}" rx="${n(g[4])}" fill="${color}"/>`));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="${COLORS.background}"/>${parts.join('')}</svg>\n`;
}

await fs.mkdir(OUT, { recursive: true });
for (const icon of ICONS) {
  await fs.writeFile(path.join(OUT, icon.file), png(icon.size, draw(icon)));
  console.log(`web/icons/${icon.file}`);
}
await fs.writeFile(path.join(OUT, 'icon.svg'), svg());
console.log('web/icons/icon.svg');
