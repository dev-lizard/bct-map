// Weather for the header, map and alerts panel. The API (Node server or Worker) fetches it and
// caches the result, so visitors share upstream requests. All free, with no keys:
//   - current conditions in Fort Lauderdale from Open-Meteo
//   - the time of the latest US NEXRAD radar composite from Iowa Environmental Mesonet; the radar
//     tiles themselves go straight from the browser to IEM
//   - active National Weather Service alerts for Broward (api.weather.gov)
//   - active Atlantic tropical storms from the National Hurricane Center: forecast cone, track and
//     points, from NOAA's map service (it sends no CORS headers, so browsers can't ask it directly)

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
export const ALERTS_TTL_MS = 2 * 60_000;
export const STORMS_TTL_MS = 10 * 60_000;

// Broward County (FLC011) and its inland, metro and coastal forecast zones. Warnings such as
// tornado or flash flood come by county; hurricane, heat and rip current alerts by zone.
const NWS_ZONES = ['FLC011', 'FLZ071', 'FLZ072', 'FLZ172'];
const NWS_ALERTS_URL = `https://api.weather.gov/alerts/active?zone=${NWS_ZONES.join(',')}`;
export const NWS_PAGE_URL = 'https://forecast.weather.gov/MapClick.php?lat=26.1224&lon=-80.1437';
const SEVERITY_ORDER = ['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown'];

// api.weather.gov's alert collection -> what the alerts panel and header banner show, most severe first.
export function describeWeatherAlerts(json, nowS = Date.now() / 1000) {
  const time = v => (v ? Math.floor(Date.parse(v) / 1000) : null);
  const rank = severity => (SEVERITY_ORDER.includes(severity) ? SEVERITY_ORDER.indexOf(severity) : SEVERITY_ORDER.length);
  const alerts = (json.features ?? [])
    .map(f => f.properties)
    .filter(p => p.status === 'Actual' && p.messageType !== 'Cancel')
    .map(p => ({
      id: p.id,
      event: p.event,
      severity: p.severity ?? 'Unknown',
      urgency: p.urgency ?? 'Unknown',
      headline: p.headline ?? p.event,
      description: p.description?.trim() || null,
      instruction: p.instruction?.trim() || null,
      onset: time(p.onset ?? p.effective),
      ends: time(p.ends ?? p.expires),
      areas: p.areaDesc ?? '',
      sender: p.senderName ?? 'National Weather Service',
    }))
    .filter(a => a.ends == null || a.ends > nowS)
    .sort((a, b) => rank(a.severity) - rank(b.severity) || (a.onset ?? 0) - (b.onset ?? 0));
  return { alerts, moreUrl: NWS_PAGE_URL };
}

export async function loadWeatherAlerts() {
  return describeWeatherAlerts(await fetchJson(NWS_ALERTS_URL));
}

const NHC_STORMS_URL = 'https://www.nhc.noaa.gov/CurrentStorms.json';
const NHC_MAP_SERVICE = 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer';

// NHC's active storms -> a GeoJSON FeatureCollection of each storm's forecast cone, track and points
// (property kind: 'cone', 'track' or 'point'), plus a short list of the storms. Only Atlantic storms
// unless `basins` says otherwise ('all' is handy for testing outside hurricane season).
export async function loadStorms({ basins = ['AT'] } = {}) {
  const { activeStorms = [] } = await fetchJson(NHC_STORMS_URL);
  const wanted = activeStorms.filter(s => basins === 'all' || basins.some(b => String(s.binNumber).startsWith(b)));
  if (!wanted.length) return { storms: [], features: { type: 'FeatureCollection', features: [] } };
  const { layers } = await fetchJson(`${NHC_MAP_SERVICE}?f=json`);
  const layerId = name => layers.find(l => l.name === name)?.id;
  const features = [];
  const inCone = new Set();
  for (const storm of wanted) {
    for (const [kind, layer] of [['cone', 'Forecast Cone'], ['track', 'Forecast Track'], ['point', 'Forecast Points']]) {
      const id = layerId(`${storm.binNumber} ${layer}`);
      if (id == null) continue;
      const geojson = await fetchJson(`${NHC_MAP_SERVICE}/${id}/query?where=1%3D1&outFields=*&returnGeometry=true&geometryPrecision=3&f=geojson`);
      const tagged = stormFeatures(geojson, kind, storm);
      if (kind === 'cone' && tagged.some(f => BROWARD_POINTS.some(p => inPolygon(p, f.geometry)))) inCone.add(storm.id);
      features.push(...tagged);
    }
  }
  return {
    storms: wanted.map(s => ({
      id: s.id,
      name: s.name,
      classification: STORM_CLASSES[s.classification] ?? s.classification,
      intensityKt: Number(s.intensity) || null,
      browardInCone: inCone.has(s.id),
      url: s.forecastGraphics?.url ?? 'https://www.nhc.noaa.gov/',
    })),
    features: { type: 'FeatureCollection', features },
  };
}

const STORM_CLASSES = {
  TD: 'Tropical Depression', TS: 'Tropical Storm', HU: 'Hurricane', MH: 'Major Hurricane',
  STD: 'Subtropical Depression', STS: 'Subtropical Storm', PTC: 'Potential Tropical Cyclone', PC: 'Post-tropical Cyclone',
};

// Broward's corners and middle: if any is inside a storm's cone, the county is in it.
const BROWARD_POINTS = [[-80.44, 26.13], [-80.88, 25.96], [-80.88, 26.33], [-80.12, 25.96], [-80.07, 26.33]];

// [lon, lat] inside a GeoJSON Polygon or MultiPolygon (ray casting; holes count as outside).
export function inPolygon([x, y], geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polygons.some(rings => rings.reduce((inside, ring, i) => {
    let crosses = false;
    for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
      const [xa, ya] = ring[a];
      const [xb, yb] = ring[b];
      if ((ya > y) !== (yb > y) && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) crosses = !crosses;
    }
    return i === 0 ? crosses : inside && !crosses;
  }, false));
}

// One layer's GeoJSON -> features tagged for the map, keeping only the properties it uses.
export function stormFeatures(geojson, kind, storm) {
  return (geojson.features ?? []).filter(f => f.geometry).map(f => ({
    type: 'Feature',
    geometry: f.geometry,
    properties: {
      kind,
      storm: storm.name,
      label: kind === 'point' ? f.properties?.dvlbl ?? '' : '',
      time: kind === 'point' ? f.properties?.datelbl ?? '' : '',
    },
  }));
}

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
export const getWeatherAlerts = cached(loadWeatherAlerts, ALERTS_TTL_MS);
export const getStorms = cached(loadStorms, STORMS_TTL_MS);
const getAllStorms = cached(() => loadStorms({ basins: 'all' }), STORMS_TTL_MS);
export const getStormsFor = basin => (basin === 'all' ? getAllStorms() : getStorms());
