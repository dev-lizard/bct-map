// Fetches Broward County Transit's three GTFS-Realtime feeds as raw protobuf, for the Worker
// (worker/index.js) and the Node dev server to relay to browsers as one bundle (web/gtfs-rt.js).
// No Node-only APIs, so the Worker can import it.
//
// The routes BCT contracts out (4, 6, 15, 23 and 56) aren't in BCT's feeds: their buses and trip
// updates come from the contractor's TrackTrolley system. When its address is configured, those two
// feeds are fetched too and merged into BCT's. Merging needs no re-encoding: two serialized
// protobuf messages one after the other read as one, with the repeated entities of both, and the
// header of the second winning. Its address holds a private key, so it comes from the environment
// (CONTRACT_FEED_BASE: a Worker secret, or an environment variable for the Node server), never
// from the repo.
import { decodeFeed, feedTimestamp } from '../web/gtfs-rt.js';

export const BCT_BASE = 'https://myride2.broward.org/gtfsrealtime/api/';
const FEED_PATHS = { vehiclePositions: 'vehiclepositions', tripUpdates: 'trips', alerts: 'alerts' };
const CONTRACT_PATHS = { vehiclePositions: 'vehiclePositions', tripUpdates: 'tripUpdates' };
export const BCT_FEEDS = Object.fromEntries(Object.entries(FEED_PATHS).map(([name, p]) => [name, BCT_BASE + p]));

// BCT's firewall returns 403 to some tool User-Agents (curl's and Wget's defaults), so always send our own.
export const USER_AGENT = 'broward-transit-3d/0.1';
// Older vehicle feeds kept for the bundle: enough for most buses to have a previous report.
const HISTORY_SIZE = 3;
const HISTORY_MAX_AGE_S = 120;

// accept: TrackTrolley answers 406 to "application/x-protobuf" alone; it sends octet-stream.
export async function fetchFeedBytes(url, { timeoutMs = 15_000, accept = 'application/x-protobuf' } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: accept },
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
// contractBase: the contractor's GTFS-RT address, ending ".../command/gtfs-rt/", or null for BCT's
// feeds alone. A contractor feed is only added to a BCT feed that arrived, so a BCT outage still
// shows as one; its errors are reported without the address, which holds the key.
export async function fetchAllFeeds(names = Object.keys(FEED_PATHS), { base = BCT_BASE, contractBase = null } = {}) {
  const contractNames = contractBase ? names.filter(n => CONTRACT_PATHS[n]) : [];
  const contractRoot = contractBase && (contractBase.endsWith('/') ? contractBase : `${contractBase}/`);
  const [results, contract] = await Promise.all([
    Promise.allSettled(names.map(name => fetchFeedBytes(base + FEED_PATHS[name]))),
    Promise.allSettled(contractNames.map(name => fetchFeedBytes(contractRoot + CONTRACT_PATHS[name], { accept: 'application/octet-stream' }))),
  ]);
  const out = { vehiclePositions: null, tripUpdates: null, alerts: null, errors: [] };
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') out[names[i]] = r.value;
    else out.errors.push(r.reason.message);
  });
  contract.forEach((r, i) => {
    const name = contractNames[i];
    if (r.status !== 'fulfilled') out.errors.push(`Contracted routes' ${name}: ${r.reason.message.replaceAll(contractRoot, '…/')}`);
    else if (out[name]) out[name] = mergeFeeds(r.value, out[name]);
  });
  return out;
}

// Serialized feeds -> one serialized feed with every entity; the last feed's header wins.
export function mergeFeeds(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
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
