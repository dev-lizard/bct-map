// Turns Broward County Transit's static GTFS zip into the small JSON files the map loads, using
// the same layout aklcommute.nz serves from assets.aklcommute.nz:
//
//   public/data/manifest.json                        { folder }
//   public/data/<folder>/routes.json                 [{ route_id, route_short_name, route_color, ... }]
//   public/data/<folder>/stops.json                  [[stop_id, stop_code, lat, lon, name, location_type, platform_code, parent_station]]
//   public/data/<folder>/stop_routes.json            { stop_id: [route_id] }
//   public/data/<folder>/route_data/<route_id>.json  { s: { shape_id: [[lon, lat]] }, t: [[trip_id, headsign_index, shape_id, direction_id]], h: [headsign] }
//   public/data/<folder>/schedule.json               every trip's stops and times, in the compact form web/schedule.js reads
//   public/data/<folder>/amenities.json              { source, cities: [name], stops: { stop_id: [amenity bits (web/amenities.js), city index] } }
//
// Stop amenities come from Broward County's "Fixed Bus Stop" GIS layer (AMENITIES_URL). If it can't
// be reached the build still succeeds, with wheelchair access from the GTFS only.
//
// BCT ships two service periods in one zip, so only services that run in the next HORIZON_DAYS are kept.
//
// Usage: node scripts/build-static.mjs [zip path or URL]
import fs from 'node:fs/promises';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { addDays, csvObjects, gtfsTimeToSeconds, readCsv, ymdInZone } from '../web/gtfs-util.js';
import { cityName, encodeAmenities } from '../web/amenities.js';
import { packSchedule } from '../web/schedule.js';

// Producer URL since 2026-10-15 (the old broward.org/bct/documents/google_transit.zip now returns 403).
const DEFAULT_SOURCE = 'https://www.browardcdn.org/api/public/content/5813c48c805a4851a24a52a26f6f487c';
// Broward County GIS, published on ArcGIS Online as "Broward County Fixed Bus Stop".
const AMENITIES_URL = process.env.BCT_AMENITIES_URL ?? 'https://bcgishub.broward.org/hbm/rest/services/OpenData2/Fixed_Bus_Stop/FeatureServer/0';
const USER_AGENT = 'broward-transit-3d/0.1'; // both servers refuse curl's and Wget's default User-Agents
const HORIZON_DAYS = 14;
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const ROOT = path.resolve(import.meta.dirname, '..');

const source = process.argv[2] ?? process.env.BCT_STATIC_URL ?? DEFAULT_SOURCE;
console.log(`Reading GTFS from ${source}`);
const zipBytes = /^https?:/i.test(source) ? await download(source) : new Uint8Array(await fs.readFile(source));
const files = unzipSync(zipBytes, { filter: f => f.name.endsWith('.txt') });
const text = name => {
  const entry = Object.keys(files).find(k => path.posix.basename(k) === name);
  return entry ? strFromU8(files[entry]) : '';
};

const agency = csvObjects(text('agency.txt'));
const timezone = agency[0]?.agency_timezone || 'America/New_York';
const feedInfo = csvObjects(text('feed_info.txt'))[0] ?? {};

// 1. Services that run on any day from today through the horizon.
const today = ymdInZone(new Date(), timezone);
const horizon = addDays(today, HORIZON_DAYS);
const activeServices = new Set();
const calendar = csvObjects(text('calendar.txt'));
const calendarDates = csvObjects(text('calendar_dates.txt'));
for (const c of calendar) {
  if (WEEKDAYS.some(d => c[d] === '1') && c.start_date <= horizon && c.end_date >= today) activeServices.add(c.service_id);
}
for (const d of calendarDates) {
  if (d.exception_type === '1' && d.date >= today && d.date <= horizon) activeServices.add(d.service_id);
}
if (activeServices.size === 0) {
  console.warn(`No service runs between ${today} and ${horizon}; the feed may be expired. Keeping every trip.`);
}
const isActive = t => activeServices.size === 0 || activeServices.has(t.service_id);

// 2. Trips, grouped by route.
const trips = csvObjects(text('trips.txt')).filter(isActive);
const tripById = new Map(trips.map(t => [t.trip_id, t]));
const tripsByRoute = Map.groupBy(trips, t => t.route_id);

const routes = csvObjects(text('routes.txt'))
  .filter(r => tripsByRoute.has(r.route_id))
  .map(r => ({
    route_id: r.route_id,
    route_short_name: r.route_short_name,
    route_long_name: r.route_long_name,
    route_type: Number(r.route_type),
    route_color: r.route_color || '888888',
    route_text_color: r.route_text_color || 'FFFFFF',
    route_sort_order: r.route_sort_order === undefined || r.route_sort_order === '' ? null : Number(r.route_sort_order),
  }))
  .sort((a, b) => (a.route_sort_order ?? 0) - (b.route_sort_order ?? 0));

// 3. Shapes used by active trips, as [lon, lat] rounded to ~1 m.
const wantedShapes = new Set(trips.map(t => t.shape_id).filter(Boolean));
const shapePoints = new Map();
{
  const { rows, col } = readCsv(text('shapes.txt'));
  const [iId, iLat, iLon, iSeq] = ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence'].map(col);
  for (const r of rows) {
    if (!wantedShapes.has(r[iId])) continue;
    let pts = shapePoints.get(r[iId]);
    if (!pts) shapePoints.set(r[iId], (pts = []));
    pts.push([Number(r[iSeq]), round5(Number(r[iLon])), round5(Number(r[iLat]))]);
  }
}
const shapes = new Map();
for (const [id, pts] of shapePoints) {
  pts.sort((a, b) => a[0] - b[0]);
  const line = [];
  for (const [, lon, lat] of pts) {
    const last = line.at(-1);
    if (!last || last[0] !== lon || last[1] !== lat) line.push([lon, lat]);
  }
  shapes.set(id, line);
}

// 4. Stop times for active trips and which routes serve each stop.
const schedule = {};
const stopRoutes = new Map();
{
  const { rows, col } = readCsv(text('stop_times.txt'));
  const [iTrip, iArr, iDep, iStop, iSeq, iTimepoint] = ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence', 'timepoint'].map(col);
  // Timepoints are the stops the timetable is built around; on-time performance is measured there.
  // Without a timepoint column, GTFS treats every stop with a time as exact.
  const isTimepoint = r => (iTimepoint < 0 ? Boolean(r[iArr] || r[iDep]) : r[iTimepoint] === '1');
  for (const r of rows) {
    const trip = tripById.get(r[iTrip]);
    if (!trip) continue;
    let entry = schedule[trip.trip_id];
    if (!entry) {
      entry = schedule[trip.trip_id] = {
        r: trip.route_id, d: Number(trip.direction_id || 0), h: trip.trip_headsign, sh: trip.shape_id, sv: trip.service_id, s: [],
      };
    }
    const row = [Number(r[iSeq]), r[iStop], gtfsTimeToSeconds(r[iArr] || r[iDep])];
    if (isTimepoint(r)) row.push(1);
    entry.s.push(row);
    let served = stopRoutes.get(r[iStop]);
    if (!served) stopRoutes.set(r[iStop], (served = new Set()));
    served.add(trip.route_id);
  }
}
for (const entry of Object.values(schedule)) entry.s.sort((a, b) => a[0] - b[0]);

// 5. Stops served by active trips, plus their parent stations.
const allStops = csvObjects(text('stops.txt'));
const neededParents = new Set(allStops.filter(s => stopRoutes.has(s.stop_id) && s.parent_station).map(s => s.parent_station));
const stops = allStops
  .filter(s => stopRoutes.has(s.stop_id) || neededParents.has(s.stop_id))
  .map(s => [
    s.stop_id, s.stop_code, Number(s.stop_lat), Number(s.stop_lon), s.stop_name,
    Number(s.location_type || 0), s.platform_code || '', s.parent_station || '',
  ]);

// 6. Amenities: the GIS layer matched by stop_id, else stop_code, plus GTFS wheelchair access.
let gisStops = [];
try {
  gisStops = await fetchFeatures(AMENITIES_URL);
} catch (err) {
  console.warn(`Stop amenities unavailable (${err.message}); continuing without them.`);
}
const gisById = new Map(gisStops.map(a => [String(a.STOP_ID ?? '').trim(), a]));
const gisByCode = new Map(gisStops.map(a => [String(a.STOP_CODE ?? '').trim(), a]));
const cities = [];
const cityIndex = new Map();
const amenities = {};
let matched = 0;
for (const s of allStops) {
  if (!stopRoutes.has(s.stop_id)) continue;
  const gis = gisById.get(s.stop_id) ?? gisByCode.get(s.stop_code) ?? null;
  if (gis) matched++;
  const city = cityName(gis?.MUNICIPALITY);
  if (city && !cityIndex.has(city)) cityIndex.set(city, cities.push(city) - 1);
  const mask = encodeAmenities(gis, s.wheelchair_boarding);
  if (mask || city) amenities[s.stop_id] = [mask, city ? cityIndex.get(city) : null];
}

// 7. Write everything out.
const folder = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
const outDir = path.join(ROOT, 'public', 'data', folder);
await fs.mkdir(path.join(outDir, 'route_data'), { recursive: true });

await writeJson(path.join(outDir, 'routes.json'), routes);
await writeJson(path.join(outDir, 'stops.json'), stops);
await writeJson(path.join(outDir, 'amenities.json'), {
  source: gisStops.length ? { name: 'Broward County Fixed Bus Stop (Broward County GIS)', url: AMENITIES_URL, records: gisStops.length } : null,
  cities,
  stops: amenities,
});
await writeJson(path.join(outDir, 'stop_routes.json'), Object.fromEntries([...stopRoutes].map(([id, set]) => [id, [...set].sort()])));
for (const route of routes) {
  const headsigns = [];
  const headsignIndex = new Map();
  const t = tripsByRoute.get(route.route_id).map(trip => {
    let i = headsignIndex.get(trip.trip_headsign);
    if (i === undefined) {
      i = headsigns.length;
      headsigns.push(trip.trip_headsign);
      headsignIndex.set(trip.trip_headsign, i);
    }
    return [trip.trip_id, i, trip.shape_id, Number(trip.direction_id || 0)];
  });
  const s = {};
  for (const id of new Set(tripsByRoute.get(route.route_id).map(trip => trip.shape_id))) {
    if (shapes.has(id)) s[id] = shapes.get(id);
  }
  await writeJson(path.join(outDir, 'route_data', `${encodeURIComponent(route.route_id)}.json`), { s, t, h: headsigns });
}
await writeJson(path.join(outDir, 'schedule.json'), packSchedule({
  meta: {
    folder, timezone, built_at: new Date().toISOString(), feed_version: feedInfo.feed_version ?? null,
    window: [today, horizon], services: [...activeServices].sort(),
  },
  // Which of those services run on which dates, so a stop's departures can be listed for a day.
  calendar: Object.fromEntries(calendar.filter(c => activeServices.has(c.service_id)).map(c => [
    c.service_id, { days: WEEKDAYS.map(d => (c[d] === '1' ? 1 : 0)), start: c.start_date, end: c.end_date },
  ])),
  exceptions: calendarDates
    .filter(d => activeServices.has(d.service_id))
    .map(d => [d.date, d.service_id, Number(d.exception_type)]),
  trips: schedule,
}));
// Written last so the server and browser never see a manifest pointing at a half-written folder.
await writeJson(path.join(ROOT, 'public', 'data', 'manifest.json'), { folder });

// Keep this build and the one before (pages loaded just before the switch still fetch from it).
const builds = (await fs.readdir(path.join(ROOT, 'public', 'data'))).filter(f => /^\d{8}_\d{6}$/.test(f)).sort();
for (const old of builds.slice(0, -2)) await fs.rm(path.join(ROOT, 'public', 'data', old), { recursive: true, force: true });

const shapePointCount = [...shapes.values()].reduce((n, line) => n + line.length, 0);
console.log(`Feed ${feedInfo.feed_version ?? '(no feed_info)'} | services ${[...activeServices].join(', ') || 'all'}`);
console.log(`${routes.length} routes, ${trips.length} trips, ${stops.length} stops, ${shapes.size} shapes (${shapePointCount} points)`);
console.log(`Amenities: ${matched} of ${stopRoutes.size} stops matched in the GIS layer (${gisStops.length} records)`);
console.log(`Wrote public/data/${folder}/`);

async function download(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// Every feature's attributes from an ArcGIS feature layer, a page (the server's limit, 2,000) at a time.
async function fetchFeatures(layerUrl) {
  const out = [];
  for (let offset = 0; ; ) {
    const url = `${layerUrl}/query?where=1%3D1&outFields=*&returnGeometry=false&orderByFields=OBJECTID&resultOffset=${offset}&f=json`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`GET ${layerUrl} -> HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message ?? 'ArcGIS error');
    const page = (json.features ?? []).map(f => f.attributes);
    out.push(...page);
    if (!json.exceededTransferLimit || !page.length) return out;
    offset += page.length;
  }
}

function writeJson(file, value) {
  return fs.writeFile(file, JSON.stringify(value));
}

function round5(n) {
  return Math.round(n * 1e5) / 1e5;
}
