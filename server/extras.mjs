// Weather and rain radar for the header and map. The API (Node server or Worker) fetches them and
// caches the result, so visitors share upstream requests:
//   - current conditions in Fort Lauderdale from Open-Meteo (free, no key)
//   - the time of the latest US NEXRAD radar composite from Iowa Environmental Mesonet (free, no key);
//     the radar tiles themselves go straight from the browser to IEM.

const USER_AGENT = 'broward-transit-3d/0.1';
const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast?latitude=26.1224&longitude=-80.1437' +
  '&current=temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m' +
  '&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FNew_York';
const RADAR_META_URL = 'https://mesonet.agron.iastate.edu/data/gis/images/4326/USCOMP/n0q_0.json';
export const RADAR_TILES = 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png';

// WMO weather interpretation codes, as Open-Meteo reports them.
const CONDITIONS = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Light showers', 81: 'Showers', 82: 'Heavy showers', 85: 'Snow showers', 86: 'Snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with hail',
};

// Which of the header's few weather icons fits a WMO code.
export function weatherKind(code, isDay) {
  if (code <= 1) return isDay ? 'clear-day' : 'clear-night';
  if (code === 2) return isDay ? 'partly-day' : 'partly-night';
  if (code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 95) return 'storm';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  return 'rain';
}

// Open-Meteo's response -> what the header shows.
export function describeWeather(json) {
  const c = json.current;
  const [date, time] = c.time.split('T'); // local wall-clock time; utc_offset_seconds turns it into UTC
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return {
    temperatureF: Math.round(c.temperature_2m),
    feelsLikeF: Math.round(c.apparent_temperature),
    condition: CONDITIONS[c.weather_code] ?? 'Unknown',
    kind: weatherKind(c.weather_code, c.is_day === 1),
    windMph: Math.round(c.wind_speed_10m),
    observedAt: Date.UTC(y, m - 1, d, hh, mm) / 1000 - json.utc_offset_seconds,
  };
}

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

export const WEATHER_TTL_MS = 10 * 60_000;
export const RADAR_TTL_MS = 2 * 60_000;

export async function loadWeather() {
  return describeWeather(await fetchJson(WEATHER_URL));
}

// IEM rebuilds the composite every 5 minutes; `valid` is the radar time it shows.
export async function loadRadar() {
  const json = await fetchJson(RADAR_META_URL);
  return {
    valid: Math.floor(Date.parse(json.meta.valid) / 1000),
    tiles: RADAR_TILES,
    attribution: 'Radar: NEXRAD via Iowa Environmental Mesonet',
  };
}

export const getWeather = cached(loadWeather, WEATHER_TTL_MS);
export const getRadar = cached(loadRadar, RADAR_TTL_MS);
