// The API for the GitHub Pages site, on Cloudflare's free Workers plan. It serves the same
// endpoints as the Node dev server (server/index.mjs):
//   GET /api/rt            BCT's live feeds as one protobuf bundle (web/gtfs-rt.js), at most 10 s old
//   GET /api/weather       current conditions in Fort Lauderdale
//   GET /api/radar         time and tile URL of the latest rain radar
//   GET /api/weather-alerts  active National Weather Service alerts for Broward
//   GET /api/storms        active Atlantic storms' forecast cones (?basin=all for every basin)
//   GET /api/reliability   on-time performance by route, or by hour (?route=ID&days=7)
//   GET /api/analytics     bunching, cancellations and adherence by weather (?days=7)
//   GET /api/segments      measured bus running times between stops (?days=7)
//   GET /api/bunching-track  both buses' GPS tracks around a bunching event (?key=date|leader|follower)
//   GET /api/service       service delivered, prediction accuracy, headways, schedule fit (?days=7)
//   GET /api/health        ok / degraded / down, with the checks behind it (503 when down)
// A Cron Trigger runs the Recorder (recorder.js) every minute; it logs on-time performance in a
// Durable Object's SQLite database and reports health. Everything else happens in the browser.
//
// Caching is per isolate (Cloudflare's Cache API does nothing on workers.dev addresses), so BCT
// sees roughly one request per 10 s from each isolate the Worker is running in: a handful.
import { packBundle } from '../web/gtfs-rt.js';
import { fetchAllFeeds, rollHistory } from '../server/bct-feed.mjs';
import {
  ALERTS_TTL_MS, loadRadar, loadStorms, loadWeather, loadWeatherAlerts, loadWeatherHistory, RADAR_TTL_MS, STORMS_TTL_MS,
  WEATHER_HISTORY_TTL_MS, WEATHER_TTL_MS,
} from '../server/extras.mjs';
import { WEATHER_CLASSES, weatherByHour, weatherImpact } from '../server/analytics.mjs';
import { runningTimeByWeather } from '../server/segments.mjs';

export { Recorder } from './recorder.js';

const RT_TTL_MS = 10_000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Expose-Headers': 'X-Server-Time',
  'Access-Control-Max-Age': '86400',
};

const json = (value, status = 200, extra = {}) => new Response(JSON.stringify(value), {
  status,
  headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
});

// Plain data only is kept between requests: Workers can't share an in-flight fetch across them.
let rt = null; // { at, parts, body, errors }
let bctBase; // from env: BCT's own address unless .dev.vars overrides it
let contractBase; // from env: the contracted routes' feeds (a secret), or null

async function latestBundle() {
  if (rt && Date.now() - rt.at < RT_TTL_MS) return rt;
  const feeds = await fetchAllFeeds(undefined, { base: bctBase, contractBase });
  if (!feeds.vehiclePositions) {
    if (rt) return { ...rt, errors: feeds.errors }; // BCT is down: keep serving the last good bundle
    throw new Error(feeds.errors.join('; '));
  }
  const previous = rt?.parts ?? null;
  const parts = {
    vehiclePositions: feeds.vehiclePositions,
    tripUpdates: feeds.tripUpdates ?? previous?.tripUpdates ?? null,
    alerts: feeds.alerts ?? previous?.alerts ?? null,
    history: rollHistory(previous, feeds.vehiclePositions),
  };
  rt = { at: Date.now(), parts, body: packBundle(parts), errors: feeds.errors };
  return rt;
}

function memo(load, ttlMs) {
  let value = null;
  let loadedAt = -Infinity;
  return async () => {
    if (value && Date.now() - loadedAt < ttlMs) return value;
    try {
      value = await load();
      loadedAt = Date.now();
      return value;
    } catch (err) {
      if (value) return { ...value, stale: true };
      throw err;
    }
  };
}
const getWeather = memo(loadWeather, WEATHER_TTL_MS);
const getRadar = memo(loadRadar, RADAR_TTL_MS);
const getWeatherAlerts = memo(loadWeatherAlerts, ALERTS_TTL_MS);
const getStorms = memo(loadStorms, STORMS_TTL_MS);
const getAllStorms = memo(() => loadStorms({ basins: 'all' }), STORMS_TTL_MS);
const getWeatherHistory = memo(loadWeatherHistory, WEATHER_HISTORY_TTL_MS);

const recorder = env => env.RECORDER.get(env.RECORDER.idFromName('bct'));

function intParam(value, fallback, min, max) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export default {
  async fetch(request, env) {
    bctBase = env.BCT_BASE || undefined;
    contractBase = env.CONTRACT_FEED_BASE || null;
    const { pathname, searchParams } = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'Method not allowed' }, 405);

    try {
      if (pathname === '/api/rt') {
        const { body, errors } = await latestBundle();
        return new Response(body, {
          headers: {
            ...CORS,
            'Content-Type': 'application/x-protobuf',
            'Cache-Control': 'no-store',
            'X-Server-Time': String(Date.now()),
            ...(errors.length ? { 'X-Feed-Errors': errors.join('; ').slice(0, 500) } : {}),
          },
        });
      }
      if (pathname === '/api/weather') return json(await getWeather());
      if (pathname === '/api/radar') return json(await getRadar());
      if (pathname === '/api/weather-alerts') return json(await getWeatherAlerts());
      if (pathname === '/api/storms') return json(await (searchParams.get('basin') === 'all' ? getAllStorms() : getStorms()));
      if (pathname === '/api/reliability') {
        const days = intParam(searchParams.get('days'), 7, 1, 30);
        return json(await recorder(env).summary({ days, routeId: searchParams.get('route') }));
      }
      if (pathname === '/api/analytics') {
        const days = intParam(searchParams.get('days'), 7, 1, 30);
        const { hourCounts, ...rest } = await recorder(env).analytics({ days });
        let weather;
        try {
          weather = weatherImpact(hourCounts, weatherByHour(await getWeatherHistory()));
        } catch (err) {
          weather = { error: `Weather history unavailable: ${err.message}` };
        }
        return json({ ...rest, weather });
      }
      if (pathname === '/api/segments') {
        const days = intParam(searchParams.get('days'), 7, 1, 30);
        const { hourRows, ...rest } = await recorder(env).segments({ days });
        let weather;
        try {
          weather = runningTimeByWeather(hourRows, weatherByHour(await getWeatherHistory()), WEATHER_CLASSES);
        } catch (err) {
          weather = { error: `Weather history unavailable: ${err.message}` };
        }
        return json({ ...rest, weather });
      }
      if (pathname === '/api/service') return json(await recorder(env).service({ days: intParam(searchParams.get('days'), 7, 1, 30) }));
      if (pathname === '/api/bunching-track') {
        const track = await recorder(env).track(searchParams.get('key') ?? '');
        return track ? json(track) : json({ error: 'No track for this event' }, 404);
      }
      if (pathname === '/api/health') {
        const report = await recorder(env).health();
        return json(report, report.status === 'down' ? 503 : 200);
      }
      if (pathname === '/') return json({ name: 'Broward Transit 3D API', endpoints: ['/api/rt', '/api/weather', '/api/radar', '/api/weather-alerts', '/api/storms', '/api/reliability', '/api/analytics', '/api/segments', '/api/bunching-track', '/api/service', '/api/health'] });
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: `Upstream unavailable: ${err.message}` }, 502);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(recorder(env).tick());
  },
};
