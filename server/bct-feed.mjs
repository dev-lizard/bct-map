// Fetches Broward County Transit's three GTFS-Realtime feeds as raw protobuf, for the Worker
// (worker/index.js) and the Node dev server to relay to browsers as one bundle (web/gtfs-rt.js).
// No Node-only APIs, so the Worker can import it.
import { decodeFeed, feedTimestamp } from '../web/gtfs-rt.js';

export const BCT_BASE = 'https://myride2.broward.org/gtfsrealtime/api/';
const FEED_PATHS = { vehiclePositions: 'vehiclepositions', tripUpdates: 'trips', alerts: 'alerts' };
export const BCT_FEEDS = Object.fromEntries(Object.entries(FEED_PATHS).map(([name, p]) => [name, BCT_BASE + p]));

// BCT's firewall returns 403 to some tool User-Agents (curl's and Wget's defaults), so always send our own.
export const USER_AGENT = 'broward-transit-3d/0.1';
// Older vehicle feeds kept for the bundle: enough for most buses to have a previous report.
const HISTORY_SIZE = 3;
const HISTORY_MAX_AGE_S = 120;

export async function fetchFeedBytes(url, { timeoutMs = 15_000 } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/x-protobuf' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function fetchFeed(url, options) {
  return decodeFeed(await fetchFeedBytes(url, options));
}

// All three feeds at once -> { vehiclePositions, tripUpdates, alerts: Uint8Array or null, errors: [message] }.
// base: where to fetch them from instead of BCT (`wrangler dev` uses the Node server; see .dev.vars).
export async function fetchAllFeeds(names = Object.keys(FEED_PATHS), { base = BCT_BASE } = {}) {
  const results = await Promise.allSettled(names.map(name => fetchFeedBytes(base + FEED_PATHS[name])));
  const out = { vehiclePositions: null, tripUpdates: null, alerts: null, errors: [] };
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') out[names[i]] = r.value;
    else out.errors.push(r.reason.message);
  });
  return out;
}

// The older vehicle feeds to send with `current`: the previous bundle's history plus its current
// feed, each published before `current`, at most HISTORY_MAX_AGE_S older, oldest first.
// previous: { vehiclePositions: Uint8Array or null, history: [Uint8Array] } (raw bundle parts).
export function rollHistory(previous, current) {
  const now = feedTimestamp(current);
  if (now == null || !previous) return [];
  const byTs = new Map();
  for (const bytes of [...(previous.history ?? []), previous.vehiclePositions]) {
    if (!bytes) continue;
    const ts = feedTimestamp(bytes);
    if (ts != null && ts < now && ts >= now - HISTORY_MAX_AGE_S) byTs.set(ts, bytes);
  }
  return [...byTs].sort((a, b) => a[0] - b[0]).slice(-HISTORY_SIZE).map(([, bytes]) => bytes);
}
