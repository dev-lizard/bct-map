// Weather from Iowa Environmental Mesonet, free and with no keys. The API (Node server or Worker)
// fetches it and caches the result, so visitors share upstream requests:
//   - the time of the latest US NEXRAD radar composite, for the map's radar layer (the tiles go
//     straight from the browser to IEM)
//   - hourly rain at Broward's airport weather stations, for marking rainy days in Analytics

const USER_AGENT = 'broward-transit-3d/0.1';
const RADAR_META_URL = 'https://mesonet.agron.iastate.edu/data/gis/images/4326/USCOMP/n0q_0.json';
export const RADAR_TILES = 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png';

// get() returns `load()`'s value, loading at most once per `ttlMs`. Concurrent callers share one
// request. If a refresh fails, the last good value is served marked { stale: true }, and loading
// isn't retried for `retryMs`, so a down upstream isn't hit on every request.
export function cached(load, ttlMs, { retryMs = 60_000, now = () => Date.now() } = {}) {
  let value = null;
  let loadedAt = -Infinity;
  let failedAt = -Infinity;
  let pending = null;
  return async function get() {
    if (value && now() - loadedAt < ttlMs) return value;
    if (value && now() - failedAt < retryMs) return { ...value, stale: true };
    pending ??= load()
      .then(v => {
        value = v;
        loadedAt = now();
        return v;
      })
      .finally(() => {
        pending = null;
      });
    try {
      return await pending;
    } catch (err) {
      failedAt = now();
      if (value) return { ...value, stale: true };
      throw err;
    }
  };
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

export const RADAR_TTL_MS = 2 * 60_000;

// IEM rebuilds the composite every 5 minutes; `valid` is the radar time it shows.
export async function loadRadar() {
  const json = await fetchJson(RADAR_META_URL);
  return {
    valid: Math.floor(Date.parse(json.meta.valid) / 1000),
    tiles: RADAR_TILES,
    attribution: 'Radar: NEXRAD via Iowa Environmental Mesonet',
  };
}

export const getRadar = cached(loadRadar, RADAR_TTL_MS);

// Observed hourly rain for the last month at Broward's four airport weather stations (ASOS):
// Fort Lauderdale/Hollywood International (FLL), Fort Lauderdale Executive (FXE), North Perry in
// Pembroke Pines (HWO) and Pompano Beach (PMP), from Iowa Environmental Mesonet's archive of their
// hourly reports. Used to mark rainy days (analytics.mjs rainByDate). Weather-model history,
// such as Open-Meteo's, missed nearly all of the scattered showers this is meant to catch.
// Returns the CSV: station,network,valid,precip_in.
export const RAIN_STATIONS = ['FLL', 'FXE', 'HWO', 'PMP'];
export const WEATHER_HISTORY_TTL_MS = 20 * 60_000;

export async function loadWeatherHistory(nowMs = Date.now()) {
  const iso = ms => `${new Date(ms).toISOString().slice(0, 19)}Z`;
  const url = 'https://mesonet.agron.iastate.edu/cgi-bin/request/hourlyprecip.py?network=FL_ASOS' +
    `&station=${RAIN_STATIONS.join(',')}&sts=${iso(nowMs - 31 * 86_400_000)}&ets=${iso(nowMs + 3_600_000)}&tz=America/New_York`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GET hourly rain -> HTTP ${res.status}`);
  return res.text();
}

export const getWeatherHistory = cached(loadWeatherHistory, WEATHER_HISTORY_TTL_MS);
