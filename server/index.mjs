// The Node server, for local development and for hosting on your own machine. In production the
// same API comes from a Cloudflare Worker (worker/) and the site from GitHub Pages (docs/DEPLOY.md).
// It polls BCT's GTFS-RT feeds on a timer (never per request), rebuilds the static timetable every
// night, logs on-time performance, and serves
//   GET /api/rt                            BCT's three live feeds as one protobuf bundle (web/gtfs-rt.js)
//   GET /api/reliability                   on-time performance by route, or by hour (?route=ID&days=7)
//   GET /api/weather                       current conditions in Fort Lauderdale
//   GET /api/radar                         time and tile URL of the latest rain radar
//   GET /api/health                        ok / degraded / down, with the checks behind it (503 when down)
//   GET /data/...                          static GTFS output from scripts/build-static.mjs
//   GET /...                               the web app in web/
// The browser does the rest (web/live.js): vehicles, delays, departure boards and trip timelines.
//
// Run exactly one instance: the feed poller, nightly rebuild and reliability log all live in this
// process. Environment: PORT (8787), REFRESH_MS (10000), NIGHTLY_BUILD_AT ("03:30" Broward time, or "off").
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodeFeed, feedTimestamp, packBundle } from '../web/gtfs-rt.js';
import { summarizeTripUpdates } from '../web/live.js';
import { Schedule } from '../web/schedule.js';
import { fetchAllFeeds, rollHistory } from './bct-feed.mjs';
import { getRadar, getWeather } from './extras.mjs';
import { addDays, serviceDayStart, ymdInZone } from '../web/gtfs-util.js';
import { healthReport } from './health.mjs';
import { ReliabilityLog } from './reliability.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const WEB_DIR = path.join(ROOT, 'web');
const DATA_DIR = path.join(ROOT, 'public', 'data');
const PORT = Number(process.env.PORT ?? 8787);
// BCT republishes about every 10 s; polling faster only returns the same data.
const REFRESH_MS = Number(process.env.REFRESH_MS ?? 10_000);
const NIGHTLY_BUILD_AT = process.env.NIGHTLY_BUILD_AT ?? '03:30';
const BUILD_TIMEOUT_MS = 10 * 60_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.geojson': 'application/geo+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.geojson', '.svg']);
const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' };

// ---- Static timetable ------------------------------------------------------------------------

async function loadStaticData() {
  const { folder } = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'manifest.json'), 'utf8'));
  const schedule = new Schedule(JSON.parse(await fs.readFile(path.join(DATA_DIR, folder, 'schedule.json'), 'utf8')));
  console.log(`Static data ${folder}: ${Object.keys(schedule.trips).length} trips`);
  return { folder, schedule };
}

// Runs scripts/build-static.mjs in its own process: parsing BCT's 80 MB stop_times.txt takes about
// half a minute of solid CPU, which would otherwise freeze the API.
function runBuild() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'build-static.mjs')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const keep = chunk => {
      output = (output + chunk).slice(-2000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill(), BUILD_TIMEOUT_MS);
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', code => {
      clearTimeout(timer);
      const lastLine = output.trim().split('\n').at(-1) ?? '';
      if (code === 0) resolve({ seconds: Math.round((Date.now() - started) / 1000), summary: lastLine });
      else reject(new Error(lastLine || `build exited with code ${code}`));
    });
  });
}

let staticData;
try {
  staticData = await loadStaticData();
} catch {
  console.log('No static data yet: building it from BCT\'s GTFS (about a minute)...');
  try {
    await runBuild();
    staticData = await loadStaticData();
  } catch (err) {
    console.error(`Could not build static GTFS data: ${err.message}`);
    process.exit(1);
  }
}

const timezone = staticData.schedule.meta.timezone;
const reliability = new ReliabilityLog({ dir: path.join(ROOT, 'data', 'reliability'), timezone });
await reliability.load();
console.log(`Reliability: ${reliability.samples.length} timepoint departures on record`);

// ---- Nightly rebuild -------------------------------------------------------------------------

let lastBuild = null; // { ok, at, seconds?, error? } for the last rebuild in this process
let building = false;

// Unix ms of the next "HH:MM" in Broward.
function nextBuildAt(nowMs, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  let day = ymdInZone(new Date(nowMs), timezone);
  for (;;) {
    const at = (serviceDayStart(day, timezone) + h * 3600 + m * 60) * 1000;
    if (at > nowMs + 1000) return at;
    day = addDays(day, 1);
  }
}

async function rebuild() {
  if (building) return;
  building = true;
  try {
    const result = await runBuild();
    staticData = await loadStaticData();
    lastBuild = { ok: true, at: new Date().toISOString(), seconds: result.seconds };
    console.log(`[build] ${result.summary} (${result.seconds} s), now serving the new timetable`);
  } catch (err) {
    // The previous data stays in use; health reports the failure.
    lastBuild = { ok: false, at: new Date().toISOString(), error: err.message };
    console.error(`[build] nightly rebuild failed: ${err.message}`);
  } finally {
    building = false;
  }
}

function scheduleNightlyBuild() {
  if (NIGHTLY_BUILD_AT === 'off') return;
  if (!/^\d{1,2}:\d{2}$/.test(NIGHTLY_BUILD_AT)) {
    console.error(`NIGHTLY_BUILD_AT must be HH:MM or "off", not "${NIGHTLY_BUILD_AT}"; nightly rebuild disabled`);
    return;
  }
  const at = nextBuildAt(Date.now(), NIGHTLY_BUILD_AT);
  console.log(`[build] next timetable rebuild ${new Date(at).toISOString()}`);
  setTimeout(async () => {
    await rebuild();
    scheduleNightlyBuild();
  }, at - Date.now());
}

// ---- Feed polling ----------------------------------------------------------------------------

let lastRefreshS = null;
let vehicleFeedS = null;
let feedErrors = [];
// The latest bundle: its raw parts (to carry over a feed BCT fails to return, and for history),
// and the serialised body, gzipped once per refresh rather than per request.
let bundle = { parts: null, body: null, gz: null };

async function refresh() {
  const feeds = await fetchAllFeeds();
  feedErrors = feeds.errors;
  if (!feeds.vehiclePositions) throw new Error(feeds.errors.join('; '));
  const previous = bundle.parts;
  const parts = {
    vehiclePositions: feeds.vehiclePositions,
    tripUpdates: feeds.tripUpdates ?? previous?.tripUpdates ?? null,
    alerts: feeds.alerts ?? previous?.alerts ?? null,
    history: rollHistory(previous, feeds.vehiclePositions),
  };
  const body = Buffer.from(packBundle(parts));
  bundle = { parts, body, gz: zlib.gzipSync(body) };
  lastRefreshS = Date.now() / 1000;
  vehicleFeedS = feedTimestamp(feeds.vehiclePositions);
  let recorded = 0;
  if (feeds.tripUpdates) {
    const { schedule } = staticData;
    const { feedTs, trips } = summarizeTripUpdates(decodeFeed(feeds.tripUpdates), { trips: schedule.trips, timezone });
    recorded = reliability.observe(trips.values(), schedule.trips, feedTs);
  }
  const kb = n => `${Math.round(n / 1024)} KB`;
  const errors = feedErrors.length ? ` (partial: ${feedErrors.join('; ')})` : '';
  console.log(`[feed] bundle ${kb(body.length)} (${kb(bundle.gz.length)} gzipped), ${parts.history.length} older vehicle feeds, ${recorded} departures recorded${errors}`);
}

async function refreshLoop() {
  try {
    await refresh();
  } catch (err) {
    console.error(`[feed] refresh failed: ${err.message}`);
  }
  pollTimer = setTimeout(refreshLoop, REFRESH_MS);
}
let pollTimer = null;

function health() {
  const nowS = Date.now() / 1000;
  const today = ymdInZone(new Date(), timezone);
  const { schedule } = staticData;
  const end = schedule.end;
  const toUtcDay = ymd => Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8));
  const report = healthReport({
    nowS,
    lastRefreshS,
    vehicleFeedS,
    feedErrors,
    timetableEnd: end,
    today,
    daysLeft: end ? Math.round((toUtcDay(end) - toUtcDay(today)) / 86_400_000) : null,
    lastBuild,
    builtAtS: Date.parse(schedule.meta.built_at) / 1000 || null,
  });
  return {
    ...report,
    feedVersion: schedule.meta.feed_version,
    folder: staticData.folder,
    lastBuild,
    nextBuild: NIGHTLY_BUILD_AT === 'off' ? null : new Date(nextBuildAt(Date.now(), NIGHTLY_BUILD_AT)).toISOString(),
    reliabilitySamples: reliability.samples.length,
    uptimeS: Math.round(process.uptime()),
  };
}

// ---- Responses -------------------------------------------------------------------------------

const acceptsGzip = req => /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');

// `gz`: the body already gzipped, if cached. `compress`: false for formats that are compressed already.
function send(req, res, status, body, headers, { gz = null, compress = true } = {}) {
  const compressible = compress && body.length > 1024 && acceptsGzip(req);
  const payload = compressible ? gz ?? zlib.gzipSync(body) : body;
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...headers,
    Vary: 'Accept-Encoding',
    ...(compressible ? { 'Content-Encoding': 'gzip' } : {}),
    'Content-Length': payload.length,
  });
  res.end(req.method === 'HEAD' ? undefined : payload);
}

// Every API response may be read from another origin (GitHub Pages calling a Worker uses the same
// headers); X-Server-Time lets the page correct for a wrong clock.
const API_HEADERS = {
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'X-Server-Time',
};

function sendJson(req, res, status, value) {
  send(req, res, status, Buffer.from(JSON.stringify(value)), { ...API_HEADERS, 'Content-Type': 'application/json' });
}

function sendBundle(req, res) {
  const headers = { ...API_HEADERS, 'Content-Type': 'application/x-protobuf', 'X-Server-Time': String(Date.now()) };
  send(req, res, 200, bundle.body, headers, { gz: bundle.gz });
}

const fileGzCache = new Map(); // file path -> { mtimeMs, gz }

// Dated build folders under /data never change, so browsers may keep them for a year; everything
// else is revalidated on each load (a cheap 304 when unchanged).
async function serveFile(req, res, baseDir, urlPath, { immutable = false } = {}) {
  let file = path.resolve(baseDir, `.${path.posix.normalize(`/${decodeURIComponent(urlPath)}`)}`);
  if (file !== baseDir && !file.startsWith(baseDir + path.sep)) return sendJson(req, res, 403, { error: 'Forbidden' });
  try {
    let stat = await fs.stat(file);
    if (stat.isDirectory()) {
      file = path.join(file, 'index.html');
      stat = await fs.stat(file);
    }
    const lastModified = new Date(Math.floor(stat.mtimeMs / 1000) * 1000).toUTCString();
    const headers = {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'Last-Modified': lastModified,
    };
    if (!immutable && req.headers['if-modified-since'] === lastModified) {
      res.writeHead(304, { ...SECURITY_HEADERS, ...headers });
      return res.end();
    }
    const body = await fs.readFile(file);
    const compress = COMPRESSIBLE.has(path.extname(file));
    let gz = null;
    if (compress && body.length > 1024 && acceptsGzip(req)) {
      const cached = fileGzCache.get(file);
      if (cached?.mtimeMs === stat.mtimeMs) gz = cached.gz;
      else fileGzCache.set(file, { mtimeMs: stat.mtimeMs, gz: (gz = zlib.gzipSync(body)) });
    }
    send(req, res, 200, body, headers, { gz, compress });
  } catch {
    sendJson(req, res, 404, { error: 'Not found' });
  }
}

// Integer query parameter, falling back to `fallback` and clamped to [min, max].
function intParam(value, fallback, min, max) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// ---- Routes ----------------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(req, res, 405, { error: 'Method not allowed' });

  // For `wrangler dev` only: workerd can't make TLS connections to BCT's server, which offers only
  // older cipher suites (Cloudflare's network can). .dev.vars points the local Worker here instead.
  const dev = pathname.match(/^\/dev\/bct\/(vehiclepositions|trips|alerts)$/);
  if (dev) {
    const part = bundle.parts?.[{ vehiclepositions: 'vehiclePositions', trips: 'tripUpdates', alerts: 'alerts' }[dev[1]]];
    return part ? send(req, res, 200, Buffer.from(part), { 'Content-Type': 'application/x-protobuf', 'Cache-Control': 'no-store' }) : sendJson(req, res, 503, { error: 'Not fetched yet' });
  }
  if (pathname === '/api/rt') {
    return bundle.body ? sendBundle(req, res) : sendJson(req, res, 503, { error: 'First feed refresh has not finished yet' });
  }
  if (pathname === '/api/health') {
    const report = health();
    return sendJson(req, res, report.status === 'down' ? 503 : 200, report);
  }
  if (pathname === '/api/reliability') {
    const summary = reliability.summary({ days: intParam(searchParams.get('days'), 7, 1, 30), routeId: searchParams.get('route') });
    return sendJson(req, res, 200, summary);
  }
  if (pathname === '/api/weather' || pathname === '/api/radar') {
    try {
      return sendJson(req, res, 200, await (pathname === '/api/weather' ? getWeather() : getRadar()));
    } catch (err) {
      return sendJson(req, res, 502, { error: `Upstream unavailable: ${err.message}` });
    }
  }
  if (pathname.startsWith('/data/')) {
    const rel = pathname.slice('/data/'.length);
    return serveFile(req, res, DATA_DIR, rel, { immutable: /^\d{8}_\d{6}\//.test(rel) });
  }
  return serveFile(req, res, WEB_DIR, pathname);
});

server.listen(PORT, () => console.log(`Broward Transit 3D on http://localhost:${PORT}`));
refreshLoop();
scheduleNightlyBuild();

// ---- Shutdown --------------------------------------------------------------------------------

// On SIGTERM (container stop, deploy) or Ctrl+C: stop taking requests and polling, and finish
// writing the reliability log before exiting.
let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: shutting down`);
  clearTimeout(pollTimer);
  server.close();
  await reliability.flush();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', err => console.error('[unhandled]', err));
