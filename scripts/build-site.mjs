// Assembles the static site for GitHub Pages in _site/: the web app from web/, the timetable from
// public/data/ (run build:static first), and runtime-config.js pointing the page at the API.
//
// Usage: API_URL=https://broward-transit-3d.<you>.workers.dev node scripts/build-site.mjs
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, '_site');
const apiUrl = (process.env.API_URL ?? '').trim().replace(/\/+$/, '');

if (apiUrl && !/^https?:\/\/[^\s'"\\]+$/.test(apiUrl)) throw new Error(`API_URL doesn't look like a URL: ${apiUrl}`);
if (!apiUrl) console.warn('API_URL is not set: the page will call the API on its own origin, which GitHub Pages does not have.');

await fs.rm(OUT, { recursive: true, force: true });
await fs.cp(path.join(ROOT, 'web'), OUT, { recursive: true });
await fs.cp(path.join(ROOT, 'public', 'data'), path.join(OUT, 'data'), { recursive: true });
await fs.writeFile(path.join(OUT, 'runtime-config.js'), `// Written by scripts/build-site.mjs.\nwindow.BT3D_API = ${JSON.stringify(apiUrl)};\n`);
// A version on its address, so a changed WORKER_URL reaches browsers at once instead of after
// GitHub Pages' 10-minute cache.
const indexFile = path.join(OUT, 'index.html');
const stamp = Date.now().toString(36);
await fs.writeFile(indexFile, (await fs.readFile(indexFile, 'utf8')).replace('./runtime-config.js"', `./runtime-config.js?v=${stamp}"`));
// Pages would otherwise run the site through Jekyll, which skips some files.
await fs.writeFile(path.join(OUT, '.nojekyll'), '');

const { folder } = JSON.parse(await fs.readFile(path.join(OUT, 'data', 'manifest.json'), 'utf8'));
console.log(`Site in _site/ (timetable ${folder}, API ${apiUrl || 'same origin'})`);
