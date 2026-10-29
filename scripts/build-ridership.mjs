// Turns a week of BCT fare-box exports (one CSV per service day, one row per boarding) into
// web/ridership.json: average boardings a day by stop, and by route and hour, for weighting the
// Analytics by riders. Only totals are written; the exports' card data, ticket, device and driver
// fields are never read into the output, and the raw files stay out of the repository.
//
// Usage: node scripts/build-ridership.mjs <folder of CSVs>
//
// Each file is one service day (BCT's runs 4 AM to about 2 AM), so a boarding after midnight
// belongs to the file's day. The garages' boardings (operators riding in) are left out, as are
// rows with no stop for the by-stop totals. A stop is matched by BCT's stop id or code (the exports
// drop leading zeros), else by its coordinates: the nearest stop on that route within 60 m.
import fs from 'node:fs';
import path from 'node:path';
import { distanceMeters, servicesOn, addDays } from '../web/gtfs-util.js';
import { Schedule } from '../web/schedule.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'web', 'ridership.json');
const NEAREST_M = 60;
const DAY_TYPES = ['weekday', 'saturday', 'sunday'];
const dayTypeOf = ymd => ({ 0: 'sunday', 6: 'saturday' })[new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8))).getUTCDay()] ?? 'weekday';

const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) throw new Error('Usage: node scripts/build-ridership.mjs <folder of CSVs>');

// The timetable, for stops, routes and how many trips run each hour.
const { folder } = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'manifest.json'), 'utf8'));
const read = name => JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', folder, name), 'utf8'));
const stops = read('stops.json').filter(s => s[5] === 0);
const stopRoutes = read('stop_routes.json');
const routeIds = new Map(read('routes.json').map(r => [String(Number(r.route_short_name)), r.route_id]));
const schedule = new Schedule(read('schedule.json'));
const byId = new Map(stops.map(s => [s[0], s[0]]));
const byCode = new Map(stops.map(s => [s[1], s[0]]));

function matchStop(number, lat, lon, routeId) {
  for (const n of [number, number.padStart(4, '0')]) {
    if (byId.has(n)) return byId.get(n);
    if (byCode.has(n)) return byCode.get(n);
  }
  if (!lat || !lon) return null;
  let best = null;
  for (const s of stops) {
    if (!(stopRoutes[s[0]] ?? []).includes(routeId)) continue;
    const d = distanceMeters(lat, lon, s[2], s[3]);
    if (d <= NEAREST_M && (!best || d < best.d)) best = { d, id: s[0] };
  }
  return best?.id ?? null;
}

// A CSV line, with quoted fields.
function parseLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false; else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

const days = []; // { date, type }
const stopTotals = new Map(); // stop id -> { weekday, saturday, sunday } boardings
const routeHours = new Map(); // route id -> { weekday: [24], ... } boardings by clock hour
const skipped = { garage: 0, noStop: 0, noRoute: 0 };
let boardings = 0;
const matchCache = new Map();

for (const file of fs.readdirSync(dir).filter(f => /\.csv$/i.test(f)).sort()) {
  const lines = fs.readFileSync(path.join(dir, file), 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const head = parseLine(lines[0]);
  const col = name => {
    const i = head.indexOf(name);
    if (i < 0) throw new Error(`${file}: no "${name}" column`);
    return i;
  };
  const [cTime, cRoute, cStop, cName, cLat, cLon, cRiders] = ['Transaction Time', 'Route', 'Stop Number', 'Stop Name', 'Latitude', 'Longitude', 'Ridership'].map(col);
  const rows = lines.slice(1).map(parseLine);
  // The file's service day: the date of its rides from 4 AM on.
  const dates = new Map();
  for (const f of rows) if (Number(f[cTime].slice(11, 13)) >= 4) dates.set(f[cTime].slice(0, 10), (dates.get(f[cTime].slice(0, 10)) ?? 0) + 1);
  const date = [...dates].sort((a, b) => b[1] - a[1])[0][0].replaceAll('-', '');
  const type = dayTypeOf(date);
  days.push({ date, type });
  for (const f of rows) {
    const n = Number(f[cRiders]) || 0;
    if (!n) continue;
    if (/garage/i.test(f[cName])) { skipped.garage += n; continue; }
    const routeId = routeIds.get(String(Number(f[cRoute])));
    if (!routeId) { skipped.noRoute += n; continue; }
    boardings += n;
    const hours = routeHours.get(routeId) ?? routeHours.set(routeId, Object.fromEntries(DAY_TYPES.map(t => [t, new Array(24).fill(0)]))).get(routeId);
    hours[type][Number(f[cTime].slice(11, 13))] += n;
    const number = (f[cStop] ?? '').trim();
    if (!number || number === '0' || /not set/i.test(number)) { skipped.noStop += n; continue; }
    const key = `${number}|${f[cLat]}|${f[cLon]}|${routeId}`;
    if (!matchCache.has(key)) matchCache.set(key, matchStop(number, Number(f[cLat]), Number(f[cLon]), routeId));
    const stopId = matchCache.get(key);
    if (!stopId) { skipped.noStop += n; continue; }
    const t = stopTotals.get(stopId) ?? stopTotals.set(stopId, { weekday: 0, saturday: 0, sunday: 0 }).get(stopId);
    t[type] += n;
  }
}

// Averages a day, by day type.
const dayCount = Object.fromEntries(DAY_TYPES.map(t => [t, days.filter(d => d.type === t).length]));
const avg = (n, type) => (dayCount[type] ? Math.round((10 * n) / dayCount[type]) / 10 : 0);

// Trips starting each hour, by route and day type, on dates the timetable covers.
const window = schedule.meta.window?.[0] ?? days[0].date;
const sample = {};
for (let i = 0; i < 14 && Object.keys(sample).length < 3; i++) sample[dayTypeOf(addDays(window, i))] ??= addDays(window, i);
const tripsPerHour = new Map();
for (const [type, date] of Object.entries(sample)) {
  const running = servicesOn(date, schedule.calendar, schedule.exceptions);
  for (const trip of Object.values(schedule.trips)) {
    if (!running.has(trip.sv)) continue;
    const first = trip.s.find(r => r[2] != null);
    if (!first) continue;
    const counts = tripsPerHour.get(trip.r) ?? tripsPerHour.set(trip.r, Object.fromEntries(DAY_TYPES.map(t => [t, new Array(24).fill(0)]))).get(trip.r);
    counts[type][Math.floor(first[2] / 3600) % 24]++;
  }
}

const out = {
  v: 1,
  week: [days.map(d => d.date).sort()[0], days.map(d => d.date).sort().at(-1)],
  days: dayCount,
  builtAt: new Date().toISOString(),
  // Boardings counted, and left out: at the garages, with no route, or (by stop only) with no stop.
  totals: { boardings, ...Object.fromEntries(Object.entries(skipped).map(([k, v]) => [k, v])) },
  // stop id -> [weekday, saturday, sunday] average boardings a day
  stops: Object.fromEntries([...stopTotals].map(([id, t]) => [id, DAY_TYPES.map(type => avg(t[type], type))])),
  // route id -> { day type: [average boardings a day by clock hour 0-23] }
  routeHours: Object.fromEntries([...routeHours].map(([id, h]) => [id, Object.fromEntries(DAY_TYPES.map(type => [type, h[type].map(n => avg(n, type))]))])),
  // route id -> { day type: [average boardings per trip starting that hour] } (null: no trips start then)
  perTrip: Object.fromEntries([...routeHours].map(([id, h]) => [id, Object.fromEntries(DAY_TYPES.map(type => [type, h[type].map((n, hour) => {
    const trips = tripsPerHour.get(id)?.[type][hour] ?? 0;
    return trips ? Math.round((10 * avg(n, type)) / trips) / 10 : null;
  })]))])),
};
fs.writeFileSync(OUT, `${JSON.stringify(out)}\n`);
const kb = Math.round(fs.statSync(OUT).size / 1024);
console.log(`Ridership for ${out.week.join('–')} (${Object.entries(dayCount).map(([t, n]) => `${n} ${t}`).join(', ')}): ${boardings} boardings, ${stopTotals.size} stops, ${routeHours.size} routes; left out ${JSON.stringify(skipped)}. Wrote ${path.relative(ROOT, OUT)} (${kb} KB).`);
